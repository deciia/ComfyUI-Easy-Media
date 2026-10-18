"""h3_timeline（项目时间线持久化）单元测试。

为什么用 importlib 按文件路径加载：
    `utils/__init__.py` 会把 image/audio/video/models/minimax 等重依赖全部拉进来，
    在没有 ComfyUI 运行环境的机器上 ``from utils import h3_timeline`` 会导入失败
    （仓库里既有测试在本机同样跑不起来）。h3_timeline 本身只依赖标准库和
    ``folder_paths``（延迟导入），因此按路径加载可以独立运行：

        python -m pytest tests/test_h3_timeline.py -q

覆盖：新建/重复新建、读写往返、乐观并发、摘要与列表、只删时间线（并清理空目录）、
项目名净化、体积上限、损坏文件容错。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "utils" / "h3_timeline.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("h3_timeline_under_test", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def timeline(tmp_path, monkeypatch):
    """把 folder_paths 的输出目录指向 tmp_path，返回已加载的模块。"""
    monkeypatch.setitem(
        sys.modules,
        "folder_paths",
        SimpleNamespace(get_output_directory=lambda: str(tmp_path)),
    )
    module = _load_module()
    return module, tmp_path / "easy_media" / "projects"


def test_create_timeline_creates_file_with_task_track(timeline):
    module, root = timeline
    doc = module.create_timeline("测试项目")

    assert doc["project_name"] == "测试项目"
    tracks = doc["track_data"]["tracks"]
    assert len(tracks) == 1
    assert tracks[0]["type"] == "task"
    assert tracks[0]["segments"] == []
    assert tracks[0]["id"].startswith("task-")
    assert (root / "测试项目" / "timeline.json").is_file()


def test_create_timeline_rejects_duplicate(timeline):
    module, _ = timeline
    module.create_timeline("dup")
    with pytest.raises(FileExistsError):
        module.create_timeline("dup")


def test_load_timeline_missing_file_raises(timeline):
    module, _ = timeline
    with pytest.raises(FileNotFoundError):
        module.load_timeline("never-created")


def test_save_and_load_roundtrip_keeps_prompt_and_resolution(timeline):
    module, _ = timeline
    module.create_timeline("往返")
    payload = {
        "version": 1,
        "resolution": {"mode": "custom", "width": 768, "height": 1376},
        "format": "MiniMax",
        "track_data": {
            "frame_rate": 24,
            "total_length": 480,
            "tracks": [
                {
                    "id": "t1",
                    "type": "task",
                    "segments": [
                        {
                            "id": "s1",
                            "start_frame": 0,
                            "end_frame": 480,
                            "content": {"user_prompt": "单元测试用提示词占位，与真实项目无关。"},
                        }
                    ],
                }
            ],
        },
    }
    saved = module.save_timeline("往返", payload)
    assert saved["bytes"] > 0
    assert saved["updated_at"] > 0

    loaded = module.load_timeline("往返")
    assert loaded["resolution"]["width"] == 768
    assert loaded["format"] == "MiniMax"
    segment = loaded["track_data"]["tracks"][0]["segments"][0]
    assert segment["content"]["user_prompt"].startswith("单元测试")


def test_save_writes_utf8_without_escaping(timeline):
    module, root = timeline
    module.save_timeline("编码", {"track_data": {"tracks": []}, "format": "MiniMax"})
    text = (root / "编码" / "timeline.json").read_text(encoding="utf-8")
    assert "MiniMax" in text


def test_optimistic_concurrency_raises_conflict(timeline):
    module, _ = timeline
    module.create_timeline("并发")
    first = module.load_timeline("并发")

    with pytest.raises(module.TimelineConflictError):
        module.save_timeline("并发", {"track_data": {"tracks": []}}, base_updated_at=first["updated_at"] - 5)

    # 带上正确的 base 可以写入
    result = module.save_timeline(
        "并发", {"track_data": {"tracks": []}}, base_updated_at=first["updated_at"]
    )
    assert result["bytes"] > 0


def test_summarize_counts_segments_and_prompts(timeline):
    module, _ = timeline
    doc = {
        "track_data": {
            "frame_rate": 24,
            "total_length": 480,
            "tracks": [
                {
                    "type": "task",
                    "segments": [
                        {"content": {"user_prompt": "有提示词"}},
                        {"content": {"user_prompt": ""}},
                    ],
                }
            ],
        }
    }
    summary = module.summarize_timeline(doc)
    assert summary["tracks"] == 1
    assert summary["segments"] == 2
    assert summary["prompt_segments"] == 1
    assert summary["duration_seconds"] == pytest.approx(20.0)


def test_list_timelines_reports_has_timeline_and_video_count(timeline):
    module, root = timeline
    module.create_timeline("列表项")
    (root / "列表项" / "video_0_1.mp4").write_bytes(b"fake")
    (root / "只有产物").mkdir(parents=True)
    (root / "只有产物" / "video_0_1.mp4").write_bytes(b"fake")

    rows = {row["project_name"]: row for row in module.list_timelines()}
    assert rows["列表项"]["has_timeline"] is True
    assert rows["列表项"]["video_count"] == 1
    assert rows["只有产物"]["has_timeline"] is False
    assert "track_data" not in rows["列表项"]


def test_delete_timeline_keeps_videos(timeline):
    module, root = timeline
    module.create_timeline("有产物")
    project_dir = root / "有产物"
    (project_dir / "video_0_1.mp4").write_bytes(b"fake")

    assert module.delete_timeline("有产物") is True
    assert not (project_dir / "timeline.json").exists()
    assert (project_dir / "video_0_1.mp4").is_file()
    assert module.delete_timeline("有产物") is False


def test_delete_timeline_prunes_empty_project_dir(timeline):
    module, root = timeline
    module.create_timeline("空壳")
    assert module.delete_timeline("空壳") is True
    assert not (root / "空壳").exists()


def test_project_name_sanitising(timeline):
    module, _ = timeline
    cases = {
        "": "default",
        "..": "default",
        "a/b": "a_b",
        "a:b*c?": "a_b_c_",
        "CON": "_CON",
        "  测试 项目  ": "测试 项目",
    }
    for raw, expected in cases.items():
        assert module.safe_timeline_project_name(raw) == expected
    long_name = "长" * 200
    assert len(module.safe_timeline_project_name(long_name).encode("utf-8")) <= 180


def test_save_rejects_oversized_timeline(timeline):
    module, _ = timeline
    oversized = {"track_data": {"blob": "x" * (module.TIMELINE_MAX_BYTES + 64)}}
    with pytest.raises(ValueError):
        module.save_timeline("超大", oversized)


def test_load_rejects_broken_json(timeline):
    module, root = timeline
    module.create_timeline("损坏")
    (root / "损坏" / "timeline.json").write_text("{not json", encoding="utf-8")

    with pytest.raises(ValueError):
        module.load_timeline("损坏")

    row = next(row for row in module.list_timelines() if row["project_name"] == "损坏")
    assert row["error"]  # 列表不崩溃，只标记错误


def test_save_normalises_version_and_updated_at(timeline):
    module, root = timeline
    module.save_timeline("规范化", {"version": "1", "track_data": {}})
    on_disk = json.loads((root / "规范化" / "timeline.json").read_text(encoding="utf-8"))
    assert on_disk["version"] == 1
    assert isinstance(on_disk["updated_at"], float)
    assert on_disk["project_name"] == "规范化"
