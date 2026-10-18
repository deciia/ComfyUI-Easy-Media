"""参考作用域（aligned / global）与参考时长/起点规则的单元测试。"""
from __future__ import annotations

import torch

from ComfyUI_Deciia_EasyMedia.utils.h3_project import (
    _ScopedVideoReference,
    crop_multitrack_project_media,
)
from ComfyUI_Deciia_EasyMedia.utils.multitrack import (
    multitrack_is_shared_reference,
    multitrack_reference_mode,
)


def test_reference_mode_migrates_legacy_fields():
    assert multitrack_reference_mode({}) == "off"
    assert multitrack_reference_mode({"reference_mode": "global"}) == "global"
    assert multitrack_reference_mode({"reference_mode": "aligned"}) == "aligned"
    assert multitrack_reference_mode({"reference_mode": "off"}) == "off"
    # 旧字段迁移：shared_reference 默认对齐，reference_scope=full 视为全局
    assert multitrack_reference_mode({"shared_reference": True}) == "aligned"
    assert multitrack_reference_mode(
        {"shared_reference": True, "reference_scope": "full"}
    ) == "global"
    # 更旧的 speaker_reference 别名
    assert multitrack_reference_mode({"speaker_reference": True}) == "aligned"
    # 新字段优先于旧字段
    assert multitrack_reference_mode(
        {"reference_mode": "off", "shared_reference": True}
    ) == "off"


def test_shared_reference_predicate_follows_mode():
    assert multitrack_is_shared_reference({"reference_mode": "aligned"}) is True
    assert multitrack_is_shared_reference({"reference_mode": "global"}) is True
    assert multitrack_is_shared_reference({"reference_mode": "off"}) is False


def _audio(start: int, end: int, mode: str, seconds: float = 4.0) -> dict:
    samples = int(44100 * seconds)
    return {
        "waveform": torch.ones(1, 1, samples),
        "sample_rate": 44100,
        "_start_frame": start,
        "_end_frame": end,
        "_reference_mode": mode,
    }


def _crop(shared_audio, shared_video, start: int, duration: int):
    return crop_multitrack_project_media(
        shared_audio,
        shared_video,
        None,
        start,
        duration,
        30.0,
    )


def test_aligned_reference_only_applies_to_overlapping_task():
    audio = [_audio(0, 60, "aligned")]
    assert len(_crop(audio, [], 0, 60)[0]) == 1
    assert len(_crop(audio, [], 120, 60)[0]) == 0
    # 部分重叠（overlap > 0）也算生效
    assert len(_crop(audio, [], 30, 60)[0]) == 1


def test_global_reference_applies_to_every_task():
    audio = [_audio(0, 60, "global")]
    assert len(_crop(audio, [], 0, 60)[0]) == 1
    assert len(_crop(audio, [], 120, 60)[0]) == 1


def test_reference_duration_is_clamped_to_track_length():
    # 参考片段 1 秒（30fps -> 30 帧），任务 4 秒（120 帧）
    audio = [_audio(0, 30, "aligned", seconds=4.0)]
    cropped = _crop(audio, [], 0, 120)[0]
    assert len(cropped) == 1
    # 参考时长 = min(任务时长, 轨道显示时长) = 30 帧 = 1 秒
    assert cropped[0]["waveform"].shape[-1] == 44100


def test_reference_starts_at_the_trimmed_track_position():
    # 素材 8 秒；片段在轨道上被裁到 60-120 帧（origin=0），参考应从素材第 2 秒开始
    samples = 44100 * 8
    waveform = torch.arange(samples, dtype=torch.float32).reshape(1, 1, samples)
    audio = [{
        "waveform": waveform,
        "sample_rate": 44100,
        "_start_frame": 60,
        "_end_frame": 120,
        "_reference_mode": "aligned",
        "_source_start_frame": 60,
    }]
    cropped = _crop(audio, [], 0, 120)[0]
    assert len(cropped) == 1
    # 起点 = 60 帧 = 2 秒 = 88200 采样
    assert int(cropped[0]["waveform"].flatten()[0].item()) == 88200


class _FakeVideo:
    def __init__(self) -> None:
        self.calls: list[tuple[float, float, bool]] = []

    def as_trimmed(self, start_time=0.0, duration=0.0, strict_duration=False):
        self.calls.append((start_time, duration, strict_duration))
        return self


def test_aligned_video_reference_is_filtered_by_overlap():
    video = _FakeVideo()
    wrapped = _ScopedVideoReference(video, "aligned", 0, 60)
    assert _crop([], [wrapped], 120, 60)[1] == []
    assert video.calls == []

    video2 = _FakeVideo()
    wrapped2 = _ScopedVideoReference(video2, "aligned", 0, 60)
    assert len(_crop([], [wrapped2], 30, 60)[1]) == 1


def test_global_video_reference_ignores_overlap():
    video = _FakeVideo()
    wrapped = _ScopedVideoReference(video, "global", 0, 60)
    assert len(_crop([], [wrapped], 1200, 60)[1]) == 1


def test_raw_video_without_scope_keeps_legacy_behaviour():
    video = _FakeVideo()
    assert len(_crop([], [video], 1200, 60)[1]) == 1
