import { app } from "../../scripts/app.js";

/**
 * Save Video（easy saveVideo）节点面板：
 * 执行完成后在节点内显示内嵌播放器 + 视频详情 + 打开目录/复制路径。
 * 参考班长「🎥 视频合并」节点的展示形态，但只做展示，不改执行逻辑。
 */
const VARIANTS = [
  ["filename", "文件名称"],
  ["size", "文件体积"],
  ["resolution", "物理尺寸"],
  ["frames", "总帧数"],
  ["duration", "播放时间"],
  ["fps", "视频帧率"],
  ["codec", "编码格式"],
  ["format", "容器格式"],
];

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtSeconds(sec) {
  const n = Number(sec) || 0;
  if (!n) return "—";
  if (n < 60) return `${n.toFixed(2)} 秒`;
  const m = Math.floor(n / 60);
  return `${m} 分 ${(n - m * 60).toFixed(1)} 秒`;
}

function buildPanel() {
  const root = document.createElement("div");
  root.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:6px",
    "padding:6px",
    "border:1px solid #333",
    "border-radius:6px",
    "background:#141414",
    "font-size:11px",
    "color:#ddd",
  ].join(";");

  const video = document.createElement("video");
  video.controls = true;
  video.loop = false;
  video.style.cssText = "width:100%;max-height:260px;background:#000;border-radius:4px;";
  root.appendChild(video);

  const details = document.createElement("div");
  details.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:2px 8px;";
  root.appendChild(details);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";
  const openBtn = document.createElement("button");
  openBtn.textContent = "📂 打开目录";
  openBtn.style.cssText = "cursor:pointer;padding:2px 8px;border-radius:4px;border:1px solid #555;background:#222;color:#ddd;";
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "📋 复制路径";
  copyBtn.style.cssText = openBtn.style.cssText;
  row.appendChild(openBtn);
  row.appendChild(copyBtn);
  root.appendChild(row);

  return { root, video, details, openBtn, copyBtn };
}

function renderInfo(node, info) {
  if (!info) return;
  let panel = node._easyVideoPanel;
  if (!panel) {
    panel = buildPanel();
    node._easyVideoPanel = panel;
    const widget = node.addDOMWidget("easy_video_panel", "easy_video_panel", panel.root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => null,
      setValue: () => {},
    });
    widget.computeSize = () => [node.size?.[0] ?? 320, 420];
  }

  const { video, details, openBtn, copyBtn } = panel;
  const params = new URLSearchParams({
    filename: info.filename || "",
    subfolder: info.subfolder || "",
    type: info.type || "output",
  });
  video.src = `/view?${params.toString()}&t=${Date.now()}`;

  const values = {
    filename: info.filename || "—",
    size: fmtBytes(info.size_bytes),
    resolution: info.width && info.height ? `${info.width} × ${info.height}` : "—",
    frames: info.frames ? `${info.frames} 帧` : "—",
    duration: fmtSeconds(info.duration),
    fps: info.fps ? `${info.fps} FPS` : "—",
    codec: info.codec || info.format || "—",
    format: (info.format || "").toUpperCase() || "—",
  };
  details.replaceChildren(
    ...VARIANTS.flatMap(([key, label]) => {
      const k = document.createElement("span");
      k.textContent = label;
      k.style.color = "#888";
      const v = document.createElement("span");
      v.textContent = values[key] ?? "—";
      return [k, v];
    }),
  );

  openBtn.onclick = async (event) => {
    event.stopPropagation();
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
  };
  copyBtn.onclick = async (event) => {
    event.stopPropagation();
    const text = info.path || info.filename || "";
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "✅ 已复制";
      setTimeout(() => {
        copyBtn.textContent = "📋 复制路径";
      }, 1500);
    } catch (error) {
      console.warn("[EasyMedia] 复制路径失败：", error);
    }
  };

  node.setSize?.([Math.max(node.size?.[0] ?? 320, 340), Math.max(node.size?.[1] ?? 300, 560)]);
}

app.registerExtension({
  name: "easy.media.saveVideo.panel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "easy saveVideo") return;

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message, ...rest) {
      const result = onExecuted?.apply(this, [message, ...rest]);
      const info = Array.isArray(message?.easy_video_info) ? message.easy_video_info[0] : null;
      if (info) {
        try {
          renderInfo(this, info);
        } catch (error) {
          console.warn("[EasyMedia] 渲染视频面板失败：", error);
        }
      }
      return result;
    };
  },
});
