/**
 * 文档附件（图片）路径解析：文档文件夹内解析、禁止越界。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dataDir: string;
let store: typeof import('../server/docStore');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'docmax-attach-'));
  process.env.DOCPRO_DATA_DIR = dataDir;
  const { vi } = await import('vitest');
  vi.resetModules();
  store = await import('../server/docStore');
});

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DOCPRO_DATA_DIR;
});

describe('附件路径解析', () => {
  it('文档文件夹内的相对路径可解析', () => {
    const doc = store.createDoc({ title: '附件测试', content: '内容' });
    const folder = join(dataDir, 'docs', doc.id);
    mkdirSync(join(folder, 'img'), { recursive: true });
    writeFileSync(join(folder, 'img', 'a.png'), 'x');
    const target = store.resolveAttachmentPath(doc.id, 'img/a.png');
    expect(target).toBe(join(folder, 'img', 'a.png'));
    expect(existsSync(target as string)).toBe(true);
  });

  it('拒绝 .. 越界', () => {
    const doc = store.createDoc({ title: '越界测试', content: '内容' });
    expect(store.resolveAttachmentPath(doc.id, '../secret.png')).toBeNull();
    expect(store.resolveAttachmentPath(doc.id, 'img/../../secret.png')).toBeNull();
    expect(store.resolveAttachmentPath(doc.id, '..')).toBeNull();
  });

  it('拒绝绝对路径与空路径', () => {
    const doc = store.createDoc({ title: '绝对路径测试', content: '内容' });
    expect(store.resolveAttachmentPath(doc.id, 'C:\\Windows\\x.png')).toBeNull();
    expect(store.resolveAttachmentPath(doc.id, '')).toBeNull();
  });

  it('文档不存在返回 null', () => {
    expect(store.resolveAttachmentPath('doc-20260101-000000-000000', 'a.png')).toBeNull();
  });
});
