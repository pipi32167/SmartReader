import { marked } from 'marked';
import { MessageType } from '../shared/types';
import { debounce, truncate } from '../shared/utils';

let accumulatedContent = '';
let isStreaming = false;
let currentWindowId: number | null = null;
let isReady = false;
const messageBuffer: any[] = [];

// History view state
let currentView: 'output' | 'history-list' | 'history-detail' = 'output';
let currentHistoryId: number | null = null;
let currentOutputHistoryId: number | null = null;
let currentHistorySupportsFollowUp = false;
let currentHistoryMarkdown = '';
let showFavoritesOnly = false;

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
    MessageType.SHOW_HISTORY_VIEW,
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
      handleStreamStart(message.promptPreview, message.isFollowUp, message.userMessage);
      break;

    case MessageType.STREAM_CHUNK:
      handleStreamChunk(message.content);
      break;

    case MessageType.STREAM_COMPLETE:
      handleStreamComplete(message.historyId);
      break;

    case MessageType.STREAM_ERROR:
      handleStreamError(message.error);
      break;

    case MessageType.STREAM_ABORTED:
      handleStreamAborted();
      break;

    case MessageType.SHOW_HISTORY_VIEW:
      showView('history-list');
      loadHistoryList();
      break;
  }
}

function handleStreamStart(promptPreview?: string, isFollowUp?: boolean, userMessage?: string) {
  console.log('[SidePanel] STREAM_START, preview:', promptPreview, 'isFollowUp:', isFollowUp);
  isStreaming = true;

  // Auto-switch to output view when a stream starts
  showView('output');

  const conversationLog = document.getElementById('conversationLog');
  const currentResponse = document.getElementById('currentResponse');

  // New conversation: clear log and reset history id
  if (!isFollowUp && conversationLog) {
    conversationLog.innerHTML = '';
    currentOutputHistoryId = null;
  }

  // Archive previous turn if follow-up
  if (isFollowUp && accumulatedContent && conversationLog) {
    const turnDiv = document.createElement('div');
    turnDiv.className = 'turn';
    const archivedContent = accumulatedContent;
    turnDiv.innerHTML = `<div class="turn-toolbar"><button class="msg-copy-btn" title="拷贝 Markdown">📋</button></div><div class="markdown-content">${renderMarkdown(archivedContent)}</div>`;
    const copyBtn = turnDiv.querySelector('.msg-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => copyMarkdownToClipboard(archivedContent, copyBtn as HTMLElement));
    }
    conversationLog.appendChild(turnDiv);
  }

  // Show user follow-up message
  if (isFollowUp && userMessage && conversationLog) {
    const userDiv = document.createElement('div');
    userDiv.className = 'turn user-turn';
    userDiv.textContent = userMessage;
    conversationLog.appendChild(userDiv);
  }

  accumulatedContent = '';

  if (currentResponse) {
    currentResponse.innerHTML = '<div class="streaming-text"><span id="stream-content"></span><span class="cursor"></span></div>';
  }

  showAbortButton();
  hideFollowUpArea();
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

function handleStreamComplete(historyId?: number) {
  console.log('[SidePanel] STREAM_COMPLETE');
  isStreaming = false;
  updateStatus('idle', '完成');

  if (historyId) {
    currentOutputHistoryId = historyId;
  }

  renderAccumulatedContent();
  hideAbortButton();
  showFollowUpArea();
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

  const currentResponse = document.getElementById('currentResponse');
  if (currentResponse) {
    const retryBtnHtml = currentOutputHistoryId != null
      ? '<button class="msg-retry-btn" id="currentRetryBtn" title="重新生成">🔄</button>'
      : '';
    const contentHtml = accumulatedContent
      ? `<div class="response-toolbar"><button class="msg-copy-btn" data-copy="current" title="拷贝 Markdown">📋</button>${retryBtnHtml}</div><div class="markdown-content">${renderMarkdown(accumulatedContent)}</div>`
      : '';
    currentResponse.innerHTML = `
      <div class="error-message">
        <h3>❌ 出错了</h3>
        <p>${escapeHtml(error)}</p>
      </div>
      ${contentHtml}
    `;
    bindCurrentRetryButton();
    const copyBtn = currentResponse.querySelector('.msg-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => copyMarkdownToClipboard(accumulatedContent, copyBtn as HTMLElement));
    }
  }

  hideAbortButton();
  showFollowUpArea();
  hidePromptPreview();
}

function handleStreamAborted() {
  console.log('[SidePanel] STREAM_ABORTED');
  isStreaming = false;
  updateStatus('aborted', '已中断');

  renderAccumulatedContent();
  hideAbortButton();
  showFollowUpArea();
  scrollToBottom();
}

function renderAccumulatedContent() {
  const currentResponse = document.getElementById('currentResponse');
  if (currentResponse && accumulatedContent) {
    const retryBtnHtml = currentOutputHistoryId != null
      ? '<button class="msg-retry-btn" id="currentRetryBtn" title="重新生成">🔄</button>'
      : '';
    currentResponse.innerHTML = `<div class="response-toolbar"><button class="msg-copy-btn" data-copy="current" title="拷贝 Markdown">📋</button>${retryBtnHtml}</div><div class="markdown-content">${renderMarkdown(accumulatedContent)}</div>`;
    bindCurrentRetryButton();
    const copyBtn = currentResponse.querySelector('.msg-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => copyMarkdownToClipboard(accumulatedContent, copyBtn as HTMLElement));
    }
  }
}

function bindCurrentRetryButton() {
  const retryBtn = document.getElementById('currentRetryBtn');
  if (retryBtn) {
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      retryCurrentMessage();
    });
  }
}

