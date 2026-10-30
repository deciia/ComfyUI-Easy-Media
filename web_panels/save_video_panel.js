import { app } from "../../scripts/app.js";

/**
 * Save Video（easy saveVideo）节点面板。
 *
 * 尺寸模型与「多轨项目视频合并」一致：
 *  - 面板 widget **不声明 computeSize**，只用 computeLayoutSize({minHeight}) 成为“可伸缩项”；
 *  - 节点多高由用户拖动决定，多出来的空间全部给画框，画面 object-fit: contain 等比居中；
 *  - 面板内部用 flex 布局（画框 flex:1），不写死任何像素高度，也不回写节点尺寸。
 */
const ROWS = [
  ["elapsed", "⏱️ 累计用时", (i) => (i?.save_seconds ? `${i.save_seconds} 秒` : "—")],
  ["filename", "📄 文件名称", (i) => i?.filename || "—"],
  ["resolution", "📐 物理尺寸", (i) => (i?.width && i?.height ? `${i.width} × ${i.height}` : "—")],
  ["frames", "🎞️ 总帧数", (i) => (i?.frames ? `${i.frames} 帧` : i?.count ? `${i.count} 张` : "—")],
  ["duration", "▶️ 播放时间", (i) => secs(i?.duration)],
  ["fps", "🎬 视频帧率", (i) => (i?.fps ? `${i.fps} FPS` : "—")],
  ["size", "💾 文件体积", (i) => bytes(i?.size_bytes)],
  ["format", "🎨 编码格式", (i) => (i?.format || "").toUpperCase() || "—"],
  ["audio", "🔊 音频", (i) => (i?.has_audio ? "有声" : "—")],
];

const KIND_ICONS = [
  { kind: "video", icon: "🎬", title: "保存视频" },
  { kind: "images", icon: "🖼️", title: "保存图像序列" },
  { kind: "audio", icon: "🎵", title: "保存音频" },
];

/** 折叠按钮要收起的所有参数控件 */
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
  "save_kind",
  "image_format",
  "audio_format",
  "notify_sound",
];

/** 每种形态下应显示的专属参数（其余隐藏） */
const KIND_WIDGETS = {
  video: ["video_format", "adopt_source_video"],
  images: ["image_format"],
  audio: ["audio_format"],
};

const KIND_BAR_HEIGHT = 24;
const HEADER_HEIGHT = 26;
const MIN_PANEL_HEIGHT = 150;

const COLOR_GROUPS = [
  { title: "🎨 饱和度", rows: [{ key: "🎨 饱和度", label: "饱和度", min: 0, max: 200, step: 1, def: 100, unit: "%", scale: 0.01 }] },
  {
    title: "✨ 泛光 Bloom",
    rows: [
      { key: "✨ 泛光强度", label: "强度", min: 0, max: 100, step: 1, def: 0, unit: "%", scale: 0.01 },
      { key: "✨ 泛光起点", label: "起点 · 多亮才发光", min: 0, max: 95, step: 1, def: 75, unit: "%", scale: 0.01 },
      { key: "✨ 泛光范围", label: "范围 · 扩散多远", min: 1, max: 10, step: 0.5, def: 4, unit: "", scale: 1 },
    ],
  },
  {
    title: "🌫️ 柔雾 Mist",
    rows: [
      { key: "🌫️ 柔雾强度", label: "强度 · 柔焦量", min: 0, max: 100, step: 1, def: 0, unit: "%", scale: 0.01 },
      { key: "🌫️ 柔焦范围", label: "柔焦范围", min: 1, max: 10, step: 0.5, def: 4, unit: "", scale: 1 },
      { key: "🌫️ 灰雾浓度", label: "灰雾 · 抬黑位", min: 0, max: 100, step: 1, def: 30, unit: "%", scale: 0.01 },
    ],
  },
  {
    title: "🔥 暖晕 Halation",
    rows: [
      { key: "🔥 暖晕强度", label: "强度 · 红橙溢出", min: 0, max: 100, step: 1, def: 0, unit: "%", scale: 0.01 },
      { key: "🔥 暖晕起点", label: "起点 · 多亮才出暖晕", min: 0, max: 95, step: 1, def: 70, unit: "%", scale: 0.01 },
      { key: "🔥 暖晕范围", label: "范围 · 扩散多远", min: 1, max: 10, step: 0.5, def: 5, unit: "", scale: 1 },
    ],
  },
];

