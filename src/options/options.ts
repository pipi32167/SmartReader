import { MessageType } from '../shared/types';
import type { ApiConfig, Prompt } from '../shared/types';
import { t, initPage, getCurrentLocale, setLocale } from '../shared/i18n';
import { isLocalApiBaseUrl } from '../shared/utils';

let currentTab = 'api';
let prompts: Prompt[] = [];
let editingPromptId: number | null = null;

// ============================================================================
// LLM Provider Presets
// ============================================================================

interface ProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
}

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022' },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-1.5-flash' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  moonshot: { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  glm: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4-flash' },
  qwen: { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  doubao: { name: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
  minimax: { name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama3-8b-8192' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
};

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  await initPage();
  setupTabs();
  setupApiForm();
  setupPromptModal();
  setupApiKeyToggle();
  setupTestApiButton();
  setupProviderSelect();
  setupLanguageSelect();

  loadApiConfig();
  loadPrompts();
}

// ============================================================================
// Tabs
// ============================================================================

function setupTabs() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = (item as HTMLElement).dataset.tab;
      if (!tab) return;
      switchTab(tab);
    });
  });
}

function switchTab(tab: string) {
  currentTab = tab;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', (item as HTMLElement).dataset.tab === tab);
  });

  // Update content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tab}`);
  });
}

// ============================================================================
// API Config
// ============================================================================

async function loadApiConfig() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MessageType.GET_API_CONFIG });
    if (response.success && response.data) {
      const config: ApiConfig = response.data;
      (document.getElementById('baseUrl') as HTMLInputElement).value = config.base_url || '';
      (document.getElementById('apiKey') as HTMLInputElement).value = config.api_key || '';
      (document.getElementById('model') as HTMLInputElement).value = config.model || '';
    }
  } catch (error) {
    console.error('[Options] Failed to load API config:', error);
  }
}

function setupApiForm() {
  const form = document.getElementById('apiForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const baseUrl = (document.getElementById('baseUrl') as HTMLInputElement).value.trim();
    const apiKey = (document.getElementById('apiKey') as HTMLInputElement).value.trim();
    const model = (document.getElementById('model') as HTMLInputElement).value.trim();

    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.SAVE_API_CONFIG,
        baseUrl,
        apiKey,
        model
      });

      if (response.success) {
        showSaveStatus('apiSaveStatus', t('options.status.saved'));
      } else {
        showSaveStatus('apiSaveStatus', t('options.status.saveFailed', { message: response.error }), true);
      }
    } catch (error: any) {
      showSaveStatus('apiSaveStatus', t('options.status.saveFailed', { message: error.message }), true);
    }
  });
}

function setupApiKeyToggle() {
  const toggleBtn = document.getElementById('toggleApiKey');
  const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
  if (!toggleBtn || !apiKeyInput) return;

  toggleBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleBtn.textContent = isPassword ? t('options.btn.hide') : t('options.btn.show');
  });
}

function showSaveStatus(elementId: string, message: string, isError = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#c62828' : '#4caf50';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function showTestStatus(message: string, status: 'testing' | 'success' | 'error') {
  const el = document.getElementById('apiTestStatus');
  if (!el) return;
  el.textContent = message;
  el.className = 'test-status show ' + status;
  if (status !== 'testing') {
    setTimeout(() => el.classList.remove('show'), 5000);
  }
}

function setupTestApiButton() {
  const btn = document.getElementById('testApiBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const baseUrl = (document.getElementById('baseUrl') as HTMLInputElement).value.trim();
    const apiKey = (document.getElementById('apiKey') as HTMLInputElement).value.trim();
    const model = (document.getElementById('model') as HTMLInputElement).value.trim();

    if (!baseUrl || !model || (!apiKey && !isLocalApiBaseUrl(baseUrl))) {
      showTestStatus(t('options.error.incompleteConfig'), 'error');
      return;
    }

    showTestStatus(t('options.status.testing'), 'testing');
    btn.setAttribute('disabled', 'true');

    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.TEST_API_CONNECTION,
        baseUrl,
        apiKey,
        model
      });

      if (response.success) {
        showTestStatus(t('options.status.testSuccess'), 'success');
      } else {
        showTestStatus(t('options.status.testError', { message: response.error || t('sidepanel.error.unknown') }), 'error');
      }
    } catch (error: any) {
      showTestStatus(t('options.status.testFailed', { message: error.message || t('options.error.network') }), 'error');
    } finally {
      btn.removeAttribute('disabled');
    }
  });
}

