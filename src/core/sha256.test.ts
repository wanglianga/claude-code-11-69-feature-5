import { describe, it, expect } from 'vitest';
import { sha256HexFallback, sha256Bytes } from './sha256';
import { sha256Hex, normalizeText } from './hash';

const VECTORS: [string, string][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

describe('纯 TS SHA-256 回退', () => {
  it('匹配 RFC 标准测试向量', () => {
    for (const [input, expected] of VECTORS) {
      expect(sha256HexFallback(input)).toBe(expected);
      expect(sha256Bytes(new TextEncoder().encode(input)).length).toBe(32);
    }
  });

  it('与 WebCrypto 结果一致（含中文长文本与多块填充）', async () => {
    const inputs = [
      '采购归档证据图工作台'.repeat(50),
      'x'.repeat(1000),
      normalizeText('当前位置：首页 > 详情\n\n【网站导航】首页　 \n项目编号：ZC2024-017\r\n'),
    ];
    for (const text of inputs) {
      expect(sha256HexFallback(text)).toBe(await sha256Hex(text));
    }
  });
});
