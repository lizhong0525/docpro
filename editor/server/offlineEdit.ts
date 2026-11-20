import type { EditRequest, ServerEvent, Timings, Usage } from '../src/core/types';
import { analyzeSelection } from '../src/core/selection';
import { buildProposal } from '../src/core/apply';

const concisePhrases = [
  ['可以进行报名', '可以报名'], ['进行报名', '报名'], ['进行登记', '登记'],
  ['进行整理', '整理'], ['提前进行预约', '提前预约'], ['在此期间内', '期间'],
  ['有需要的居民朋友们', '有需要的居民'], ['各位居民朋友们', '各位居民'],
  ['进行统一收集', '统一收集'], ['相关的材料', '相关材料']
] as const;

/** Keep Markdown structure, links, inline and fenced code intact during prose cleanup. */
export function streamline(text: string): string {
  const protectedParts = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/\S+)/g;
  return text.split(protectedParts).map((part, index) => {
    if (index % 2) return part;
    return concisePhrases.reduce((value, [before, after]) => value.replaceAll(before, after), part);
  }).join('');
}

export function runOfflineEdit(request: EditRequest, send: (event: ServerEvent) => void): void {
  const range = request.ranges[0];
  const local = analyzeSelection(request.docText, range.from, range.to, range.index);
  const insert = request.options.mode === 'insert';
  const direct = request.instruction.match(/^替换为[：:]([\s\S]*)$/);
  const text = insert ? request.instruction : direct ? direct[1] : streamline(range.text);
  const startedAt = Date.now();
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const timings: Timings = { startedAt, finishedAt: startedAt, totalMs: 0, attempts: 1, repairs: 0 };
  const options = { ...request.options, mode: insert ? 'insert' as const : 'rewrite' as const };
  send({ type: 'status', phase: 'validating', note: '正在本机核对选区与规则结果。' });
  const { proposal, repair } = buildProposal({
    request: { ...request, options }, localAnalyses: [local], usage, timings,
    sanitize: false, allowFuzzy: false,
    parsed: { analysis: null, content: text, answer: '', edits: [],
      truncated: false, hasEditBlock: false, missingSentinels: false, raw: '', issues: [] }
  });
  if (proposal) {
    proposal.engine = 'offline';
    send({ type: 'delta', rangeId: range.index, text });
    send({ type: 'proposal', proposal });
    send({ type: 'status', phase: 'done', note: '本地规则已完成，无外部请求。' });
  } else {
    send({ type: 'error', code: 'offline-rule', message: repair?.message || '规则执行失败。', retryable: false });
  }
  send({ type: 'done', requestId: request.requestId, usage, timings });
}