const BTN_CSS =
  "padding:0 6px;height:18px;line-height:16px;border-radius:3px;border:1px solid #4a4a4a;background:rgba(24,24,24,.9);color:#bbb;cursor:pointer;font-size:10px;";

let panelRef = null;

/** 参数折叠状态：新字段优先；旧节点沿用 easyVideoOnly（它当时把参数一起折叠了） */
function readParamsHidden(properties) {
  const props = properties || {};
  if (props.easyParamsHidden !== undefined) return props.easyParamsHidden !== false;
  return props.easyVideoOnly !== false;
}

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

function currentKind(node) {
  return String(node?.widgets?.find((w) => w.name === "save_kind")?.value ?? "video");
}

/**
 * 隐藏/恢复原生 widget（参数控件）。
 *
 * 四个动作必须一起做，缺一个都会出问题（都踩过）：
 *  1. `type = "hidden"` —— **前端渲染与槽绘制以 type 为准**（ComfyUI DOMWidgetImpl.computeLayoutSize
 *     对 type==='hidden' 直接返回 0；行是否渲染同样看它）。只设 hidden 不够，槽会留在原位/飘到空白处；
 *  2. `hidden = true` —— canvas 渲染旧路径兼容；
 *  3. `computeSize = () => [0, 0]` —— 行高归零，但**不能是 [0, -4]**：负高度会让后续行 y 上移累积、槽错位；
 *  4. `computeLayoutSize` 返回全 0 —— 让布局引擎认为不占位（否则节点被内容高度顶住、拖不动）。
 */
function hideWidget(widget, hide) {
  if (!widget) return;
  if (hide) {
    if (widget._easySizeSaved) return;
    widget._easySizeSaved = {
      type: widget.type,
      cs: widget.computeSize,
      cls: widget.computeLayoutSize,
      hidden: widget.hidden,
      ch: widget.computedHeight,
    };
    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, 0];
    widget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0, maxWidth: 0 });
    // 关键：前端布局直接读 computedHeight（已算好的行高）。曾显示过再被隐藏的 widget 会残留
    // computedHeight=24，Vue 仍为它留一行，而槽标签按 widget.y（已跳过隐藏行）绘制 → 错位 24px×隐藏数。
    widget.computedHeight = 0;
  } else if (widget._easySizeSaved) {
    const saved = widget._easySizeSaved;
    widget.type = saved.type;
    widget.hidden = saved.hidden === true;
    widget.computeSize = saved.cs;
    if (saved.cls) widget.computeLayoutSize = saved.cls;
    else delete widget.computeLayoutSize;
    // 还原行高：原本有值就还回去，没有就删除让前端按 computeSize 重算
    if (saved.ch === undefined) delete widget.computedHeight;
    else widget.computedHeight = saved.ch;
    delete widget._easySizeSaved;
  }
}

