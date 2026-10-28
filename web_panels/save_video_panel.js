import { app } from "../../scripts/app.js";

/**
 * Save Video（easy saveVideo）节点面板 —— 对齐班长「🎥 视频合并」的折叠语义：
 *  1) 画面右上角 ⌃/⌄ = 「仅画面模式」：折叠**所有参数控件 + 详情面板**，只留画面；
 *  2) 详情标题栏 = 折叠按钮 | 📋 视频详情 | 复制全部；收起后**保留标题条**（与班长一致）；
 *  3) 底部路径行 + 打开目录常驻；
 *  4) 「高级设置」仍可单独折叠（隐藏未使用的输出格式/路径/净化/提示音）。
 * 状态写入 node.properties，随工作流保存。只做展示，不改执行逻辑。
 */
const ROWS = [
  ["elapsed", "⏱️ 累计用时", (i) => (i?.save_seconds ? `${i.save_seconds} 秒` : "—")],
  ["filename", "📄 文件名称", (i) => i?.filename || "—"],
  ["resolution", "📐 物理尺寸", (i) => (i?.width && i?.height ? `${i.width} × ${i.height}` : "—")],
  ["frames", "🎞️ 总帧数", (i) => (i?.frames ? `${i.frames} 帧` : "—")],
  ["duration", "▶️ 播放时间", (i) => secs(i?.duration)],
  ["fps", "🎬 视频帧率", (i) => (i?.fps ? `${i.fps} FPS` : "—")],
  ["size", "💾 文件体积", (i) => bytes(i?.size_bytes)],
  ["format", "🎨 编码格式", (i) => (i?.format || "").toUpperCase() || "—"],
  ["audio", "🔊 音频", (i) => (i?.has_audio ? "有声" : "无声")],
];

/** 节点上方的全部输入控件（折叠按钮会把它们一起收起） */
const PARAM_WIDGETS = [
  "input_mode",
  "fps",
  "output_mode",
  "save_metadata",
  "filename_prefix",
  "video_format",
  "custom_save_path",
  "adopt_source_video",
  "cleanup_after_save",
  "notify_sound",
];
const PLAYER_HEIGHT = 220;
const HEADER_HEIGHT = 26;
const DETAILS_HEIGHT = 186;

function bytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function secs(n) {
  n = Number(n) || 0;
  if (!n) return "—";
  if (n < 60) return `${n.toFixed(2)} 秒`;
  const m = Math.floor(n / 60);
  return `${m} 分 ${(n - m * 60).toFixed(1)} 秒`;
}

function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BTN_CSS =
  "padding:0 6px;height:18px;line-height:16px;border-radius:3px;border:1px solid #4a4a4a;background:rgba(24,24,24,.9);color:#bbb;cursor:pointer;font-size:10px;";

