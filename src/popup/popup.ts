import { MessageType } from '../shared/types';
import type { Prompt } from '../shared/types';

let prompts: Prompt[] = [];

const POPUP_INPUT_CACHE_KEY = 'popup_custom_prompt_input';

async function init() {
  document.getElementById('optionsBtn')?.addEventListener('click', openOptions);
  document.getElementById('markdownBtn')?.addEventListener('click', handleMarkdownClick);
  document.getElementById('historyBtn')?.addEventListener('click', handleHistoryClick);
  document.getElementById('addPromptBtn')?.addEventListener('click', openOptions);
  document.getElementById('customSendBtn')?.addEventListener('click', handleCustomSend);

  // Allow Ctrl+Enter to send from textarea
  document.getElementById('customPrompt')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleCustomSend();
    }
  });

  // Cache input on every keystroke
  document.getElementById('customPrompt')?.addEventListener('input', (e) => {
    const value = (e.target as HTMLTextAreaElement).value;
    chrome.storage.local.set({ [POPUP_INPUT_CACHE_KEY]: value }).catch(() => {});
  });

  await loadPrompts();

  // Restore cached input after prompts are loaded
  try {
    const result = await chrome.storage.local.get(POPUP_INPUT_CACHE_KEY);
    const cachedValue = result[POPUP_INPUT_CACHE_KEY];
    if (cachedValue) {
      const textarea = document.getElementById('customPrompt') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = cachedValue;
      }
    }
  } catch {
    // Ignore storage errors
  }

  // Detect selection state from current tab
  await detectContextStatus();
}

async function loadPrompts() {
  showLoading(true);
  hideError();

  try {
    const response = await chrome.runtime.sendMessage({ type: MessageType.GET_PROMPTS });
    console.log('[Popup] GET_PROMPTS response:', response);
    if (response && response.success) {
      prompts = response.data || [];
      renderPrompts();
    } else {
      const err = response?.error || '加载提示词失败';
      console.error('[Popup] GET_PROMPTS failed:', err, response);
      showError(err);
    }
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    showError('无法连接到后台服务: ' + errMsg);
    console.error('[Popup] Failed to load prompts:', error);
  } finally {
    showLoading(false);
  }
}

function renderPrompts() {
  const container = document.getElementById('prompt-list');
  const emptyState = document.getElementById('empty-state');
  const section = document.getElementById('saved-prompts-section');

  if (!container || !emptyState || !section) return;

  if (prompts.length === 0) {
    container.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  container.classList.remove('hidden');
  emptyState.classList.add('hidden');

  container.innerHTML = prompts.map((prompt, index) => `
    <button class="prompt-item" data-id="${prompt.id}" data-index="${index}">
      <span class="prompt-icon">💬</span>
      <span class="prompt-title">${escapeHtml(prompt.title)}</span>
    </button>
  `).join('');

  container.querySelectorAll('.prompt-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const promptId = Number((btn as HTMLElement).dataset.id);
      handlePromptClick(promptId);
    });
  });
}

async function handlePromptClick(promptId: number) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) {
      showError('无法获取当前标签页');
      return;
    }

    // Check API config before opening side panel
    const apiConfig = await chrome.runtime.sendMessage({ type: MessageType.GET_API_CONFIG });
    if (!apiConfig?.data?.api_key) {
      showError('API Key 未配置，请先在设置中配置 API');
      setTimeout(() => {
        chrome.runtime.openOptionsPage();
        window.close();
      }, 1200);
      return;
    }

    // Open side panel first (requires user gesture context)
    await chrome.sidePanel.open({ windowId: tab.windowId });

    // Trigger execution and await to ensure message is sent before popup closes
    console.log('[Popup] Sending EXECUTE_PROMPT...');
    await chrome.runtime.sendMessage({
      type: MessageType.EXECUTE_PROMPT,
      promptId,
      tabId: tab.id,
      tabUrl: tab.url || '',
      windowId: tab.windowId
    });
    console.log('[Popup] EXECUTE_PROMPT sent successfully');

    // Close popup
    window.close();
  } catch (error: any) {
    showError('操作失败: ' + error.message);
    console.error('[Popup] handlePromptClick error:', error);
  }
}

