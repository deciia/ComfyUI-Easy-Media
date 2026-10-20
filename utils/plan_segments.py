"""分镜编排（AI 规划）后端：把 brief 变成可校验的分镜表。

设计要点
- 只做「规划 → 结构化 JSON」，不直接改时间线；应用由前端预览后提交。
- 兼容曜石导演台的文本分镜格式（``# 镜头名 | 4秒`` + 提示词正文），便于互相导入导出。
- 严格校验：任何字段缺失/非法都补默认或报错，绝不让前端拿到半截数据。
"""

from __future__ import annotations

import json
import re
from typing import Any

PLAN_SYSTEM_PROMPT = """你是短视频分镜规划器，为 MiniMax-H3 Ref2VA 工作流把文字需求拆成分镜表。
只输出 JSON，不要解释、不要 Markdown 代码块。

输出结构：
{
  "title": "项目标题",
  "total_seconds": 30,
  "segments": [
    {
      "name": "镜头 1",
      "duration": 4,
      "summary": "一句话说明这段在讲什么",
      "shots": [
        {"shot": 1, "framing": "中景", "camera": "缓慢推进", "action": "人物动作与画面变化"}
      ],
      "subjects": [
        {"name": "小赵", "type": "人物", "description": "外观与身份", "retention": ["发型", "服装"]}
      ],
      "resources": [
        {"kind": "image", "name": "办公室全景", "note": "空景参考"}
      ],
      "prompt_draft": "可直接用于生成的英文提示词草稿"
    }
  ]
}

规则：
1. 每段 duration 单位为秒，范围 1–15；所有 duration 之和应接近给定总时长（±20% 内）。
2. shots 每段 1–4 个；framing 用「大远景/远景/全景/中景/中近景/特写/大特写」之一。
3. subjects 只列本段实际出现的角色/场景/物体，name 用中文短名；retention 写需要保持不变的要素。
4. resources 写本段需要的参考素材（kind: image/audio/video），缺失也可以列出，后续资源页补齐。
5. prompt_draft 用英文、按 MiniMax-H3 Ref2VA 六段式组织（subject_definitions / summary /
   retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），
   用 <Subject n> / <Picture n> / <Audio n> / <Video n> 引用主体与素材，不要使用 @ 语法。
6. 段数不超过 12 段；没有把握的字段可以省略，但不要编造不存在的素材文件。
"""

_FRAMINGS = ("大远景", "远景", "全景", "中景", "中近景", "特写", "大特写")
_REF_KINDS = ("image", "audio", "video")
_MAX_SEGMENTS = 24


class PlanError(ValueError):
    """分镜规划数据非法。"""


def _text(value: Any, limit: int = 200) -> str:
    if value is None:
        return ""
    return str(value).strip()[:limit]


def _positive_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not (number > 0) or not (number == number):  # NaN 守卫
        return None
    return number


