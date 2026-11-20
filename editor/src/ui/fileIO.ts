/**
 * 本地文件读写：优先 File System Access API（Chrome / Edge），
 * 不支持或被拒绝时退化为 <input type=file> 打开 / 下载保存。
 *
 * 打开前做文件类型嗅探（core/textFile）：
 * - .docx / OOXML 压缩包 → 交给「导入 Word」流程，不再把二进制当文本读成乱码；
 * - PDF / 图片 / 旧版 Office → 提示不是文本文件；
 * - 文本按 BOM / UTF-8 / GBK 解码（老 .txt 常是 GBK）。
 */
import { decodeTextBytes, normalizeNewlines, sniffFileKind } from '../core/textFile';

export interface FsWritable {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface FsFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritable>;
}

interface FsPickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<FsFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FsFileHandle>;
}

const pickerWindow = window as unknown as FsPickerWindow;

const FILE_TYPES = [
  {
    description: 'Markdown / 文本',
    accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.txt'] },
  },
  {
    description: 'Word 文档',
    accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
  },
];

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}

function titleFromFileName(name: string): string {
  return name.replace(/\.(md|markdown|mdown|txt)$/i, '') || '未命名文档';
}

export interface OpenFileResult {
  title: string;
  text: string;
  handle: FsFileHandle | null;
}

/** 打开本地文件的结果（含拒收原因，UI 据此提示或转交导入流程） */
export type OpenFileOutcome =
  | { status: 'ok'; result: OpenFileResult }
  | { status: 'docx'; file: File; handle: FsFileHandle | null }
  | { status: 'binary'; fileName: string }
  | { status: 'cancelled' };

function pickWithInput(): Promise<{ file: File; handle: null } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.mdown,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file ? { file, handle: null } : null);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

async function pickLocalFile(): Promise<{ file: File; handle: FsFileHandle | null } | null> {
  if (pickerWindow.showOpenFilePicker) {
    try {
      const handles = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      const handle = handles?.[0];
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (error) {
      if (isAbortError(error)) return null;
      // 权限被拒 / 浏览器不支持：继续走 input 兜底
    }
  }
  return pickWithInput();
}

/**
 * 打开本地文件。
 * - 文本：解码（UTF-8 / GBK / UTF-16）后返回；
 * - .docx：返回 status='docx'，由调用方转入「导入 Word」；
 * - PDF / 图片 / 旧版 Office：status='binary'；
 * - 用户取消：status='cancelled'。
 */
export async function openMarkdownFile(): Promise<OpenFileOutcome> {
  const picked = await pickLocalFile();
  if (!picked) return { status: 'cancelled' };
  const { file, handle } = picked;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return { status: 'binary', fileName: file.name };
  }

  const kind = sniffFileKind(file.name, bytes);
  if (kind === 'docx') return { status: 'docx', file, handle };
  if (kind === 'binary') return { status: 'binary', fileName: file.name };

  const decoded = decodeTextBytes(bytes);
  if (!decoded) return { status: 'binary', fileName: file.name };

  return {
    status: 'ok',
    result: {
      title: titleFromFileName(file.name),
      text: normalizeNewlines(decoded.text),
      handle,
    },
  };
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface SaveFileResult {
  handle: FsFileHandle | null;
  fileName: string;
  downloaded: boolean;
}

/**
 * 保存 Markdown。
 * - existing 非空且未要求另存：原地写入；
 * - 否则走 showSaveFilePicker（如果支持），最后兜底为下载。
 */
export async function saveMarkdownFile(
  existing: FsFileHandle | null,
  fileName: string,
  text: string,
  options: { saveAs?: boolean } = {},
): Promise<SaveFileResult | null> {
  if (existing && !options.saveAs) {
    try {
      const writable = await existing.createWritable();
      await writable.write(text);
      await writable.close();
      return { handle: existing, fileName: existing.name || fileName, downloaded: false };
    } catch (error) {
      if (isAbortError(error)) return null;
      // 句柄失效（文件被移动 / 权限被收回）：继续走另存流程
    }
  }

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: FILE_TYPES,
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { handle, fileName: handle.name || fileName, downloaded: false };
    } catch (error) {
      if (isAbortError(error)) return null;
    }
  }

  downloadText(fileName, text);
  return { handle: null, fileName, downloaded: true };
}

export function isFileSystemAccessSupported(): boolean {
  return typeof pickerWindow.showOpenFilePicker === 'function';
}
