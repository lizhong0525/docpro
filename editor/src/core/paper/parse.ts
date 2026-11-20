/**
 * 论文结构解析（确定性、纯本地）。
 *
 * 把 Markdown 论文拆成「单元（块）→ 章节 → 段落」，供论文助手 UI 展示
 * 与逐段修订使用。规则刻意保守：宁可多拆一块，不可把两块内容粘到一起。
 *
 * 块划分：
 * - 代码围栏（``` / ~~~）内部永远是一个整体，标题/表格等规则不生效；
 * - 表格行（|…|）连续聚合为一个 table 块；
 * - 列表行（-、*、+ 开头或 1. 等编号）连续聚合为一个 list 块（遇到空行断开）；
 * - 引用行（>）连续聚合为一个 quote 块；
 * - 标题（#）单独成块；空行不产出可修订单元。
 */
import type { PaperImageRef, PaperSection, PaperSectionKind, PaperTableData, PaperUnit, PaperUnitKind } from './types';

/** 各章节语义的标题识别模式（顺序敏感：abstract 先于 body） */
const SECTION_PATTERNS: Array<{ kind: PaperSectionKind; re: RegExp }> = [
  { kind: 'abstract', re: /^(摘要|提要)|^(abstract)\b/i },
  { kind: 'keywords', re: /^(关键词|关键字)|^key\s*words?\b/i },
  { kind: 'intro', re: /^(引言|绪论|前言)|^(introduction)\b/i },
  { kind: 'conclusion', re: /^(结论|结语|总结)|^(conclusion|discussion)\b/i },
  { kind: 'references', re: /^(参考文献|文献)|^(references?|bibliography)\b/i },
  { kind: 'acknowledgment', re: /^(致谢|鸣谢)|^acknowledg/i },
  { kind: 'appendix', re: /^(附录|附件)|^(appendix|appendices)\b/i },
];

