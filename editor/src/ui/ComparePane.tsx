/**
 * 对照模式：左侧显示「对照文档」（只读渲染），右侧保留当前文档（编辑/预览）。
 *
 * - 对照文档来源：文档库文档（下拉切换）或本地 Markdown 文件；
 * - 控制栏浮动在左侧顶部（半透明卡片），可开同步滚动、切换、关闭；
 * - 文档库文档的图片走附件代理（MarkdownPreview 传入 docId）；
 * - 同步滚动为双向比例同步（左 ↔ 右），带防回环保护。
 */
import { useEffect, useRef } from 'react';
import type { DocSummary } from '../core/docs';
import { MarkdownPreview } from './Preview';
import { IconClose } from './Icons';

export interface CompareRef {
  /** 文档库文档 id（用于图片附件代理）；本地文件为 null */
  id: string | null;
  title: string;
  content: string;
  source: 'library' | 'local';
}

export interface ComparePaneProps {
  open: boolean;
  reference: CompareRef | null;
  docs: DocSummary[];
  loading: boolean;
  syncScroll: boolean;
  onSelectDoc: (id: string) => void;
  onOpenLocal: (file: File) => void;
  onToggleSync: () => void;
  onClose: () => void;
}

export function ComparePane(props: ComparePaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const syncRef = useRef(props.syncScroll);
  syncRef.current = props.syncScroll;

  /* 双向比例同步滚动（左 ↔ 右）；滚动事件用捕获阶段监听，天然覆盖编辑器滚动容器 */
  useEffect(() => {
    if (!props.open) return;
    let syncing = false;
    let frame = 0;
    const onScroll = (event: Event) => {
      if (!syncRef.current || syncing) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const left = scrollRef.current;
      if (!left) return;
      const right = document.querySelector<HTMLElement>(
        '.workspace.is-compare .cm-scroller, .workspace.is-compare .preview-scroll',
      );
      if (!right) return;
      const isLeft = target === left;
      const isRight = target === right;
      if (!isLeft && !isRight) return;
      const source = target;
      const dest = isLeft ? right : left;
      const maxSource = source.scrollHeight - source.clientHeight;
      const maxDest = dest.scrollHeight - dest.clientHeight;
      if (maxSource <= 0 || maxDest <= 0) return;
      syncing = true;
      dest.scrollTop = (source.scrollTop / maxSource) * maxDest;
      frame = window.requestAnimationFrame(() => {
        syncing = false;
      });
    };
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [props.open]);

  if (!props.open) return null;

  const currentId = props.reference?.source === 'library' ? props.reference.id ?? '' : '';

  return (
    <aside className="compare-pane" aria-label="对照文档" data-testid="compare-pane">
      <div className="compare-bar" data-testid="compare-bar">
        <div className="compare-bar-row">
          <span className="compare-mark" aria-hidden="true">
            ⇆
          </span>
          <span className="compare-title">对照</span>
          <select
            className="compare-select"
            value={currentId}
            onChange={(event) => {
              if (event.target.value) props.onSelectDoc(event.target.value);
            }}
            aria-label="选择对照文档"
            data-testid="compare-select"
          >
            <option value="">选择文档库文档…</option>
            {props.docs.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.title}
              </option>
            ))}
          </select>
        </div>
        <div className="compare-bar-row">
          <label className="compare-file-btn">
            打开本地文件
            <input
              type="file"
              accept=".md,.markdown,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              data-testid="compare-local-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) props.onOpenLocal(file);
                event.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            className={`compare-toggle${props.syncScroll ? ' is-active' : ''}`}
            onClick={props.onToggleSync}
            aria-pressed={props.syncScroll}
            title="左右两侧按比例同步滚动"
            data-testid="compare-sync"
          >
            同步滚动
          </button>
          <span className="compare-bar-gap" />
          <button type="button" className="compare-close" onClick={props.onClose} aria-label="关闭对照" title="关闭对照（Esc）">
            <IconClose />
            <span>关闭</span>
          </button>
        </div>
      </div>

      <div className="compare-doc-scroll" ref={scrollRef} data-testid="compare-scroll">
        {props.loading ? (
          <div className="compare-empty">
            <span className="spinner" aria-hidden="true" />
            <span>正在加载对照文档…</span>
          </div>
        ) : props.reference ? (
          <>
            <div className="compare-doc-head">
              <span className="compare-doc-title" title={props.reference.title}>
                {props.reference.title}
              </span>
              <span className="compare-doc-meta">
                {props.reference.source === 'library' ? '文档库' : '本地文件'} · {props.reference.content.length.toLocaleString('zh-CN')} 字
              </span>
            </div>
            {props.reference.content.trim() ? (
              <MarkdownPreview docText={props.reference.content} className="prose compare-prose" testId="compare-doc" docId={props.reference.id} />
            ) : (
              <div className="compare-empty">该对照文档没有内容，请换一个文档或打开本地文件。</div>
            )}
          </>
        ) : (
          <div className="compare-empty">
            <span>选择一个文档库文档，或打开本地 Markdown 文件作为对照。</span>
          </div>
        )}
      </div>
    </aside>
  );
}
