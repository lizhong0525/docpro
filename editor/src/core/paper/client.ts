/**
 * 论文助手 SSE 客户端（浏览器用；服务端不依赖）。
 *
 * 与 core/client.ts 的编辑客户端同构：解析 `data:` 行、按事件类型分发、
 * 支持 AbortSignal 中止、在收到 proposal/error 后结束。
 */
import type { PaperServerEvent, PaperReviseProposal, PaperWarning } from './types';
import type { Timings, Usage } from '../types';

export interface PaperStreamHandlers {
  onStatus?: (event: Extract<PaperServerEvent, { type: 'status' }>) => void;
  onReasoning?: (delta: string) => void;
  onDelta?: (text: string) => void;
  onMeta?: (event: Extract<PaperServerEvent, { type: 'meta' }>) => void;
  /** 联网工具执行了一步（搜索/阅读链接） */
  onWeb?: (call: Extract<PaperServerEvent, { type: 'web' }>['call']) => void;
  /** 回答中的引用标注 */
  onCitation?: (citation: Extract<PaperServerEvent, { type: 'citation' }>['citation']) => void;
  onDone?: (info: { requestId: string; usage: Usage; timings: Timings }) => void;
}

export interface PaperStreamOutcome {
  ok: boolean;
  proposal: PaperReviseProposal | null;
  warnings: PaperWarning[];
  error: { code: string; message: string; detail?: string; retryable: boolean } | null;
  usage: Usage | null;
  timings: Timings | null;
}

const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** POST + SSE 流式读取；返回聚合结果 */
export async function streamPaperRevise(
  url: string,
  body: unknown,
  handlers: PaperStreamHandlers,
  signal: AbortSignal,
): Promise<PaperStreamOutcome> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    let message = `服务返回 HTTP ${response.status}`;
    let code = 'http-error';
    try {
      const parsed = (await response.json()) as { code?: string; error?: string };
      if (parsed.code) code = parsed.code;
      if (parsed.error) message = parsed.error;
    } catch {
      // 保持默认错误
    }
    return {
      ok: false,
      proposal: null,
      warnings: [],
      error: { code, message, retryable: response.status >= 500 || response.status === 429 },
      usage: null,
      timings: null,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let proposal: PaperReviseProposal | null = null;
  let warnings: PaperWarning[] = [];
  let error: PaperStreamOutcome['error'] = null;
  let usage: Usage | null = null;
  let timings: Timings | null = null;

  const handleEvent = (event: PaperServerEvent) => {
    switch (event.type) {
      case 'meta':
        handlers.onMeta?.(event);
        break;
      case 'status':
        handlers.onStatus?.(event);
        break;
      case 'reasoning':
        handlers.onReasoning?.(event.delta);
        break;
      case 'delta':
        handlers.onDelta?.(event.text);
        break;
      case 'web':
        handlers.onWeb?.(event.call);
        break;
      case 'citation':
        handlers.onCitation?.(event.citation);
        break;
      case 'proposal':
        proposal = event.proposal;
        warnings = event.proposal.warnings;
        break;
      case 'error':
        error = { code: event.code, message: event.message, detail: event.detail, retryable: event.retryable };
        break;
      case 'done':
        usage = event.usage;
        timings = event.timings;
        handlers.onDone?.({ requestId: event.requestId, usage: event.usage, timings: event.timings });
        break;
    }
  };

  for (;;) {
    if (signal.aborted) {
      return { ok: false, proposal: null, warnings, error: { code: 'aborted', message: '已取消本次生成。', retryable: false }, usage, timings };
    }
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          handleEvent(JSON.parse(data) as PaperServerEvent);
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  }

  return {
    ok: error === null && proposal !== null,
    proposal,
    warnings,
    error,
    usage: usage ?? EMPTY_USAGE,
    timings,
  };
}
