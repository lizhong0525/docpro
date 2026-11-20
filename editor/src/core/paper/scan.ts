/**
 * AI 痕迹扫描（确定性、纯本地）。
 *
 * 目标是「大模型生产的论文」里最常见的质量缺陷：
 * - 空洞连接词堆砌（首先/其次/最后、综上所述、众所周知……）
 * - 模板句（随着……的发展、在……背景下）
 * - 官方腔/黑话（赋能、抓手、闭环）
 * - AI 自述痕迹（作为一个人工智能……）
 * - 占位符与未完成内容（TODO、待补充、（此处……））
 * - 无引用支撑的断言（研究表明/数据显示 且本段无引文标记）
 * - 破折号滥用、碎片化列表、跨段重复开头
 *
 * 扫描只做「提示」，不做「定罪」：命中只是建议用户核对。
 */
import type { AiIssue, AiIssueKind, PaperUnit } from './types';

interface Rule {
  kind: AiIssueKind;
  severity: 'info' | 'warn';
  message: string;
  /** 命中的正则（对段落纯文本执行） */
  patterns: RegExp[];
  /** 达到该命中数才报告（默认 1） */
  minHits?: number;
}

const RULES: Rule[] = [
  {
    kind: 'sequence-filler',
    severity: 'warn',
    message: '机械的序列连接词堆砌（首先/其次/最后、第一/第二/第三…），典型 AI 行文',
    patterns: [/首先|其次|再次|最后|第一|第二|第三|第四|其一|其二|其三|一方面|另一方面/g],
    minHits: 3,
  },
  {
    kind: 'empty-connector',
    severity: 'warn',
    message: '空洞总结连接词（综上所述/众所周知/显而易见…），学术写作中通常多余',
    patterns: [/综上所述|总而言之|综上|众所周知|毋庸置疑|不难发现|显而易见|不可否认|必须指出|毫无疑义/g],
  },
  {
    kind: 'template-phrase',
    severity: 'info',
    message: '模板化句式（随着…的发展 / 在…背景下 / 在当今…时代）',
    patterns: [
      /随着.{2,20}的(?:不断|飞速|快速)?发展/g,
      /在.{2,20}的背景(?:之)?下/g,
      /在当今.{0,10}(?:时代|社会)/g,
      /近年来/g,
      /为了(?:更好地|进一步|推动)/g,
      /为.{2,10}提供(?:了)?(?:有力|坚实)?(?:保障|支撑|基础)/g,
    ],
  },
  {
    kind: 'buzzword',
    severity: 'info',
    message: '宣传腔/黑话词汇（赋能/抓手/闭环/落地/打磨），论文中宜用中性表述',
    patterns: [/赋能|抓手|闭环|落地|打磨|痛点|风口|生态圈|新范式|顶层设计/g],
    minHits: 2,
  },
  {
    kind: 'ai-self-reference',
    severity: 'warn',
    message: 'AI 自述痕迹（作为一个人工智能/作为 AI 助手/我可以帮你…），论文中应彻底删除',
    patterns: [/作为一个?(?:人工智能|AI|大语言模型|语言模型|助手)|作为AI助手|我可以帮你|我可以协助|I am an AI|as an AI (?:assistant|language model)/gi],
  },
  {
    kind: 'placeholder',
    severity: 'warn',
    message: '占位符或未完成内容（TODO/待补充/（此处…）等），需补全',
    patterns: [
      /\b(?:TODO|TBD|FIXME|XXX)\b/i,
      /待补充|待完善|待填写|（此处[^）]*）|\(此处[^)]*\)|待插入|此处需要|Lorem ipsum/i,
      /\{\{[^}]*\}\}|【】|（待/,
      /[（(]图\s*\d*[）)][:：]?\s*[（(]?待/,
    ],
  },
  {
    kind: 'uncited-claim',
    severity: 'info',
    message: '数据/研究类断言但本段没有引文标记，请核对来源或补引文',
    patterns: [/研究表明|研究显示|数据显示|调查显示|据统计|实验表明|实践证明|大量研究|已有研究|相关研究表明/g],
  },
  {
    kind: 'excessive-dash',
    severity: 'info',
    message: '破折号使用密集（AI 生成文本常见特征），建议改用逗号/句号',
    patterns: [/——/g],
    minHits: 4,
  },
];

