"""提示词校验器单元测试（生成结果不通过就不替换）。

    python -m pytest tests/test_h3_prompt_validate.py -q
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "utils" / "h3_prompt_validate.py"

GOOD = """subject_definitions:
<Picture 1> is the tool-wall work area: green metal wall.
summary:
A short reference-driven shot.
retention_analysis:
<Picture 1> (appears in [Shot 1]): fully_preserved - tool wall.
detailed_description:
[Shot 1] The camera pushes in. <d>[Chinese] 你好</d>
overall_soundscape:
Room tone and metal clinks.
non_diegetic_music:
None.
"""


def _load_module():
    spec = importlib.util.spec_from_file_location("h3_prompt_validate_under_test", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def v():
    return _load_module()


def test_good_prompt_passes(v):
    assert v.validate_prompt(GOOD, require_sections=True, picture_count=2, max_shots=2) == []


def test_missing_sections(v):
    failures = v.validate_prompt("只有一句话", require_sections=True)
    assert any("缺少段落" in item for item in failures)


def test_masked_residue(v):
    failures = v.validate_prompt(GOOD.replace("[Shot 1]", "MASKED_0"))
    assert any("MASKED" in item for item in failures)


def test_unexpanded_tokens(v):
    failures = v.validate_prompt(GOOD.replace("<Picture 1>", "<@车间>", 1))
    assert any("令牌" in item for item in failures)


def test_unbalanced_dialogue(v):
    failures = v.validate_prompt(GOOD.replace("</d>", ""))
    assert any("不成对" in item for item in failures)


def test_picture_number_out_of_range(v):
    failures = v.validate_prompt(GOOD, picture_count=0)
    assert any("超出本段图片数量" in item for item in failures)


def test_shot_out_of_range(v):
    failures = v.validate_prompt(GOOD, max_shots=0)
    assert any("超出镜头数量" in item for item in failures)


def test_forbidden_watermark(v):
    failures = v.validate_prompt(GOOD + "\n画面右下角有 water mark 水印")
    assert any("水印" in item for item in failures)


def test_empty_prompt(v):
    assert v.validate_prompt("") == ["提示词为空"]
