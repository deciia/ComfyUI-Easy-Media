/**
 * 提示词工作台 (Prompt Studio) 前端面板 —— EasyMedia 本地新增（Deciia）
 * ==========================================================================
 * 目标节点：easy promptStudio（后端 nodes/prompt_studio.py）
 *
 * 面板结构（自上而下）
 *   [片段 n/N] [接线状态] [↻ 刷新素材] [采用基线] [清空] [复制提示词]
 *   素材架：当前片段素材直接以缩略图铺开，点一下即插入正文
 *   上游：系统提示词1（只读）、用户提示词2（基线，仅改写模式）
 *   正文：提示词3 —— 富文本编辑区，输入 @ 弹出素材列表，
 *         选中后以「缩略图 chip」形式插入文本；落盘仍是 <Picture n> 规范标记
 *
 * 契约
 *   · 只读：不修改 TRACKS_INFO、不写回编辑器。
 *   · 素材编号由后端按「多轨编辑器 / 多轨任务输出」同一套规则解析，
 *     保证 <Picture n> / <Audio n> / <Video n> 与编辑器一致。
 *   · 落进正文的永远是规范标记，@ 只是插入手势。
 * ==========================================================================
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAMES = ["easy promptStudio", "PromptStudio"];
const RESOLVE_ROUTE = "/easy-media/prompt-studio/resolve";
const TOKEN_SOURCE = "<\\s*(Picture|Audio|Video)\\s+(\\d+)\\s*>";
const KIND_CN = { Picture: "图像", Audio: "音频", Video: "视频" };
const SOCKET_KINDS = [["images", "Picture"], ["audio", "Audio"], ["video", "Video"]];

// ── 样式 ──────────────────────────────────────────────────────────────
(function injectCss() {
  const ID = "dps-css";
  if (document.getElementById(ID)) return;
  const style = document.createElement("style");
  style.id = ID;
  style.textContent = `
.dps-wrap{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:5px 7px 7px;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#e6e8ec;overflow-y:auto;overflow-x:hidden}
.dps-bar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:0 0 auto}
.dps-btn{background:#2a2d35;border:1px solid #3a3d45;border-radius:6px;color:#e6e8ec;font-size:11px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.dps-btn:hover{border-color:#4a9eff;color:#fff}
.dps-btn:disabled{opacity:.45;cursor:default;border-color:#3a3d45}
.dps-tag{font-size:11px;color:#9aa3b2;background:#22242a;border:1px solid #33363d;border-radius:6px;padding:2px 7px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dps-rack{flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:2px 1px 4px;min-height:64px;align-items:flex-start}
.dps-rack:empty{display:none}
.dps-tile{flex:0 0 auto;width:74px;display:flex;flex-direction:column;gap:3px;align-items:center;cursor:pointer;border:1px solid #33363d;border-radius:7px;padding:4px 3px;background:#1e2026}
.dps-tile:hover{border-color:#4a9eff;background:#23262e}
.dps-tile.dps-lock{cursor:default;opacity:.6}
.dps-tile.dps-lock:hover{border-color:#33363d;background:#1e2026}
.dps-thumb{width:74px;height:52px;border-radius:5px;background:#15171b;display:flex;align-items:center;justify-content:center;overflow:hidden}
.dps-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dps-thumb svg{width:20px;height:20px;opacity:.75}
.dps-tile-n{font-size:10px;color:#7fb2ff;font-weight:600;line-height:1.1}
.dps-tile-nm{font-size:9px;color:#8a93a3;max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dps-up{flex:0 0 auto;display:flex;flex-direction:column;gap:4px}
.dps-up-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dps-up-chip{font-size:10.5px;color:#8f97a6;background:#1e2026;border:1px solid #2f323a;border-radius:6px;padding:1px 8px;cursor:pointer;font-family:inherit;white-space:nowrap;line-height:1.6}
.dps-up-chip:hover{color:#e6e8ec;border-color:#4a4e57}
.dps-up-chip.dps-up-open{color:#cdd6e4;border-color:#4a4e57;background:#232630}
.dps-up-bodies{display:flex;flex-direction:column;gap:4px}
.dps-up-body{border:1px solid #33363d;border-radius:6px;background:#1b1d22;font-size:11px;line-height:1.5;color:#c9cfd9;padding:4px 7px 6px;max-height:92px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dps-ed{flex:1 1 auto;min-height:100px;border:1px solid #33363d;border-radius:7px;background:#15171b;padding:6px 8px;overflow:auto;font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;outline:none;cursor:text}
.dps-ed:focus{border-color:#4a9eff}
.dps-ed[data-empty="1"]::before{content:attr(data-ph);color:#666e7d;pointer-events:none}
.dps-tok{display:inline-flex;align-items:center;gap:3px;vertical-align:baseline;margin:0 1px;padding:0 4px 0 2px;border:1px solid #3d5f8f;border-radius:5px;background:#1d2733;cursor:default;user-select:none}
.dps-tok img{width:16px;height:16px;border-radius:3px;object-fit:cover;vertical-align:middle}
.dps-tok svg{width:13px;height:13px;opacity:.8}
.dps-tok-n{font-size:10.5px;color:#8fc0ff}
.dps-tok.dps-tok-miss{border-color:#7a4a4a;background:#2a1e1e}
.dps-tok.dps-tok-miss .dps-tok-n{color:#e08a8a}
.dps-hint{flex:0 0 auto;font-size:9.5px;color:#6f7787;line-height:1.4}
.dps-menu{position:fixed;z-index:99999;min-width:230px;max-width:340px;max-height:216px;overflow:auto;background:#1c1f26;border:1px solid #3a3d45;border-radius:8px;box-shadow:0 10px 26px rgba(0,0,0,.5);padding:3px}
.dps-menu-i{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:6px;cursor:pointer}
.dps-menu-i:hover,.dps-menu-i.dps-on{background:#2b3240}
.dps-menu-th{width:32px;height:32px;flex:0 0 auto;border-radius:5px;background:#15171b;display:flex;align-items:center;justify-content:center;overflow:hidden}
.dps-menu-th img{width:100%;height:100%;object-fit:cover}
.dps-menu-th svg{width:16px;height:16px;opacity:.75}
.dps-menu-tx{min-width:0}
.dps-menu-t{font-size:11px;font-weight:600;color:#8fc0ff;white-space:nowrap}
.dps-menu-d{font-size:9.5px;color:#8a93a3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.dps-menu-e{font-size:10.5px;color:#7a8291;padding:6px}
`;
  document.head.appendChild(style);
})();

// ── 图标 ──────────────────────────────────────────────────────────────
const ICON_PATH = {
  Picture: "M3 3h18v18H3z M8.5 8.5a1.5 1.5 0 1 0 0-.01 M21 15l-5-5L5 21",
  Audio: "M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  Video: "M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
};

function icon(kind) {
  const span = document.createElement("span");
  span.style.display = "inline-flex";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATH[kind] || ICON_PATH.Picture);
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

// ── 小工具 ────────────────────────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function widgetOf(node, name) {
  return (node.widgets || []).find((w) => w.name === name) || null;
}

function rawWidgetValue(node, name) {
  return widgetOf(node, name)?.value;
}

function widgetValue(node, name) {
  const value = rawWidgetValue(node, name);
  return typeof value === "string" ? value : "";
}

function setWidgetValue(node, name, value, silent) {
  const widget = widgetOf(node, name);
  if (!widget) return false;
  widget.value = value;
  if (!silent) {
    try { widget.callback?.(value, app.canvas, node, [0, 0], null); } catch (error) { /* noop */ }
  }
  app.graph?.setDirtyCanvas?.(true, false);
  return true;
}

