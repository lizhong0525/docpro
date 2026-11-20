/**
 * 论文助手（Paper Assistant）核心类型 —— 客户端与服务端共享的唯一契约。
 *
 * 设计要点：
 * - 结构解析、参考文献完整性检查、AI 痕迹扫描全部是**确定性本地计算**，
 *   不消耗模型调用，随时可重算（analyzePaper 在浏览器内直接执行）。
 * - 只有「逐段修订」与「参考文献格式重排」调用 DeepSeek；服务端用快照
 *   （偏移 + 原文 + 指纹）校验修订目标，输出经过引文保护的提案。
 */
import type { CitationRef, ModelId, ThinkingLevel, Timings, Usage, WebToolCall } from '../types';

/** 引用格式预设 id（GB/T 7714 顺序编码制 / APA 著者-出版年 / 自定义模板） */
export type ReferenceFormatId = 'gb-t7714' | 'apa7' | 'custom';

/** 论文结构单元的类型 */
export type PaperUnitKind =
  | 'heading'
  | 'text'
  | 'list'
  | 'table'
  | 'code'
  | 'quote'
  | 'hr'
  | 'frontmatter'
  | 'html'
  | 'blank';

/** 章节的语义类型（由标题文字识别） */
export type PaperSectionKind =
  | 'abstract'
  | 'keywords'
  | 'intro'
  | 'references'
  | 'acknowledgment'
  | 'appendix'
  | 'conclusion'
  | 'body';

/** 段落的语义类型（决定它能否被逐段修订、以及提示词中的角色） */
export type PaperParagraphKind =
  | 'title'
  | 'front'
  | 'abstract'
  | 'keywords'
  | 'body'
  | 'references'
  | 'acknowledgment'
  | 'appendix'
  | 'heading';

/** 论文结构单元（块）：行级聚合的最小修订单位 */
export interface PaperUnit {
  id: string;
  index: number;
  kind: PaperUnitKind;
  from: number;
  to: number;
  /** 1-based 起始/结束行号（用于 UI 展示与跳转） */
  lineStart: number;
  lineEnd: number;
  /** 标题块时为标题级别（1-6），否则为 null */
  headingLevel: number | null;
  /** 标题块时的标题文字 */
  headingText: string | null;
  text: string;
  plainText: string;
  /** UTF-16 字符数 */
  chars: number;
  words: number;
  /** 表格块时解析出的结构化数据，否则为 null */
  table: PaperTableData | null;
}

/** 结构化表格（Markdown 管道表格解析结果） */
export interface PaperTableData {
  /** 表头单元格（无分隔行时为 null） */
  header: string[];
  /** 数据行（不含表头与分隔行） */
  rows: string[][];
  columnCount: number;
  rowCount: number;
  /** 是否存在 `---` 分隔行（true 表示第一行是表头） */
  hasHeader: boolean;
  /** 每列对齐方式（来自分隔行 `:---:`） */
  align: Array<'left' | 'center' | 'right' | null>;
}

/** 段落中引用的图片 */
export interface PaperImageRef {
  alt: string;
  src: string;
}

/** 章节：一个标题及其辖域 */
export interface PaperSection {
  headingLevel: number | null;
  title: string | null;
  kind: PaperSectionKind;
  from: number;
  to: number;
  /** 该章节下的单元索引 */
  unitIndexes: number[];
}

/** 段落 = 可修订的单元 + 语义与上下文（由 analyzePaper 组装） */
export interface PaperParagraph {
  id: string;
  unitIndex: number;
  kind: PaperParagraphKind;
  from: number;
  to: number;
  lineStart: number;
  lineEnd: number;
  /** 所属章节标题（最近一个标题）；无标题时为 null */
  sectionTitle: string | null;
  sectionKind: PaperSectionKind | null;
  text: string;
  plainText: string;
  words: number;
  /** 本段引用的参考文献序号（[n] 展开后去重） */
  citations: number[];
  /** 本段引用作者-年份样式的原文片段 */
  authorYearCitations: string[];
  /** 本段命中的 AI 痕迹问题 */
  aiIssues: AiIssue[];
  /** 本段引用的图片 */
  images: PaperImageRef[];
  /** 本段是否为表格块（表格用结构化渲染，仍可逐段修订） */
  isTable: boolean;
  /** 可逐段修订 */
  revisable: boolean;
  /** 不可修订的原因（如：属于参考文献条目） */
  notRevisableReason: string | null;
}

