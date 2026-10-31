import { app } from "../../scripts/app.js";

/**
 * 「多轨项目」节点：视频提交次数 / 仅音频分辨率 只在 sampling_mode=audio_first 时显示。
 *
 * 这两个控件是节点级 widget（追加在列表末尾，避免旧工作流 widgets_values 错位），
 * 所以需要在前端按采样模式动态隐藏/显示。
 */
const NODE_TYPE = "easy multitrackProject";
const FIELDS = ["视频提交次数", "仅音频分辨率"];

function setWidgetHidden(widget, hidden) {
  if (!widget) return;
  if (!widget.__afOrig) {
    widget.__afOrig = {
      computeSize: widget.computeSize,
      computeLayoutSize: widget.computeLayoutSize,
    };
  }
  if (hidden) {
    if (widget.__afHidden) return;
    widget.__afHidden = true;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.computeLayoutSize = () => ({
      minHeight: 0,
      maxHeight: 0,
      minWidth: 0,
      maxWidth: 0,
    });
  } else {
    if (!widget.__afHidden) return;
    widget.__afHidden = false;
    widget.hidden = false;
    if (widget.__afOrig.computeSize) widget.computeSize = widget.__afOrig.computeSize;
    else delete widget.computeSize;
    if (widget.__afOrig.computeLayoutSize) {
      widget.computeLayoutSize = widget.__afOrig.computeLayoutSize;
    } else {
      delete widget.computeLayoutSize;
    }
  }
}

function applyVisibility(node) {
  if (!node || node.comfyClass !== NODE_TYPE || !node.widgets) return;
  const mode = node.widgets.find((widget) => widget.name === "sampling_mode");
  const isAudioFirst = mode ? mode.value === "audio_first" : false;
  for (const name of FIELDS) {
    setWidgetHidden(node.widgets.find((widget) => widget.name === name), !isAudioFirst);
  }
  if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
    try {
      node.setSize([node.size[0], node.computeSize()[1]]);
    } catch (error) {
      // 节点尺寸调整失败不影响显示逻辑
      console.debug("[EasyMedia] audio_first visibility resize skipped", error);
    }
  }
}

function hookNode(node) {
  if (!node || node.comfyClass !== NODE_TYPE || !node.widgets) return;
  const mode = node.widgets.find((widget) => widget.name === "sampling_mode");
  if (mode && !mode.__afHooked) {
    mode.__afHooked = true;
    const original = mode.callback;
    mode.callback = function (...args) {
      const result = original ? original.apply(this, args) : undefined;
      setTimeout(() => applyVisibility(node), 0);
      return result;
    };
  }
  applyVisibility(node);
}

app.registerExtension({
  name: "Deciia.EasyMedia.AudioFirstVisibility",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      setTimeout(() => hookNode(this), 0);
      return result;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => hookNode(this), 0);
      return result;
    };
  },
});