function socketWired(node, name) {
  const input = (node.inputs || []).find((slot) => slot.name === name);
  return Boolean(input && input.link);
}

function findEditorNode() {
  const nodes = app.graph?.nodes || app.graph?._nodes || [];
  return nodes.find((n) => /multiTrackEditor$/i.test(String(n.type || ""))) || null;
}

function readEditorTrackData() {
  const editor = findEditorNode();
  if (!editor) return null;
  const widget = (editor.widgets || []).find((w) => /track_data/i.test(String(w.name)));
  const value = widget?.value;
  return typeof value === "string" && value.trim() ? value : null;
}

function token(kind, n) {
  return `<${kind} ${n}>`;
}

// ══════════════════════════════════════════════════════════════════════
// 富文本编辑器：文本 + 缩略图 chip
// ══════════════════════════════════════════════════════════════════════
function createEditor(options = {}) {
  const itemOf = typeof options.itemOf === "function" ? options.itemOf : () => null;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const onAt = typeof options.onAt === "function" ? options.onAt : null;

  const ed = el("div", "dps-ed");
  ed.setAttribute("contenteditable", "plaintext-only");
  const flat = ed.contentEditable === "plaintext-only";
  if (!flat) ed.setAttribute("contenteditable", "true");
  ed.spellcheck = false;
  ed.dataset.ph = options.placeholder || "";

  let lastCaret = 0;
  const undoStack = [];
  const redoStack = [];
  let snapshotTimer = null;

  // ---- 序列化：DOM → 规范文本 ----
  function read(root) {
    let out = "";
    for (const child of (root || ed).childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1) {
        if (child.dataset && child.dataset.dpsToken) out += child.dataset.dpsToken;
        else if (child.tagName === "BR") out += "\n";
        else out += read(child);
      }
    }
    return out;
  }

  // ---- DOM 位置 → 文本偏移 ----
  function offsetAtPoint(container, offset) {
    let total = 0;
    let done = false;
    const visit = (parent) => {
      for (const child of parent.childNodes) {
        if (done) return;
        if (child === container) {
          if (child.nodeType === 1 && child.dataset && child.dataset.dpsToken) {
            total += child.dataset.dpsToken.length;
          } else {
            total += offset;
          }
          done = true;
          return;
        }
        if (child.nodeType === 3) total += child.nodeValue.length;
        else if (child.nodeType === 1) {
          if (child.dataset && child.dataset.dpsToken) total += child.dataset.dpsToken.length;
          else if (child.tagName === "BR") total += 1;
          else visit(child);
        }
      }
    };
    visit(ed);
    return done ? total : read().length;
  }

  function caretOffset() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return read().length;
    const range = selection.getRangeAt(0);
    if (!ed.contains(range.startContainer)) return read().length;
    return offsetAtPoint(range.startContainer, range.startOffset);
  }

  // ---- 文本偏移 → DOM 位置 ----
  function pointAt(target) {
    const indexOf = (child) => Array.prototype.indexOf.call(child.parentNode.childNodes, child);
    let acc = 0;
    let result = null;
    const visit = (parent) => {
      for (const child of parent.childNodes) {
        if (result) return;
        if (child.nodeType === 3) {
          const len = child.nodeValue.length;
          if (acc + len >= target) { result = { node: child, offset: Math.max(0, Math.min(target - acc, len)) }; return; }
          acc += len;
        } else if (child.nodeType === 1) {
          if (child.dataset && child.dataset.dpsToken) {
            const len = child.dataset.dpsToken.length;
            if (acc + len >= target) { result = { node: parent, offset: indexOf(child) + 1 }; return; }
            acc += len;
          } else if (child.tagName === "BR") {
            if (acc + 1 >= target) { result = { node: parent, offset: indexOf(child) + 1 }; return; }
            acc += 1;
          } else {
            visit(child);
          }
        }
      }
    };
    visit(ed);
    if (!result) result = { node: ed, offset: ed.childNodes.length };
    return result;
  }

  function rangeAt(start, end) {
    const a = pointAt(start);
    const b = pointAt(end === undefined ? start : end);
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (error) {
      range.selectNodeContents(ed);
      range.collapse(false);
    }
    return range;
  }

  function setCaretAt(target) {
    if (document.activeElement !== ed) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(rangeAt(target));
  }

  // ---- chip ----
  function makeChip(kind, n) {
    const item = itemOf(kind, n);
    const chip = el("span", "dps-tok" + (item ? "" : " dps-tok-miss"));
    chip.contentEditable = "false";
    chip.dataset.dpsToken = token(kind, n);
    chip.dataset.dpsKind = kind;
    chip.dataset.dpsN = String(n);
    if (item && item.url) {
      const img = new Image();
      img.src = item.url;
      img.alt = "";
      img.draggable = false;
      img.loading = "lazy";
      img.onerror = () => { img.remove(); chip.insertBefore(icon(kind), chip.firstChild); };
      chip.appendChild(img);
    } else {
      chip.appendChild(icon(kind));
    }
    chip.appendChild(el("span", "dps-tok-n", `${kind} ${n}`));
    chip.title = item
      ? `${item.name || ""}\n${token(kind, n)}`
      : `该片段没有 ${token(kind, n)}（编号越界）`;
    return chip;
  }

  function markEmpty() {
    ed.dataset.empty = read().length === 0 ? "1" : "0";
  }

  // ---- 绘制：文本 → DOM（尽量保住光标） ----
  function paint(text, caret) {
    const wanted = caret === undefined || caret === null ? read().length : caret;
    while (ed.firstChild) ed.removeChild(ed.firstChild);
    const re = new RegExp(TOKEN_SOURCE, "gi");
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > last) ed.appendChild(document.createTextNode(text.slice(last, match.index)));
      ed.appendChild(makeChip(match[1], match[2]));
      last = match.index + match[0].length;
    }
    if (last < text.length) ed.appendChild(document.createTextNode(text.slice(last)));
    lastCaret = Math.min(wanted, text.length);
    markEmpty();
    if (document.activeElement === ed) setCaretAt(lastCaret);
  }

  // ---- 历史 ----
  function snapshot() {
    const text = read();
    const top = undoStack[undoStack.length - 1];
    if (top && top.text === text) return;
    undoStack.push({ text, caret: caretOffset() });
    if (undoStack.length > 120) undoStack.shift();
    redoStack.length = 0;
  }

  function scheduleSnapshot() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => { snapshotTimer = null; snapshot(); }, 400);
  }

  function restore(state) {
    paint(state.text, state.caret);
    onChange(state.text);
  }

  function undo() {
    if (undoStack.length < 2) return;
    redoStack.push({ text: read(), caret: caretOffset() });
    undoStack.pop();
    restore(undoStack[undoStack.length - 1]);
  }

  function redo() {
    const state = redoStack.pop();
    if (!state) return;
    undoStack.push(state);
    restore(state);
  }

  // ---- 插入 ----
  function insertChip(kind, n, at) {
    const text = read();
    const offset = at === undefined || at === null
      ? (document.activeElement === ed ? caretOffset() : Math.min(lastCaret, text.length))
      : Math.max(0, Math.min(Number(at) || 0, text.length));
    snapshot();
    const chip = makeChip(kind, n);
    const range = rangeAt(offset);
    range.deleteContents();
    const lead = document.createTextNode(offset > 0 && !/\s$/.test(text.slice(0, offset)) ? " " : "");
    range.insertNode(lead);
    range.setStartAfter(lead);
    range.collapse(true);
    range.insertNode(chip);
    const tail = document.createTextNode(" ");
    chip.parentNode.insertBefore(tail, chip.nextSibling);
    const afterRange = document.createRange();
    afterRange.setStart(tail, tail.nodeValue.length);
    afterRange.collapse(true);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(afterRange);
    }
    lastCaret = offset + chip.dataset.dpsToken.length + 1;
    markEmpty();
    onChange(read());
    ed.focus();
    return chip;
  }

  function insertPlainText(text) {
    if (!text) return;
    snapshot();
    const selection = window.getSelection();
    if (document.activeElement !== ed || !selection || !selection.rangeCount) {
      const current = read();
      paint(current + text, current.length + text.length);
      onChange(read());
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    String(text).split("\n").forEach((part, index) => {
      let lastNode = null;
      if (index > 0) {
        lastNode = document.createElement("br");
        range.insertNode(lastNode);
        range.setStartAfter(lastNode);
        range.collapse(true);
      }
      if (part) {
        lastNode = document.createTextNode(part);
        range.insertNode(lastNode);
        range.setStartAfter(lastNode);
        range.collapse(true);
      }
    });
    markEmpty();
    onChange(read());
  }

  // ---- 事件 ----
  ed.addEventListener("input", () => {
    markEmpty();
    onChange(read());
    scheduleSnapshot();
    if (onAt) onAt(read(), caretOffset());
  });
  ed.addEventListener("focus", () => { lastCaret = caretOffset(); });
  ed.addEventListener("blur", () => { if (onAt) onAt(null, null); });
  ed.addEventListener("keyup", () => {
    lastCaret = caretOffset();
    if (onAt) onAt(read(), caretOffset());
  });
  ed.addEventListener("mouseup", () => { lastCaret = caretOffset(); });
  ed.addEventListener("keydown", (event) => {
    event.stopPropagation();
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (ctrl && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
    if (event.key === "Enter" && !flat) { event.preventDefault(); insertPlainText("\n"); return; }
    if (event.key === "Backspace") scheduleSnapshot();
  });
  ed.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    insertPlainText(text);
  });
  ed.addEventListener("drop", (event) => event.preventDefault());
  ed.addEventListener("dragover", (event) => event.preventDefault());

  return {
    el: ed,
    getValue: read,
    setValue: (text, caret) => {
      undoStack.length = 0;
      redoStack.length = 0;
      paint(String(text || ""), caret);
      snapshot();
    },
    insertItem: (item, at) => insertChip(item.kind, item.n, at),
    insertText: insertPlainText,
    repaint: () => paint(read(), caretOffset()),
    caretOffset,
    lastCaret: () => lastCaret,
    focus: () => ed.focus(),
  };
}

