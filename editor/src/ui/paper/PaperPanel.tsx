/**
 * 论文助手面板：结构解析 / 逐段修改 / 参考文献 / 记忆·要求 / AI 扫描。
 *
 * 面板是右侧停靠层（不遮挡编辑区，可边看边改）：
 * - 结构分析、参考文献完整性、AI 扫描全部本地确定性计算（analyzePaper）；
 * - 逐段修订与参考文献重排走服务端（DeepSeek 全家桶分工：强模型改正文、快模型排文献）；
 * - 记忆随文档保存（文档库 → 文档文件夹；本地文件 → 指纹存储）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzePaper } from '../../core/paper/analyze';
import { fnv1a32 } from '../../core/selection';
import { defaultMemory, normalizeMemory } from '../../core/paper/memory';
import type { PaperAnalysis, PaperMemory } from '../../core/paper/types';
import type { PublicConfig } from '../../core/protocol';
import { loadPaperMemory, savePaperMemory, type PaperMemoryKey } from './paperApi';
import { PaperParagraphs } from './PaperParagraphs';
import { PaperRefs } from './PaperRefs';
import { PaperMemoryTab } from './PaperMemoryTab';
import { PaperScan } from './PaperScan';
import { IconClose } from '../Icons';

export interface PaperChange {
  from: number;
  to: number;
  oldText: string;
  newText: string;
}

export interface PaperPanelProps {
  open: boolean;
  onClose: () => void;
  docText: string;
  docTitle: string;
  docId: string | null;
  publicConfig: PublicConfig;
  onJump: (from: number, to: number) => void;
  onApplyChanges: (changes: PaperChange[], note: string) => void;
  showToast: (text: string) => void;
}

export type PaperTab = 'paragraphs' | 'refs' | 'memory' | 'scan';

function localStorageKey(docId: string | null, docTitle: string): string {
  if (docId) return `docpro-paper-memory-${docId}`;
  return `docpro-paper-memory-${fnv1a32(docTitle || 'untitled')}`;
}

function memoryKey(docId: string | null, docTitle: string): PaperMemoryKey {
  if (docId) return { docId };
  return { fingerprint: fnv1a32(docTitle || 'untitled') };
}

export function PaperPanel(props: PaperPanelProps) {
  const { open, docText, docTitle, docId } = props;
  const [tab, setTab] = useState<PaperTab>('paragraphs');
  const [memory, setMemory] = useState<PaperMemory>(() => defaultMemory());
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [appliedParagraphs, setAppliedParagraphs] = useState<Set<string>>(new Set());
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef<string>('');

  const key = useMemo(() => memoryKey(docId, docTitle), [docId, docTitle]);

  /* 记忆加载：docId / 标题变化时重新加载（本地文件先用 localStorage 兜底） */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fallbackKey = localStorageKey(docId, docTitle);
    const run = async () => {
      const stored = loadPaperMemory(key).then((server) => {
        if (server) return server;
        try {
          const local = localStorage.getItem(fallbackKey);
          if (local) {
            const parsed = JSON.parse(local) as unknown;
            void savePaperMemory(key, normalizeMemory(parsed)); // 迁移到服务端存储
            return normalizeMemory(parsed);
          }
        } catch {
          // 忽略本地存储损坏
        }
        return null;
      });
      const loaded = await stored;
      if (cancelled) return;
      setMemory(loaded ?? defaultMemory());
      loadedRef.current = JSON.stringify(loaded ?? defaultMemory());
      setMemoryLoaded(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open, key, docId, docTitle]);

  /* 记忆自动保存（防抖 700ms；文档库走服务端，本地文件同时写 localStorage） */
  useEffect(() => {
    if (!memoryLoaded) return;
    const serialized = JSON.stringify(memory);
    if (serialized === loadedRef.current) return;
    loadedRef.current = serialized;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const payload = normalizeMemory(memory);
      void savePaperMemory(key, payload).then((ok) => {
        if (!ok) props.showToast('论文记忆保存失败（本地保存已生效）');
      });
      try {
        localStorage.setItem(localStorageKey(docId, docTitle), serialized);
      } catch {
        // localStorage 满或不可用
      }
    }, 700);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [memory, memoryLoaded, key, docId, docTitle, props]);

  const analysis: PaperAnalysis = useMemo(
    () => analyzePaper(docText, { referenceFormat: memory.referenceFormat }),
    [docText, memory.referenceFormat],
  );

  const handleMemoryChange = useCallback((next: PaperMemory) => {
    setMemory(normalizeMemory(next));
  }, []);

  const markApplied = useCallback((paragraphId: string) => {
    setAppliedParagraphs((previous) => {
      const next = new Set(previous);
      next.add(paragraphId);
      return next;
    });
  }, []);

  if (!open) return null;

  const stats = analysis.stats;
  const refSummary = {
    refs: analysis.references.totalRefs,
    uncited: analysis.references.uncited.length,
    undefined: analysis.references.undefined.length,
    duplicates: analysis.references.duplicates.length,
  };

  const tabs: Array<{ id: PaperTab; label: string; badge?: number }> = [
    { id: 'paragraphs', label: '段落', badge: stats.revisableParagraphs },
    { id: 'refs', label: '参考文献', badge: refSummary.refs || undefined },
    { id: 'scan', label: 'AI 扫描', badge: stats.issues || undefined },
    { id: 'memory', label: '记忆 · 要求' },
  ];

  return (
    <div className="paper-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <aside className="paper-panel" role="dialog" aria-label="论文助手" data-testid="paper-panel">
        <header className="paper-head">
          <div className="paper-head-title">
            <span className="paper-mark" aria-hidden="true">✦</span>
            <span>论文助手</span>
            <span className="paper-head-sub">逐段修改 · 引文保护</span>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭论文助手" title="关闭">
            <IconClose />
          </button>
        </header>

        <nav className="paper-tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`paper-tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => setTab(item.id)}
              data-testid={`paper-tab-${item.id}`}
            >
              {item.label}
              {item.badge !== undefined && item.badge > 0 ? <span className="paper-tab-badge">{item.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className="paper-body">
          {tab === 'paragraphs' ? (
            <PaperParagraphs
              analysis={analysis}
              docText={docText}
              docTitle={docTitle}
              docId={docId}
              memory={memory}
              appliedParagraphs={appliedParagraphs}
              publicConfig={props.publicConfig}
              onMarkApplied={markApplied}
              onJump={props.onJump}
              onApplyChanges={props.onApplyChanges}
              showToast={props.showToast}
            />
          ) : null}
          {tab === 'refs' ? (
            <PaperRefs
              analysis={analysis}
              docText={docText}
              docTitle={docTitle}
              memory={memory}
              publicConfig={props.publicConfig}
              onJump={props.onJump}
              onApplyChanges={props.onApplyChanges}
              showToast={props.showToast}
            />
          ) : null}
          {tab === 'scan' ? <PaperScan analysis={analysis} onJump={props.onJump} /> : null}
          {tab === 'memory' ? <PaperMemoryTab memory={memory} onChange={handleMemoryChange} /> : null}
        </div>

        <footer className="paper-foot">
          <span>{stats.units} 块 · {stats.paragraphs} 段 · {stats.words.toLocaleString('zh-CN')} 词</span>
          <span>
            {refSummary.refs > 0
              ? `文献 ${refSummary.refs} 条${refSummary.undefined > 0 ? ` · 未定义引用 ${refSummary.undefined}` : ''}`
              : '未检测到参考文献'}
          </span>
        </footer>
      </aside>
    </div>
  );
}