function relayoutSlots(node) {
  if (!node) return;
  // 槽位置来自 calculateVueInputSlotPosition → getWidgetSlotY：优先 slot.pos，否则 widget.y + 半行高。
  // 隐藏中段 widget（images/audio 形态隐藏 video_format/adopt_source_video）后若 widget.y 不重算，
  // 其余槽仍按旧 y 绘制 → 浮到下方空白处（本问题的成因）。_arrangeWidgets 不会更新到槽所依赖的 widget.y。
  // arrange() 会重算所有 widget.y（槽随之归位），但它同时把 node.size 重置为 computeSize()，
  // 因此这里先记下尺寸、重排后立刻还原：布局归 arrange，尺寸归用户，互不侵占。
  // 清掉 widget 输入槽缓存的 pos：前端 getWidgetSlotY 里 `if (slot.pos) return slot.pos[1]` 优先用它，
  // 而工作流加载时这些槽带着保存时的旧位置 → 无论 widget 行怎么重排，槽都钉在原地（错位的直接原因）。
  // 清空后 getWidgetSlotY 回落到 `widget.y + NODE_SLOT_HEIGHT/2`，才会跟着行实时对齐。
  for (const input of node.inputs ?? []) {
    if (input && input.widget && input.pos) input.pos = undefined;
  }
  const savedSize = node.size ? [node.size[0], node.size[1]] : null;
  try { node.arrange?.(); } catch { /* ignore */ }
  if (savedSize && typeof node.setSize === "function") {
    try { node.setSize(savedSize); } catch { /* ignore */ }
  }
  try { node.setDirtyCanvas?.(true, true); } catch { /* ignore */ }
}

