/**
 * 结构解析器：把离线归档文本切分为
 *  - announcement 公告正文
 *  - attachment   附件摘要
 *  - noise        站点噪声（导航栏、页脚、版权、广告、面包屑等）
 *
 * 纯函数、无副作用，版本号随规则演进，写入快照后冻结。
 */
import type { StructuredDocument, StructuredSection, TextSpan, SectionKind } from './types';

export const PARSER_VERSION = 'parser-1.0.0';

const NOISE_PATTERNS: RegExp[] = [
  /^【?网站导航】?/,
  /^当前位置[:：]/, // 面包屑
  /^首页[＞>]/,
  /^版权所有/i,
  /^Copyright\b/i,
  /^主办单位[:：].*网站/,
  /^技术支持[:：]/,
  /^ICP备\s*\d+/,
  /^公安备案号/,
  /^扫[一码]扫/,
  /^关注(微信|公众号)/,
  /^友情链接[:：]/,
  /^\[广告\]/,
  /^广告位/,
  /^点击下载(浏览器|APP)/,
  /^温馨提示[:：].*(浏览器|APP)/,
  /^—+\s*页脚\s*—+$/,
  /^—+\s*页眉\s*—+$/,
  /^打印时间[:：]/,
  /^第\s*\d+\s*页\s*共\s*\d+\s*页/,
];

const ATTACHMENT_BEGIN = /^(附件|附录)\s*[0-9一二三四五六七八九十]*[：:.\s]/;
const ATTACHMENT_END = /^(附件结束|附录结束|正文结束|公告正文)/;

function makeSpan(start: number, end: number, text: string): TextSpan {
  return { start, end, text };
}

function matchNoise(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  return NOISE_PATTERNS.some((re) => re.test(t));
}

/**
 * 解析入口。输入原始文本，输出带字符偏移的段落结构。
 * sourceKind 由文件名/导入通道推断。
 */
export function parseDocument(rawText: string, sourceKind: StructuredDocument['sourceKind']): StructuredDocument {
  const sections: StructuredSection[] = [];
  const noiseSpans: TextSpan[] = [];
  const bodyParts: string[] = [];

  // 以换行切分并保留偏移
  const lines: { text: string; start: number; end: number }[] = [];
  let cursor = 0;
  const rawLines = rawText.split('\n');
  rawLines.forEach((line, idx) => {
    const start = cursor;
    const end = start + line.length;
    lines.push({ text: line, start, end });
    cursor = end + (idx < rawLines.length - 1 ? 1 : 0);
  });

  let current: { kind: SectionKind; heading: string; start: number; textParts: string[] } | null = null;
  let inAttachment = false;

  const flush = (endPos: number) => {
    if (!current) return;
    const text = current.textParts.join('\n');
    sections.push({
      kind: current.kind,
      heading: current.heading,
      span: makeSpan(current.start, endPos, text),
    });
    if (current.kind !== 'noise') bodyParts.push(text);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.text.trim();

    if (matchNoise(line.text)) {
      flush(line.start);
      noiseSpans.push(makeSpan(line.start, line.end, line.text));
      continue;
    }

    if (ATTACHMENT_BEGIN.test(trimmed)) {
      flush(line.start);
      inAttachment = true;
      current = { kind: 'attachment', heading: trimmed, start: line.start, textParts: [line.text] };
      continue;
    }
    if (inAttachment && ATTACHMENT_END.test(trimmed)) {
      flush(line.end);
      inAttachment = false;
      continue;
    }

    const kind: SectionKind = inAttachment ? 'attachment' : 'announcement';
    if (!current || current.kind !== kind) {
      flush(line.start);
      current = {
        kind,
        heading: inAttachment ? '附件摘要' : '公告正文',
        start: line.start,
        textParts: [line.text],
      };
    } else {
      current.textParts.push(line.text);
    }
  }
  flush(rawText.length);

  return {
    parserVersion: PARSER_VERSION,
    bodyText: bodyParts.join('\n'),
    sections,
    noiseSpans,
    sourceKind,
  };
}

export function inferSourceKind(fileName: string): StructuredDocument['sourceKind'] {
  const name = fileName.toLowerCase();
  if (name.includes('附件') || /attach|appendix/.test(name)) return 'attachment';
  if (name.includes('打印') || name.includes('print')) return 'print';
  if (name.includes('复制') || name.includes('copy') || name.endsWith('.txt')) return 'copytext';
  return 'webpage';
}
