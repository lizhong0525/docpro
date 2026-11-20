/**
 * 论文助手的提示词构建。
 *
 * 与普通编辑不同，论文修订的提示词把「引文保护」作为一等约束：
 * 模型不得删除、修改或新增引文标记——这一约束在提示词与校验（apply.ts）
 * 两层同时执行，提示词失效时校验层兜底。
 */
import type { PaperMemory, PaperParagraph } from './types';
import { memoryToPromptSection } from './memory';

/** 逐段修订的系统提示词 */
export function buildPaperSystemPrompt(memory: PaperMemory): string {
  const memorySection = memoryToPromptSection(memory);
  return [
    '你是严谨的学术论文修订专家。用户会给你论文中的一个段落，你要按修订要求改进它。',
    '',
    '硬性规则（违反任何一条都是失败）：',
    '1. 只输出修订后的段落本身（Markdown），不要任何解释、前言、结语或代码围栏。',
    '2. 保留原文的全部事实、数字、公式、变量、专有名词、图表编号（如图1、表2）。',
    '3. 原文中的引文标记（[1]、[3-5]、(Smith et al., 2020) 等）必须原样保留：不得删除、不得改写编号、不得新增原文没有的引文。绝对禁止编造参考文献。',
    '4. 不新增原文没有的结论、数据或出处；信息缺失时宁可保留原状，也不编造。',
    '5. 学术、克制、具体的表达：删除空话套话（“综上所述”“众所周知”等堆砌）、AI 腔与宣传腔；不为了凑字数重复。',
    '6. 保持原文的 Markdown 结构（列表、引用层级、表格行列）；本段若是列表/表格，输出仍是列表/表格，表格的列数与表头含义不得改变。',
    '7. 只改有问题的地方：若原文已经合格，输出原文或仅做最小修改；无必要不要整段重排。',
    '8. 输出语言与原文一致（中文论文输出中文，英文论文输出英文）。',
    '',
    memorySection ? `用户补充的论文上下文与要求：\n${memorySection}` : '',
    '',
    '再次强调：输出只有修订后的段落，不要代码围栏，不要解释。',
  ]
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n');
}

const DEFAULT_INSTRUCTION =
  '修订这段文字：纠正 AI 痕迹与空话套话、语病与表述不规范，保持原意、事实、数字与引文标记不变。';

/** 逐段修订的用户提示词 */
export function buildPaperUserPrompt(
  docTitle: string,
  paragraph: PaperParagraph,
  instruction: string,
  previousSnippet: string | null,
  nextSnippet: string | null,
): string {
  const parts: string[] = [];
  parts.push(`<论文标题>：${docTitle || '（未命名）'}`);
  if (paragraph.sectionTitle) {
    const kindNote: Record<string, string> = {
      abstract: '摘要',
      keywords: '关键词',
      body: '正文',
      intro: '引言',
      conclusion: '结论',
      references: '参考文献',
      acknowledgment: '致谢',
      appendix: '附录',
      title: '题目',
      front: '前置信息',
      heading: '标题',
    };
    parts.push(`<所属章节>：${paragraph.sectionTitle}（${kindNote[paragraph.sectionKind ?? 'body'] ?? '正文'}）`);
  }
  if (previousSnippet) parts.push(`<前一段开头>：${previousSnippet}`);
  parts.push(`<待修订段落>：\n${paragraph.text}`);
  if (nextSnippet) parts.push(`<后一段开头>：${nextSnippet}`);
  parts.push(`<修订要求>：${instruction.trim() || DEFAULT_INSTRUCTION}`);
  return parts.join('\n\n');
}

/** 修复重试消息：模型输出未通过校验时给出具体原因 */
export function buildPaperRepairMessage(reason: string): string {
  return [
    '你上一次的输出没有通过自动校验，请重新输出修订后的段落。',
    `校验失败原因：${reason}`,
    '请严格只输出修订后的段落本身，不要代码围栏、不要解释；引文标记必须与原文完全一致。',
  ].join('\n');
}

/** 参考文献格式重排的系统提示词 */
export function buildRefsFixSystemPrompt(memory: PaperMemory): string {
  const memorySection = memoryToPromptSection(memory);
  return [
    '你是参考文献格式整理专家。用户会给出编号的参考文献条目列表，你按指定格式重排每条。',
    '',
    '硬性规则：',
    '1. 逐条输出，每条一行，行首为原编号：`[n] 修订后的条目`。',
    '2. 只利用条目中已有的信息：作者、题名、出处、年份、卷期页、DOI 等；任何缺失的信息不得编造。',
    '3. 不得合并、拆分、新增或删除条目；输出条数必须与输入完全一致，编号必须连续。',
    '4. 条目的出版年、卷期页、DOI 等关键数字必须与输入一致，只调整顺序与标点。',
    '5. 中文文献用中文标点，英文文献用英文标点。',
    '6. 不要输出任何解释、前言或代码围栏。',
    '',
    memorySection ? `格式要求：\n${memorySection}` : '',
    '',
    '输出示例：\n[1] 张三, 李四. 论示例[J]. 示例学报, 2020, 40(2): 100-110.',
  ].join('\n');
}

/** 参考文献格式重排的用户提示词 */
export function buildRefsFixUserPrompt(docTitle: string, entries: Array<{ index: number; text: string }>): string {
  const lines = entries.map((entry) => `[${entry.index}] ${entry.text}`).join('\n');
  return [`<论文标题>：${docTitle || '（未命名）'}`, '<参考文献条目>：', lines, '', '请按格式要求逐条重排输出。'].join('\n');
}
