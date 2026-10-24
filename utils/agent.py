# -*- coding: utf-8 -*-
"""导演工作台的项目智能体：决策 + 流式规划（思考/正文实时透传，不设总时限）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, AsyncIterator

from .plan_segments import PlanError, build_plan_messages, plan_from_response


class AgentError(RuntimeError):
    """智能体调用失败。"""


AGENT_SYSTEM_PROMPT = """你是 EasyMedia「导演工作台」里的项目智能体，负责在**当前项目范围内**替用户干活。

你可以调用以下工具（不是描述，而是真的会执行）：

1. plan_storyboard —— 按用户想法从零生成整片分镜脚本（段落/beat/时长/镜头表/台词/微表情/声音）。
   参数：brief（用户想法，必填）、duration_seconds、ratio、style。
2. revise_storyboard —— 在现有分镜基础上按修改要求重写。
   参数：instruction（修改要求，必填）。
3. apply_storyboard —— 把当前分镜脚本应用到任务轨（创建/替换片段）。
   参数：无。
4. answer —— 只回答/讨论，不执行任何写操作。
   参数：reply。

判断规则：
- 用户给出故事/想法要求生成分镜 → plan_storyboard
- 已分镜，要求改（拆段、合并、改台词、调节奏、换风格…）→ revise_storyboard
- 要求“应用/落到时间线/生成片段” → apply_storyboard
- 询问、确认、闲聊、解释 → answer

已有数据适配策略（重要，先读上下文再选动作）：
- 上下文里已有任务分段（segments 非空）：说明用户手动建过分镜。不要主动提出整体重写；
  除非用户明确要求“重新生成整片”，否则优先 revise_storyboard 做增量修改，或 answer 说明现状并给建议。
- 上下文里已有主体（subjects 非空）：沿用现有主体名字与设定，不要在 reply 里建议重建主体库；
  生成/修改分镜时如需引用，直接用现有名字。
- 上下文里已有资源需求（planned_resources 非空）：视为既定清单，修改分镜时保持资源需求连续，
  只在用户要求时增删。
- 用户只是补充信息或问问题 → answer，不要顺手执行写操作。
- 段上的 images 是已绑定的参考素材，audio_tracks 是时间线音轨（很可能是参考音色）：
  这些是既定事实，修改分镜时保持绑定关系不变，不随意增删或重命名引用。
- 一切写操作前，reply 里用一句话说清楚你将改什么、影响哪几段。

只输出一个 JSON 对象，不要 Markdown 代码块，不要多余文字：
{"action": "plan_storyboard", "params": {"brief": "..."}, "reply": "给用户看的一句话"}
或
{"action": "revise_storyboard", "params": {"instruction": "..."}, "reply": "..."}
或
{"action": "apply_storyboard", "params": {}, "reply": "..."}
或
{"action": "answer", "params": {"reply": "..."}, "reply": "..."}

reply 要用中文、简洁、像同事说话，不要复述 JSON。
"""


AGENT_TOOL_PROMPT = """你是 EasyMedia「导演工作台」的项目智能体。你通过**调用工具**干活，而不是输出 JSON 动作。

工作原则：
1. 先读后写：动手前先 get_plan / list_segments / list_resources 搞清楚现状，不要凭猜测编段号或资源名。
2. 一次只做用户要求的事，不擅自扩大范围；连续相关的小改动可以合并成一轮完成。
3. 每次写完用一句话汇报改了什么（改了哪几段、字段变化），不要复述工具输出。
4. 需要用户拍板（题材方向、是否覆盖、选哪个素材）时调用 ask_user 给选项，不要替用户决定。
5. 不确定的信息不要编造：没有的素材就用 list_input_files 查，查不到就问用户。
6. 台词/提示词要符合 MiniMax-H3 规范：台词只写在 <d> 标签里；镜头描述里不写台词原文；参考素材用 <Subject n>/<Picture n>/<Audio n> 令牌引用。
7. 生成分镜用 plan_storyboard；改分镜用 revise_storyboard 或段级工具；提示词用 generate_prompt / generate_all_prompts；落任务轨用 apply_storyboard；正式生成用 run_generation；生成后可用 list_outputs 查产物。
8. 应用任务轨/正式生成属于重动作：执行前先用一句话说明将发生什么（除非用户已明确要求）。

