/**
 * 参考文献解析与完整性检查（确定性、纯本地）。
 *
 * 能力：
 * - 从参考文献章节中切分条目，支持 [1] / 1. / （1） 三种编号样式与多行条目；
 * - 从正文提取编号引用 [1]、[1,3-5]、[1，2] 与作者-年份引用 (Smith et al., 2020)；
 * - 交叉检查：未引用的条目、引用了但不存在的序号、疑似重复条目；
 * - 启发式字段抽取（作者/年份/类型标记/DOI）与格式问题提示（缺年份、缺页码等）。
 *
 * 刻意保守：只报告「确定」或「疑似」，绝不声称某条文献是编造的（模型无法核实
 * 事实，需要联网检索——这超出确定性检查的边界，UI 中只提示用户自行核实）。
 */
import type {
  AuthorYearCitation,
  CitationMatch,
  PaperUnit,
  ReferenceEntry,
  ReferenceFormatSettings,
  ReferenceReport,
} from './types';
import { stripMarkdownInline } from './parse';

const YEAR_RE = /\b(19|20)\d{2}\b/;
const DOI_RE = /(?:doi|DOI)[:：\s]*\S+|\b10\.\d{4,9}\/\S+/;
const TYPE_MARKER_RE = /\[[A-Z]{1,4}(?:\/[A-Z]{1,4})*\]/;
const PAGES_RE = /(?:\d{1,5}\s*[-–—~]\s*\d{1,5}|pp?\.?\s*\d{1,5}(?:\s*[-–—~]\s*\d{1,5})?)/i;

/** 编号引用的正则：[1] [1,2] [1-3] [1，3] [1, 3-5] [1–3] [1~3] [1至3] */
const NUMERIC_CITATION_RE =
  /\[(\s*\d{1,3}\s*(?:[-–—~～至]\s*\d{1,3}\s*)?(?:\s*[,，;；]\s*\d{1,3}\s*(?:[-–—~～至]\s*\d{1,3}\s*)?)*)\]/g;

/** 作者-年份引用：(Smith et al., 2020)、（Smith等，2020）、（李四等，2021） */
const AUTHOR_YEAR_RE =
  /[（(]\s*([A-Za-z\u3400-\u9fff][A-Za-z'’.\- \u3400-\u9fff]{1,30}?(?:et al\.?|等)?)\s*[,，]\s*((?:19|20)\d{2})\s*[)）]/g;

/** 编号条目行的开始：[1] / 1. / 1、/ （1） */
const ENTRY_START_RE = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.)、]|（(\d{1,3})）)\s*/;

export interface ReferenceRange {
  sectionRange: { from: number; to: number } | null;
  /** 正文区间（排除参考文献章节后的所有区域，用于引文提取） */
  bodyRanges: Array<{ from: number; to: number }>;
}

/** 定位参考文献章节与正文区间 */
export function findReferenceRanges(units: PaperUnit[]): ReferenceRange {
  let refHeadingIndex = -1;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind !== 'heading' || !unit.headingText) continue;
    const title = unit.headingText.replace(/^#+\s*/, '').replace(/^\d+(\.\d+)*[\s.、)]*/, '').trim();
    if (/^(参考文献|文献)|^(references?|bibliography)\b/i.test(title)) {
      refHeadingIndex = i;
      break;
    }
  }
  if (refHeadingIndex < 0) return { sectionRange: null, bodyRanges: units.length ? [{ from: 0, to: units[units.length - 1].to }] : [] };

  const heading = units[refHeadingIndex];
  const level = heading.headingLevel ?? 1;
  // 参考文献章节到「下一个同级或更高级标题」为止，否则到文档末尾
  let end = units.length > 0 ? units[units.length - 1].to : heading.to;
  for (let i = refHeadingIndex + 1; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind === 'heading' && (unit.headingLevel ?? 1) <= level) {
      end = unit.from;
      break;
    }
  }
  const bodyRanges: Array<{ from: number; to: number }> = [];
  if (refHeadingIndex > 0 && units[refHeadingIndex - 1]) {
    bodyRanges.push({ from: 0, to: units[refHeadingIndex - 1].to });
  }
  // 参考文献章节之后（如有附录）也属于正文区
  if (end < (units.length ? units[units.length - 1].to : end)) {
    bodyRanges.push({ from: end, to: units[units.length - 1].to });
  }
  return { sectionRange: { from: heading.from, to: end }, bodyRanges };
}

