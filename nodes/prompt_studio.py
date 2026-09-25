"""提示词工作台 (Prompt Studio) —— EasyMedia 本地新增节点（Deciia）

用途
----
把「当前片段」的素材、上游提示词与手写提示词放在一个面板里：

· 入口：轨道信息（多轨编辑器 / 多轨任务输出）、图像 / 音频 / 视频素材、
  系统提示词1、需要改写的用户提示词2（基线）、提示词3（本节点主体）。
· 面板：素材架直接展示缩略图，编辑器里打 ``@`` 弹出素材列表，
  选中后以缩略图形式插入正文，落盘仍是规范标记。
· 出口：最终提示词（提示词3，或基线兜底）；媒体透传，便于串在
  任务输出 → 工作台 → 提示词增强器 之间。

素材编号契约（与多轨编辑器 / 多轨任务输出严格一致）
------------------------------------------------
- ``<Picture n>``：任务片段 ``content.images`` 里 **非静音** 项按顺序编号
  （等价于前端的 ``activeTaskImages``）
- ``<Audio n>``：先给带视频的轨道（视频内嵌音轨）编号，再给音频轨道编号
- ``<Video n>``：视频轨道顺序

本节点只输出规范标记 ``<Picture n> / <Audio n> / <Video n>``，不产出 ``@图片1``
之类的别名写法；面板上的 ``@`` 只是插入手势，落进正文的仍是规范标记。

只读：不修改 TRACKS_INFO、不写回编辑器。回填由用户手动完成，或交给官方的
「多轨提示词增强到项目」节点。
"""

from __future__ import annotations

import os
import re
from urllib.parse import quote

from aiohttp import web

try:  # ComfyUI 运行时一定存在；单独导入本模块做静态检查时可能缺失
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None

from comfy_api.latest import io

from ..utils.multitrack import (
    _parse_track_data,
    multitrack_is_muted_image,
    multitrack_is_shared_reference,
    multitrack_media_identity,
)

CATEGORY_FALLBACK = "EasyUse/MultiTrackEditor"

try:
    from .basic import (
        CATEGORY_MULTITRACK,
        TYPE_TRACKS_INFO,
        _multitrack_task_entries,
    )
except Exception:  # pragma: no cover - 包结构变动时的兜底
    CATEGORY_MULTITRACK = CATEGORY_FALLBACK
    TYPE_TRACKS_INFO = io.Custom(io_type="TRACKS_INFO")
    _multitrack_task_entries = None


PROMPT_STUDIO_RESOLVE_ROUTE = "/easy-media/prompt-studio/resolve"

