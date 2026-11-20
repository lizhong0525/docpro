import { describe, expect, it } from 'vitest';
import {
  defaultMemory,
  memoryIsEmpty,
  memoryToPromptSection,
  normalizeMemory,
  parseTerminologyText,
  referenceFormatRules,
} from '../../src/core/paper/memory';
import { buildPaperSystemPrompt, buildPaperUserPrompt, buildRefsFixSystemPrompt } from '../../src/core/paper/prompts';
import type { PaperMemory } from '../../src/core/paper/types';

function memoryWith(partial: Partial<PaperMemory>): PaperMemory {
  return normalizeMemory({ ...defaultMemory(), ...partial });
}

describe('记忆清洗', () => {
  it('缺字段回落默认', () => {
    const memory = normalizeMemory(null);
    expect(memory.requirements).toBe('');
    expect(memory.referenceFormat.preset).toBe('gb-t7714');
    expect(memory.terminology).toEqual([]);
  });

  it('非法 preset 回落 gb-t7714', () => {
    const memory = normalizeMemory({ referenceFormat: { preset: 'bogus', customTemplate: '', note: '' } });
    expect(memory.referenceFormat.preset).toBe('gb-t7714');
  });

  it('超长字段被截断', () => {
    const memory = normalizeMemory({ requirements: 'x'.repeat(20_000) });
    expect(memory.requirements.length).toBeLessThanOrEqual(8_000);
  });

  it('术语表文本解析', () => {
    const terms = parseTerminologyText('注意力机制：用于序列建模\nBERT\n# 注释行\n  : 空术语');
    expect(terms).toEqual([{ term: '注意力机制', note: '用于序列建模' }, { term: 'BERT', note: '' }]);
  });

  it('空记忆判定', () => {
    expect(memoryIsEmpty(defaultMemory())).toBe(true);
    expect(memoryIsEmpty(memoryWith({ requirements: '有要求' }))).toBe(false);
  });
});

describe('提示词构建', () => {
  it('系统提示词注入记忆与引文硬规则', () => {
    const memory = memoryWith({
      requirements: '目标期刊要求：摘要不超过 300 字。',
      terminology: [{ term: '注意力机制', note: 'attention' }],
    });
    const prompt = buildPaperSystemPrompt(memory);
    expect(prompt).toContain('目标期刊要求');
    expect(prompt).toContain('注意力机制');
    expect(prompt).toContain('绝对禁止编造参考文献');
    expect(prompt).toContain('原样保留');
  });

  it('默认记忆只注入默认引用格式规则，不产生空章节', () => {
    const prompt = buildPaperSystemPrompt(defaultMemory());
    expect(prompt).toContain('GB/T 7714-2015');
    expect(prompt).not.toContain('目标场合：');
    expect(prompt).not.toContain('术语表');
  });

  it('用户提示词包含章节与相邻段落', () => {
    const paragraph = {
      id: 'p0',
      unitIndex: 0,
      kind: 'body' as const,
      from: 0,
      to: 10,
      lineStart: 1,
      lineEnd: 1,
      sectionTitle: '1 引言',
      sectionKind: 'body' as const,
      text: '待修订内容。',
      plainText: '待修订内容。',
      words: 6,
      citations: [],
      authorYearCitations: [],
      aiIssues: [],
      images: [],
      isTable: false,
      revisable: true,
      notRevisableReason: null,
    };
    const prompt = buildPaperUserPrompt('测试论文', paragraph, '', '上一段开头。', '下一段开头。');
    expect(prompt).toContain('测试论文');
    expect(prompt).toContain('1 引言');
    expect(prompt).toContain('上一段开头。');
    expect(prompt).toContain('待修订内容。');
    expect(prompt).toContain('下一段开头。');
  });

  it('GB/T 7714 规则注入引用格式', () => {
    const rules = referenceFormatRules(memoryWith({}));
    expect(rules).toContain('GB/T 7714-2015');
    expect(rules).toContain('顺序编码制');
  });

  it('自定义模板注入', () => {
    const rules = referenceFormatRules(
      memoryWith({ referenceFormat: { preset: 'custom', customTemplate: '作者. 题名. 刊名, 年.', note: '年份四位' } }),
    );
    expect(rules).toContain('作者. 题名. 刊名, 年.');
    expect(rules).toContain('年份四位');
  });

  it('参考文献重排提示词包含条目与编号规则', () => {
    const prompt = buildRefsFixSystemPrompt(memoryWith({}));
    expect(prompt).toContain('不得合并、拆分、新增或删除条目');
    expect(prompt).toContain('编号必须连续');
  });
});
