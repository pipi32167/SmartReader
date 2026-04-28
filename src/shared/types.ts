// API Configuration
export interface ApiConfig {
  id: number;
  base_url: string;
  api_key: string;
  model: string;
  updated_at: number;
}

// Prompt
export interface Prompt {
  id: number;
  title: string;
  prompt: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

// Page content extracted by content script
export interface PageContent {
  title: string;
  url: string;
  html: string;
  text: string;
}

// Conversation message
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// History record
export interface HistoryItem {
  id: number;
  title: string;
  url: string;
  prompt: string;
  response: string;
  messages?: string;
  created_at: number;
  updated_at?: number;
}

// Message types for communication between components
export const MessageType = {
  // Content script
  GET_PAGE_CONTENT: 'GET_PAGE_CONTENT',

  // Offscreen document
  PING_OFFSCREEN: 'PING_OFFSCREEN',
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  OFFSCREEN_HTML_LOADED: 'OFFSCREEN_HTML_LOADED',
  DB_INIT: 'DB_INIT',
  DB_QUERY: 'DB_QUERY',
  DB_EXEC: 'DB_EXEC',

  // Popup / Options → Service Worker
  EXECUTE_PROMPT: 'EXECUTE_PROMPT',
  SHOW_PAGE_MARKDOWN: 'SHOW_PAGE_MARKDOWN',
  GET_PROMPTS: 'GET_PROMPTS',
  SAVE_PROMPT: 'SAVE_PROMPT',
  DELETE_PROMPT: 'DELETE_PROMPT',
  GET_API_CONFIG: 'GET_API_CONFIG',
  SAVE_API_CONFIG: 'SAVE_API_CONFIG',
  TEST_API_CONNECTION: 'TEST_API_CONNECTION',
  EXTRACT_PDF_TEXT: 'EXTRACT_PDF_TEXT',

  // History operations
  GET_HISTORY_LIST: 'GET_HISTORY_LIST',
  GET_HISTORY_DETAIL: 'GET_HISTORY_DETAIL',
  DELETE_HISTORY: 'DELETE_HISTORY',
  CLEAR_HISTORY: 'CLEAR_HISTORY',

  // Side Panel → Service Worker
  ABORT_STREAM: 'ABORT_STREAM',
  SEND_FOLLOW_UP: 'SEND_FOLLOW_UP',

  // Service Worker → Side Panel
  STREAM_START: 'STREAM_START',
  STREAM_CHUNK: 'STREAM_CHUNK',
  STREAM_COMPLETE: 'STREAM_COMPLETE',
  STREAM_ERROR: 'STREAM_ERROR',
  STREAM_ABORTED: 'STREAM_ABORTED',

  // Popup → Side Panel
  SHOW_HISTORY_VIEW: 'SHOW_HISTORY_VIEW',
} as const;

export type MessageTypeValue = typeof MessageType[keyof typeof MessageType];

// Generic message shape
export interface ExtensionMessage {
  type: MessageTypeValue;
  [key: string]: unknown;
}
