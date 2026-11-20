import { describe, expect, it } from 'vitest';
import {
  checkTableStructure,
  compareAuthorYearCitations,
  compareCitations,
  detectContextLeak,
  sanitizePaperOutput,
  validatePaperOutput,
  type PaperOutputContext,
} from '../../src/core/paper/apply';

function ctx(overrides: Partial<PaperOutputContext> = {}): PaperOutputContext {
  return {
    oldText: '原始段落内容。',
    refIndexes: new Set([1, 2, 3, 5]),
    neighborBefore: '前一段落的内容，用来检测模型是否把上下文吐了回来。',
    neighborAfter: '后一段落的内容，同样用于上下文泄漏检测。',
    ...overrides,
  };
}

describe('输出清洗', () => {
  it('剥掉代码围栏', () => {
    const { text, sanitized } = sanitizePaperOutput('```markdown\n修订后的内容。\n```');
    expect(text).toBe('修订后的内容。');
    expect(sanitized).toBe(true);
  });

  it('剥掉前后空行', () => {
    const { text } = sanitizePaperOutput('\n\n修订后的内容。\n\n');
    expect(text).toBe('修订后的内容。');
  });

  it('纯文本不受影响', () => {
    const { text, sanitized } = sanitizePaperOutput('修订后的内容。');
    expect(text).toBe('修订后的内容。');
    expect(sanitized).toBe(false);
  });
});

describe('上下文泄漏检测', () => {
  it('输出包含邻段开头 → 泄漏', () => {
    const neighbor = '前一段落的内容，用来检测模型是否把上下文吐了回来，这段文字必须足够长才能命中阈值。';
    const leak = detectContextLeak(`先说一堆${neighbor.slice(0, 50)}然后继续`, neighbor, '其他', '');
    expect(leak).not.toBeNull();
  });

  it('输出不含邻段 → 无泄漏', () => {
    const neighbor = '前一段落的内容，用来检测模型是否把上下文吐了回来，这段文字必须足够长才能命中阈值。';
    expect(detectContextLeak('干净的输出内容。', neighbor, '后面内容，与输出无关的另一段描述文字。', '')).toBeNull();
  });
});

describe('引文保护', () => {
  it('保留引文：无警告', () => {
    const c = ctx({ oldText: '本文方法见[1]与[3-5]。' });
    const result = validatePaperOutput('本文提出的方法详见[1]与[3-5]。', c);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.filter((w) => w.code.startsWith('citation'))).toHaveLength(0);
  });

  it('删除引文 → warn', () => {
    const c = ctx({ oldText: '本文方法见[1]。' });
    const result = validatePaperOutput('本文方法见相关文献。', c);
    expect(result.warnings.some((w) => w.code === 'citation-dropped')).toBe(true);
  });

  it('新增已存在序号 → warn（需人工确认）', () => {
    const c = ctx({ oldText: '本文方法。' });
    const result = validatePaperOutput('本文方法见[2]。', c);
    expect(result.warnings.some((w) => w.code === 'citation-added')).toBe(true);
  });

  it('新增不存在序号 → error（编造引文，禁止应用）', () => {
    const c = ctx({ oldText: '本文方法。' });
    const result = validatePaperOutput('本文方法见[99]。', c);
    expect(result.errors.some((e) => e.includes('99'))).toBe(true);
  });

  it('作者-年份引用被删除 → warn', () => {
    const c = ctx({ oldText: '已有工作（Smith et al., 2020）表明。' });
    const result = validatePaperOutput('已有工作表明。', c);
    expect(result.warnings.some((w) => w.code === 'author-year-dropped')).toBe(true);
  });

  it('无变化 → info 提示', () => {
    const c = ctx({ oldText: '原文。' });
    const result = validatePaperOutput('原文。', c);
    expect(result.warnings.some((w) => w.code === 'no-change')).toBe(true);
  });

  it('空输出 → error', () => {
    const c = ctx();
    const result = validatePaperOutput('  \n ', c);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('compareCitations 展开集合差', () => {
    const c = ctx({ oldText: '[1,2][3-5]' });
    const delta = compareCitations('[1,2][3-5]', '[1][3]', c);
    expect(delta.dropped).toEqual([2, 4, 5]);
    expect(delta.added).toEqual([]);
  });

  it('compareAuthorYearCitations 对比键', () => {
    const delta = compareAuthorYearCitations('（Smith et al., 2020）', '（Doe, 2021）');
    expect(delta.dropped).toEqual(['smith|2020']);
    expect(delta.added).toEqual(['doe|2021']);
  });
});

describe('表格结构保护', () => {
  const table = '| 方法 | 准确率 |\n| --- | --- |\n| A | 0.9 |\n| B | 0.8 |';

  it('原文无表格 → 无警告', () => {
    expect(checkTableStructure('普通段落。', '普通段落（改）。')).toBeNull();
  });

  it('表格保留且列数一致 → 无警告', () => {
    expect(checkTableStructure(table, '| 方法 | 准确率 |\n| --- | --- |\n| A | 0.91 |\n| B | 0.79 |')).toBeNull();
  });

  it('表格消失 → warn', () => {
    const warning = checkTableStructure(table, '我们测试了两种方法。');
    expect(warning?.code).toBe('table-structure');
    expect(warning?.severity).toBe('warn');
  });

  it('列数变化 → info', () => {
    const warning = checkTableStructure(table, '| 方法 | 准确率 | 年份 |\n| --- | --- | --- |\n| A | 0.9 | 2024 |');
    expect(warning?.severity).toBe('info');
    expect(warning?.message).toContain('3 列');
  });

  it('validatePaperOutput 对表格输出给出表格警告', () => {
    const c = ctx({ oldText: table });
    const result = validatePaperOutput('我们测试了两种方法。', c);
    expect(result.warnings.some((w) => w.code === 'table-structure')).toBe(true);
  });
});
