/**
 * Markdown 渲染：marked + DOMPurify。
 * 编辑器的预览模式与「解释」模式的回答都用同一套渲染，保证样式一致。
 *
 * 图片处理：http(s)/data/站点根路径直接显示；文档库文档中的相对路径图片
 * 重写为附件代理地址（/api/docs/:id/attachments/...），无法解析时按 alt 显示占位。
 */
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface MarkdownPreviewProps {
  docText: string;
  /** 外层容器 class，默认 prose */
  className?: string;
  /** 用于测试定位，默认 preview */
  testId?: string;
  /** 文档库文档 id：存在时相对路径图片走附件代理 */
  docId?: string | null;
}

function isResolvableImageSrc(src: string | null): boolean {
  if (!src) return false;
  return /^(https?:|data:|blob:|#)/i.test(src) || src.startsWith('/') || src.startsWith('//');
}

export function MarkdownPreview({ docText, className = 'prose', testId = 'preview', docId = null }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    if (!docText.trim()) return '';
    try {
      const raw = marked.parse(docText, { async: false, gfm: true, breaks: false }) as string;
      const sanitized = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
        FORBID_ATTR: ['style', 'onerror', 'onload'],
      });
      const parsed = new DOMParser().parseFromString(sanitized, 'text/html');
      // 文档库文档：把相对路径图片重写为附件代理地址
      if (docId) {
        parsed.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('src');
          if (src && !isResolvableImageSrc(src) && !/^[a-zA-Z]:[\\/]/.test(src)) {
            img.setAttribute('src', `/api/docs/${encodeURIComponent(docId)}/attachments/${encodeURIComponent(src)}`);
          }
        });
      }
      // 宽表格放进横向滚动容器，避免把正文挤变形
      parsed.querySelectorAll('table').forEach((table) => {
        const wrapper = parsed.createElement('div');
        wrapper.className = 'prose-table-scroll';
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      });
      return parsed.body.innerHTML;
    } catch {
      return '<p class="preview-error">渲染失败，请检查 Markdown 语法。</p>';
    }
  }, [docText, docId]);

  if (!html) {
    return (
      <div className="preview-empty" aria-live="polite">
        文档还是空的。切回编辑，写点什么吧。
      </div>
    );
  }

  return <article className={className} data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />;
}
