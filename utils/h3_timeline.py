"""H3 项目时间线（多轨编辑器轨道数据）的本地持久化。

与生成过程的渲染清单 ``project.json`` 并列存放、互不覆盖：

    <output>/easy_media/projects/<项目名>/timeline.json

设计约束（2026-10-18 与用户定稿）：
* 每个项目一个独立文件（不是所有项目共用一个大 JSON）；
* 删除只删 ``timeline.json``，视频产物 / ``context_latent_*`` / ``project.json`` 一律不动；
* 保存可携带 ``base_updated_at``，与磁盘不一致时抛 :class:`TimelineConflictError`（409），
  不静默覆盖；
* 本模块只依赖标准库与 ``folder_paths``（延迟导入），项目名净化规则与
  ``utils/h3_project.py`` 的 ``safe_h3_project_name`` 保持一致，便于离线测试。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

TIMELINE_FILENAME = "timeline.json"
TIMELINE_VERSION = 1
TIMELINE_MAX_BYTES = 8 * 1024 * 1024

# 与 utils/h3_project.py 完全一致（见其 46-57 行）；此处刻意复制常量而不 import，
# 以免把 torch / comfy 依赖带进本模块，导致无法离线测试。
_PROJECT_NAME_PATTERN = re.compile(r"[^\w\-. ()\u3400-\u9fff]+", re.UNICODE)
_WINDOWS_RESERVED_PROJECT_NAMES = {
    "AUX",
    "CON",
    "NUL",
    "PRN",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
_PROJECT_NAME_MAX_UTF8_BYTES = 180


class TimelineConflictError(RuntimeError):
    """磁盘上的时间线比发起这次保存的客户端更新。"""

    def __init__(self, project_name: str, updated_at: float) -> None:
        super().__init__(
            f"项目 {project_name!r} 的时间线已被其它窗口修改"
            f"（磁盘 updated_at={updated_at}），请刷新后再保存。"
        )
        self.project_name = project_name
        self.updated_at = updated_at


__all__ = [
    "TIMELINE_FILENAME",
    "TIMELINE_MAX_BYTES",
    "TIMELINE_VERSION",
    "TimelineConflictError",
    "create_timeline",
    "default_timeline",
    "delete_timeline",
    "list_timelines",
    "load_timeline",
    "safe_timeline_project_name",
    "save_timeline",
    "summarize_timeline",
    "timeline_directory",
    "timeline_path",
    "timeline_root",
]


def safe_timeline_project_name(value: Any) -> str:
    """净化项目名，规则与 ``utils/h3_project.safe_h3_project_name`` 一致。"""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    name = str(value or "").strip()
    if not name:
        return "default"
    name = _PROJECT_NAME_PATTERN.sub("_", name).strip(" .")
    if not name or name in {".", ".."}:
        return "default"
    if name.partition(".")[0].upper() in _WINDOWS_RESERVED_PROJECT_NAMES:
        name = f"_{name}"
    encoded_name = name.encode("utf-8")
    if len(encoded_name) > _PROJECT_NAME_MAX_UTF8_BYTES:
        digest = hashlib.sha256(encoded_name).hexdigest()[:8]
        suffix = f"-{digest}"
        prefix_bytes = encoded_name[:_PROJECT_NAME_MAX_UTF8_BYTES - len(suffix.encode("ascii"))]
        prefix = prefix_bytes.decode("utf-8", errors="ignore").rstrip(" .")
        name = f"{prefix or 'project'}{suffix}"
    return name


def _projects_root() -> Path:
    import folder_paths  # 延迟导入：离线测试可注入 stub

    return Path(folder_paths.get_output_directory()).resolve() / "easy_media" / "projects"


def timeline_root() -> Path:
    """所有项目的根目录：``<output>/easy_media/projects``。"""
    return _projects_root()


def timeline_directory(project_name: Any) -> Path:
    """项目目录：``<output>/easy_media/projects/<净化后的项目名>``。"""
    return _projects_root() / safe_timeline_project_name(project_name)


def timeline_path(project_name: Any) -> Path:
    """时间线文件绝对路径。"""
    return timeline_directory(project_name) / TIMELINE_FILENAME


def default_timeline(project_name: Any) -> dict[str, Any]:
    """新建项目的默认时间线：不含轨道，由编辑器自行加轨。"""
    safe_name = safe_timeline_project_name(project_name)
    return {
        "version": TIMELINE_VERSION,
        "project_name": safe_name,
        "updated_at": time.time(),
        "resolution": None,
        "format": None,
        "track_data": {
            "muted": False,
            "volume_db": 0.0,
            "task_markers": [],
            "task_overview": False,
            "tracks": [],
            "total_length": 0,
            "frame_rate": 24,
        },
        "meta": {"app": "easy-media", "editor": "multitrack-v1"},
        "gen_settings_snapshot": None,
    }


def summarize_timeline(timeline: dict[str, Any]) -> dict[str, Any]:
    """从时间线里取列表页需要的摘要字段。"""
    track_data = timeline.get("track_data")
    if not isinstance(track_data, dict):
        track_data = {}
    tracks = track_data.get("tracks")
    if not isinstance(tracks, list):
        tracks = []
    segments = 0
    prompt_segments = 0
    for track in tracks:
        if not isinstance(track, dict):
            continue
        track_segments = track.get("segments")
        if not isinstance(track_segments, list):
            continue
        segments += len(track_segments)
        for segment in track_segments:
            if isinstance(segment, dict) and isinstance(segment.get("content"), dict):
                prompt = segment["content"].get("user_prompt")
                if isinstance(prompt, str) and prompt.strip():
                    prompt_segments += 1
    try:
        frame_rate = float(track_data.get("frame_rate") or 24)
    except (TypeError, ValueError):
        frame_rate = 24.0
    try:
        total_length = int(track_data.get("total_length") or 0)
    except (TypeError, ValueError):
        total_length = 0
    return {
        "tracks": len(tracks),
        "segments": segments,
        "prompt_segments": prompt_segments,
        "frame_rate": frame_rate,
        "total_length": total_length,
        "duration_seconds": round(total_length / frame_rate, 3) if frame_rate > 0 else 0.0,
    }


def _reject_symlink(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"拒绝操作符号链接路径：{path}")


def _coerce_timeline(payload: Any, project_name: str) -> dict[str, Any]:
    """校验并规范化待写入的时间线对象。"""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as error:
            raise ValueError(f"timeline 不是合法 JSON：{error}") from error
    if not isinstance(payload, dict):
        raise TypeError("timeline 必须是字典或 JSON 对象")
    timeline = dict(payload)
    version = timeline.get("version", TIMELINE_VERSION)
    try:
        version = int(version)
    except (TypeError, ValueError) as error:
        raise ValueError("timeline.version 必须是整数") from error
    if version < 1:
        raise ValueError("timeline.version 必须 >= 1")
    track_data = timeline.get("track_data")
    if track_data is None:
        track_data = {}
    if not isinstance(track_data, dict):
        raise ValueError("timeline.track_data 必须是对象")
    timeline["version"] = version
    timeline["project_name"] = project_name
    timeline["track_data"] = track_data
    timeline["updated_at"] = time.time()
    timeline.setdefault("meta", {"app": "easy-media", "editor": "multitrack-v1"})
    return timeline


def load_timeline(project_name: Any) -> dict[str, Any]:
    """读取时间线；文件不存在时抛 ``FileNotFoundError``。"""
    safe_name = safe_timeline_project_name(project_name)
    path = timeline_path(safe_name)
    _reject_symlink(path)
    if not path.is_file():
        raise FileNotFoundError(f"项目 {safe_name!r} 没有时间线文件：{path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"时间线文件损坏：{path}（{error}）") from error
    if not isinstance(payload, dict):
        raise ValueError(f"时间线文件必须是 JSON 对象：{path}")
    payload.setdefault("version", TIMELINE_VERSION)
    payload["project_name"] = safe_name
    try:
        payload["updated_at"] = float(payload.get("updated_at") or 0.0)
    except (TypeError, ValueError):
        payload["updated_at"] = 0.0
    return payload


def save_timeline(
    project_name: Any,
    timeline: Any,
    *,
    base_updated_at: float | None = None,
) -> dict[str, Any]:
    """写入时间线（原子写）。返回写入结果摘要。"""
    safe_name = safe_timeline_project_name(project_name)
    directory = timeline_directory(safe_name)
    path = timeline_path(safe_name)
    _reject_symlink(directory)
    _reject_symlink(path)

    if base_updated_at is not None:
        try:
            base_value: float | None = float(base_updated_at)
        except (TypeError, ValueError):
            base_value = None
        if base_value is not None and path.is_file():
            try:
                current = load_timeline(safe_name)
                current_updated = float(current.get("updated_at") or 0.0)
            except (FileNotFoundError, ValueError):
                current_updated = 0.0
            if abs(current_updated - base_value) > 1e-6:
                raise TimelineConflictError(safe_name, current_updated)

    normalised = _coerce_timeline(timeline, safe_name)
    serialised = json.dumps(normalised, ensure_ascii=False, indent=2)
    encoded = serialised.encode("utf-8")
    if len(encoded) > TIMELINE_MAX_BYTES:
        raise ValueError(f"时间线过大（{len(encoded)} 字节，上限 {TIMELINE_MAX_BYTES}）")

    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f".{TIMELINE_FILENAME}.tmp"
    try:
        temporary.write_text(serialised, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass
    return {
        "project_name": safe_name,
        "updated_at": normalised["updated_at"],
        "path": str(path),
        "bytes": len(encoded),
    }


def create_timeline(project_name: Any, template: Any = None) -> dict[str, Any]:
    """新建项目时间线；已存在时抛 ``FileExistsError``（路由映射 409）。"""
    safe_name = safe_timeline_project_name(project_name)
    path = timeline_path(safe_name)
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"项目 {safe_name!r} 的时间线已存在：{path}")
    payload = template if template is not None else default_timeline(safe_name)
    save_timeline(safe_name, payload)
    return load_timeline(safe_name)


def delete_timeline(project_name: Any) -> bool:
    """只删 ``timeline.json``；其它文件（视频/清单/上下文链）一律不动。"""
    safe_name = safe_timeline_project_name(project_name)
    path = timeline_path(safe_name)
    _reject_symlink(path)
    if not path.exists():
        return False
    path.unlink()
    return True


def list_timelines() -> list[dict[str, Any]]:
    """列出项目及时间线摘要（不返回完整时间线）。"""
    root = _projects_root()
    if not root.is_dir():
        return []
    results: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        timeline_file = entry / TIMELINE_FILENAME
        has_timeline = timeline_file.is_file() and not timeline_file.is_symlink()
        summary: dict[str, Any] = {
            "project_name": entry.name,
            "has_timeline": has_timeline,
            "updated_at": 0.0,
            "tracks": 0,
            "segments": 0,
            "prompt_segments": 0,
            "duration_seconds": 0.0,
            "video_count": len(list(entry.glob("video_*.mp4"))),
            "error": None,
        }
        if has_timeline:
            try:
                timeline = load_timeline(entry.name)
                summary.update(summarize_timeline(timeline))
                summary["updated_at"] = float(timeline.get("updated_at") or 0.0)
            except (OSError, ValueError) as error:
                summary["error"] = str(error)
        results.append(summary)
    return results
