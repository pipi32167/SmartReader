// Default API configuration
export const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

// Default prompts
export const DEFAULT_PROMPTS = [
  {
    title: '总结页面',
    prompt: '请总结以下网页内容：\n\n${html}',
    sort_order: 0,
  },
  {
    title: '解释选中内容',
    prompt: '请解释以下内容：\n\n${text}',
    sort_order: 1,
  },
];

// OPFS file name for SQLite database
export const DB_FILENAME = 'smartreader.db';

// Maximum content length to send to AI (approximate characters)
export const MAX_CONTENT_LENGTH = 30000;
