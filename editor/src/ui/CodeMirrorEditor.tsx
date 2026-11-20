/**
 * CodeMirror 6 编辑器封装。
 *
 * 关键约束（对应评审要求）：
 * - 请求开始时由外部取选区快照；流式过程只更新 React 状态，绝不 dispatch 文档变更；
 * - 接受修改时由外部传入 changes，本组件用「一个 transaction」同时应用 changes + selection，
 *   保证一次 Ctrl+Z 完整回滚；
 * - 打开文件 / 恢复草稿时用 setState 重建文档，历史被清空，避免 Ctrl+Z 回到上一份文档；
 * - IME composition 期间不打断（对外暴露 isComposing，由外部决定是否暂缓操作）。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExt,
  type DecorationSet,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo as cmRedo,
  undo as cmUndo,
} from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { analyzeSelection, expandRange } from '../core/selection';
import { findTableBlocks, stripMarkdownInline, type TableBlockRange } from '../core/paper/parse';
import { buildEditorHighlight, buildEditorTheme } from './editorTheme';
import type { EditorRangeInfo, EditorSelectionInfo, RawRange } from './types';

export interface EditorChange {
  from: number;
  to: number;
  insert: string;
}

export interface CodeMirrorEditorHandle {
  getDoc(): string;
  getDocLength(): number;
  /** 主选区优先的选区列表（主选区 index=0） */
  getRanges(): RawRange[];
  focus(): void;
  hasFocus(): boolean;
  isComposing(): boolean;
  /** 重建整篇文档（清空 undo 历史），用于打开文件 / 新建 */
  resetDoc(text: string, cursorAt?: number): void;
  /** 用单个 transaction 应用多处修改，并把光标放到新文档的 cursorAt 处 */
  applyChanges(changes: EditorChange[], cursorAt: number): boolean;
  undo(): boolean;
  redo(): boolean;
  setSelection(from: number, to: number): void;
  expandSelection(unit: 'word' | 'line' | 'paragraph' | 'block'): void;
  getSelectionText(): string;
  requestMeasure(): void;
}

