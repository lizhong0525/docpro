/**
 * 记忆 · 要求：论文助手的「底层格式逻辑/要求」输入区。
 *
 * 内容会注入每次逐段修订与参考文献重排的系统提示词：
 * - 总体要求（自由文本）：目标期刊、审稿要求、格式逻辑、硬性约束；
 * - 参考文献格式：GB/T 7714-2015（顺序编码制）/ APA 第 7 版 / 自定义模板；
 * - 术语表：每行「术语：说明」；
 * - 风格与语言要求。
 *
 * 保存是自动的（防抖），随文档走：文档库文档存文档文件夹，本地文件存指纹存储。
 */
import type { PaperMemory, PaperTerm, ReferenceFormatId } from '../../core/paper/types';
import { REFERENCE_FORMAT_TEMPLATES } from '../../core/paper/refs';
import { parseTerminologyText } from '../../core/paper/memory';

export interface PaperMemoryTabProps {
  memory: PaperMemory;
  onChange: (memory: PaperMemory) => void;
}

function terminologyToText(terms: PaperTerm[]): string {
  return terms.map((t) => (t.note ? `${t.term}：${t.note}` : t.term)).join('\n');
}

export function PaperMemoryTab(props: PaperMemoryTabProps) {
  const { memory, onChange } = props;
  const format = memory.referenceFormat;

  const patch = (partial: Partial<PaperMemory>) => onChange({ ...memory, ...partial, updatedAt: Date.now() });
  const patchFormat = (partial: Partial<PaperMemory['referenceFormat']>) =>
    patch({ referenceFormat: { ...format, ...partial } });

  return (
    <div className="paper-tab-content paper-memory-tab">
      <div className="paper-section">
        <div className="paper-section-title">论文要求（自由文本）</div>
        <div className="paper-section-desc">目标期刊/会议、格式逻辑、审稿硬性要求……优先级最高，随每次修订注入。</div>
        <textarea
          className="paper-input"
          rows={6}
          placeholder={'示例：\n- 目标期刊：某某学报（CSSCI）；\n- 摘要 250–300 字，含目的/方法/结果/结论四要素；\n- 正文标题层级不超过三级（1 / 1.1 / 1.1.1）；\n- 图题在图下方居中，表题在表上方居中；\n- 数值保留两位小数，单位用国际单位制。'}
          value={memory.requirements}
          onChange={(event) => patch({ requirements: event.target.value })}
          aria-label="论文要求"
        />
      </div>

      <div className="paper-section">
        <div className="paper-section-title">目标场合</div>
        <input
          className="paper-input"
          type="text"
          placeholder="如：某某大学学报 / 硕士学位论文 / 会议投稿"
          value={memory.targetVenue}
          onChange={(event) => patch({ targetVenue: event.target.value })}
          aria-label="目标场合"
        />
      </div>

      <div className="paper-section">
        <div className="paper-section-title">参考文献格式</div>
        <div className="paper-section-desc">决定「参考文献」标签页的格式检查与 AI 重排规则。</div>
        <select
          className="paper-input"
          value={format.preset}
          onChange={(event) => patchFormat({ preset: event.target.value as ReferenceFormatId })}
          aria-label="引用格式预设"
        >
          <option value="gb-t7714">GB/T 7714-2015（顺序编码制）</option>
          <option value="apa7">APA 第 7 版（著者-出版年）</option>
          <option value="custom">自定义模板</option>
        </select>
        {format.preset === 'custom' ? (
          <textarea
            className="paper-input"
            rows={2}
            placeholder="自定义模板，如：作者. 题名. 刊名, 出版年, 卷(期): 页码. DOI"
            value={format.customTemplate}
            onChange={(event) => patchFormat({ customTemplate: event.target.value })}
            aria-label="自定义引用模板"
          />
        ) : (
          <div className="paper-format-hint">
            <div className="paper-format-template">{REFERENCE_FORMAT_TEMPLATES[format.preset]?.template}</div>
            <div className="paper-format-rules">{REFERENCE_FORMAT_TEMPLATES[format.preset]?.rules}</div>
          </div>
        )}
        <textarea
          className="paper-input"
          rows={2}
          placeholder="补充规则（可选）：如「同一文献多次引用用同一序号」「英文文献句末用句点」"
          value={format.note}
          onChange={(event) => patchFormat({ note: event.target.value })}
          aria-label="引用格式补充规则"
        />
      </div>

      <div className="paper-section">
        <div className="paper-section-title">术语表</div>
        <div className="paper-section-desc">每行一条：术语 或 术语：说明（中文冒号/等号均可）。</div>
        <textarea
          className="paper-input"
          rows={4}
          placeholder={'注意力机制：attention mechanism\nBERT\nF1 值：精确率与召回率的调和平均'}
          value={terminologyToText(memory.terminology)}
          onChange={(event) => patch({ terminology: parseTerminologyText(event.target.value) })}
          aria-label="术语表"
        />
      </div>

      <div className="paper-section">
        <div className="paper-section-title">风格与语言要求</div>
        <textarea
          className="paper-input"
          rows={3}
          placeholder="如：第三人称客观表述；不用「我们」抒情；避免感叹号；句式完整，不写网络流行语…"
          value={memory.styleNotes}
          onChange={(event) => patch({ styleNotes: event.target.value })}
          aria-label="风格要求"
        />
      </div>

      <div className="paper-memory-note">✓ 内容自动保存；随每次逐段修订与参考文献重排注入模型上下文。</div>
    </div>
  );
}
