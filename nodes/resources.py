"""资源采集器：把「图像/音频/视频加载 + 列表构建 + 时长换算 + 提示词」收进一个节点。

两种供料方式，可混用：
  1) 面板手动添加（本节点自带的资源面板，上传到 input 目录后按文件名读取）；
  2) 连线（autogrow 动态槽，ComfyTV 侧栏也按同一套槽位接线）。
接线优先：接上的槽位覆盖面板同编号素材，剩余面板素材顺延补到末尾。

槽位命名与 ComfyTV 的媒体表约定一致（见 ComfyTV/composables/stages/mediaOrder.ts）：
  images.imageN / videos.videoN / audio.audioN
"""

from __future__ import annotations

import json
import os
import re
from fractions import Fraction

import folder_paths
import torch
from comfy_api.latest import InputImpl, Types, io

from ..utils import silence
CATEGORY_RESOURCES = "EasyUse/Project"

# 面板根 widget：前端渲染资源面板，值是一段 JSON 字符串（{images,videos,audio}）。
TYPE_RESOURCE_MEDIA = io.Custom(io_type="RESOURCE_MEDIA")

# 资源包（单个连线承载图像/音频/视频/帧数/提示词）：接「多轨编辑器」的 collector 输入。
# 用自定义类型而不是多个类型化输出，是为了让 ComfyTV 侧只需要一条连线、且不占用
# widgets_values 值槽（自定义类型不是控件，位置不会错位）。
TYPE_COLLECTOR_BUNDLE = io.Custom(io_type="EASY_COLLECTOR")


def _collector_bundle(
    *,
    active: bool,
    images=None,
    audio=None,
    videos=None,
    frames: int = 0,
    frame_rate: float = 24.0,
    duration_seconds: float = 0.0,
    prompt: str = "",
    settings: dict | None = None,
) -> dict:
    """打包资源采集结果。

    active=False 表示「未放行」，下游按各自时间线跑；active=True 时下游忽略自身时间线，
    按 frames + prompt + 媒体重建单段。settings 携带原 #303 高级设置（分辨率/任务类型/
    参考图尺寸），由下游读取，便于 ComfyTV 只面对本节点。
    """
    bundle = {
        "type": "easy.collector",
        "version": 1,
        "active": bool(active),
        "images": list(images or []),
        "audio": list(audio or []),
        "videos": list(videos or []),
        "frames": int(frames),
        "frame_rate": float(frame_rate),
        "duration_seconds": float(duration_seconds),
        "prompt": str(prompt or ""),
    }
    bundle.update(dict(settings or {}))
    return bundle

# (组名, 槽名前缀, 中文名, 上限)  —— 组名/前缀必须与 ComfyTV 的 mediaOrder 约定一致。
MEDIA_GROUPS = (
    ("images", "image", "图像", 9),
    ("videos", "video", "视频", 3),
    ("audio", "audio", "音频", 3),
)

# ComfyTV 侧栏只渲染「控件」，不渲染连线插槽，所以每类素材额外声明一组上传型 widget：
# 值 = 素材文件名（ComfyTV 写入 "xxx.png [input]" 这类 annotated 名），优先级 接线 > 绑定 > 面板。
MEDIA_BIND_GROUPS = (
    ("images", "image", "图像", 9, "image_upload"),
    ("videos", "video", "视频", 3, "video_upload"),
    ("audio", "audio", "音频", 3, "audio_upload"),
)


