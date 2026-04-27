import { marked } from 'marked';
import { MessageType } from '../shared/types';

let accumulatedContent = '';
let isStreaming = false;
let currentWindowId: number | null = null;
let isReady = false;
const messageBuffer: any[] = [];

function init() {
  console.log('[SidePanel] init() called');

  // Listen for messages from service worker
  // Only respond to stream messages; silently ignore everything else
  // so we don't intercept responses meant for popup/options
  const STREAM_MESSAGE_TYPES = new Set([
    MessageType.STREAM_START,
    MessageType.STREAM_CHUNK,
    MessageType.STREAM_COMPLETE,
    MessageType.STREAM_ERROR,
    MessageType.STREAM_ABORTED,
  ]);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!STREAM_MESSAGE_TYPES.has(message.type)) {
      return false; // Not handled, let other listeners respond
    }
    handleMessage(message);
    sendResponse({ received: true });
    return true;
  });

  // Get current window ID for filtering messages
  chrome.windows.getCurrent().then(win => {
    currentWindowId = win.id ?? null;
    console.log('[SidePanel] Window ID:', currentWindowId);
  });

  // Mark as ready and process buffered messages
  isReady = true;
  console.log('[SidePanel] Ready, processing', messageBuffer.length, 'buffered messages');
  while (messageBuffer.length > 0) {
    const msg = messageBuffer.shift();
    if (msg) handleMessage(msg);
  }
}

function handleMessage(message: any) {
  // If not ready yet, buffer the message
  if (!isReady) {
    console.log('[SidePanel] Buffering message:', message.type);
    messageBuffer.push(message);
    return;
  }

  // Filter messages by window ID if provided
  if (message.windowId && currentWindowId && message.windowId !== currentWindowId) {
    return;
  }

  console.log('[SidePanel] Received message:', message.type);

  switch (message.type) {
    case MessageType.STREAM_START:
      handleStreamStart(message.promptPreview);
      break;

    case MessageType.STREAM_CHUNK:
      handleStreamChunk(message.content);
      break;

    case MessageType.STREAM_COMPLETE:
      handleStreamComplete();
      break;

    case MessageType.STREAM_ERROR:
      handleStreamError(message.error);
      break;

    case MessageType.STREAM_ABORTED:
      handleStreamAborted();
      break;
  }
}

function handleStreamStart(promptPreview?: string) {
  console.log('[SidePanel] STREAM_START, preview:', promptPreview);
  isStreaming = true;
  accumulatedContent = '';

  const output = document.getElementById('output');
  if (output) {
    output.innerHTML = '<div class="streaming-text"><span id="stream-content"></span><span class="cursor"></span></div>';
  }

  showAbortButton();
  hideCopyButton();
  updateStatus('active', 'AI 生成中...');

  if (promptPreview) {
    showPromptPreview(promptPreview);
  } else {
    hidePromptPreview();
  }
}

function handleStreamChunk(content: string) {
  if (!isStreaming) return;

  accumulatedContent += content;

  const streamContent = document.getElementById('stream-content');
  if (streamContent) {
    streamContent.textContent = accumulatedContent;
  }

  // Auto-scroll to bottom
  scrollToBottom();
}

function handleStreamComplete() {
  console.log('[SidePanel] STREAM_COMPLETE');
  isStreaming = false;
  updateStatus('idle', '完成');

  renderAccumulatedContent();
  hideAbortButton();
  showCopyButton();
  scrollToBottom();
}

function showPromptPreview(text: string) {
  const el = document.getElementById('promptPreview');
  if (el) {
    el.textContent = `💡 ${text}`;
    el.classList.remove('hidden');
  }
}

function hidePromptPreview() {
  const el = document.getElementById('promptPreview');
  if (el) {
    el.classList.add('hidden');
    el.textContent = '';
  }
}

function handleStreamError(error: string) {
  console.log('[SidePanel] STREAM_ERROR:', error);
  isStreaming = false;
  updateStatus('error', '出错');

  const output = document.getElementById('output');
  if (output) {
    output.innerHTML = `
      <div class="error-message">
        <h3>❌ 出错了</h3>
        <p>${escapeHtml(error)}</p>
      </div>
      ${accumulatedContent ? `<div class="markdown-content">${marked.parse(accumulatedContent, { async: false })}</div>` : ''}
    `;
  }

  hideAbortButton();
  hideCopyButton();
  hidePromptPreview();
}

function handleStreamAborted() {
  console.log('[SidePanel] STREAM_ABORTED');
  isStreaming = false;
  updateStatus('aborted', '已中断');

  renderAccumulatedContent();
  hideAbortButton();
  showCopyButton();
  scrollToBottom();
}

function renderAccumulatedContent() {
  const output = document.getElementById('output');
  if (output && accumulatedContent) {
    try {
      const html = marked.parse(accumulatedContent, { async: false }) as string;
      output.innerHTML = `<div class="markdown-content">${html}</div>`;
    } catch (error) {
      output.innerHTML = `<div class="streaming-text">${escapeHtml(accumulatedContent)}</div>`;
    }
  }
}

function updateStatus(state: 'idle' | 'active' | 'error' | 'aborted', text: string) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  if (dot) {
    dot.className = 'status-dot';
    if (state === 'active') dot.classList.add('active');
    if (state === 'error') dot.classList.add('error');
  }

  if (statusText) {
    statusText.textContent = text;
  }
}

function scrollToBottom() {
  const main = document.querySelector('.main');
  if (main) {
    main.scrollTop = main.scrollHeight;
  }
}

function showCopyButton() {
  const btn = document.getElementById('copyBtn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.textContent = '📋 拷贝 Markdown';
    btn.classList.remove('copied');
  }
}

function hideCopyButton() {
  const btn = document.getElementById('copyBtn');
  if (btn) {
    btn.classList.add('hidden');
    btn.classList.remove('copied');
  }
}

function showAbortButton() {
  const btn = document.getElementById('abortBtn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '⏹ 中断';
  }
}

function hideAbortButton() {
  const btn = document.getElementById('abortBtn');
  if (btn) {
    btn.classList.add('hidden');
    btn.disabled = false;
  }
}

async function handleAbortClick() {
  if (!isStreaming) return;

  const btn = document.getElementById('abortBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '中断中...';
  }

  try {
    const win = await chrome.windows.getCurrent();
    await chrome.runtime.sendMessage({
      type: MessageType.ABORT_STREAM,
      windowId: win.id
    });
  } catch (err) {
    console.error('[SidePanel] Abort failed:', err);
  }
}

async function handleCopyClick() {
  if (!accumulatedContent) return;

  try {
    await navigator.clipboard.writeText(accumulatedContent);
    const btn = document.getElementById('copyBtn');
    if (btn) {
      btn.textContent = '✓ 已拷贝';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋 拷贝 Markdown';
        btn.classList.remove('copied');
      }, 2000);
    }
  } catch (err) {
    console.error('[SidePanel] Copy failed:', err);
    const btn = document.getElementById('copyBtn');
    if (btn) {
      btn.textContent = '❌ 拷贝失败';
      setTimeout(() => {
        btn.textContent = '📋 拷贝 Markdown';
      }, 2000);
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Configure marked
marked.use({
  gfm: true,
  breaks: true,
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  init();
  const copyBtn = document.getElementById('copyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', handleCopyClick);
  }
  const abortBtn = document.getElementById('abortBtn');
  if (abortBtn) {
    abortBtn.addEventListener('click', handleAbortClick);
  }
});
