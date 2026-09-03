import { marked } from 'marked';
import { MessageType } from '../shared/types';
import { t, initPage, initTranslations } from '../shared/i18n';

const CHAT_PORT_NAME = 'smartreader-chat';

interface ChatMsg {
  role: string;
  content: string;
}

interface HistoryMeta {
  id: number;
  title: string;
  url: string;
  prompt: string;
  created_at: number;
  updated_at?: number;
}

let port: chrome.runtime.Port | null = null;
let supportsFollowUp = false;
let isStreaming = false;
let isPageUnloading = false;
let disconnected = false;

/**
 * The authoritative message list mirrors the service-worker session state and
 * INCLUDES the leading system item, so delete/retry indices map 1:1 to the SW.
 * System messages are skipped when rendering.
 */
let messages: ChatMsg[] = [];
let accumulatedContent = '';

// ============================================================================
// i18n / markdown helpers (local copies, consistent with other pages)
// ============================================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  // Also escape quotes so the result is safe inside title="..." attributes.
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMarkdown(content: string): string {
  if (!content) return '';
  try {
    return marked.parse(content, { async: false }) as string;
  } catch {
    return `<div class="streaming-text">${escapeHtml(content)}</div>`;
  }
}

async function copyMarkdownToClipboard(text: string, btn?: HTMLElement) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  } catch (err) {
    console.error('[Chat] Copy failed:', err);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '❌';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  }
}

marked.use({
  gfm: true,
  breaks: true,
});

// ============================================================================
// DOM helpers
// ============================================================================

function getThread(): HTMLElement | null {
  return document.getElementById('thread');
}

function scrollToBottom() {
  const main = document.querySelector('.chat-main');
  if (main) {
    main.scrollTop = main.scrollHeight;
  }
}

function updateStatus(state: 'idle' | 'active' | 'error' | 'aborted', text: string) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  if (dot) {
    dot.className = 'status-dot';
    if (state === 'active') dot.classList.add('active');
    if (state === 'error') dot.classList.add('error');
    if (state === 'aborted') dot.classList.add('aborted');
  }
  if (statusText) {
    statusText.textContent = text;
  }
}

function getLastUserContent(msgs: ChatMsg[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i].content;
  }
  return null;
}

function setFollowUpVisibility() {
  const area = document.getElementById('followUpArea');
  if (!area) return;
  const show = supportsFollowUp && !isStreaming && !disconnected && port !== null;
  area.classList.toggle('hidden', !show);
}

function setAbortVisibility(visible: boolean, disabled = false) {
  const btn = document.getElementById('abortBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.classList.toggle('hidden', !visible);
  btn.disabled = disabled;
}

// ============================================================================
// Rendering
// ============================================================================

function showLoading() {
  const el = document.getElementById('chatLoading');
  if (el) {
    el.textContent = t('sidepanel.loading');
    el.classList.remove('hidden');
  }
}

function hideLoading() {
  const el = document.getElementById('chatLoading');
  if (el) el.classList.add('hidden');
}

function showChatError(error: string) {
  hideLoading();
  const el = document.getElementById('chatError');
  if (el) {
    el.textContent = error;
    el.classList.remove('hidden');
  }
  setFollowUpVisibility();
}

function hideChatError() {
  const el = document.getElementById('chatError');
  if (el) el.classList.add('hidden');
}

function removeStreamingTurn() {
  const thread = getThread();
  if (thread) {
    const el = thread.querySelector('.streaming-turn');
    if (el) el.remove();
  }
}

function renderThread() {
  const thread = getThread();
  if (!thread) return;
  hideChatError();
  thread.innerHTML = buildThreadHtml();
  bindMessageActions();
  scrollToBottom();
}

function buildThreadHtml(): string {
  let html = '';
  messages.forEach((msg, index) => {
    if (msg.role === 'system') return; // keep index aligned with the SW session
    if (msg.role === 'user') {
      const userContent = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
      html += `<div class="turn user-turn" data-index="${index}" title="${escapeHtml(msg.content)}">
        <button class="msg-delete-btn" data-index="${index}" title="${t('sidepanel.btn.deleteMessage')}">🗑</button>
        ${escapeHtml(userContent)}
      </div>`;
    } else if (msg.role === 'assistant') {
      html += `<div class="turn" data-index="${index}">
        <div class="turn-toolbar">
          <button class="msg-copy-btn" data-index="${index}" title="${t('sidepanel.btn.copyMarkdown')}">📋</button>
          <button class="msg-delete-btn" data-index="${index}" title="${t('sidepanel.btn.deleteMessage')}">🗑</button>
          <button class="msg-retry-btn" data-index="${index}" title="${t('sidepanel.btn.retry')}">🔄</button>
        </div>
        <div class="markdown-content">${renderMarkdown(msg.content)}</div>
      </div>`;
    }
  });
  return html;
}

function bindMessageActions() {
  const thread = getThread();
  if (!thread) return;

  thread.querySelectorAll('.msg-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number((btn as HTMLElement).dataset.index);
      deleteMessage(index);
    });
  });

  thread.querySelectorAll('.msg-retry-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number((btn as HTMLElement).dataset.index);
      retryMessage(index);
    });
  });

  thread.querySelectorAll('.msg-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number((btn as HTMLElement).dataset.index);
      const msg = messages[index];
      if (msg?.role === 'assistant') {
        copyMarkdownToClipboard(msg.content, btn as HTMLElement);
      }
    });
  });
}

