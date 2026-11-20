/**
 * 逐段修订输出的清洗与校验（确定性）。
 *
 * 模型输出是不可信输入。这里做四件事：
 * 1. 清洗：剥掉代码围栏/前后空行等格式噪音；
 * 2. 上下文泄漏校验：输出里不应出现邻段的大段原文；
 * 3. 引文保护：修订后段落的引文标记集合必须与原文一致——
 *    丢引文 → warn；新增已有序号的引文 → warn（需人工确认属实）；
 *    新增不存在序号的引文 → error（视为编造，禁止应用）；
 * 4. 空输出 / 无变化检测。
 */
import { extractAuthorYearCitations, extractNumericCitations } from './refs';
import type { PaperWarning, PaperWarningCode } from './types';

export interface PaperOutputContext {
  oldText: string;
  /** 文末参考文献列表中存在的全部序号 */
  refIndexes: Set<number>;
  neighborBefore: string;
  neighborAfter: string;
}

export interface PaperValidationResult {
  /** 清洗后的输出文本 */
  text: string;
  warnings: PaperWarning[];
  /** 需要拒绝应用的硬错误（空数组 = 可应用） */
  errors: string[];
}

const CONTEXT_LEAK_THRESHOLD = 40;

/** 剥掉模型常见的输出噪音：代码围栏、首尾空行、前后缀说明 */
export function sanitizePaperOutput(raw: string): { text: string; sanitized: boolean } {
  let text = raw;
  let sanitized = false;

  // 去除最外层代码围栏（``` / ~~~，可选语言标记）
  const fenceWrap = /^\s*(```+|~~~+)[^\n]*\n([\s\S]*?)\n?\s*\1\s*$/.exec(text);
  if (fenceWrap) {
    text = fenceWrap[2];
    sanitized = true;
  } else {
    const openFence = /^\s*(```+|~~~+)[^\n]*\n/.exec(text);
    const closeFence = /\n\s*(```+|~~~+)\s*$/.exec(text);
    if (openFence && closeFence) {
      text = text.slice(openFence[0].length, closeFence.index).trim();
      sanitized = true;
    }
  }

  const trimmed = text.trim();
  if (trimmed !== text) {
    text = trimmed;
    sanitized = true;
  }
  return { text, sanitized };
}

/** 判断修订输出是否包含相邻段落的原文泄漏 */
export function detectContextLeak(output: string, neighborBefore: string, neighborAfter: string, oldText: string): string | null {
  const check = (neighbor: string): string | null => {
    const sample = neighbor.trim();
    if (sample.length < CONTEXT_LEAK_THRESHOLD) return null;
    const start = sample.slice(0, CONTEXT_LEAK_THRESHOLD);
    const end = sample.slice(-CONTEXT_LEAK_THRESHOLD);
    // 邻段开头/结尾的大段原文出现在输出里、且不属于原段落本身 → 泄漏
    if (output.includes(start) && !oldText.includes(start)) return start;
    if (output.includes(end) && !oldText.includes(end)) return end;
    return null;
  };
  return check(neighborBefore) ?? check(neighborAfter);
}

interface CitationDelta {
  dropped: number[];
  added: number[];
  invalid: number[];
  /** 编号引用原文被改动（如 [1,2] 变成 [1] 属于 dropped；格式变化另行报告） */
  rawBefore: string[];
  rawAfter: string[];
}

/** 对比修订前后的编号引文集合 */
export function compareCitations(oldText: string, newText: string, ctx: PaperOutputContext): CitationDelta {
  const before = extractNumericCitations(oldText, [{ from: 0, to: oldText.length }], null);
  const after = extractNumericCitations(newText, [{ from: 0, to: newText.length }], null);

  const set = (matches: Array<{ indexes: number[] }>): Set<number> => {
    const s = new Set<number>();
    for (const m of matches) for (const i of m.indexes) s.add(i);
    return s;
  };
  const beforeSet = set(before);
  const afterSet = set(after);

  const dropped = [...beforeSet].filter((i) => !afterSet.has(i)).sort((a, b) => a - b);
  const added = [...afterSet].filter((i) => !beforeSet.has(i)).sort((a, b) => a - b);
  const invalid = added.filter((i) => !ctx.refIndexes.has(i));

  return {
    dropped,
    added,
    invalid,
    rawBefore: before.map((m) => m.raw),
    rawAfter: after.map((m) => m.raw),
  };
}

/** 对比作者-年份引用（按 year+surname 的规范化键） */
export function compareAuthorYearCitations(oldText: string, newText: string): { dropped: string[]; added: string[] } {
  const extract = (text: string): string[] => {
    const found = extractAuthorYearCitations(text, [{ from: 0, to: text.length }]);
    return found.map((c) => `${c.surname}|${c.year}`);
  };
  const before = new Set(extract(oldText));
  const after = new Set(extract(newText));
  return {
    dropped: [...before].filter((k) => !after.has(k)),
    added: [...after].filter((k) => !before.has(k)),
  };
}

/** 提取文本中的表格列数（取第一条表格的首行列数）；无表格返回 null */
function tableColumnCount(text: string): number | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!(line.startsWith('|') && line.endsWith('|'))) continue;
    const next = lines[i + 1]?.trim() ?? '';
    const isSeparator = next.startsWith('|') && next.endsWith('|') && next.slice(1, -1).split('|').every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell.trim()));
    if (isSeparator) {
      return line.slice(1, -1).split('|').length;
    }
  }
  return null;
}

/** 表格结构保护：原文有表格时，输出不得丢失表格或改变列数（提示级，不阻断） */
export function checkTableStructure(oldText: string, newText: string): PaperWarning | null {
  const oldColumns = tableColumnCount(oldText);
  if (oldColumns === null) return null;
  const newColumns = tableColumnCount(newText);
  if (newColumns === null) {
    return {
      code: 'table-structure',
      severity: 'warn',
      message: '原文包含表格，修订后的段落里表格消失了。除非你有意删除表格，否则请重新生成。',
    };
  }
  if (newColumns !== oldColumns) {
    return {
      code: 'table-structure',
      severity: 'info',
      message: `表格列数发生了变化（${oldColumns} 列 → ${newColumns} 列），请确认表头与数据对应关系仍然正确。`,
    };
  }
  return null;
}

function warning(code: PaperWarningCode, severity: PaperWarning['severity'], message: string): PaperWarning {
  return { code, severity, message };
}

/** 主入口：清洗 + 校验模型输出，返回可应用文本与警告/错误 */
export function validatePaperOutput(raw: string, ctx: PaperOutputContext): PaperValidationResult {
  const { text, sanitized } = sanitizePaperOutput(raw);
  const warnings: PaperWarning[] = [];
  const errors: string[] = [];

  if (sanitized) {
    warnings.push(warning('fence-sanitized', 'info', '已自动去除模型输出中的代码围栏等格式噪音'));
  }

  if (text.trim().length === 0) {
    errors.push('模型输出为空');
    return { text, warnings, errors };
  }

  const leak = detectContextLeak(text, ctx.neighborBefore, ctx.neighborAfter, ctx.oldText);
  if (leak) {
    errors.push('模型输出中包含相邻段落的原文（上下文泄漏），已拒绝该提案');
    return { text, warnings, errors };
  }

  const citationDelta = compareCitations(ctx.oldText, text, ctx);
  if (citationDelta.invalid.length > 0) {
    const message = `模型新增了不存在的引文编号 ${citationDelta.invalid.map((i) => `[${i}]`).join('、')}（参考文献列表中没有这些条目）。这是编造引文的典型表现，已拒绝该提案。`;
    errors.push(message);
    return { text, warnings, errors };
  }
  if (citationDelta.dropped.length > 0) {
    warnings.push(
      warning('citation-dropped', 'warn', `修订后的段落删除了原文的引文标记 ${citationDelta.dropped.map((i) => `[${i}]`).join('、')}，请确认是有意删除。`),
    );
  }
  if (citationDelta.added.length > 0) {
    warnings.push(
      warning('citation-added', 'warn', `修订后的段落新增了引文 ${citationDelta.added.map((i) => `[${i}]`).join('、')}，请人工确认该处确实引用了对应文献。`),
    );
  }
  if (citationDelta.rawBefore.join('') !== citationDelta.rawAfter.join('') && citationDelta.rawBefore.length > 0 && citationDelta.dropped.length === 0 && citationDelta.added.length === 0) {
    warnings.push(warning('citation-format-changed', 'info', '引文标记的书写形式有变化（如 [1,2] 与 [1][2]），请确认编号仍然正确。'));
  }

  const authorYearDelta = compareAuthorYearCitations(ctx.oldText, text);
  if (authorYearDelta.dropped.length > 0) {
    warnings.push(
      warning('author-year-dropped', 'warn', `修订后的段落删除了作者-年份引用（${authorYearDelta.dropped.slice(0, 3).join('、')}${authorYearDelta.dropped.length > 3 ? ' 等' : ''}），请确认。`),
    );
  }

  const tableWarning = checkTableStructure(ctx.oldText, text);
  if (tableWarning) warnings.push(tableWarning);

  if (text === ctx.oldText) {
    warnings.push(warning('no-change', 'info', '模型输出与原文一致（无需修改）'));
  }

  return { text, warnings, errors };
}
