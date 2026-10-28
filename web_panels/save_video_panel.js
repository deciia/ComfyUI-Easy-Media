import { app } from "../../scripts/app.js";

/**
 * Save Video（easy saveVideo）节点面板 —— 参考班长「🎥 视频合并」的展示形态：
 *  - 节点创建即出现占位面板（播放器 + 可折叠的「视频详情」）
 *  - 执行完成后自动填入视频、刷新详情
 *  - 详情最后一行是路径 + 「打开目录」
 * 只做展示，不改变任何执行逻辑。
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

function buildPanel() {
  const root = el("div", "display:flex;flex-direction:column;background:#141414;border:1px solid #333;border-radius:6px;overflow:hidden;");

  const video = el("video", "width:100%;height:220px;background:#000;object-fit:contain;display:block;");
  video.controls = true;
  video.loop = false;
  video.preload = "metadata";
  video.muted = true;
  root.appendChild(video);

  // 折叠头
  const header = el(
    "div",
    "display:flex;align-items:center;gap:6px;padding:4px 8px;background:#1b1b1b;border-top:1px solid #333;cursor:pointer;user-select:none;font-size:11px;color:#bbb;",
  );
  const caret = el("span", "width:12px;text-align:center;", "▾");
  const title = el("span", "flex:1 1 auto;", "视频详情");
  header.appendChild(caret);
  header.appendChild(title);
  root.appendChild(header);

  const body = el("div", "display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:6px 8px 8px;font-size:11px;color:#ddd;");
  const cells = new Map();
  for (const [key, label] of ROWS) {
    const k = el("span", "color:#888;white-space:nowrap;", label);
    const v = el("span", "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "—");
    body.appendChild(k);
    body.appendChild(v);
    cells.set(key, v);
  }

  // 路径行：左路径右按钮
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

  let collapsed = false;
  header.addEventListener("click", (event) => {
    event.stopPropagation();
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "grid";
    caret.textContent = collapsed ? "▸" : "▾";
    if (panel.node?.setSize) {
      const width = panel.node.size?.[0] ?? 360;
      panel.node.setSize([width, collapsed ? 300 : 520]);
    }
  });

  const panel = { root, video, cells, pathText, openBtn, node: null, info: null, collapsed: () => collapsed };

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

function ensurePanel(node) {
  if (node._easyVideoPanel) return node._easyVideoPanel;
  const panel = buildPanel();
  node._easyVideoPanel = panel;
  panel.node = node;
  const widget = node.addDOMWidget("easy_video_panel", "easy_video_panel", panel.root, { hideOnZoom: false });
  widget.computeSize = () => [node.size?.[0] ?? 360, panel.collapsed() ? 300 : 540];
  if (node.size && node.size[1] < 520) node.setSize([node.size[0], 520]);
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

    // 从工作流恢复时，用节点上缓存的详情回填（ui 数据不随 workflow 保存）
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info, ...rest) {
      const result = onConfigure?.apply(this, [info, ...rest]);
      try {
        const cached = this._easyVideoInfo;
        ensurePanel(this);
        if (cached) applyInfo(this._easyVideoPanel, cached);
      } catch (error) {
        console.warn("[EasyMedia] 恢复视频面板失败：", error);
      }
      return result;
    };
  },
});
