/**
 * API Key 配置对话框。
 *
 * 面向「空白密钥安装包」的用户：不需要手工编辑 .env——在界面里粘贴 Key，
 * 服务端会先用 GET /models 校验，通过后立即生效并写回安装目录的 .env。
 */
import { useEffect, useRef, useState } from 'react';
import type { HealthState } from './types';

export interface ApiKeyDialogProps {
  open: boolean;
  serviceState: HealthState;
  onClose: () => void;
  /** 保存成功（此时 key 已生效），由 App 刷新健康状态并提示 */
  onSaved: () => void;
}

const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{10,}$/;

export function ApiKeyDialog({ open, serviceState, onClose, onSaved }: ApiKeyDialogProps) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setKey('');
    setError(null);
    setSaving(false);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const save = async () => {
    const trimmed = key.trim();
    if (!KEY_PATTERN.test(trimmed)) {
      setError('API Key 格式不正确：应以 sk- 开头，且长度不少于 12 个字符。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/config/apikey', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; verified?: boolean; error?: string; warning?: string }
        | null;
      if (!response.ok || !body?.ok) {
        setError(body?.error ?? `保存失败（HTTP ${response.status}）`);
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(`无法连接本地服务：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="apikey-card" role="dialog" aria-modal="true" aria-label="配置 DeepSeek API Key" data-testid="apikey-dialog">
        <header className="apikey-head">
          <div>
            <h2>配置 DeepSeek API Key</h2>
            <p className="apikey-sub">AI 改写、论文助手与联网搜索都需要它。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭配置窗口">
            ✕
          </button>
        </header>

        <div className="apikey-body">
          <label className="apikey-label" htmlFor="apikey-input">
            API Key（以 sk- 开头）
          </label>
          <input
            id="apikey-input"
            ref={inputRef}
            className="apikey-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') onClose();
            }}
            data-testid="apikey-input"
          />
          <p className="apikey-hint">
            在{' '}
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
              platform.deepseek.com/api_keys
            </a>{' '}
            获取。Key 只保存在本机安装目录的 <code>.env</code> 中，不会上传到除 DeepSeek 之外的任何服务。
          </p>
          {error ? (
            <p className="apikey-error" role="alert" data-testid="apikey-error">
              {error}
            </p>
          ) : null}
          {serviceState === 'offline' ? (
            <p className="apikey-error" role="alert">
              本地服务未连接，暂时无法保存。请确认 DocPro 服务已启动后重试。
            </p>
          ) : null}
        </div>

        <footer className="apikey-foot">
          <span className="apikey-status">保存前会自动校验 Key 是否可用</span>
          <span className="apikey-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="apikey-cancel">
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving } data-testid="apikey-save">
              {saving ? '校验中…' : '保存并校验'}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