async function retryCurrentMessage() {
  if (currentOutputHistoryId == null) {
    alert('对话尚未保存，无法重试');
    return;
  }
  try {
    const win = await chrome.windows.getCurrent();
    const response = await chrome.runtime.sendMessage({
      type: MessageType.RETRY_MESSAGE,
      historyId: currentOutputHistoryId,
      messageIndex: -1,
      windowId: win.id
    });
    if (!response?.success) {
      console.error('[SidePanel] Retry failed:', response?.error);
    }
  } catch (error) {
    console.error('[SidePanel] Failed to retry current message:', error);
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

function showFollowUpArea() {
  const area = document.getElementById('followUpArea');
  if (area) {
    area.classList.remove('hidden');
  }
}

function hideFollowUpArea() {
  const area = document.getElementById('followUpArea');
  if (area) {
    area.classList.add('hidden');
  }
}

function hasActiveConversation(): boolean {
  const conversationLog = document.getElementById('conversationLog');
  return accumulatedContent.length > 0 || (conversationLog !== null && conversationLog.children.length > 0);
}

async function handleFollowUpSend() {
  const input = document.getElementById('followUpInput') as HTMLTextAreaElement | null;
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.disabled = true;

  try {
    const win = await chrome.windows.getCurrent();
    const payload: any = {
      type: MessageType.SEND_FOLLOW_UP,
      text,
      windowId: win.id
    };
    const activeHistoryId = currentView === 'history-detail' ? currentHistoryId : currentOutputHistoryId;
    if (activeHistoryId !== null) {
      payload.historyId = activeHistoryId;
    }
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.success) {
      // Show error in current response
      if (currentView === 'history-detail') {
        showView('output');
      }
      const currentResponse = document.getElementById('currentResponse');
      if (currentResponse) {
        currentResponse.innerHTML = `
          <div class="error-message">
            <h3>❌ 无法发送追问</h3>
            <p>${escapeHtml(response?.error || '未知错误')}</p>
          </div>
        `;
      }
      hideFollowUpArea();
    }
  } catch (err) {
    console.error('[SidePanel] Follow-up send failed:', err);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function handleFollowUpKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleFollowUpSend();
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
    console.error('[SidePanel] Copy failed:', err);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '❌';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(content: string): string {
  if (!content) return '';
  try {
    return marked.parse(content, { async: false }) as string;
  } catch {
    return `<div class="streaming-text">${escapeHtml(content)}</div>`;
  }
}

// ============================================================================
// History Views
// ============================================================================

function openPromptModal(fullPrompt: string) {
  const modal = document.getElementById('promptModal');
  const textEl = document.getElementById('modalPromptText');
  if (!modal || !textEl) return;
  textEl.textContent = fullPrompt;
  modal.classList.remove('hidden');
}

function closePromptModal() {
  const modal = document.getElementById('promptModal');
  if (modal) modal.classList.add('hidden');
}

function showView(view: 'output' | 'history-list' | 'history-detail') {
  currentView = view;
  const output = document.getElementById('output');
  const historyListView = document.getElementById('historyListView');
  const historyDetailView = document.getElementById('historyDetailView');

  if (output) output.classList.toggle('hidden', view !== 'output');
  if (historyListView) historyListView.classList.toggle('hidden', view !== 'history-list');
  if (historyDetailView) historyDetailView.classList.toggle('hidden', view !== 'history-detail');

  // Update follow-up area visibility
  const followUpArea = document.getElementById('followUpArea');
  if (followUpArea) {
    let shouldShow = false;
    if (view === 'output') {
      shouldShow = !isStreaming && hasActiveConversation();
    } else if (view === 'history-detail') {
      shouldShow = !isStreaming && currentHistorySupportsFollowUp;
    }
    followUpArea.classList.toggle('hidden', !shouldShow);
  }
}

async function loadHistoryList(keyword?: string, favoritesOnly?: boolean) {
  const listEl = document.getElementById('historyList');
  const emptyEl = document.getElementById('historyEmpty');
  if (!listEl) return;

  listEl.innerHTML = '';
  if (emptyEl) emptyEl.classList.add('hidden');

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.GET_HISTORY_LIST,
      limit: 100,
      keyword,
      favoritesOnly
    });
    if (response?.success && response.data) {
      renderHistoryList(response.data);
    } else {
      if (emptyEl) emptyEl.classList.remove('hidden');
    }
  } catch (error) {
    console.error('[SidePanel] Failed to load history:', error);
    if (emptyEl) emptyEl.classList.remove('hidden');
  }
}

