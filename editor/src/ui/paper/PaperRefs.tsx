/**
 * 参考文献标签页：
 * - 完整性报告（未引用 / 未定义 / 疑似重复）全部本地确定性计算；
 * - 条目明细：引用次数、字段（年份/类型/DOI）、格式问题提示；
 * - 「AI 重排格式」：按记忆中的引用格式（GB/T 7714 / APA / 自定义模板）逐条重排，
 *   结果先 diff 审阅，应用时按快照校验，编造条目会被服务端拒绝。
 */
import { useMemo, useState } from 'react';
import type { PaperAnalysis, PaperMemory, RefFixEntry, RefVerifyEntry } from '../../core/paper/types';
import type { PublicConfig } from '../../core/protocol';
import { refsFix, verifyRefs } from './paperApi';
import type { PaperChange } from './PaperPanel';
import { DiffView } from '../DiffView';

export interface PaperRefsProps {
  analysis: PaperAnalysis;
  docText: string;
  docTitle: string;
  memory: PaperMemory;
  publicConfig: PublicConfig;
  onJump: (from: number, to: number) => void;
  onApplyChanges: (changes: PaperChange[], note: string) => void;
  showToast: (text: string) => void;
}

export function PaperRefs(props: PaperRefsProps) {
  const { analysis } = props;
  const report = analysis.references;
  const [busy, setBusy] = useState(false);
  const [fixEntries, setFixEntries] = useState<RefFixEntry[] | null>(null);
  const [fixWarnings, setFixWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /* 联网核实 */
  const [verifying, setVerifying] = useState(false);
  const [verifyEntries, setVerifyEntries] = useState<RefVerifyEntry[] | null>(null);
  const [verifySearched, setVerifySearched] = useState(0);

  const paragraphByUnit = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of analysis.paragraphs) {
      map.set(p.unitIndex, p.plainText.slice(0, 40));
    }
    return map;
  }, [analysis.paragraphs]);

  const entryById = useMemo(() => new Map(report.entries.map((e) => [e.index, e])), [report.entries]);

  const runFix = async () => {
    setBusy(true);
    try {
      const result = await refsFix(props.docText, props.docTitle, props.memory, {
        model: props.publicConfig.paperModels.refs,
        thinking: 'off',
      });
      setFixEntries(result.entries);
      setFixWarnings(result.warnings.map((w) => w.message));
      const changed = new Set(result.entries.filter((e) => e.changed).map((e) => e.index));
      setSelected(changed);
      if (!result.entries.some((e) => e.changed)) {
        props.showToast('模型认为当前格式已符合要求，无需调整');
      }
    } catch (err) {
      props.showToast(`重排失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const runVerify = async () => {
    setVerifying(true);
    try {
      const result = await verifyRefs(props.docText, props.docTitle);
      setVerifyEntries(result.entries);
      setVerifySearched(result.searched);
      if (result.searched === 0 && result.entries.length === 0) {
        props.showToast('没有可核实的参考文献条目');
      } else {
        const suspicious = result.entries.filter((entry) => entry.verdict === 'suspicious').length;
        props.showToast(`已联网核实 ${result.entries.length} 条（搜索 ${result.searched} 次）${suspicious > 0 ? `，其中 ${suspicious} 条需人工核实` : ''}`);
      }
    } catch (err) {
      props.showToast(`联网核实失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVerifying(false);
    }
  };

  const applySelected = () => {
    if (!fixEntries) return;
    const chosen = fixEntries.filter((e) => e.changed && selected.has(e.index));
    if (chosen.length === 0) {
      props.showToast('没有选中任何改动');
      return;
    }
    const changes: PaperChange[] = chosen.map((e) => {
      const entry = entryById.get(e.index);
      return { from: entry?.from ?? 0, to: entry?.to ?? 0, oldText: e.oldText, newText: e.newText };
    });
    props.onApplyChanges(changes, `参考文献格式重排（${chosen.length} 条）`);
    setFixEntries(null);
    setFixWarnings([]);
  };

  return (
    <div className="paper-tab-content">
      <div className="paper-section">
        <div className="paper-section-head">
          <div>
            <div className="paper-section-title">参考文献</div>
            <div className="paper-section-desc">
              完整性检查在本地完成，不消耗模型调用；「AI 重排格式」按「记忆 · 要求」中的格式规范逐条整理。
            </div>
          </div>
        </div>

        <div className="paper-ref-stats">
          <span>共 {report.totalRefs} 条</span>
          <span className={report.uncited.length > 0 ? 'is-warn' : ''}>未被引用 {report.uncited.length}</span>
          <span className={report.undefined.length > 0 ? 'is-danger' : ''}>未定义引用 {report.undefined.length}</span>
          <span className={report.duplicates.length > 0 ? 'is-warn' : ''}>疑似重复 {report.duplicates.length}</span>
        </div>

        {report.sectionRange === null ? (
          <div className="paper-empty-note">
            没有检测到参考文献章节（需要一个标题含「参考文献 / References」的章节）。
          </div>
        ) : null}

        {report.undefined.length > 0 ? (
          <div className="paper-ref-issue">
            <div className="paper-ref-issue-title">正文引用了、但文末没有对应条目（典型 AI 编造引文）</div>
            {report.undefined.map((item, i) => (
              <div className="paper-ref-issue-row" key={i}>
                <span className="paper-ref-badge is-danger">{item.raw}</span>
                <button type="button" className="link-btn" onClick={() => props.onJump(...jumpFor(analysis, item.paragraphIndex))}>
                  {paragraphByUnit.get(item.paragraphIndex) ?? '定位到段落'}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {report.uncited.length > 0 ? (
          <div className="paper-ref-issue">
            <div className="paper-ref-issue-title">文末列出了、但正文从未引用（{report.uncited.length} 条）</div>
            <div className="paper-ref-issue-note">建议在正文相应位置补引，或删除多余条目。</div>
            {report.uncited.map((entry) => (
              <div className="paper-ref-issue-row" key={entry.index}>
                <span className="paper-ref-badge">[{entry.index}]</span>
                <span className="paper-ref-issue-text">{entry.text.slice(0, 60)}{entry.text.length > 60 ? '…' : ''}</span>
              </div>
            ))}
          </div>
        ) : null}

        {report.duplicates.length > 0 ? (
          <div className="paper-ref-issue">
            <div className="paper-ref-issue-title">疑似重复条目</div>
            {report.duplicates.map((pair, i) => (
              <div className="paper-ref-issue-row" key={i}>
                <span className="paper-ref-badge is-warn">
                  [{pair.a}] ≈ [{pair.b}]
                </span>
                <span className="paper-ref-issue-text">{entryById.get(pair.a)?.text.slice(0, 50)}…</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="paper-section">
        <div className="paper-section-head">
          <div className="paper-section-title">条目明细</div>
          <span className="paper-ref-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void runVerify()}
              disabled={verifying || report.entries.length === 0}
              title="用 DeepSeek Search API 逐条检索，判断文献是否真实存在（每次最多 20 条，搜索计费约 5 元/千次）"
              data-testid="paper-refs-verify"
            >
              {verifying ? '核实中…' : '联网核实'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void runFix()} disabled={busy || report.entries.length === 0} data-testid="paper-refs-fix">
              {busy ? '重排中…' : 'AI 重排格式'}
            </button>
          </span>
        </div>

        {verifyEntries ? (
          <div className="paper-verify" data-testid="paper-verify">
            <div className="paper-ref-fix-head">
              <span>
                联网核实结果（{verifyEntries.length} 条 · 搜索 {verifySearched} 次）
              </span>
              <button type="button" className="link-btn" onClick={() => setVerifyEntries(null)}>
                收起
              </button>
            </div>
            {verifyEntries.map((entry) => (
              <div className={`paper-verify-entry is-${entry.verdict}`} key={entry.index}>
                <div className="paper-verify-head">
                  <span className="paper-ref-badge">[{entry.index}]</span>
                  <span className={`paper-verify-verdict is-${entry.verdict}`}>
                    {entry.verdict === 'found' ? '✅ 找到来源' : entry.verdict === 'suspicious' ? '⚠ 需人工核实' : '❓ 未核实'}
                  </span>
                  <span className="paper-verify-score">相似度 {Math.round(entry.score * 100)}%</span>
                </div>
                <div className="paper-verify-reason">{entry.reason}</div>
                {entry.query ? <div className="paper-verify-query">检索词：{entry.query}</div> : null}
                {entry.matches.length > 0 ? (
                  <ul className="paper-verify-matches">
                    {entry.matches.slice(0, 3).map((match) => (
                      <li key={match.url}>
                        <a href={match.url} target="_blank" rel="noreferrer">
                          {match.title || match.url}
                        </a>
                        {match.siteName ? <span className="paper-verify-site"> · {match.siteName}</span> : null}
                        {match.publishedAt ? <span className="paper-verify-date"> · {match.publishedAt.slice(0, 10)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
            <p className="paper-verify-note">
              核实结果基于 DeepSeek 搜索的置信度打分，仅作参考：找不到不代表文献不存在（可能未被收录），找到也请核对作者与年份。
            </p>
          </div>
        ) : null}

        {fixWarnings.length > 0 ? (
          <div className="paper-warnings">
            {fixWarnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        ) : null}

        {fixEntries ? (
          <div className="paper-ref-fix">
            <div className="paper-ref-fix-head">
              <span>逐条审阅改动（{fixEntries.filter((e) => e.changed).length} 条有改动）</span>
              <span>
                <button type="button" className="link-btn" onClick={() => setSelected(new Set(fixEntries.filter((e) => e.changed).map((e) => e.index)))}>
                  全选改动
                </button>
                <button type="button" className="link-btn" onClick={() => { setFixEntries(null); setFixWarnings([]); }}>
                  放弃
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={applySelected} data-testid="paper-refs-apply">
                  应用 {selected.size} 条
                </button>
              </span>
            </div>
            {fixEntries.map((entry) =>
              entry.changed ? (
                <div className="paper-ref-fix-entry" key={entry.index}>
                  <label className="paper-ref-fix-label">
                    <input
                      type="checkbox"
                      checked={selected.has(entry.index)}
                      onChange={() =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (next.has(entry.index)) next.delete(entry.index);
                          else next.add(entry.index);
                          return next;
                        })
                      }
                    />
                    <span className="paper-ref-badge">[{entry.index}]</span>
                  </label>
                  <div className="paper-ref-fix-diff">
                    <DiffView before={entry.oldText} after={entry.newText} />
                  </div>
                </div>
              ) : null,
            )}
          </div>
        ) : null}

        {report.entries.length === 0 ? null : (
          <div className="paper-ref-list">
            {report.entries.map((entry) => (
              <div className="paper-ref-item" key={entry.index}>
                <div className="paper-ref-item-head">
                  <span className="paper-ref-badge">[{entry.index}]</span>
                  <span className="paper-ref-cite-count" title="正文引用次数">
                    被引 {entry.citeCount}
                  </span>
                  {entry.fields.year ? <span className="paper-ref-field">年 {entry.fields.year}</span> : <span className="paper-ref-field is-missing">缺年份</span>}
                  {entry.fields.typeMarker ? <span className="paper-ref-field">{entry.fields.typeMarker}</span> : null}
                  {entry.fields.doi ? <span className="paper-ref-field">DOI</span> : null}
                  {entry.formatHints.length > 0 ? (
                    <span className="paper-ref-hints" title={entry.formatHints.join('；')}>
                      {entry.formatHints.length} 项格式提示
                    </span>
                  ) : null}
                </div>
                <div className="paper-ref-item-text">{entry.text}</div>
                {entry.formatHints.length > 0 ? (
                  <div className="paper-ref-hint-list">
                    {entry.formatHints.map((hint, i) => (
                      <span key={i}>{hint}</span>
                    ))}
                  </div>
                ) : null}
                {entry.citedByParagraphs.length > 0 ? (
                  <div className="paper-ref-cited">
                    引用位置：
                    {entry.citedByParagraphs.map((unitIndex, i) => (
                      <button key={i} type="button" className="link-btn" onClick={() => props.onJump(...jumpFor(analysis, unitIndex))}>
                        {paragraphByUnit.get(unitIndex) ?? `段 ${unitIndex + 1}`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 由段落 unitIndex 得到跳转区间 */
function jumpFor(analysis: PaperAnalysis, paragraphIndex: number): [number, number] {
  const paragraph = analysis.paragraphs.find((p) => p.unitIndex === paragraphIndex);
  if (paragraph) return [paragraph.from, paragraph.to];
  const unit = analysis.units[paragraphIndex];
  return unit ? [unit.from, unit.to] : [0, 0];
}
