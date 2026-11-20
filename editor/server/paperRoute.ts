/**
 * 论文助手 API。
 *
 * - POST /api/paper/revise      逐段修订（SSE）：快照校验 → 提示词（记忆注入）→ DeepSeek
 *                               → 输出清洗 + 引文保护校验 → 失败自动修复一次 → 提案
 *                               options.webSearch=true 时声明 DeepSeek 联网工具（搜索/读链接）
 * - POST /api/paper/refs/fix    参考文献格式重排（一次性 JSON，走快模型）
 * - POST /api/paper/refs/verify 参考文献联网核实（调用 Search API，确定性打分）
 * - GET  /api/paper/memory      读取论文记忆（文档库文件夹 或 指纹存储）
 * - PUT  /api/paper/memory      保存论文记忆
 *
 * 结构解析、参考文献完整性检查、AI 痕迹扫描都在浏览器本地执行（analyzePaper），
 * 服务端只承担需要模型与联网的部分。
 */
import type { Request, Response } from 'express';
import { config, hasApiKey } from './config';
import { DeepSeekError, streamChat, type ChatMessage } from './deepseek';
import { searchWeb } from './webTools';
import { memoryKeyFrom, readPaperMemory, writePaperMemory } from './paperStore';
import { analyzePaper } from '../src/core/paper/analyze';
import { validatePaperOutput, type PaperOutputContext } from '../src/core/paper/apply';
import { buildPaperRepairMessage, buildPaperSystemPrompt, buildPaperUserPrompt, buildRefsFixSystemPrompt, buildRefsFixUserPrompt } from '../src/core/paper/prompts';
import { normalizeMemory } from '../src/core/paper/memory';
import { buildReferenceQuery, unverifiedReference, verifyReference, type SearchHit } from '../src/core/paper/verify';
import { fnv1a32 } from '../src/core/selection';
import type {
  PaperReviseProposal,
  PaperReviseRequest,
  PaperServerEvent,
  PaperWarning,
  RefFixEntry,
  RefFixResponse,
  RefVerifyEntry,
  RefVerifyResponse,
} from '../src/core/paper/types';
import type { CitationRef, ModelId, ThinkingLevel, Timings, Usage, WebToolCall } from '../src/core/types';

const VALID_MODELS: ModelId[] = ['deepseek-flash', 'deepseek-v4-pro'];
const VALID_THINKING: ThinkingLevel[] = ['off', 'low', 'high', 'max'];
/** 联网工具仅 deepseek-flash 支持 */
const WEB_TOOL_MODEL: ModelId = 'deepseek-flash';
/** 单次联网核实的条数上限（Search 计费 5 元/千次，默认最多 20 条 ≈ 0.1 元） */
const MAX_VERIFY_REFS = 20;