export interface CodeMirrorEditorProps {
  initialDoc: string;
  dark: boolean;
  placeholder?: string;
  onChange: (doc: string) => void;
  onSelection: (info: EditorSelectionInfo) => void;
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 编辑器内联表格渲染：
 * - 光标 / 选区不在表格块内时，整块替换为真实 HTML 表格（所见即所得）；
 * - 点击表格任意位置 → 光标进入块首，恢复源码显示，可正常编辑；
 * - 选区覆盖表格时显示源码，保证选区编辑（AI 改写）语义不变。
 */
class TableWidget extends WidgetType {
  constructor(readonly block: TableBlockRange) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.block.from === this.block.from && other.block.text === this.block.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const data = this.block.data;
    const wrap = document.createElement('div');
    wrap.className = 'cm-table-widget';
    wrap.title = '点击进入表格源码编辑';
    const table = document.createElement('table');
    if (data.hasHeader) {
      const thead = document.createElement('thead');
      const row = document.createElement('tr');
      data.header.forEach((cell, index) => {
        const th = document.createElement('th');
        th.textContent = stripMarkdownInline(cell) || ' ';
        const align = data.align[index];
        if (align) th.style.textAlign = align;
        row.appendChild(th);
      });
      thead.appendChild(row);
      table.appendChild(thead);
    }
    const tbody = document.createElement('tbody');
    for (const cells of data.rows) {
      const row = document.createElement('tr');
      cells.forEach((cell, index) => {
        const td = document.createElement('td');
        td.textContent = stripMarkdownInline(cell) || ' ';
        const align = data.align[index];
        if (align) td.style.textAlign = align;
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    const hint = document.createElement('div');
    hint.className = 'cm-table-hint';
    hint.textContent = `${data.columnCount} 列 × ${data.rowCount} 行 · 点击编辑源码`;
    wrap.appendChild(hint);
    wrap.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(this.block.from), scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const docText = state.doc.toString();
  const decorations: Range<Decoration>[] = [];
  const selection = state.selection;
  const overlapsSelection = (from: number, to: number): boolean =>
    selection.ranges.some((range) => range.from <= to && range.to >= from);
  for (const block of findTableBlocks(docText)) {
    if (overlapsSelection(block.from, block.to)) continue;
    decorations.push(Decoration.replace({ widget: new TableWidget(block), block: true }).range(block.from, block.to));
  }
  return Decoration.set(decorations, true);
}

const tablePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),
  update: (decorations, transaction) => {
    if (transaction.docChanged || transaction.selection) return buildTableDecorations(transaction.state);
    return decorations;
  },
});

interface LatestHandlers {
  onChange: (doc: string) => void;
  onSelection: (info: EditorSelectionInfo) => void;
}

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(props, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const handlersRef = useRef<LatestHandlers>({
      onChange: props.onChange,
      onSelection: props.onSelection,
    });
    const darkRef = useRef(props.dark);
    const placeholderRef = useRef(props.placeholder ?? '在这里开始写…');
    const themeCompartment = useRef(new Compartment());
    const highlightCompartment = useRef(new Compartment());
    const rafRef = useRef(0);

    handlersRef.current.onChange = props.onChange;
    handlersRef.current.onSelection = props.onSelection;

    const buildExtensions = (dark: boolean): Extension[] => [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      markdown(),
      bracketMatching(),
      // 表格内联渲染：StateField 负责计算，decorations.from 负责渲染（块级 widget 必须走 state field）
      tablePreviewField,
      EditorView.decorations.from(tablePreviewField),
      themeCompartment.current.of(buildEditorTheme(dark)),
      highlightCompartment.current.of(syntaxHighlighting(buildEditorHighlight())),
      placeholderExt(placeholderRef.current),
      EditorView.contentAttributes.of({
        'aria-label': 'Markdown 正文编辑器',
        'aria-multiline': 'true',
        'data-testid': 'editor',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
      EditorView.domEventHandlers({
        focus: () => {
          scheduleEmit();
          return false;
        },
        blur: () => {
          scheduleEmit();
          return false;
        },
      }),
      keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          handlersRef.current.onChange(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          scheduleEmit();
        }
      }),
    ];

    const emitSelection = () => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc.toString();
      const sel = view.state.selection;
      const order: number[] = [sel.mainIndex];
      sel.ranges.forEach((_range, index) => {
        if (index !== sel.mainIndex) order.push(index);
      });
      const ranges: EditorRangeInfo[] = order.map((originalIndex) => {
        const range = sel.ranges[originalIndex];
        const from = Math.min(range.from, range.to);
        const to = Math.max(range.from, range.to);
        return {
          index: 0,
          from,
          to,
          anchor: range.anchor,
          head: range.head,
          analysis: analyzeSelection(doc, from, to, 0),
        };
      });
      ranges.forEach((range, index) => {
        range.index = index;
        range.analysis.index = index;
      });
      const main = sel.main;
      const line = view.state.doc.lineAt(main.head);
      let coords: EditorSelectionInfo['coords'] = null;
      if (!main.empty) {
        const rect = view.coordsAtPos(main.to);
        if (rect) coords = { left: rect.left, top: rect.top, bottom: rect.bottom };
      }
      handlersRef.current.onSelection({
        ranges,
        primaryIndex: 0,
        cursor: { line: line.number, col: main.head - line.from + 1 },
        coords,
      });
    };

