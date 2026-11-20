/**
 * 论文记忆（Paper Memory）：用户补充的、随每次修订注入模型的上下文。
 *
 * 记忆内容属于「论文底层格式逻辑/要求」的载体：
 * - requirements：总体要求（目标期刊、审稿要求、格式逻辑……）
 * - referenceFormat：参考文献格式（GB/T 7714 / APA / 自定义模板）
 * - terminology：术语表
 * - styleNotes：风格与语言要求
 *
 * 记忆是可编辑的「输入」，不是系统提示词的私有财产：服务端只做清洗与
 * 长度收敛，不悄悄改写用户的规则。
 */
import { REFERENCE_FORMAT_TEMPLATES } from './refs';
import type { PaperMemory, PaperTerm, ReferenceFormatId, ReferenceFormatSettings } from './types';

export const MAX_MEMORY_LENGTHS = {
  requirements: 8_000,
  targetVenue: 200,
  customTemplate: 2_000,
  referenceNote: 2_000,
  term: 80,
  termNote: 200,
  maxTerms: 200,
  styleNotes: 4_000,
} as const;

export function defaultReferenceFormat(): ReferenceFormatSettings {
  return { preset: 'gb-t7714', customTemplate: '', note: '' };
}

export function defaultMemory(): PaperMemory {
  return {
    version: 1,
    requirements: '',
    targetVenue: '',
    referenceFormat: defaultReferenceFormat(),
    terminology: [],
    styleNotes: '',
    updatedAt: Date.now(),
  };
}

function clampString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** 解析术语表文本（每行 "术语" 或 "术语：说明"） */
export function parseTerminologyText(text: string): PaperTerm[] {
  const terms: PaperTerm[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.search(/[:：=]/);
    const term = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const note = idx >= 0 ? line.slice(idx + 1).trim() : '';
    if (!term) continue;
    terms.push({ term: term.slice(0, MAX_MEMORY_LENGTHS.term), note: note.slice(0, MAX_MEMORY_LENGTHS.termNote) });
    if (terms.length >= MAX_MEMORY_LENGTHS.maxTerms) break;
  }
  return terms;
}

/** 清洗客户端传入的记忆对象（永不抛错，缺字段回落默认） */
export function normalizeMemory(input: unknown): PaperMemory {
  const base = defaultMemory();
  if (!input || typeof input !== 'object') return base;
  const raw = input as Partial<PaperMemory>;
  const referenceFormatRaw = (raw.referenceFormat ?? {}) as Partial<ReferenceFormatSettings>;
  const preset: ReferenceFormatId =
    referenceFormatRaw.preset === 'apa7' || referenceFormatRaw.preset === 'custom'
      ? referenceFormatRaw.preset
      : 'gb-t7714';
  return {
    version: 1,
    requirements: clampString(raw.requirements, MAX_MEMORY_LENGTHS.requirements),
    targetVenue: clampString(raw.targetVenue, MAX_MEMORY_LENGTHS.targetVenue),
    referenceFormat: {
      preset,
      customTemplate: clampString(referenceFormatRaw.customTemplate, MAX_MEMORY_LENGTHS.customTemplate),
      note: clampString(referenceFormatRaw.note, MAX_MEMORY_LENGTHS.referenceNote),
    },
    terminology: Array.isArray(raw.terminology)
      ? raw.terminology
          .filter((t): t is PaperTerm => Boolean(t && typeof t === 'object'))
          .map((t) => ({
            term: clampString(t.term, MAX_MEMORY_LENGTHS.term),
            note: clampString(t.note, MAX_MEMORY_LENGTHS.termNote),
          }))
          .filter((t) => t.term.length > 0)
          .slice(0, MAX_MEMORY_LENGTHS.maxTerms)
      : [],
    styleNotes: clampString(raw.styleNotes, MAX_MEMORY_LENGTHS.styleNotes),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

/** 参考文献格式规则（注入提示词） */
export function referenceFormatRules(memory: PaperMemory): string {
  const format = memory.referenceFormat;
  if (format.preset === 'custom') {
    const template = format.customTemplate.trim() || '（用户未填写模板，保持原文格式）';
    const note = format.note.trim();
    return [
      `参考文献格式（自定义模板）：${template}`,
      note ? `补充规则：${note}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const preset = REFERENCE_FORMAT_TEMPLATES[format.preset];
  if (!preset) return '';
  const note = format.note.trim();
  return [
    `参考文献格式：${format.preset === 'gb-t7714' ? 'GB/T 7714-2015（顺序编码制）' : 'APA 第 7 版（著者-出版年）'}`,
    `格式规则：${preset.rules}`,
    note ? `补充规则：${note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 记忆 → 系统提示词片段（空记忆返回空字符串） */
export function memoryToPromptSection(memory: PaperMemory): string {
  const sections: string[] = [];
  if (memory.targetVenue.trim()) sections.push(`目标场合：${memory.targetVenue.trim()}`);
  if (memory.requirements.trim()) sections.push(`论文要求（用户指定，优先级最高）：\n${memory.requirements.trim()}`);
  const refRules = referenceFormatRules(memory);
  if (refRules) sections.push(refRules);
  if (memory.terminology.length > 0) {
    const lines = memory.terminology.map((t) => (t.note ? `- ${t.term}：${t.note}` : `- ${t.term}`));
    sections.push(`术语表（必须遵守，不得随意改写术语）：\n${lines.join('\n')}`);
  }
  if (memory.styleNotes.trim()) sections.push(`风格与语言要求：${memory.styleNotes.trim()}`);
  return sections.join('\n\n');
}

/** 判断记忆是否「有内容」（UI 用于提示未填写） */
export function memoryIsEmpty(memory: PaperMemory): boolean {
  return (
    !memory.requirements.trim() &&
    !memory.targetVenue.trim() &&
    !memory.referenceFormat.note.trim() &&
    memory.terminology.length === 0 &&
    !memory.styleNotes.trim()
  );
}
