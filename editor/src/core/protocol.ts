/**
 * 客户端/服务端共享的协议辅助：SSE 编码、公开配置类型。
 */
import type { ModelId, ServerEvent, ThinkingLevel } from './types';

export function encodeSse(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function encodePing(): string {
  return ': ping\n\n';
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  description: string;
  contextWindow: number;
  maxOutput: number;
  supportsVision?: boolean;
  /** 是否支持 DeepSeek 联网工具（deepseek_web_search / deepseek_read_url） */
  supportsWebTools?: boolean;
}

export interface PublicConfig {
  /** 服务端是否已配置 API Key */
  hasApiKey: boolean;
  defaultModel: ModelId;
  defaultThinking: ThinkingLevel;
  models: ModelInfo[];
  /** 论文助手模型路由：逐段修订用强模型，参考文献格式重排用快模型 */
  paperModels: { revise: ModelId; refs: ModelId };
  paperDefaultThinking: ThinkingLevel;
  limits: {
    maxSelectionChars: number;
    maxDocumentChars: number;
    maxInstructionChars: number;
    maxContextChars: number;
    defaultContextChars: number;
    defaultMaxRewriteChars: number;
    /** docx 导入文件大小上限（字节） */
    maxDocxBytes: number;
  };
  version: string;
}

export const APP_VERSION = '0.6.1';

export const MODELS: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    description: '默认。低延迟、支持 1M 上下文与联网工具（搜索/读链接），适合编辑器内实时改写。',
    contextWindow: 1_048_576,
    maxOutput: 384 * 1024,
    supportsVision: true,
    supportsWebTools: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: '更强推理与更细的文字把握，速度较慢，适合长文与复杂修改（不支持联网工具）。',
    contextWindow: 1_048_576,
    maxOutput: 384 * 1024,
    supportsVision: false,
    supportsWebTools: false,
  },
];

export const DEFAULT_LIMITS: PublicConfig['limits'] = {
  maxSelectionChars: 200_000,
  maxDocumentChars: 400_000,
  maxInstructionChars: 4_000,
  maxContextChars: 4_000,
  defaultContextChars: 800,
  defaultMaxRewriteChars: 4_000,
  maxDocxBytes: 25 * 1024 * 1024,
};

export function publicConfig(
  hasApiKey: boolean,
  defaultModel: ModelId = 'deepseek-flash',
  paperModels: { revise: ModelId; refs: ModelId } = { revise: 'deepseek-v4-pro', refs: 'deepseek-flash' },
  paperDefaultThinking: ThinkingLevel = 'low',
): PublicConfig {
  return {
    hasApiKey,
    defaultModel,
    defaultThinking: 'off',
    models: MODELS,
    paperModels,
    paperDefaultThinking,
    limits: DEFAULT_LIMITS,
    version: APP_VERSION,
  };
}
