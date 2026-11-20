/**
 * 论文记忆（Paper Memory）持久化。
 *
 * - 文档库文档：记忆存在文档文件夹内（paper-memory.json），随文档一起备份/移动/删除；
 * - 非文档库文档（本地打开）：按文档指纹存到数据目录 paper-memory/<fp>.json。
 *
 * 记忆是可编辑的用户输入；服务端读写只做清洗（normalizeMemory），不修改语义。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config';
import { docFolder } from './docStore';
import { normalizeMemory } from '../src/core/paper/memory';
import type { PaperMemory } from '../src/core/paper/types';

const MEMORY_FILE = 'paper-memory.json';
const FINGERPRINT_RE = /^[a-f0-9]{8}$/;

export interface MemoryKey {
  /** 文档库文档 id（优先） */
  docId?: string;
  /** 无文档库时的文档指纹（fnv1a32） */
  fingerprint?: string;
}

function memoryDir(): string {
  return join(config.dataDir, 'paper-memory');
}

export function resolveMemoryPath(key: MemoryKey): string | null {
  if (key.docId) {
    try {
      const folder = docFolder(key.docId);
      if (!existsSync(folder)) return null;
      return join(folder, MEMORY_FILE);
    } catch {
      return null;
    }
  }
  if (key.fingerprint && FINGERPRINT_RE.test(key.fingerprint)) {
    return join(memoryDir(), `${key.fingerprint}.json`);
  }
  return null;
}

export function readPaperMemory(key: MemoryKey): PaperMemory | null {
  const path = resolveMemoryPath(key);
  if (!path || !existsSync(path)) return null;
  try {
    return normalizeMemory(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    console.error('[paper] 记忆文件损坏，忽略:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function writePaperMemory(key: MemoryKey, memory: unknown): { ok: boolean; memory: PaperMemory } {
  const normalized = normalizeMemory(memory);
  const path = resolveMemoryPath(key);
  if (!path) return { ok: false, memory: normalized };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
    renameSync(tmp, path);
    return { ok: true, memory: normalized };
  } catch (err) {
    console.error('[paper] 记忆写入失败:', err instanceof Error ? err.message : err);
    return { ok: false, memory: normalized };
  }
}

/** 客户端可用的记忆键（从查询/请求体中提取） */
export function memoryKeyFrom(input: { docId?: unknown; fingerprint?: unknown }): MemoryKey {
  const key: MemoryKey = {};
  if (typeof input.docId === 'string' && input.docId.trim()) key.docId = input.docId.trim();
  if (typeof input.fingerprint === 'string' && FINGERPRINT_RE.test(input.fingerprint)) key.fingerprint = input.fingerprint;
  return key;
}
