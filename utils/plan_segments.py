"""分镜编排（AI 导演级规划）后端。

与「提示词增强」的分工：
- 这里产出的是**分镜脚本**（段/镜头/台词/微表情/声音/导演意图），不是生成模型提示词；
- 后续由提示词增强把分镜脚本对齐成模型规范提示词。

兼容曜石导演台的文本分镜格式（``# 镜头名 | 4秒`` + 正文），便于互相导入导出。
"""

from __future__ import annotations

import json
import re
from typing import Any

PLAN_SYSTEM_PROMPT = """你是一位资深影视导演兼分镜师，同时熟悉短视频节奏与 MiniMax-H3 的生成能力。
你的任务：把创作者的想法，变成一份**可以直接执行拍摄/生成的分镜脚本**，而不是提示词。

请像真正的导演一样思考和写作：

一、先定叙事骨架（写进顶层字段，不写进画面描述）
- 类型与基调：剧情/广告/口播/动作/悬疑/温情…，镜头语言随之不同。
- 节奏曲线：开场钩子（前 3 秒必须抓人）→ 推进 → 转折 → 高潮 → 收束/回味。
- 观众要看懂什么、情绪落点在哪、留白在哪里。

二、再分段：一段 = 一次可连续生成的镜头组
- 每段建议 3–10 秒（1–15 秒内），段落数量按总时长合理分配，不要平均切。
- 每段承担一个明确的戏剧功能（beat）：钩子、建立、铺垫、冲突、转折、高潮、释放、留白。
- 对话密集处可长一点，动作/情绪爆发处要短切。
- 段落之间要有承接关系（动作接动作、视线接视线、声音接声音）。

三、每段写清楚镜头表（shots），逐镜给出：
- framing：景别（大远景/远景/全景/中景/中近景/特写/大特写），要有变化，别一景到底。
- camera：机位与运动（固定/横移/推/拉/摇/跟/升降/手持），说明动机。
- action：画面里发生什么（谁、在哪、做什么、状态如何变化），要具体可拍。
- dialogue：台词，数组；每项 {speaker, line}。写清谁先说、谁回应、有没有打断/停顿。
- micro_expression：微表情与身体语言（眼神、嘴角、呼吸、手指、重心转移），用于情绪转折。
- sound：本镜的声音（对白、环境、动作音效、音乐进入/退出）。
- transition：与下一镜的衔接方式（切/动作匹配/视线匹配/声音先入/黑场）。

四、专业导演规则（必须体现在镜头表里，不要写在解释里）
- 对话戏优先正反打 + 过肩，保持 180° 轴线；三人以上用双人同框交代站位。
- 动作戏用短镜 + 匹配剪辑，动接动、方向一致；避免无动机的运镜。
- 情绪转折用特写或 Insert（手、眼睛、物件），给足反应镜头。
- 文戏敢于长镜和留白，不要切碎；武戏敢于短切和冲击，不要拖。
- 同一空间先建立（全景/中景），再进入细节，避免观众迷失。
- 每段最多 4 个镜头；不要编造不存在的素材。

五、推导主体与资源（分镜决定它们，不要等提示词阶段再想）
- subjects：本段出现的角色/场景/物体，{name, type(人物/场景/物体/风格), description, retention[]}。
  名字用中文短名，全片保持一致；retention 写必须保持不变的外观/空间要素。
- resources：本段需要的参考素材，{kind(image/audio/video), name, note, for: 用途}。
  缺失也没关系，后续资源页补齐；不要编造文件名。

输出：只输出 JSON，不要 Markdown 代码块，不要解释。结构如下：
{
  "title": "项目标题",
  "logline": "一句话故事",
  "genre": "剧情/广告/动作/口播…",
  "tone": "整体调性与视觉方向",
  "rhythm": "节奏设计一句话（钩子/推进/转折/高潮/收束）",
  "total_seconds": 30,
  "segments": [
    {
      "name": "段名（简短、可读）",
      "beat": "钩子|建立|铺垫|冲突|转折|高潮|释放|留白",
      "duration": 4,
      "summary": "这一段的戏剧功能与内容（1–2 句）",
      "director_note": "为什么这样拍（选这个景别/机位/节奏的原因，1 句）",
      "shots": [
        {
          "framing": "中景",
          "camera": "缓慢推近",
          "action": "人物动作与画面变化",
          "dialogue": [{"speaker": "小赵", "line": "台词"}],
          "micro_expression": "眼神先躲开，随后抬眼直视",
          "sound": "环境声 + 衣服摩擦声，音乐未进",
          "transition": "动作匹配切下一镜"
        }
      ],
      "subjects": [{"name": "小赵", "type": "人物", "description": "外观与身份", "retention": ["发型", "服装"]}],
      "resources": [{"kind": "image", "name": "诊室全景", "note": "空景", "for": "建立空间"}]
    }
  ]
}
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
    if not (number > 0) or number != number:
        return None
    return number


def build_plan_messages(payload: dict) -> list[dict]:
    """构造导演级规划请求消息。payload.brief 必填。"""
    brief = _text(payload.get("brief"), 8000)
    if not brief:
        raise PlanError("请先填写想法/故事描述")
    duration = _positive_number(payload.get("duration_seconds")) or 30.0
    duration = min(max(duration, 3.0), 600.0)
    ratio = _text(payload.get("ratio"), 20) or "16:9"
    style = _text(payload.get("style"), 300)
    language = _text(payload.get("language"), 8) or "zh"
    audience = _text(payload.get("audience"), 200)
    must = payload.get("must_have") if isinstance(payload.get("must_have"), list) else []
    subjects = payload.get("subjects") if isinstance(payload.get("subjects"), list) else []

    lines = [
        f"总时长：{duration:g} 秒",
        f"画幅：{ratio}",
        f"台词语言：{'中文' if language.startswith('zh') else '英文'}",
    ]
    if style:
        lines.append(f"风格/参考：{style}")
    if audience:
        lines.append(f"目标观众：{audience}")
    if must:
        lines.append("必须包含：" + "；".join(_text(item, 80) for item in must[:10] if _text(item, 80)))
    subject_lines = []
    for item in subjects[:24]:
        if isinstance(item, dict):
            name = _text(item.get("name"), 60)
            if name:
                subject_lines.append(f"- {name}（{_text(item.get('type'), 20) or '未分类'}）")
    if subject_lines:
        lines.append("已有主体（优先复用，别造同名）：\n" + "\n".join(subject_lines))
    lines.append("我的想法：\n" + brief)
    lines.append("请按导演级标准输出 JSON 分镜脚本。")
    return [
        {"role": "system", "content": PLAN_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(lines)},
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
        raise PlanError("分镜脚本必须是 JSON 对象")
    return data


def _normalize_shots(raw: Any) -> list[dict]:
    shots: list[dict] = []
    for index, shot in enumerate((raw if isinstance(raw, list) else [])[:6]):
        if not isinstance(shot, dict):
            continue
        framing = _text(shot.get("framing"), 20)
        if framing not in _FRAMINGS:
            framing = "中景"
        dialogue = []
        for item in (shot.get("dialogue") if isinstance(shot.get("dialogue"), list) else [])[:8]:
            if isinstance(item, dict):
                line = _text(item.get("line"), 400)
                if line:
                    dialogue.append({"speaker": _text(item.get("speaker"), 40), "line": line})
            else:
                line = _text(item, 400)
                if line:
                    dialogue.append({"speaker": "", "line": line})
        shots.append({
            "shot": len(shots) + 1,
            "framing": framing,
            "camera": _text(shot.get("camera"), 80),
            "action": _text(shot.get("action"), 600),
            "dialogue": dialogue,
            "micro_expression": _text(shot.get("micro_expression"), 300),
            "sound": _text(shot.get("sound"), 300),
            "transition": _text(shot.get("transition"), 80),
        })
    if not shots:
        shots = [{
            "shot": 1, "framing": "中景", "camera": "", "action": "",
            "dialogue": [], "micro_expression": "", "sound": "", "transition": "",
        }]
    return shots


def normalize_plan(data: dict, frame_rate: float = 30.0) -> dict:
    """把模型输出规范成稳定结构；非法时抛 PlanError。"""
    if not isinstance(data, dict):
        raise PlanError("分镜脚本必须是对象")
    raw_segments = data.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise PlanError("分镜脚本缺少 segments")
    safe_rate = float(frame_rate) if frame_rate and frame_rate > 0 else 30.0
    segments: list[dict] = []
    cursor = 0
    for index, raw in enumerate(raw_segments[:_MAX_SEGMENTS]):
        if not isinstance(raw, dict):
            continue
        duration = _positive_number(raw.get("duration"))
        duration = min(max(duration if duration is not None else 4.0, 0.5), 15.0)
        frames = max(1, round(duration * safe_rate))
        name = _text(raw.get("name"), 80) or f"镜头 {index + 1}"

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
                "for": _text(resource.get("for"), 120),
            })

        segments.append({
            "index": len(segments) + 1,
            "name": name,
            "beat": _text(raw.get("beat"), 20),
            "duration_seconds": round(duration, 3),
            "duration_frames": frames,
            "start_frame": cursor,
            "end_frame": cursor + frames,
            "summary": _text(raw.get("summary"), 500),
            "director_note": _text(raw.get("director_note"), 400),
            "shots": _normalize_shots(raw.get("shots")),
            "subjects": subjects,
            "resources": resources,
            # 分镜阶段不强制英文提示词；保留字段供 ④ 填充
            "prompt_draft": _text(raw.get("prompt_draft"), 8000),
        })
        cursor += frames
    if not segments:
        raise PlanError("分镜脚本里没有有效片段")
    return {
        "title": _text(data.get("title"), 120),
        "logline": _text(data.get("logline"), 300),
        "genre": _text(data.get("genre"), 60),
        "tone": _text(data.get("tone"), 300),
        "rhythm": _text(data.get("rhythm"), 300),
        "total_seconds": round(cursor / safe_rate, 3),
        "total_frames": cursor,
        "frame_rate": safe_rate,
        "segments": segments,
    }


def plan_from_response(raw: str, frame_rate: float = 30.0) -> dict:
    return normalize_plan(extract_json_object(raw), frame_rate=frame_rate)


def render_storyboard_text(plan: dict, limit: int = 200) -> str:
    """导出为曜石导演台兼容的文本分镜（``# 名称 | 秒`` + 正文）。"""
    lines: list[str] = []
    for segment in plan.get("segments", [])[:limit]:
        name = str(segment.get("name") or "镜头").replace("\n", " ")
        duration = float(segment.get("duration_seconds") or 4)
        lines.append(f"# {name} | {duration:g}秒")
        body = [str(segment.get("summary") or "").strip()]
        for shot in segment.get("shots", []):
            part = f"[{shot.get('framing', '')}] {shot.get('action', '')}"
            if shot.get("camera"):
                part += f"（{shot['camera']}）"
            body.append(part.strip())
            for line in shot.get("dialogue", []):
                speaker = f"{line['speaker']}：" if line.get("speaker") else ""
                body.append(f"{speaker}{line['line']}")
        lines.append("\n".join(item for item in body if item))
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def parse_storyboard_text(source: str, frame_rate: float = 30.0) -> dict:
    """解析曜石导演台文本分镜（``# 名称 | 4秒`` 后跟正文）。"""
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
        current["summary"] = prompt.splitlines()[0][:200] if prompt else ""
        current["prompt_draft"] = prompt
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


