import { describe, expect, it } from 'vitest';
import { analyzePaper } from '../../src/core/paper/analyze';
import {
  buildSections,
  classifySectionTitle,
  countWords,
  extractImages,
  findTableBlocks,
  normalizeTableText,
  parsePaperBlocks,
  parseTableData,
  splitTableRow,
  stripMarkdownInline,
} from '../../src/core/paper/parse';

describe('论文结构解析', () => {
  it('标题/文本/列表/表格/代码块正确分块', () => {
    const doc = [
      '# 一级标题',
      '',
      '正文第一段。',
      '正文第二段。',
      '',
      '- 项目一',
      '- 项目二',
      '',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n');
    const units = parsePaperBlocks(doc);
    const kinds = units.map((u) => u.kind);
    expect(kinds).toEqual(['heading', 'text', 'list', 'table', 'code']);
    expect(units[0].headingLevel).toBe(1);
    expect(units[0].headingText).toBe('一级标题');
    expect(units[1].plainText).toBe('正文第一段。 正文第二段。');
    expect(units[4].text).toContain('print("hi")');
  });

  it('代码围栏内的标题/空行不拆块', () => {
    const doc = '说明\n\n```\n# 不是标题\n\n- 也不是列表\n```\n后续';
    const units = parsePaperBlocks(doc);
    expect(units.map((u) => u.kind)).toEqual(['text', 'code', 'text']);
    expect(units[1].text).toContain('# 不是标题');
  });

  it('行号与偏移正确（to 不含行尾换行，slice === text）', () => {
    const doc = '第一行\n第二行\n\n第三行';
    const units = parsePaperBlocks(doc);
    expect(units[0].lineStart).toBe(1);
    expect(units[0].lineEnd).toBe(2);
    expect(units[1].lineStart).toBe(4);
    expect(doc.slice(units[0].from, units[0].to)).toBe('第一行\n第二行');
    expect(units[0].text).toBe('第一行\n第二行');
  });

  it('章节标题语义识别', () => {
    expect(classifySectionTitle('摘要')).toBe('abstract');
    expect(classifySectionTitle('Abstract')).toBe('abstract');
    expect(classifySectionTitle('1 引言')).toBe('intro');
    expect(classifySectionTitle('2.1 方法')).toBe('body');
    expect(classifySectionTitle('参考文献')).toBe('references');
    expect(classifySectionTitle('References')).toBe('references');
    expect(classifySectionTitle('致谢')).toBe('acknowledgment');
    expect(classifySectionTitle('附录 A')).toBe('appendix');
    expect(classifySectionTitle('结论与展望')).toBe('conclusion');
    expect(classifySectionTitle('关键词')).toBe('keywords');
  });

  it('章节辖域：内容归属最近标题', () => {
    const doc = ['# 引言', '', '第一段。', '', '## 方法', '', '第二段。', '', '## 结论', '', '第三段。'].join('\n');
    const units = parsePaperBlocks(doc);
    const sections = buildSections(units);
    expect(sections.map((s) => s.title)).toEqual(['引言', '方法', '结论']);
    const analysis = analyzePaper(doc);
    const second = analysis.paragraphs.find((p) => p.plainText === '第二段。');
    expect(second?.sectionTitle).toBe('方法');
    const third = analysis.paragraphs.find((p) => p.plainText === '第三段。');
    expect(third?.sectionTitle).toBe('结论');
    expect(third?.sectionKind).toBe('conclusion');
  });

  it('无标题文档：第一个文本单元是题目', () => {
    const doc = '论文题目：测试\n\n作者：张三\n\n正文内容。';
    const analysis = analyzePaper(doc);
    const kinds = analysis.paragraphs.map((p) => p.kind);
    expect(kinds[0]).toBe('title');
    expect(kinds[1]).toBe('front');
    expect(analysis.title).toContain('论文题目');
  });

  it('stripMarkdownInline 去除行内标记', () => {
    expect(stripMarkdownInline('**粗体** 和 [链接](https://a.b) 与 `code`')).toBe('粗体 和 链接 与 code');
    expect(stripMarkdownInline('- 项目 *斜体*')).toBe('项目 斜体');
  });

  it('countWords 中英文混排', () => {
    expect(countWords('中文三个字')).toBe(5);
    expect(countWords('hello world')).toBe(2);
    expect(countWords('中文 test 内容')).toBe(5);
  });

  it('表格块解析出结构化数据（表头/对齐/数据行）', () => {
    const doc = ['| 方法 | 准确率 | 时间 |', '| :--- | ---: | :---: |', '| A | 0.92 | 12s |', '| B | 0.88 | 9s |'].join('\n');
    const units = parsePaperBlocks(doc);
    expect(units[0].kind).toBe('table');
    expect(units[0].table).not.toBeNull();
    expect(units[0].table?.columnCount).toBe(3);
    expect(units[0].table?.rowCount).toBe(2);
    expect(units[0].table?.header).toEqual(['方法', '准确率', '时间']);
    expect(units[0].table?.align).toEqual(['left', 'right', 'center']);
    expect(units[0].table?.rows[1]).toEqual(['B', '0.88', '9s']);
  });

  it('无分隔行的表格按数据行解析（无表头）', () => {
    const table = parseTableData('| A | 1 |\n| B | 2 |');
    expect(table?.hasHeader).toBe(false);
    expect(table?.rowCount).toBe(2);
    expect(table?.columnCount).toBe(2);
  });

  it('单元格数不足时补齐空单元格', () => {
    const table = parseTableData('| a | b | c |\n| --- | --- | --- |\n| 1 |');
    expect(table?.rows[0]).toEqual(['1', '', '']);
  });

  it('splitTableRow 处理首尾管道与空格', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitTableRow(' a | b ')).toEqual(['a', 'b']);
  });

  it('提取段落中的图片引用', () => {
    const images = extractImages('结果如图：![图1 实验结果](img/result.png)，另一个 ![架构图](https://x.y/a.jpg "示意")。');
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({ alt: '图1 实验结果', src: 'img/result.png' });
    expect(images[1].src).toBe('https://x.y/a.jpg');
  });

  it('analyzePaper 给段落挂图片与表格标记', () => {
    const doc = ['# 实验', '', '结果如图 ![图1](a.png)。', '', '| x | y |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const analysis = analyzePaper(doc);
    const imagePara = analysis.paragraphs.find((p) => p.plainText.includes('结果如图'));
    expect(imagePara?.images).toEqual([{ alt: '图1', src: 'a.png' }]);
    const tablePara = analysis.paragraphs.find((p) => p.isTable);
    expect(tablePara?.isTable).toBe(true);
    expect(tablePara?.revisable).toBe(true);
  });

  it('findTableBlocks 返回可渲染表格块的偏移（用于编辑器内联渲染）', () => {
    const doc = ['前言', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '后记'].join('\n');
    const blocks = findTableBlocks(doc);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(doc.slice(block.from, block.to)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(block.data.columnCount).toBe(2);
  });

  it('findTableBlocks 忽略缺少分隔行的管道文本', () => {
    expect(findTableBlocks('| a | b |\n| 1 | 2 |')).toHaveLength(0);
    expect(findTableBlocks('普通段落\n\n| 只有一行 |')).toHaveLength(0);
  });

  it('findTableBlocks 支持多个表格', () => {
    const doc = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '中间文字', '', '| c | d |', '| --- | --- |', '| 3 | 4 |'].join('\n');
    expect(findTableBlocks(doc)).toHaveLength(2);
  });

  it('normalizeTableText 统一空格与分隔行；已规范返回 null', () => {
    const messy = '|a|b|\n|---|---|\n|1|2|';
    expect(normalizeTableText(messy)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(normalizeTableText('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBeNull();
  });

  it('normalizeTableText 对无表头的管道块提升首行为表头', () => {
    expect(normalizeTableText('| A | 1 |\n| B | 2 |')).toBe('| A | 1 |\n| --- | --- |\n| B | 2 |');
  });

  it('normalizeTableText 保留单元格行内 Markdown，转义裸管道', () => {
    const normalized = normalizeTableText('|**粗体**|[链接](https://x.y)|\n|---|---|\n|a\\|b|c|');
    expect(normalized).not.toBeNull();
    expect(normalized).toContain('**粗体**');
    expect(normalized).toContain('[链接](https://x.y)');
    expect(normalized).toContain('a\\|b');
  });
});
