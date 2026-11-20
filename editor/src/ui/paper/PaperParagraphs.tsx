/**
 * 段落标签页：结构视图 + 逐段修订。
 *
 * - 每个可修订段落一行：章节、片段、字数、引文、AI 问题徽章；
 * - 点「修改」展开指令输入（模型/思考强度可选），提交后流式修订；
 * - 修订结果先展示词级 diff 与引文保护警告，接受才写入文档；
 * - 支持「批量逐段」：同一指令按顺序修订全部正文段落，逐段审阅。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fnv1a32 } from '../../core/selection';
import type { PaperAnalysis, PaperImageRef, PaperMemory, PaperParagraph, PaperReviseProposal, PaperTableData } from '../../core/paper/types';
import { normalizeTableText, stripMarkdownInline } from '../../core/paper/parse';
import type { ModelId, ThinkingLevel } from '../../core/types';
import type { PublicConfig } from '../../core/protocol';
import { streamPaperReviseRequest } from './paperApi';
import type { PaperChange } from './PaperPanel';
import { AI_ISSUE_KIND_LABELS } from '../../core/paper/scan';
import type { WebSource, WebToolCall } from '../../core/types';
import { DiffView } from '../DiffView';

export interface PaperParagraphsProps {
  analysis: PaperAnalysis;
  docText: string;
  docTitle: string;
  docId: string | null;
  memory: PaperMemory;
  appliedParagraphs: Set<string>;
  publicConfig: PublicConfig;
  onMarkApplied: (paragraphId: string) => void;
  onJump: (from: number, to: number) => void;
  onApplyChanges: (changes: PaperChange[], note: string) => void;
  showToast: (text: string) => void;
}

interface ReviseJob {
  paragraphId: string;
  instruction: string;
  model: ModelId;
  thinking: ThinkingLevel;
  webSearch: boolean;
  status: 'running' | 'done' | 'error';
  phase: string;
  phaseNote: string | null;
  attempt: number;
  reasoning: string;
  streamText: string;
  webCalls: WebToolCall[];
  proposal: PaperReviseProposal | null;
  error: string | null;
}

interface BatchState {
  running: boolean;
  instruction: string;
  model: ModelId;
  thinking: ThinkingLevel;
  total: number;
  current: number;
  done: number;
  failed: number;
}

const DEFAULT_INSTRUCTION = '修订这段文字：纠正 AI 痕迹与空话套话、语病与表述不规范，保持原意、事实、数字与引文标记不变。';

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `paper-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function cap(text: string, max = 200_000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function kindLabel(kind: PaperParagraph['kind']): string {
  const labels: Record<PaperParagraph['kind'], string> = {
    title: '题目',
    front: '前置',
    abstract: '摘要',
    keywords: '关键词',
    body: '正文',
    references: '参考文献',
    acknowledgment: '致谢',
    appendix: '附录',
    heading: '标题',
  };
  return labels[kind];
}

export function PaperParagraphs(props: PaperParagraphsProps) {
  const { analysis, memory, appliedParagraphs, publicConfig } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, ReviseJob>>({});
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [batchInstruction, setBatchInstruction] = useState('');
  const [batchModel, setBatchModel] = useState<ModelId>(publicConfig.paperModels.revise);
  const [batchThinking, setBatchThinking] = useState<ThinkingLevel>(publicConfig.paperDefaultThinking);
  const abortRef = useRef<AbortController | null>(null);
  const batchRef = useRef<BatchState | null>(null);
  batchRef.current = batch;
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  const docRef = useRef(props.docText);
  docRef.current = props.docText;

  /* 文档变化：中止运行、清空待审提案（已接受的段落仍保留标记） */
  useEffect(() => {
    abortRef.current?.abort();
    setJobs({});
    setEditingId(null);
    setBatch(null);
  }, [props.docText]);

  const patchJob = useCallback((paragraphId: string, patch: Partial<ReviseJob>) => {
    setJobs((previous) => {
      const current = previous[paragraphId];
      if (!current) return previous;
      return { ...previous, [paragraphId]: { ...current, ...patch } };
    });
  }, []);

  const appendJob = useCallback((paragraphId: string, key: 'reasoning' | 'streamText', delta: string) => {
    if (!delta) return;
    setJobs((previous) => {
      const current = previous[paragraphId];
      if (!current) return previous;
      return { ...previous, [paragraphId]: { ...current, [key]: cap(current[key] + delta) } };
    });
  }, []);

  /** 对单个段落执行修订；返回是否得到可审阅提案 */
  const runRevise = useCallback(
    async (paragraph: PaperParagraph, instruction: string, model: ModelId, thinking: ThinkingLevel, webSearch = false): Promise<boolean> => {
      const abort = new AbortController();
      abortRef.current = abort;
      const base: ReviseJob = {
        paragraphId: paragraph.id,
        instruction,
        model,
        thinking,
        webSearch,
        status: 'running',
        phase: 'connecting',
        phaseNote: null,
        attempt: 1,
        reasoning: '',
        streamText: '',
        webCalls: [],
        proposal: null,
        error: null,
      };
      setJobs((previous) => ({ ...previous, [paragraph.id]: base }));
      setEditingId(null);

      const payload = {
        requestId: newRequestId(),
        docTitle: props.docTitle,
        docText: docRef.current,
        paragraphId: paragraph.id,
        from: paragraph.from,
        to: paragraph.to,
        oldText: paragraph.text,
        hash: fnv1a32(paragraph.text),
        instruction,
        memory: memoryRef.current,
        // 联网工具仅 deepseek-flash 支持：勾选联网时自动切到 flash
        options: { model: webSearch ? 'deepseek-flash' : model, thinking, webSearch },
      };

      const outcome = await streamPaperReviseRequest(
        payload,
        {
          onStatus: (event) => patchJob(paragraph.id, { phase: event.phase, phaseNote: event.note ?? null, attempt: event.attempt ?? 1 }),
          onReasoning: (delta) => appendJob(paragraph.id, 'reasoning', delta),
          onDelta: (text) => appendJob(paragraph.id, 'streamText', text),
          onWeb: (call) => {
            setJobs((previous) => {
              const current = previous[paragraph.id];
              if (!current) return previous;
              return { ...previous, [paragraph.id]: { ...current, webCalls: [...current.webCalls, call] } };
            });
          },
        },
        abort.signal,
      );

      if (outcome.proposal) {
        patchJob(paragraph.id, { status: 'done', proposal: outcome.proposal, phase: 'done', phaseNote: null });
        return true;
      }
      patchJob(paragraph.id, {
        status: 'error',
        error: outcome.error?.message ?? '修订失败，请重试。',
        phase: 'done',
        phaseNote: null,
      });
      return false;
    },
    [appendJob, patchJob, props.docTitle],
  );

  const startBatch = useCallback(async () => {
    const instruction = batchInstruction.trim();
    if (!instruction) {
      props.showToast('请先输入批量修订要求');
      return;
    }
    const targets = analysis.paragraphs.filter((p) => p.revisable);
    if (targets.length === 0) {
      props.showToast('没有可修订的正文段落');
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    const total = targets.length;
    let done = 0;
    let failed = 0;
    setBatch({ running: true, instruction, model: batchModel, thinking: batchThinking, total, current: 0, done: 0, failed: 0 });
    for (let i = 0; i < targets.length; i++) {
      if (abort.signal.aborted) break;
      setBatch((prev) => (prev ? { ...prev, current: i + 1 } : prev));
      const ok = await runRevise(targets[i], instruction, batchModel, batchThinking);
      if (ok) done += 1;
      else failed += 1;
      setBatch((prev) => (prev ? { ...prev, done, failed } : prev));
    }
    setBatch((prev) => (prev ? { ...prev, running: false } : prev));
  }, [analysis.paragraphs, batchInstruction, batchModel, batchThinking, props, runRevise]);

  const stopBatch = useCallback(() => {
    abortRef.current?.abort();
    setBatch((prev) => (prev ? { ...prev, running: false } : prev));
  }, []);

  const acceptJob = useCallback(
    (job: ReviseJob) => {
      const proposal = job.proposal;
      if (!proposal) return;
      if (proposal.newText === proposal.oldText) {
        props.showToast('修订结果与原文一致，无需应用');
        setJobs((previous) => {
          const next = { ...previous };
          delete next[job.paragraphId];
          return next;
        });
        return;
      }
      props.onApplyChanges(
        [{ from: proposal.from, to: proposal.to, oldText: proposal.oldText, newText: proposal.newText }],
        `论文助手修订「${job.instruction.slice(0, 40)}」`,
      );
      props.onMarkApplied(job.paragraphId);
      setJobs((previous) => {
        const next = { ...previous };
        delete next[job.paragraphId];
        return next;
      });
    },
    [props],
  );

  const discardJob = useCallback((paragraphId: string) => {
    setJobs((previous) => {
      const next = { ...previous };
      delete next[paragraphId];
      return next;
    });
  }, []);

  /* 按章节分组 */
  const groups = useMemo(() => {
    const result: Array<{ sectionTitle: string | null; paragraphs: PaperParagraph[] }> = [];
    let current: { sectionTitle: string | null; paragraphs: PaperParagraph[] } | null = null;
    for (const paragraph of analysis.paragraphs) {
      if (paragraph.kind === 'heading') {
        current = { sectionTitle: paragraph.plainText || paragraph.sectionTitle, paragraphs: [] };
        result.push(current);
        continue;
      }
      if (!current) {
        current = { sectionTitle: null, paragraphs: [] };
        result.push(current);
      }
      current.paragraphs.push(paragraph);
    }
    return result;
  }, [analysis.paragraphs]);

  const jobFor = (paragraphId: string): ReviseJob | null => jobs[paragraphId] ?? null;

  const renderJobDetail = (job: ReviseJob, paragraph: PaperParagraph) => {
    if (job.status === 'running') {
      return (
        <div className="paper-job paper-job-running" data-testid={`paper-job-${paragraph.id}`}>
          <div className="paper-job-status">
            <span className="spinner" aria-hidden="true" />
            <span>
              {job.phase === 'connecting' && '正在连接模型…'}
              {job.phase === 'thinking' && '模型思考中…'}
              {job.phase === 'streaming' && '正在生成修订…'}
              {job.phase === 'validating' && '正在校验引文与结构…'}
              {job.phase === 'repairing' && '输出未通过校验，自动修复中…'}
            </span>
            {job.phaseNote ? <span className="paper-job-note">{job.phaseNote}</span> : null}
            {job.attempt > 1 ? <span className="paper-job-attempt">第 {job.attempt} 次尝试</span> : null}
          </div>
          {job.reasoning ? (
            <details className="paper-reasoning">
              <summary>思考过程（{job.reasoning.length.toLocaleString('zh-CN')} 字）</summary>
              <pre>{job.reasoning}</pre>
            </details>
          ) : null}
          {job.webCalls.length > 0 ? <PaperWebSources calls={job.webCalls} /> : null}
          {job.streamText ? <div className="paper-stream">{job.streamText}</div> : null}
          <button type="button" className="link-btn" onClick={() => abortRef.current?.abort()}>
            中止生成
          </button>
        </div>
      );
    }
    if (job.status === 'error') {
      return (
        <div className="paper-job paper-job-error" data-testid={`paper-job-${paragraph.id}`}>
          <div className="paper-job-status paper-job-failed">修订失败：{job.error}</div>
          <div className="paper-job-actions">
            <button type="button" className="link-btn" onClick={() => discardJob(paragraph.id)}>
              关闭
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void runRevise(paragraph, job.instruction, job.model, job.thinking)}>
              重试
            </button>
          </div>
        </div>
      );
    }
    if (job.proposal) {
      const proposal = job.proposal;
      const errorWarnings = proposal.warnings.filter((w) => w.severity === 'error');
      const warnWarnings = proposal.warnings.filter((w) => w.severity === 'warn');
      return (
        <div className="paper-job" data-testid={`paper-job-${paragraph.id}`}>
          {proposal.webCalls && proposal.webCalls.length > 0 ? <PaperWebSources calls={proposal.webCalls} /> : null}
          {errorWarnings.length > 0 ? (
            <div className="paper-warnings paper-warnings-error">
              {errorWarnings.map((w, i) => (
                <div key={i}>⚠ {w.message}</div>
              ))}
            </div>
          ) : null}
          {warnWarnings.length > 0 ? (
            <div className="paper-warnings">
              {warnWarnings.map((w, i) => (
                <div key={i}>⚠ {w.message}</div>
              ))}
            </div>
          ) : null}
          <div className="paper-diff-head">
            <span>原文 → 修订建议（词级差异）</span>
            <span className="paper-diff-meta">
              {proposal.usage?.totalTokens ? `tokens ${proposal.usage.totalTokens}` : ''}
            </span>
          </div>
          <div className="paper-diff">
            <DiffView before={proposal.oldText} after={proposal.newText} />
          </div>
          <div className="paper-job-actions">
            <button type="button" className="link-btn" onClick={() => discardJob(paragraph.id)}>
              放弃
            </button>
            <button type="button" className="link-btn" onClick={() => void runRevise(paragraph, job.instruction, job.model, job.thinking)}>
              重新生成
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => acceptJob(job)}
              data-testid={`paper-accept-${paragraph.id}`}
            >
              {errorWarnings.length > 0 ? '仍要接受' : '接受修订'}
            </button>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="paper-tab-content">
      <div className="paper-section">
        <div className="paper-section-head">
          <div>
            <div className="paper-section-title">逐段修改</div>
            <div className="paper-section-desc">
              逐段给出要求，模型只修订该段；引文标记受保护，编造引文会被自动拒绝。
            </div>
          </div>
        </div>

        {/* 批量逐段修改 */}
        <div className="paper-batch">
          <div className="paper-batch-head">
            <span>批量逐段</span>
            {batch?.running ? (
              <span className="paper-batch-progress">
                {batch.current}/{batch.total} · 成功 {batch.done} · 失败 {batch.failed}
              </span>
            ) : null}
          </div>
          <textarea
            className="paper-input"
            rows={2}
            placeholder="同一要求用于全部正文段落（每段独立修订、逐段审阅）。例如：统一术语、删空话套话、按 GB/T 7714 检查引文…"
            value={batchInstruction}
            onChange={(event) => setBatchInstruction(event.target.value)}
            disabled={batch?.running}
          />
          <div className="paper-batch-controls">
            <select value={batchModel} onChange={(event) => setBatchModel(event.target.value as ModelId)} disabled={batch?.running} aria-label="批量模型">
              {publicConfig.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select value={batchThinking} onChange={(event) => setBatchThinking(event.target.value as ThinkingLevel)} disabled={batch?.running} aria-label="批量思考强度">
              <option value="off">不思考（快）</option>
              <option value="low">低强度思考</option>
              <option value="high">高强度思考</option>
              <option value="max">最强思考</option>
            </select>
            {batch?.running ? (
              <button type="button" className="btn btn-sm" onClick={stopBatch}>
                停止
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void startBatch()} data-testid="paper-batch-start">
                逐段修改全文
              </button>
            )}
          </div>
          {batch && !batch.running ? (
            <div className="paper-batch-summary">
              批量修订完成：{batch.done} 段成功 / {batch.failed} 段失败，请在下方逐段审阅后接受。
            </div>
          ) : null}
        </div>
      </div>

      {groups.map((group, groupIndex) => (
        <div className="paper-section" key={groupIndex}>
          {group.sectionTitle ? (
            <div className="paper-section-label" title={group.sectionTitle}>
              {group.sectionTitle}
            </div>
          ) : (
            <div className="paper-section-label paper-section-label-muted">（无标题章节）</div>
          )}
          {group.paragraphs.map((paragraph) => {
            const job = jobFor(paragraph.id);
            const applied = appliedParagraphs.has(paragraph.id);
            const issueWarnCount = paragraph.aiIssues.filter((i) => i.severity === 'warn').length;
            const issueCount = paragraph.aiIssues.length;
            const unit = analysis.units[paragraph.unitIndex];
            const tableNormalized = paragraph.isTable ? normalizeTableText(paragraph.text) : null;
            return (
              <div className="paper-para" key={paragraph.id} data-testid={`paper-para-${paragraph.id}`}>
                <div className="paper-para-row">
                  <button type="button" className="paper-para-main" onClick={() => props.onJump(paragraph.from, paragraph.to)} title="点击在编辑器中定位该段">
                    <span className={`paper-kind paper-kind-${paragraph.kind}`}>{paragraph.isTable ? '表格' : kindLabel(paragraph.kind)}</span>
                    <span className="paper-para-snippet">
                      {paragraph.isTable && unit?.table
                        ? `${unit.table.columnCount} 列 × ${unit.table.rowCount} 行${unit.table.hasHeader ? ' · 含表头' : ' · 无表头'}`
                        : `${paragraph.plainText.slice(0, 64)}${paragraph.plainText.length > 64 ? '…' : ''}`}
                    </span>
                    <span className="paper-para-meta">
                      {paragraph.isTable && unit?.table ? null : <>{paragraph.words} 字</>}
                      {paragraph.citations.length > 0 ? <span className="paper-cite"> · 引 [{paragraph.citations.join(',')}]</span> : null}
                      {paragraph.images.length > 0 ? <span className="paper-cite"> · 图 {paragraph.images.length}</span> : null}
                      {issueCount > 0 ? (
                        <span className={`paper-issue-badge${issueWarnCount > 0 ? ' is-warn' : ''}`} title={paragraph.aiIssues.map((i) => `${AI_ISSUE_KIND_LABELS[i.kind]}：${i.message}`).join('\n')}>
                          {issueWarnCount > 0 ? `AI 痕迹 ${issueWarnCount}` : `提示 ${issueCount}`}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <div className="paper-para-side">
                    {applied ? <span className="paper-applied">已修改</span> : null}
                    {paragraph.isTable ? (
                      <button
                        type="button"
                        className="paper-tidy-btn"
                        disabled={!tableNormalized}
                        title={tableNormalized ? '规范化表格源码：统一列数、清理单元格空白、重建分隔行' : '表格源码已规范'}
                        onClick={() => {
                          if (!tableNormalized) return;
                          props.showToast('表格已规范化（Ctrl+Z 可撤销）');
                          props.onApplyChanges(
                            [{ from: paragraph.from, to: paragraph.to, oldText: paragraph.text, newText: tableNormalized }],
                            '表格排版整理',
                          );
                        }}
                      >
                        整理
                      </button>
                    ) : null}
                    {paragraph.revisable ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={Boolean(batch?.running)}
                        onClick={() => setEditingId(editingId === paragraph.id ? null : paragraph.id)}
                      >
                        修改
                      </button>
                    ) : (
                      <span className="paper-para-na" title={paragraph.notRevisableReason ?? undefined}>
                        {paragraph.notRevisableReason ?? '不可修订'}
                      </span>
                    )}
                  </div>
                </div>

                {unit?.table ? <TableBlock table={unit.table} /> : null}
                {paragraph.images.length > 0 ? <ImageRow images={paragraph.images} docId={props.docId} /> : null}

                {editingId === paragraph.id && paragraph.revisable ? (
                  <ParagraphForm
                    paragraph={paragraph}
                    defaultModel={publicConfig.paperModels.revise}
                    defaultThinking={publicConfig.paperDefaultThinking}
                    onSubmit={(instruction, model, thinking, webSearch) => void runRevise(paragraph, instruction, model, thinking, webSearch)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : null}

                {job ? renderJobDetail(job, paragraph) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ParagraphForm(props: {
  paragraph: PaperParagraph;
  defaultModel: ModelId;
  defaultThinking: ThinkingLevel;
  onSubmit: (instruction: string, model: ModelId, thinking: ThinkingLevel, webSearch: boolean) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION);
  const [model, setModel] = useState<ModelId>(props.defaultModel);
  const [thinking, setThinking] = useState<ThinkingLevel>(props.defaultThinking);
  const [webSearch, setWebSearch] = useState(false);
  return (
    <div className="paper-form" data-testid={`paper-form-${props.paragraph.id}`}>
      <textarea
        className="paper-input"
        rows={2}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={DEFAULT_INSTRUCTION}
        aria-label="修订要求"
      />
      <div className="paper-form-controls">
        <select value={webSearch ? 'deepseek-flash' : model} onChange={(event) => setModel(event.target.value as ModelId)} aria-label="模型">
          <option value="deepseek-flash">DeepSeek V4.1 Flash（快）</option>
          <option value="deepseek-v4-pro" disabled={webSearch}>DeepSeek V4 Pro（强）</option>
        </select>
        <select value={thinking} onChange={(event) => setThinking(event.target.value as ThinkingLevel)} aria-label="思考强度">
          <option value="off">不思考（快）</option>
          <option value="low">低强度思考</option>
          <option value="high">高强度思考</option>
          <option value="max">最强思考</option>
        </select>
        <label className="paper-web-toggle" title="联网搜索/阅读链接（仅 Flash；搜索计费约 5 元/千次）">
          <input
            type="checkbox"
            checked={webSearch}
            onChange={(event) => {
              const enabled = event.target.checked;
              setWebSearch(enabled);
              if (enabled) setModel('deepseek-flash');
            }}
            data-testid={`paper-web-${props.paragraph.id}`}
          />
          联网
        </label>
        <button type="button" className="link-btn" onClick={props.onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => props.onSubmit(instruction.trim(), model, thinking, webSearch)}
          data-testid={`paper-run-${props.paragraph.id}`}
        >
          开始修订
        </button>
      </div>
    </div>
  );
}

/** 解析图片地址：http(s)/data 直显；文档库相对路径走附件代理；其余不可显示 */
export function resolveImageSrc(src: string, docId: string | null): string | null {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('//')) return null;
  if (src.startsWith('/')) return src; // 站点根路径
  if (docId) {
    return `/api/docs/${encodeURIComponent(docId)}/attachments/${encodeURIComponent(src)}`;
  }
  return null;
}

function alignStyle(align: PaperTableData['align'][number]): { textAlign?: 'left' | 'center' | 'right' } {
  if (!align || align === 'left') return {};
  return { textAlign: align };
}

/** 结构化表格渲染：表头 + 数据行，单元格内联 Markdown 去除 */
function TableBlock({ table }: { table: PaperTableData }) {
  return (
    <div className="paper-table-wrap" data-testid="paper-table">
      <table className="paper-table">
        {table.hasHeader ? (
          <thead>
            <tr>
              {table.header.map((cell, i) => (
                <th key={i} style={alignStyle(table.align[i])}>
                  {stripMarkdownInline(cell) || ' '}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} style={alignStyle(table.align[ci])}>
                  {stripMarkdownInline(cell) || ' '}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="paper-table-meta">
        {table.columnCount} 列 × {table.rowCount} 行{table.hasHeader ? '（含表头）' : '（无表头行）'}
      </div>
    </div>
  );
}

/** 段落内图片缩略图；加载失败显示占位 */
function ImageRow({ images, docId }: { images: PaperImageRef[]; docId: string | null }) {
  return (
    <div className="paper-img-row" data-testid="paper-images">
      {images.map((image, i) => (
        <PaperImage key={i} image={image} docId={docId} />
      ))}
    </div>
  );
}

function PaperImage({ image, docId }: { image: PaperImageRef; docId: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = resolveImageSrc(image.src, docId);
  return (
    <figure className="paper-figure">
      {src && !failed ? (
        <a href={src} target="_blank" rel="noreferrer" title="点击查看原图">
          <img
            className="paper-img"
            src={src}
            alt={image.alt || '图片'}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </a>
      ) : (
        <div className="paper-img-placeholder" title={image.src}>
          <span aria-hidden="true">🖼</span>
          <span className="paper-img-placeholder-text">
            {image.alt || image.src || '图片'}
            {failed ? '（无法加载）' : ''}
          </span>
        </div>
      )}
      {image.alt ? <figcaption className="paper-img-caption">{image.alt}</figcaption> : null}
    </figure>
  );
}

/** 联网来源（论文段落修订期间实时展示搜索/阅读链接的来源） */
function PaperWebSources({ calls }: { calls: WebToolCall[] }) {
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    for (const source of call.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
    }
  }
  const completed = calls.filter((call) => call.status === 'completed').length;
  return (
    <div className="paper-web-sources" data-testid="paper-web-sources">
      <div className="paper-web-head">
        <span>联网来源</span>
        <span>{completed} 次搜索/抓取 · {sources.length} 条来源</span>
      </div>
      {sources.length === 0 ? (
        <p className="paper-web-empty">模型这次没有返回来源。</p>
      ) : (
        <ul>
          {sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title || source.url}
              </a>
              {source.siteName ? <span className="paper-web-site"> · {source.siteName}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