def build_plan_messages(payload: dict) -> list[dict]:
    """构造规划请求消息。payload.brief 为必填。"""
    brief = _text(payload.get("brief"), 4000)
    if not brief:
        raise PlanError("请先填写故事/需求描述")
    duration = _positive_number(payload.get("duration_seconds")) or 30.0
    ratio = _text(payload.get("ratio"), 20) or "16:9"
    style = _text(payload.get("style"), 200)
    language = _text(payload.get("language"), 8) or "en"
    subjects = payload.get("subjects") if isinstance(payload.get("subjects"), list) else []
    subject_lines = []
    for item in subjects[:24]:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"), 60)
        if not name:
            continue
        subject_lines.append(f"- {name}（{_text(item.get('type'), 20) or '未分类'}）")
    user_parts = [
        f"总时长：{duration:g} 秒",
        f"画幅：{ratio}",
        f"提示词语言：{'英文' if language.startswith('en') else '中文'}",
    ]
    if style:
        user_parts.append(f"风格：{style}")
    if subject_lines:
        user_parts.append("已有主体（优先复用，不要重复造同名主体）：\n" + "\n".join(subject_lines))
    user_parts.append(f"故事/需求：\n{brief}")
    user_parts.append("请输出 JSON 分镜表。")
    return [
        {"role": "system", "content": PLAN_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]


def extract_json_object(raw: str) -> dict:
    """从模型输出里取出 JSON 对象（容忍代码块与前后废话）。"""
    text = (raw or "").strip()
    if not text:
        raise PlanError("模型返回为空")
    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    if fenced:
        text = fenced.group(1)
    if not text.startswith("{"):
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise PlanError("模型没有返回 JSON 对象")
        text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise PlanError(f"JSON 解析失败：{error}") from error
    if not isinstance(data, dict):
        raise PlanError("分镜表必须是 JSON 对象")
    return data


def normalize_plan(data: dict, frame_rate: float = 30.0) -> dict:
    """把模型输出规范成稳定结构；非法时抛 PlanError。"""
    if not isinstance(data, dict):
        raise PlanError("分镜表必须是对象")
    raw_segments = data.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise PlanError("分镜表缺少 segments")
    safe_rate = float(frame_rate) if frame_rate and frame_rate > 0 else 30.0
    segments: list[dict] = []
    cursor = 0
    for index, raw in enumerate(raw_segments[:_MAX_SEGMENTS]):
        if not isinstance(raw, dict):
            continue
        duration = _positive_number(raw.get("duration"))
        if duration is None:
            duration = 4.0
        duration = min(max(duration, 0.5), 15.0)
        frames = max(1, round(duration * safe_rate))
        name = _text(raw.get("name"), 80) or f"镜头 {index + 1}"
        prompt = _text(raw.get("prompt_draft"), 8000)
        shots_raw = raw.get("shots") if isinstance(raw.get("shots"), list) else []
        shots: list[dict] = []
        for shot_index, shot in enumerate(shots_raw[:6]):
            if not isinstance(shot, dict):
                continue
            framing = _text(shot.get("framing"), 20)
            if framing not in _FRAMINGS:
                framing = _FRAMINGS[3]
            shots.append({
                "shot": shot_index + 1,
                "framing": framing,
                "camera": _text(shot.get("camera"), 60),
                "action": _text(shot.get("action"), 400),
            })
        if not shots:
            shots = [{"shot": 1, "framing": "中景", "camera": "", "action": ""}]
        subjects: list[dict] = []
        for subject in (raw.get("subjects") if isinstance(raw.get("subjects"), list) else [])[:12]:
            if not isinstance(subject, dict):
                continue
            subject_name = _text(subject.get("name"), 60)
            if not subject_name:
                continue
            retention = subject.get("retention")
            retention_items = [
                _text(item, 40) for item in (retention if isinstance(retention, list) else [])[:12]
            ]
            subjects.append({
                "name": subject_name,
                "type": _text(subject.get("type"), 20) or "未分类",
                "description": _text(subject.get("description"), 400),
                "retention": [item for item in retention_items if item],
            })
        resources: list[dict] = []
        for resource in (raw.get("resources") if isinstance(raw.get("resources"), list) else [])[:12]:
            if not isinstance(resource, dict):
                continue
            kind = _text(resource.get("kind"), 10).lower()
            if kind not in _REF_KINDS:
                kind = "image"
            resource_name = _text(resource.get("name"), 80)
            if not resource_name:
                continue
            resources.append({
                "kind": kind,
                "name": resource_name,
                "note": _text(resource.get("note"), 200),
            })
        segments.append({
            "index": len(segments) + 1,
            "name": name,
            "duration_seconds": round(duration, 3),
            "duration_frames": frames,
            "start_frame": cursor,
            "end_frame": cursor + frames,
            "summary": _text(raw.get("summary"), 400),
            "shots": shots,
            "subjects": subjects,
            "resources": resources,
            "prompt_draft": prompt,
        })
        cursor += frames
    if not segments:
        raise PlanError("分镜表里没有有效片段")
    return {
        "title": _text(data.get("title"), 120),
        "total_seconds": round(cursor / safe_rate, 3),
        "total_frames": cursor,
        "frame_rate": safe_rate,
        "segments": segments,
    }


def plan_from_response(raw: str, frame_rate: float = 30.0) -> dict:
    """模型原始输出 → 规范化分镜表。"""
    return normalize_plan(extract_json_object(raw), frame_rate=frame_rate)


def render_storyboard_text(plan: dict, limit: int = 200) -> str:
    """导出为曜石导演台兼容的文本分镜（``# 名称 | 秒`` + 提示词正文）。"""
    lines: list[str] = []
    for segment in plan.get("segments", [])[:limit]:
        name = str(segment.get("name") or "镜头").replace("\n", " ")
        duration = float(segment.get("duration_seconds") or 4)
        lines.append(f"# {name} | {duration:g}秒")
        lines.append(str(segment.get("prompt_draft") or "").strip())
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def parse_storyboard_text(source: str, frame_rate: float = 30.0) -> dict:
    """解析曜石导演台文本分镜（``# 名称 | 4秒`` 后跟提示词正文）。"""
    if not isinstance(source, str) or not source.strip():
        raise PlanError("分镜文本为空")
    if len(source) > 1024 * 1024:
        raise PlanError("分镜文本上限 1 MiB")
    rows: list[dict] = []
    current: dict | None = None
    body: list[str] = []

    def flush() -> None:
        nonlocal current, body
        if current is None:
            return
        prompt = "\n".join(body).strip()
        while prompt.startswith("\n"):
            prompt = prompt[1:]
        current["prompt_draft"] = prompt
        current["summary"] = prompt.splitlines()[0][:200] if prompt else ""
        rows.append(current)
        current, body = None, []

    for line in source.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        header = re.match(r"^\s*#\s+(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*$", line, re.I)
        if header:
            flush()
            name = header.group(1).strip()[:80]
            duration = _positive_number(header.group(2)) or 4.0
            current = {"name": name or "镜头", "duration": min(max(duration, 0.5), 15.0)}
            body = []
            continue
        if current is not None:
            body.append(line)
    flush()
    if not rows:
        raise PlanError("没有解析到镜头（格式：`# 镜头名称 | 4秒` 后跟提示词）")
    return normalize_plan({"segments": rows}, frame_rate=frame_rate)
