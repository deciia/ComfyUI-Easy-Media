"""Deciia 本地新增：直通(passthrough)任务段支持。

任务模式 "passthrough"：该任务段不采样、不重绘，把覆盖窗口内的视频轨素材
按帧窗裁切、规格化后作为该段的交付视频直接登记进项目 manifest，
成片合并/选版本/对比全部复用现有机制。

上游基线: yolain/ComfyUI-Easy-Media @ 1191d43
本地 fork: ComfyUI_Deciia_EasyMedia（不发布）
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from comfy_api.latest import io
import folder_paths

from ..utils.video import get_ffmpeg_path, ffprobe_info, resolve_video_path

PASSTHROUGH_TASK_MODE = "passthrough"
PASSTHROUGH_CONTEXT_FRAMES = 22


def passthrough_continuity_mode(entry: dict) -> str:
    """直通段的 continuity_mode 语义映射。

    shot  -> "shot"    切断: 不编码素材尾帧, 下一段强制独立开场
    context/context_swap -> "context" 留续接基础(swap 对直通段无独立含义, 降级)
    """
    task = entry.get("task", {}) if isinstance(entry, dict) else {}
    content = task.get("content", {}) if isinstance(task, dict) else {}
    mode = str(content.get("continuity_mode", "context")).lower() if isinstance(content, dict) else "context"
    if mode == "context_test":
        mode = "context"
    return "shot" if mode == "shot" else "context"


def is_passthrough_task(entry: dict[str, Any]) -> bool:
    """该任务段的 task_mode 是否为直通。"""
    task = entry.get("task", {})
    content = task.get("content", {}) if isinstance(task, dict) else {}
    if not isinstance(content, dict):
        return False
    return str(content.get("task_mode", "")).lower() == PASSTHROUGH_TASK_MODE


def _frame_value(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def find_passthrough_source(
    entry: dict[str, Any],
    info: dict[str, Any],
) -> dict[str, Any]:
    """在视频轨里找到完整覆盖该任务窗口的素材段。

    返回素材段 dict（含 content / start_frame / end_frame）。
    v1 规则：必须恰好一段素材完整覆盖任务窗口，否则报错并说明缺口。
    """
    start_frame = _frame_value(entry.get("start_frame"))
    end_frame = _frame_value(entry.get("end_frame"))
    covering: list[tuple[dict, dict]] = []
    for track in info.get("tracks", []):
        if not isinstance(track, dict) or track.get("type") != "video":
            continue
        for segment in track.get("segments", []):
            if not isinstance(segment, dict):
                continue
            content = segment.get("content", {})
            if not isinstance(content, dict) or content.get("media_type") != "video":
                continue
            seg_start = _frame_value(segment.get("start_frame"))
            seg_end = _frame_value(segment.get("end_frame"))
            if seg_start <= start_frame and seg_end >= end_frame:
                covering.append((track, segment))
    if not covering:
        raise ValueError(
            f"Passthrough segment [{start_frame}, {end_frame}) is not fully covered "
            f"by any video-track media segment. Place a video clip that spans the "
            f"whole task window, or split the task into per-clip passthrough tasks."
        )
    if len(covering) > 1:
        raise ValueError(
            f"Passthrough segment [{start_frame}, {end_frame}) is covered by "
            f"{len(covering)} video-track media segments. Keep exactly one clip "
            f"per passthrough task (v1)."
        )
    track, segment = covering[0]
    return {
        "track": track,
        "segment": segment,
        "content": segment.get("content", {}),
        "source_start_frame": start_frame - _frame_value(segment.get("start_frame")),
        "source_end_frame": end_frame - _frame_value(segment.get("start_frame")),
        "task_start_frame": start_frame,
        "task_end_frame": end_frame,
    }


def resolve_passthrough_media(source: dict[str, Any]) -> str:
    """把素材段 content 解析成本地文件路径。"""
    content = source["content"]
    resolved = resolve_video_path(
        str(content.get("source_type", "input")),
        content.get("file_path"),
        content.get("local_path"),
        content.get("url"),
    )
    if isinstance(resolved, str) and os.path.isfile(resolved):
        return resolved
    raise FileNotFoundError(
        "Passthrough source could not be resolved to a local file. "
        "URL sources are not supported for passthrough (v1)."
    )


def find_passthrough_audio(
    entry: dict[str, Any],
    info: dict[str, Any],
) -> tuple[str, int, int] | None:
    """找音频轨里与任务窗口重叠的段，返回 (本地文件, 源内起帧, 源内止帧)。

    音频轨 MP3 即素材的优化后原声；取与任务窗口重叠的第一段。
    没有则返回 None（交付视频使用素材内嵌音轨）。
    """
    start_frame = _frame_value(entry.get("start_frame"))
    end_frame = _frame_value(entry.get("end_frame"))
    for track in info.get("tracks", []):
        if not isinstance(track, dict) or track.get("type") != "audio":
            continue
        for segment in sorted(
            track.get("segments", []),
            key=lambda seg: _frame_value(seg.get("start_frame")),
        ):
            if not isinstance(segment, dict):
                continue
            content = segment.get("content", {})
            if not isinstance(content, dict):
                continue
            seg_start = _frame_value(segment.get("start_frame"))
            seg_end = _frame_value(segment.get("end_frame"))
            if seg_end <= start_frame or seg_start >= end_frame:
                continue
            source_type = str(content.get("source_type", "input"))
            if source_type == "url":
                continue
            if source_type == "output" and content.get("file_path"):
                resolved = os.path.join(
                    folder_paths.get_output_directory(), content["file_path"]
                )
            elif source_type == "input" and content.get("file_path"):
                resolved = folder_paths.get_annotated_filepath(content["file_path"])
            elif source_type == "local" and content.get("local_path"):
                resolved = content["local_path"]
            else:
                continue
            if not os.path.isfile(str(resolved)):
                continue
            return (
                str(resolved),
                max(0, start_frame - seg_start),
                max(1, end_frame - seg_start),
            )
    return None


def stage_passthrough_media(
    source_path: str,
    source_start_frame: int,
    frame_count: int,
    fps: float,
    width: int,
    height: int,
    staging_path: str,
    audio_source: str | None = None,
    audio_start_frame: int = 0,
    audio_frame_count: int = 0,
) -> str:
    """ffmpeg 文件级加工：裁切 + 归一 + 缩放 + 精确帧数，写 staging mp4。

    - 帧率归一到时间线 fps 后再按帧窗裁切（与官方 merge 的顺序一致）
    - tpad 兜底防止容器元数据帧数虚高导致黑边泄漏
    - 音频独立来源时按同样窗口裁切后 mux
    """
    ffmpeg = get_ffmpeg_path("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("FFmpeg not found; passthrough staging requires FFmpeg.")
    if width % 2 or height % 2:
        raise ValueError(f"Passthrough target size must be even: {width}x{height}")

    duration = frame_count / fps
    command = [ffmpeg, "-y", "-i", source_path]
    if audio_source is not None and audio_source != source_path:
        command.extend(["-i", audio_source])

    video_filters = [
        "setpts=PTS-STARTPTS",
        f"fps=fps={fps}:start_time=0",
        f"trim=start_frame={source_start_frame}:end_frame={source_start_frame + frame_count}",
        "setpts=PTS-STARTPTS",
        f"scale={width}:{height}",
        f"tpad=stop_mode=clone:stop_duration={duration}",
        f"trim=end_frame={frame_count}",
        "setpts=PTS-STARTPTS",
    ]
    filters = [f"[0:v]{','.join(video_filters)}[vout]"]

    if audio_source is not None:
        audio_index = 0 if audio_source == source_path else 1
        if audio_frame_count > 0:
            audio_start_sec = audio_start_frame / fps
            audio_duration = audio_frame_count / fps
            filters.append(
                f"[{audio_index}:a]aresample=44100,atrim=start={audio_start_sec}:"
                f"duration={audio_duration},asetpts=PTS-STARTPTS,"
                f"apad=whole_dur={duration}[aout]"
            )
        else:
            filters.append(
                f"[{audio_index}:a]aresample=44100,atrim=duration={duration},"
                f"asetpts=PTS-STARTPTS,apad=whole_dur={duration}[aout]"
            )

    if audio_source is None:
        # 无独立音频来源：若素材带内嵌音轨，按同窗口裁切保留
        media_info = ffprobe_info(source_path)
        if media_info.get("has_audio"):
            filters.append(
                f"[0:a]aresample=44100,atrim=start="
                f"{source_start_frame / fps}:duration={duration},"
                f"asetpts=PTS-STARTPTS,apad=whole_dur={duration}[aout]"
            )
            has_audio_output = True
        else:
            has_audio_output = False
    else:
        has_audio_output = True
    command.extend(["-filter_complex", ";".join(filters), "-map", "[vout]"])
    if has_audio_output:
        command.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"])
    else:
        command.extend(["-an"])
    command.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-t",
            str(duration),
            staging_path,
        ]
    )
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "Passthrough staging FFmpeg failed: "
            + result.stderr.decode(errors="replace")[-800:]
        )
    return staging_path


def passthrough_staging_prefix(project_name: str, task_index: int) -> str:
    """staging 文件名前缀（与官方 saveVideo 的命名约定一致）。"""
    return f"easy_media/projects/{project_name}/.staging_video_{task_index}"
