import { MessageType } from '../shared/types';
import type { ApiConfig, Prompt, PageContent, ExtensionMessage } from '../shared/types';
import { MAX_CONTENT_LENGTH } from '../shared/constants';

let offscreenReady = false;
let pendingEnsure: Promise<void> | null = null;

interface ConversationState {
  historyId: number | null;
  title: string;
  url: string;
  prompt: string;
  messages: Array<{ role: string; content: string }>;
  abortController: AbortController | null;
  apiConfig: ApiConfig;
}

const conversations = new Map<number, ConversationState>();

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
// History
// ============================================================================

async function saveOrUpdateHistory(windowId: number, response: string): Promise<void> {
  const state = conversations.get(windowId);
  if (!state) return;
  const now = Date.now();

  const firstUserMessage = state.messages.find(m => m.role === 'user');
  const promptText = typeof firstUserMessage?.content === 'string' ? firstUserMessage.content : state.prompt;

  try {
    if (state.historyId) {
      await dbExec(
        'UPDATE history SET title = ?, url = ?, prompt = ?, response = ?, messages = ?, updated_at = ? WHERE id = ?',
        [state.title, state.url, promptText, response, JSON.stringify(state.messages), now, state.historyId]
      );
    } else {
      const result = await dbQuery(
        'INSERT INTO history (title, url, prompt, response, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        [state.title, state.url, promptText, response, JSON.stringify(state.messages), now, now]
      );
      state.historyId = result[0]?.values[0][0] ?? null;
    }
    console.log('[Service Worker] History saved for window', windowId, 'historyId:', state.historyId);
  } catch (error: any) {
    console.error('[Service Worker] Failed to save history:', error);
  }
}

async function generateAITitle(apiConfig: ApiConfig, content: string): Promise<string | null> {
  try {
    const baseUrl = apiConfig.base_url.replace(/\/$/, '');
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
          { role: 'user', content: `请根据以下内容生成一个简洁的标题（不超过15个字），只返回标题文本，不要加引号、序号或任何解释：\n\n${content.substring(0, 1500)}` }
        ],
        stream: false,
        max_tokens: 30
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const title = data.choices?.[0]?.message?.content?.trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^[\d\.\-\*\#]+\s*/, '')
      .trim();
    return title || null;
  } catch (error: any) {
    console.error('[Service Worker] AI title generation failed:', error.message);
    return null;
  }
}

async function getHistoryList(limit: number = 100, keyword?: string): Promise<any[]> {
  let sql = 'SELECT id, title, url, prompt, created_at, updated_at FROM history';
  const params: unknown[] = [];
  if (keyword && keyword.trim()) {
    const pattern = `%${keyword.trim()}%`;
    sql += ' WHERE (title LIKE ? OR url LIKE ? OR prompt LIKE ?)';
    params.push(pattern, pattern, pattern);
  }
  sql += ' ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?';
  params.push(limit);
  const result = await dbQuery(sql, params);
  if (!result || result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map((row: any[]) => {
    const item: any = {};
    columns.forEach((col: string, i: number) => {
      item[col] = row[i];
    });
    return item;
  });
}

async function getHistoryDetail(id: number): Promise<any | null> {
  const result = await dbQuery('SELECT * FROM history WHERE id = ?', [id]);
  if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
    return null;
  }
  const columns = result[0].columns;
  const row = result[0].values[0];
  const item: any = {};
  columns.forEach((col: string, i: number) => {
    item[col] = row[i];
  });
  return item;
}

async function deleteHistory(id: number): Promise<void> {
  await dbExec('DELETE FROM history WHERE id = ?', [id]);
}

async function clearHistory(): Promise<void> {
  await dbExec('DELETE FROM history');
}

async function updateHistory(id: number, messages: string, response: string): Promise<void> {
  const now = Date.now();
  await dbExec(
    'UPDATE history SET messages = ?, response = ?, updated_at = ? WHERE id = ?',
    [messages, response, now, id]
  );
}

// ============================================================================
// PDF Helpers
// ============================================================================

/**
 * Extract a filename hint from a Content-Disposition style string.
 * Handles both `filename="name.pdf"` and `filename*=UTF-8''name.pdf`.
 */
