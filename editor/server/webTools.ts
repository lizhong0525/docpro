/**
 * DeepSeek 全家桶原始工具接口：网页搜索与网页抓取。
 *
 * - POST /v1/tools/search：按 query 搜索，返回结构化结果（DeepSeek 自研搜索）；
 * - POST /v1/tools/fetch：抓取单个网页，返回 Markdown 正文。
 *
 * 与「联网工具」（deepseek_web_search / deepseek_read_url）不同，这两个接口是
 * 我们主动调用、不经过模型，适合做参考文献核实这类确定性检索。
 * 计费：每 1000 次成功请求 5 元；Search QPS 100、Fetch QPS 25（账号级）。
 */
import { config } from './config';
import { DeepSeekError } from './deepseek';
import type { SearchHit } from '../src/core/paper/verify';

interface SearchApiResult {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  site_name?: string | null;
  date?: string | null;
}

interface SearchApiResponse {
  results?: SearchApiResult[];
}

export interface SearchOptions {
  count?: number;
  oriQuestion?: string;
  needContent?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function mapWebToolError(status: number, bodyText: string, action: string): DeepSeekError {
  let detail = bodyText.slice(0, 600);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // 保留原文
  }
  switch (status) {
    case 401:
      return new DeepSeekError('invalid-api-key', 'DeepSeek API Key 无效或未配置，无法使用联网工具。', status, false, detail);
    case 402:
      return new DeepSeekError('insufficient-balance', 'DeepSeek 账户余额不足，联网工具不可用。', status, false, detail);
    case 403:
      return new DeepSeekError('web-forbidden', `${action}被安全策略拒绝。`, status, false, detail);
    case 404:
      return new DeepSeekError('web-not-found', `${action}未能获取可用内容。`, status, false, detail);
    case 429:
      return new DeepSeekError('rate-limited', `${action}触发限流（Search 100 QPS / Fetch 25 QPS），请稍后重试。`, status, true, detail);
    default:
      return new DeepSeekError('web-error', `${action}失败（HTTP ${status}）。`, status, status >= 500, detail);
  }
}

/** 调用 DeepSeek Search API；失败抛出 DeepSeekError */
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  if (!config.apiKey) {
    throw new DeepSeekError('missing-api-key', '服务端未配置 DEEPSEEK_API_KEY，无法使用联网搜索。', 0, false);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query.slice(0, 128),
        count: Math.max(1, Math.min(50, options.count ?? 5)),
        ...(options.oriQuestion ? { ori_question: options.oriQuestion.slice(0, 128) } : {}),
        need_content: options.needContent === true,
      }),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError('network-error', `无法连接 DeepSeek 搜索接口：${message}`, 0, true);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw mapWebToolError(response.status, text, '联网搜索');
  }
  const data = (await response.json().catch(() => null)) as SearchApiResponse | null;
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((item) => ({
    url: typeof item.url === 'string' ? item.url : '',
    title: typeof item.title === 'string' ? item.title : '',
    snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
    summary: typeof item.summary === 'string' ? item.summary : undefined,
    siteName: typeof item.site_name === 'string' ? item.site_name : null,
    publishedAt: typeof item.date === 'string' ? item.date : null,
    rerankScore: typeof item.rerank_score === 'number' ? item.rerank_score : undefined,
  })).filter((hit) => hit.url && hit.title);
}

export interface FetchedPage {
  title: string;
  content: string;
}

/** 调用 DeepSeek Fetch API 抓取网页正文（Markdown） */
export async function fetchWebPage(url: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<FetchedPage> {
  if (!config.apiKey) {
    throw new DeepSeekError('missing-api-key', '服务端未配置 DEEPSEEK_API_KEY，无法使用网页抓取。', 0, false);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new DeepSeekError('bad-request', '只支持 http/https 链接。', 400, false);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/tools/fetch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError('network-error', `无法连接 DeepSeek 抓取接口：${message}`, 0, true);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw mapWebToolError(response.status, text, '网页抓取');
  }
  const data = (await response.json().catch(() => null)) as { title?: string; content?: string } | null;
  return {
    title: typeof data?.title === 'string' ? data.title : '',
    content: typeof data?.content === 'string' ? data.content : '',
  };
}
