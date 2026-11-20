/**
 * AI 扫描标签页：把确定性扫描到的「AI 痕迹 / 论文垃圾」问题按严重级分组展示，
 * 点击可定位到对应段落。扫描不调用模型，文档每次变化即时更新。
 */
import type { PaperAnalysis } from '../../core/paper/types';
import { AI_ISSUE_KIND_LABELS } from '../../core/paper/scan';

export interface PaperScanProps {
  analysis: PaperAnalysis;
  onJump: (from: number, to: number) => void;
}

export function PaperScan(props: PaperScanProps) {
  const { analysis, onJump } = props;
  const warns = analysis.issues.filter((issue) => issue.severity === 'warn');
  const infos = analysis.issues.filter((issue) => issue.severity === 'info');

  return (
    <div className="paper-tab-content">
      <div className="paper-section">
        <div className="paper-section-head">
          <div>
            <div className="paper-section-title">AI 痕迹扫描</div>
            <div className="paper-section-desc">
              确定性规则扫描（本地、免费、即时）：{warns.length} 项需处理，{infos.length} 项建议核对。
            </div>
          </div>
        </div>
        {analysis.issues.length === 0 ? (
          <div className="paper-empty-note">未发现明显的 AI 行文痕迹。扫描只查模式，不替代人工判断。</div>
        ) : null}
      </div>

      <IssueGroup
        title={`需处理（${warns.length}）`}
        issues={warns}
        analysis={analysis}
        onJump={onJump}
        tone="warn"
      />
      <IssueGroup
        title={`建议核对（${infos.length}）`}
        issues={infos}
        analysis={analysis}
        onJump={onJump}
        tone="info"
      />
    </div>
  );
}

function IssueGroup(props: {
  title: string;
  issues: PaperAnalysis['issues'];
  analysis: PaperAnalysis;
  onJump: (from: number, to: number) => void;
  tone: 'warn' | 'info';
}) {
  if (props.issues.length === 0) return null;
  return (
    <div className="paper-section">
      <div className={`paper-section-label ${props.tone === 'warn' ? 'paper-label-warn' : ''}`}>{props.title}</div>
      {props.issues.map((issue, i) => {
        const paragraph = props.analysis.paragraphs[issue.paragraphIndex];
        const snippet = paragraph ? paragraph.plainText.slice(0, 48) : '';
        return (
          <div className="paper-issue-row" key={i}>
            <span className={`paper-issue-kind is-${issue.severity}`}>{AI_ISSUE_KIND_LABELS[issue.kind]}</span>
            <div className="paper-issue-body">
              <div className="paper-issue-message">{issue.message}</div>
              {issue.matches.length > 0 ? (
                <div className="paper-issue-matches">
                  {issue.matches.map((m, j) => (
                    <code key={j}>{m}</code>
                  ))}
                </div>
              ) : null}
              {paragraph ? (
                <button type="button" className="link-btn" onClick={() => props.onJump(paragraph.from, paragraph.to)}>
                  {snippet}
                  {paragraph.plainText.length > 48 ? '…' : ''} · 第 {paragraph.lineStart} 行
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