function buildPanel() {
  const root = el("div", "display:flex;flex-direction:column;background:#141414;border:1px solid #333;border-radius:6px;overflow:hidden;");

  // ── 画面区（右上角「仅画面模式」按钮）──
  const videoWrap = el("div", "position:relative;width:100%;background:#000;");
  const video = el("video", `width:100%;height:${PLAYER_HEIGHT}px;background:#000;object-fit:contain;display:block;`);
  video.controls = true;
  video.loop = false;
  video.preload = "metadata";
  video.muted = true;
  videoWrap.appendChild(video);

  const videoOnlyBtn = el(
    "button",
    `position:absolute;top:4px;right:4px;width:20px;${BTN_CSS}`,
    "⌃",
  );
  videoOnlyBtn.title = "折叠参数，仅显示画面";
  videoOnlyBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  videoWrap.appendChild(videoOnlyBtn);
  root.appendChild(videoWrap);

  // ── 详情标题栏：折叠按钮 | 📋 视频详情 | 复制全部 ──
  const header = el(
    "div",
    `display:flex;align-items:center;gap:6px;height:${HEADER_HEIGHT}px;padding:0 8px;background:#1b1b1b;border-top:1px solid #333;user-select:none;font-size:11px;color:#bbb;box-sizing:border-box;`,
  );
  const foldBtn = el("button", BTN_CSS, "▾");
  foldBtn.title = "折叠/展开视频详情";
  foldBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  const title = el("span", "flex:1 1 auto;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "📋 视频详情");
  const copyAllBtn = el("button", BTN_CSS, "复制全部");
  copyAllBtn.title = "复制视频详情文本";
  copyAllBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  header.appendChild(foldBtn);
  header.appendChild(title);
  header.appendChild(copyAllBtn);
  root.appendChild(header);

  // ── 详情字段 ──
  const body = el("div", "display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:6px 8px 8px;font-size:11px;color:#ddd;");
  const cells = new Map();
  for (const [key, label] of ROWS) {
    const k = el("span", "color:#888;white-space:nowrap;", label);
    const v = el("span", "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "—");
    body.appendChild(k);
    body.appendChild(v);
    cells.set(key, v);
  }

  const pathLabel = el("span", "color:#888;white-space:nowrap;", "📁 路径");
  const pathRow = el("div", "display:flex;align-items:center;gap:6px;min-width:0;");
  const pathText = el(
    "span",
    "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ca3af;",
    "—",
  );
  const openBtn = el(
    "button",
    "flex:0 0 auto;cursor:pointer;padding:1px 8px;border-radius:4px;border:1px solid #555;background:#222;color:#ddd;font-size:11px;",
    "打开目录",
  );
  pathRow.appendChild(pathText);
  pathRow.appendChild(openBtn);
  body.appendChild(pathLabel);
  body.appendChild(pathRow);
  root.appendChild(body);

  const panel = {
    root,
    video,
    header,
    body,
    cells,
    pathText,
    openBtn,
    copyAllBtn,
    foldBtn,
    videoOnlyBtn,
    node: null,
    info: null,
    videoOnly: false,
    detailsOpen: true,
  };

  const refreshLayout = () => {
    // 仅画面模式：参数与详情全藏，只留画面（画面高度不变）
    header.style.display = panel.videoOnly ? "none" : "flex";
    body.style.display = panel.videoOnly || !panel.detailsOpen ? "none" : "grid";
    foldBtn.textContent = panel.detailsOpen ? "▾" : "▸";
    videoOnlyBtn.textContent = panel.videoOnly ? "⌄" : "⌃";
    videoOnlyBtn.title = panel.videoOnly ? "展开参数与详情" : "折叠参数，仅显示画面";

    const node = panel.node;
    if (node) {
      node.properties = node.properties || {};
      node.properties.easyVideoOnly = panel.videoOnly;
      node.properties.easyDetailsOpen = panel.detailsOpen;
      for (const name of PARAM_WIDGETS) {
        hideWidget(node.widgets?.find((w) => w.name === name), panel.videoOnly);
      }
      const widget = node.widgets?.find((w) => w.name === "easy_video_panel");
      if (widget?.computeSize) {
        const details = !panel.videoOnly && panel.detailsOpen ? DETAILS_HEIGHT : 0;
        const head = panel.videoOnly ? 0 : HEADER_HEIGHT;
        widget.computeSize = () => [node.size?.[0] ?? 360, PLAYER_HEIGHT + head + details + 6];
      }
      const width = node.size?.[0] ?? 360;
      const height = node.computeSize ? node.computeSize()[1] : node.size?.[1] ?? 400;
      node.setSize?.([width, Math.max(160, height)]);
      node.setDirtyCanvas?.(true, true);
    }
  };

  videoOnlyBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.videoOnly = !panel.videoOnly;
    refreshLayout();
  });

  foldBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.detailsOpen = !panel.detailsOpen;
    refreshLayout();
  });
  title.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.detailsOpen = !panel.detailsOpen;
    refreshLayout();
  });

  copyAllBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const info = panel.info;
    const lines = [info?.filename ? `文件名称 ${info.filename}` : null]
      .concat(ROWS.map(([key, label, fmt]) => `${label.replace(/^\S+\s/, "")} ${fmt(info)}`))
      .filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      copyAllBtn.textContent = "已复制";
      setTimeout(() => {
        copyAllBtn.textContent = "复制全部";
      }, 1200);
    } catch (error) {
      console.warn("[EasyMedia] 复制详情失败：", error);
    }
  });

  openBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  openBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const info = panel.info;
    if (!info?.path) return;
    try {
      const res = await fetch("/easy-media/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: info.path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) console.warn("[EasyMedia] 打开目录失败：", data?.error || res.status);
    } catch (error) {
      console.warn("[EasyMedia] 打开目录失败：", error);
    }
  });

  panel.refreshLayout = refreshLayout;
  return panel;
}

