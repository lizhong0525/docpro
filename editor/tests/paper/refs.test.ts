import { describe, expect, it } from 'vitest';
import { analyzePaper } from '../../src/core/paper/analyze';
import {
  buildReferenceReport,
  extractAuthorYearCitations,
  extractNumericCitations,
  extractReferenceFields,
  lintReferenceFormat,
  normalizeEntryText,
  parseReferenceEntries,
} from '../../src/core/paper/refs';
import { parsePaperBlocks } from '../../src/core/paper/parse';
import { defaultMemory } from '../../src/core/paper/memory';

function makeDoc(body: string, refs: string[]): string {
  return `${body}\n\n## 参考文献\n\n${refs.map((r, i) => `[${i + 1}] ${r}`).join('\n')}\n`;
}

describe('参考文献切分', () => {
  it('[n] 编号样式切分条目', () => {
    const entries = parseReferenceEntries('[1] 张三. 论文一[J]. 学报, 2020.\n[2] 李四. 论文二[J]. 学报, 2021.', 100);
    expect(entries).toHaveLength(2);
    expect(entries[0].index).toBe(1);
    expect(entries[0].text).toBe('张三. 论文一[J]. 学报, 2020.');
    expect(entries[0].from).toBe(100);
  });

  it('多行条目合并为一条', () => {
    const text = '[1] 张三.\n论文标题很长[J].\n学报, 2020.\n[2] 李四. 短条目[J]. 2021.';
    const entries = parseReferenceEntries(text, 0);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('张三. 论文标题很长[J]. 学报, 2020.');
  });

  it('无编号样式：按行编号', () => {
    const entries = parseReferenceEntries('张三. 条目一. 2020.\n李四. 条目二. 2021.', 0);
    expect(entries.map((e) => e.index)).toEqual([1, 2]);
  });

  it('数字编号样式 1. / （1）', () => {
    const entries = parseReferenceEntries('1. 张三. 条目[J]. 2020.\n（2） 李四. 条目[J]. 2021.', 0);
    expect(entries.map((e) => e.index)).toEqual([1, 2]);
  });
});

describe('正文引用提取', () => {
  it('展开范围与列表引用', () => {
    const text = '本文参考[1]与[2,4]，以及[3-5]和[6，7]的方案。';
    const citations = extractNumericCitations(text, [{ from: 0, to: text.length }], null);
    expect(citations.map((c) => c.indexes)).toEqual([[1], [2, 4], [3, 4, 5], [6, 7]]);
  });

  it('忽略链接语法 [1](url) 与代码块', () => {
    const text = '见[链接](https://x.y)，代码 `[9]`，围栏内\n```\n[8]\n```\n正文[3]。';
    const citations = extractNumericCitations(text, [{ from: 0, to: text.length }], null);
    expect(citations.map((c) => c.indexes)).toEqual([[3]]);
  });

  it('作者-年份引用提取', () => {
    const text = '已有工作（Smith et al., 2020）表明；另一项（李四等，2021）也指出。';
    const found = extractAuthorYearCitations(text, [{ from: 0, to: text.length }]);
    expect(found).toHaveLength(2);
    expect(found[0].surname).toBe('smith');
    expect(found[0].year).toBe('2020');
    expect(found[1].surname).toBe('李四');
  });
});

describe('字段抽取与格式提示', () => {
  it('抽取年份/类型标记/DOI', () => {
    const fields = extractReferenceFields('Smith, J., & Doe, A. (2020). Title of paper[J]. Journal of Tests, 1(2), 3-10. https://doi.org/10.1000/xyz123');
    expect(fields.year).toBe('2020');
    expect(fields.typeMarker).toBe('[J]');
    expect(fields.doi).toContain('10.1000/xyz123');
    expect(fields.authors).toContain('Smith');
  });

  it('GB/T 7714 模板下缺字段给出提示', () => {
    const format = { ...defaultMemory().referenceFormat, preset: 'gb-t7714' as const };
    const hints = lintReferenceFormat('张三. 没有年份的条目[J]. 某学报.', format);
    expect(hints.some((h) => h.includes('出版年'))).toBe(true);
    expect(hints.some((h) => h.includes('页码'))).toBe(true);
  });

  it('自定义模板按占位符检查', () => {
    const format = { preset: 'custom' as const, customTemplate: '作者. 题名. 刊名, 出版年, 页码. DOI', note: '' };
    const hints = lintReferenceFormat('张三. 有题目但没年份也没页. 某刊, 2020.', format);
    expect(hints.some((h) => h.includes('页码'))).toBe(true);
    expect(hints.some((h) => h.includes('DOI'))).toBe(true);
    expect(hints.some((h) => h.includes('出版年'))).toBe(false);
  });

  it('归一化用于查重', () => {
    const a = normalizeEntryText('Zhang, S. Title. J. Test, 2020.');
    const b = normalizeEntryText('zhang s title j test 2020');
    expect(a).toBe(b);
  });
});

describe('完整性交叉检查', () => {
  it('未引用条目、未定义引用、被引统计', () => {
    const doc = makeDoc('正文提到[1]和[2]，[2]再次引用。', [
      '张三. 条目一[J]. 学报, 2020.',
      '李四. 条目二[J]. 学报, 2021.',
      '王五. 从未被引用[J]. 学报, 2022.',
    ]);
    const analysis = analyzePaper(doc);
    const report = analysis.references;
    expect(report.totalRefs).toBe(3);
    expect(report.uncited.map((e) => e.index)).toEqual([3]);
    const entry2 = report.entries.find((e) => e.index === 2);
    expect(entry2?.citeCount).toBe(2);
    const para = analysis.paragraphs.find((p) => p.plainText.includes('正文提到'));
    expect(para?.citations).toEqual([1, 2]);
  });

  it('引用了不存在的序号 → undefined', () => {
    const doc = makeDoc('正文引用[4]。', ['张三. 条目一[J]. 学报, 2020.']);
    const analysis = analyzePaper(doc);
    expect(analysis.references.undefined.map((u) => u.index)).toEqual([4]);
  });

  it('重复条目检测（完全相同与作者+年份相同）', () => {
    const doc = makeDoc('正文[1][3]。', [
      '张三. 标题A[J]. 学报, 2020.',
      '李四. 标题B[J]. 学报, 2021.',
      '张三. 标题A[J]. 学报, 2020.',
    ]);
    const analysis = analyzePaper(doc);
    expect(analysis.references.duplicates).toEqual([{ a: 1, b: 3 }]);
  });

  it('无参考文献章节时报告为空且不误报', () => {
    const doc = '# 引言\n\n正文内容，没有引用。\n';
    const analysis = analyzePaper(doc);
    expect(analysis.references.sectionRange).toBeNull();
    expect(analysis.references.totalRefs).toBe(0);
    expect(analysis.references.undefined).toHaveLength(0);
  });

  it('作者-年份引用与条目匹配', () => {
    const doc = makeDoc('已有研究（Smith et al., 2020）指出。', ['Smith, J., & Doe, A. (2020). Title. Journal.']);
    const analysis = analyzePaper(doc);
    expect(analysis.references.authorYear).toHaveLength(1);
    expect(analysis.references.authorYear[0].matchedIndex).toBe(1);
  });

  it('参考文献章节之后的内容仍算正文（附录）', () => {
    const doc = makeDoc('正文[1]。', ['张三. 条目一[J]. 学报, 2020.']) + '\n\n## 附录\n\n附录里提到[1]。';
    const units = parsePaperBlocks(doc);
    const report = buildReferenceReport(doc, units, null);
    expect(report.totalCitations).toBe(2);
  });
});
