/**
 * DeepSeek Chat Completions 流式客户端（OpenAI 兼容格式）。
 *
 * 关键点：
 * - thinking 关闭时传 {"thinking":{"type":"disabled"}}，追求编辑器内的低延迟；
 *   需要更高质量时用 reasoning_effort = low/high/max。
 * - 流式返回 content 与 reasoning_content 两类增量，分别转发。
 * - 上游错误转换成可读的中文错误码，前端据此提示（余额不足 / Key 错误 / 限流等）。
 */
import { config } from './config';
import type { CitationRef, ModelId, ThinkingLevel, Usage, WebSource, WebToolCall } from '../src/core/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** DeepSeek 全家桶联网工具（仅 deepseek-flash 支持） */
export interface WebToolOptions {
  /** deepseek_web_search：联网搜索 / 深度思考搜索（思考开启时自动升级） */
  search?: boolean;
  /** deepseek_read_url：阅读用户消息中的链接 */
  readUrl?: boolean;
}

export interface StreamChatOptions {
  model: ModelId;
  messages: ChatMessage[];
  thinking: ThinkingLevel;
  signal: AbortSignal;
  /** 声明服务端联网工具；只有 deepseek-flash 生效 */
  webTools?: WebToolOptions;
}

const WEB_TOOL_MODEL: ModelId = 'deepseek-flash';

/** 该模型是否支持联网工具 */
export function supportsWebTools(model: ModelId): boolean {
  return model === WEB_TOOL_MODEL;
}

/** 构造 Chat Completions 请求体（导出以便单测断言「不发送输出限制」与工具声明） */
export function buildChatRequestBody(opts: Omit<StreamChatOptions, 'signal'>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    // 不发送 max_tokens：输出长度交给模型/服务端的默认上限，避免中途被截断
    stream_options: { include_usage: true },
  };
  if (opts.thinking === 'off') {
    body.thinking = { type: 'disabled' };
  } else {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = opts.thinking;
  }
  // 联网工具：服务端会自行搜索/抓取，客户端不执行任何工具调用
  const tools: Array<{ type: string }> = [];
  if (opts.webTools?.search) tools.push({ type: 'deepseek_web_search' });
  if (opts.webTools?.readUrl) tools.push({ type: 'deepseek_read_url' });
  if (tools.length > 0 && supportsWebTools(opts.model)) {
    body.tools = tools;
  }
  return body;
}

export interface WebEventPayload {
  type: 'call_started' | 'call_completed' | 'step_reasoning_done';
  call?: WebToolCall;
}

export interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  usage?: Usage;
  finishReason?: string | null;
  /** 流式过程中的联网工具事件（server_tool_event） */
  webEvent?: WebEventPayload;
  /** 最后一个 chunk 携带的完整联网调用记录（server_tool_calls 展平） */
  webCalls?: WebToolCall[];
  /** 最后一个 chunk 携带的引用标注（url_citation） */
  citations?: CitationRef[];
}

/** 把 DeepSeek 的 web_search_result 归一化为 WebSource */
export function toWebSource(input: unknown): WebSource | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (!url) return null;
  return {
    url,
    title: typeof raw.title === 'string' ? raw.title : url,
    snippet: typeof raw.snippet === 'string' ? raw.snippet : undefined,
    siteName: typeof raw.site_name === 'string' ? raw.site_name : null,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
  };
}

/** 把 Chat Completions 的一次工具调用（server_tool_calls[].calls[] 或 server_tool_event.call）归一化 */
export function toWebToolCall(input: unknown): WebToolCall | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const actionRaw = (raw.action ?? {}) as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind : raw.type === 'deepseek_read_url' ? 'read_link' : 'search';
  const action = typeof actionRaw.type === 'string' ? actionRaw.type : kind === 'read_link' ? 'read_link' : 'search';
  const sources = Array.isArray(raw.sources)
    ? (raw.sources.map(toWebSource).filter(Boolean) as WebSource[])
    : [];
  const page = (raw.page ?? {}) as Record<string, unknown>;
  const queries = Array.isArray(actionRaw.queries)
    ? actionRaw.queries.filter((q): q is string => typeof q === 'string')
    : undefined;
  const error = (raw.error ?? {}) as Record<string, unknown>;
  return {
    kind: kind as WebToolCall['kind'],
    action,
    queries: queries && queries.length > 0 ? queries : undefined,
    url: typeof actionRaw.url === 'string' ? actionRaw.url : typeof page.url === 'string' ? page.url : undefined,
    status: raw.status === 'failed' ? 'failed' : 'completed',
    sources,
    error: typeof error.code === 'string' ? error.code : undefined,
  };
}

/** 从 server_tool_calls 的「步」数组里展平所有调用 */
export function flattenServerToolCalls(steps: unknown): WebToolCall[] {
  if (!Array.isArray(steps)) return [];
  const calls: WebToolCall[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const stepCalls = (step as Record<string, unknown>).calls;
    if (!Array.isArray(stepCalls)) continue;
    for (const call of stepCalls) {
      const converted = toWebToolCall(call);
      if (converted) calls.push(converted);
    }
  }
  return calls;
}

