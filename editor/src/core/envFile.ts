/**
 * .env 文件的行级编辑（纯函数，可单测）。
 *
 * 用于「应用内配置 API Key」：只更新 DEEPSEEK_API_KEY 一行，保留文件里其他
 * 配置与注释；不存在该行时追加到末尾。
 */
export function upsertEnvValue(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(name)}\\s*=.*$`, 'm');
  if (pattern.test(text)) {
    return text.replace(pattern, line);
  }
  const base = text.replace(/\s+$/, '');
  return base ? `${base}\n${line}\n` : `${line}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 .env 文本里读取某个键（用于展示/校验，不做完整解析） */
export function readEnvValue(text: string, name: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(name)}\\s*=\\s*(.*)$`, 'm');
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

/** API Key 的基本格式检查（不做真实鉴权） */
export function isPlausibleApiKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{10,}$/.test(key.trim());
}