async def generate_plan(payload: dict, config: dict | None = None) -> dict:
    """调用云模型生成导演级分镜；失败抛 PlanError。"""
    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    messages = build_plan_messages(payload)
    import aiohttp

    body = {
        "model": settings.model,
        "messages": messages,
        "temperature": 0.8,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}
    try:
        timeout = aiohttp.ClientTimeout(total=max(60, settings.timeout))
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(settings.base_url, json=body, headers=headers) as response:
                raw = await response.text()
                if response.status >= 400:
                    raise PlanError(f"API 返回 {response.status}: {raw[:300]}")
                data = json.loads(raw)
    except PlanError:
        raise
    except PromptEnhancerError as error:
        raise PlanError(str(error)) from error
    except Exception as error:  # noqa: BLE001
        raise PlanError(f"调用失败: {error}") from error

    if not isinstance(data, dict) or "choices" not in data:
        detail = ""
        if isinstance(data, dict):
            detail = str(data.get("msg") or data.get("message") or data.get("error") or "")
        raise PlanError(f"API 返回非标准结构：{detail[:200] or str(data)[:200]}")
    try:
        message = data["choices"][0]["message"]
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part) for part in content
            )
    except (KeyError, IndexError, TypeError) as error:
        raise PlanError("API 返回结构异常（缺少 choices.message.content）") from error
    raw_text = str(content or "").strip()
    frame_rate = _positive_number(payload.get("frame_rate")) or 30.0
    plan = plan_from_response(raw_text, frame_rate=frame_rate)
    plan["raw"] = raw_text[:4000]
    return plan
