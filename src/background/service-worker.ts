import { MessageType } from '../shared/types';
import type { ApiConfig, Prompt, PageContent, ExtensionMessage } from '../shared/types';
import { MAX_CONTENT_LENGTH } from '../shared/constants';

let offscreenReady = false;
let pendingEnsure: Promise<void> | null = null;

// Active stream abort controllers keyed by windowId
const activeStreams = new Map<number, AbortController>();

// ============================================================================
// Offscreen Document Management
// ============================================================================

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) {
    try {
      const response = await chrome.runtime.sendMessage({ type: MessageType.PING_OFFSCREEN });
      if (response?.pong) return;
    } catch {
      offscreenReady = false;
    }
  }

  // Serialize concurrent calls to prevent "Only a single offscreen document may be created"
  if (pendingEnsure) {
    console.log('[Service Worker] Offscreen creation already in progress, awaiting...');
    return pendingEnsure;
  }

  pendingEnsure = doEnsureOffscreenDocument();
  try {
    await pendingEnsure;
  } finally {
    pendingEnsure = null;
  }
}

async function doEnsureOffscreenDocument(): Promise<void> {
  try {
    // Check if document already exists (Chrome 116+ has chrome.offscreen.hasDocument)
    let existing = false;
    if (chrome.offscreen && 'hasDocument' in chrome.offscreen) {
      existing = await (chrome.offscreen as any).hasDocument();
    } else {
      try {
        await chrome.runtime.sendMessage({ type: MessageType.PING_OFFSCREEN });
        existing = true;
      } catch {
        existing = false;
      }
    }

    if (existing) {
      console.log('[Service Worker] Offscreen document exists, pinging to check health...');
      try {
        const response = await chrome.runtime.sendMessage({ type: MessageType.PING_OFFSCREEN });
        if (response?.pong) {
          console.log('[Service Worker] Existing offscreen document is healthy, reusing');
          offscreenReady = true;
          return;
        }
      } catch {
        // ping failed - document is stale
      }

      console.log('[Service Worker] Offscreen document is stale, closing it...');
      if (chrome.offscreen && 'closeDocument' in chrome.offscreen) {
        try {
          await (chrome.offscreen as any).closeDocument();
          console.log('[Service Worker] Closed stale offscreen document');
        } catch (e: any) {
          console.log('[Service Worker] closeDocument failed:', e.message);
        }
      }
    }

    console.log('[Service Worker] Creating offscreen document...');
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Maintain SQLite database with OPFS access for SmartReader'
    });
    console.log('[Service Worker] offscreen.createDocument resolved');

    // Wait for ready signal
    await waitForOffscreenReady();
  } catch (error) {
    console.error('[Service Worker] Failed to create offscreen document:', error);
    throw error;
  }
}

function waitForOffscreenReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    let htmlLoaded = false;

    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      const hint = htmlLoaded
        ? 'HTML loaded but JS init never completed. Check offscreen console for errors.'
        : 'HTML never loaded. Check if offscreen.html path is correct.';
      reject(new Error(`Offscreen document initialization timeout (${hint})`));
    }, 30000); // 30 seconds

    const listener = (msg: ExtensionMessage) => {
      if (msg.type === MessageType.OFFSCREEN_HTML_LOADED) {
        console.log('[Service Worker] Received OFFSCREEN_HTML_LOADED');
        htmlLoaded = true;
        return;
      }

      if (msg.type === MessageType.OFFSCREEN_READY) {
        console.log('[Service Worker] Received OFFSCREEN_READY');
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        offscreenReady = true;
        resolve();
      }
    };

    chrome.runtime.onMessage.addListener(listener);
  });
}

// ============================================================================
// Database Operations (proxied to offscreen document)
// ============================================================================

async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: MessageType.DB_QUERY,
    sql,
    params
  });
  if (!response.success) {
    throw new Error(response.error || 'Database query failed');
  }
  return response.data;
}

async function dbExec(sql: string, params: unknown[] = []): Promise<void> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: MessageType.DB_EXEC,
    sql,
    params
  });
  if (!response.success) {
    throw new Error(response.error || 'Database exec failed');
  }
}

// ============================================================================
// API Config
// ============================================================================