/** 对一个单元的纯文本执行规则扫描 */
export function scanUnit(unit: PaperUnit): Omit<AiIssue, 'paragraphIndex'>[] {
  if (unit.plainText.length === 0) return [];
  const issues: Omit<AiIssue, 'paragraphIndex'>[] = [];
  for (const rule of RULES) {
    const matches: string[] = [];
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(unit.plainText)) !== null) {
        matches.push(match[0].length > 24 ? `${match[0].slice(0, 24)}…` : match[0]);
        if (matches.length >= 5) break;
      }
      if (matches.length >= 5) break;
    }
    if (matches.length >= (rule.minHits ?? 1)) {
      issues.push({ kind: rule.kind, severity: rule.severity, message: rule.message, matches });
    }
  }
  return issues;
}

/** 跨段检查：多个段落以相同开头（如同样的连接词开头），提示行文单调 */
export function scanRepeatedOpenings(units: PaperUnit[]): Array<{ unitIndex: number; opening: string }> {
  const openings = new Map<string, number[]>();
  for (const unit of units) {
    if (!['text', 'list', 'quote'].includes(unit.kind)) continue;
    const opening = unit.plainText.slice(0, 3);
    if (opening.length < 2) continue;
    if (!/[\u3400-\u9fff]/.test(opening)) continue; // 只对中文开头敏感
    const list = openings.get(opening) ?? [];
    list.push(unit.index);
    openings.set(opening, list);
  }
  const result: Array<{ unitIndex: number; opening: string }> = [];
  for (const [opening, list] of openings) {
    if (list.length >= 3) {
      for (const unitIndex of list) result.push({ unitIndex, opening });
    }
  }
  return result;
}

/** 碎片化列表：列表块内条目过多且每条过短 */
export function scanBulletSoup(unit: PaperUnit): Omit<AiIssue, 'paragraphIndex'> | null {
  if (unit.kind !== 'list') return null;
  const items = unit.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d{1,3}[.)、]\s+)/, '').trim())
    .filter((item) => item.length > 0);
  if (items.length < 6) return null;
  const shortCount = items.filter((item) => item.length < 20).length;
  if (shortCount < items.length - 2) return null;
  return {
    kind: 'bullet-soup',
    severity: 'info',
    message: '碎片化列表：条目多而短，建议合并为连贯段落或减少条目',
    matches: items.slice(0, 5).map((item) => (item.length > 24 ? `${item.slice(0, 24)}…` : item)),
  };
}

/** 汇总单段扫描结果（含跨段规则） */
export function scanParagraphIssues(unit: PaperUnit, repeatedOpenings: Set<number>): Omit<AiIssue, 'paragraphIndex'>[] {
  const issues = scanUnit(unit);
  const soup = scanBulletSoup(unit);
  if (soup) issues.push(soup);
  if (repeatedOpenings.has(unit.index)) {
    const opening = unit.plainText.slice(0, 3);
    issues.push({
      kind: 'repeated-opening',
      severity: 'info',
      message: `多个段落以相同开头（“${opening}…”），行文单调，建议变化起句`,
      matches: [opening],
    });
  }
  return issues;
}

export const AI_ISSUE_KIND_LABELS: Record<AiIssueKind, string> = {
  'sequence-filler': '序列堆砌',
  'empty-connector': '空洞连接词',
  buzzword: '宣传腔',
  'template-phrase': '模板句式',
  'ai-self-reference': 'AI 自述',
  placeholder: '未完成内容',
  'uncited-claim': '无引用断言',
  'repeated-opening': '重复开头',
  'excessive-dash': '破折号密集',
  'bullet-soup': '碎片列表',
};
