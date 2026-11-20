/**
 * 服务端配置：读取 .env / 环境变量。API Key 只在服务端使用，绝不下发到浏览器。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelId, ThinkingLevel } from '../src/core/types';
import { APP_VERSION, DEFAULT_LIMITS } from '../src/core/protocol';
import { upsertEnvValue } from '../src/core/envFile';

// 安装版（打包后）由启动器设置 DOCPRO_ROOT 指向安装目录；源码运行时退回项目根目录。
export const PROJECT_ROOT = process.env.DOCPRO_ROOT
  ? resolve(process.env.DOCPRO_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 文档库根目录（在 loadDotEnv 之后赋值）：
 * - 安装版：%USERPROFILE%\Documents\DocPro（用户可见、可备份）
 * - 源码运行：项目下的 data/（已 gitignore）
 * - 显式 DOCPRO_DATA_DIR 优先
 */
export let DATA_DIR = '';

/** 极简 .env 解析（不引入 dotenv 依赖） */
function loadDotEnv(): void {
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

DATA_DIR = process.env.DOCPRO_DATA_DIR
  ? resolve(process.env.DOCPRO_DATA_DIR)
  : join(PROJECT_ROOT, 'data');

function pickModel(value: string | undefined): ModelId {
  return value === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash';
}

function pickThinking(value: string | undefined): ThinkingLevel {
  return value === 'low' || value === 'high' || value === 'max' ? value : 'off';
}

/** 运行时可变的 API Key（应用内配置后立即生效，无需重启） */
let runtimeApiKey = process.env.DEEPSEEK_API_KEY || '';

/** 运行时设置 API Key（只改内存；持久化由 saveApiKeyToEnvFile 负责） */
export function setRuntimeApiKey(key: string): void {
  runtimeApiKey = key.trim();
}

export const config = {
  version: APP_VERSION,
  port: Number(process.env.PORT || 4399),
  host: process.env.HOST || '127.0.0.1',
  isProduction: process.argv.includes('--prod') || process.env.NODE_ENV === 'production',
  get apiKey(): string {
    return runtimeApiKey;
  },
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  defaultModel: pickModel(process.env.DOCPRO_MODEL),
  defaultThinking: pickThinking(process.env.DOCPRO_THINKING),
  dataDir: DATA_DIR,
  /**
   * 论文助手模型路由（DeepSeek 全家桶分工）：
   * - revise：逐段修订，默认用推理更强的 V4 Pro；
   * - refs：参考文献格式重排，默认用低延迟的 Flash（省成本）。
   */
  paperModels: {
    revise: pickModel(process.env.DOCPRO_PAPER_MODEL || 'deepseek-v4-pro'),
    refs: pickModel(process.env.DOCPRO_PAPER_REFS_MODEL || 'deepseek-flash'),
  },
  /** 论文助手逐段修订的默认思考强度 */
  paperDefaultThinking: pickThinking(process.env.DOCPRO_PAPER_THINKING || 'low'),
  /** 单次请求总超时：不限制输出长度时，长文生成可能持续数分钟 */
  requestTimeoutMs: Number(process.env.DOCPRO_TIMEOUT_MS || 600_000),
  /** 上游首个字节超时 */
  connectTimeoutMs: Number(process.env.DOCPRO_CONNECT_TIMEOUT_MS || 30_000),
  /** docx 导入大小上限 */
  docxMaxBytes: Number(process.env.DOCPRO_MAX_DOCX_BYTES || 25 * 1024 * 1024),
  maxRepairs: 1,
  limits: {
    ...DEFAULT_LIMITS,
    maxSelectionChars: Number(process.env.DOCPRO_MAX_SELECTION || DEFAULT_LIMITS.maxSelectionChars),
    maxDocumentChars: Number(process.env.DOCPRO_MAX_DOCUMENT || DEFAULT_LIMITS.maxDocumentChars),
  },
} as const;

export function hasApiKey(): boolean {
  return !!runtimeApiKey && !runtimeApiKey.startsWith('sk-xxxxxxxx');
}

/**
 * 把 API Key 写回 .env（保留其他配置与注释；原子替换）。
 * 只更新 DEEPSEEK_API_KEY 一行；写失败返回错误信息，内存中的 key 仍会生效。
 */
export function saveApiKeyToEnvFile(key: string): { ok: boolean; envPath: string; error?: string } {
  const envPath = join(PROJECT_ROOT, '.env');
  try {
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const next = upsertEnvValue(existing, 'DEEPSEEK_API_KEY', key.trim());
    const tmp = `${envPath}.tmp`;
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, envPath);
    return { ok: true, envPath };
  } catch (err) {
    return { ok: false, envPath, error: err instanceof Error ? err.message : String(err) };
  }
}