function buildPanel() {
  // 根容器：铺满 widget 分配到的空间；纵向 flex，画框吃掉剩余
  const root = el(
    "div",
    "display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:#141414;border:1px solid #333;border-radius:6px;overflow:hidden;",
  );

  // ── 形态图标行（固定高度）──
  const kindBar = el(
    "div",
    `display:flex;align-items:center;gap:4px;height:${KIND_BAR_HEIGHT}px;flex:0 0 auto;padding:0 6px;background:#1b1b1b;border-bottom:1px solid #333;box-sizing:border-box;`,
  );
  const kindButtons = new Map();
  for (const item of KIND_ICONS) {
    const btn = el(
      "button",
      "width:24px;height:19px;padding:0;border-radius:4px;border:1px solid #4a4a4a;background:rgba(20,20,20,.85);color:#ddd;cursor:pointer;font-size:12px;line-height:17px;",
      item.icon,
    );
    btn.title = item.title;
    btn.addEventListener("mousedown", (event) => event.stopPropagation());
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      setSaveKind(panel, item.kind);
    });
    kindBar.appendChild(btn);
    kindButtons.set(item.kind, btn);
  }
  // 右侧三个按钮（都在三角形折叠键左边 → 详情、调色台，最右是三角形）：
  //   📋 视频详情折叠（默认折叠） / 🎨 调色台 / ▲ 只折叠上方的设置参数
  const barBtnCss = `width:22px;height:19px;padding:0;${BTN_CSS}`;
  const detailsBtn = el("button", `margin-left:auto;${barBtnCss}`, "📋");
  detailsBtn.title = "展开/收起视频详情（默认折叠）";
  detailsBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  const colorBtn = el("button", barBtnCss, "🎨");
  colorBtn.title = "调色台（展开/收起）";
  colorBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  const paramsBtn = el("button", barBtnCss, "▲");
  paramsBtn.title = "折叠上方设置参数";
  paramsBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  kindBar.appendChild(detailsBtn);
  kindBar.appendChild(colorBtn);
  kindBar.appendChild(paramsBtn);
  root.appendChild(kindBar);

  // ── 画框（可伸缩）──
  const videoWrap = el("div", "position:relative;flex:1 1 auto;min-height:60px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;");
  const video = el(
    "video",
    // 绝对定位填满画框：<video> 无源时固有尺寸是 300×150，若留在文档流里会撑住 flex 容器，
    // 使「保存视频」形态的最小高度被抬高、节点压不下去（图片/音频形态 video 是 display:none 所以没这问题）。
    "position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;display:block;",
  );
  video.controls = true;
  video.loop = false;
  video.preload = "metadata";
  video.muted = true;
  // 无片时浏览器会给 <video> 画一块灰色占位（盖住容器黑底），而控件条在 video 元素内部，
  // 不能隐藏元素（否则播放条也没了）。用 1×1 纯黑 PNG 作 poster：无片时黑底 + 播放条都在，
  // 有片后 poster 自动被视频画面替换。
  video.poster =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
  videoWrap.appendChild(video);

  const imagePreview = el("img", "width:100%;height:100%;object-fit:contain;background:#000;display:none;");
  imagePreview.alt = "";
  videoWrap.appendChild(imagePreview);

  const audioPlayer = el("audio", "width:100%;height:54px;padding:8px 10px;box-sizing:border-box;background:#000;display:none;");
  audioPlayer.controls = true;
  audioPlayer.preload = "metadata";
  videoWrap.appendChild(audioPlayer);

  const bloomLayer = el("div", "position:absolute;inset:0;pointer-events:none;opacity:0;mix-blend-mode:screen;backdrop-filter:blur(8px) brightness(1.35);");
  const mistLayer = el("div", "position:absolute;inset:0;pointer-events:none;opacity:0;mix-blend-mode:lighten;backdrop-filter:blur(8px) brightness(1.12);");
  const halationLayer = el("div", "position:absolute;inset:0;pointer-events:none;opacity:0;mix-blend-mode:screen;backdrop-filter:blur(8px) sepia(1) saturate(4) hue-rotate(-18deg);");
  videoWrap.appendChild(bloomLayer);
  videoWrap.appendChild(mistLayer);
  videoWrap.appendChild(halationLayer);

  // 三点菜单已移除：调色台与视频详情各自有按钮，避免与原生播放器 ⋮ 重复
  root.appendChild(videoWrap);

  // ── 详情标题栏（固定）──
  const header = el(
    "div",
    `display:flex;align-items:center;gap:6px;height:${HEADER_HEIGHT}px;flex:0 0 auto;padding:0 8px;background:#1b1b1b;border-top:1px solid #333;user-select:none;font-size:11px;color:#bbb;box-sizing:border-box;`,
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

  const body = el("div", "flex:0 0 auto;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:6px 8px 8px;font-size:11px;color:#ddd;");
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
  const pathText = el("span", "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ca3af;", "—");
  const openBtn = el("button", "flex:0 0 auto;cursor:pointer;padding:1px 8px;border-radius:4px;border:1px solid #555;background:#222;color:#ddd;font-size:11px;", "打开目录");
  pathRow.appendChild(pathText);
  pathRow.appendChild(openBtn);
  body.appendChild(pathLabel);
  body.appendChild(pathRow);
  root.appendChild(body);

  // ── 调色台参数区（入口在画面右下角 ⋮ 菜单，这里只放展开后的滑杆）──
  const colorBody = el("div", "flex:0 0 auto;display:none;flex-direction:column;gap:6px;padding:6px 8px;border-top:1px solid #333;background:#171717;font-size:11px;color:#ddd;");
  const sliders = new Map();
  for (const group of COLOR_GROUPS) {
    const g = el("div", "display:flex;flex-direction:column;gap:3px;");
    g.appendChild(el("div", "color:#9bd0ff;font-size:10px;", group.title));
    for (const row of group.rows) {
      const line = el("div", "display:flex;align-items:center;gap:6px;");
      line.appendChild(el("span", "flex:0 0 108px;color:#888;white-space:nowrap;", row.label));
      const input = el("input", "flex:1 1 auto;min-width:0;");
      input.type = "range";
      input.min = String(row.min);
      input.max = String(row.max);
      input.step = String(row.step);
      input.value = String(row.def);
      const value = el("span", "flex:0 0 44px;text-align:right;color:#bbb;font-variant-numeric:tabular-nums;", `${row.def}${row.unit}`);
      input.addEventListener("mousedown", (event) => event.stopPropagation());
      input.addEventListener("input", () => {
        value.textContent = `${input.value}${row.unit}`;
        applyColorPreview(panel);
      });
      line.appendChild(input);
      line.appendChild(value);
      g.appendChild(line);
      sliders.set(row.key, { input, value, row });
    }
    colorBody.appendChild(g);
  }
  const colorActions = el("div", "display:flex;align-items:center;gap:6px;padding-top:2px;");
  const bakeBtn = el("button", "cursor:pointer;padding:2px 10px;border-radius:4px;border:1px solid #2b6cb0;background:#1d4ed8;color:#fff;font-size:11px;", "应用并导出");
  const colorResetBtn = el("button", "cursor:pointer;padding:2px 8px;border-radius:4px;border:1px solid #4a4a4a;background:rgba(24,24,24,.9);color:#bbb;font-size:11px;", "♻️ 重置");
  colorResetBtn.title = "把调色台所有参数恢复默认";
  colorResetBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  colorResetBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    resetColorTune();
  });
  const colorStatus = el("span", "flex:1 1 auto;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "");
  colorActions.appendChild(bakeBtn);
  colorActions.appendChild(colorResetBtn);
  colorActions.appendChild(colorStatus);
  colorBody.appendChild(colorActions);
  root.appendChild(colorBody);

  const panel = {
    root,
    video,
    imagePreview,
    audioPlayer,
    videoWrap,
    header,
    body,
    cells,
    pathText,
    openBtn,
    copyAllBtn,
    foldBtn,
    detailsBtn,
    colorBtn,
    paramsBtn,
    kindBar,
    kindButtons,
    colorBody,
    bakeBtn,
    colorStatus,
    sliders,
    bloomLayer,
    mistLayer,
    halationLayer,
    node: null,
    info: null,
    paramsHidden: false,
    detailsOpen: false,
    colorOpen: false,
  };
  panelRef = panel;

  const refreshLayout = () => {
    const node = panel.node;
    const kind = currentKind(node);
    const hasPlayer = kind !== "audio";

    panel.videoWrap.style.display = "flex";
    if (kind === "audio") {
      // 音频：画框不占空间，只留一条播放条
      panel.videoWrap.style.flex = "0 0 auto";
      panel.videoWrap.style.height = "54px";
      panel.videoWrap.style.minHeight = "0";
    } else {
      panel.videoWrap.style.flex = "1 1 auto";
      panel.videoWrap.style.height = "";
      panel.videoWrap.style.minHeight = "60px";
    }
    panel.video.style.display = kind === "video" ? "block" : "none";
    panel.video.controls = kind === "video";
    panel.imagePreview.style.display = kind === "images" && panel.imagePreview.src ? "block" : "none";
    if (panel.audioPlayer) panel.audioPlayer.style.display = kind === "audio" ? "block" : "none";

    // 详情与调色台各有独立开关；三角形只控制上方的设置参数
    header.style.display = "flex";
    body.style.display = panel.detailsOpen ? "grid" : "none";
    colorBody.style.display = panel.colorOpen ? "flex" : "none";
    foldBtn.textContent = panel.detailsOpen ? "▾" : "▸";
    detailsBtn.style.borderColor = panel.detailsOpen ? "#4a90d9" : "#4a4a4a";
    colorBtn.style.borderColor = panel.colorOpen ? "#4a90d9" : "#4a4a4a";
    paramsBtn.textContent = panel.paramsHidden ? "▼" : "▲";
    paramsBtn.title = panel.paramsHidden ? "展开上方设置参数" : "折叠上方设置参数";

    if (node) {
      node.properties = node.properties || {};
      node.properties.easyParamsHidden = panel.paramsHidden;
      node.properties.easyDetailsOpen = panel.detailsOpen;
      node.properties.easyColorOpen = panel.colorOpen;

      if (!panel.paramsHidden) applyKindWidgets(node, kind);
      for (const name of PARAM_WIDGETS) {
        hideWidget(node.widgets?.find((w) => w.name === name), panel.paramsHidden);
      }

      // 行显隐已变化 → 重算槽位置（否则切 images/audio 时槽错位）
      relayoutSlots(node);
      // 高度下限由 addDOMWidget 的 getMinHeight 动态读取（见 ensurePanel），这里不再重设布局函数
      node.setDirtyCanvas?.(true, true);
    }
  };

  paramsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.paramsHidden = !panel.paramsHidden;
    refreshLayout();
  });
  detailsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.detailsOpen = !panel.detailsOpen;
    refreshLayout();
  });
  colorBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.colorOpen = !panel.colorOpen;
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
  bakeBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  bakeBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await bakeColorTune(panel);
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