function appendErrorPanel(error: string) {
  const thread = getThread();
  if (!thread) return;
  const el = document.createElement('div');
  el.className = 'error-message';
  el.innerHTML = `<h3>${t('sidepanel.error.title')}</h3><p>${escapeHtml(error)}</p>`;
  thread.appendChild(el);
  scrollToBottom();
}

function renderStreamingTurn() {
  const thread = getThread();
  if (!thread) return;
  removeStreamingTurn();
  const el = document.createElement('div');
  el.className = 'turn streaming-turn';
  el.innerHTML = '<div class="streaming-text"><span id="stream-content"></span><span class="cursor"></span></div>';
  thread.appendChild(el);
  scrollToBottom();
}

function freezePartialContent() {
  const thread = getThread();
  if (!thread || !accumulatedContent) return;
  const el = document.createElement('div');
  el.className = 'turn';
  el.innerHTML = `<div class="markdown-content">${renderMarkdown(accumulatedContent)}</div>`;
  thread.appendChild(el);
}

function setHeader(meta: HistoryMeta) {
  const titleEl = document.getElementById('chatTitle');
  if (titleEl) {
    titleEl.textContent = meta.title || t('sidepanel.label.untitled');
  }
  const linkEl = document.getElementById('chatSourceLink') as HTMLAnchorElement | null;
  if (linkEl) {
    if (meta.url) {
      linkEl.textContent = meta.url;
      linkEl.href = meta.url;
      linkEl.classList.remove('hidden');
    } else {
      linkEl.classList.add('hidden');
    }
  }
}

// ============================================================================
// Actions
// ============================================================================

function handleSendFollowUp() {
  const input = document.getElementById('followUpInput') as HTMLTextAreaElement | null;
  if (!input || isStreaming || disconnected || !port || !supportsFollowUp) return;

  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  resizeInput(input);

  // Optimistic local append so the new question is visible immediately. The SW
  // mirrors this into its session state when it starts the stream.
  messages = [...messages, { role: 'user', content: text }];
  isStreaming = true;
  setAbortVisibility(true);
  setFollowUpVisibility();
  renderThread();
  renderStreamingTurn();

  port.postMessage({ type: MessageType.CHAT_FOLLOW_UP, text });
  updateStatus('active', t('sidepanel.status.generating'));
}

function deleteMessage(index: number) {
  if (isStreaming || disconnected || !port) return;
  if (!window.confirm(t('sidepanel.confirm.deleteMessage'))) return;
  port.postMessage({ type: MessageType.CHAT_DELETE_MESSAGE, messageIndex: index });
}

function retryMessage(index: number) {
  if (isStreaming || disconnected || !port) return;
  if (!window.confirm(t('sidepanel.confirm.retryMessage'))) return;

  messages = messages.slice(0, index);
  isStreaming = true;
  setAbortVisibility(true);
  setFollowUpVisibility();
  renderThread();
  renderStreamingTurn();

  port.postMessage({ type: MessageType.CHAT_RETRY, messageIndex: index });
  updateStatus('active', t('sidepanel.status.generating'));
}

function handleAbort() {
  if (!isStreaming || !port) return;
  setAbortVisibility(true, true);
  updateStatus('active', t('sidepanel.status.aborting'));
  port.postMessage({ type: MessageType.CHAT_ABORT });
}

function resizeInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
}

// ============================================================================
// Port message handling
// ============================================================================

function handlePortMessage(event: any) {
  if (!event || !event.type) return;

  switch (event.type) {
    case MessageType.CHAT_OPENED:
      handleChatOpened(event);
      break;

    case MessageType.CHAT_OPEN_ERROR:
      isStreaming = false;
      supportsFollowUp = false;
      setAbortVisibility(false);
      setFollowUpVisibility();
      showChatError(event.error || t('sidepanel.error.unknown'));
      updateStatus('error', t('sidepanel.status.error'));
      break;

    case MessageType.STREAM_START:
      handleStreamStart(event);
      break;

    case MessageType.STREAM_CHUNK:
      handleStreamChunk(event.content);
      break;

    case MessageType.STREAM_COMPLETE:
      handleStreamComplete(event);
      break;

    case MessageType.STREAM_ERROR:
      handleStreamError(event.error);
      break;

    case MessageType.STREAM_ABORTED:
      handleStreamAborted();
      break;

    case MessageType.CHAT_DELETED:
      if (Array.isArray(event.messages)) {
        messages = event.messages as ChatMsg[];
        renderThread();
      }
      break;

    default:
      break;
  }
}