async function getApiConfig(): Promise<ApiConfig> {
  const result = await dbQuery('SELECT * FROM api_config WHERE id = 1');
  if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
    return {
      id: 1,
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      model: 'gpt-4o-mini',
      updated_at: Date.now()
    };
  }
  const row = result[0].values[0];
  const columns = result[0].columns;
  const config: any = {};
  columns.forEach((col: string, i: number) => {
    config[col] = row[i];
  });
  return config as ApiConfig;
}

// ============================================================================
// Prompts
// ============================================================================

async function getPrompts(): Promise<Prompt[]> {
  const result = await dbQuery('SELECT * FROM prompts ORDER BY sort_order, id');
  if (!result || result.length === 0) return [];

  const columns = result[0].columns;
  return result[0].values.map((row: any[]) => {
    const prompt: any = {};
    columns.forEach((col: string, i: number) => {
      prompt[col] = row[i];
    });
    return prompt as Prompt;
  });
}

async function getPromptById(id: number): Promise<Prompt | null> {
  const result = await dbQuery('SELECT * FROM prompts WHERE id = ?', [id]);
  if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
    return null;
  }
  const columns = result[0].columns;
  const row = result[0].values[0];
  const prompt: any = {};
  columns.forEach((col: string, i: number) => {
    prompt[col] = row[i];
  });
  return prompt as Prompt;
}

// ============================================================================
// AI Streaming
// ============================================================================

