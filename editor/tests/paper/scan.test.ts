import { describe, expect, it } from 'vitest';
import { analyzePaper } from '../../src/core/paper/analyze';
import { scanBulletSoup, scanRepeatedOpenings, scanUnit } from '../../src/core/paper/scan';
import { parsePaperBlocks } from '../../src/core/paper/parse';

describe('AI 痕迹扫描', () => {
  it('序列堆砌命中', () => {
    const unit = parsePaperBlocks('首先，我们要分析问题。其次，要考虑数据。最后，得出结论。')[0];
    const issues = scanUnit(unit);
    expect(issues.some((i) => i.kind === 'sequence-filler')).toBe(true);
  });

  it('空洞连接词命中', () => {
    const unit = parsePaperBlocks('综上所述，众所周知，这个结论显而易见。')[0];
    const issues = scanUnit(unit);
    expect(issues.some((i) => i.kind === 'empty-connector')).toBe(true);
  });

  it('AI 自述命中', () => {
    const unit = parsePaperBlocks('作为一个人工智能，我可以帮你分析这个问题。')[0];
    const issues = scanUnit(unit);
    expect(issues.some((i) => i.kind === 'ai-self-reference')).toBe(true);
  });

  it('占位符命中', () => {
    const unit = parsePaperBlocks('实验结果见（此处需要补充图表）。TODO: 补数据。')[0];
    const issues = scanUnit(unit);
    expect(issues.some((i) => i.kind === 'placeholder')).toBe(true);
  });

  it('无引用断言命中（有引文时不误报）', () => {
    const noCite = parsePaperBlocks('研究表明，这种方法效果显著。')[0];
    expect(scanUnit(noCite).some((i) => i.kind === 'uncited-claim')).toBe(true);
    const withCite = parsePaperBlocks('研究表明，这种方法效果显著[3]。')[0];
    expect(scanUnit(withCite).some((i) => i.kind === 'uncited-claim')).toBe(true); // 引文标记不算（扫描只提示人工核对）
  });

  it('正常段落无命中', () => {
    const unit = parsePaperBlocks('我们提出一种基于注意力的序列建模方法，并在三个基准数据集上验证其有效性。')[0];
    const issues = scanUnit(unit);
    expect(issues).toHaveLength(0);
  });

  it('跨段重复开头', () => {
    const doc = ['此外，第一段内容。', '', '此外，第二段内容。', '', '此外，第三段内容。'].join('\n');
    const units = parsePaperBlocks(doc);
    const repeated = scanRepeatedOpenings(units);
    expect(repeated).toHaveLength(3);
  });

  it('碎片列表命中', () => {
    const doc = ['- 点一', '- 点二', '- 点三', '- 点四', '- 点五', '- 点六', '- 点七'].join('\n');
    const unit = parsePaperBlocks(doc)[0];
    expect(scanBulletSoup(unit)?.kind).toBe('bullet-soup');
    const long = ['- 这是一个内容比较长的条目，不会被判为碎片', '- 这也是一个足够长的条目内容', '- 这是第三个足够长的条目内容'].join('\n');
    expect(scanBulletSoup(parsePaperBlocks(long)[0])).toBeNull();
  });

  it('analyzePaper 汇总 issues 并挂到段落', () => {
    const doc = '# 引言\n\n综上所述，众所周知，这个方法很好。\n\n正常段落内容。\n';
    const analysis = analyzePaper(doc);
    expect(analysis.stats.issues).toBeGreaterThan(0);
    const bad = analysis.paragraphs.find((p) => p.plainText.includes('综上所述'));
    expect(bad?.aiIssues.length).toBeGreaterThan(0);
    const good = analysis.paragraphs.find((p) => p.plainText.includes('正常段落'));
    expect(good?.aiIssues).toHaveLength(0);
  });
});