交付纪律（必须遵守）：
9. 任何一轮"改脚本/改资源/生成提示词/落轨"结束后，必须调用 verify_project 自检，并把剩余问题一句话汇报。
10. 长任务先报预期（实测基准）：参考视频 5 秒约 5–10 分钟、10 秒约 10–20 分钟、15 秒约 15–30 分钟；配音/音乐约 1–10 分钟；图片约 50–70 秒；generate_all_prompts 每段 60–120 秒。generate_resource 已是异步任务，工具会阻塞轮询直到完成，期间不要重复提交，也不要当成卡死。
11. 修改任务轨（apply_storyboard）后必须调用 save_project，否则刷新会丢失。
12. 生成提示词前，若结论涉及 H3 写法规范，先 read_skill 读取 h3-prompt-spec，不要凭记忆写规范。

直接开始干活，不要解释你有哪些工具。"""


def _compact_context(context: dict | None) -> dict:
    context = context or {}
    segments = []
    for segment in (context.get("segments") or [])[:40]:
        segments.append(
            {
                "index": segment.get("index"),
                "name": segment.get("name"),
                "duration": segment.get("duration_seconds") or segment.get("duration"),
                "images": [str(item) for item in (segment.get("images") or [])][:8],
                "has_prompt": bool(segment.get("has_prompt")),
            }
        )
    plan = context.get("plan") or {}
    plan_segments = []
    for index, segment in enumerate((plan.get("segments") or [])[:40]):
        if not isinstance(segment, dict):
            continue
        plan_segments.append(
            {
                "index": segment.get("index") or index + 1,
                "name": str(segment.get("name") or ""),
                "duration": segment.get("duration_seconds"),
                "beat": str(segment.get("beat") or "")[:40],
                "shots": segment.get("shots"),
                "has_prompt_a": segment.get("has_prompt_a"),
                "final_a_len": segment.get("final_a_len"),
                "task_mode": segment.get("task_mode"),
            }
        )
    return {
        "project": context.get("project") or "",
        "frame_rate": context.get("frame_rate"),
        "ratio": context.get("ratio"),
        "segments": segments,
        "plan": {
            "title": plan.get("title"),
            "total_seconds": plan.get("total_seconds"),
            "count": len(plan.get("segments") or []),
            "segments": plan_segments,
        }
        if plan
        else None,
        "subjects": [
            (
                {"name": str(item.get("name")), "description": str(item.get("description") or "")[:120]}
                if isinstance(item, dict)
                else {"name": str(item)}
            )
            for item in (context.get("subjects") or [])
        ][:30],
        "audio_tracks": [str(item) for item in (context.get("audio_tracks") or [])][:10],
        "planned_resources": [
            str(item.get("name") if isinstance(item, dict) else item) for item in (context.get("planned_resources") or [])
        ][:30],
        "todos": [
            {"text": str(item.get("text") or "")[:120], "status": str(item.get("status") or "pending")}
            for item in (context.get("todos") or [])
            if isinstance(item, dict)
        ][:24],
        "notes": {
            str(key)[:60]: str(value)[:400]
            for key, value in list((context.get("notes") or {}).items())[:20]
        },
        "mentions": [
            {
                "name": str(item.get("name") or "")[:60],
                "type": str(item.get("type") or ""),
                "found": bool(item.get("found")),
            }
            for item in (context.get("mentions") or [])
            if isinstance(item, dict)
        ][:20],
    }


def build_decision_messages(messages: list[dict], context: dict | None, system_extra: str = "") -> list[dict]:
    system = AGENT_SYSTEM_PROMPT + "\n当前项目上下文（JSON）：\n" + json.dumps(_compact_context(context), ensure_ascii=False)
    if system_extra:
        system += "\n\n用户配置的技能/系统提示词（优先级高于默认风格）：\n" + system_extra[:4000]
    history = []
    for message in (messages or [])[-12:]:
        role = str(message.get("role") or "user")
        if role not in ("user", "assistant"):
            continue
        text = str(message.get("text") or message.get("content") or "").strip()
        if text:
            history.append({"role": role, "content": text[:4000]})
    history = _sanitize_tool_history(history)
    if not history:
        history = [{"role": "user", "content": "你好"}]
    return [{"role": "system", "content": system}, *history]


def parse_decision(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise AgentError("模型没有返回可解析的动作 JSON")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as error:
        raise AgentError(f"动作 JSON 解析失败：{error}") from error
    if not isinstance(data, dict):
        raise AgentError("动作 JSON 不是对象")
    action = str(data.get("action") or "answer").strip()
    if action not in ("plan_storyboard", "revise_storyboard", "apply_storyboard", "answer"):
        action = "answer"
        data.setdefault("params", {})
        data["params"] = {"reply": str(data.get("reply") or "")}
    params = data.get("params") if isinstance(data.get("params"), dict) else {}
    reply = str(data.get("reply") or params.get("reply") or "").strip()
    return {"action": action, "params": params, "reply": reply}


async def _decide(messages: list[dict], context: dict | None, config: dict | None, system_extra: str = "") -> dict:
    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    body = {
        "model": settings.model,
        "messages": build_decision_messages(messages, context, system_extra),
        "temperature": 0.3,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}
    import aiohttp

    try:
        timeout = aiohttp.ClientTimeout(total=120)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(settings.base_url, json=body, headers=headers) as response:
                raw = await response.text()
                if response.status >= 400:
                    raise AgentError(f"决策请求失败（{response.status}）：{raw[:300]}")
                data = json.loads(raw)
    except AgentError:
        raise
    except PromptEnhancerError as error:
        raise AgentError(str(error)) from error
    except Exception as error:  # noqa: BLE001
        raise AgentError(f"决策请求异常（{type(error).__name__}）：{error}") from error
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise AgentError("决策响应格式异常") from error
    return parse_decision(str(content))


def _sse(event: dict) -> str:
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


async def _stream_plan(payload: dict, config: dict | None) -> AsyncIterator[tuple[str, str]]:
    """流式调用规划模型；yield ('think'|'content', delta)。不设总时限。"""
    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    messages = build_plan_messages(payload)
    body = {
        "model": settings.model,
        "messages": messages,
        "temperature": 0.8,
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}
    import aiohttp

    # 不限总时长：连接保持即持续产出；仅防呆——30 秒连不上 / 300 秒无任何字节才断
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_connect=30, sock_read=300)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(settings.base_url, json=body, headers=headers) as response:
                if response.status >= 400:
                    raw = await response.text()
                    raise AgentError(f"规划请求失败（{response.status}）：{raw[:300]}")
                buffer = ""
                async for chunk in response.content.iter_any():
                    buffer += chunk.decode("utf-8", errors="replace")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            return
                        try:
                            item = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        choices = item.get("choices") or []
                        delta = (choices[0].get("delta") or {}) if choices else {}
                        reasoning = delta.get("reasoning_content")
                        if reasoning:
                            yield ("think", str(reasoning))
                        content = delta.get("content")
                        if content:
                            yield ("content", str(content))
    except AgentError:
        raise
    except PromptEnhancerError as error:
        raise AgentError(str(error)) from error
    except Exception as error:  # noqa: BLE001
        raise AgentError(f"流式规划异常（{type(error).__name__}）：{error}") from error



def _sanitize_tool_history(items: list[dict]) -> list[dict]:
    """把工具协议历史整理成合法序列。

    - 开头孤立的 tool 消息丢弃（24 条裁切可能把 assistant 切掉）
    - assistant 的 tool_calls 必须紧跟对应 id 的 tool 回复；缺一个就整条降级为文本
    """
    cleaned: list[dict] = []
    index = 0
    total = len(items)
    while index < total:
        item = items[index]
        role = item.get("role")
        if role == "tool":
            index += 1
            continue
        calls = item.get("tool_calls") if role == "assistant" else None
        if not calls:
            cleaned.append(item)
            index += 1
            continue
        wanted = [str(call.get("id")) for call in calls]
        following: list[dict] = []
        cursor = index + 1
        while cursor < total and items[cursor].get("role") == "tool":
            following.append(items[cursor])
            cursor += 1
        provided = {str(message.get("tool_call_id")) for message in following}
        if all(call_id in provided for call_id in wanted):
            cleaned.append(item)
            cleaned.extend(message for message in following if str(message.get("tool_call_id")) in wanted)
        else:
            summary = "；".join(
                f"{call['function']['name']}({str(call['function'].get('arguments'))[:100]})"
                for call in calls
                if call.get("function")
            )
            text = str(item.get("content") or "")
            cleaned.append({"role": "assistant", "content": (text + "\n[调用工具：" + summary + "]").strip()})
        index = cursor
    return cleaned


def _skills_hint() -> str:
    try:
        items = list_skills()
    except Exception:
        return ""
    if not items:
        return ""
    names = "、".join(f"{item['name']}（{item['title']}）" for item in items[:12])
    return "\n\n可用技能包（写提示词/分镜前用 read_skill 按需读取，不要凭记忆编规范）：" + names


def skills_dir() -> Path:
    """技能目录：<ComfyUI>/user/DeciiaEasyMedia/skills/*.md"""
    import folder_paths

    base = Path(folder_paths.get_user_directory()) / "DeciiaEasyMedia" / "skills"
    base.mkdir(parents=True, exist_ok=True)
    return base


def list_skills() -> list[dict]:
    items = []
    for path in sorted(skills_dir().glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        title = path.stem
        for line in text.split("\n"):
            if line.strip().startswith("#"):
                title = line.strip("# ").strip() or title
                break
        items.append({"name": path.stem, "title": title, "chars": len(text)})
    return items


def read_skill(name: str) -> str:
    safe = "".join(ch for ch in str(name) if ch.isalnum() or ch in "-_ ")
    path = skills_dir() / f"{safe.strip()}.md"
    if not path.exists():
        raise FileNotFoundError(f"技能不存在：{name}")
    return path.read_text(encoding="utf-8", errors="ignore")


async def stream_agent_step(
    messages: list[dict],
    context: dict | None,
    tools: list[dict] | None,
    config: dict | None,
    system_extra: str = "",
):
    """流式单步：逐段 yield SSE 文本；结束时给出组装好的 tool_calls。"""
    import aiohttp

    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    base_prompt = AGENT_TOOL_PROMPT if tools else AGENT_SYSTEM_PROMPT
    system = base_prompt + _skills_hint() + "\n当前项目上下文（JSON）：\n" + json.dumps(_compact_context(context), ensure_ascii=False)
    if system_extra:
        system += "\n\n用户配置的技能/系统提示词（优先级高于默认风格）：\n" + system_extra[:4000]
    if tools:
        system += (
            "\n\n你现在可以使用工具读写项目数据。规则：① 先读后写；② 一次只做用户要求的事；"
            "③ 改完用一句话汇报；④ 不确定先 ask_user；⑤ 不要编造段号或资源名。"
        )

    history: list[dict] = []
    for message in (messages or [])[-24:]:
        role = str(message.get("role") or "user")
        if role not in ("user", "assistant", "tool"):
            continue
        text = str(message.get("text") or message.get("content") or "")
        if role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            if call_id:
                history.append({"role": "tool", "tool_call_id": call_id, "content": text[:6000]})
            continue
        calls = message.get("tool_calls")
        if role == "assistant" and isinstance(calls, list) and calls:
            normalized = []
            for index, call in enumerate(calls):
                fn = (call or {}).get("function") or {}
                if not fn.get("name"):
                    continue
                normalized.append({
                    "id": str(call.get("id") or f"call_{index}"),
                    "type": "function",
                    "function": {"name": str(fn.get("name")), "arguments": str(fn.get("arguments") or "{}")},
                })
            item: dict = {"role": "assistant", "tool_calls": normalized}
            if text:
                item["content"] = text
            history.append(item)
            continue
        history.append({"role": role, "content": text})
    history = _sanitize_tool_history(history)
    if not history:
        history = [{"role": "user", "content": "你好"}]

    body: dict = {
        "model": settings.model,
        "messages": [{"role": "system", "content": system}, *history],
        "temperature": 0.3,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}

    collected_text: list[str] = []
    tool_buffer: dict[int, dict] = {}
    usage: dict = {}
    timeout = aiohttp.ClientTimeout(total=180)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(settings.base_url, json=body, headers=headers) as response:
            if response.status >= 400:
                raw = await response.text()
                yield f"data: {json.dumps({'type': 'error', 'error': f'流式请求失败（{response.status}）：{raw[:200]}'}, ensure_ascii=False)}\n\n"
                return
            buffer = ""
            async for raw_chunk in response.content.iter_any():
                buffer += raw_chunk.decode("utf-8", errors="ignore")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(chunk.get("usage"), dict) and chunk["usage"]:
                        usage = chunk["usage"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        collected_text.append(str(piece))
                        yield f"data: {json.dumps({'type': 'text', 'delta': str(piece)}, ensure_ascii=False)}\n\n"
                    for call in delta.get("tool_calls") or []:
                        index = int(call.get("index") or 0)
                        slot = tool_buffer.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        if call.get("id"):
                            slot["id"] = str(call["id"])
                        fn = call.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = str(fn["name"])
                        if fn.get("arguments"):
                            slot["arguments"] += str(fn["arguments"])

    calls = []
    for index in sorted(tool_buffer):
        slot = tool_buffer[index]
        if not slot.get("name"):
            continue
        calls.append({"id": slot.get("id") or f"call_{index}", "name": slot["name"], "arguments": slot.get("arguments") or "{}"})
    yield f"data: {json.dumps({'type': 'final', 'text': ''.join(collected_text), 'tool_calls': calls, 'usage': usage, 'model': settings.model}, ensure_ascii=False)}\n\n"


async def compact_messages(messages: list[dict], config: dict | None = None) -> str:
    """把较早的对话压成要点备忘（Toonflow 式 compaction）。"""
    from .prompt_enhancer import PromptEnhancerError, resolve_settings
    import aiohttp

    settings = resolve_settings(config)
    lines = []
    for message in (messages or [])[-40:]:
        role = str(message.get("role") or "")
        if role not in ("user", "assistant", "tool"):
            continue
        text = str(message.get("text") or message.get("content") or "").strip()
        if not text:
            continue
        lines.append(f"[{role}] {text[:1200]}")
    if not lines:
        return ""
    system = (
        "你是对话压缩器。把下面这段导演台助手与用户的对话压缩成不超过 400 字的要点备忘。"
        "必须保留：用户目标、已完成动作与关键参数、未完成事项、用户偏好与禁忌。不要复述细节，不要编造。"
    )
    body = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": "\n".join(lines)[:24000]},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}
    timeout = aiohttp.ClientTimeout(total=120)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(settings.base_url, json=body, headers=headers) as response:
            raw = await response.text()
            if response.status >= 400:
                raise PromptEnhancerError(f"压缩失败（{response.status}）：{raw[:200]}")
            data = json.loads(raw)
    choices = data.get("choices") or []
    if not choices:
        return ""
    return str((choices[0].get("message") or {}).get("content") or "").strip()


async def run_agent_step(
    messages: list[dict],
    context: dict | None = None,
    tools: list[dict] | None = None,
    config: dict | None = None,
    system_extra: str = "",
) -> dict:
    """单步工具调用：一次 LLM 请求，返回 {text, tool_calls, thinking}。

    工具执行在前端（项目数据在 localStorage），后端只负责构造请求与解析 tool_calls。
    """
    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    base_prompt = AGENT_TOOL_PROMPT if tools else AGENT_SYSTEM_PROMPT
    system = (
        base_prompt
        + _skills_hint()
        + "\n当前项目上下文（JSON）：\n"
        + json.dumps(_compact_context(context), ensure_ascii=False)
    )
    if system_extra:
        system += "\n\n用户配置的技能/系统提示词（优先级高于默认风格）：\n" + system_extra[:4000]
    if tools:
        system += (
            "\n\n你现在可以使用工具读写项目数据（分镜脚本/主体/资源/绑定）。规则："
            "① 先读后写，写之前用 list_/get_ 确认现状；② 一次只做用户要求的事，不自作主张扩大范围；"
            "③ 改完用一句话汇报改了什么；④ 不确定时先 ask_user 提问；⑤ 不要编造段号或资源名。"
        )
    history = []
    for message in (messages or [])[-24:]:
        role = str(message.get("role") or "user")
        if role not in ("user", "assistant", "tool"):
            continue
        text = str(message.get("text") or message.get("content") or "")
        tool_calls = message.get("tool_calls")
        if role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            if not call_id:
                continue
            history.append({"role": "tool", "tool_call_id": call_id, "content": (text or "")[:6000]})
            continue
        item: dict[str, Any] = {"role": role}
        if isinstance(tool_calls, list) and tool_calls:
            # 补全 id/type/function 结构；content 为空时省略（GLM 不接受 null）
            normalized = []
            for index, call in enumerate(tool_calls):
                if not isinstance(call, dict):
                    continue
                fn = call.get("function") or {}
                if not fn.get("name"):
                    continue
                normalized.append({
                    "id": str(call.get("id") or f"call_{index}"),
                    "type": "function",
                    "function": {
                        "name": str(fn.get("name")),
                        "arguments": str(fn.get("arguments") or "{}"),
                    },
                })
            if normalized:
                item["tool_calls"] = normalized
                if text:
                    item["content"] = text
            elif text:
                item["content"] = text
            else:
                continue
        else:
            item["content"] = text
        history.append(item)
    if not history:
        history = [{"role": "user", "content": "你好"}]

    body: dict[str, Any] = {
        "model": settings.model,
        "messages": [{"role": "system", "content": system}, *history],
        "temperature": 0.3,
        "stream": False,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}
    import aiohttp

    def _strip_tool_protocol(items: list[dict]) -> list[dict]:
        """把工具协议历史压平成纯文本，兼容不接受 tool 角色的模型。"""
        out: list[dict] = []
        for item in items:
            role = item.get("role")
            if role == "system":
                out.append(item)
                continue
            if role == "tool":
                continue
            content = item.get("content") or ""
            calls = item.get("tool_calls") or []
            if calls:
                summary = "；".join(
                    f"{call['function']['name']}({call['function']['arguments'][:120]})" for call in calls if call.get("function")
                )
                content = (content + "\n[上一轮已调用工具：" + summary + "]").strip()
            out.append({"role": role, "content": content or "已执行工具调用。"})
        return out

    async def _post(payload_body: dict) -> tuple[int, str]:
        timeout = aiohttp.ClientTimeout(total=180)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(settings.base_url, json=payload_body, headers=headers) as response:
                return response.status, await response.text()

    try:
        status, raw = await _post(body)
        if status >= 400 and tools and ("1214" in raw or "tool" in raw.lower() or "messages" in raw):
            # 把工具历史压平后重试一次（仍保留 tools 定义）
            fallback = dict(body)
            fallback["messages"] = _strip_tool_protocol(body["messages"])
            status, raw = await _post(fallback)
        if status >= 400:
            raise AgentError(f"模型请求失败（{status}）：{raw[:300]}")
        data = json.loads(raw)
    except AgentError:
        raise
    except PromptEnhancerError as error:
        raise AgentError(str(error)) from error
    except Exception as error:  # noqa: BLE001
        raise AgentError(f"模型请求异常（{type(error).__name__}）：{error}") from error

    try:
        choice = data["choices"][0]
        message = choice.get("message") or {}
    except (KeyError, IndexError, TypeError) as error:
        raise AgentError("模型响应格式异常") from error

    text = str(message.get("content") or "")
    calls = []
    for call in (message.get("tool_calls") or [])[:8]:
        fn = call.get("function") or {}
        args = fn.get("arguments")
        calls.append({
            "id": str(call.get("id") or ""),
            "name": str(fn.get("name") or ""),
            "arguments": args if isinstance(args, str) else json.dumps(args or {}, ensure_ascii=False),
        })
    return {
        "text": text,
        "tool_calls": calls,
        "usage": (data.get("usage") or {}),
        "model": settings.model,
    }

async def run_agent(
    messages: list[dict],
    context: dict | None = None,
    config: dict | None = None,
    system_extra: str = "",
) -> AsyncIterator[str]:
    """产出 SSE 文本流：step / think / gen / text / plan / action / done / error。"""
    try:
        yield _sse({"type": "step", "label": "理解需求并选择动作"})
        decision = await _decide(messages, context, config, system_extra)
        action = decision["action"]
        reply = decision["reply"]
        yield _sse({"type": "step", "label": f"选择动作：{action}"})

        if action in ("plan_storyboard", "revise_storyboard"):
            params = decision["params"]
            payload: dict[str, Any] = {
                "brief": str(params.get("brief") or ""),
                "instruction": str(params.get("instruction") or ""),
                "duration_seconds": params.get("duration_seconds"),
                "ratio": params.get("ratio"),
                "style": params.get("style"),
                "frame_rate": (context or {}).get("frame_rate") or 24,
            }
            if action == "revise_storyboard":
                payload["previous_plan"] = (context or {}).get("plan")
                if not payload["instruction"]:
                    raise AgentError("缺少修改要求")
            else:
                if not payload["brief"]:
                    raise AgentError("缺少故事想法")
            yield _sse({"type": "step", "label": "调用规划模型（流式生成，不限时，可点停止）"})
            raw = ""
            async for kind, delta in _stream_plan(payload, config):
                if kind == "think":
                    yield _sse({"type": "think", "text": delta})
                else:
                    raw += delta
                    yield _sse({"type": "gen", "text": delta})
            if not raw.strip():
                raise AgentError("规划模型没有返回内容")
            yield _sse({"type": "step", "label": "解析并校验分镜 JSON"})
            plan = plan_from_response(raw, payload["frame_rate"])
            yield _sse({"type": "plan", "plan": plan})
            yield _sse({"type": "text", "text": reply or f"分镜已生成：{len(plan.get('segments') or [])} 段。"})
            yield _sse({"type": "done"})
            return

        if action == "apply_storyboard":
            yield _sse({"type": "action", "action": "apply_storyboard", "label": "应用到任务轨"})
            yield _sse({"type": "text", "text": reply or "已请求应用当前分镜到任务轨。"})
            yield _sse({"type": "done"})
            return

        text = reply or str(decision["params"].get("reply") or "")
        yield _sse({"type": "text", "text": text or "我在。你可以让我生成分镜、改分镜，或把分镜应用到任务轨。"})
        yield _sse({"type": "done"})
    except PlanError as error:
        yield _sse({"type": "error", "message": str(error)})
    except AgentError as error:
        yield _sse({"type": "error", "message": str(error)})
    except Exception as error:  # noqa: BLE001
        yield _sse({"type": "error", "message": f"智能体异常（{type(error).__name__}）：{error}"})