async function detectContextStatus() {
  const statusEl = document.getElementById('contextStatus');
  if (!statusEl) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      statusEl.textContent = '📄 网页全文';
      return;
    }

    // Inject content script if not already present
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-script.js']
      });
    } catch {
      // May already be injected
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: MessageType.GET_SELECTION });
    if (response?.success && response.data?.text?.trim()) {
      statusEl.textContent = '📝 选中文字';
    } else {
      statusEl.textContent = '📄 网页全文';
    }
  } catch {
    // Default to full page on any error
    statusEl.textContent = '📄 网页全文';
  }
}

async function handleCustomSend() {
  const textarea = document.getElementById('customPrompt') as HTMLTextAreaElement;
  const userInput = textarea?.value.trim();
  const includeContent = (document.getElementById('includeContent') as HTMLInputElement)?.checked ?? true;

  if (!userInput) {
    showError('请输入指令');
    return;
  }

  hideError();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) {
      showError('无法获取当前标签页');
      return;
    }

    // Check API config before opening side panel
    const apiConfig = await chrome.runtime.sendMessage({ type: MessageType.GET_API_CONFIG });
    if (!apiConfig?.data?.api_key) {
      showError('API Key 未配置，请先在设置中配置 API');
      setTimeout(() => {
        chrome.runtime.openOptionsPage();
        window.close();
      }, 1200);
      return;
    }

    // Build prompt template based on checkbox state
    const promptTemplate = includeContent ? `\${html}\n${userInput}` : userInput;

    // Open side panel first (requires user gesture context)
    await chrome.sidePanel.open({ windowId: tab.windowId });

    // Trigger execution with custom template
    console.log('[Popup] Sending custom prompt...');
    await chrome.runtime.sendMessage({
      type: MessageType.EXECUTE_PROMPT,
      promptTemplate,
      tabId: tab.id,
      tabUrl: tab.url || '',
      windowId: tab.windowId,
      skipContent: !includeContent
    });
    console.log('[Popup] Custom prompt sent successfully');

    // Clear cached input after successful send
    chrome.storage.local.remove(POPUP_INPUT_CACHE_KEY).catch(() => {});

    // Close popup
    window.close();
  } catch (error: any) {
    showError('操作失败: ' + error.message);
    console.error('[Popup] handleCustomSend error:', error);
  }
}

async function handleMarkdownClick() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) {
      showError('无法获取当前标签页');
      return;
    }

    // Open side panel first (requires user gesture context)
    await chrome.sidePanel.open({ windowId: tab.windowId });

    // Request page markdown display
    console.log('[Popup] Sending SHOW_PAGE_MARKDOWN...');
    await chrome.runtime.sendMessage({
      type: MessageType.SHOW_PAGE_MARKDOWN,
      tabId: tab.id,
      tabUrl: tab.url || '',
      windowId: tab.windowId
    });
    console.log('[Popup] SHOW_PAGE_MARKDOWN sent successfully');

    // Close popup
    window.close();
  } catch (error: any) {
    showError('操作失败: ' + error.message);
    console.error('[Popup] handleMarkdownClick error:', error);
  }
}

async function handleHistoryClick() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.windowId) {
      showError('无法获取当前窗口');
      return;
    }

    // Open side panel first (requires user gesture context)
    await chrome.sidePanel.open({ windowId: tab.windowId });

    // Notify side panel to show history view
    console.log('[Popup] Sending SHOW_HISTORY_VIEW...');
    await chrome.runtime.sendMessage({
      type: MessageType.SHOW_HISTORY_VIEW,
      windowId: tab.windowId
    });
    console.log('[Popup] SHOW_HISTORY_VIEW sent successfully');

    // Close popup
    window.close();
  } catch (error: any) {
    showError('操作失败: ' + error.message);
    console.error('[Popup] handleHistoryClick error:', error);
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function showLoading(show: boolean) {
  const el = document.getElementById('loading');
  if (el) el.classList.toggle('hidden', !show);
}

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

function hideError() {
  const el = document.getElementById('error');
  if (el) el.classList.add('hidden');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize
document.addEventListener('DOMContentLoaded', init);