function extractFilenameFromDisposition(value: string): string | null {
  const filenameStar = value.match(/filename\*=['"]?UTF-8['"]?['"]?(?:%27)?([^;'"]+)/i);
  if (filenameStar) return decodeURIComponent(filenameStar[1].replace(/%27/g, "'"));
  const filename = value.match(/filename=['"]?([^;'"]+)['"]?/i);
  if (filename) return filename[1];
  return null;
}

/**
 * Resolve a URL to its underlying PDF URL.
 * Returns the PDF URL if the given URL is or points to a PDF, otherwise null.
 */
function resolvePdfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // Direct PDF link
    if (u.pathname.toLowerCase().endsWith('.pdf')) return url;

    // Check query params for PDF indicators
    const disposition = u.searchParams.get('response-content-disposition') || '';
    const contentType = u.searchParams.get('response-content-type') || '';
    const filenameParam = u.searchParams.get('filename') || '';

    if (disposition.toLowerCase().includes('.pdf')) return url;
    if (filenameParam.toLowerCase().endsWith('.pdf')) return url;
    if (contentType.includes('pdf') || contentType.includes('application/pdf')) return url;

    // Chrome built-in PDF viewer
    if (u.protocol === 'chrome:' && u.hostname === 'pdf-viewer') {
      const src = u.searchParams.get('src');
      if (src) return src;
      return url;
    }
    // Chrome extension PDF viewer (e.g. Chrome's default PDF viewer)
    if (u.pathname.includes('/pdf_viewer.html') || u.pathname.includes('/pdf_viewer')) {
      const src = u.searchParams.get('src');
      if (src) return src;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchPdfAsBase64(url: string): Promise<{ filename: string; data: string; size: number }> {
  console.log('[Service Worker] Fetching PDF from', url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 PDF 失败: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  if (blob.type && !blob.type.includes('pdf')) {
    console.warn('[Service Worker] Response content-type is not PDF:', blob.type);
  }
  const arrayBuffer = await blob.arrayBuffer();
  const size = arrayBuffer.byteLength;
  const MAX_PDF_SIZE = 32 * 1024 * 1024; // 32MB OpenAI limit
  if (size > MAX_PDF_SIZE) {
    throw new Error(`PDF 文件过大 (${(size / 1024 / 1024).toFixed(1)}MB)，超过 OpenAI API 限制的 32MB`);
  }
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  // Try to extract filename from multiple sources
  let filename = 'document.pdf';
  // 1. URL query param: response-content-disposition
  try {
    const u = new URL(url);
    const disposition = u.searchParams.get('response-content-disposition');
    if (disposition) {
      const name = extractFilenameFromDisposition(disposition);
      if (name) filename = name;
    }
  } catch {}
  // 2. URL query param: filename
  if (filename === 'document.pdf') {
    try {
      const u = new URL(url);
      const fn = u.searchParams.get('filename');
      if (fn) filename = fn;
    } catch {}
  }
  // 3. URL pathname
  if (filename === 'document.pdf') {
    try {
      const u = new URL(url);
      const pathParts = u.pathname.split('/');
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.toLowerCase().endsWith('.pdf')) {
        filename = decodeURIComponent(lastPart);
      }
    } catch {}
  }
  // 4. Response Content-Disposition header
  if (filename === 'document.pdf') {
    const disposition = response.headers.get('content-disposition');
    if (disposition) {
      const name = extractFilenameFromDisposition(disposition);
      if (name) filename = name;
    }
  }

  console.log('[Service Worker] PDF fetched, size:', size, 'bytes, filename:', filename);
  return { filename, data: base64, size };
}

/**
 * Send PDF bytes to the offscreen document for text extraction.
 */
async function extractPdfTextViaOffscreen(arrayBuffer: ArrayBuffer): Promise<string> {
  await ensureOffscreenDocument();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  const response = await chrome.runtime.sendMessage({
    type: MessageType.EXTRACT_PDF_TEXT,
    base64
  });
  if (!response.success) {
    throw new Error(response.error || 'PDF 文本提取失败');
  }
  return response.text;
}

// ============================================================================
// AI Streaming
// ============================================================================

/**
 * Read chunks from a streaming response and forward them to the side panel.
 * Returns the full accumulated content.
 */
async function readStreamChunks(response: Response, windowId: number): Promise<string> {
  if (!response.body) {
    throw new Error('Response body is null');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let chunkCount = 0;
  let fullContent = '';
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
          fullContent += content;
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
  return fullContent;
}

async function streamAIResponse(
  windowId: number,
  promptPreview?: string,
  pdfBase64?: { filename: string; data: string }
): Promise<void> {
  const state = conversations.get(windowId);
  if (!state) {
    console.error('[Service Worker] No conversation state for window', windowId);
    return;
  }

  const isFollowUp = state.messages.filter(m => m.role === 'user').length > 1;

  // Notify side panel that stream is starting
  console.log('[Service Worker] Sending STREAM_START to window', windowId);
  try {
    const lastMsg = state.messages[state.messages.length - 1];
    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_START,
      windowId,
      promptPreview,
      isFollowUp,
      userMessage: isFollowUp && lastMsg.role === 'user' ? lastMsg.content : undefined
    });
    console.log('[Service Worker] STREAM_START sent');
  } catch (e: any) {
    console.error('[Service Worker] Failed to send STREAM_START:', e.message);
  }

  const controller = new AbortController();
  state.abortController = controller;
  const timeout = setTimeout(() => controller.abort(), 60000);

  async function doFetch(): Promise<Response> {
    const baseUrl = state.apiConfig.base_url.replace(/\/$/, '');

    // Build messages for API request
    const apiMessages = state.messages.map(m => ({ role: m.role, content: m.content }));

    // If PDF and last message is user, replace with file content type
    if (pdfBase64) {
      const lastIdx = apiMessages.length - 1;
      const lastMsg = apiMessages[lastIdx];
      if (lastMsg.role === 'user') {
        apiMessages[lastIdx] = {
          role: 'user',
          content: [
            { type: 'text', text: lastMsg.content },
            {
              type: 'file',
              file: {
                filename: pdfBase64.filename,
                file_data: `data:application/pdf;base64,${pdfBase64.data}`
              }
            }
          ]
        } as any;
      }
    }

    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiConfig.api_key}`
      },
      body: JSON.stringify({
        model: state.apiConfig.model,
        messages: apiMessages,
        stream: true
      }),
      signal: controller.signal
    });
  }

  try {
    console.log('[Service Worker] Calling AI API at', state.apiConfig.base_url);

    let response = await doFetch();

    // Fallback: if the API does not support 'file' content parts, extract text from the PDF and retry
    if (!response.ok && pdfBase64) {
      const errorText = await response.text().catch(() => 'Unknown error');
      const isFileTypeError = errorText.toLowerCase().includes('invalid part type') ||
                              errorText.toLowerCase().includes('file') ||
                              errorText.toLowerCase().includes('unsupported content');

      if (isFileTypeError) {
        console.log('[Service Worker] API does not support file type, falling back to text extraction');
        try {
          const pdfBytes = Uint8Array.from(atob(pdfBase64.data), c => c.charCodeAt(0));
          const extractedText = await extractPdfTextViaOffscreen(pdfBytes.buffer);

          // Send a notice to the side panel about the fallback
          await chrome.runtime.sendMessage({
            type: MessageType.STREAM_CHUNK,
            content: `> ⚠️ 当前 API 不支持 PDF 文件直接上传，已自动提取 PDF 文本内容作为替代。\n\n---\n\n`,
            windowId
          });

          // Update the last user message in state with extracted text
          const lastIdx = state.messages.length - 1;
          if (state.messages[lastIdx].role === 'user') {
            state.messages[lastIdx].content = state.prompt + '\n\n[PDF 文件：' + pdfBase64.filename + ']\n\n' + extractedText;
          }

          response = await doFetch();
        } catch (extractError: any) {
          console.error('[Service Worker] PDF fallback extraction failed:', extractError);
          throw new Error('当前 API 不支持 PDF 文件解析，且无法提取 PDF 文本内容。请使用支持 file 类型的 API（如 OpenAI 官方 API），或尝试普通网页。');
        }
      }
    }

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const fullContent = await readStreamChunks(response, windowId);

    // Append assistant message to state
    state.messages.push({ role: 'assistant', content: fullContent });

    // Generate title and save history before notifying completion
    // so sidepanel can receive historyId for follow-up recovery
    if (state.historyId === null) {
      const generatedTitle = await generateAITitle(state.apiConfig, fullContent);
      if (generatedTitle) {
        state.title = generatedTitle;
        console.log('[Service Worker] AI title generated:', generatedTitle);
      }
    }
    await saveOrUpdateHistory(windowId, fullContent);

    await chrome.runtime.sendMessage({
      type: MessageType.STREAM_COMPLETE,
      windowId,
      historyId: state.historyId
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
    state.abortController = null;
  }
}

// ============================================================================
// Execute Prompt
// ============================================================================

async function executePrompt(
  tabId: number,
  windowId: number,
  promptId?: number,
  promptTemplate?: string,
  tabUrl?: string
): Promise<void> {
  // MV3 service worker can be terminated after sendResponse. Keep it alive.
  const keepAlive = setInterval(() => {
    chrome.storage.local.get('__keepalive').catch(() => {});
  }, 4000);

  try {
    const pdfUrl = tabUrl ? resolvePdfUrl(tabUrl) : null;
    const isPdf = pdfUrl !== null;
    console.log('[Service Worker] Tab URL:', tabUrl, 'isPdf:', isPdf, 'pdfUrl:', pdfUrl);

    let finalPrompt: string;
    let pdfBase64: { filename: string; data: string } | undefined;
    let template: string;
    let pageContent: PageContent | undefined;

    // 1. Get page content (HTML) or fetch PDF
    if (isPdf && pdfUrl) {
      console.log('[Service Worker] Step 1: Detected PDF page, fetching...');
      try {
        const pdf = await fetchPdfAsBase64(pdfUrl);
        pdfBase64 = { filename: pdf.filename, data: pdf.data };
      } catch (error: any) {
        console.error('[Service Worker] Failed to fetch PDF:', error.message);
        await new Promise(r => setTimeout(r, 1000));
        try {
          await chrome.runtime.sendMessage({
            type: MessageType.STREAM_ERROR,
            error: `无法下载 PDF：${error.message}`,
            windowId
          });
        } catch (sendErr: any) {
          console.error('[Service Worker] Failed to send STREAM_ERROR:', sendErr.message);
        }
        return;
      }

      // Get prompt template
      if (promptTemplate !== undefined) {
        template = promptTemplate;
      } else {
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
        template = prompt.prompt;
      }

      // Replace variables: ${html} becomes a PDF hint, ${text} stays as selection (empty for PDFs)
      finalPrompt = template
        .replace(/\$\{html\}/g, `（以下是一份 PDF 文件：${tabUrl}）`)
        .replace(/\$\{text\}/g, '(未选中文字)');
      console.log('[Service Worker] PDF prompt length:', finalPrompt.length);
      // Conversation state will be created after API config is loaded
    } else {
      // Normal HTML page flow
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

      // Get prompt template
      if (promptTemplate !== undefined) {
        template = promptTemplate;
      } else {
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
        template = prompt.prompt;
      }

      // Replace variables
      finalPrompt = template
        .replace(/\$\{html\}/g, pageContent.html.substring(0, MAX_CONTENT_LENGTH))
        .replace(/\$\{text\}/g, pageContent.text || '(未选中文字)');
      console.log('[Service Worker] Final prompt length:', finalPrompt.length);
      // Conversation state will be created after API config is loaded
    }

    // 2. Get API config
    console.log('[Service Worker] Step 2: Getting API config');
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

    // 3. Wait for side panel to fully load before sending stream messages
    console.log('[Service Worker] Step 3: Waiting for side panel to load...');
    await new Promise(r => setTimeout(r, 1500));
    // Pass the substituted prompt as preview so side panel shows real content
    const preview = finalPrompt.length > 200 ? finalPrompt.slice(0, 200) + '...' : finalPrompt;
    console.log('[Service Worker] Starting AI stream, preview:', preview);

    // Create conversation state
    conversations.delete(windowId);
    const state: ConversationState = {
      historyId: null,
      title: isPdf ? (pdfBase64?.filename || 'PDF 文件') : (pageContent?.title || '未命名页面'),
      url: tabUrl || '',
      prompt: finalPrompt,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Please respond in the same language as the user query.' },
        { role: 'user', content: finalPrompt }
      ],
      abortController: null,
      apiConfig
    };
    conversations.set(windowId, state);

    await streamAIResponse(windowId, preview, pdfBase64);
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

async function showPageMarkdown(tabId: number, windowId: number, tabUrl?: string): Promise<void> {
  try {
    // Check if PDF page
    const pdfUrl = tabUrl ? resolvePdfUrl(tabUrl) : null;
    if (pdfUrl) {
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_START,
        windowId
      });
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_CHUNK,
        content: `> 📄 当前页面是 PDF 文件：\`${tabUrl}\`\n\nPDF 内容无法直接以 Markdown 显示。请使用「总结页面」等提示词让 AI 解析此 PDF。`,
        windowId
      });
      await chrome.runtime.sendMessage({
        type: MessageType.STREAM_COMPLETE,
        windowId
      });
      return;
    }

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

        case MessageType.TEST_API_CONNECTION: {
          const { baseUrl, apiKey, model } = message as any;
          console.log('[Service Worker] Testing API connection:', baseUrl, 'model:', model);
          try {
            const url = (baseUrl || '').replace(/\/$/, '') + '/chat/completions';
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: model || 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'Hi' }],
                max_completion_tokens: 1
              })
            });
            if (response.ok) {
              sendResponse({ success: true });
            } else {
              const errorText = await response.text().catch(() => 'Unknown error');
              let friendlyError = `API 错误 ${response.status}`;
              if (response.status === 401) {
                friendlyError = 'API Key 无效或已过期';
              } else if (response.status === 404) {
                friendlyError = '模型不存在或 Base URL 错误';
              } else if (response.status === 429) {
                friendlyError = '请求过于频繁，请稍后再试';
              }
              console.error('[Service Worker] API test failed:', response.status, errorText);
              sendResponse({ success: false, error: friendlyError });
            }
          } catch (error: any) {
            console.error('[Service Worker] API test network error:', error);
            sendResponse({ success: false, error: '网络错误：' + (error.message || '无法连接到 API') });
          }
          break;
        }

        // Execution
        case MessageType.EXECUTE_PROMPT: {
          const { promptId, promptTemplate, tabId, tabUrl, windowId } = message as any;
          console.log('[Service Worker] Received EXECUTE_PROMPT:', { promptId, promptTemplate: promptTemplate ? '(custom)' : undefined, tabId, tabUrl, windowId });
          // Execute asynchronously without blocking the response
          sendResponse({ success: true });
          executePrompt(tabId, windowId, promptId, promptTemplate, tabUrl);
          break;
        }

        case MessageType.ABORT_STREAM: {
          const { windowId } = message as any;
          console.log('[Service Worker] Received ABORT_STREAM for window', windowId);
          const state = conversations.get(windowId);
          if (state?.abortController) {
            state.abortController.abort();
            state.abortController = null;
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'No active stream for this window' });
          }
          break;
        }

        case MessageType.SEND_FOLLOW_UP: {
          const { text, windowId, historyId } = message as any;
          console.log('[Service Worker] Received SEND_FOLLOW_UP for window', windowId);

          let state = conversations.get(windowId);

          // If no active conversation but historyId provided, load from history
          if (!state && historyId) {
            const item = await getHistoryDetail(historyId);
            if (!item || !item.messages) {
              sendResponse({ success: false, error: '历史记录不存在或无法读取对话内容' });
              return;
            }
            try {
              const messages = JSON.parse(item.messages) as Array<{role: string; content: string}>;
              const apiConfig = await getApiConfig();
              state = {
                historyId: item.id,
                title: item.title,
                url: item.url || '',
                prompt: item.prompt || '',
                messages,
                abortController: null,
                apiConfig
              };
              conversations.set(windowId, state);
            } catch {
              sendResponse({ success: false, error: '对话内容解析失败' });
              return;
            }
          }

          if (!state) {
            sendResponse({ success: false, error: '当前没有活跃的对话' });
            return;
          }

          sendResponse({ success: true });

          // Append user message
          state.messages.push({ role: 'user', content: text });

          const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
          streamAIResponse(windowId, preview);
          break;
        }

        case MessageType.SHOW_PAGE_MARKDOWN: {
          const { tabId, tabUrl, windowId } = message as any;
          console.log('[Service Worker] Received SHOW_PAGE_MARKDOWN:', { tabId, tabUrl, windowId });
          sendResponse({ success: true });
          showPageMarkdown(tabId, windowId, tabUrl);
          break;
        }

        // History operations
        case MessageType.GET_HISTORY_LIST: {
          const limit = (message as any).limit || 100;
          const keyword = (message as any).keyword;
          const items = await getHistoryList(limit, keyword);
          sendResponse({ success: true, data: items });
          break;
        }

        case MessageType.GET_HISTORY_DETAIL: {
          const { id } = message as any;
          const item = await getHistoryDetail(id);
          sendResponse({ success: true, data: item });
          break;
        }

        case MessageType.DELETE_HISTORY: {
          const { id } = message as any;
          await deleteHistory(id);
          sendResponse({ success: true });
          break;
        }

        case MessageType.CLEAR_HISTORY: {
          await clearHistory();
          sendResponse({ success: true });
          break;
        }

        case MessageType.UPDATE_HISTORY: {
          const { id, messages, response } = message as any;
          await updateHistory(id, messages, response);
          sendResponse({ success: true });
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