function applyKindWidgets(node, kind) {
  const show = new Set(KIND_WIDGETS[kind] ?? []);
  const managed = new Set(Object.values(KIND_WIDGETS).flat());
  let changed = false;
  for (const name of managed) {
    const widget = node.widgets?.find((w) => w.name === name);
    if (!widget) continue;
    const shouldHide = !show.has(name);
    const isHidden = Boolean(widget._easySizeSaved) || widget.hidden === true;
    if (shouldHide !== isHidden) changed = true;
    hideWidget(widget, shouldHide);
  }
  // 形态专属参数显隐变化后重算槽位置（images/audio 形态的槽错位就出在这里）
  if (changed) relayoutSlots(node);
}

/**
 * 按「输入槽实际接线情况」算可保存形态（前端只能看槽类型，帧数/实际类型由后端判断）：
 *  - 只接 audio          → 仅 audio
 *  - 接了 images(+audio) → images / video / audio
 *  - 只接 images        → images / video（多帧图像流→无声视频；单张图由后端报错引导存图片）
 *  - video 槽（*）接了  → 三种都允许（可能是 VIDEO/IMAGE/AUDIO，后端自动分流）
 *  - 完全没接           → 不限制（避免新节点被锁死）
 */
function availableKinds(node) {
  const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
  const connected = (name) => inputs.some((input) => input?.name === name && input?.link != null);
  const hasImages = connected("images");
  const hasVideo = connected("video");
  const hasAudio = connected("audio");
  if (!hasImages && !hasVideo && !hasAudio) return ["video", "images", "audio"];
  const allowed = new Set();
  if (hasVideo) {
    allowed.add("video");
    allowed.add("images");
    allowed.add("audio");
  }
  if (hasImages) {
    allowed.add("images");
    // 图像流（多帧）可保存无声视频 → 🎬 也放开；单张图由后端执行时报错提示
    allowed.add("video");
    if (hasAudio) {
      allowed.add("audio");
    }
  }
  if (hasAudio) allowed.add("audio");
  if (allowed.size === 0) allowed.add("video");
  return ["video", "images", "audio"].filter((kind) => allowed.has(kind));
}

