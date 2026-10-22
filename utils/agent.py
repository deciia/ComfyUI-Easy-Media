# -*- coding: utf-8 -*-
"""导演工作台的项目智能体：决策 + 流式规划（思考/正文实时透传，不设总时限）。"""
from __future__ import annotations

import json
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


def _compact_context(context: dict | None) -> dict:
    context = context or {}
    segments = []
    for segment in (context.get("segments") or [])[:40]:
        segments.append(
            {
                "index": segment.get("index"),
                "name": segment.get("name"),
                "duration": segment.get("duration_seconds") or segment.get("duration"),
                "summary": (segment.get("summary") or "")[:120],
            }
        )
    plan = context.get("plan") or {}
    return {
        "project": context.get("project") or "",
        "frame_rate": context.get("frame_rate"),
        "ratio": context.get("ratio"),
        "segments": segments,
        "plan": {
            "title": plan.get("title"),
            "total_seconds": plan.get("total_seconds"),
            "count": len(plan.get("segments") or []),
        }
        if plan
        else None,
        "subjects": [str(item.get("name") if isinstance(item, dict) else item) for item in (context.get("subjects") or [])][:30],
        "planned_resources": [
            str(item.get("name") if isinstance(item, dict) else item) for item in (context.get("planned_resources") or [])
        ][:30],
    }


def build_decision_messages(messages: list[dict], context: dict | None) -> list[dict]:
    system = AGENT_SYSTEM_PROMPT + "\n当前项目上下文（JSON）：\n" + json.dumps(_compact_context(context), ensure_ascii=False)
    history = []
    for message in (messages or [])[-12:]:
        role = str(message.get("role") or "user")
        if role not in ("user", "assistant"):
            continue
        text = str(message.get("text") or message.get("content") or "").strip()
        if text:
            history.append({"role": role, "content": text[:4000]})
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


async def _decide(messages: list[dict], context: dict | None, config: dict | None) -> dict:
    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    body = {
        "model": settings.model,
        "messages": build_decision_messages(messages, context),
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


async def run_agent(
    messages: list[dict],
    context: dict | None = None,
    config: dict | None = None,
) -> AsyncIterator[str]:
    """产出 SSE 文本流：step / think / gen / text / plan / action / done / error。"""
    try:
        yield _sse({"type": "step", "label": "理解需求并选择动作"})
        decision = await _decide(messages, context, config)
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