    function scheduleEmit() {
      if (rafRef.current) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        emitSelection();
      });
    }

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const state = EditorState.create({
        doc: props.initialDoc,
        extensions: buildExtensions(darkRef.current),
      });
      const view = new EditorView({ state, parent: host });
      viewRef.current = view;
      emitSelection();
      const scroller = view.scrollDOM;
      const onScroll = () => scheduleEmit();
      scroller.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      return () => {
        scroller.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        if (rafRef.current) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 主题切换：只重配 theme / highlight 两个 compartment，不重建文档与历史
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      darkRef.current = props.dark;
      view.dispatch({
        effects: [
          themeCompartment.current.reconfigure(buildEditorTheme(props.dark)),
          highlightCompartment.current.reconfigure(syntaxHighlighting(buildEditorHighlight())),
        ],
      });
    }, [props.dark]);

    useImperativeHandle(
      ref,
      (): CodeMirrorEditorHandle => ({
        getDoc: () => viewRef.current?.state.doc.toString() ?? '',
        getDocLength: () => viewRef.current?.state.doc.length ?? 0,
        getRanges: () => {
          const view = viewRef.current;
          if (!view) return [];
          const sel = view.state.selection;
          const order: number[] = [sel.mainIndex];
          sel.ranges.forEach((_range, index) => {
            if (index !== sel.mainIndex) order.push(index);
          });
          return order.map((originalIndex) => {
            const range = sel.ranges[originalIndex];
            return {
              from: Math.min(range.from, range.to),
              to: Math.max(range.from, range.to),
              anchor: range.anchor,
              head: range.head,
            };
          });
        },
        focus: () => viewRef.current?.focus(),
        hasFocus: () => viewRef.current?.hasFocus ?? false,
        isComposing: () => viewRef.current?.composing ?? false,
        requestMeasure: () => viewRef.current?.requestMeasure(),
        resetDoc: (text: string, cursorAt?: number) => {
          const view = viewRef.current;
          if (!view) return;
          const state = EditorState.create({
            doc: text,
            extensions: buildExtensions(darkRef.current),
          });
          view.setState(state);
          if (typeof cursorAt === 'number') {
            const pos = Math.max(0, Math.min(cursorAt, state.doc.length));
            view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
          }
          view.requestMeasure();
          emitSelection();
        },
        applyChanges: (changes: EditorChange[], cursorAt: number) => {
          const view = viewRef.current;
          if (!view) return false;
          if (!changes.length) return false;
          let newLength = view.state.doc.length;
          for (const change of changes) {
            newLength += change.insert.length - (change.to - change.from);
          }
          const pos = Math.max(0, Math.min(cursorAt, newLength));
          try {
            view.dispatch({
              changes,
              selection: EditorSelection.cursor(pos),
              scrollIntoView: true,
            });
            view.focus();
            return true;
          } catch {
            return false;
          }
        },
        undo: () => {
          const view = viewRef.current;
          if (!view) return false;
          return cmUndo(view);
        },
        redo: () => {
          const view = viewRef.current;
          if (!view) return false;
          return cmRedo(view);
        },
        setSelection: (from: number, to: number) => {
          const view = viewRef.current;
          if (!view) return;
          const length = view.state.doc.length;
          const start = Math.max(0, Math.min(from, length));
          const end = Math.max(start, Math.min(to, length));
          view.dispatch({
            selection: EditorSelection.range(start, end),
            scrollIntoView: true,
          });
          view.focus();
        },
        expandSelection: (unit: 'word' | 'line' | 'paragraph' | 'block') => {
          const view = viewRef.current;
          if (!view) return;
          const doc = view.state.doc.toString();
          const main = view.state.selection.main;
          const { from: rawFrom, to: rawTo } = expandRange(doc, main.from, main.to, unit);
          let from = rawFrom;
          let to = rawTo;
          if (unit === 'word' && from === to) {
            // core 的 word 单元只识别拉丁词；中文按连续汉字补一个兜底
            while (from > 0 && CJK_CHAR.test(doc[from - 1])) from--;
            while (to < doc.length && CJK_CHAR.test(doc[to])) to++;
            if (from === to) return;
          }
          view.dispatch({
            selection: EditorSelection.range(from, to),
            scrollIntoView: true,
          });
          view.focus();
        },
        getSelectionText: () => {
          const view = viewRef.current;
          if (!view) return '';
          const doc = view.state.doc.toString();
          return view.state.selection.ranges
            .map((range) => doc.slice(Math.min(range.from, range.to), Math.max(range.from, range.to)))
            .join('\n');
        },
      }),
      [],
    );

    return <div className="editor-host" ref={hostRef} data-testid="editor-host" />;
  },
);