function syncKindButtons(panel) {
  const node = panel?.node;
  if (!node || !panel?.kindButtons) return;
  const allowed = availableKinds(node);
  // 当前形态不被输入支持 → 自动切到第一个可用形态（优先图片/音频，最后才是视频）
  if (!allowed.includes(currentKind(node))) {
    const fallback = ["images", "audio", "video"].find((kind) => allowed.includes(kind)) || "video";
    const widget = node.widgets?.find((w) => w.name === "save_kind");
    if (widget) {
      widget.value = fallback;
      try {
        widget.callback?.(fallback);
      } catch {
        /* 忽略回调异常：值已写入 */
      }
    }
  }
  const current = currentKind(node);
  for (const [kind, btn] of panel.kindButtons) {
    const active = kind === current;
    const usable = allowed.includes(kind);
    btn.style.borderColor = active ? "#39a0ff" : "#4a4a4a";
    btn.style.background = active ? "rgba(29,78,216,.85)" : "rgba(20,20,20,.85)";
    btn.style.opacity = usable ? (active ? "1" : "0.7") : "0.28";
    btn.style.cursor = usable ? "pointer" : "not-allowed";
    btn.disabled = !usable;
    const baseTitle = (KIND_ICONS.find((item) => item.kind === kind) || {}).title || kind;
    btn.title = usable ? baseTitle : `${baseTitle}（当前输入不支持，需要接 ${kind === "audio" ? "音频" : kind === "images" ? "图像+音频" : "视频/图像+音频"}）`;
  }
  applyKindWidgets(node, current);
}

