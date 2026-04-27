import initSqlJs from 'sql.js';
import * as pdfjsLib from 'pdfjs-dist';
import { MessageType } from '../shared/types';
import { DB_FILENAME } from '../shared/constants';

// pdfjs-dist tries to spawn a Web Worker by default. Disable it and parse on the main thread.
pdfjsLib.GlobalWorkerOptions.disableWorker = true;

let db: any = null;
let SQL: any = null;
let fileHandle: FileSystemFileHandle | null = null;

async function initDatabase(): Promise<void> {
  try {
    // Load sql.js with WASM
    console.log('[Offscreen] Starting sql.js initialization...');
    const wasmUrl = chrome.runtime.getURL('sql-wasm.wasm');
    console.log('[Offscreen] WASM URL:', wasmUrl);

    try {
      SQL = await initSqlJs({ locateFile: () => wasmUrl });
      console.log('[Offscreen] sql.js loaded successfully');
    } catch (wasmError: any) {
      console.error('[Offscreen] sql.js WASM load failed:', wasmError);
      // Signal ready anyway so service worker doesn't hang forever
      chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY });
      return;
    }

    // Get OPFS root
    console.log('[Offscreen] Opening OPFS...');
    const opfsRoot = await navigator.storage.getDirectory();
    fileHandle = await opfsRoot.getFileHandle(DB_FILENAME, { create: true });
    console.log('[Offscreen] OPFS file handle acquired');

    // Try to load existing database
    try {
      const file = await fileHandle.getFile();
      console.log('[Offscreen] Existing DB file size:', file.size);
      if (file.size > 0) {
        const buffer = await file.arrayBuffer();
        db = new SQL.Database(new Uint8Array(buffer));
        console.log('[Offscreen] Loaded existing database from OPFS');
      } else {
        db = new SQL.Database();
        console.log('[Offscreen] Created new database (file was empty)');
      }
    } catch (readError: any) {
      console.log('[Offscreen] Could not read existing DB, creating new:', readError.message);
      db = new SQL.Database();
    }

    // Initialize schema
    console.log('[Offscreen] Initializing schema...');
    initializeSchema();
    console.log('[Offscreen] Schema initialized');

    // Insert default data if needed
    console.log('[Offscreen] Checking default data...');
    await ensureDefaults();
    console.log('[Offscreen] Default data check complete');

    // Signal ready
    console.log('[Offscreen] Sending OFFSCREEN_READY');
    chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY });
    console.log('[Offscreen] Database initialized and ready');
  } catch (error: any) {
    console.error('[Offscreen] Failed to initialize database:', error);
    // Still signal ready so service worker doesn't hang
    chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY });
  }
}

function initializeSchema(): void {
  if (!db) return;

  db.run(`
    CREATE TABLE IF NOT EXISTS api_config (
      id INTEGER PRIMARY KEY,
      base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
}

async function ensureDefaults(): Promise<void> {
  if (!db) return;

  // Check if api_config exists
  const configResult = db.exec('SELECT COUNT(*) as count FROM api_config');
  const configCount = configResult[0]?.values[0][0] || 0;

  if (configCount === 0) {
    db.run(
      'INSERT INTO api_config (id, base_url, api_key, model, updated_at) VALUES (?, ?, ?, ?, ?)',
      [1, 'https://api.openai.com/v1', '', 'gpt-4o-mini', Date.now()]
    );
    await persistDatabase();
  }

  // Check if prompts exist
  const promptResult = db.exec('SELECT COUNT(*) as count FROM prompts');
  const promptCount = promptResult[0]?.values[0][0] || 0;

  if (promptCount === 0) {
    db.run(
      'INSERT INTO prompts (title, prompt, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['总结页面', '请总结以下网页内容：\n\n${html}', 0, Date.now(), Date.now()]
    );
    db.run(
      'INSERT INTO prompts (title, prompt, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['解释选中内容', '请解释以下内容：\n\n${text}', 1, Date.now(), Date.now()]
    );
    await persistDatabase();
  }
}

async function persistDatabase(): Promise<void> {
  if (!db || !fileHandle) return;

  try {
    const data = db.export();
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (error) {
    console.error('[Offscreen] Failed to persist database:', error);
  }
}

// Offscreen document only handles DB-related messages.
// All other messages are silently ignored so the Service Worker can handle them.
const OFFSCREEN_MESSAGE_TYPES = new Set([
  MessageType.PING_OFFSCREEN,
  MessageType.DB_QUERY,
  MessageType.DB_EXEC,
  MessageType.EXTRACT_PDF_TEXT,
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages not meant for offscreen document
  if (!OFFSCREEN_MESSAGE_TYPES.has(message.type)) {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case MessageType.PING_OFFSCREEN:
          sendResponse({ success: true, pong: true });
          break;

        case MessageType.DB_QUERY:
          if (!db) {
            sendResponse({ success: false, error: 'Database not initialized' });
            return;
          }
          {
            const sql = message.sql as string;
            const params = (message.params as unknown[]) || [];
            const result = db.exec(sql, params);
            sendResponse({ success: true, data: result });
          }
          break;

        case MessageType.DB_EXEC:
          if (!db) {
            sendResponse({ success: false, error: 'Database not initialized' });
            return;
          }
          {
            const sql = message.sql as string;
            const params = (message.params as unknown[]) || [];
            db.run(sql, params);
            await persistDatabase();
            sendResponse({ success: true });
          }
          break;

        case MessageType.EXTRACT_PDF_TEXT: {
          const base64 = message.base64 as string;
          try {
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
            const parts: string[] = [];
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const content = await page.getTextContent();
              const pageText = content.items
                .map((item: any) => item.str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
              if (pageText) parts.push(pageText);
            }
            sendResponse({ success: true, text: parts.join('\n\n') });
          } catch (error: any) {
            console.error('[Offscreen] PDF text extraction failed:', error);
            sendResponse({ success: false, error: error.message || 'PDF 文本提取失败' });
          }
          break;
        }
      }
    } catch (error: any) {
      console.error('[Offscreen] Error handling message:', error);
      sendResponse({ success: false, error: error.message || 'Unknown error' });
    }
  })();
  return true; // Keep channel open for async
});

// Signal that the module has started executing (before any async init)
console.log('[Offscreen] offscreen.ts module executing');
try {
  chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_HTML_LOADED });
} catch (e) {
  // ignore
}
initDatabase();
