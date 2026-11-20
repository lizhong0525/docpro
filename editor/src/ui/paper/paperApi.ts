/**
 * 论文助手浏览器端 API 客户端。
 *
 * 结构分析（analyzePaper）在组件内本地执行；这里只封装需要 HTTP 的部分：
 * 逐段修订（SSE）、参考文献重排（JSON）、记忆读写。
 */
import { streamPaperRevise, type PaperStreamHandlers, type PaperStreamOutcome } from '../../core/paper/client';
import type { PaperMemory, PaperReviseProposal, PaperReviseRequest, RefFixResponse, RefVerifyResponse } from '../../core/paper/types';
import type { ModelId, ThinkingLevel } from '../../core/types';

export interface PaperMemoryKey {
  docId?: string;
  fingerprint?: string;
}

function queryFor(key: PaperMemoryKey): string {
  const parts: string[] = [];
  if (key.docId) parts.push(`docId=${encodeURIComponent(key.docId)}`);
  if (key.fingerprint) parts.push(`fingerprint=${encodeURIComponent(key.fingerprint)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function loadPaperMemory(key: PaperMemoryKey): Promise<PaperMemory | null> {
  try {
    const response = await fetch(`/api/paper/memory${queryFor(key)}`);
    if (!response.ok) return null;
    const parsed = (await response.json()) as { memory?: PaperMemory | null };
    return parsed.memory ?? null;
  } catch {
    return null;
  }
}

export async function savePaperMemory(key: PaperMemoryKey, memory: PaperMemory): Promise<boolean> {
  try {
    const response = await fetch('/api/paper/memory', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...key, memory }),
    });
    if (!response.ok) return false;
    const parsed = (await response.json()) as { ok?: boolean };
    return parsed.ok === true;
  } catch {
    return false;
  }
}

export function streamPaperReviseRequest(
  payload: PaperReviseRequest,
  handlers: PaperStreamHandlers,
  signal: AbortSignal,
): Promise<PaperStreamOutcome> {
  return streamPaperRevise('/api/paper/revise', payload, handlers, signal);
}

export async function refsFix(docText: string, docTitle: string, memory: PaperMemory, options: { model: ModelId; thinking: ThinkingLevel }): Promise<RefFixResponse> {
  const response = await fetch('/api/paper/refs/fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docText, docTitle, memory, options }),
  });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(parsed?.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as RefFixResponse;
}

/** 参考文献联网核实（DeepSeek Search API，确定性打分） */
export async function verifyRefs(docText: string, docTitle: string, maxRefs?: number): Promise<RefVerifyResponse> {
  const response = await fetch('/api/paper/refs/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docText, docTitle, maxRefs }),
  });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(parsed?.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as RefVerifyResponse;
}