function setSaveKind(panel, kind) {
  const node = panel?.node;
  if (!node) return;
  const widget = node.widgets?.find((w) => w.name === "save_kind");
  if (widget) {
    widget.value = kind;
    widget.callback?.(kind);
  }
  syncKindButtons(panel);
  panel.refreshLayout?.();
}

function colorTune() {
  const panel = panelRef;
  const tune = {};
  if (!panel?.sliders) return tune;
  for (const [key, entry] of panel.sliders) {
    tune[key] = Number(entry.input.value) * entry.row.scale;
  }
  return tune;
}

function resetColorTune() {
  const panel = panelRef;
  if (!panel?.sliders) return;
  for (const [, entry] of panel.sliders) {
    entry.input.value = String(entry.row.def);
    entry.value.textContent = `${entry.row.def}${entry.row.unit}`;
  }
  applyColorPreview(panel);
}

function applyColorPreview(panel) {
  if (!panel?.video) return;
  const tune = colorTune();
  const sat = Number(tune["🎨 饱和度"] ?? 1);
  panel.video.style.filter = Math.abs(sat - 1) < 0.01 ? "" : `saturate(${sat.toFixed(2)})`;

  const bloom = Number(tune["✨ 泛光强度"] ?? 0);
  const bloomRadius = Number(tune["✨ 泛光范围"] ?? 4);
  if (panel.bloomLayer) {
    panel.bloomLayer.style.opacity = bloom > 0.001 ? String(Math.min(0.9, bloom)) : "0";
    panel.bloomLayer.style.backdropFilter = `blur(${(bloomRadius * 2).toFixed(1)}px) brightness(1.35)`;
  }
  const mist = Number(tune["🌫️ 柔雾强度"] ?? 0);
  const mistRadius = Number(tune["🌫️ 柔焦范围"] ?? 4);
  const veil = Number(tune["🌫️ 灰雾浓度"] ?? 0.3);
  if (panel.mistLayer) {
    panel.mistLayer.style.opacity = mist > 0.001 ? String(Math.min(0.9, mist)) : "0";
    panel.mistLayer.style.backdropFilter = `blur(${(mistRadius * 2).toFixed(1)}px) brightness(1.12)`;
    panel.mistLayer.style.background = `rgba(255,255,255,${(veil * Math.min(0.5, mist)).toFixed(3)})`;
  }
  const halation = Number(tune["🔥 暖晕强度"] ?? 0);
  const halationRadius = Number(tune["🔥 暖晕范围"] ?? 5);
  if (panel.halationLayer) {
    panel.halationLayer.style.opacity = halation > 0.001 ? String(Math.min(0.9, halation)) : "0";
    panel.halationLayer.style.backdropFilter =
      `blur(${(halationRadius * 2).toFixed(1)}px) sepia(1) saturate(4) hue-rotate(-18deg)`;
  }
}

