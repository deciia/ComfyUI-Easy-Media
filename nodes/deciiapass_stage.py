"""Deciia 直通段节点：staging 加工 + 尾部上下文张量（子图节点，非顶层节点）。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import folder_paths
import torch
from comfy_api.latest import io

from ..utils.h3_project import safe_h3_project_name
from .deciiapassthrough import (
    PASSTHROUGH_CONTEXT_FRAMES,
    find_passthrough_audio,
    find_passthrough_source,
    passthrough_staging_prefix,
    resolve_passthrough_media,
    stage_passthrough_media,
)


class DeciiaPassthroughStage(io.ComfyNode):
    """把任务窗口内的视频轨素材文件级加工成 staging 交付视频。

    同时解码素材尾部 N 帧 + 音频尾，供 _h3_encode_context_media 编码上下文
    latent（保证下一段 AI 生成能从实拍画面续接）。
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy deciiaPassthroughStage",
            display_name="Deciia Passthrough Stage",
            category="EasyUse/H3/dev",
            description="Internal passthrough media stager for H3 projects.",
            inputs=[
                io.String.Input("project_name"),
                io.Int.Input("segment_index", min=0),
                io.AnyType.Input("tracks_info"),
                io.Int.Input("width", min=32, default=544),
                io.Int.Input("height", min=32, default=960),
                io.Float.Input("fps", min=1.0, max=120.0, default=24.0),
                io.Int.Input(
                    "context_frames",
                    min=1,
                    max=112,
                    default=PASSTHROUGH_CONTEXT_FRAMES,
                ),
            ],
            outputs=[
                io.String.Output("staging_path"),
                io.Image.Output("tail_images"),
                io.Audio.Output("tail_audio"),
            ],
            not_idempotent=True,
            is_dev_only=True,
        )

    @classmethod
    def execute(
        cls,
        project_name: str,
        segment_index: int,
        tracks_info: Any,
        width: int,
        height: int,
        fps: float,
        context_frames: int = PASSTHROUGH_CONTEXT_FRAMES,
    ) -> io.NodeOutput:
        info = tracks_info if isinstance(tracks_info, dict) else {}
        entries = info.get("_deciiapass_entries") or []
        entry = None
        for candidate in entries:
            if isinstance(candidate, dict) and candidate.get("index") == segment_index:
                entry = candidate.get("entry")
                break
        if entry is None:
            raise ValueError(
                f"Passthrough stage could not find task entry for segment {segment_index}"
            )

        source = find_passthrough_source(entry, info)
        source_path = resolve_passthrough_media(source)
        frame_count = source["task_end_frame"] - source["task_start_frame"]
        if frame_count <= 0:
            raise ValueError("Passthrough task window has zero length")

        safe_name = safe_h3_project_name(project_name)
        output_dir = Path(folder_paths.get_output_directory()).resolve()
        staging_dir = output_dir / "easy_media" / "projects" / safe_name
        staging_dir.mkdir(parents=True, exist_ok=True)
        staging_path = staging_dir / f".staging_video_{segment_index}.mp4"

        audio_window = find_passthrough_audio(entry, info)
        if audio_window is not None:
            audio_path, audio_start, audio_end = audio_window
            stage_passthrough_media(
                source_path,
                source["source_start_frame"],
                frame_count,
                fps,
                width,
                height,
                str(staging_path),
                audio_source=audio_path,
                audio_start_frame=audio_start,
                audio_frame_count=audio_end - audio_start,
            )
        else:
            stage_passthrough_media(
                source_path,
                source["source_start_frame"],
                frame_count,
                fps,
                width,
                height,
                str(staging_path),
            )

        # Deciia: continuity_mode=shot 切断时跳过尾帧解码(省一次解码, 输出占位张量)
        cut_mode = False
        try:
            pass_entries = tracks_info.get("_deciiapass_entries", []) if isinstance(tracks_info, dict) else []
            for item in pass_entries:
                if isinstance(item, dict) and int(item.get("index", -1)) == int(segment_index):
                    content = (item.get("entry", {}).get("task", {}) or {}).get("content", {})
                    cut_mode = str(content.get("continuity_mode", "context")).lower() == "shot"
                    break
        except (TypeError, ValueError, AttributeError):
            cut_mode = False
        if cut_mode:
            tail_images = torch.zeros(1, height, width, 3, dtype=torch.float32)
            tail_audio = {"waveform": torch.zeros(1, 1, 1), "sample_rate": 44100}
        else:
            tail_images, tail_audio = cls._decode_tail(
                str(staging_path), context_frames, fps
            )
        return io.NodeOutput(str(staging_path), tail_images, tail_audio)

    @staticmethod
    def _decode_tail(
        staging_path: str, context_frames: int, fps: float
    ) -> tuple[torch.Tensor, dict[str, Any]]:
        """解码 staging 尾部帧 + 音频尾（有界内存：仅 N 帧）。"""
        import av
        import numpy as np

        frames = []
        audio_chunks: list = []
        sample_rate = 44100
        with av.open(staging_path) as container:
            if not container.streams.video:
                raise ValueError(f"Passthrough staging has no video: {staging_path}")
            for frame in container.decode(video=0):
                frames.append(frame.to_ndarray(format="rgb24"))
            if container.streams.audio:
                audio_stream = container.streams.audio[0]
                sample_rate = int(audio_stream.rate or 44100)
                for frame in container.decode(audio=0):
                    array = frame.to_ndarray()
                    if array.ndim == 1:
                        array = array[np.newaxis, ...]
                    audio_chunks.append(array)
        if not frames:
            raise ValueError(f"Passthrough staging decoded no frames: {staging_path}")
        tail = frames[-context_frames:]
        images = torch.from_numpy(
            np.concatenate([f[np.newaxis, ...] for f in tail], axis=0)
        ).float() / 255.0

        tail_samples = max(1, int(round(context_frames / fps * sample_rate)))
        if audio_chunks:
            raw = np.concatenate(audio_chunks, axis=1 if audio_chunks[0].ndim == 2 else 0)
            wave = torch.from_numpy(raw).float()
            if wave.dim() == 1:
                wave = wave.unsqueeze(0)
            if wave.shape[0] > 2:
                wave = wave[:2]
            elif wave.shape[0] == 1:
                wave = wave.repeat(2, 1)
            if wave.shape[1] > tail_samples:
                wave = wave[:, -tail_samples:]
        else:
            wave = torch.zeros(2, tail_samples)
        audio_payload = {
            "waveform": wave.unsqueeze(0),
            "sample_rate": sample_rate,
        }
        return images, audio_payload