// ══════════════════════════════════════════════════════════════════════
// @ 素材菜单
// ══════════════════════════════════════════════════════════════════════
function createMenu() {
  const root = el("div", "dps-menu");
  root.style.display = "none";
  document.body.appendChild(root);

  let items = [];
  let current = 0;
  let handler = null;
  let queryRange = null;

  function draw() {
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!items.length) {
      root.appendChild(el("div", "dps-menu-e", "当前片段没有可引用的素材"));
      return;
    }
    items.forEach((item, index) => {
      const row = el("div", "dps-menu-i" + (index === current ? " dps-on" : ""));
      const thumb = el("div", "dps-menu-th");
      if (item.url) {
        const img = new Image();
        img.src = item.url;
        img.alt = "";
        img.onerror = () => { img.remove(); thumb.appendChild(icon(item.kind)); };
        thumb.appendChild(img);
      } else {
        thumb.appendChild(icon(item.kind));
      }
      row.appendChild(thumb);
      const box = el("div", "dps-menu-tx");
      box.appendChild(el("div", "dps-menu-t", `${KIND_CN[item.kind] || ""} · ${item.label}`));
      box.appendChild(el("div", "dps-menu-d", item.name || item.token));
      row.appendChild(box);
      row.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pick(index);
      });
      root.appendChild(row);
    });
  }

  function pick(index) {
    const item = items[index];
    const span = queryRange;
    const fn = handler;
    close();
    if (item && span && fn) fn(item, span);
  }

  function close() {
    root.style.display = "none";
    items = [];
    handler = null;
    queryRange = null;
  }

  function open(entries, anchor, onPick, range) {
    items = entries;
    current = 0;
    handler = onPick;
    queryRange = range;
    draw();
    root.style.display = "block";
    const rect = anchor || { left: 40, top: 40, bottom: 60 };
    const height = Math.min(root.scrollHeight || 216, 216);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - (root.offsetWidth || 240) - 12));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  function move(delta) {
    if (!items.length) return;
    current = (current + delta + items.length) % items.length;
    draw();
  }

  return {
    open,
    close,
    move,
    pick: () => pick(current),
    get visible() { return root.style.display !== "none"; },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 素材清单
// ══════════════════════════════════════════════════════════════════════
function collectItems(node) {
  const data = node._dpsState?.data;
  const items = [];
  if (data?.ok) {
    (data.items || []).forEach((raw) => {
      items.push({
        kind: raw.kind,
        n: Number(raw.n),
        label: raw.label || `${raw.kind} ${raw.n}`,
        token: raw.token || token(raw.kind, raw.n),
        name: raw.name || "",
        url: raw.url || null,
        shared: Boolean(raw.shared),
        source: "editor",
        locked: false,
      });
    });
  }
  // 端口素材：编辑器素材清单里没有对应域时的兜底占位（编号运行时才确定，不可点选）
  SOCKET_KINDS.forEach(([name, kind]) => {
    if (!socketWired(node, name)) return;
    if (items.some((item) => item.kind === kind)) return;
    items.push({
      kind,
      n: 1,
      label: `${kind} 1`,
      token: token(kind, 1),
      name: "端口素材",
      url: null,
      shared: false,
      source: "socket",
      locked: true,
    });
  });
  return items;
}

function itemBy(node, kind, n) {
  return collectItems(node).find((item) => item.kind === kind && Number(item.n) === Number(n)) || null;
}

// ══════════════════════════════════════════════════════════════════════
// 面板
// ══════════════════════════════════════════════════════════════════════
function setupPanel(node) {
  if (node._dpsBuilt) return;
  node._dpsBuilt = true;

  const state = { data: null, busy: false, signature: "", timer: null, fromEditor: false, atQuery: null, atDismissed: null };
  node._dpsState = state;

  const wrap = el("div", "dps-wrap");
  wrap.addEventListener("mousedown", (event) => event.stopPropagation());
  wrap.addEventListener("keydown", (event) => event.stopPropagation());
  wrap.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

  const bar = el("div", "dps-bar");
  const tagSeg = el("span", "dps-tag", "片段 —");
  const tagWire = el("span", "dps-tag", "未接端口");
  const btnRefresh = el("button", "dps-btn", "↻ 刷新");
  const btnBaseline = el("button", "dps-btn", "采用基线");
  const btnClear = el("button", "dps-btn", "清空");
  const btnCopy = el("button", "dps-btn", "复制");
  [btnRefresh, btnBaseline, btnClear, btnCopy].forEach((b) => { b.type = "button"; });
  bar.append(tagSeg, tagWire, btnRefresh, btnBaseline, btnClear, btnCopy);

  const rack = el("div", "dps-rack");
  const up = el("div", "dps-up");
  const upSystem = upstreamBox("系统提示词1");
  const upUser = upstreamBox("用户提示词2（基线）");
  const upBodies = el("div", "dps-up-bodies");
  const upRow = el("div", "dps-up-row");
  upRow.append(upSystem.box, upUser.box);
  upBodies.append(upSystem.body, upUser.body);
  up.append(upRow, upBodies);

  const menu = createMenu();

  const editor = createEditor({
    placeholder: "在此写提示词3：输入 @ 选素材，插入后存为 <Picture n> / <Audio n> / <Video n>。",
    itemOf: (kind, n) => itemBy(node, kind, n),
    onChange: (text) => {
      state.fromEditor = true;
      setWidgetValue(node, "prompt", text, false);
      state.fromEditor = false;
    },
    onAt: (text, caret) => handleAtKeyword(text, caret),
  });

  const hint = el("div", "dps-hint", "编号与多轨编辑器一致：<Picture n> / <Audio n> / <Video n>");
  hint.title =
    "编号与多轨编辑器一致：<Picture n> 图像 / <Audio n> 音频 / <Video n> 视频。\n" +
    "面板只读项目数据，不回写项目；改写模式下提示词3留空会回退用户提示词2（基线）。";

  wrap.append(bar, rack, up, editor.el, hint);

  node._dpsWrap = wrap;
  node._dpsEditor = editor;
  node._dpsMenu = menu;
  node._dpsRack = rack;
  node._dpsBtnBaseline = btnBaseline;
  node._dpsUpSystem = upSystem;
  node._dpsUpUser = upUser;

  node._dpsDomW = node.addDOMWidget("提示词工作台", "提示词工作台", wrap, { serialize: false });
  // 固定高度的"最小需求"：绝不能引用 node.size[1]——前端会拿它跟"其他控件的真实高度（~206）"相加
  // 当作节点最小高度，形成自引用，每次载入把节点顶高 (206-112)=94px（用户调好的高度会被重置）。
  // 固定 240 后：新节点默认尺寸由它决定（约 400x256，紧凑），已有存档尺寸原样保留，面板靠 height:100% 自己吃满。
  node._dpsDomW.computeSize = () => [node.size[0], 240];

  // ── @ 菜单 ──
  function handleAtKeyword(text, caret) {
    if (text === null || caret === null) { menu.close(); return; }
    const before = text.slice(0, caret);
    const match = before.match(/@([^\s@<>]*)$/);
    if (!match) { state.atQuery = null; state.atDismissed = null; menu.close(); return; }
    const query = match[1].toLowerCase();
    if (state.atDismissed !== null && state.atDismissed === query) { menu.close(); return; }
    state.atDismissed = null;
    state.atQuery = query;
    const entries = collectItems(node).filter((item) => {
      if (item.locked) return false;
      if (!query) return true;
      const haystack = `${item.label} ${item.name} ${KIND_CN[item.kind] || ""} ${item.token}`.toLowerCase();
      return haystack.includes(query);
    });
    const start = caret - match[0].length;
    let anchor = null;
    try {
      const selection = window.getSelection();
      const rect = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      if (rect && (rect.width || rect.height || rect.top)) anchor = rect;
    } catch (error) { anchor = null; }
    if (!anchor) {
      const box = editor.el.getBoundingClientRect();
      anchor = { left: box.left + 12, top: box.top + 12, bottom: box.top + 26 };
    }
    menu.open(entries, anchor, (item, span) => {
      const current = editor.getValue();
      const next = current.slice(0, span.start) + current.slice(span.end);
      editor.setValue(next, span.start);
      editor.insertItem(item, span.start);
    }, { start, end: caret });
  }

  // 菜单键盘接管（capture：先于编辑器的 keydown）
  editor.el.addEventListener("keydown", (event) => {
    const key = event.key;
    if (menu.visible) {
      if (key === "ArrowDown") { event.preventDefault(); menu.move(1); return; }
      if (key === "ArrowUp") { event.preventDefault(); menu.move(-1); return; }
      if (key === "Enter" || key === "Tab") { event.preventDefault(); menu.pick(); return; }
    }
    if (key === "Escape") {
      if (menu.visible) {
        event.preventDefault();
        state.atDismissed = state.atQuery;
        menu.close();
      }
    }
  }, true);

  // ── 按钮 ──
  btnRefresh.addEventListener("click", (event) => { event.stopPropagation(); refresh(node, { force: true }); });
  btnClear.addEventListener("click", (event) => {
    event.stopPropagation();
    editor.setValue("");
    state.fromEditor = true;
    setWidgetValue(node, "prompt", "", false);
    state.fromEditor = false;
    render(node);
  });
  btnCopy.addEventListener("click", (event) => { event.stopPropagation(); copyPrompt(node); });
  btnBaseline.addEventListener("click", (event) => {
    event.stopPropagation();
    const baseline = state.data?.user_prompt || widgetValue(node, "user_prompt");
    if (!baseline) return;
    editor.setValue(baseline, baseline.length);
    state.fromEditor = true;
    setWidgetValue(node, "prompt", baseline, false);
    state.fromEditor = false;
    render(node);
  });

  // ── widget 变化 ──
  ["mode", "task_index", "prompt", "user_prompt", "system_prompt"].forEach((name) => {
    const widget = widgetOf(node, name);
    if (!widget) return;
    const original = widget.callback;
    widget.callback = function () {
      const result = original ? original.apply(this, arguments) : undefined;
      if (name === "prompt") {
        // 面板自己写的值不再回灌，也不重绘（免得每敲一个字重建素材架）
        if (!state.fromEditor) {
          const text = typeof widget.value === "string" ? widget.value : "";
          if (text !== editor.getValue()) editor.setValue(text);
          render(node);
        }
        return result;
      }
      if (name === "task_index") refresh(node, { force: true });
      render(node);
      return result;
    };
  });

  // 面板接管正文：原生输入框收成 0 高度，值仍照常序列化
  const nativePrompt = widgetOf(node, "prompt");
  if (nativePrompt) {
    nativePrompt.computeSize = () => [0, -4];
    nativePrompt.hidden = true;
    node._dpsNativePrompt = nativePrompt;
  }

  editor.setValue(widgetValue(node, "prompt"));
  render(node);
  setTimeout(() => refresh(node, { silent: true }), 800);
  startWatch(node);
}

function upstreamBox(title) {
  // 折叠态只占一个 chip 的位置，展开时正文在下方整行出现
  const chip = el("button", "dps-up-chip", `${title} ▸`);
  chip.type = "button";
  chip.title = "点击展开 / 收起（只读展示，本节点不改写）";
  const body = el("div", "dps-up-body", "—");
  body.style.display = "none";
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = body.style.display === "none";
    body.style.display = open ? "" : "none";
    chip.textContent = `${title} ${open ? "▾" : "▸"}`;
    chip.classList.toggle("dps-up-open", open);
  });
  return { box: chip, body };
}

