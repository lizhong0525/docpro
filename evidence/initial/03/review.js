'use strict';
const draft = document.querySelector('#draft');
const rule = document.querySelector('#rule');
const diff = document.querySelector('#diff');
const accept = document.querySelector('#accept');
const reject = document.querySelector('#reject');
const undo = document.querySelector('#undo');
const message = document.querySelector('#message');
const concise = new Map([
  ['有意参加的居民', '居民'], ['进行报名', '报名'],
  ['进行登记', '登记'], ['进行修补', '修补']
]);
const phrasePattern = new RegExp([...concise.keys()].join('|'), 'g');
const initialHint = diff.textContent;
let proposal = null;
let previous = null;

// Preserve offsets from the selected range. Identical words elsewhere can stay untouched.
function propose(original, mode) {
  const changes = [];
  const pattern = mode === 'concise' ? phrasePattern : / {2,}/g;
  let cursor = 0;
  for (const match of original.matchAll(pattern)) {
    if (match.index > cursor) changes.push({keep: original.slice(cursor, match.index)});
    changes.push({remove: match[0], add: mode === 'concise' ? concise.get(match[0]) : ' '});
    cursor = match.index + match[0].length;
  }
  if (cursor < original.length) changes.push({keep: original.slice(cursor)});
  return changes;
}

function renderDiff(changes) {
  diff.replaceChildren();
  for (const part of changes) {
    if ('keep' in part) {
      diff.append(part.keep);
      continue;
    }
    for (const [tag, value] of [['del', part.remove], ['ins', part.add]]) {
      const node = document.createElement(tag);
      node.textContent = value;
      diff.append(node);
    }
  }
}

function clearProposal() {
  proposal = null;
  diff.textContent = initialHint;
  accept.disabled = true;
  reject.disabled = true;
}

document.querySelector('#generate').addEventListener('click', () => {
  clearProposal();
  const start = draft.selectionStart;
  const end = draft.selectionEnd;
  if (start === end) {
    message.textContent = '请先在稿件中选中文字。';
    draft.focus();
    return;
  }
  const source = draft.value;
  const original = source.slice(start, end);
  const parts = propose(original, rule.value);
  if (!parts.some(part => 'remove' in part)) {
    message.textContent = '选区内没有符合这条规则的文字。';
    return;
  }
  proposal = {start, end, source, result: parts.map(part => part.keep ?? part.add).join('')};
  renderDiff(parts);
  accept.disabled = false;
  reject.disabled = false;
  message.textContent = '建议已生成，请核对标记后决定是否接受。';
  accept.focus();
});

draft.addEventListener('input', () => {
  if (proposal) {
    clearProposal();
    message.textContent = '原稿已编辑，旧建议失效。请重新选取。';
  }
  previous = null;
  undo.disabled = true;
});

function applyRange(text, start, end) {
  draft.setRangeText(text, start, end, 'select');
  draft.focus();
}

accept.addEventListener('click', () => {
  if (!proposal) return;
  const {start, end, source, result} = proposal;
  if (draft.value !== source) {
    clearProposal();
    message.textContent = '原稿已变化，请重新生成。';
    return;
  }
  applyRange(result, start, end);
  previous = {start, end: start + result.length, original: source.slice(start,end), after: draft.value};
  undo.disabled = false;
  clearProposal();
  message.textContent = '已应用修改，可以撤销这一次接受。';
});

reject.addEventListener('click', () => {
  clearProposal();
  message.textContent = '已保留原文。';
  draft.focus();
});

undo.addEventListener('click', () => {
  if (!previous || draft.value !== previous.after) return;
  applyRange(previous.original, previous.start, previous.end);
  previous = null;
  undo.disabled = true;
  clearProposal();
  message.textContent = '已恢复上一次接受前的选区。';
});