function applyInfo(panel, info) {
  if (!info) return;
  panel.info = info;
  const params = new URLSearchParams({
    filename: info.filename || "",
    subfolder: info.subfolder || "",
    type: info.type || "output",
  });
  if (info.filename) panel.video.src = `/view?${params.toString()}&t=${Date.now()}`;
  for (const [key, , fmt] of ROWS) {
    const cell = panel.cells.get(key);
    if (cell) cell.textContent = fmt(info);
  }
  panel.pathText.textContent = info.path || info.filename || "—";
  panel.pathText.title = info.path || "";
}

function hideWidget(widget, hide) {
  if (!widget) return;
  if (hide) {
    if (widget._easyOrigComputeSize === undefined) widget._easyOrigComputeSize = widget.computeSize ?? null;
    widget.computeSize = () => [0, -4];
  } else if (widget._easyOrigComputeSize !== undefined) {
    const original = widget._easyOrigComputeSize;
    widget._easyOrigComputeSize = undefined;
    if (original) widget.computeSize = original;
    else delete widget.computeSize;
  }
}

function ensurePanel(node) {
  if (node._easyVideoPanel) return node._easyVideoPanel;
  const panel = buildPanel();
  node._easyVideoPanel = panel;
  panel.node = node;
  const widget = node.addDOMWidget("easy_video_panel", "easy_video_panel", panel.root, { hideOnZoom: false });
  widget.computeSize = () => [node.size?.[0] ?? 360, PLAYER_HEIGHT + HEADER_HEIGHT + DETAILS_HEIGHT + 6];
  panel.videoOnly = node.properties?.easyVideoOnly === true;
  panel.detailsOpen = node.properties?.easyDetailsOpen !== false;
  panel.refreshLayout();
  if (node.size && node.size[1] < 430) node.setSize([node.size[0], 430]);
  return panel;
}

app.registerExtension({
  name: "easy.media.saveVideo.panel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "easy saveVideo") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      try {
        ensurePanel(this);
      } catch (error) {
        console.warn("[EasyMedia] 创建视频面板失败：", error);
      }
      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message, ...rest) {
      const result = onExecuted?.apply(this, [message, ...rest]);
      const info = Array.isArray(message?.easy_video_info) ? message.easy_video_info[0] : null;
      if (info) this._easyVideoInfo = info;
      if (info) {
        try {
          applyInfo(ensurePanel(this), info);
        } catch (error) {
          console.warn("[EasyMedia] 刷新视频面板失败：", error);
        }
      }
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info, ...rest) {
      const result = onConfigure?.apply(this, [info, ...rest]);
      try {
        const cached = this._easyVideoInfo;
        const panel = ensurePanel(this);
        if (cached) applyInfo(panel, cached);
        panel.videoOnly = this.properties?.easyVideoOnly === true;
        panel.detailsOpen = this.properties?.easyDetailsOpen !== false;
        panel.refreshLayout();
      } catch (error) {
        console.warn("[EasyMedia] 恢复视频面板失败：", error);
      }
      return result;
    };
  },
});