interface RawEntry {
  index: number;
  text: string;
  from: number;
  to: number;
  lineStart: number;
}

/** 从参考文献章节文本中切分条目 */
export function parseReferenceEntries(sectionText: string, sectionFrom: number): RawEntry[] {
  const lines = sectionText.split('\n');
  interface LinePos {
    line: string;
    lineNo: number;
    from: number;
  }
  const positions: LinePos[] = [];
  let offset = 0;
  lines.forEach((line, i) => {
    positions.push({ line, lineNo: i, from: offset });
    offset += line.length + 1;
  });

  // 找出所有编号起始行
  const starts: Array<{ pos: LinePos; index: number }> = [];
  for (const pos of positions) {
    const match = ENTRY_START_RE.exec(pos.line);
    if (match) {
      const index = Number(match[1] ?? match[2] ?? match[3]);
      starts.push({ pos, index });
    }
  }

  if (starts.length === 0) {
    // 无编号样式：每个非空行视为一条；上一行不以句末标点结尾时视为续行合并
    const entries: RawEntry[] = [];
    let index = 1;
    for (const pos of positions) {
      const text = pos.line.trim();
      if (text.length === 0) continue;
      const last = entries[entries.length - 1];
      if (last && !/[。.．;；:：]$/.test(last.text)) {
        last.text = `${last.text} ${text}`;
        last.to = sectionFrom + pos.from + pos.line.length;
      } else {
        entries.push({
          index: index++,
          text,
          from: sectionFrom + pos.from,
          to: sectionFrom + pos.from + pos.line.length,
          lineStart: pos.lineNo + 1,
        });
      }
    }
    return entries;
  }

  const entries: RawEntry[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const nextFrom = i + 1 < starts.length ? starts[i + 1].pos.from : offset;
    const contentLines = positions.filter((p) => p.from >= start.pos.from && p.from < nextFrom);
    const text = contentLines
      .map((p) => p.line.replace(/^\s*(?:\[\d{1,3}\]|\d{1,3}[.)、]|（\d{1,3}）)\s*/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const last = contentLines[contentLines.length - 1];
    entries.push({
      index: start.index,
      text,
      from: sectionFrom + start.pos.from,
      to: sectionFrom + (last ? last.from + last.line.length : start.pos.from + start.pos.line.length),
      lineStart: start.pos.lineNo + 1,
    });
  }
  return entries;
}

/** 展开单个引用 token（如 "3" 或 "3-5"）为序号数组 */
function expandIndexToken(token: string, maxExpand = 100): number[] {
  const match = /^\s*(\d{1,3})\s*(?:[-–—~～至]\s*(\d{1,3}))?\s*$/.exec(token);
  if (!match) return [];
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (end < start || end - start > maxExpand) return [start];
  const result: number[] = [];
  for (let n = start; n <= end; n++) result.push(n);
  return result;
}

/** 在正文区间提取编号引用 */
export function extractNumericCitations(
  docText: string,
  bodyRanges: Array<{ from: number; to: number }>,
  refSection: { from: number; to: number } | null,
): Array<{ raw: string; from: number; to: number; indexes: number[] }> {
  const fenceRanges = findFenceRanges(docText);
  const inlineCodeRanges = findInlineCodeRanges(docText);
  const results: Array<{ raw: string; from: number; to: number; indexes: number[] }> = [];
  for (const range of bodyRanges) {
    NUMERIC_CITATION_RE.lastIndex = 0;
    const slice = docText.slice(range.from, range.to);
    let match: RegExpExecArray | null;
    while ((match = NUMERIC_CITATION_RE.exec(slice)) !== null) {
      const from = range.from + match.index;
      const to = range.from + NUMERIC_CITATION_RE.lastIndex;
      // 排除链接语法 [1](url)
      if (docText[to] === '(') continue;
      if (isInsideAny(from, to, fenceRanges) || isInsideAny(from, to, inlineCodeRanges)) continue;
      if (refSection && from >= refSection.from && from < refSection.to) continue;
      const indexes: number[] = [];
      for (const token of match[1].split(/[,，;；]/)) {
        indexes.push(...expandIndexToken(token));
      }
      results.push({ raw: match[0], from, to, indexes: [...new Set(indexes)] });
    }
  }
  return results;
}

/** 提取作者-年份引用 */
export function extractAuthorYearCitations(docText: string, bodyRanges: Array<{ from: number; to: number }>): Array<Omit<AuthorYearCitation, 'paragraphIndex' | 'matchedIndex'>> {
  const fenceRanges = findFenceRanges(docText);
  const inlineCodeRanges = findInlineCodeRanges(docText);
  const results: Array<Omit<AuthorYearCitation, 'paragraphIndex' | 'matchedIndex'>> = [];
  for (const range of bodyRanges) {
    AUTHOR_YEAR_RE.lastIndex = 0;
    const slice = docText.slice(range.from, range.to);
    let match: RegExpExecArray | null;
    while ((match = AUTHOR_YEAR_RE.exec(slice)) !== null) {
      const from = range.from + match.index;
      const to = range.from + AUTHOR_YEAR_RE.lastIndex;
      if (isInsideAny(from, to, fenceRanges) || isInsideAny(from, to, inlineCodeRanges)) continue;
      const authorPart = match[1]?.trim() ?? '';
      const surname = extractSurname(authorPart);
      results.push({ raw: match[0], from, to, surname, year: match[2] });
    }
  }
  return results;
}

function extractSurname(authorPart: string): string {
  let cleaned = authorPart.replace(/^(et al\.?|等)\s*/i, '').trim();
  cleaned = cleaned.replace(/\s*(?:et al\.?|等)$/i, '').trim();
  const first = cleaned.split(/[\s,，]/)[0];
  return first.toLowerCase();
}

function findFenceRanges(docText: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const re = /^[ \t]*(```+|~~~+)[^\n]*$/gm;
  let match: RegExpExecArray | null;
  const opens: { index: number; char: string; length: number }[] = [];
  while ((match = re.exec(docText)) !== null) {
    const char = match[1][0];
    const length = match[1].length;
    const openIdx = opens.findIndex((o) => o.char === char);
    if (openIdx < 0) {
      opens.push({ index: match.index, char, length });
    } else {
      const open = opens.splice(openIdx, 1)[0];
      ranges.push({ from: open.index, to: re.lastIndex });
    }
  }
  for (const open of opens) {
    ranges.push({ from: open.index, to: docText.length });
  }
  return ranges;
}

function findInlineCodeRanges(docText: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const re = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(docText)) !== null) {
    ranges.push({ from: match.index, to: re.lastIndex });
  }
  return ranges;
}

function isInsideAny(from: number, to: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

/** 启发式抽取条目字段 */
export function extractReferenceFields(text: string): ReferenceEntry['fields'] {
  const plain = stripMarkdownInline(text);
  const year = YEAR_RE.exec(plain)?.[0] ?? null;
  const typeMarker = TYPE_MARKER_RE.exec(plain)?.[0] ?? null;
  const doi = DOI_RE.exec(plain)?.[0] ?? null;

  // 作者段：第一个句号/空格分隔前的片段（启发式）
  const segments = plain
    .split(/(?:\.\s+|．\s+|\s{2,})/)
    .map((s) => s.trim())
    .filter(Boolean);
  let authors: string | null = null;
  let title: string | null = null;
  const first = segments[0] ?? '';
  if (first.length >= 2 && first.length <= 120 && !/^\d/.test(first)) {
    const hasName = /[A-Za-z\u3400-\u9fff]/.test(first) && /[,，;；&\s]/.test(first);
    if (hasName || /(et al|等)/i.test(first)) {
      authors = first;
      title = segments[1] ?? null;
    } else {
      title = first;
    }
  } else if (segments.length > 1) {
    title = segments[0];
  }
  return { authors, year, title, typeMarker, doi };
}

/** 归一化条目文本（用于查重） */
export function normalizeEntryText(text: string): string {
  return stripMarkdownInline(text)
    .toLowerCase()
    .replace(/[\s，。．、,.:;；"'“”‘’()（）\[\]【】\-–—~]/g, '');
}

/** 依据用户设定的引用格式模板，给出条目的格式问题提示 */
export function lintReferenceFormat(text: string, format: ReferenceFormatSettings): string[] {
  const hints: string[] = [];
  const fields = extractReferenceFields(text);
  const template =
    format.preset === 'custom'
      ? format.customTemplate
      : REFERENCE_FORMAT_TEMPLATES[format.preset]?.template ?? '';

  const plain = stripMarkdownInline(text);

  const wantsYear = /(出版年|年份|\{year\})/.test(template) || format.preset !== 'custom';
  const wantsPages = /(页码|页|\{pages\}|起止页)/.test(template);
  const wantsType = /(\[文献类型|类型标识|\{type\})/.test(template);
  const wantsDoi = /(DOI|doi|\{doi\})/.test(template);
  const wantsTitle = /(题名|篇名|题目|\{title\})/.test(template);
  const wantsJournal = /(刊名|期刊|出处|\{journal\})/.test(template);

  if (wantsYear && !fields.year) hints.push('疑似缺少出版年');
  if (wantsPages && !PAGES_RE.test(plain)) hints.push('疑似缺少起止页码');
  if (wantsType && !fields.typeMarker) hints.push('疑似缺少文献类型标识（如 [J]、[M]）');
  if (wantsDoi && !fields.doi) hints.push('疑似缺少 DOI');
  if (wantsTitle && !fields.title) hints.push('疑似缺少题名');
  if (wantsJournal && !fields.title && !fields.authors) hints.push('疑似缺少刊名/出处');
  if (!/[.。！!？?]$/.test(plain.trim()) && plain.trim().length > 0) hints.push('条目结尾疑似缺少标点');
  return hints;
}

/** 各预设的模板说明（也用于提示词与 UI 展示） */
export const REFERENCE_FORMAT_TEMPLATES: Record<
  string,
  { template: string; rules: string }
> = {
  'gb-t7714': {
    template: '作者. 题名[文献类型标识]. 出版地: 出版者, 出版年: 起止页码.',
    rules:
      '正文引用用 [序号] 上标或平排标注；文末参考文献按正文引用顺序连续编号，同一文献多次引用用同一序号。文献类型标识：期刊[J]、专著[M]、论文集[C]、学位论文[D]、报告[R]、标准[S]、专利[P]、电子资源[EB/OL]。',
  },
  apa7: {
    template: 'Author, A. A. (Year). Title of article. Journal Name, Volume(Issue), pages. DOI',
    rules:
      '正文引用标注（作者, 年份）；文末参考文献按第一作者姓氏字母顺序排列。期刊：作者. (年). 题名. 刊名, 卷(期), 页码. DOI；专著：作者. (年). 书名. 出版者。',
  },
};

/** 组装完整性报告 */
export function buildReferenceReport(docText: string, units: PaperUnit[], format: ReferenceFormatSettings | null): ReferenceReport {
  const ranges = findReferenceRanges(units);
  const entries: ReferenceEntry[] = [];
  const rawEntries: RawEntry[] = [];

  if (ranges.sectionRange) {
    const sectionText = docText.slice(ranges.sectionRange.from, ranges.sectionRange.to);
    const parsed = parseReferenceEntries(sectionText, ranges.sectionRange.from);
    for (const raw of parsed) {
      rawEntries.push(raw);
      const fields = extractReferenceFields(raw.text);
      entries.push({
        index: raw.index,
        from: raw.from,
        to: raw.to,
        text: raw.text,
        fields,
        citedByParagraphs: [],
        citeCount: 0,
        formatHints: format ? lintReferenceFormat(raw.text, format) : [],
        duplicateOf: null,
      });
    }
  }

  const citationsRaw = extractNumericCitations(docText, ranges.bodyRanges, ranges.sectionRange);
  const authorYearRaw = extractAuthorYearCitations(docText, ranges.bodyRanges);

  // 段落归属：按 offset 找到段落 unitIndex
  const unitOfOffset = (offset: number): number => {
    for (const unit of units) {
      if (offset >= unit.from && offset < unit.to) return unit.index;
    }
    return -1;
  };

  const indexMap = new Map<number, ReferenceEntry>();
  for (const entry of entries) indexMap.set(entry.index, entry);

  const citations: CitationMatch[] = citationsRaw.map((c) => ({
    raw: c.raw,
    from: c.from,
    to: c.to,
    paragraphIndex: unitOfOffset(c.from),
    indexes: c.indexes,
  }));

  const seenPairs = new Set<string>();
  for (const citation of citations) {
    if (citation.paragraphIndex < 0) continue;
    for (const idx of citation.indexes) {
      const entry = indexMap.get(idx);
      if (entry) {
        const pairKey = `${entry.index}:${citation.paragraphIndex}`;
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          entry.citedByParagraphs.push(citation.paragraphIndex);
        }
        entry.citeCount += 1;
      }
    }
  }

  // 作者-年份匹配
  const authorYear: AuthorYearCitation[] = authorYearRaw.map((c) => {
    let matchedIndex: number | null = null;
    for (const entry of entries) {
      if (entry.fields.year === c.year && c.surname.length >= 3) {
        const normalized = entry.text.toLowerCase();
        if (normalized.includes(c.surname)) {
          matchedIndex = entry.index;
          break;
        }
      }
    }
    return { ...c, paragraphIndex: unitOfOffset(c.from), matchedIndex };
  });

  // 未引用 / 未定义
  const uncited = entries.filter((entry) => entry.citeCount === 0 && authorYear.every((c) => c.matchedIndex !== entry.index));
  const definedIndexes = new Set(entries.map((e) => e.index));
  const undefinedCitations: ReferenceReport['undefined'] = [];
  for (const citation of citations) {
    for (const idx of citation.indexes) {
      if (!definedIndexes.has(idx)) {
        undefinedCitations.push({ index: idx, raw: citation.raw, paragraphIndex: citation.paragraphIndex });
      }
    }
  }

  // 疑似重复
  const duplicates: { a: number; b: number }[] = [];
  const normalizedMap = new Map<string, number>();
  for (const entry of entries) {
    const key = normalizeEntryText(entry.text);
    if (!key) continue;
    const existing = normalizedMap.get(key);
    if (existing !== undefined) {
      entries.find((e) => e.index === existing)!.duplicateOf = entry.index;
      duplicates.push({ a: existing, b: entry.index });
    } else {
      normalizedMap.set(key, entry.index);
    }
  }
  // 作者+年份相同的疑似重复（不同文本）
  const authorYearGroups = new Map<string, number[]>();
  for (const entry of entries) {
    const key = `${normalizeEntryText(entry.fields.authors ?? '')}|${entry.fields.year ?? ''}`;
    if (!entry.fields.authors || !entry.fields.year) continue;
    const group = authorYearGroups.get(key) ?? [];
    group.push(entry.index);
    authorYearGroups.set(key, group);
  }
  for (const group of authorYearGroups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!duplicates.some((d) => (d.a === group[i] && d.b === group[j]) || (d.a === group[j] && d.b === group[i]))) {
          duplicates.push({ a: group[i], b: group[j] });
        }
      }
    }
  }

  return {
    sectionRange: ranges.sectionRange,
    entries,
    citations,
    authorYear,
    uncited,
    undefined: undefinedCitations,
    duplicates,
    totalRefs: entries.length,
    totalCitations: citations.length,
  };
}