function render(node) {
  const state = node._dpsState;
  const editor = node._dpsEditor;
  if (!state || !editor) return;

  const data = state.data;
  const tags = node._dpsWrap.querySelectorAll(".dps-tag");

  if (data?.ok) {
    const total = Math.max(1, Number(data.task_count) || 1);
    const index = Number(data.task_index) || 0;
    const frames = data.start_frame !== undefined && data.start_frame !== null && data.end_frame !== undefined
      ? ` · 帧 ${data.start_frame}–${data.end_frame}` : "";
    if (tags[0]) tags[0].textContent = `片段 ${index + 1}/${total}${frames}`;
  } else if (tags[0]) {
    tags[0].textContent = "片段 —";
  }

  const wired = [
    ["tracks_info", "轨道信息"], ["images", "图像"], ["audio", "音频"],
    ["video", "视频"], ["system_prompt", "系统提示词1"], ["user_prompt", "用户提示词2"],
  ].filter(([name]) => socketWired(node, name)).map(([, label]) => label);
  if (tags[1]) tags[1].textContent = wired.length ? `已接：${wired.join("、")}` : "未接端口";

  // 素材架
  const rackHost = node._dpsRack;
  while (rackHost.firstChild) rackHost.removeChild(rackHost.firstChild);
  const items = collectItems(node);
  if (data && data.ok === false) {
    rackHost.appendChild(el("div", "dps-hint", `素材解析失败：${data.error || "未知错误"}`));
  } else if (!items.length) {
    rackHost.appendChild(el("div", "dps-hint", "当前片段没有素材：接上多轨编辑器的轨道信息后点「↻ 刷新素材」。"));
  }
  items.forEach((item) => rackHost.appendChild(rackTile(node, item)));

  // 上游只读
  node._dpsUpSystem.body.textContent = data?.ok
    ? (data.system_prompt || "（该片段没有系统提示词）")
    : (socketWired(node, "system_prompt") ? "由接线在运行时提供" : "未接线");
  node._dpsUpUser.body.textContent = data?.ok
    ? (data.user_prompt || "（该片段没有用户提示词）")
    : (socketWired(node, "user_prompt") ? "由接线在运行时提供" : "未接线");
  const mode = widgetValue(node, "mode") || "改写";
  const showUser = mode !== "生成" || Boolean(data?.user_prompt) || socketWired(node, "user_prompt");
  node._dpsUpUser.box.style.display = showUser ? "" : "none";
  if (!showUser) node._dpsUpUser.body.style.display = "none";
  node._dpsBtnBaseline.disabled = !(data?.user_prompt || widgetValue(node, "user_prompt"));

  node._dpsDomW?.computeSize?.();
  app.graph?.setDirtyCanvas?.(true, true);
}