function renderHistoryList(items: any[]) {
  const listEl = document.getElementById('historyList');
  const emptyEl = document.getElementById('historyEmpty');
  if (!listEl) return;

  if (items.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  listEl.innerHTML = items.map(item => {
    const isFav = item.favorite ? true : false;
    return `
    <div class="history-item" data-id="${item.id}">
      <button class="history-item-favorite ${isFav ? 'is-favorite' : ''}" data-id="${item.id}" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '⭐' : '☆'}</button>
      <button class="history-item-delete" data-id="${item.id}" title="删除">🗑</button>
      <div class="history-item-title">${escapeHtml(item.title || '未命名')}</div>
      <div class="history-item-meta">
        <span class="history-item-url">${escapeHtml(item.url || '')}</span>
        <span>${formatDate(item.created_at)}</span>
      </div>
    </div>
  `;
  }).join('');

  listEl.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = Number((el as HTMLElement).dataset.id);
      showHistoryDetail(id);
    });
  });

  listEl.querySelectorAll('.history-item-favorite').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number((el as HTMLElement).dataset.id);
      toggleFavoriteItem(id);
    });
  });

  listEl.querySelectorAll('.history-item-delete').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number((el as HTMLElement).dataset.id);
      deleteHistoryItem(id);
    });
  });
}

