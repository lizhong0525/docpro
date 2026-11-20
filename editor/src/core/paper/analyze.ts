/**
 * analyzePaper —— 论文助手的主入口（确定性、纯本地、可在浏览器直接执行）。
 *
 * 一次调用得到：结构单元、章节、可修订段落、参考文献完整性报告、AI 痕迹扫描。
 * 全部结果基于同一份文档快照，段落带 offset，可直接用于跳转与修订请求。
 */
import { buildReferenceReport } from './refs';
import { buildSections, classifyParagraphKind, extractImages, isUnitRevisable, notRevisableReason, parsePaperBlocks } from './parse';
import { scanParagraphIssues, scanRepeatedOpenings } from './scan';
import type { AiIssue, PaperAnalysis, PaperParagraph, ReferenceFormatSettings } from './types';

export interface AnalyzeOptions {
  /** 用于格式提示的引用格式设置（可选） */
  referenceFormat?: ReferenceFormatSettings | null;
}

export function analyzePaper(docText: string, options: AnalyzeOptions = {}): PaperAnalysis {
  const units = parsePaperBlocks(docText);
  const sections = buildSections(units);
  const references = buildReferenceReport(docText, units, options.referenceFormat ?? null);

  // 单元 → 所属章节
  const sectionByUnit = new Map<number, ReturnType<typeof buildSections>[number]>();
  for (const section of sections) {
    for (const unitIndex of section.unitIndexes) sectionByUnit.set(unitIndex, section);
  }

  // 第一个「内容」单元（用于题目判定）
  const firstContentIndex = units.findIndex((unit) => unit.kind === 'text' && unit.plainText.trim().length > 0);

  // 跨段重复开头
  const repeatedOpenings = new Set(scanRepeatedOpenings(units).map((item) => item.unitIndex));

  // 段落组装
  const paragraphs: PaperParagraph[] = [];
  const citationSetByUnit = new Map<number, number[]>();
  const authorYearByUnit = new Map<number, string[]>();
  for (const citation of references.citations) {
    if (citation.paragraphIndex < 0) continue;
    const list = citationSetByUnit.get(citation.paragraphIndex) ?? [];
    for (const idx of citation.indexes) if (!list.includes(idx)) list.push(idx);
    citationSetByUnit.set(citation.paragraphIndex, list);
  }
  for (const ay of references.authorYear) {
    if (ay.paragraphIndex < 0) continue;
    const list = authorYearByUnit.get(ay.paragraphIndex) ?? [];
    list.push(ay.raw);
    authorYearByUnit.set(ay.paragraphIndex, list);
  }

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const section = sectionByUnit.get(unit.index) ?? null;
    const kind = classifyParagraphKind(unit, section, unit.index === firstContentIndex);
    // 参考文献章节内的条目由「参考文献」标签页统一管理，不参与逐段修订
    const revisable = isUnitRevisable(unit) && kind !== 'references';
    const reason = notRevisableReason(unit, kind);
    const unitIssues: Omit<AiIssue, 'paragraphIndex'>[] = scanParagraphIssues(unit, repeatedOpenings);
    paragraphs.push({
      id: `p${i}`,
      unitIndex: unit.index,
      kind,
      from: unit.from,
      to: unit.to,
      lineStart: unit.lineStart,
      lineEnd: unit.lineEnd,
      sectionTitle: section?.title ?? null,
      sectionKind: section?.kind ?? null,
      text: unit.text,
      plainText: unit.plainText,
      words: unit.words,
      citations: citationSetByUnit.get(unit.index) ?? [],
      authorYearCitations: authorYearByUnit.get(unit.index) ?? [],
      aiIssues: unitIssues.map((issue) => ({ ...issue, paragraphIndex: i })),
      images: extractImages(unit.text),
      isTable: unit.kind === 'table',
      revisable,
      notRevisableReason: reason,
    });
  }

  const issues: AiIssue[] = paragraphs.flatMap((p) => p.aiIssues);

  // 章节区间内的单元计数等统计
  const titleUnit = firstContentIndex >= 0 ? units[firstContentIndex] : null;

  return {
    title: titleUnit ? titleUnit.plainText.slice(0, 120) : null,
    units,
    sections,
    paragraphs,
    references,
    issues,
    stats: {
      units: units.length,
      paragraphs: paragraphs.length,
      revisableParagraphs: paragraphs.filter((p) => p.revisable).length,
      chars: docText.length,
      words: paragraphs.reduce((sum, p) => sum + p.words, 0),
      headings: units.filter((u) => u.kind === 'heading').length,
      refs: references.totalRefs,
      citations: references.totalCitations,
      issues: issues.length,
    },
  };
}