async function streamAIResponse(
  prompt: string,
  apiConfig: ApiConfig,
  windowId: number,
  promptPreview?: string
): Promise<void> {
  // Notify side panel that stream is starting
  console.log('[Service Worker] Sending STREAM_START to window', windowId);
  try {
    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_START,
      windowId,
      promptPreview
    });
    console.log('[Service Worker] STREAM_START sent');
  } catch (e: any) {
    console.error('[Service Worker] Failed to send STREAM_START:', e.message);
  }

  const controller = new AbortController();
  activeStreams.set(windowId, controller);
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const baseUrl = apiConfig.base_url.replace(/\/$/, '');
    console.log('[Service Worker] Calling AI API at', baseUrl);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.api_key}`
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Please respond in the same language as the user query.' },
          { role: 'user', content: prompt }
        ],
        stream: true
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6).trim();
        if (data === '[DONE]' || !data) continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            chunkCount++;
            await chrome.runtime.sendMessage({
              type: MessageType.STREAM_CHUNK,
              content,
              windowId
            });
          }
        } catch (e) {
          // Ignore malformed JSON
        }
      }
    }

    console.log('[Service Worker] Stream complete, total chunks:', chunkCount);
    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_COMPLETE,
      windowId
    });
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      console.log('[Service Worker] Stream aborted by user');
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_ABORTED,
        windowId
      });
    } else {
      console.error('[Service Worker] Streaming error:', error);
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_ERROR,
        error: error.message || 'Unknown streaming error',
        windowId
      });
    }
  } finally {
    activeStreams.delete(windowId);
  }
}

// ============================================================================
// Execute Prompt
// ============================================================================

async function executePrompt(
  tabId: number,
  windowId: number,
  promptId?: number,
  promptTemplate?: string
): Promise<void> {
  // MV3 service worker can be terminated after sendResponse. Keep it alive.
  const keepAlive = setInterval(() => {
    chrome.storage.local.get('__keepalive').catch(() => {});
  }, 4000);

  try {
    // 1. Ensure content script is injected, then get page content
    console.log('[Service Worker] Step 1: Ensuring content script in tab', tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js']
      });
      console.log('[Service Worker] Content script injected (or already present)');
    } catch (injectErr: any) {
      console.log('[Service Worker] Content script injection result:', injectErr.message);
      // May already be injected, proceed anyway
    }

    console.log('[Service Worker] Getting page content from tab', tabId);
    let pageContent: PageContent;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MessageType.GET_PAGE_CONTENT
      });
      console.log('[Service Worker] Page content response:', response);
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to get page content');
      }
      pageContent = response.data as PageContent;
      console.log('[Service Worker] Page content OK, title:', pageContent.title);
    } catch (error: any) {
      console.error('[Service Worker] Failed to get page content:', error.message);
      // Delay sending error to give side panel time to load
      await new Promise(r => setTimeout(r, 1000));
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.STREAM_ERROR,
          error: '无法读取此页面内容。请尝试刷新页面或使用普通网页（不支持 chrome:// 等内部页面）。',
          windowId
        });
      } catch (sendErr: any) {
        console.error('[Service Worker] Failed to send STREAM_ERROR to sidepanel:', sendErr.message);
      }
      return;
    }

    // 2. Get prompt template
    let template: string;
    if (promptTemplate !== undefined) {
      console.log('[Service Worker] Step 2: Using provided prompt template');
      template = promptTemplate;
    } else {
      console.log('[Service Worker] Step 2: Getting prompt template from DB');
      const prompt = await getPromptById(promptId!);
      if (!prompt) {
        console.error('[Service Worker] Prompt not found:', promptId);
        await new Promise(r => setTimeout(r, 1000));
        try {
          await chrome.runtime.sendMessage({
            type: MessageType.STREAM_ERROR,
            error: '提示词不存在',
            windowId
          });
        } catch (sendErr: any) {
          console.error('[Service Worker] Failed to send STREAM_ERROR:', sendErr.message);
        }
        return;
      }
      console.log('[Service Worker] Prompt template OK:', prompt.title);
      template = prompt.prompt;
    }

    // 3. Replace variables
    console.log('[Service Worker] Step 3: Replacing variables');
    const finalPrompt = template
      .replace(/\$\{html\}/g, pageContent.html.substring(0, MAX_CONTENT_LENGTH))
      .replace(/\$\{text\}/g, pageContent.text || '(未选中文字)');
    console.log('[Service Worker] Final prompt length:', finalPrompt.length);

    // 4. Get API config
    console.log('[Service Worker] Step 4: Getting API config');
    const apiConfig = await getApiConfig();
    console.log('[Service Worker] API config base_url:', apiConfig.base_url, 'model:', apiConfig.model, 'hasKey:', !!apiConfig.api_key);
    if (!apiConfig.api_key) {
      console.error('[Service Worker] API Key not configured');
      await new Promise(r => setTimeout(r, 1000));
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.STREAM_ERROR,
          error: 'API Key 未配置。请打开选项页面配置 API 设置。',
          windowId
        });
      } catch (sendErr: any) {
        console.error('[Service Worker] Failed to send STREAM_ERROR:', sendErr.message);
      }
      return;
    }

    // 5. Wait for side panel to fully load before sending stream messages
    console.log('[Service Worker] Step 5: Waiting for side panel to load...');
    await new Promise(r => setTimeout(r, 1500));
    // Pass the original template (before variable substitution) as preview
    const preview = template.length > 200 ? template.slice(0, 200) + '...' : template;
    console.log('[Service Worker] Starting AI stream...');
    await streamAIResponse(finalPrompt, apiConfig, windowId, preview);
  } catch (error: any) {
    console.error('[Service Worker] Execute prompt outer catch:', error);
    try {
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_ERROR,
        error: error.message || '执行失败',
        windowId
      });
    } catch (sendErr: any) {
      console.error('[Service Worker] Failed to send STREAM_ERROR:', sendErr.message);
    }
  } finally {
    clearInterval(keepAlive);
    console.log('[Service Worker] executePrompt finished, keepAlive cleared');
  }
}

// ============================================================================
// Show Page Markdown (no AI, just display converted Markdown)
// ============================================================================

async function showPageMarkdown(tabId: number, windowId: number): Promise<void> {
  try {
    // 1. Ensure content script is injected
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js']
      });
    } catch (injectErr: any) {
      // May already be injected, proceed anyway
    }

    // 2. Get page content
    let pageContent: PageContent;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MessageType.GET_PAGE_CONTENT
      });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to get page content');
      }
      pageContent = response.data as PageContent;
    } catch (error: any) {
      console.error('[Service Worker] Failed to get page content:', error.message);
      await new Promise(r => setTimeout(r, 500));
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.STREAM_ERROR,
          error: '无法读取此页面内容。请尝试刷新页面或使用普通网页。',
          windowId
        });
      } catch {}
      return;
    }

    // 3. Send to side panel using the existing stream pipeline
    const markdown = pageContent.html;
    console.log('[Service Worker] Sending page Markdown to side panel, length:', markdown.length);

    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_START,
      windowId
    });

    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_CHUNK,
      content: markdown,
      windowId
    });

    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_COMPLETE,
      windowId
    });
  } catch (error: any) {
    console.error('[Service Worker] showPageMarkdown error:', error);
    try {
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_ERROR,
        error: error.message || '获取页面 Markdown 失败',
        windowId
      });
    } catch {}
  }
}

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        // Prompt operations
        case MessageType.GET_PROMPTS: {
          console.log('[Service Worker] Handling GET_PROMPTS');
          const prompts = await getPrompts();
          console.log('[Service Worker] GET_PROMPTS returning', prompts.length, 'prompts');
          sendResponse({ success: true, data: prompts });
          break;
        }

        case MessageType.SAVE_PROMPT: {
          const { id, title, prompt, sort_order } = message as any;
          const now = Date.now();
          if (id) {
            await dbExec(
              'UPDATE prompts SET title = ?, prompt = ?, sort_order = ?, updated_at = ? WHERE id = ?',
              [title, prompt, sort_order ?? 0, now, id]
            );
          } else {
            await dbExec(
              'INSERT INTO prompts (title, prompt, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
              [title, prompt, sort_order ?? 0, now, now]
            );
          }
          sendResponse({ success: true });
          break;
        }

        case MessageType.DELETE_PROMPT: {
          const { id } = message as any;
          await dbExec('DELETE FROM prompts WHERE id = ?', [id]);
          sendResponse({ success: true });
          break;
        }

        // API Config operations
        case MessageType.GET_API_CONFIG: {
          const config = await getApiConfig();
          sendResponse({ success: true, data: config });
          break;
        }

        case MessageType.SAVE_API_CONFIG: {
          const { baseUrl, apiKey, model } = message as any;
          const exists = await dbQuery('SELECT COUNT(*) as count FROM api_config WHERE id = 1');
          const count = exists[0]?.values[0][0] || 0;
          const now = Date.now();
          if (count > 0) {
            await dbExec(
              'UPDATE api_config SET base_url = ?, api_key = ?, model = ?, updated_at = ? WHERE id = 1',
              [baseUrl, apiKey, model, now]
            );
          } else {
            await dbExec(
              'INSERT INTO api_config (id, base_url, api_key, model, updated_at) VALUES (1, ?, ?, ?, ?)',
              [baseUrl, apiKey, model, now]
            );
          }
          sendResponse({ success: true });
          break;
        }

        // Execution
        case MessageType.EXECUTE_PROMPT: {
          const { promptId, promptTemplate, tabId, windowId } = message as any;
          console.log('[Service Worker] Received EXECUTE_PROMPT:', { promptId, promptTemplate: promptTemplate ? '(custom)' : undefined, tabId, windowId });
          // Execute asynchronously without blocking the response
          sendResponse({ success: true });
          executePrompt(tabId, windowId, promptId, promptTemplate);
          break;
        }

        case MessageType.ABORT_STREAM: {
          const { windowId } = message as any;
          console.log('[Service Worker] Received ABORT_STREAM for window', windowId);
          const controller = activeStreams.get(windowId);
          if (controller) {
            controller.abort();
            activeStreams.delete(windowId);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'No active stream for this window' });
          }
          break;
        }

        case MessageType.SHOW_PAGE_MARKDOWN: {
          const { tabId, windowId } = message as any;
          console.log('[Service Worker] Received SHOW_PAGE_MARKDOWN:', { tabId, windowId });
          sendResponse({ success: true });
          showPageMarkdown(tabId, windowId);
          break;
        }

        // Offscreen lifecycle messages - silently ignore
        case MessageType.OFFSCREEN_HTML_LOADED:
        case MessageType.OFFSCREEN_READY:
          // These are sent from offscreen to signal lifecycle events.
          // No response needed.
          break;

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (error: any) {
      console.error('[Service Worker] Message handler error:', error);
      sendResponse({ success: false, error: error.message || 'Unknown error' });
    }
  })();
  return true; // Keep channel open for async
});

// Initialize offscreen document on startup
ensureOffscreenDocument().catch(console.error);

console.log('[Service Worker] Initialized');