function setupProviderSelect() {
  const select = document.getElementById('providerSelect') as HTMLSelectElement;
  const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement;
  const modelInput = document.getElementById('model') as HTMLInputElement;
  if (!select || !baseUrlInput || !modelInput) return;

  select.addEventListener('change', () => {
    const key = select.value;
    if (!key || key === 'custom') return;

    const preset = PROVIDER_PRESETS[key];
    if (preset) {
      baseUrlInput.value = preset.baseUrl;
      modelInput.value = preset.model;
      // Visual feedback
      baseUrlInput.classList.add('auto-filled');
      modelInput.classList.add('auto-filled');
      setTimeout(() => {
        baseUrlInput.classList.remove('auto-filled');
        modelInput.classList.remove('auto-filled');
      }, 800);
    }
  });
}

function setupLanguageSelect() {
  const select = document.getElementById('languageSelect') as HTMLSelectElement;
  if (!select) return;

  // Set current value
  getCurrentLocale().then(locale => {
    select.value = locale;
  }).catch(() => {});

  select.addEventListener('change', async () => {
    const locale = select.value;
    await setLocale(locale);
    // Reload page to apply new language
    window.location.reload();
  });
}

// ============================================================================
// Prompts
// ============================================================================

async function loadPrompts() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MessageType.GET_PROMPTS });
    if (response.success) {
      prompts = response.data || [];
      renderPrompts();
    }
  } catch (error) {
    console.error('[Options] Failed to load prompts:', error);
  }
}

let draggedPromptId: number | null = null;

function renderPrompts() {
  const container = document.getElementById('promptsList');
  if (!container) return;

  if (prompts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>${t('options.empty.noPrompts')}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = prompts.map(p => `
    <div class="prompt-card" data-id="${p.id}" draggable="true">
      <div class="prompt-card-header">
        <span class="drag-handle" title="${t('options.btn.dragSort')}">⋮⋮</span>
        <span class="prompt-card-title">${escapeHtml(p.title)}</span>
        <div class="prompt-card-actions">
          <button class="btn btn-edit" data-id="${p.id}">${t('options.btn.edit')}</button>
          <button class="btn btn-danger btn-delete" data-id="${p.id}">${t('options.btn.delete')}</button>
        </div>
      </div>
      <div class="prompt-card-content">${escapeHtml(p.prompt)}</div>
    </div>
  `).join('');

  // Bind edit buttons
  container.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = Number((e.target as HTMLElement).dataset.id);
      openEditPrompt(id);
    });
  });

  // Bind delete buttons
  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = Number((e.target as HTMLElement).dataset.id);
      deletePrompt(id);
    });
  });

  // Bind drag events on cards
  container.querySelectorAll('.prompt-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedPromptId = Number((card as HTMLElement).dataset.id);
      card.classList.add('dragging');
      const dt = (e as DragEvent).dataTransfer;
      if (dt) {
        dt.effectAllowed = 'move';
        dt.setData('text/plain', String(draggedPromptId));
      }
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedPromptId = null;
      document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
    });
  });

  // Bind container-level dragover/drop once
  if (!container.hasAttribute('data-drag-bound')) {
    container.setAttribute('data-drag-bound', 'true');

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      const afterElement = getDragAfterElement(container, e.clientY);
      const indicator = getDropIndicator();
      if (afterElement == null) {
        container.appendChild(indicator);
      } else {
        container.insertBefore(indicator, afterElement);
      }
    });

    container.addEventListener('drop', async (e) => {
      e.preventDefault();
      document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
      if (draggedPromptId == null) return;

      const afterElement = getDragAfterElement(container, e.clientY);
      const cardElements = Array.from(container.querySelectorAll('.prompt-card'));
      const fromIndex = prompts.findIndex(p => p.id === draggedPromptId);
      if (fromIndex === -1) return;

      let toIndex: number;
      if (afterElement == null) {
        toIndex = prompts.length - 1;
      } else {
        toIndex = cardElements.indexOf(afterElement);
        if (toIndex > fromIndex) toIndex -= 1;
      }

      if (fromIndex === toIndex) return;

      const [moved] = prompts.splice(fromIndex, 1);
      prompts.splice(toIndex, 0, moved);

      const orders = prompts.map((p, i) => ({ id: p.id, sort_order: i }));
      renderPrompts();

      try {
        const response = await chrome.runtime.sendMessage({
          type: MessageType.REORDER_PROMPTS,
          orders
        });
        if (!response?.success) {
          console.error('[Options] Reorder failed:', response?.error);
          await loadPrompts();
        }
      } catch (err) {
        console.error('[Options] Failed to reorder prompts:', err);
        await loadPrompts();
      }
    });
  }
}