/** 参考文献条目（文末列表中的一条） */
export interface ReferenceEntry {
  /** 引用序号（正文 [n] 使用的编号；1-based） */
  index: number;
  from: number;
  to: number;
  text: string;
  /** 启发式抽取的字段 */
  fields: {
    authors: string | null;
    year: string | null;
    title: string | null;
    typeMarker: string | null;
    doi: string | null;
  };
  /** 引用它的段落 unitIndex 列表 */
  citedByParagraphs: number[];
  /** 正文中出现该序号的次数（含同一段的多次） */
  citeCount: number;
  /** 格式问题提示（确定性启发式） */
  formatHints: string[];
  /** 与它疑似重复的条目序号 */
  duplicateOf: number | null;
}

/** 正文中的一条编号引用（如 [3]、[1,3-5]） */
export interface CitationMatch {
  raw: string;
  from: number;
  to: number;
  paragraphIndex: number;
  /** 展开后的单个序号 */
  indexes: number[];
}

/** 正文中的作者-年份引用（如 (Smith et al., 2020)） */
export interface AuthorYearCitation {
  raw: string;
  from: number;
  to: number;
  paragraphIndex: number;
  surname: string;
  year: string;
  /** 匹配到的条目序号；null = 未在文末列表中找到 */
  matchedIndex: number | null;
}

export interface ReferenceReport {
  /** 参考文献章节的文档区间；没有参考文献章节时为 null */
  sectionRange: { from: number; to: number } | null;
  entries: ReferenceEntry[];
  citations: CitationMatch[];
  authorYear: AuthorYearCitation[];
  /** 文末定义了、但正文从未引用的条目 */
  uncited: ReferenceEntry[];
  /** 正文引用了、但文末没有对应条目的序号（含原文片段） */
  undefined: { index: number; raw: string; paragraphIndex: number }[];
  /** 疑似重复条目对 */
  duplicates: { a: number; b: number }[];
  totalRefs: number;
  totalCitations: number;
}

/** AI 痕迹问题的确定性扫描结果 */
export type AiIssueKind =
  | 'sequence-filler'
  | 'empty-connector'
  | 'buzzword'
  | 'template-phrase'
  | 'ai-self-reference'
  | 'placeholder'
  | 'uncited-claim'
  | 'repeated-opening'
  | 'excessive-dash'
  | 'bullet-soup';

export interface AiIssue {
  kind: AiIssueKind;
  severity: 'info' | 'warn';
  message: string;
  /** 命中的原文片段（最多 5 个） */
  matches: string[];
  paragraphIndex: number;
}

/** 全文解析结果：结构 + 参考文献 + AI 扫描（全部确定性） */
export interface PaperAnalysis {
  title: string | null;
  units: PaperUnit[];
  sections: PaperSection[];
  paragraphs: PaperParagraph[];
  references: ReferenceReport;
  issues: AiIssue[];
  stats: {
    units: number;
    paragraphs: number;
    revisableParagraphs: number;
    chars: number;
    words: number;
    headings: number;
    refs: number;
    citations: number;
    issues: number;
  };
}

/* ------------------------------ 记忆（上下文补充） ------------------------------ */

/** 参考文献格式设置 */
export interface ReferenceFormatSettings {
  preset: ReferenceFormatId;
  /** preset 为 custom 时的自定义模板（可含 {作者} {题名} {刊名} {出版年} {页码} 等占位符） */
  customTemplate: string;
  /** 额外规则说明（自由文本） */
  note: string;
}

/** 术语表条目 */
export interface PaperTerm {
  term: string;
  note: string;
}

/** 论文记忆：用户补充的、随每次修订注入模型提示词的上下文 */
export interface PaperMemory {
  version: 1;
  /** 论文总体要求（自由文本：目标期刊、格式逻辑、审稿要求等） */
  requirements: string;
  /** 目标场合（期刊/会议/课程名） */
  targetVenue: string;
  /** 参考文献格式要求 */
  referenceFormat: ReferenceFormatSettings;
  /** 术语表 */
  terminology: PaperTerm[];
  /** 风格与语言要求 */
  styleNotes: string;
  updatedAt: number;
}

