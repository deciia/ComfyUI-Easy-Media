from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills/easy-media-multitrack-workflow/scripts/patch_workflow.py"
)


@pytest.fixture(scope="module")
def patch_workflow_module():
    spec = importlib.util.spec_from_file_location("partial_reference_patch", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _segment(segment_id: str, start: int, end: int, kind: str) -> dict[str, Any]:
    content: dict[str, Any] = {"media_type": kind}
    if kind == "none":
        content["images"] = []
    return {
        "id": segment_id,
        "start_frame": start,
        "end_frame": end,
        "content": content,
    }


@pytest.fixture
def track_data() -> dict[str, Any]:
    return {
        "frame_rate": 30,
        "total_length": 2040,
        "tracks": [
            {"id": "tasks", "type": "task", "segments": [
                _segment("verse", 0, 485, "none"),
                _segment("dance", 485, 2040, "none"),
            ]},
            {"id": "song", "type": "audio", "audio_locked": True, "segments": [
                _segment("master", 0, 2040, "audio"),
            ]},
            {"id": "motion", "type": "video", "audio_locked": True, "segments": [
                _segment("reference", 485, 2040, "video"),
            ]},
        ],
    }


def test_complete_master_allows_partial_motion_reference(patch_workflow_module, track_data):
    patch_workflow_module.validate_track_data(track_data, recalculate=False)


def test_partial_video_alone_still_rejects_uncovered_verse(patch_workflow_module, track_data):
    track_data["tracks"].pop(1)
    with pytest.raises(patch_workflow_module.WorkflowError, match="does not overlap task segments"):
        patch_workflow_module.validate_track_data(track_data, recalculate=False)


def test_incomplete_master_does_not_bypass_overlap_validation(patch_workflow_module, track_data):
    track_data["tracks"][1]["segments"][0]["start_frame"] = 485
    with pytest.raises(patch_workflow_module.WorkflowError, match="Locked audio track song"):
        patch_workflow_module.validate_track_data(track_data, recalculate=False)


def test_adjacent_audio_segments_cover_a_task(patch_workflow_module, track_data):
    track_data["tracks"][1]["segments"] = [
        _segment("master-start", 0, 200, "audio"),
        _segment("master-end", 200, 2040, "audio"),
    ]
    patch_workflow_module.validate_track_data(track_data, recalculate=False)


@pytest.mark.parametrize("start, end", [(1, 2040), (0, 2039)])
def test_partial_audio_overlap_does_not_allow_uncovered_video(
    patch_workflow_module, track_data, start, end,
):
    track_data["tracks"][1]["segments"] = [_segment("master", start, end, "audio")]
    with pytest.raises(patch_workflow_module.WorkflowError, match="Locked video track motion"):
        patch_workflow_module.validate_track_data(track_data, recalculate=False)


def test_audio_gap_does_not_allow_uncovered_video(patch_workflow_module, track_data):
    track_data["tracks"][1]["segments"] = [
        _segment("master-start", 0, 200, "audio"),
        _segment("master-end", 201, 2040, "audio"),
    ]
    with pytest.raises(patch_workflow_module.WorkflowError, match="Locked video track motion"):
        patch_workflow_module.validate_track_data(track_data, recalculate=False)


def test_only_selected_tasks_require_complete_audio(patch_workflow_module, track_data):
    track_data["tracks"][1]["segments"][0]["end_frame"] = 485
    patch_workflow_module.validate_track_data(track_data, recalculate=False, segment_count=1)
    track_data["tracks"][1]["segments"][0].update(start_frame=485, end_frame=2040)
    track_data["tracks"][2]["segments"][0].update(start_frame=0, end_frame=485)
    patch_workflow_module.validate_track_data(track_data, recalculate=False, segment_start_index=1)


def test_unlocked_audio_cannot_bypass_video_validation(patch_workflow_module, track_data):
    track_data["tracks"][1]["audio_locked"] = False
    with pytest.raises(patch_workflow_module.WorkflowError, match="Locked video track motion"):
        patch_workflow_module.validate_track_data(track_data, recalculate=False)


def test_complete_audio_does_not_allow_empty_locked_video(patch_workflow_module, track_data):
    track_data["tracks"][2]["segments"] = []
    with pytest.raises(patch_workflow_module.WorkflowError, match="contains no video segments"):
        patch_workflow_module.validate_track_data(track_data, recalculate=False)
