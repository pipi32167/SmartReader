import { describe, it, expect } from 'vitest';
import { arrayBufferToBase64 } from './utils';

describe('arrayBufferToBase64', () => {
  it('正确处理 1MB 的 ArrayBuffer 而不栈溢出', () => {
    const size = 1024 * 1024; // 1MB
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      view[i] = i % 256;
    }
    const base64 = arrayBufferToBase64(buffer);
    expect(base64.length).toBeGreaterThan(0);
    expect(typeof base64).toBe('string');
  });

  it('空 ArrayBuffer 返回空 base64', () => {
    const base64 = arrayBufferToBase64(new ArrayBuffer(0));
    expect(base64).toBe('');
  });

  it('小数据编码结果正确', () => {
    // "Hello" → SGVsbG8=
    const buffer = new TextEncoder().encode('Hello').buffer;
    expect(arrayBufferToBase64(buffer)).toBe('SGVsbG8=');
  });
});
