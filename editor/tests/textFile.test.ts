/**
 * 本地文件类型嗅探与文本解码（防「把 docx/PDF 当文本打开成乱码」）。
 */
import { describe, expect, it } from 'vitest';
import { decodeTextBytes, normalizeNewlines, sniffFileKind } from '../src/core/textFile';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('文件类型嗅探', () => {
  it('按扩展名识别 docx', () => {
    expect(sniffFileKind('论文.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('docx');
    expect(sniffFileKind('论文.DOCX', new Uint8Array([]))).toBe('docx');
  });

  it('ZIP 魔数但非 .docx → 二进制（pptx/xlsx/压缩包）', () => {
    expect(sniffFileKind('演示.pptx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('binary');
  });

  it('PDF / 图片 / 旧版 Office → 二进制', () => {
    expect(sniffFileKind('a.pdf', utf8('%PDF-1.7\n'))).toBe('binary');
    expect(sniffFileKind('a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('binary');
    expect(sniffFileKind('a.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('binary');
    expect(sniffFileKind('a.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('binary');
  });

  it('普通文本 → text', () => {
    expect(sniffFileKind('a.md', utf8('# 标题\n正文'))).toBe('text');
  });
});

describe('文本解码', () => {
  it('UTF-8 中文正常解码', () => {
    const decoded = decodeTextBytes(utf8('# 标题\n中文内容'));
    expect(decoded?.encoding).toBe('utf-8');
    expect(decoded?.text).toContain('中文内容');
  });

  it('GBK 中文按 GBK 解码（老 .txt）', () => {
    // “中文”的 GBK 编码：D6 D0 CE C4
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
    const decoded = decodeTextBytes(bytes);
    expect(decoded?.encoding).toBe('gbk');
    expect(decoded?.text.trim()).toBe('中文');
  });

  it('UTF-16LE BOM 解码', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]); // “你好”
    const decoded = decodeTextBytes(bytes);
    expect(decoded?.encoding).toBe('utf-16le');
    expect(decoded?.text).toBe('你好');
  });

  it('UTF-8 BOM 去除', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('标题')]);
    expect(decodeTextBytes(bytes)?.text).toBe('标题');
  });

  it('含大量 NUL 的二进制 → null', () => {
    const bytes = new Uint8Array(64).fill(0);
    expect(decodeTextBytes(bytes)).toBeNull();
  });

  it('随机高熵字节 → null（不当成文本）', () => {
    const bytes = new Uint8Array(200);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
    expect(decodeTextBytes(bytes)).toBeNull();
  });

  it('normalizeNewlines 统一换行', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
