/**
 * 参考文献联网核实（确定性打分，纯函数）。
 *
 * 用 DeepSeek Search API（/v1/tools/search）检索文末条目，再把结果标题/摘要与
 * 条目做 token 重叠比对，给出 found / suspicious / unverified 三档：
 * - found：找到高相似来源（≥ 0.6），可视为文献真实存在；
 * - suspicious：有弱匹配或完全没找到（< 0.6），提示人工核实（不直接断言造假）；
 * - unverified：搜索本身失败（网络/限流），不下结论。
 *
 * 打分是启发式的：中英文混排的条目、译名差异都会影响结果，UI 一律展示"建议核实"。
 */
import type { ReferenceEntry, RefVerifyEntry, RefVerifyMatch } from './types';

/** Search API 返回的一条结果（服务端归一化后传入） */
export interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  summary?: string;
  siteName?: string | null;
  publishedAt?: string | null;
  rerankScore?: number;
}

const LATIN_TOKEN_RE = /[a-z][a-z0-9'-]{1,}/gi;
const CJK_RUN_RE = /[\u3400-\u9fff]{2,}/g;

/** 抽 token：拉丁词（小写、去短词）+ 中文 bigram */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(LATIN_TOKEN_RE)) {
    const word = match[0].replace(/^[-']+|[-']+$/g, '');
    if (word.length >= 3 && !STOP_WORDS.has(word)) tokens.push(word);
  }
  for (const run of text.matchAll(CJK_RUN_RE)) {
    const chars = run[0];
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars.slice(i, i + 2));
  }
  return tokens;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'using',
  'based',
  'via',
  'into',
  'are',
  'was',
  'were',
  'has',
  'have',
  'et',
  'al',
]);

/** 从条目文本抽出「拿来做检索」的标题部分 */
export function referenceTitleText(entry: ReferenceEntry): string {
  if (entry.fields.title && entry.fields.title.trim().length >= 4) return entry.fields.title.trim();
  // 兜底：去掉年份与文献类型标记后的正文
  return entry.text
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\[[A-Z]{1,4}(\/[A-Z]{1,4})*\]/g, ' ')
    .slice(0, 160)
    .trim();
}

/** 构造检索词：标题 + 年份（有作者时带上第一作者） */
export function buildReferenceQuery(entry: ReferenceEntry): string {
  const title = referenceTitleText(entry);
  const author = entry.fields.authors?.split(/[,，;；]/)[0]?.trim().slice(0, 24) ?? '';
  const year = entry.fields.year ?? '';
  const parts = [author, title, year].filter((part) => part.length > 0);
  const query = parts.join(' ').replace(/\s+/g, ' ').trim();
  return query.slice(0, 128);
}

/** 标题相似度（0~1）：token 重叠率 + 年份/DOI 加成 */
export function scoreReferenceMatch(entry: ReferenceEntry, hit: SearchHit): number {
  const target = tokenize(referenceTitleText(entry));
  if (target.length === 0) return 0;
  const haystack = new Set(tokenize(`${hit.title} ${hit.summary ?? ''} ${hit.snippet ?? ''}`));
  let overlap = 0;
  for (const token of target) {
    if (haystack.has(token)) overlap += 1;
  }
  // 以目标 token 数为分母（标题很短时更严格），最多累计到 1
  let score = Math.min(1, overlap / Math.max(4, Math.min(target.length, 24)));
  const year = entry.fields.year;
  if (year && `${hit.title} ${hit.summary ?? ''} ${hit.snippet ?? ''}`.includes(year)) score = Math.min(1, score + 0.12);
  const doi = entry.fields.doi;
  if (doi) {
    const doiCore = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
    if (doiCore && `${hit.title} ${hit.summary ?? ''} ${hit.snippet ?? ''}`.toLowerCase().includes(doiCore)) score = Math.max(score, 0.95);
  }
  return Math.round(score * 100) / 100;
}

/** 单条条目的核实结论 */
export function verifyReference(entry: ReferenceEntry, hits: SearchHit[]): RefVerifyEntry {
  const query = buildReferenceQuery(entry);
  const matches: RefVerifyMatch[] = hits.slice(0, 5).map((hit) => ({
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
    summary: hit.summary,
    siteName: hit.siteName ?? null,
    publishedAt: hit.publishedAt ?? null,
    rerankScore: hit.rerankScore,
  }));
  if (hits.length === 0) {
    return { index: entry.index, query, verdict: 'suspicious', score: 0, reason: '搜索没有返回结果，需人工核实该文献是否存在', matches };
  }
  let best = 0;
  for (const hit of hits) best = Math.max(best, scoreReferenceMatch(entry, hit));
  if (best >= 0.6) {
    return { index: entry.index, query, verdict: 'found', score: best, reason: '找到高相似来源', matches };
  }
  if (best >= 0.3) {
    return { index: entry.index, query, verdict: 'suspicious', score: best, reason: '只有弱匹配结果，题名/作者/年份可能不一致', matches };
  }
  return { index: entry.index, query, verdict: 'suspicious', score: best, reason: '未找到匹配结果，疑似不存在或题名有误', matches };
}

/** 搜索失败的条目（不下结论） */
export function unverifiedReference(entry: ReferenceEntry, query: string, reason: string): RefVerifyEntry {
  return { index: entry.index, query, verdict: 'unverified', score: 0, reason, matches: [] };
}
