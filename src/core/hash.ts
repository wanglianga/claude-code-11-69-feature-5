/**
 * 内容指纹与确定性标识工具。
 * 优先使用 WebCrypto（安全上下文），不可用时回退到纯 TS SHA-256，
 * 保证局域网 HTTP 部署等非安全上下文下仍完全离线可用。
 */
import { sha256HexFallback } from './sha256';

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return sha256HexFallback(text);
}

/**
 * 规范化文本：统一换行、去除每行首尾空白与连续空白、
 * 去除站点噪声常见的全角空格，用于识别排版差异下的同件副本。
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/　/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 确定性 id（非加密场景），FNV-1a 32bit 双路混合，避免 Math.random 不可复算 */
export function deterministicId(prefix: string, parts: (string | number)[]): string {
  const basis = parts.join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < basis.length; i++) {
    const c = basis.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return `${prefix}_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** 数组指纹：用于裁决水位、依赖追踪的可复算哈希输入 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