function handleChatOpened(event: any) {
  const history = event.history as HistoryMeta | undefined;
  if (history) {
    setHeader(history);
  }
  supportsFollowUp = !!event.supportsFollowUp;
  hideLoading();
  isStreaming = false;
  setAbortVisibility(false);
  accumulatedContent = '';

  if (supportsFollowUp && Array.isArray(event.messages)) {
    messages = event.messages as ChatMsg[];
    renderThread();
    updateStatus('idle', t('sidepanel.status.ready'));
  } else {
    // Legacy record without a `messages` column: read-only Markdown view.
    messages = [];
    const thread = getThread();
    if (thread) {
      hideChatError();
      const response = typeof event.response === 'string' ? event.response : '';
      thread.innerHTML = `<div class="turn"><div class="markdown-content">${renderMarkdown(response)}</div></div>`;
    }
    updateStatus('idle', t('sidepanel.status.ready'));
  }
  setFollowUpVisibility();
  scrollToBottom();
}

function handleStreamStart(event: any) {
  isStreaming = true;
  accumulatedContent = '';
  removeStreamingTurn();

  // The SW only echoes the user follow-up that starts a new turn. With an
  // optimistic append it is already present as the last user message, so we
  // add it only when it differs (defensive for retry/reconnect edge cases).
  if (event.isFollowUp && event.userMessage) {
    if (getLastUserContent(messages) !== event.userMessage) {
      messages = [...messages, { role: 'user', content: event.userMessage }];
    }
  }

  renderThread();
  renderStreamingTurn();
  setAbortVisibility(true);
  setFollowUpVisibility();
  updateStatus('active', t('sidepanel.status.generating'));
  scrollToBottom();
}

function handleStreamChunk(content: string) {
  if (!isStreaming) return;
  accumulatedContent += content;
  const streamContent = document.getElementById('stream-content');
  if (streamContent) {
    streamContent.textContent = accumulatedContent;
  }
  scrollToBottom();
}

function handleStreamComplete(event: any) {
  isStreaming = false;
  accumulatedContent = '';
  if (Array.isArray(event.messages)) {
    messages = event.messages as ChatMsg[];
  }
  removeStreamingTurn();
  setAbortVisibility(false);
  renderThread();
  setFollowUpVisibility();
  updateStatus('idle', t('sidepanel.status.completed'));
  scrollToBottom();
}

function handleStreamError(error: string) {
  isStreaming = false;
  removeStreamingTurn();
  freezePartialContent();
  appendErrorPanel(error || t('sidepanel.error.unknown'));
  accumulatedContent = '';
  setAbortVisibility(false);
  setFollowUpVisibility();
  updateStatus('error', t('sidepanel.status.error'));
  scrollToBottom();
}

function handleStreamAborted() {
  isStreaming = false;
  removeStreamingTurn();
  freezePartialContent();
  accumulatedContent = '';
  setAbortVisibility(false);
  setFollowUpVisibility();
  updateStatus('aborted', t('sidepanel.status.aborted'));
  scrollToBottom();
}

function showDisconnected() {
  disconnected = true;
  isStreaming = false;
  setAbortVisibility(false);
  setFollowUpVisibility();
  hideLoading();
  showChatError(t('chat.error.disconnected'));
  updateStatus('error', t('sidepanel.status.error'));
}

// ============================================================================
// Connection
// ============================================================================

function connect(id: number) {
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connect({ name: CHAT_PORT_NAME });
  } catch (error) {
    console.error('[Chat] Failed to connect:', error);
    showChatError(t('chat.error.disconnected'));
    return;
  }

  port = p;
  p.onMessage.addListener((msg) => handlePortMessage(msg));
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    if (isPageUnloading) return;
    showDisconnected();
  });

  window.addEventListener('pagehide', () => {
    isPageUnloading = true;
    try {
      p.disconnect();
    } catch {}
  });

  p.postMessage({ type: MessageType.CHAT_OPEN, historyId: id });
}

// ============================================================================
// Init
// ============================================================================

async function init() {
  await initTranslations();
  await initPage();
  document.title = t('chat.title');

  const abortBtn = document.getElementById('abortBtn');
  if (abortBtn) {
    abortBtn.addEventListener('click', handleAbort);
  }

  const followUpSendBtn = document.getElementById('followUpSendBtn');
  const followUpInput = document.getElementById('followUpInput') as HTMLTextAreaElement | null;
  if (followUpSendBtn) {
    followUpSendBtn.addEventListener('click', handleSendFollowUp);
  }
  if (followUpInput) {
    followUpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendFollowUp();
      }
    });
    followUpInput.addEventListener('input', () => resizeInput(followUpInput));
  }

  const param = new URLSearchParams(window.location.search).get('historyId');
  const id = param ? Number(param) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    supportsFollowUp = false;
    showChatError(t('chat.error.noHistoryParam'));
    updateStatus('error', t('sidepanel.status.error'));
    return;
  }

  showLoading();
  connect(id);
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