async function showHistoryDetail(id: number) {
  currentHistoryId = id;
  const contentEl = document.getElementById('historyDetailContent');
  const metaEl = document.getElementById('historyMeta');
  if (!contentEl || !metaEl) return;

  contentEl.innerHTML = '<p style="color:#888;padding:20px;">加载中...</p>';
  showView('history-detail');

  try {
    const response = await chrome.runtime.sendMessage({ type: MessageType.GET_HISTORY_DETAIL, id });
    if (response?.success && response.data) {
      const item = response.data;
      currentHistorySupportsFollowUp = !!item.messages;
      // Show prompt in meta for all records that have one
      const hasPrompt = !!item.prompt;
      const promptDisplay = hasPrompt ? truncate(item.prompt, 200) : '';
      const promptFull = hasPrompt ? item.prompt : '';
      const showViewBtn = hasPrompt && item.prompt.length > 200;
      const isFav = item.favorite ? true : false;
      metaEl.innerHTML = `
        <div class="history-meta-title">${escapeHtml(item.title || '未命名')}</div>
        ${item.url ? `<a class="history-meta-url" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a>` : ''}
        ${promptDisplay ? `<div class="history-meta-prompt">${escapeHtml(promptDisplay)}</div>` : ''}
        ${showViewBtn ? `<button class="view-prompt-btn" id="viewPromptBtn">🔍 查看完整提示词</button>` : ''}
        <div class="history-meta-footer" style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <div class="history-meta-time">${formatDate(item.created_at)}</div>
          <button class="history-detail-favorite ${isFav ? 'is-favorite' : ''}" id="detailFavoriteBtn" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '⭐ 已收藏' : '☆ 收藏'}</button>
        </div>
      `;

      if (showViewBtn) {
        const viewBtn = document.getElementById('viewPromptBtn');
        if (viewBtn) {
          viewBtn.addEventListener('click', () => openPromptModal(promptFull));
        }
      }

      const detailFavBtn = document.getElementById('detailFavoriteBtn');
      if (detailFavBtn) {
        detailFavBtn.addEventListener('click', () => {
          toggleFavoriteItem(id);
        });
      }

      if (item.messages) {
        try {
          const messages = JSON.parse(item.messages) as Array<{role: string; content: string}>;
          let html = '<div class="conversation-thread">';
          const assistantContents: string[] = [];
          messages.forEach((msg, index) => {
            if (msg.role === 'user') {
              const userContent = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
              html += `<div class="turn user-turn" data-index="${index}" title="${escapeHtml(msg.content)}">
                <button class="msg-delete-btn" data-index="${index}" title="删除此消息">🗑</button>
                ${escapeHtml(userContent)}
              </div>`;
            } else if (msg.role === 'assistant') {
              assistantContents.push(msg.content);
              html += `<div class="turn" data-index="${index}">
                <div class="turn-toolbar">
                  <button class="msg-copy-btn" data-index="${index}" title="拷贝 Markdown">📋</button>
                  <button class="msg-delete-btn" data-index="${index}" title="删除此消息">🗑</button>
                  <button class="msg-retry-btn" data-index="${index}" title="重新生成">🔄</button>
                </div>
                <div class="markdown-content">${renderMarkdown(msg.content)}</div>
              </div>`;
            }
          });
          html += '</div>';
          contentEl.innerHTML = html;
          currentHistoryMarkdown = assistantContents.join('\n\n---\n\n');

          // Bind delete buttons
          contentEl.querySelectorAll('.msg-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const idx = Number((btn as HTMLElement).dataset.index);
              deleteHistoryMessage(id, messages, idx);
            });
          });

          // Bind retry buttons
          contentEl.querySelectorAll('.msg-retry-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const idx = Number((btn as HTMLElement).dataset.index);
              retryHistoryMessage(id, idx);
            });
          });

          // Bind copy buttons
          contentEl.querySelectorAll('.msg-copy-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const idx = Number((btn as HTMLElement).dataset.index);
              const msg = messages[idx];
              if (msg?.role === 'assistant') {
                copyMarkdownToClipboard(msg.content, btn as HTMLElement);
              }
            });
          });
        } catch {
          contentEl.innerHTML = `<div class="markdown-content">${renderMarkdown(item.response || '')}</div>`;
          currentHistoryMarkdown = item.response || '';
        }
      } else {
        contentEl.innerHTML = `<div class="markdown-content">${renderMarkdown(item.response || '')}</div>`;
        currentHistoryMarkdown = item.response || '';
      }
    } else {
      contentEl.innerHTML = '<p style="color:#c62828;padding:20px;">加载失败</p>';
    }
  } catch (error) {
    console.error('[SidePanel] Failed to load history detail:', error);
    contentEl.innerHTML = '<p style="color:#c62828;padding:20px;">加载失败</p>';
  }
}

async function deleteHistoryItem(id: number) {
  if (!window.confirm('确定删除这条历史记录？')) return;
  try {
    await chrome.runtime.sendMessage({ type: MessageType.DELETE_HISTORY, id });
    showView('history-list');
    await loadHistoryList(undefined, showFavoritesOnly || undefined);
  } catch (error) {
    console.error('[SidePanel] Failed to delete history:', error);
  }
}

async function toggleFavoriteItem(id: number) {
  try {
    const response = await chrome.runtime.sendMessage({ type: MessageType.TOGGLE_FAVORITE, id });
    if (response?.success) {
      if (currentView === 'history-detail' && currentHistoryId === id) {
        await showHistoryDetail(id);
      }
      const searchInput = document.getElementById('historySearch') as HTMLInputElement | null;
      await loadHistoryList(searchInput?.value.trim() || undefined, showFavoritesOnly || undefined);
    }
  } catch (error) {
    console.error('[SidePanel] Failed to toggle favorite:', error);
  }
}

