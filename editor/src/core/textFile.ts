/**
 * 本地文件类型嗅探与文本解码（纯函数，可单测）。
 *
 * 背景：本地文件夹里混着 .docx / PDF / 图片，用户用「打开」误选时不能把二进制
 * 当 UTF-8 读成乱码写进文档库。这里做三件事：
 * 1. 按扩展名 + 魔数识别 docx / 二进制；
 * 2. 文本文件按 BOM / UTF-8 / GBK 依次尝试解码（老 .txt 常是 GBK）；
 * 3. 解码后仍有大量替换字符或 NUL → 判定不是文本。
 */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF_MAGIC = [0x47, 0x49, 0x46];
const BMP_MAGIC = [0x42, 0x4d];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** 文件类型判定：docx / 二进制 / 可当文本读取 */
export type SniffedKind = 'docx' | 'binary' | 'text';

export function sniffFileKind(fileName: string, bytes: Uint8Array): SniffedKind {
  const lower = fileName.toLowerCase();
  if (/\.docx$/.test(lower)) return 'docx';
  if (startsWith(bytes, ZIP_MAGIC)) {
    // 其他 OOXML（pptx/xlsx）或压缩包：不是文本
    return 'binary';
  }
  if (
    startsWith(bytes, OLE_MAGIC) || // 旧版 Word/Excel（.doc/.xls）
    startsWith(bytes, PDF_MAGIC) ||
    startsWith(bytes, PNG_MAGIC) ||
    startsWith(bytes, JPEG_MAGIC) ||
    startsWith(bytes, GIF_MAGIC) ||
    startsWith(bytes, BMP_MAGIC) ||
    startsWith(bytes, RIFF_MAGIC) // wav/avi 等
  ) {
    return 'binary';
  }
  return 'text';
}

const REPLACEMENT = '\ufffd';

function countReplacement(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === REPLACEMENT) count += 1;
  }
  return count;
}

export interface DecodedText {
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk';
}

/** 文本文件解码：BOM → UTF-16；否则在 UTF-8 / GBK 里挑替换字符更少的；两者都烂则视为二进制 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText | null {
  // BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(new TextDecoder('utf-8').decode(bytes.subarray(3))), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: stripBom(new TextDecoder('utf-16le').decode(bytes.subarray(2))), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: stripBom(new TextDecoder('utf-16be').decode(bytes.subarray(2))), encoding: 'utf-16be' };
  }

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let best: { text: string; bad: number; encoding: DecodedText['encoding'] } = {
    text: utf8,
    bad: countReplacement(utf8),
    encoding: 'utf-8',
  };
  if (best.bad > 0) {
    try {
      const gbk = new TextDecoder('gbk').decode(bytes);
      const gbkBad = countReplacement(gbk);
      if (gbkBad < best.bad) best = { text: gbk, bad: gbkBad, encoding: 'gbk' };
    } catch {
      // 浏览器不支持 gbk 时保持 UTF-8 结果
    }
  }
  const length = Math.max(1, best.text.length);
  if (best.bad / length > 0.02) return null;
  if (best.text.includes('\u0000')) return null;
  return { text: stripBom(best.text), encoding: best.encoding };
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/** 统一换行符（\r\n / \r → \n） */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