/** 从 url_citation 注解数组里归一化引用 */
export function toCitations(annotations: unknown): CitationRef[] {
  if (!Array.isArray(annotations)) return [];
  const citations: CitationRef[] = [];
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== 'object') continue;
    const raw = annotation as Record<string, unknown>;
    const payload = (raw.url_citation ?? {}) as Record<string, unknown>;
    const url = typeof payload.url === 'string' ? payload.url : '';
    if (!url) continue;
    citations.push({
      url,
      title: typeof payload.title === 'string' ? payload.title : url,
      startIndex: typeof payload.start_index === 'number' ? payload.start_index : 0,
      endIndex: typeof payload.end_index === 'number' ? payload.end_index : 0,
    });
  }
  return citations;
}

export class DeepSeekError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  detail?: string;

  constructor(code: string, message: string, status = 0, retryable = false, detail?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function mapHttpError(status: number, bodyText: string): DeepSeekError {
  let detail = bodyText.slice(0, 800);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; type?: string; code?: string } | string };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // preserve raw text
  }
  switch (status) {
    case 401:
      return new DeepSeekError('invalid-api-key', 'DeepSeek API Key 无效或未配置，请检查 .env 中的 DEEPSEEK_API_KEY。', status, false, detail);
    case 402:
      return new DeepSeekError('insufficient-balance', 'DeepSeek 账户余额不足，请充值后重试。', status, false, detail);
    case 422:
    case 400:
      return new DeepSeekError('bad-request', '请求参数被 DeepSeek 拒绝，请稍后重试。', status, false, detail);
    case 429:
      return new DeepSeekError('rate-limited', 'DeepSeek 接口限流，请稍后重试。', status, true, detail);
    default:
      return new DeepSeekError('upstream-error', `DeepSeek 服务异常（HTTP ${status}），请稍后重试。`, status, status >= 500, detail);
  }
}

/** 逐块产出模型输出；调用方负责解析与校验 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatStreamChunk, void, unknown> {
  if (!config.apiKey) {
    throw new DeepSeekError('missing-api-key', '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中填写。', 0, false);
  }
  const body = buildChatRequestBody({ model: opts.model, messages: opts.messages, thinking: opts.thinking, webTools: opts.webTools });

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError('network-error', `无法连接 DeepSeek 接口：${message}`, 0, true);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw mapHttpError(response.status, text);
  }
  if (!response.body) throw new DeepSeekError('no-body', 'DeepSeek 返回了空响应', response.status, true);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: Usage | undefined;
  for (;;) {
    let read: { done: boolean; value?: Uint8Array };
    try {
      read = await reader.read();
    } catch (err) {
      if (opts.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      throw new DeepSeekError('stream-error', `DeepSeek 数据流中断：${message}`, 0, true);
    }
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              server_tool_calls?: unknown;
              annotations?: unknown;
            };
            server_tool_event?: { type?: string; call?: unknown };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
            server_tool_use?: { tool_search?: number; tool_fetch?: number; tool_image_search?: number };
          } | null;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        const contentDelta = choice?.delta?.content ?? undefined;
        const reasoningDelta = choice?.delta?.reasoning_content ?? undefined;
        if (parsed.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
            promptCacheHitTokens: parsed.usage.prompt_cache_hit_tokens,
            promptCacheMissTokens: parsed.usage.prompt_cache_miss_tokens,
            reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
            webSearchRequests: parsed.usage.server_tool_use?.tool_search,
            webFetchRequests: parsed.usage.server_tool_use?.tool_fetch,
            webImageSearches: parsed.usage.server_tool_use?.tool_image_search,
          };
        }
        // 联网工具事件：call_started / call_completed
        let webEvent: WebEventPayload | undefined;
        const rawEvent = choice?.server_tool_event as { type?: string; call?: unknown } | undefined;
        if (rawEvent && typeof rawEvent.type === 'string') {
          if (rawEvent.type === 'call_started' || rawEvent.type === 'call_completed') {
            const call = toWebToolCall(rawEvent.call);
            if (call) webEvent = { type: rawEvent.type, call };
          }
        }
        // 最后一个 chunk 携带完整 server_tool_calls / annotations
        const webCalls = choice?.delta?.server_tool_calls ? flattenServerToolCalls(choice.delta.server_tool_calls) : undefined;
        const citations = choice?.delta?.annotations ? toCitations(choice.delta.annotations) : undefined;
        if (contentDelta || reasoningDelta || choice?.finish_reason || webEvent || webCalls?.length || citations?.length) {
          yield {
            contentDelta: contentDelta ?? undefined,
            reasoningDelta: reasoningDelta ?? undefined,
            usage,
            finishReason: choice?.finish_reason ?? null,
            webEvent,
            webCalls,
            citations,
          };
        }
      }
    }
  }
}
