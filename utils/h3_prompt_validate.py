"""提示词结果校验器（生成结果不通过就不替换）。

对应设计文档 §6.3：六段齐全 / 令牌还原 / 编号在段内资源范围 / `<d>` 成对 /
无字幕水印类描述 / appears in [Shot N] 不越界。纯函数，便于测试。
"""

from __future__ import annotations

import re

REQUIRED_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)

_MASKED_RE = re.compile(r"MASKED_\d+")
_TOKEN_RE = re.compile(r"<@[^>]*>|<#[^>]*>")
_PICTURE_RE = re.compile(r"<Picture\s+(\d+)>", re.IGNORECASE)
_AUDIO_RE = re.compile(r"<Audio\s+(\d+)>", re.IGNORECASE)
_VIDEO_RE = re.compile(r"<Video\s+(\d+)>", re.IGNORECASE)
_SHOT_RE = re.compile(r"\[Shot\s+(\d+)\]", re.IGNORECASE)
_FORBIDDEN_RE = re.compile(r"(字幕|水印|logo|文字叠加|signature|watermark)", re.IGNORECASE)


def _max_number(pattern: re.Pattern, text: str) -> int:
    return max((int(match.group(1)) for match in pattern.finditer(text)), default=0)


def validate_prompt(
    prompt: str,
    *,
    require_sections: bool = False,
    picture_count: int | None = None,
    audio_count: int | None = None,
    video_count: int | None = None,
    max_shots: int | None = None,
) -> list[str]:
    """返回失败项列表；空列表表示通过。"""
    failures: list[str] = []
    text = prompt or ""

    if not text.strip():
        return ["提示词为空"]

    if require_sections:
        lower = text.lower()
        missing = [name for name in REQUIRED_SECTIONS if name not in lower]
        if missing:
            failures.append("缺少段落: " + ", ".join(missing))

    if _MASKED_RE.search(text):
        failures.append("存在未还原的掩码占位符 MASKED_n")

    if _TOKEN_RE.search(text):
        failures.append("仍残留未展开的主体令牌")

    if text.count("<d>") != text.count("</d>"):
        failures.append("<d> 标签不成对")

    if picture_count is not None:
        used = _max_number(_PICTURE_RE, text)
        if used > picture_count:
            failures.append(f"<Picture {used}> 超出本段图片数量 {picture_count}")
    if audio_count is not None:
        used = _max_number(_AUDIO_RE, text)
        if used > audio_count:
            failures.append(f"<Audio {used}> 超出本段音频数量 {audio_count}")
    if video_count is not None:
        used = _max_number(_VIDEO_RE, text)
        if used > video_count:
            failures.append(f"<Video {used}> 超出本段视频数量 {video_count}")

    if max_shots is not None:
        used = _max_number(_SHOT_RE, text)
        if used > max_shots:
            failures.append(f"[Shot {used}] 超出镜头数量 {max_shots}")

    if _FORBIDDEN_RE.search(text):
        failures.append("出现字幕/水印/logo 类描述（官方规范禁止）")

    return failures