function sse(res: Response, event: PaperServerEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

interface MergeUsage extends Usage {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

function mergeUsage(target: Usage, next: Usage | undefined): void {
  if (!next) return;
  target.promptTokens += next.promptTokens;
  target.completionTokens += next.completionTokens;
  target.totalTokens += next.totalTokens;
  (target as MergeUsage).promptCacheHitTokens = ((target as MergeUsage).promptCacheHitTokens ?? 0) + (next.promptCacheHitTokens ?? 0);
  (target as MergeUsage).promptCacheMissTokens = ((target as MergeUsage).promptCacheMissTokens ?? 0) + (next.promptCacheMissTokens ?? 0);
  if (next.reasoningTokens) target.reasoningTokens = (target.reasoningTokens ?? 0) + next.reasoningTokens;
  if (next.webSearchRequests) target.webSearchRequests = (target.webSearchRequests ?? 0) + next.webSearchRequests;
  if (next.webFetchRequests) target.webFetchRequests = (target.webFetchRequests ?? 0) + next.webFetchRequests;
  if (next.webImageSearches) target.webImageSearches = (target.webImageSearches ?? 0) + next.webImageSearches;
}

function pickModel(value: unknown, fallback: ModelId): ModelId {
  return VALID_MODELS.includes(value as ModelId) ? (value as ModelId) : fallback;
}

function pickThinking(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return VALID_THINKING.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : fallback;
}

/** 校验逐段修订请求；返回可执行请求或错误 */
export function validatePaperReviseRequest(body: unknown): { request?: PaperReviseRequest; error?: { status: number; code: string; message: string } } {
  if (!body || typeof body !== 'object') return { error: { status: 400, code: 'bad-request', message: '请求体必须是 JSON 对象' } };
  const b = body as Partial<PaperReviseRequest>;
  if (typeof b.requestId !== 'string' || !b.requestId) return { error: { status: 400, code: 'bad-request', message: '缺少 requestId' } };
  if (typeof b.docText !== 'string') return { error: { status: 400, code: 'bad-request', message: '缺少 docText' } };
  if (b.docText.length > config.limits.maxDocumentChars) {
    return { error: { status: 413, code: 'document-too-large', message: `文档超过上限（${config.limits.maxDocumentChars} 字符）` } };
  }
  if (typeof b.paragraphId !== 'string' || typeof b.from !== 'number' || typeof b.to !== 'number') {
    return { error: { status: 400, code: 'bad-request', message: '缺少段落定位信息（paragraphId/from/to）' } };
  }
  if (!(b.from >= 0 && b.to > b.from && b.to <= b.docText.length)) {
    return { error: { status: 400, code: 'bad-request', message: '段落范围越界' } };
  }
  const slice = b.docText.slice(b.from, b.to);
  if (typeof b.oldText !== 'string' || typeof b.hash !== 'string') {
    return { error: { status: 400, code: 'bad-request', message: '缺少段落快照（oldText/hash）' } };
  }
  if (b.oldText !== slice || fnv1a32(b.oldText) !== b.hash) {
    return { error: { status: 409, code: 'stale-paragraph', message: '段落快照与当前文档不一致，请重新分析文档后再试。' } };
  }

  const memory = normalizeMemory(b.memory);
  const options = (b.options ?? {}) as PaperReviseRequest['options'];
  // 联网工具仅 deepseek-flash 支持：勾选联网时自动切到 flash
  const webSearch = options?.webSearch === true;
  const model = webSearch ? WEB_TOOL_MODEL : pickModel(options?.model, config.paperModels.revise);
  const request: PaperReviseRequest = {
    requestId: b.requestId,
    docTitle: typeof b.docTitle === 'string' ? b.docTitle.slice(0, 200) : '',
    docText: b.docText,
    paragraphId: b.paragraphId,
    from: b.from,
    to: b.to,
    oldText: b.oldText,
    hash: b.hash,
    instruction: typeof b.instruction === 'string' ? b.instruction.trim().slice(0, config.limits.maxInstructionChars) : '',
    memory,
    options: {
      model,
      thinking: pickThinking(options?.thinking, config.paperDefaultThinking),
      webSearch,
    },
  };
  return { request };
}

/** 聚合一次完整 Chat 响应（非流式使用场景） */
async function collectChat(
  model: ModelId,
  messages: ChatMessage[],
  thinking: ThinkingLevel,
  signal: AbortSignal,
): Promise<{ content: string; usage: Usage; finishReason: string | null }> {
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let content = '';
  let finishReason: string | null = null;
  for await (const chunk of streamChat({ model, messages, thinking, signal })) {
    if (chunk.usage) mergeUsage(usage, chunk.usage);
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.contentDelta) content += chunk.contentDelta;
  }
  return { content, usage, finishReason };
}

/**
 * POST /api/paper/revise —— 逐段修订（SSE）。
 * 输出事件：meta → status(connecting/thinking/streaming/validating/repairing/done)
 *           → reasoning/delta → proposal | error → done
 */
export async function handlePaperRevise(req: Request, res: Response): Promise<void> {
  if (!hasApiKey()) {
    res.status(503).json({ code: 'missing-api-key', error: '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中填写后重启服务。' });
    return;
  }
  const { request, error } = validatePaperReviseRequest(req.body);
  if (error || !request) {
    res.status(error?.status ?? 400).json({ code: error?.code ?? 'bad-request', error: error?.message ?? '请求无效' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const abortController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = AbortSignal.any([abortController.signal, timeoutSignal]);
  let closed = false;
  const onClose = () => {
    closed = true;
    abortController.abort();
  };
  res.on('close', onClose);

  let terminalSent = false;
  const send = (event: PaperServerEvent) => {
    if (closed || res.writableEnded) return;
    if (event.type === 'proposal' || event.type === 'error' || event.type === 'done') terminalSent = true;
    try {
      sse(res, event);
    } catch {
      closed = true;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try {
      res.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, 15_000);

  const startedAt = Date.now();
  const timings: Timings = { startedAt, attempts: 0, repairs: 0 };
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    // 重新分析文档（确定性、本地）：校验段落确实存在且不在参考文献章节。
    // 优先按偏移匹配（容忍结尾换行差），段落 id 作为兜底。
    const analysis = analyzePaper(request.docText, { referenceFormat: request.memory.referenceFormat });
    const paragraph =
      analysis.paragraphs.find(
        (p) => p.from === request.from && (p.to === request.to || p.to - request.to === 1 || p.to - request.to === 2),
      ) ?? analysis.paragraphs.find((p) => p.id === request.paragraphId);
    if (!paragraph) {
      send({ type: 'error', code: 'paragraph-not-found', message: '找不到该段落，文档可能已变化，请重新分析。', retryable: false });
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }
    if (paragraph.kind === 'references' || (analysis.references.sectionRange && request.from >= analysis.references.sectionRange.from && request.from < analysis.references.sectionRange.to)) {
      send({ type: 'error', code: 'paragraph-is-reference', message: '该段落在参考文献章节内，请使用「参考文献」标签页管理。', retryable: false });
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }

    const paragraphIndex = analysis.paragraphs.indexOf(paragraph);
    const previous = analysis.paragraphs[paragraphIndex - 1];
    const next = analysis.paragraphs[paragraphIndex + 1];
    const previousSnippet = previous && previous.kind !== 'heading' ? previous.plainText.slice(0, 120) : null;
    const nextSnippet = next && next.kind !== 'heading' ? next.plainText.slice(0, 120) : null;

    const systemPrompt = buildPaperSystemPrompt(request.memory);
    const userPrompt =
      buildPaperUserPrompt(request.docTitle, paragraph, request.instruction, previousSnippet, nextSnippet) +
      (request.options.webSearch ? '\n\n（已开启联网搜索：涉及事实、数据、文献时可联网核实后再改写，并优先引用权威来源。）' : '');
    const baseMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    let messages = baseMessages;
    let previousRaw = '';

    const refIndexes = new Set(analysis.references.entries.map((entry) => entry.index));
    const outputContext: PaperOutputContext = {
      oldText: request.oldText,
      refIndexes,
      neighborBefore: previousSnippet ?? '',
      neighborAfter: nextSnippet ?? '',
    };

    send({ type: 'meta', requestId: request.requestId, paragraphId: paragraph.id, model: request.options.model, startedAt });

    // 联网工具（仅 flash）：声明 deepseek_web_search（思考开启时自动升级为深度思考搜索）+ deepseek_read_url
    const webTools = request.options.webSearch ? { search: true, readUrl: true } : undefined;
    const webCalls: WebToolCall[] = [];
    const citations: CitationRef[] = [];

    const maxAttempts = 1 + config.maxRepairs;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal.aborted) return;
      timings.attempts = attempt + 1;
      let firstContentSeen = false;
      let finishReason: string | null = null;
      let content = '';
      send({ type: 'status', phase: attempt === 0 ? 'connecting' : 'repairing', note: attempt === 0 ? undefined : '正在根据校验结果修复输出…', attempt: attempt + 1 });

      try {
        for await (const chunk of streamChat({
          model: request.options.model,
          messages,
          thinking: request.options.thinking,
          signal,
          webTools,
        })) {
          if (signal.aborted) return;
          if (chunk.usage) mergeUsage(usage, chunk.usage);
          if (chunk.finishReason) finishReason = chunk.finishReason;
          if (chunk.reasoningDelta) send({ type: 'reasoning', delta: chunk.reasoningDelta });
          // 联网进度与来源：实时转发给前端
          if (chunk.webEvent?.call) {
            if (chunk.webEvent.type === 'call_completed') {
              webCalls.push(chunk.webEvent.call);
              send({ type: 'web', call: chunk.webEvent.call });
            } else {
              send({
                type: 'status',
                phase: 'streaming',
                note: chunk.webEvent.call.kind === 'read_link' ? '正在阅读链接…' : '正在联网搜索…',
                attempt: attempt + 1,
              });
            }
          }
          if (chunk.webCalls && chunk.webCalls.length > 0) {
            webCalls.splice(0, webCalls.length, ...chunk.webCalls);
            for (const call of chunk.webCalls) {
              if (call.sources.length > 0) send({ type: 'web', call });
            }
          }
          if (chunk.citations && chunk.citations.length > 0) {
            citations.splice(0, citations.length, ...chunk.citations);
            for (const citation of chunk.citations) send({ type: 'citation', citation });
          }
          if (chunk.contentDelta) {
            if (!firstContentSeen) {
              firstContentSeen = true;
              timings.firstContentMs = Date.now() - startedAt;
              send({ type: 'status', phase: 'streaming', attempt: attempt + 1 });
            }
            content += chunk.contentDelta;
            send({ type: 'delta', text: chunk.contentDelta });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        const deepseekError = err instanceof DeepSeekError ? err : null;
        send({
          type: 'error',
          code: deepseekError?.code ?? 'upstream-error',
          message: deepseekError?.message ?? (err instanceof Error ? err.message : String(err)),
          detail: deepseekError?.detail,
          retryable: deepseekError?.retryable ?? true,
        });
        timings.finishedAt = Date.now();
        timings.totalMs = timings.finishedAt - startedAt;
        send({ type: 'done', requestId: request.requestId, usage, timings });
        return;
      }

      if (finishReason === 'content_filter' || finishReason === 'insufficient_system_resource') {
        send({
          type: 'error',
          code: finishReason,
          message: finishReason === 'content_filter' ? '模型因内容安全策略停止输出，请调整内容后重试。' : '模型资源不足，本次输出不完整，请重试。',
          retryable: finishReason === 'insufficient_system_resource',
        });
        timings.finishedAt = Date.now();
        timings.totalMs = timings.finishedAt - startedAt;
        send({ type: 'done', requestId: request.requestId, usage, timings });
        return;
      }

      if (!content.trim()) {
        send({ type: 'error', code: 'empty-completion', message: '模型没有返回任何内容，请重试。', retryable: true });
        timings.finishedAt = Date.now();
        timings.totalMs = timings.finishedAt - startedAt;
        send({ type: 'done', requestId: request.requestId, usage, timings });
        return;
      }

      send({ type: 'status', phase: 'validating' });
      previousRaw = content;
      const validation = validatePaperOutput(content, outputContext);

      if (validation.errors.length === 0) {
        const warnings: PaperWarning[] = [...validation.warnings];
        if (attempt > 0) {
          warnings.push({ code: 'repair-applied', severity: 'info', message: '首次输出未通过校验，已根据校验结果自动修复一次。' });
        }
        if (finishReason === 'length') {
          warnings.push({ code: 'truncated', severity: 'error', message: '模型输出因长度限制被截断，修订内容可能不完整，请核对后再接受。' });
        }
        const proposal: PaperReviseProposal = {
          requestId: request.requestId,
          paragraphId: paragraph.id,
          from: request.from,
          to: request.to,
          oldText: request.oldText,
          newText: validation.text,
          warnings,
          truncated: finishReason === 'length',
          usage,
          timings,
          ...(webCalls.length > 0 ? { webCalls } : {}),
          ...(citations.length > 0 ? { citations } : {}),
          raw: content.slice(0, 20_000),
        };
        send({ type: 'proposal', proposal });
        send({ type: 'status', phase: 'done' });
        send({ type: 'done', requestId: request.requestId, usage, timings });
        return;
      }

      // 校验失败：还有机会则带原因重试一次
      if (attempt + 1 < maxAttempts) {
        const reason = validation.errors[0];
        console.log(`[paper] ${request.requestId} 段落修订第 ${attempt + 1} 次输出未通过校验：${reason.slice(0, 300).replace(/\n/g, ' | ')}`);
        timings.repairs++;
        messages = [
          ...baseMessages,
          { role: 'assistant', content: previousRaw.slice(0, 32_000) },
          { role: 'user', content: buildPaperRepairMessage(reason) },
        ];
        send({ type: 'status', phase: 'repairing', note: '输出未通过引文保护校验，正在自动修复…', attempt: attempt + 2 });
        continue;
      }

      send({
        type: 'error',
        code: 'paper-apply-failed',
        message: validation.errors[0],
        retryable: true,
      });
      timings.finishedAt = Date.now();
      timings.totalMs = timings.finishedAt - startedAt;
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }
  } catch (err) {
    if (!signal.aborted) {
      console.error('[paper] revise 异常:', err);
      const deepseekError = err instanceof DeepSeekError ? err : null;
      send({
        type: 'error',
        code: deepseekError?.code ?? 'internal-error',
        message: deepseekError?.message ?? (err instanceof Error ? err.message : String(err)),
        detail: deepseekError?.detail,
        retryable: deepseekError?.retryable ?? true,
      });
    }
  } finally {
    clearInterval(heartbeat);
    const elapsed = Date.now() - startedAt;
    if (request) {
      console.log(
        `[paper] ${request.requestId} paragraph=${request.paragraphId} model=${request.options.model} ` +
          `attempts=${timings.attempts} repairs=${timings.repairs} tokens=${usage.totalTokens} time=${elapsed}ms`,
      );
    }
    res.off('close', onClose);
    if (!terminalSent && !closed && timeoutSignal.aborted) {
      send({ type: 'error', code: 'timeout', message: `本次生成超时（${Math.round(config.requestTimeoutMs / 1000)} 秒），请重试。`, retryable: true });
      send({ type: 'done', requestId: request?.requestId ?? '', usage, timings });
    }
    if (!res.writableEnded) res.end();
  }
}

/** 解析参考文献重排输出：每行 `[n] 文本` */
function parseRefFixOutput(content: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const rawLine of content.split('\n')) {
    const match = /^\s*\[(\d{1,3})\]\s*([\s\S]*)$/.exec(rawLine);
    if (!match) continue;
    const index = Number(match[1]);
    const text = match[2].trim();
    if (text && !result.has(index)) result.set(index, text);
  }
  return result;
}

/** POST /api/paper/refs/fix —— 参考文献格式重排（JSON） */
export async function handlePaperRefsFix(req: Request, res: Response): Promise<void> {
  if (!hasApiKey()) {
    res.status(503).json({ code: 'missing-api-key', error: '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中填写后重启服务。' });
    return;
  }
  const body = (req.body ?? {}) as { docTitle?: unknown; docText?: unknown; memory?: unknown; options?: { model?: unknown; thinking?: unknown } };
  if (typeof body.docText !== 'string') {
    res.status(400).json({ code: 'bad-request', error: '缺少 docText' });
    return;
  }
  if (body.docText.length > config.limits.maxDocumentChars) {
    res.status(413).json({ code: 'document-too-large', error: `文档超过上限（${config.limits.maxDocumentChars} 字符）` });
    return;
  }
  const memory = normalizeMemory(body.memory);
  const model = pickModel(body.options?.model, config.paperModels.refs);
  const thinking = pickThinking(body.options?.thinking, 'off');
  const docTitle = typeof body.docTitle === 'string' ? body.docTitle.slice(0, 200) : '';

  const analysis = analyzePaper(body.docText, { referenceFormat: memory.referenceFormat });
  const entries = analysis.references.entries;

  if (entries.length === 0) {
    res.json({
      ok: true,
      entries: [] as RefFixEntry[],
      warnings: [{ code: 'other', severity: 'info', message: '没有找到参考文献条目（需要一个标题含「参考文献」的章节）。' }],
      model,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } satisfies RefFixResponse);
    return;
  }

  const systemPrompt = buildRefsFixSystemPrompt(memory);
  const userPrompt = buildRefsFixUserPrompt(docTitle, entries.map((entry) => ({ index: entry.index, text: entry.text })));
  const abortController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = AbortSignal.any([abortController.signal, timeoutSignal]);

  try {
    const { content, usage, finishReason } = await collectChat(
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      thinking,
      signal,
    );

    const parsed = parseRefFixOutput(content);
    const warnings: PaperWarning[] = [];
    if (finishReason === 'length') {
      warnings.push({ code: 'truncated', severity: 'error', message: '模型输出被截断，部分条目可能未完成重排，请核对。' });
    }
    const resultEntries: RefFixEntry[] = entries.map((entry) => {
      const newText = parsed.get(entry.index);
      if (newText === undefined) {
        warnings.push({ code: 'other', severity: 'warn', message: `模型没有返回第 [${entry.index}] 条，已保留原文。` });
        return { index: entry.index, oldText: entry.text, newText: entry.text, changed: false };
      }
      return { index: entry.index, oldText: entry.text, newText, changed: newText !== entry.text };
    });
    for (const index of parsed.keys()) {
      if (!entries.some((entry) => entry.index === index)) {
        warnings.push({ code: 'other', severity: 'warn', message: `模型多输出了不存在的第 [${index}] 条，已忽略。` });
      }
    }

    const response: RefFixResponse = { ok: true, entries: resultEntries, warnings, model, usage };
    res.json(response);
  } catch (err) {
    const deepseekError = err instanceof DeepSeekError ? err : null;
    res.status(deepseekError ? 502 : 500).json({
      code: deepseekError?.code ?? 'internal-error',
      error: deepseekError?.message ?? (err instanceof Error ? err.message : '参考文献重排失败，请重试。'),
      retryable: deepseekError?.retryable ?? true,
    });
  }
}

/** GET /api/paper/memory */
export function handlePaperMemoryGet(req: Request, res: Response): void {
  const key = memoryKeyFrom({ docId: req.query.docId, fingerprint: req.query.fingerprint });
  const memory = readPaperMemory(key);
  res.json({ memory });
}

/** PUT /api/paper/memory */
export function handlePaperMemoryPut(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { docId?: unknown; fingerprint?: unknown; memory?: unknown };
  const key = memoryKeyFrom({ docId: body.docId, fingerprint: body.fingerprint });
  if (!key.docId && !key.fingerprint) {
    res.status(400).json({ code: 'bad-request', error: '缺少 docId 或 fingerprint，无法定位记忆存储。' });
    return;
  }
  const { ok, memory } = writePaperMemory(key, body.memory);
  res.json({ ok, memory });
}

/* ------------------------- 参考文献联网核实（Search API） ------------------------- */

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; hits: SearchHit[] }>();

/**
 * POST /api/paper/refs/verify
 * 对文末参考文献逐条调用 DeepSeek Search API，按标题相似度给出 found / suspicious / unverified。
 * 单次最多核实 MAX_VERIFY_REFS 条（默认 20，Search 计费 5 元/千次），带 10 分钟内存缓存去重。
 */
export async function handlePaperRefsVerify(req: Request, res: Response): Promise<void> {
  if (!hasApiKey()) {
    res.status(503).json({ code: 'missing-api-key', error: '服务端未配置 DEEPSEEK_API_KEY，无法使用联网核实。' });
    return;
  }
  const body = (req.body ?? {}) as { docTitle?: unknown; docText?: unknown; maxRefs?: unknown };
  if (typeof body.docText !== 'string') {
    res.status(400).json({ code: 'bad-request', error: '缺少 docText' });
    return;
  }
  if (body.docText.length > config.limits.maxDocumentChars) {
    res.status(413).json({ code: 'document-too-large', error: `文档超过上限（${config.limits.maxDocumentChars} 字符）` });
    return;
  }
  const docTitle = typeof body.docTitle === 'string' ? body.docTitle.slice(0, 200) : '';
  const analysis = analyzePaper(body.docText);
  const entries = analysis.references.entries;
  if (entries.length === 0) {
    res.json({ ok: true, entries: [], searched: 0 } satisfies RefVerifyResponse);
    return;
  }
  const requested = typeof body.maxRefs === 'number' ? body.maxRefs : MAX_VERIFY_REFS;
  const limit = Math.max(1, Math.min(MAX_VERIFY_REFS, Math.floor(requested)));
  const targets = entries.slice(0, limit);

  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  const results: RefVerifyEntry[] = [];
  let searched = 0;
  for (const entry of targets) {
    if (abortController.signal.aborted) break;
    const query = buildReferenceQuery(entry);
    if (!query) {
      results.push(unverifiedReference(entry, '', '条目无法生成检索词（标题信息不足）'));
      continue;
    }
    const cached = searchCache.get(query);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      results.push(verifyReference(entry, cached.hits));
      continue;
    }
    try {
      const hits = await searchWeb(query, {
        count: 5,
        oriQuestion: docTitle || undefined,
        signal: abortController.signal,
        timeoutMs: 12_000,
      });
      searched += 1;
      searchCache.set(query, { at: Date.now(), hits });
      results.push(verifyReference(entry, hits));
    } catch (err) {
      if (abortController.signal.aborted) break;
      const message = err instanceof Error ? err.message : String(err);
      results.push(unverifiedReference(entry, query, `搜索失败：${message}`));
      // 鉴权/余额这类不可恢复错误直接停止，避免继续烧请求
      if (err instanceof DeepSeekError && (err.code === 'invalid-api-key' || err.code === 'insufficient-balance')) break;
    }
  }

  console.log(`[paper] refs-verify ${docTitle ? `「${docTitle}」` : ''} 核实 ${results.length} 条，搜索 ${searched} 次`);
  res.json({ ok: true, entries: results, searched } satisfies RefVerifyResponse);
}