function rackTile(node, item) {
  const tile = el("div", "dps-tile" + (item.locked ? " dps-lock" : ""));
  const thumb = el("div", "dps-thumb");
  if (item.url) {
    const img = new Image();
    img.src = item.url;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => { img.remove(); thumb.appendChild(icon(item.kind)); };
    thumb.appendChild(img);
  } else {
    thumb.appendChild(icon(item.kind));
  }
  tile.append(
    thumb,
    el("div", "dps-tile-n", item.source === "editor" ? item.token : `${KIND_CN[item.kind]}端口`),
    el("div", "dps-tile-nm", item.name || ""),
  );
  tile.title = item.locked
    ? `${KIND_CN[item.kind]}端口素材：本片段素材清单里没有对应编号，运行时才确定，暂不可点选插入`
    : `${item.name || ""}\n点击插入 ${item.token}`;
  if (!item.locked) {
    tile.addEventListener("click", (event) => {
      event.stopPropagation();
      node._dpsEditor?.insertItem(item, node._dpsEditor.lastCaret());
      render(node);
    });
  }
  return tile;
}

function startWatch(node) {
  const state = node._dpsState;
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!node.graph) { clearInterval(state.timer); state.timer = null; return; }
    if (state.busy) return;
    let signature = "";
    try {
      const raw = readEditorTrackData();
      signature = `${raw ? raw.length : 0}:${raw ? raw.slice(0, 80) : ""}:${rawWidgetValue(node, "task_index")}`;
    } catch (error) { return; }
    if (signature === state.signature) return;
    state.signature = signature;
    refresh(node, { silent: true });
  }, 3000);
}