TAG_PATTERN = re.compile(r"<\s*(Picture|Audio|Video)\s+(\d+)\s*>", re.IGNORECASE)
ALIAS_PATTERN = re.compile(r"@\s*(图片|音频|视频|Picture|Image|Audio|Video)\s*(\d+)", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# 素材解析
# --------------------------------------------------------------------------- #
def _basename(value: str) -> str:
    return os.path.basename(str(value).replace("\\", "/").rstrip("/"))


def media_display_name(item: dict) -> str:
    """与前端 ``imageDisplayName`` 等价的显示名。"""
    for key in ("file_name", "file_path", "local_path", "url", "slot_name", "id"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return _basename(value) if key in ("file_path", "local_path") else value
    return "<未命名素材>"


def media_view_url(item: dict) -> str | None:
    """素材预览地址（口径与前端 ``Gv()`` 一致）。

    ``url`` / ``local_path`` 直用；``file_path`` 按最后一个斜杠拆出文件名与子目录
    （多轨编辑器里存的是 ``yusheng\\ep2\\xxx.png`` 这类 input 相对路径，
    子目录不在 ``subfolder`` 字段里）；type 取 ``source_type``，其余按 ``input``。
    """
    direct = item.get("url")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    local = item.get("local_path")
    if isinstance(local, str) and local.strip():
        return local.strip()

    raw = item.get("file_path")
    if not isinstance(raw, str) or not raw.strip():
        raw = item.get("file_name")
    if not isinstance(raw, str) or not raw.strip():
        return None

    normalized = raw.replace("\\", "/")
    if normalized.lower().startswith(("http://", "https://")):
        return normalized

    cut = normalized.rfind("/")
    filename = normalized[cut + 1:] if cut >= 0 else normalized
    subfolder = normalized[:cut] if cut >= 0 else ""
    if not filename:
        fallback = item.get("file_name")
        filename = fallback.strip() if isinstance(fallback, str) else ""
    if not filename:
        return None
    # 绝对路径不在 input/output/temp 之下，/view 取不到——宁可不给缩略图，也不给错 URL
    if re.match(r"^[A-Za-z]:", subfolder) or subfolder.startswith("/") or subfolder.startswith(".."):
        return None

    source = str(item.get("source_type") or "").lower()
    if source not in ("input", "output", "temp", "local"):
        source = "input"
    return f"/view?filename={quote(filename)}&type={source}&subfolder={quote(subfolder.strip('/'))}"


def _track_entries(tracks: list, track_type: str, media_type: str) -> list[dict]:
    found: list[dict] = []
    for track in tracks:
        if not isinstance(track, dict) or track.get("type") != track_type:
            continue
        segments = track.get("segments")
        if not isinstance(segments, list):
            continue
        has_media = any(
            isinstance(segment, dict)
            and (segment.get("content") or {}).get("media_type") == media_type
            for segment in segments
        )
        if has_media:
            found.append(track)
    return found


def _track_display_name(track: dict) -> str:
    label = track.get("name") if isinstance(track.get("name"), str) else ""
    media_name = ""
    for segment in track.get("segments") or []:
        content = (segment or {}).get("content") or {}
        for key in ("file_name", "file_path", "local_path", "url"):
            value = content.get(key)
            if isinstance(value, str) and value.strip():
                media_name = _basename(value) if key in ("file_path", "local_path") else value
                break
        if media_name:
            break
    label = label.strip()
    if label and media_name and media_name not in label:
        return f"{label} · {media_name}"
    return label or media_name or str(track.get("id") or "<未命名轨道>")


def task_entry_at(info: dict, index: int) -> dict:
    entries = _multitrack_task_entries(info) if _multitrack_task_entries else []
    if not entries:
        return {}
    safe_index = min(max(0, int(index)), len(entries) - 1)
    return entries[safe_index]


def collect_task_media(info: dict, index: int) -> dict:
    """收集当前片段素材（编号顺序与编辑器一致）。"""
    entry = task_entry_at(info, index)
    task = entry.get("task") if isinstance(entry.get("task"), dict) else {}
    content = task.get("content") if isinstance(task.get("content"), dict) else {}

    images: list[dict] = []
    seen_shared: set = set()
    for item in content.get("images") or []:
        if not isinstance(item, dict) or multitrack_is_muted_image(item):
            continue
        if multitrack_is_shared_reference(item):
            identity = multitrack_media_identity(item)
            if identity is not None:
                if identity in seen_shared:
                    continue
                seen_shared.add(identity)
        images.append(item)

    tracks = info.get("tracks") if isinstance(info.get("tracks"), list) else []
    video_tracks = _track_entries(tracks, "video", "video")
    audio_tracks = _track_entries(tracks, "audio", "audio")

    videos = [{"name": _track_display_name(track), "track_id": track.get("id")} for track in video_tracks]
    # 音频域：视频内嵌音轨先占号，再排音频轨道（前端 videoTracks.length + index + 1）
    audios = [{"name": _track_display_name(track), "track_id": track.get("id")} for track in video_tracks]
    audios += [{"name": _track_display_name(track), "track_id": track.get("id")} for track in audio_tracks]

    return {
        "entry": entry,
        "content": content,
        "images": images,
        "audios": audios,
        "videos": videos,
    }


def build_media_items(images: list[dict], audios: list[dict], videos: list[dict]) -> list[dict]:
    """面板素材架用的一份扁平清单：一条素材一条记录，带规范标记与预览地址。"""
    items: list[dict] = []
    for number, media in enumerate(images, 1):
        items.append(
            {
                "kind": "Picture",
                "n": number,
                "label": f"Picture {number}",
                "token": f"<Picture {number}>",
                "name": media_display_name(media),
                "url": media_view_url(media),
                "shared": multitrack_is_shared_reference(media),
                "source": "editor",
            }
        )
    for number, media in enumerate(audios, 1):
        items.append(
            {
                "kind": "Audio",
                "n": number,
                "label": f"Audio {number}",
                "token": f"<Audio {number}>",
                "name": media.get("name") or "",
                "url": None,
                "shared": False,
                "source": "editor",
            }
        )
    for number, media in enumerate(videos, 1):
        items.append(
            {
                "kind": "Video",
                "n": number,
                "label": f"Video {number}",
                "token": f"<Video {number}>",
                "name": media.get("name") or "",
                "url": None,
                "shared": False,
                "source": "editor",
            }
        )
    return items


def segment_user_prompt(content: dict) -> str:
    variant = content.get("user_prompt_variant")
    if variant == "b":
        return content.get("user_prompt_b") or ""
    return content.get("user_prompt") or content.get("text") or ""


def detect_alias_tokens(text: str) -> list[str]:
    """面板只做提示，不静默改写用户原文。"""
    return sorted({match.group(0) for match in ALIAS_PATTERN.finditer(text or "")})


def detect_out_of_range(text: str, images: list, audios: list, videos: list) -> list[str]:
    limits = {"picture": len(images), "audio": len(audios), "video": len(videos)}
    found: list[str] = []
    for kind, number in TAG_PATTERN.findall(text or ""):
        key = kind.lower()
        value = int(number)
        if key in limits and (value < 1 or value > limits[key]):
            found.append(f"<{kind} {value}>")
    return sorted(set(found))


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #
class PromptStudio(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy promptStudio",
            display_name="Prompt Studio",
            category=CATEGORY_MULTITRACK,
            description=(
                "提示词工作台：接轨道信息与媒体，展示当前片段素材架；在提示词3里打 @ 选素材，"
                "以缩略图插入正文，输出规范标记提示词。素材编号与多轨编辑器一致。只读，不回写项目。"
            ),
            inputs=[
                TYPE_TRACKS_INFO.Input(
                    "tracks_info",
                    optional=True,
                    tooltip="轨道信息：接多轨编辑器或多轨任务输出，用于列出当前片段素材与编号。",
                ),
                io.Image.Input(
                    "images",
                    optional=True,
                    tooltip="图像素材（接多轨任务输出的 IMAGES）：透传到输出，并作为素材架编号兜底。",
                ),
                io.Audio.Input(
                    "audio",
                    optional=True,
                    tooltip="音频素材：透传到输出，并作为素材架编号兜底。",
                ),
                io.Video.Input(
                    "video",
                    optional=True,
                    tooltip="视频素材：透传到输出，并作为素材架编号兜底。",
                ),
                io.String.Input(
                    "system_prompt",
                    default="",
                    multiline=True,
                    optional=True,
                    force_input=True,
                    tooltip="系统提示词1：来自多轨编辑器 / 任务输出，面板只读展示，本节点不改写。",
                ),
                io.String.Input(
                    "user_prompt",
                    default="",
                    multiline=True,
                    optional=True,
                    force_input=True,
                    tooltip="用户提示词2（基线）：需要改写的原文。改写模式下留空时输出回退使用它。",
                ),
                io.AnyType.Input(
                    "previous",
                    optional=True,
                    tooltip="链式依赖，仅用于排序执行位置。",
                ),
                io.Int.Input(
                    "task_index",
                    default=0,
                    min=-1,
                    tooltip="片段索引（0 起）。-1 表示整条时间线，素材架不可用。",
                ),
                io.Combo.Input(
                    "mode",
                    options=["改写", "生成"],
                    default="改写",
                    tooltip="改写：以提示词3为准，空则回退用户提示词2；生成：只用提示词3。",
                ),
                io.String.Input(
                    "prompt",
                    default="",
                    multiline=True,
                    tooltip="提示词3（正文）：在节点面板上输入，打 @ 选素材；原生输入框已被面板接管。",
                ),
            ],
            outputs=[
                io.String.Output("PROMPT", tooltip="最终提示词，可交给提示词增强器或手动回填编辑器。"),
                io.Image.Output("IMAGES", tooltip="图像素材透传。"),
                io.Audio.Output("AUDIO", tooltip="音频素材透传。"),
                io.Video.Output("VIDEO", tooltip="视频素材透传。"),
            ],
        )

    @classmethod
    def execute(
        cls,
        tracks_info=None,
        images=None,
        audio=None,
        video=None,
        system_prompt=None,
        user_prompt=None,
        previous=None,
        task_index: int = 0,
        mode: str = "改写",
        prompt: str = "",
    ) -> io.NodeOutput:
        del previous, system_prompt

        body = str(prompt or "").strip()
        baseline = str(user_prompt or "").strip()
        final_prompt = body if str(mode) == "生成" else (body or baseline)

        return io.NodeOutput(final_prompt, images, audio, video)


# --------------------------------------------------------------------------- #
# 只读解析路由（供节点面板拉取当前片段素材与上游提示词）
# --------------------------------------------------------------------------- #
async def _prompt_studio_resolve(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    raw = payload.get("track_data")
    if raw is None:
        return web.json_response({"ok": False, "error": "track_data is required"}, status=400)

    try:
        index = int(payload.get("task_index") or 0)
    except (TypeError, ValueError):
        index = 0

    try:
        info = raw if isinstance(raw, dict) else _parse_track_data(raw)
        empty = {"images": [], "audios": [], "videos": [], "content": {}}
        media = collect_task_media(info, index) if index >= 0 else empty
        task_count = len(_multitrack_task_entries(info)) if _multitrack_task_entries else 0
        # 回显实际渲染的片段号：越界时按编辑器口径夹到末段，免得面板显示「片段 100/3」
        shown_index = index if index < 0 else (min(index, task_count - 1) if task_count else index)
        entry = media.get("entry") or {}
        content = media.get("content") or {}
        images = media["images"]
        audios = media["audios"]
        videos = media["videos"]

        return web.json_response(
            {
                "ok": True,
                "task_index": shown_index,
                "requested_index": index,
                "task_count": task_count,
                "start_frame": entry.get("start_frame"),
                "end_frame": entry.get("end_frame"),
                "user_prompt": segment_user_prompt(content),
                "system_prompt": content.get("system_prompt") or "",
                "items": build_media_items(images, audios, videos),
                "images": [
                    {
                        "kind": "Picture",
                        "n": number,
                        "name": media_display_name(item),
                        "url": media_view_url(item),
                        "token": f"<Picture {number}>",
                        "shared": multitrack_is_shared_reference(item),
                    }
                    for number, item in enumerate(images, 1)
                ],
                "audios": [{"kind": "Audio", "n": n, "name": item["name"]} for n, item in enumerate(audios, 1)],
                "videos": [{"kind": "Video", "n": n, "name": item["name"]} for n, item in enumerate(videos, 1)],
            }
        )
    except Exception as exc:  # 面板侧只显示错误文本，不抛出到 ComfyUI 控制台
        return web.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def _register_routes() -> None:
    instance = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    if instance is None:
        return
    instance.routes.post(PROMPT_STUDIO_RESOLVE_ROUTE)(_prompt_studio_resolve)


_register_routes()