/* ------------------------------ 修订请求 / 提案 ------------------------------ */

/** 一次逐段修订请求 */
export interface PaperReviseRequest {
  requestId: string;
  docTitle: string;
  docText: string;
  paragraphId: string;
  from: number;
  to: number;
  /** 请求发出时该段原文（服务端应用前再次比对） */
  oldText: string;
  hash: string;
  instruction: string;
  memory: PaperMemory;
  options: {
    model: ModelId;
    thinking: ThinkingLevel;
    /** 联网搜索（DeepSeek 全家桶工具，仅 deepseek-flash） */
    webSearch?: boolean;
  };
}

export type PaperWarningCode =
  | 'truncated'
  | 'context-leak'
  | 'citation-dropped'
  | 'citation-added'
  | 'citation-invalid'
  | 'citation-format-changed'
  | 'author-year-dropped'
  | 'table-structure'
  | 'fence-sanitized'
  | 'no-change'
  | 'empty-result'
  | 'repair-applied'
  | 'other';

export interface PaperWarning {
  code: PaperWarningCode;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

/** 服务端校验后的逐段修订提案 */
export interface PaperReviseProposal {
  requestId: string;
  paragraphId: string;
  from: number;
  to: number;
  oldText: string;
  newText: string;
  warnings: PaperWarning[];
  truncated: boolean;
  usage: Usage;
  timings: Timings;
  /** 联网工具执行的步骤（搜索/阅读链接） */
  webCalls?: WebToolCall[];
  /** 回答中的引用标注 */
  citations?: CitationRef[];
  raw?: string;
}

/** 论文助手的 SSE 事件 */
export type PaperServerEvent =
  | { type: 'meta'; requestId: string; paragraphId: string; model: ModelId; startedAt: number }
  | {
      type: 'status';
      phase: 'connecting' | 'thinking' | 'streaming' | 'validating' | 'repairing' | 'done';
      note?: string;
      attempt?: number;
    }
  | { type: 'reasoning'; delta: string }
  | { type: 'delta'; text: string }
  /** 联网工具执行了一步（搜索/阅读链接），携带来源 */
  | { type: 'web'; call: WebToolCall }
  /** 回答中的一条引用标注 */
  | { type: 'citation'; citation: CitationRef }
  | { type: 'proposal'; proposal: PaperReviseProposal }
  | { type: 'error'; code: string; message: string; detail?: string; retryable: boolean }
  | { type: 'done'; requestId: string; usage: Usage; timings: Timings };

/** 参考文献联网核实：单条搜索结果 */
export interface RefVerifyMatch {
  url: string;
  title: string;
  snippet?: string;
  summary?: string;
  siteName?: string | null;
  publishedAt?: string | null;
  rerankScore?: number;
}

export interface RefVerifyEntry {
  /** 文末参考文献序号 */
  index: number;
  /** 实际发起的搜索词 */
  query: string;
  /** found=找到高匹配来源；suspicious=未找到/弱匹配，需人工核实；unverified=搜索失败 */
  verdict: 'found' | 'suspicious' | 'unverified';
  /** 最佳标题相似度 0~1 */
  score: number;
  reason: string;
  matches: RefVerifyMatch[];
}

export interface RefVerifyResponse {
  ok: boolean;
  entries: RefVerifyEntry[];
  /** 实际发起的搜索次数（计费口径） */
  searched: number;
  error?: string;
}

/** 参考文献格式重排：单条结果 */
export interface RefFixEntry {
  index: number;
  oldText: string;
  newText: string;
  changed: boolean;
}

export interface RefFixResponse {
  ok: boolean;
  entries: RefFixEntry[];
  warnings: PaperWarning[];
  model: ModelId;
  usage: Usage;
}

export interface RefFixRequest {
  docTitle: string;
  /** 服务端重新解析 docText 得到条目；也可由客户端显式传入 */
  docText: string;
  memory: PaperMemory;
  options: { model: ModelId; thinking: ThinkingLevel };
}
