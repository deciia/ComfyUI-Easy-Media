"""分镜规划模块的纯函数测试（不联网）。"""
from __future__ import annotations

import pytest

from ComfyUI_Deciia_EasyMedia.utils.plan_segments import (
    PlanError,
    build_plan_messages,
    extract_json_object,
    normalize_plan,
    parse_storyboard_text,
    plan_from_response,
    render_storyboard_text,
)


def test_build_plan_messages_requires_brief():
    with pytest.raises(PlanError):
        build_plan_messages({})
    messages = build_plan_messages({"brief": "一个修车师傅的故事", "duration_seconds": 30})
    assert messages[0]["role"] == "system"
    assert "导演" in messages[0]["content"]
    # 关键导演规则必须常驻
    for keyword in ("180", "正反打", "微表情", "beat"):
        assert keyword in messages[0]["content"]
    assert "30" in messages[1]["content"]


def test_extract_json_handles_fence_and_prose():
    assert extract_json_object('```json\n{"segments": []}\n```') == {"segments": []}
    assert extract_json_object('前言 {"segments": []} 后话') == {"segments": []}
    with pytest.raises(PlanError):
        extract_json_object("没有 JSON")


def test_normalize_plan_keeps_director_fields():
    plan = normalize_plan({
        "title": "测试片",
        "logline": "一句话",
        "genre": "剧情",
        "tone": "写实",
        "rhythm": "钩子→推进→收束",
        "segments": [{
            "name": "开场",
            "beat": "钩子",
            "duration": 3,
            "summary": "建立空间",
            "director_note": "用全景交代",
            "shots": [{
                "framing": "航拍",  # 非法景别 → 回落中景
                "camera": "推近",
                "action": "人物进入画面",
                "dialogue": ["我回来了", {"speaker": "老赵", "line": "嗯"}],
                "micro_expression": "眼神躲闪",
                "sound": "环境声",
                "transition": "切",
            }],
            "subjects": [{"name": "老赵", "type": "人物", "retention": ["发型"]}],
            "resources": [{"kind": "image", "name": "车间全景", "for": "建立空间"}],
        }],
    }, frame_rate=30)
    assert plan["total_frames"] == 90
    segment = plan["segments"][0]
    assert segment["beat"] == "钩子"
    assert segment["director_note"] == "用全景交代"
    shot = segment["shots"][0]
    assert shot["framing"] == "中景"
    assert shot["dialogue"] == [
        {"speaker": "", "line": "我回来了"},
        {"speaker": "老赵", "line": "嗯"},
    ]
    assert shot["micro_expression"] == "眼神躲闪"
    assert segment["subjects"][0]["name"] == "老赵"
    assert segment["resources"][0]["for"] == "建立空间"


def test_duration_is_clamped_and_frames_are_contiguous():
    plan = normalize_plan({
        "segments": [
            {"name": "a", "duration": 100, "shots": []},
            {"name": "b", "duration": 0.1, "shots": []},
        ]
    })
    first, second = plan["segments"]
    assert first["duration_seconds"] == 15
    assert second["duration_seconds"] == 0.5
    assert second["start_frame"] == first["end_frame"]


def test_plan_from_response_and_text_roundtrip():
    raw = '{"segments":[{"name":"镜头A","duration":2,"shots":[{"framing":"特写","action":"手部"}],"summary":"细节"}]}'
    plan = plan_from_response(raw, frame_rate=24)
    text = render_storyboard_text(plan)
    assert "# 镜头A | 2秒" in text
    parsed = parse_storyboard_text(text, frame_rate=24)
    assert parsed["segments"][0]["name"] == "镜头A"
    assert parsed["segments"][0]["duration_frames"] == 48


def test_parse_storyboard_rejects_bad_input():
    with pytest.raises(PlanError):
        parse_storyboard_text("")
    with pytest.raises(PlanError):
        parse_storyboard_text("没有镜头头")
