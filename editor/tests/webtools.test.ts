/**
 * DeepSeek 全家桶：联网工具请求声明 + 流式扩展字段解析 + 参考文献联网核实打分。
 */
import { describe, expect, it } from 'vitest';
import { buildChatRequestBody, flattenServerToolCalls, supportsWebTools, toCitations, toWebSource, toWebToolCall } from '../server/deepseek';
import { buildReferenceQuery, scoreReferenceMatch, verifyReference } from '../src/core/paper/verify';
import type { ReferenceEntry } from '../src/core/paper/types';

function entry(partial: Partial<ReferenceEntry> & { text: string }): ReferenceEntry {
  return {
    index: 1,
    from: 0,
    to: 10,
    fields: { authors: null, year: null, title: null, typeMarker: null, doi: null },
    citedByParagraphs: [],
    citeCount: 0,
    formatHints: [],
    duplicateOf: null,
    ...partial,
  };
}

describe('联网工具请求声明', () => {
  it('flash + webTools → tools 声明 deepseek_web_search / deepseek_read_url', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: 'off',
      webTools: { search: true, readUrl: true },
    });
    expect(body.tools).toEqual([{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }]);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('仅 search 时只声明 web_search', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: 'high',
      webTools: { search: true },
    });
    expect(body.tools).toEqual([{ type: 'deepseek_web_search' }]);
    expect(body.reasoning_effort).toBe('high');
  });

  it('v4-pro 不支持联网工具：即使传入也不声明', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: 'off',
      webTools: { search: true, readUrl: true },
    });
    expect(body.tools).toBeUndefined();
    expect(supportsWebTools('deepseek-v4-pro')).toBe(false);
    expect(supportsWebTools('deepseek-flash')).toBe(true);
  });

  it('未开启时不发送 tools', () => {
    const body = buildChatRequestBody({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], thinking: 'off' });
    expect(body.tools).toBeUndefined();
  });
});

describe('联网工具流式字段解析', () => {
  it('toWebSource 归一化搜索来源', () => {
    const source = toWebSource({ url: 'https://a.b/c', title: '标题', snippet: '摘要', site_name: '站点', published_at: '2026-01-02T03:04:05+00:00' });
    expect(source).toEqual({ url: 'https://a.b/c', title: '标题', snippet: '摘要', siteName: '站点', publishedAt: '2026-01-02T03:04:05+00:00' });
    expect(toWebSource({ title: '没有 url' })).toBeNull();
  });

  it('toWebToolCall 归一化 search 调用（含 queries 与 sources）', () => {
    const call = toWebToolCall({
      index: 0,
      id: 'srvtoolu_s_00_x',
      type: 'deepseek_web_search',
      kind: 'search',
      action: { type: 'search', queries: ['DeepSeek V4'] },
      status: 'completed',
      sources: [{ url: 'https://x.y', title: 'X', snippet: 's' }],
    });
    expect(call).not.toBeNull();
    expect(call?.kind).toBe('search');
    expect(call?.queries).toEqual(['DeepSeek V4']);
    expect(call?.sources).toHaveLength(1);
    expect(call?.status).toBe('completed');
  });

  it('toWebToolCall 归一化 read_link / failed 调用', () => {
    const call = toWebToolCall({
      type: 'deepseek_read_url',
      kind: 'read_link',
      action: { type: 'read_link', url: 'https://a.b' },
      status: 'failed',
      error: { code: 'url_not_accessible' },
      page: { url: 'https://a.b', title: '页面' },
    });
    expect(call?.kind).toBe('read_link');
    expect(call?.url).toBe('https://a.b');
    expect(call?.status).toBe('failed');
    expect(call?.error).toBe('url_not_accessible');
  });

  it('flattenServerToolCalls 展平多步调用', () => {
    const calls = flattenServerToolCalls([
      { index: 0, calls: [{ kind: 'search', action: { type: 'search', queries: ['a'] }, status: 'completed', sources: [] }] },
      { index: 1, calls: [{ kind: 'read_link', action: { type: 'read_link', url: 'https://u' }, status: 'completed', sources: [] }] },
    ]);
    expect(calls.map((call) => call.kind)).toEqual(['search', 'read_link']);
  });

  it('toCitations 解析 url_citation 注解', () => {
    const citations = toCitations([
      { type: 'url_citation', url_citation: { url: 'https://a.b', title: 'Title', start_index: 0, end_index: 12 } },
      { type: 'unknown' },
    ]);
    expect(citations).toEqual([{ url: 'https://a.b', title: 'Title', startIndex: 0, endIndex: 12 }]);
  });
});

describe('参考文献联网核实打分', () => {
  const bert = entry({
    text: 'Devlin J, Chang M W, Lee K, et al. BERT: Pre-training of deep bidirectional transformers for language understanding[J]. arXiv preprint, 2018.',
    fields: { authors: 'Devlin J, Chang M W', year: '2018', title: 'BERT: Pre-training of deep bidirectional transformers for language understanding', typeMarker: '[J]', doi: null },
  });

  it('buildReferenceQuery 组合作者/标题/年份', () => {
    const query = buildReferenceQuery(bert);
    expect(query).toContain('Devlin');
    expect(query).toContain('BERT');
    expect(query).toContain('2018');
    expect(query.length).toBeLessThanOrEqual(128);
  });

  it('高相似结果 → found', () => {
    const result = verifyReference(bert, [
      {
        url: 'https://arxiv.org/abs/1810.04805',
        title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
        summary: 'Devlin et al. 2018. arXiv preprint.',
      },
    ]);
    expect(result.verdict).toBe('found');
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  it('无结果 → suspicious（需人工核实，不断言造假）', () => {
    const result = verifyReference(bert, []);
    expect(result.verdict).toBe('suspicious');
    expect(result.reason).toContain('需人工核实');
  });

  it('弱相关结果 → suspicious', () => {
    const result = verifyReference(bert, [
      { url: 'https://x.y', title: 'A survey of graph neural networks', summary: 'Nothing related.' },
    ]);
    expect(result.verdict).toBe('suspicious');
    expect(result.score).toBeLessThan(0.6);
  });

  it('DOI 命中直接高置信', () => {
    const withDoi = entry({
      ...bert,
      fields: { ...bert.fields, doi: '10.1000/xyz123' },
    });
    const result = verifyReference(withDoi, [
      { url: 'https://doi.org/10.1000/xyz123', title: 'Unrelated title', summary: 'https://doi.org/10.1000/xyz123' },
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(result.verdict).toBe('found');
  });

  it('scoreReferenceMatch 年份加成不越界', () => {
    const score = scoreReferenceMatch(bert, { url: 'u', title: 'BERT 2018', summary: '' });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0);
  });
});