async function bakeColorTune(panel) {
  const info = panel?.info;
  if (!info?.path) {
    if (panel?.colorStatus) panel.colorStatus.textContent = "先出一次片再调色";
    return;
  }
  const rows = COLOR_GROUPS.flatMap((g) => g.rows);
  const tune = colorTune();
  const dirty = rows.some((row) => Math.abs(Number(tune[row.key] ?? 0) - row.def * row.scale) > 1e-6);
  if (!dirty) {
    panel.colorStatus.textContent = "参数都是默认值，无需导出";
    return;
  }
  panel.colorStatus.textContent = "导出中…";
  const started = Date.now();
  try {
    const res = await fetch("/banzhang_api/bake_video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src: info.path, tune }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.success) {
      panel.colorStatus.textContent = `导出失败：${data?.msg || res.status}`;
      return;
    }
    panel.colorStatus.textContent = `已导出 ${data.filename || ""}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`;
    if (data.filename) {
      const q = new URLSearchParams({
        filename: data.filename,
        subfolder: info.subfolder || "",
        type: info.type || "output",
      });
      panel.video.src = `/view?${q.toString()}&t=${Date.now()}`;
    }
  } catch (error) {
    panel.colorStatus.textContent = `导出失败：${error}`;
  }
}

function applyInfo(panel, info) {
  if (!info) return;
  panel.info = info;
  const params = new URLSearchParams({
    filename: info.filename || "",
    subfolder: info.subfolder || "",
    type: info.type || "output",
  });
  if (info.kind === "images") {
    const name = info.first_filename || String(info.filename || "").split(" … ")[0];
    if (name) {
      const q = new URLSearchParams({ filename: name, subfolder: info.subfolder || "", type: info.type || "output" });
      panel.imagePreview.src = `/view?${q.toString()}&t=${Date.now()}`;
    }
  } else if (info.kind === "audio") {
    if (info.filename && panel.audioPlayer) {
      panel.audioPlayer.src = `/view?${params.toString()}&t=${Date.now()}`;
    }
  } else if (info.filename) {
    panel.video.src = `/view?${params.toString()}&t=${Date.now()}`;
  }
  for (const [key, , fmt] of ROWS) {
    const cell = panel.cells.get(key);
    if (cell) cell.textContent = fmt(info);
  }
  panel.pathText.textContent = info.path || info.filename || "—";
  panel.pathText.title = info.path || "";
  panel.refreshLayout?.();
}

function ensurePanel(node) {
  if (node._easyVideoPanel) return node._easyVideoPanel;
  const panel = buildPanel();
  node._easyVideoPanel = panel;
  panel.node = node;
  // 尺寸配置与 EasyMedia 其它节点完全一致（见 frontend/src/lib/create-react-widget.ts）：
  // getMinHeight 30 / getMaxHeight = 节点当前高度 / hideOnZoom。这三项就足够让宽高完全归用户拖拽，
  // 不要手写 computeSize/computeLayoutSize，也不要 setSize / arrange（arrange 会把 size 重置为 computeSize）。
  const widget = node.addDOMWidget("easy_video_panel", "easy_video_panel", panel.root, {
    hideOnZoom: false,
    getMinHeight: () => 30,
    getMaxHeight: () => node.size?.[1],
  });
  // 默认：上方设置参数折叠（未显式保存过就按折叠）；视频详情默认折叠；调色台默认收起
  panel.paramsHidden = readParamsHidden(node.properties);
  // 视频详情固定默认折叠（旧节点之前被默认写成了 true，不能再拿它当用户意图）
  panel.detailsOpen = false;
  panel.colorOpen = node.properties?.easyColorOpen === true;
  syncKindButtons(panel);
  panel.refreshLayout();
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

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = onConnectionsChange?.apply(this, args);
      try {
        const panel = ensurePanel(this);
        syncKindButtons(panel);
        panel.refreshLayout?.();
      } catch (error) {
        console.warn("[EasyMedia] 输入变化后刷新保存形态失败：", error);
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
        panel.paramsHidden = readParamsHidden(this.properties);
        panel.detailsOpen = false;
        panel.colorOpen = this.properties?.easyColorOpen === true;
        syncKindButtons(panel);
        panel.refreshLayout();
      } catch (error) {
        console.warn("[EasyMedia] 恢复视频面板失败：", error);
      }
      return result;
    };
  },
});