function getDragAfterElement(container: HTMLElement, y: number): Element | null {
  const draggableElements = [...container.querySelectorAll('.prompt-card:not(.dragging)')];
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null as Element | null }).element;
}

function getDropIndicator(): HTMLElement {
  let indicator = document.querySelector('.drop-indicator') as HTMLElement;
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
  }
  return indicator;
}

// ============================================================================
// Prompt Modal
// ============================================================================

function setupPromptModal() {
  const addBtn = document.getElementById('addPromptBtn');
  const closeBtn = document.getElementById('closeModal');
  const cancelBtn = document.getElementById('cancelPrompt');
  const overlay = document.querySelector('.modal-overlay');
  const form = document.getElementById('promptForm');

  addBtn?.addEventListener('click', () => openAddPrompt());
  closeBtn?.addEventListener('click', () => closeModal());
  cancelBtn?.addEventListener('click', () => closeModal());
  overlay?.addEventListener('click', () => closeModal());

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await savePrompt();
  });
}

function openModal() {
  const modal = document.getElementById('promptModal');
  if (modal) modal.classList.remove('hidden');
}

function closeModal() {
  const modal = document.getElementById('promptModal');
  if (modal) modal.classList.add('hidden');
  editingPromptId = null;

  // Reset form
  (document.getElementById('promptId') as HTMLInputElement).value = '';
  (document.getElementById('promptTitle') as HTMLInputElement).value = '';
  (document.getElementById('promptContent') as HTMLTextAreaElement).value = '';
  (document.getElementById('promptSort') as HTMLInputElement).value = '0';
  (document.getElementById('modalTitle') as HTMLElement).textContent = t('options.modal.addPrompt');
}

function openAddPrompt() {
  editingPromptId = null;
  const maxSort = prompts.length > 0 ? Math.max(...prompts.map(p => p.sort_order)) : -1;
  (document.getElementById('promptSort') as HTMLInputElement).value = String(maxSort + 1);
  (document.getElementById('modalTitle') as HTMLElement).textContent = t('options.modal.addPrompt');
  openModal();
}

function openEditPrompt(id: number) {
  const prompt = prompts.find(p => p.id === id);
  if (!prompt) return;

  editingPromptId = id;
  (document.getElementById('promptId') as HTMLInputElement).value = String(id);
  (document.getElementById('promptTitle') as HTMLInputElement).value = prompt.title;
  (document.getElementById('promptContent') as HTMLTextAreaElement).value = prompt.prompt;
  (document.getElementById('promptSort') as HTMLInputElement).value = String(prompt.sort_order);
  (document.getElementById('modalTitle') as HTMLElement).textContent = t('options.modal.editPrompt');

  openModal();
}

async function savePrompt() {
  const title = (document.getElementById('promptTitle') as HTMLInputElement).value.trim();
  const prompt = (document.getElementById('promptContent') as HTMLTextAreaElement).value;
  const sortOrder = parseInt((document.getElementById('promptSort') as HTMLInputElement).value) || 0;

  if (!title || !prompt) {
    alert(t('options.error.emptyPrompt'));
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.SAVE_PROMPT,
      id: editingPromptId || undefined,
      title,
      prompt,
      sort_order: sortOrder
    });

    if (response.success) {
      closeModal();
      await loadPrompts();
    } else {
      alert(t('options.status.saveFailed', { message: response.error }));
    }
  } catch (error: any) {
    alert(t('options.status.saveFailed', { message: error.message }));
  }
}

async function deletePrompt(id: number) {
  if (!confirm(t('options.confirm.deletePrompt'))) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.DELETE_PROMPT,
      id
    });

    if (response.success) {
      await loadPrompts();
    } else {
      alert(t('options.error.deleteFailed', { message: response.error }));
    }
  } catch (error: any) {
    alert(t('options.error.deleteFailed', { message: error.message }));
  }
}

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize
document.addEventListener('DOMContentLoaded', init);
