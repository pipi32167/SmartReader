import { MessageType } from '../shared/types';
import type { Prompt } from '../shared/types';

let prompts: Prompt[] = [];

async function init() {
  document.getElementById('optionsBtn')?.addEventListener('click', openOptions);
  document.getElementById('markdownBtn')?.addEventListener('click', handleMarkdownClick);
  document.getElementById('addPromptBtn')?.addEventListener('click', openOptions);
  document.getElementById('customSendBtn')?.addEventListener('click', handleCustomSend);

  // Allow Ctrl+Enter to send from textarea
  document.getElementById('customPrompt')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleCustomSend();
    }
  });

  await loadPrompts();
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

    // Open side panel first (requires user gesture context)
    await chrome.sidePanel.open({ windowId: tab.windowId });

    // Trigger execution and await to ensure message is sent before popup closes
    console.log('[Popup] Sending EXECUTE_PROMPT...');
    await chrome.runtime.sendMessage({
      type: MessageType.EXECUTE_PROMPT,
      promptId,
      tabId: tab.id,
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

async function handleCustomSend() {
  const textarea = document.getElementById('customPrompt') as HTMLTextAreaElement;
  const userInput = textarea?.value.trim();

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

    // Prepend ${html} at the beginning as required
    const promptTemplate = `\${html}\n${userInput}`;

    // Open side panel first (requires user gesture context)
    await chrome.sidePanel.open({ windowId: tab.windowId });

    // Trigger execution with custom template
    console.log('[Popup] Sending custom prompt...');
    await chrome.runtime.sendMessage({
      type: MessageType.EXECUTE_PROMPT,
      promptTemplate,
      tabId: tab.id,
      windowId: tab.windowId
    });
    console.log('[Popup] Custom prompt sent successfully');

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
