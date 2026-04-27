import { MessageType } from '../shared/types';
import type { ApiConfig, Prompt } from '../shared/types';

let currentTab = 'api';
let prompts: Prompt[] = [];
let editingPromptId: number | null = null;

// ============================================================================
// Initialization
// ============================================================================

function init() {
  setupTabs();
  setupApiForm();
  setupPromptModal();
  setupApiKeyToggle();
  setupTestApiButton();

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
        showSaveStatus('apiSaveStatus', '保存成功！');
      } else {
        showSaveStatus('apiSaveStatus', '保存失败: ' + response.error, true);
      }
    } catch (error: any) {
      showSaveStatus('apiSaveStatus', '保存失败: ' + error.message, true);
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
    toggleBtn.textContent = isPassword ? '隐藏' : '显示';
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

    if (!baseUrl || !apiKey || !model) {
      showTestStatus('请填写完整的 API 配置信息', 'error');
      return;
    }

    showTestStatus('正在测试连接...', 'testing');
    btn.setAttribute('disabled', 'true');

    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.TEST_API_CONNECTION,
        baseUrl,
        apiKey,
        model
      });

      if (response.success) {
        showTestStatus('连接成功！API 配置可用', 'success');
      } else {
        showTestStatus('连接失败：' + (response.error || '未知错误'), 'error');
      }
    } catch (error: any) {
      showTestStatus('测试失败：' + (error.message || '无法连接到后台服务'), 'error');
    } finally {
      btn.removeAttribute('disabled');
    }
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

function renderPrompts() {
  const container = document.getElementById('promptsList');
  if (!container) return;

  if (prompts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>暂无提示词，点击右上角按钮添加</p>
      </div>
    `;
    return;
  }

  container.innerHTML = prompts.map(p => `
    <div class="prompt-card" data-id="${p.id}">
      <div class="prompt-card-header">
        <span class="prompt-card-title">${escapeHtml(p.title)}</span>
        <div class="prompt-card-actions">
          <button class="btn btn-edit" data-id="${p.id}">编辑</button>
          <button class="btn btn-danger btn-delete" data-id="${p.id}">删除</button>
        </div>
      </div>
      <div class="prompt-card-content">${escapeHtml(p.prompt)}</div>
      <div class="prompt-card-meta">排序: ${p.sort_order}</div>
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
  (document.getElementById('modalTitle') as HTMLElement).textContent = '添加提示词';
}

function openAddPrompt() {
  editingPromptId = null;
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
  (document.getElementById('modalTitle') as HTMLElement).textContent = '编辑提示词';

  openModal();
}

async function savePrompt() {
  const title = (document.getElementById('promptTitle') as HTMLInputElement).value.trim();
  const prompt = (document.getElementById('promptContent') as HTMLTextAreaElement).value;
  const sortOrder = parseInt((document.getElementById('promptSort') as HTMLInputElement).value) || 0;

  if (!title || !prompt) {
    alert('请填写标题和提示词内容');
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
      alert('保存失败: ' + response.error);
    }
  } catch (error: any) {
    alert('保存失败: ' + error.message);
  }
}

async function deletePrompt(id: number) {
  if (!confirm('确定要删除这个提示词吗？')) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.DELETE_PROMPT,
      id
    });

    if (response.success) {
      await loadPrompts();
    } else {
      alert('删除失败: ' + response.error);
    }
  } catch (error: any) {
    alert('删除失败: ' + error.message);
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