export function classifySectionTitle(title: string): PaperSectionKind {
  const normalized = title.replace(/^#+\s*/, '').replace(/^\d+(\.\d+)*[\s.、)]*/, '').trim();
  if (!normalized) return 'body';
  for (const { kind, re } of SECTION_PATTERNS) {
    if (re.test(normalized)) return kind;
  }
  return 'body';
}

const FENCE_RE = /^\s*(```+|~~~+)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*((\*{3,})|(-{3,})|(_{3,}))\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d{1,3}[.)、]\s+)/;
const QUOTE_RE = /^\s*>\s?/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const BLANK_RE = /^\s*$/;
const HTML_BLOCK_RE = /^\s*<(div|section|article|table|blockquote|p|h[1-6]|pre|figure)\b/i;

interface RawLine {
  text: string;
  from: number;
  to: number; // 含换行符
  lineNo: number;
}

function splitLines(doc: string): RawLine[] {
  const lines: RawLine[] = [];
  let pos = 0;
  let lineNo = 1;
  while (pos < doc.length) {
    let end = doc.indexOf('\n', pos);
    if (end < 0) end = doc.length;
    lines.push({ text: doc.slice(pos, end), from: pos, to: Math.min(end + 1, doc.length), lineNo });
    lineNo += 1;
    if (end >= doc.length) break;
    pos = end + 1;
  }
  return lines;
}

interface BuilderBlock {
  kind: PaperUnitKind;
  from: number;
  to: number;
  lineStart: number;
  lineEnd: number;
  headingLevel: number | null;
  headingText: string | null;
  raw: string;
}

function mergeBlock(current: BuilderBlock, line: RawLine, kind: PaperUnitKind): BuilderBlock {
  if (current.raw.length > 0) current.raw += '\n';
  current.raw += line.text;
  // to 不含行尾换行：保证 doc.slice(from, to) === raw，替换时保留换行结构
  current.to = line.from + line.text.length;
  current.lineEnd = line.lineNo;
  current.kind = kind;
  return current;
}

/** 将文档解析为单元（块）序列 */
export function parsePaperBlocks(doc: string): PaperUnit[] {
  const lines = splitLines(doc);
  const blocks: BuilderBlock[] = [];
  let current: BuilderBlock | null = null;
  let inFence: string | null = null;

  const closeCurrent = () => {
    if (current && current.raw.length > 0) {
      blocks.push(current);
      current = null;
    } else {
      current = null;
    }
  };

  for (const line of lines) {
    // 代码围栏内：全部归属 code 块
    if (inFence) {
      const fenceMatch = FENCE_RE.exec(line.text);
      if (fenceMatch && fenceMatch[1].length >= inFence.length) {
        current = current ?? startBlock(line, 'code');
        current = mergeBlock(current, line, 'code');
        closeCurrent();
        inFence = null;
        continue;
      }
      current = current ?? startBlock(line, 'code');
      current = mergeBlock(current, line, 'code');
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line.text);
    if (fenceMatch) {
      closeCurrent();
      inFence = fenceMatch[1];
      current = startBlock(line, 'code');
      continue;
    }

    const heading = HEADING_RE.exec(line.text);
    if (heading) {
      closeCurrent();
      current = startBlock(line, 'heading');
      current.headingLevel = heading[1].length;
      current.headingText = heading[2].trim();
      closeCurrent();
      continue;
    }

    if (BLANK_RE.test(line.text)) {
      closeCurrent();
      continue;
    }

    if (HR_RE.test(line.text)) {
      closeCurrent();
      current = startBlock(line, 'hr');
      closeCurrent();
      continue;
    }

    const plainKind: PaperUnitKind = TABLE_ROW_RE.test(line.text)
      ? 'table'
      : LIST_ITEM_RE.test(line.text)
        ? 'list'
        : QUOTE_RE.test(line.text)
          ? 'quote'
          : HTML_BLOCK_RE.test(line.text)
            ? 'html'
            : 'text';

    if (current && current.kind === plainKind && plainKind !== 'html') {
      current = mergeBlock(current, line, plainKind);
    } else {
      closeCurrent();
      current = startBlock(line, plainKind);
    }
  }
  closeCurrent();

  return blocks.map((block, index) => {
    const text = block.raw;
    return {
      id: `u${index}`,
      index,
      kind: block.kind,
      from: block.from,
      to: block.to,
      lineStart: block.lineStart,
      lineEnd: block.lineEnd,
      headingLevel: block.headingLevel,
      headingText: block.headingText,
      text,
      plainText: stripMarkdownInline(text),
      chars: text.length,
      words: countWords(stripMarkdownInline(text)),
      table: block.kind === 'table' ? parseTableData(text) : null,
    };
  });
}

/** 拆分管道表格行：`| a | b |` → ['a','b']（去除首尾空管道位，`\|` 视为单元格内转义管道） */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed;
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      current += '\\|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const TABLE_SEPARATOR_RE = /^\s*:?-{2,}:?\s*$/;

/** 解析 Markdown 管道表格（表头/数据行/列数/对齐），无法识别时返回 null */
export function parseTableData(text: string): PaperTableData | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|') && line.length > 2);
  if (lines.length < 1) return null;

  let header: string[] | null = null;
  let align: Array<'left' | 'center' | 'right' | null> | null = null;
  let bodyStart = 0;

  if (lines.length >= 2 && splitTableRow(lines[1]).every((cell) => TABLE_SEPARATOR_RE.test(cell))) {
    header = splitTableRow(lines[0]);
    align = splitTableRow(lines[1]).map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return null;
    });
    bodyStart = 2;
  } else if (lines.length === 1 && splitTableRow(lines[0]).every((cell) => TABLE_SEPARATOR_RE.test(cell))) {
    return null; // 只有分隔行
  }

  const rows = lines.slice(bodyStart).map((line) => splitTableRow(line));
  const columnCount = header ? header.length : rows[0]?.length ?? 0;
  if (columnCount === 0) return null;
  // 行内单元格数对齐（不足补空、多余截断）
  const normalizedRows = rows.map((row) => {
    const copy = row.slice(0, columnCount);
    while (copy.length < columnCount) copy.push('');
    return copy;
  });
  return {
    header: header ?? [],
    rows: normalizedRows,
    columnCount,
    rowCount: normalizedRows.length,
    hasHeader: header !== null,
    align: align ?? new Array<null>(columnCount).fill(null),
  };
}

/** 提取段落中的图片引用 `![alt](src)` */
export function extractImages(text: string): PaperImageRef[] {
  const images: PaperImageRef[] = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    images.push({ alt: match[1]?.trim() ?? '', src: match[2] ?? '' });
  }
  return images;
}

/** 编辑器内联渲染用的表格块（偏移 + 原文，to 不含行尾换行） */
export interface TableBlockRange {
  from: number;
  to: number;
  /** 块内原始文本（各行用 \n 连接，无行尾换行） */
  text: string;
  data: PaperTableData;
}

/**
 * 规范化表格 Markdown：统一列数、去单元格多余空白、转义裸管道、按列对齐重建分隔行。
 * 无表头的管道块会把首行提升为表头（使其成为合法 GFM 表格）。
 * 内容（包括行内 Markdown）保持原样；无法解析或无需修改时返回 null。
 */
export function normalizeTableText(text: string): string | null {
  const data = parseTableData(text);
  if (!data) return null;
  const cleanCell = (cell: string): string =>
    cell
      .replace(/\\\|/g, '|') // 先还原转义，避免重复转义
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\|/g, '\\|');
  const header = data.hasHeader ? data.header : data.rows[0] ?? [];
  const bodyRows = data.hasHeader ? data.rows : data.rows.slice(1);
  const lines: string[] = [];
  lines.push(`| ${header.map(cleanCell).join(' | ')} |`);
  const separator = data.align.map((align) => (align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---'));
  lines.push(`| ${separator.join(' | ')} |`);
  for (const row of bodyRows) lines.push(`| ${row.map(cleanCell).join(' | ')} |`);
  const normalized = lines.join('\n');
  if (normalized === text.trim()) return null;
  return normalized;
}

/**
 * 扫描文档中的所有「可渲染表格块」：
 * 连续 ≥3 行以 `|` 开头且结尾、且第二行是分隔行的管道表格。
 * 返回的偏移可直接用于 CodeMirror 的 replace decoration。
 */
export function findTableBlocks(docText: string): TableBlockRange[] {
  const blocks: TableBlockRange[] = [];
  const lines = docText.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const isTableLine = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
  };
  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    const blockLines: string[] = [];
    while (j < lines.length && isTableLine(lines[j])) {
      blockLines.push(lines[j].trim());
      j++;
    }
    const hasSeparator =
      blockLines.length >= 2 &&
      splitTableRow(blockLines[1]).every((cell) => TABLE_SEPARATOR_RE.test(cell));
    if (blockLines.length >= 3 && hasSeparator) {
      const lastLine = lines[j - 1];
      const from = lineStarts[i];
      const to = lineStarts[j - 1] + lastLine.length;
      const text = blockLines.join('\n');
      const data = parseTableData(text);
      if (data) blocks.push({ from, to, text, data });
    }
    i = j;
  }
  return blocks;
}

function startBlock(line: RawLine, kind: PaperUnitKind): BuilderBlock {
  return {
    kind,
    from: line.from,
    to: line.from + line.text.length,
    lineStart: line.lineNo,
    lineEnd: line.lineNo,
    headingLevel: null,
    headingText: null,
    raw: line.text,
  };
}

/** 去除行内 Markdown 标记，得到用于扫描与统计的纯文本（还原反斜杠转义） */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d{1,3}[.)、]\s+/, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** CJK 按字计数、拉丁词按词计数 */
export function countWords(plainText: string): number {
  const cjk = (plainText.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const latin = (
    plainText
      .replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9]+/g) ?? []
  ).length;
  return cjk + latin;
}

/** 组装章节：标题及其辖域 */
export function buildSections(units: PaperUnit[]): PaperSection[] {
  const sections: PaperSection[] = [];
  let current: PaperSection | null = null;
  for (const unit of units) {
    if (unit.kind === 'heading') {
      const title = unit.headingText ?? '';
      const section: PaperSection = {
        headingLevel: unit.headingLevel,
        title,
        kind: classifySectionTitle(title),
        from: unit.from,
        to: unit.to,
        unitIndexes: [unit.index],
      };
      if (current) current.to = unit.from;
      sections.push(section);
      current = section;
    } else if (current) {
      current.unitIndexes.push(unit.index);
    }
  }
  if (current && units.length > 0) current.to = units[units.length - 1].to;
  return sections;
}

/** 段落语义（决定能否逐段修订、提示词角色） */
export function classifyParagraphKind(
  unit: PaperUnit,
  section: PaperSection | null,
  isFirstContentUnit: boolean,
): 'title' | 'front' | 'abstract' | 'keywords' | 'body' | 'references' | 'acknowledgment' | 'appendix' | 'heading' {
  if (unit.kind === 'heading') return 'heading';
  if (!section) return isFirstContentUnit ? 'title' : 'front';
  switch (section.kind) {
    case 'abstract':
      return 'abstract';
    case 'keywords':
      return 'keywords';
    case 'references':
      return 'references';
    case 'acknowledgment':
      return 'acknowledgment';
    case 'appendix':
      return 'appendix';
    default:
      return 'body';
  }
}

const REVISABLE_KINDS: PaperUnitKind[] = ['text', 'list', 'quote', 'table'];

export function isUnitRevisable(unit: PaperUnit): boolean {
  return REVISABLE_KINDS.includes(unit.kind) && unit.plainText.trim().length > 0;
}

export function notRevisableReason(unit: PaperUnit, paragraphKind: string): string | null {
  if (unit.kind === 'code') return '代码块不适合逐段修订，请用普通选区编辑';
  if (unit.kind === 'html' || unit.kind === 'frontmatter') return '该块类型不支持逐段修订';
  if (unit.kind === 'hr') return '分隔线无需修订';
  if (unit.kind === 'heading') return '标题请直接编辑，或用整段修订保留级别';
  if (unit.plainText.trim().length === 0) return '空白块';
  if (paragraphKind === 'references') return '参考文献条目请用「参考文献」标签页统一管理';
  return null;
}

/** 标题的「显示名」：编号 + 文字 */
export function sectionDisplayTitle(section: PaperSection): string {
  return section.title ?? '（无标题章节）';
}
