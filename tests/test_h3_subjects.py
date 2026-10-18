"""主体库与提示词确定性组装的单元测试。

与 tests/test_h3_timeline.py 同样按文件路径加载模块，避免 utils/__init__ 的重依赖：
    python -m pytest tests/test_h3_subjects.py -q

覆盖：主体配置解析（含 RefDirector 结构）、令牌解析、自动追加与编号、
去重/静音/上限、未解析令牌告警、零侵入（无主体时不变）、主体名校验。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "utils" / "h3_subjects.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("h3_subjects_under_test", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def subj():
    return _load_module()


def _segment(prompt: str, images=None, **extra):
    content = {"user_prompt": prompt, "images": images if images is not None else []}
    content.update(extra)
    return {"id": "seg-1", "content": content}


def _timeline(*segments):
    return {"frame_rate": 24, "tracks": [{"id": "t1", "type": "task", "segments": list(segments)}]}


def test_parse_subject_config_accepts_refdirector_shape(subj):
    raw = {
        "subject_data": {
            "subjects": [
                {"name": "车 间", "type": "Picture", "description": "工具墙", "retention": "reference"},
                {"name": "老赵", "type": "Audio", "audioFile": "e/zhao.wav"},
            ]
        }
    }
    subjects = subj.parse_subject_config(raw)
    assert [item["name"] for item in subjects] == ["车 间", "老赵"]
    assert subjects[0]["kind"] == "image"
    assert subjects[1]["kind"] == "audio"
    assert subjects[0]["retention"] == "reference"


def test_parse_subject_config_ignores_broken_json(subj):
    assert subj.parse_subject_config("{not json") == []
    assert subj.parse_subject_config("") == []
    assert subj.parse_subject_config(None) == []


def test_token_parsing_kinds(subj):
    tokens = subj.parse_tokens("看 @车间 和 <@老赵>，<#老赵音色:你好>，还有 @图片1")
    kinds = [(token["kind"], token["name"]) for token in tokens]
    assert ("subject", "车间") in kinds
    assert ("subject", "老赵") in kinds
    assert ("voice", "老赵音色") in kinds
    # @图片1 也按主体候选解析，但会被"未解析令牌"捕获（不伪造编号）
    assert ("subject", "图片1") in kinds


def test_auto_append_and_numbering(subj):
    subjects = subj.parse_subject_config(
        {"subjects": [
            {"name": "车间", "path": "a/工作台.jpg", "role": "工具墙工位区", "description": "亮绿色墙面"},
        ]}
    )
    data = _timeline(_segment("看 @车间", [{"file_path": "b/别的.jpg"}]))
    data, reports = subj.compose_timeline(data, subjects)

    content = data["tracks"][0]["segments"][0]["content"]
    # 原有编号不变：追加在末尾 → 车间成为 <Picture 2>
    assert len(content["images"]) == 2
    assert "subject_definitions" in content["user_prompt"]
    assert "<Picture 2>" in content["user_prompt"]
    assert "亮绿色墙面" in content["user_prompt"]
    assert "retention_analysis" in content["user_prompt"]
    assert reports[0]["numbers"] == {"车间": "<Picture 2>"}


def test_dedupes_existing_resource(subj):
    subjects = subj.parse_subject_config({"subjects": [{"name": "车间", "path": "a/工作台.jpg"}]})
    data = _timeline(_segment("看 @车间", [{"file_path": "C:/ComfyUI/input/a/工作台.jpg"}]))
    data, reports = subj.compose_timeline(data, subjects)

    content = data["tracks"][0]["segments"][0]["content"]
    assert len(content["images"]) == 1  # 复用，不重复追加
    assert reports[0]["numbers"] == {"车间": "<Picture 1>"}
    assert reports[0]["appended"] == []


def test_muted_image_does_not_take_number(subj):
    subjects = subj.parse_subject_config({"subjects": [{"name": "车间", "path": "a/工作台.jpg"}]})
    data = _timeline(_segment("看 @车间", [{"file_path": "x.jpg", "muted": True}]))
    data, reports = subj.compose_timeline(data, subjects)
    # 静音项不占号 → 车间仍是第一张有效图
    assert reports[0]["numbers"] == {"车间": "<Picture 1>"}


def test_image_cap_respected(subj):
    subjects = subj.parse_subject_config({"subjects": [{"name": "车间", "path": "a/工作台.jpg"}]})
    images = [{"file_path": f"{index}.jpg"} for index in range(subj.MAX_TASK_IMAGES)]
    data = _timeline(_segment("看 @车间", images))
    data, reports = subj.compose_timeline(data, subjects)
    content = data["tracks"][0]["segments"][0]["content"]
    assert len(content["images"]) == subj.MAX_TASK_IMAGES
    assert any("上限" in warning for warning in reports[0]["warnings"])


def test_unresolved_token_is_kept_with_warning(subj):
    subjects = subj.parse_subject_config({"subjects": [{"name": "车间", "path": "a/工作台.jpg"}]})
    data = _timeline(_segment("看 @不存在的东西"))
    data, reports = subj.compose_timeline(data, subjects)
    prompt = data["tracks"][0]["segments"][0]["content"]["user_prompt"]
    assert "@不存在的东西" in prompt  # 原文保留
    assert any("未解析" in warning for warning in reports[0]["warnings"])


def test_zero_intrusion_without_subjects(subj):
    data = _timeline(_segment("原样提示词 @随便", [{"file_path": "a.jpg"}]))
    before = repr(data)
    data, reports = subj.compose_timeline(data, [])
    assert repr(data) == before
    assert reports == []


def test_no_token_no_change(subj):
    subjects = subj.parse_subject_config({"subjects": [{"name": "车间", "path": "a/工作台.jpg"}]})
    data = _timeline(_segment("完全没有引用主体", [{"file_path": "a.jpg"}]))
    data, reports = subj.compose_timeline(data, subjects)
    content = data["tracks"][0]["segments"][0]["content"]
    assert content["user_prompt"] == "完全没有引用主体"
    assert len(content["images"]) == 1
    # 没有令牌 → 不产生报告条目（零噪音）
    assert reports == []


def test_video_subject_not_auto_appended(subj):
    subjects = subj.parse_subject_config(
        {"subjects": [{"name": "参考视频", "kind": "video", "path": "v/ref.mp4"}]}
    )
    data = _timeline(_segment("看 @参考视频"))
    data, reports = subj.compose_timeline(data, subjects)
    content = data["tracks"][0]["segments"][0]["content"]
    assert content["images"] == []
    assert any("没有可追加的图片" in warning for warning in reports[0]["warnings"])


def test_subject_name_validation(subj):
    assert subj.validate_subject_name("校泵车间") is None
    assert subj.validate_subject_name("图片1") == "reserved"
    assert subj.validate_subject_name("Subject 2") == "reserved"
    assert subj.validate_subject_name("") == "empty"
    assert subj.validate_subject_name("含<尖括号>") == "invalid_char"


def test_shots_extracted_from_prompt(subj):
    subjects = subj.parse_subject_config(
        {"subjects": [{"name": "车间", "path": "a/工作台.jpg", "retention": "partially_preserved"}]}
    )
    data = _timeline(_segment("[Shot 1] 开场 @车间 [Shot 3] 收尾 @车间"))
    data, _ = subj.compose_timeline(data, subjects)
    prompt = data["tracks"][0]["segments"][0]["content"]["user_prompt"]
    assert "appears in [Shot 1], [Shot 3]" in prompt
    assert "partially_preserved" in prompt


def test_document_parsing_global_prompt_and_rich_fields(subj):
    raw = {
        "global_prompt": "始终出现的三个人物：小赵、司机、画外老赵",
        "subjects": [
            {
                "name": "安娜",
                "kind": "subject",
                "retention": "fully_preserved",
                "description": "同 <@主角脸部> 与 <@主角全身> 定义的同一位表演者",
                "relationship": "fully preserved",
                "retention_text": "保留面部/发色/身材比例/服装/颜色",
                "resources": [
                    {"kind": "image", "path": "a/anna.png"},
                    {"kind": "audio", "path": "a/anna.wav"},
                ],
            }
        ],
    }
    document = subj.parse_subject_config_document(raw)
    assert document["global_prompt"].startswith("始终出现")
    subject = document["subjects"][0]
    assert subject["retention_text"].startswith("保留面部")
    assert [item["kind"] for item in subject["resources"]] == ["image", "audio"]
    # 兼容纯 JSON 字符串与 RefDirector 的 subject_data 包装
    nested = subj.parse_subject_config_document({"subject_data": raw})
    assert nested["subjects"][0]["name"] == "安娜"


def test_rich_fields_do_not_break_compose(subj):
    subjects = subj.parse_subject_config(
        {"subjects": [{
            "name": "车间",
            "path": "a/工作台.jpg",
            "retention_text": "保留墙面颜色与工具位置",
            "resources": [{"kind": "image", "path": "a/工作台.jpg"}],
        }]}
    )
    data = _timeline(_segment("看 @车间"))
    data, reports = subj.compose_timeline(data, subjects)
    content = data["tracks"][0]["segments"][0]["content"]
    assert len(content["images"]) == 1
    assert reports[0]["numbers"] == {"车间": "<Picture 1>"}


def test_retention_text_used_in_retention_line(subj):
    subjects = subj.parse_subject_config(
        {"subjects": [{"name": "车间", "path": "a/工作台.jpg", "retention_text": "保留工具墙布局"}]}
    )
    data = _timeline(_segment("[Shot 1] 看 @车间"))
    data, _ = subj.compose_timeline(data, subjects)
    prompt = data["tracks"][0]["segments"][0]["content"]["user_prompt"]
    assert "保留工具墙布局" in prompt


def test_global_prompt_prepended(subj):
    subjects = subj.parse_subject_config({"subjects": [{"name": "车间", "path": "a/工作台.jpg"}]})
    data = _timeline(_segment("看 @车间"))
    data, _ = subj.compose_timeline(data, subjects, global_prompt="始终出现的三个人物：小赵、司机")
    prompt = data["tracks"][0]["segments"][0]["content"]["user_prompt"]
    assert prompt.startswith("global:")
    assert "小赵" in prompt


def test_subject_kind_with_image_resource_is_appended(subj):
    subjects = subj.parse_subject_config(
        {"subjects": [{
            "name": "安娜",
            "kind": "subject",
            "resources": [
                {"kind": "image", "path": "a/anna.png"},
                {"kind": "audio", "path": "a/anna.wav"},
            ],
        }]}
    )
    data = _timeline(_segment("看 @安娜"))
    data, reports = subj.compose_timeline(data, subjects)
    content = data["tracks"][0]["segments"][0]["content"]
    assert [image["file_path"] for image in content["images"]] == ["a/anna.png"]
    assert reports[0]["numbers"] == {"安娜": "<Picture 1>"}


def test_email_is_not_parsed_as_subject_token(subj):
    tokens = subj.parse_tokens("联系 zhao@yusheng.com 或 shop.name@foxmail.com")
    assert tokens == []
