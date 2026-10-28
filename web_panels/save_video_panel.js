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

/** 隐藏/恢复原生 widget：三处一起改（Vue 节点渲染只看 hidden 与 computeLayoutSize） */
function hideWidget(widget, hide) {
  if (!widget) return;
  if (hide) {
    if (widget._easySizeSaved) return;
    widget._easySizeSaved = { cs: widget.computeSize, cls: widget.computeLayoutSize };
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0, maxWidth: 0 });
  } else if (widget._easySizeSaved) {
    const saved = widget._easySizeSaved;
    widget.computeSize = saved.cs;
    if (saved.cls) widget.computeLayoutSize = saved.cls;
    else delete widget.computeLayoutSize;
    widget.hidden = false;
    delete widget._easySizeSaved;
  }
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
  const videoOnlyBtn = el("button", `margin-left:auto;width:24px;height:19px;padding:0;${BTN_CSS}`, "▲");
  videoOnlyBtn.title = "折叠参数，仅显示画面";
  videoOnlyBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  kindBar.appendChild(videoOnlyBtn);
  root.appendChild(kindBar);

  // ── 画框（可伸缩）──
  const videoWrap = el("div", "position:relative;flex:1 1 auto;min-height:60px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;");
  const video = el("video", "width:100%;height:100%;background:#000;object-fit:contain;display:block;");
  video.controls = true;
  video.loop = false;
  video.preload = "metadata";
  video.muted = true;
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

  // ── 调色台（固定高度，可折叠）──
  const colorHeader = el(
    "div",
    `display:flex;align-items:center;gap:6px;height:${HEADER_HEIGHT}px;flex:0 0 auto;padding:0 8px;background:#1b1b1b;border-top:1px solid #333;user-select:none;font-size:11px;color:#bbb;box-sizing:border-box;`,
  );
  const colorFold = el("button", BTN_CSS, "▸");
  const colorTitle = el("span", "flex:1 1 auto;cursor:pointer;", "🎨 调色台");
  const colorReset = el("button", BTN_CSS, "重置");
  colorHeader.appendChild(colorFold);
  colorHeader.appendChild(colorTitle);
  colorHeader.appendChild(colorReset);
  root.appendChild(colorHeader);

  const colorBody = el("div", "flex:0 0 auto;display:none;flex-direction:column;gap:6px;padding:6px 8px;border-top:1px solid #2a2a2a;background:#171717;font-size:11px;color:#ddd;");
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
  const colorStatus = el("span", "flex:1 1 auto;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "");
  colorActions.appendChild(bakeBtn);
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
    videoOnlyBtn,
    kindBar,
    kindButtons,
    colorHeader,
    colorBody,
    colorFold,
    colorTitle,
    colorReset,
    bakeBtn,
    colorStatus,
    sliders,
    bloomLayer,
    mistLayer,
    halationLayer,
    node: null,
    info: null,
    videoOnly: false,
    detailsOpen: true,
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

    header.style.display = panel.videoOnly ? "none" : "flex";
    body.style.display = panel.videoOnly || !panel.detailsOpen ? "none" : "grid";
    colorHeader.style.display = panel.videoOnly ? "none" : "flex";
    colorBody.style.display = panel.videoOnly || !panel.colorOpen ? "none" : "flex";
    colorFold.textContent = panel.colorOpen ? "▾" : "▸";
    foldBtn.textContent = panel.detailsOpen ? "▾" : "▸";
    videoOnlyBtn.textContent = panel.videoOnly ? "▼" : "▲";
    videoOnlyBtn.title = panel.videoOnly ? "展开参数与详情" : "折叠参数，仅显示画面";

    if (node) {
      node.properties = node.properties || {};
      node.properties.easyVideoOnly = panel.videoOnly;
      node.properties.easyDetailsOpen = panel.detailsOpen;
      node.properties.easyColorOpen = panel.colorOpen;

      for (const name of PARAM_WIDGETS) {
        hideWidget(node.widgets?.find((w) => w.name === name), panel.videoOnly);
      }
      if (!panel.videoOnly) applyKindWidgets(node, kind);

      // 面板高度下限：折叠时更小，展开时保证详情可见
      const widget = node.widgets?.find((w) => w.name === "easy_video_panel");
      if (widget) {
        const audioKind = kind === "audio";
        widget.computeLayoutSize = () => ({
          minHeight: panel.videoOnly
            ? KIND_BAR_HEIGHT + 60
            : audioKind
              ? KIND_BAR_HEIGHT + 54 + HEADER_HEIGHT + 40
              : MIN_PANEL_HEIGHT,
          minWidth: 0,
        });
      }
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
  colorFold.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.colorOpen = !panel.colorOpen;
    refreshLayout();
  });
  colorTitle.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.colorOpen = !panel.colorOpen;
    refreshLayout();
  });
  colorReset.addEventListener("click", (event) => {
    event.stopPropagation();
    resetColorTune();
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
  for (const name of managed) {
    hideWidget(node.widgets?.find((w) => w.name === name), !show.has(name));
  }
}

function syncKindButtons(panel) {
  const node = panel?.node;
  if (!node || !panel?.kindButtons) return;
  const current = currentKind(node);
  for (const [kind, btn] of panel.kindButtons) {
    const active = kind === current;
    btn.style.borderColor = active ? "#39a0ff" : "#4a4a4a";
    btn.style.background = active ? "rgba(29,78,216,.85)" : "rgba(20,20,20,.85)";
    btn.style.opacity = active ? "1" : "0.7";
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
  hideNativePreviews(panel);
  panel.refreshLayout?.();
}

/** 后端仍会返回 ui.PreviewVideo，ComfyUI 会在节点里插入原生播放器；这里把它藏掉，只留面板自己的播放器 */
function hideNativePreviews(panel) {
  const node = panel?.node;
  if (!node?.widgets) return;
  for (const widget of node.widgets) {
    if (widget.name === "easy_video_panel") continue;
    const element = widget.element;
    if (!element || element.tagName === "CANVAS") continue;
    const hasMedia = element.querySelector?.("video,audio,img");
    if (!hasMedia) continue;
    element.style.display = "none";
    hideWidget(widget, true);
  }
}

function ensurePanel(node) {
  if (node._easyVideoPanel) return node._easyVideoPanel;
  const panel = buildPanel();
  node._easyVideoPanel = panel;
  panel.node = node;
  const widget = node.addDOMWidget("easy_video_panel", "easy_video_panel", panel.root, { hideOnZoom: false });
  // 关键：不声明 computeSize，只声明可伸缩范围 → 节点多高都由用户拖动决定，多出来的空间归面板
  widget.computeLayoutSize = () => ({
    minHeight: panel.videoOnly ? KIND_BAR_HEIGHT + 60 : MIN_PANEL_HEIGHT,
    minWidth: 0,
  });
  panel.videoOnly = node.properties?.easyVideoOnly === true;
  panel.detailsOpen = node.properties?.easyDetailsOpen !== false;
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

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info, ...rest) {
      const result = onConfigure?.apply(this, [info, ...rest]);
      try {
        const cached = this._easyVideoInfo;
        const panel = ensurePanel(this);
        if (cached) applyInfo(panel, cached);
        panel.videoOnly = this.properties?.easyVideoOnly === true;
        panel.detailsOpen = this.properties?.easyDetailsOpen !== false;
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