def _parse_media_data(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except Exception:
        print("[资源采集器] 面板数据不是合法 JSON，已按空面板处理")
        return {}
    return data if isinstance(data, dict) else {}


def _wired_positions(raw) -> dict:
    """autogrow 传进来的是 {子输入名: 值}：按名字尾号还原槽位位置，接线优先占用该位置。"""
    if isinstance(raw, dict):
        positions = {}
        for key, value in raw.items():
            match = re.search(r"(\d+)$", str(key))
            positions[int(match.group(1)) if match else 0] = value
        return positions
    if isinstance(raw, (list, tuple)):
        return dict(enumerate(raw))
    if raw is None:
        return {}
    return {0: raw}


def _panel_files(data: dict, group: str) -> list:
    slots = data.get(group) if isinstance(data, dict) else None
    if not isinstance(slots, list):
        return []
    files = []
    for slot in slots:
        if isinstance(slot, dict):
            name = str(slot.get("file") or "").strip()
            if name:
                files.append(name)
    return files


def _resolve_input_path(name: str) -> str:
    name = str(name or "").strip().replace("\\", "/")
    if not name:
        raise ValueError("空文件名")
    if os.path.isabs(name) and os.path.exists(name):
        return name
    candidate = os.path.join(folder_paths.get_input_directory(), name)
    if os.path.exists(candidate):
        return candidate
    try:
        annotated = folder_paths.get_annotated_filepath(name)
        if annotated and os.path.exists(annotated):
            return annotated
    except Exception:
        pass
    raise ValueError("找不到素材文件：%s（面板里存的是 input 目录下的相对名）" % name)


def _load_image(name: str):
    from nodes import LoadImage

    path = _resolve_input_path(name)
    image, _mask = LoadImage().load_image(path)
    return image


def _load_audio(name: str):
    from comfy_extras.nodes_audio import load as _load_audio_file

    path = _resolve_input_path(name)
    waveform, sample_rate = _load_audio_file(path)
    return {"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)}


def _load_video(name: str):
    from comfy_api.latest import InputImpl

    path = _resolve_input_path(name)
    return InputImpl.VideoFromFile(path)


_LOADERS = {"images": _load_image, "videos": _load_video, "audio": _load_audio}


def _as_number(value: object, default: float) -> float:
    """ComfyTV 绑定值可能是字符串（"22"、"1"），逐层容错转数字。"""
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _as_bool(value: object, default: bool = False) -> bool:
    """ComfyTV 的绑定值以字符串下发（"true"/"false"），直接 if 判会全部为真。"""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"", "none", "null", "undefined"}:
        return default
    return text in {"1", "true", "yes", "on", "y", "t"}


class ResourceCollector(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy resourceCollector",
            display_name="资源采集器（图像 / 音频 / 视频）",
            category=CATEGORY_RESOURCES,
            description=(
                "资源采集器：一次采集图像/音频/视频，输出三类媒体列表、时长帧数与提示词。\n"
                "· 面板（本节点自带）可直接上传素材；接线槽位（ComfyUI / ComfyTV 均可接）优先覆盖面板同编号素材。\n"
                "· 阻断输出=开（默认）：图像/音频/视频输出空、帧数 0、提示词空，等同未接线（多轨编辑器按时间线跑）。\n"
                "· 阻断输出=关：素材真的灌进多轨编辑器，并按 帧率×秒 覆盖时间线时长（单段）。\n"
                "· 跳过空输入=开：空缺槽位直接丢弃，不补占位素材。"
            ),
            inputs=[
                io.String.Input(
                    "prompt",
                    default="",
                    multiline=True,
                    tooltip="随资源一起下发的提示词；接「多轨编辑器」的 prompt_override 使用。",
                ),
                io.Boolean.Input(
                    "block_output",
                    default=True,
                    label_on="阻断",
                    label_off="放行",
                    tooltip="开：三类媒体输出空列表、帧数 0、提示词空（等同未接线）。关：素材参与生成，并覆盖时间线时长。",
                ),
                io.Boolean.Input(
                    "skip_empty",
                    default=True,
                    label_on="跳过空位",
                    label_off="补齐空位",
                    tooltip="开：空缺槽位不输出。关：空缺槽位补占位素材（图像黑图/音频静音/视频空片），保持编号对齐。",
                ),
                io.Float.Input(
                    "frame_rate",
                    default=24.0,
                    min=1.0,
                    max=240.0,
                    step=1.0,
                    tooltip="帧率：与选项里的秒数相乘得到输出帧数。",
                ),
                io.Float.Input(
                    "duration_seconds",
                    default=5.0,
                    min=0.1,
                    max=60.0,
                    step=0.1,
                    tooltip="时长（秒）：帧数 = round(秒 × 帧率)；接多轨编辑器后即覆盖时间线的时长。",
                ),
                *[
                    io.String.Input(
                        "%s%d" % (prefix, index),
                        default="",
                        optional=True,
                        tooltip="ComfyTV 绑定位 %d/%d：ComfyTV 侧栏把这一行绑到 Upstream，就会写入素材文件名；"
                        "ComfyUI 画布里默认折叠隐藏。优先于面板同编号素材。" % (index, limit),
                        extra_dict={flag: True},
                    )
                    for _group, prefix, _label, limit, flag in MEDIA_BIND_GROUPS
                    for index in range(1, limit + 1)
                ],
                # 分辨率长宽：ComfyTV 侧唯一需要设置的覆盖项（0 = 跟随多轨编辑器）。
                # 注意：新增控件必须追加在末尾，否则 widgets_values 按位置取值会整体错位。
                io.Int.Input(
                    "resolution_width",
                    default=0,
                    min=0,
                    max=8096,
                    step=8,
                    optional=True,
                    advanced=True,
                    tooltip="覆盖宽度（0 = 不用）。宽高同时 > 0 时按自定义长宽，优先级最高。",
                ),
                io.Int.Input(
                    "resolution_height",
                    default=0,
                    min=0,
                    max=8096,
                    step=8,
                    optional=True,
                    advanced=True,
                    tooltip="覆盖高度（0 = 不用）。宽高同时 > 0 时按自定义长宽，优先级最高。",
                ),
                io.Combo.Input(
                    "task_type_override",
                    options=["自动推断", "t2v", "i2v", "r2v", "rv2v", "v2v", "vi2v", "l2v"],
                    default="自动推断",
                    optional=True,
                    advanced=True,
                    tooltip="任务类型覆盖：资源包接管时写入默认项目第一个任务片段的 task_type/task_mode；自动推断 = 按上游媒体推断。",
                ),
                TYPE_RESOURCE_MEDIA.Input(
                    "media_data",
                    optional=True,
                    tooltip="资源面板数据（前端自动维护）：面板里上传的图像/音频/视频文件名。",
                ),
                *[
                    io.Autogrow.Input(
                        group,
                        template=io.Autogrow.TemplatePrefix(
                            input={
                                "images": io.Image.Input("image"),
                                "videos": io.Video.Input("video"),
                                "audio": io.Audio.Input("audio"),
                            }[group],
                            prefix=prefix,
                            min=0,
                            max=limit,
                        ),
                        tooltip="%s槽位（%d 个）：连进来的优先于面板同编号素材；ComfyTV 侧栏请用上面的绑定行。"
                        % (label, limit),
                        extra_dict={"advanced": True},
                    )
                    for group, prefix, label, limit in MEDIA_GROUPS
                ],
            ],
            outputs=[
                io.Image.Output("IMAGE", is_output_list=True, tooltip="图像列表"),
                io.Audio.Output("AUDIO", is_output_list=True, tooltip="音频列表"),
                io.Video.Output("VIDEO", is_output_list=True, tooltip="视频列表"),
                io.Int.Output("FRAMES", tooltip="round(秒 × 帧率)，接多轨编辑器即覆盖时间线时长"),
                io.String.Output("PROMPT", tooltip="提示词原样透传"),
                TYPE_COLLECTOR_BUNDLE.Output(
                    "BUNDLE",
                    tooltip="资源包：接「多轨编辑器」的 collector。接上后编辑器忽略自身时间线，按这里的媒体/帧数/提示词生成。",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        block_output: bool = True,
        skip_empty: bool = True,
        prompt: str = "",
        frame_rate: float = 24.0,
        duration_seconds: float = 5.0,
        media_data: str = "",
        resolution_width: int = 0,
        resolution_height: int = 0,
        task_type_override: str = "自动推断",
        **kwargs,
    ) -> io.NodeOutput:
        block_output = _as_bool(block_output, True)
        skip_empty = _as_bool(skip_empty, True)
        frame_rate = _as_number(frame_rate, 24.0)
        duration_seconds = _as_number(duration_seconds, 5.0)
        # 只保留长宽：放行即覆盖，任务类型/参考图尺寸/画幅比例都跟随多轨编辑器。
        settings = {
            "resolution_width": int(_as_number(resolution_width, 0)),
            "resolution_height": int(_as_number(resolution_height, 0)),
            "task_type_override": str(task_type_override or "自动推断").strip() or "自动推断",
        }
        if block_output:
            print("[资源采集器] 阻断输出=开：图像/音频/视频为空、帧数 0、提示词空（等同未接线，多轨编辑器按时间线跑）")
            return io.NodeOutput(
                [], [], [], 0, "",
                _collector_bundle(
                    active=False,
                    frame_rate=frame_rate,
                    duration_seconds=duration_seconds,
                    settings=settings,
                ),
            )

        panel = _parse_media_data(media_data)
        merged = {}
        for group, prefix, label, limit in MEDIA_GROUPS:
            wired = _wired_positions(kwargs.get(group))
            bound = {}
            for index in range(1, limit + 1):
                raw_name = kwargs.get("%s%d" % (prefix, index))
                # 绑定位只接受字符串：ComfyTV 写入文件名；若误接到张量（节点内直连）则忽略，
                # 避免 str(tensor) 抛 "Boolean value of Tensor with more than one value is ambiguous"。
                if isinstance(raw_name, (list, tuple)):
                    raw_name = raw_name[0] if raw_name else ""
                name = raw_name.strip() if isinstance(raw_name, str) else ""
                if name:
                    bound[index - 1] = name
            # 接线优先：同一编号上，socket 覆盖 ComfyTV 绑定行
            slots = dict(bound)
            slots.update(wired)
            pending = _panel_files(panel, group)
            panel_count = len(pending)
            values = []

            def _load_panel(name):
                try:
                    return _LOADERS[group](name)
                except Exception as error:
                    raise ValueError("资源采集器：%s素材读取失败（%s）：%s" % (label, name, error))

            # 接线优先占住自己的槽位号；面板素材先补空位，剩下的顺延追加。
            if slots:
                for index in range(max(slots) + 1):
                    if index in slots:
                        value = slots[index]
                        values.append(_load_panel(value) if isinstance(value, str) else value)
                    elif pending:
                        values.append(_load_panel(pending.pop(0)))
                    elif not skip_empty:
                        values.append(cls._placeholder(group))
            for name in pending:
                values.append(_load_panel(name))

            if skip_empty:
                values = [value for value in values if value is not None]
            else:
                values = [value if value is not None else cls._placeholder(group) for value in values]

            if len(values) > limit:
                print("[资源采集器] %s共 %d 个，超过建议上限 %d 个，已全部下发" % (label, len(values), limit))
            print("[资源采集器] %s：接线 %d（槽位 %s）+ 绑定 %d + 面板 %d → 输出 %d"
                  % (label, len(wired), sorted(wired), len(bound), panel_count, len(values)))
            merged[group] = values

        try:
            fps = float(frame_rate)
        except (TypeError, ValueError):
            fps = 24.0
        try:
            seconds = float(duration_seconds)
        except (TypeError, ValueError):
            seconds = 5.0
        frames = max(1, int(round(seconds * fps)))
        print("[资源采集器] 分辨率覆盖：%sx%s（0x0 = 跟随多轨编辑器）；任务类型=%s"
              % (settings["resolution_width"], settings["resolution_height"], settings["task_type_override"]))
        print("[资源采集器] %d 图 / %d 音频 / %d 视频；%ss x %sfps = %d 帧；提示词 %s"
              % (len(merged["images"]), len(merged["audio"]), len(merged["videos"]),
                 seconds, fps, frames, "有（%d 字）" % len(prompt or "") if (prompt or "").strip() else "空"))
        return io.NodeOutput(
            merged["images"],
            merged["audio"],
            merged["videos"],
            frames,
            prompt or "",
            _collector_bundle(
                active=True,
                images=merged["images"],
                audio=merged["audio"],
                videos=merged["videos"],
                frames=frames,
                frame_rate=fps,
                duration_seconds=seconds,
                prompt=prompt or "",
                settings=settings,
            ),
        )

    @staticmethod
    def _placeholder(group: str):
        if group == "images":
            return torch.zeros((1, 64, 64, 3))
        if group == "videos":
            return InputImpl.VideoFromComponents(
                Types.VideoComponents(
                    images=torch.zeros(1, 2, 2, 3, dtype=torch.float32, device="cpu"),
                    audio=None,
                    frame_rate=Fraction(24),
                )
            )
        return {"waveform": silence(16000, 0.001, 1), "sample_rate": 16000}
