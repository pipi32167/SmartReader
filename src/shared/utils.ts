/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n... (content truncated)';
}

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Format timestamp to locale string
 */
export function formatDate(timestamp: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

/**
 * Whether a base URL points at a loopback host (localhost / 127.0.0.1 / ::1).
 * Local endpoints such as Ollama do not require an API key.
 */
export function isLocalApiBaseUrl(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

/**
 * An API config is usable when it has a base URL + model and either an API key
 * or a local (loopback) endpoint that does not need one.
 */
export function isApiConfigUsable(config: { base_url?: string; model?: string; api_key?: string }): boolean {
  if (!config.base_url || !config.model) return false;
  if (config.api_key) return true;
  return isLocalApiBaseUrl(config.base_url);
}

/**
 * Convert ArrayBuffer to Base64 string without stack overflow.
 * Avoids spread operator on large arrays (> ~500k items).
 */
export function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
