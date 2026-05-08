import initSqlJs from 'sql.js';
import * as pdfjsLib from 'pdfjs-dist';
// Tesseract.js is loaded dynamically to avoid bloating the initial chunk.
// It is only needed when a PDF page has sparse text and requires OCR.
import { MessageType } from '../shared/types';
import { DB_FILENAME } from '../shared/constants';
import { htmlToMarkdown } from '../shared/html-to-markdown';
import { buildPdfHtml } from '../shared/pdf-to-html';

// pdfjs-dist v5: set worker source so page.render() can create a Web Worker.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

let db: any = null;
let SQL: any = null;
let fileHandle: FileSystemFileHandle | null = null;

function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || 'Unknown error', name: error.name, stack: error.stack };
  }
  if (typeof error === 'string') {
    return { message: error || 'Unknown error' };
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error (null/undefined thrown)' };
  }
  try {
    const serialized = JSON.stringify(error);
    return { message: serialized || 'Unknown error' };
  } catch {
    return { message: 'Unknown error (unserializable object)' };
  }
}

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

    // Migrate history table if needed
    console.log('[Offscreen] Checking history table migration...');
    await migrateHistoryTable();
    console.log('[Offscreen] History migration check complete');

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

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT,
      prompt TEXT,
      response TEXT NOT NULL,
      messages TEXT,
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

async function migrateHistoryTable(): Promise<void> {
  if (!db) return;
  try {
    const result = db.exec('PRAGMA table_info(history)');
    if (!result || result.length === 0) return;
    const columns = result[0].values.map((row: any[]) => row[1] as string);
    if (!columns.includes('messages')) {
      db.run('ALTER TABLE history ADD COLUMN messages TEXT');
      console.log('[Offscreen] Added messages column to history');
    }
    if (!columns.includes('updated_at')) {
      db.run('ALTER TABLE history ADD COLUMN updated_at INTEGER');
      console.log('[Offscreen] Added updated_at column to history');
    }
    await persistDatabase();
  } catch (error: any) {
    console.error('[Offscreen] History migration failed:', error);
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
  MessageType.CONVERT_PDF_TO_MARKDOWN,
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
          } catch (error: unknown) {
            const errInfo = normalizeError(error);
            console.error('[Offscreen] PDF text extraction failed:', `[${errInfo.name}]`, errInfo.message, errInfo.stack);
            sendResponse({ success: false, error: `PDF 文本提取失败: ${errInfo.message}` });
          }
          break;
        }

        case MessageType.CONVERT_PDF_TO_MARKDOWN: {
          const base64 = message.base64 as string;
          try {
            console.log('[Offscreen] Starting PDF to Markdown conversion...');
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
            console.log('[Offscreen] PDF loaded, pages:', pdf.numPages);

            let tesseractModule: typeof import('tesseract.js') | null = null;
            let worker: Awaited<ReturnType<typeof import('tesseract.js').createWorker>> | null = null;
            const pages: Array<{ pageNum: number; text: string }> = [];
            const maxPages = Math.min(pdf.numPages, 50);
            let ocrAttempted = false;
            let ocrSucceeded = 0;

            for (let i = 1; i <= maxPages; i++) {
              const page = await pdf.getPage(i);
              const textContent = await page.getTextContent();
              let pageText = textContent.items
                .map((item: any) => item.str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();

              // If page has very little text, treat as scanned and run OCR
              if (pageText.length < 50) {
                console.log(`[Offscreen] Page ${i} text sparse (${pageText.length} chars), attempting OCR...`);
                ocrAttempted = true;
                try {
                  if (!tesseractModule) {
                    tesseractModule = await import('tesseract.js');
                  }
                  if (!worker) {
                    worker = await tesseractModule.createWorker('chi_sim+eng');
                    console.log('[Offscreen] Tesseract worker created');
                  }
                  const viewport = page.getViewport({ scale: 1.5 });
                  const canvas = document.createElement('canvas');
                  canvas.width = viewport.width;
                  canvas.height = viewport.height;
                  const ctx = canvas.getContext('2d');
                  if (!ctx) {
                    console.warn(`[Offscreen] Page ${i}: Failed to get 2D canvas context, skipping OCR`);
                  } else {
                    await page.render({ canvasContext: ctx, viewport }).promise;
                    const result = await worker.recognize(canvas);
                    const ocrText = result.data.text.trim();
                    if (ocrText.length > pageText.length) {
                      pageText = ocrText;
                    }
                    ocrSucceeded++;
                  }
                } catch (ocrErr: unknown) {
                  const errInfo = normalizeError(ocrErr);
                  console.warn(`[Offscreen] Page ${i}: OCR failed, using sparse text. Error [${errInfo.name}]:`, errInfo.message);
                }
              }

              if (pageText) {
                pages.push({ pageNum: i, text: pageText });
              }
            }

            if (worker) {
              try {
                await worker.terminate();
                console.log('[Offscreen] Tesseract worker terminated');
              } catch (termErr: unknown) {
                const errInfo = normalizeError(termErr);
                console.warn('[Offscreen] Tesseract worker terminate failed:', errInfo.message);
              }
            }
            console.log('[Offscreen] Pages with content:', pages.length, '(OCR attempted:', ocrAttempted, ', succeeded:', ocrSucceeded, ')');

            // Build HTML and convert to Markdown
            const html = buildPdfHtml(pages);
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const markdown = htmlToMarkdown(doc.body);
            console.log('[Offscreen] Markdown generated, length:', markdown.length);

            sendResponse({ success: true, markdown });
          } catch (error: unknown) {
            const errInfo = normalizeError(error);
            console.error('[Offscreen] PDF to Markdown conversion failed:', `[${errInfo.name}]`, errInfo.message, errInfo.stack);
            sendResponse({ success: false, error: `PDF 转换为 Markdown 失败: ${errInfo.message}` });
          }
          break;
        }
      }
    } catch (error: unknown) {
      const errInfo = normalizeError(error);
      console.error('[Offscreen] Error handling message:', `[${errInfo.name}]`, errInfo.message, errInfo.stack);
      sendResponse({ success: false, error: `Offscreen error: ${errInfo.message}` });
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