// ── 动作 ──────────────────────────────────────────────────────────────
async function refresh(node, options = {}) {
  const state = node._dpsState;
  if (!state || state.busy) return;
  const trackData = readEditorTrackData();
  if (!trackData) {
    state.data = { ok: false, error: "未找到多轨编辑器节点（或它的 track_data 为空）" };
    render(node);
    return;
  }
  state.busy = true;
  try {
    const index = Number(rawWidgetValue(node, "task_index") ?? 0);
    const response = await api.fetchApi(RESOLVE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track_data: trackData, task_index: Number.isFinite(index) ? index : 0 }),
    });
    state.data = await response.json();
  } catch (error) {
    state.data = { ok: false, error: String(error?.message || error) };
  } finally {
    state.busy = false;
    render(node);
    node._dpsEditor?.repaint?.();
  }
}

async function copyPrompt(node) {
  const text = node._dpsEditor?.getValue?.() || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (e) { /* noop */ }
    area.remove();
  }
}

// ── 注册 ──────────────────────────────────────────────────────────────
app.registerExtension({
  name: "deciia.prompt.studio",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.includes(String(nodeData.name))) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated ? onCreated.apply(this, arguments) : undefined;
      try {
        setupPanel(this);
        // 不再主动改节点尺寸：初始高度由 computeSize 决定，之后一律尊重用户调整后的尺寸。
      } catch (error) {
        console.warn("[Prompt Studio] setup:", error);
      }
      return result;
    };

    const onConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        if (!this._dpsBuilt) setupPanel(this);
        const text = widgetValue(this, "prompt");
        if (text !== this._dpsEditor?.getValue?.()) this._dpsEditor?.setValue?.(text);
        render(this);
      } catch (error) {
        console.warn("[Prompt Studio] configure:", error);
      }
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      try {
        const state = this._dpsState;
        if (state?.timer) { clearInterval(state.timer); state.timer = null; }
        this._dpsMenu?.close?.();
      } catch (error) { /* noop */ }
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };
  },
});
