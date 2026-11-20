/**
 * .env 行级编辑（应用内配置 API Key 的底层）。
 */
import { describe, expect, it } from 'vitest';
import { isPlausibleApiKey, readEnvValue, upsertEnvValue } from '../src/core/envFile';

describe('upsertEnvValue', () => {
  it('不存在该键时追加到末尾', () => {
    expect(upsertEnvValue('PORT=5199\n', 'DEEPSEEK_API_KEY', 'sk-abc')).toBe('PORT=5199\nDEEPSEEK_API_KEY=sk-abc\n');
  });

  it('存在时只替换该行，保留其他配置与注释', () => {
    const before = '# 注释\nDEEPSEEK_API_KEY=sk-old\nPORT=5199\n';
    const after = upsertEnvValue(before, 'DEEPSEEK_API_KEY', 'sk-new');
    expect(after).toBe('# 注释\nDEEPSEEK_API_KEY=sk-new\nPORT=5199\n');
  });

  it('空 key 也会写入（保持行存在）', () => {
    expect(upsertEnvValue('DEEPSEEK_API_KEY=sk-old\n', 'DEEPSEEK_API_KEY', '')).toBe('DEEPSEEK_API_KEY=\n');
  });

  it('空文件也能写入', () => {
    expect(upsertEnvValue('', 'DEEPSEEK_API_KEY', 'sk-x')).toBe('DEEPSEEK_API_KEY=sk-x\n');
  });

  it('允许 = 两侧有空格', () => {
    expect(upsertEnvValue('DEEPSEEK_API_KEY = sk-old\n', 'DEEPSEEK_API_KEY', 'sk-new')).toBe('DEEPSEEK_API_KEY=sk-new\n');
  });
});

describe('readEnvValue', () => {
  it('读取键值', () => {
    expect(readEnvValue('DEEPSEEK_API_KEY=sk-abc\n', 'DEEPSEEK_API_KEY')).toBe('sk-abc');
    expect(readEnvValue('DEEPSEEK_API_KEY=\n', 'DEEPSEEK_API_KEY')).toBe('');
  });

  it('不存在返回 null', () => {
    expect(readEnvValue('PORT=5199\n', 'DEEPSEEK_API_KEY')).toBeNull();
  });
});

describe('isPlausibleApiKey', () => {
  it('合法格式', () => {
    expect(isPlausibleApiKey('sk-1234567890abcdef')).toBe(true);
    expect(isPlausibleApiKey('  sk-abc_def-123456  ')).toBe(true);
  });

  it('非法格式', () => {
    expect(isPlausibleApiKey('')).toBe(false);
    expect(isPlausibleApiKey('abc-1234567890')).toBe(false);
    expect(isPlausibleApiKey('sk-short')).toBe(false);
    expect(isPlausibleApiKey('sk-<script>alert(1)</script>')).toBe(false);
  });
});