async function deleteHistoryMessage(historyId: number, messages: Array<{role: string; content: string}>, index: number) {
  if (!window.confirm('确定删除这条消息？')) return;
  try {
    const updatedMessages = messages.filter((_, i) => i !== index);
    // Recompute response as the last assistant message content, or empty if none
    const assistantMessages = updatedMessages.filter(m => m.role === 'assistant');
    const newResponse = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : '';
    await chrome.runtime.sendMessage({
      type: MessageType.UPDATE_HISTORY,
      id: historyId,
      messages: JSON.stringify(updatedMessages),
      response: newResponse
    });
    await showHistoryDetail(historyId);
  } catch (error) {
    console.error('[SidePanel] Failed to delete history message:', error);
  }
}

async function retryHistoryMessage(historyId: number, messageIndex: number) {
  if (!window.confirm('确定重新生成这条回复？')) return;
  try {
    const win = await chrome.windows.getCurrent();
    const response = await chrome.runtime.sendMessage({
      type: MessageType.RETRY_MESSAGE,
      historyId,
      messageIndex,
      windowId: win.id
    });
    if (!response?.success) {
      console.error('[SidePanel] Retry failed:', response?.error);
    }
  } catch (error) {
    console.error('[SidePanel] Failed to retry history message:', error);
  }
}

async function clearAllHistory() {
  if (!window.confirm('确定清空所有历史记录？此操作不可恢复。')) return;
  try {
    await chrome.runtime.sendMessage({ type: MessageType.CLEAR_HISTORY });
    await loadHistoryList();
  } catch (error) {
    console.error('[SidePanel] Failed to clear history:', error);
  }
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Configure marked
marked.use({
  gfm: true,
  breaks: true,
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  init();
  const abortBtn = document.getElementById('abortBtn');
  if (abortBtn) {
    abortBtn.addEventListener('click', handleAbortClick);
  }

  // History buttons
  const historyBtn = document.getElementById('historyBtn');
  if (historyBtn) {
    historyBtn.addEventListener('click', () => {
      showView('history-list');
      loadHistoryList();
    });
  }

  const backToOutputBtn = document.getElementById('backToOutputBtn');
  if (backToOutputBtn) {
    backToOutputBtn.addEventListener('click', () => showView('output'));
  }

  const backToListBtn = document.getElementById('backToListBtn');
  if (backToListBtn) {
    backToListBtn.addEventListener('click', () => showView('history-list'));
  }

  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', clearAllHistory);
  }

  const deleteHistoryBtn = document.getElementById('deleteHistoryBtn');
  if (deleteHistoryBtn) {
    deleteHistoryBtn.addEventListener('click', () => {
      if (currentHistoryId !== null) {
        deleteHistoryItem(currentHistoryId);
      }
    });
  }

  // History search
  const historySearch = document.getElementById('historySearch') as HTMLInputElement | null;
  if (historySearch) {
    const debouncedSearch = debounce((value: string) => {
      loadHistoryList(value.trim() || undefined, showFavoritesOnly || undefined);
    }, 300);
    historySearch.addEventListener('input', () => {
      debouncedSearch(historySearch.value);
    });
  }

  const filterFavoritesBtn = document.getElementById('filterFavoritesBtn');
  if (filterFavoritesBtn) {
    filterFavoritesBtn.addEventListener('click', () => {
      showFavoritesOnly = !showFavoritesOnly;
      filterFavoritesBtn.classList.toggle('active', showFavoritesOnly);
      const searchInput = document.getElementById('historySearch') as HTMLInputElement | null;
      loadHistoryList(searchInput?.value.trim() || undefined, showFavoritesOnly || undefined);
    });
  }

  // Follow-up input
  const followUpSendBtn = document.getElementById('followUpSendBtn');
  const followUpInput = document.getElementById('followUpInput') as HTMLTextAreaElement | null;
  if (followUpSendBtn) {
    followUpSendBtn.addEventListener('click', handleFollowUpSend);
  }
  if (followUpInput) {
    followUpInput.addEventListener('keydown', handleFollowUpKeydown);
    // Auto-resize textarea
    followUpInput.addEventListener('input', () => {
      followUpInput.style.height = 'auto';
      followUpInput.style.height = followUpInput.scrollHeight + 'px';
    });
  }

  // Modal close handlers
  const modalOverlay = document.getElementById('promptModal');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closePromptModal();
    });
  }
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closePromptModal);
  }
});
