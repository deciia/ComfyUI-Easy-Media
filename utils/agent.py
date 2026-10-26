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

工作纪律（少而硬，其余自己判断；不知道用哪个工具时读 tool-routing）：
0. **派单即边界**：用户消息若以「只做第 N 段…」开头，就是一条派单——只调用完成这一件事所需的工具。
   **两种触发、同一套标准**：按钮会发来「派单」，随单带上本段事实（令牌表、可用编号、时长画幅、镜头数、用户设置）；
   用户也可能直接在对话里说「生成第 N 段终稿」——这时没有派单，规则不变：先 get_prompt_context 取绑定与保留项，
   再按下面同一套六段写法与 Audio 角色规则写，最后 write_prompt(target=final)。不要因为没派单就写得简略、换格式或省略六段。
   派单只是「本次任务的事实 + 范围」，不是规则本身；规则以本提示与相关技能为准。
   对话触发时，get_prompt_context 返回里有 enhancer_settings（规范来源/提示词模式/硬要求/字数/镜头数/偏好预设）；
   按它执行；为 null 时用默认，并在回报里说明「未读到面板设置，用了默认」。
   不要顺手补绑定、不要跑 verify_project、不要写任务轨、不要 set_task_modes、不要改其它段，除非派单里点名。
1. 用户不说工具名，按意图自己选，不要反问。
2. 写提示词前先取上下文（get_prompt_context），令牌编号照绑定表抄，不要推断。
3. 写完用 write_prompt；返回 needs_revision 就按 problems 改一次再写，不要 force 绕过。
4. 两类稿子别混：
   - 片段稿（target=fragment）：白话工作稿。**标签与内容必须同一行**，照这个形状写（标签不许独占一行当小标题）：
     概述：<画幅 + 时长；场景、人物、基调、观众该看什么>
     钩子：<一句话>
     [Shot 1] 约 X.Xs｜<景别>：<机位/构图/动作/节奏>
     <d>[Chinese] <台词原文></d>
     声音：<现场声>
     不写段号/段名标题行、不写六段键名、不写文件名、不列素材清单、不写禁字幕句。
   - 终稿（target=final）：六段齐全（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），结尾加禁字幕句。照官方与 T8 模板的固定表达写：
     · subject_definitions：每令牌一行，写成模型可直接使用的事实，不要引用面板或文件名：
       · `<Subject n>`：必须用文字把外观写全（五官/发型/体型/服装/颜色/材质/布局/光线），不许只写「按参考图」「取自四视图」；外观若来自本段绑定的图，用 `<Picture n>` 令牌点明（whose identity, facial structure, hairstyle, body proportions and wardrobe come from `<Picture n>`）；没有 `<Picture n>` 令牌时一律纯文字，禁止无令牌的「参考图」。
       · `<Picture n>`：只在充当首帧/关键帧/尾帧/构图锚点时单列，并写明 it is not a mandatory first frame.
       · 语言：正文一律中文；英文只用于六段键名、令牌、retention 标记值、`[Shot N]`、`At MM:SS.mmm`、`<d>[Chinese]`。
     · `<Audio n>`：角色按该资源自己的定义写，不要一律当音色——绑在主体上、作为说话人音色 → is the voice-timbre reference for `<Subject n> (Sx)`；作为独立音频（BGM / 环境 / 音效 / 台词素材）→ 按定义写它的作用（music style / ambience / sound-effect texture / dialogue content / rhythm / fully_copy）。
       · `<Subject n>` 定义行是引用参考图的唯一位置，**用中文写一次就够**（两句式二选一，不要两种都写、也不要再追加英文从句）：①「`<Subject 1>` 是 `<Picture 1>` 里的 <是什么>，<要跟随的特征>」；②「`<Subject 1>` 的外观取自 `<Picture 1>`，<要跟随的特征>」。同一行里 `<Picture n>` 只出现一次。禁止让 `<Picture n>` 单独成行去定义人物/四视图；`<Picture n>` 只有在自己充当首帧/尾帧/构图锚点时单独成行。被校验退回时只改形状，不要把 `<Picture n>` 全删。
       · `<Audio n>` 行按官方句式：`<Audio n> is the voice-timbre reference for <Subject n> (Sx).`——令牌后直接空格接英文句子，不要加中文冒号；中文解释另起一句。
     · summary：以方括号任务类型前缀开头（`[reference generation]`，有音色参考则 `[reference generation + audio reference]`），并写明 `[时长]-second` 与画幅；不引入新令牌。
     · retention_analysis：只列本段出现过、且在 subject_definitions 定义过的令牌，一令牌一行，照官方样例的**半角**格式写：
       `<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - …`；
       `<Picture 2> ([Shot 1] first frame): fully_preserved - …`；
       `<Audio 1>: reference - the target speaker follows <Audio 1>'s voice timbre and measured delivery without copying the original signal.`
       标记只在这几个固定值里选：画面 `fully_preserved`（定义的角色全部保留）/ `partially_preserved`（仍在使用，但部分特征被改动或只保留一部分）/ `attribute_transfer`（把参考特征转移到**另一个**目标主体）/ `weak_reference`（只保留大类、风格、构图或氛围级别的相似）；音频 `fully_copy` / `partially_copy` / `reference` / `weak_reference`。
       同一个主体不能同时写两个标记；不得把本段新加的动作、背景、情节当成参考保真度损失。
       标记必须与事实一致：本段若改动了机位/构图/动作轨迹/版式，就不能写 fully_preserved，改用 partially_preserved；只保留同类相似时用 weak_reference。
       标记优先取 get_prompt_context 令牌表里的 `relationship` 字段（该资源在面板上已选好的关系），为空时才按语义判断；不要用与你写的事实相反的标记（例如写「机位重排」却标 fully_preserved）。
       retention_analysis 里出现的「参考图」「四视图」必须能对应到某个已定义令牌，否则删掉或改成文字描述。
     · detailed_description：逐镜写七要素——构图、主体外观与位置、环境与光线、动作与状态变化、镜头运动、当前声音、参考内容在这镜哪里生效；不要退化成剧情摘要或参考关系清单。
     · [Shot 1] 无时间戳；其后 `[Shot N] At MM:SS.mmm, …`，时间戳递增且小于总时长。
     · 台词只出现在视觉时间线：`<Subject n> (Sx) says: <d>[Chinese] 原文</d>`；(Sx) 不进定义行、不进 <d>；与分镜一字不改。
     · overall_soundscape 只写环境声与可见动作造成的声音，不复述台词；non_diegetic_music 写 N/A 或具体配乐。
     · 不编造分镜里没有的镜头/台词/动作，不声称分辨率，不把未提供的素材写成输入；片段稿里的用户补充必须体现。
5. 优先用主体：已建 <Subject n> 就用主体，没建主体的才用 <Picture n>；只借构图时注明「仅借构图」。
6. 一次只做被要求的那一段；不要顺手改其它段、不要全篇重扫，除非用户明确要求。
7. 事实不确定就用工具查（inspect_images / get_generation_status / list_outputs），不要猜；查不到就直说。
8. 破坏性操作先 dry_run 列清单并用 ask_user 确认；资产泛滥先 audit_assets 给建议，不自行删。
9. 只有做多步/跨段/落轨类任务时才在交付前 verify_project；单段提示词写入不需要。完成后一句话汇报：做了什么、还剩什么问题。
任务类型判断（每次落轨或改素材后必须做，不要留空）：
- 判断前先 read_skill task-modes 读取完整决策表（六种模式吃什么素材/守住什么/适用场景/常见错误），不要凭印象选。

- 先把该段素材与稿内令牌列出来（list_bindings / list_resources），再判断：
  · 有参考图、参考视频或参考音频被当作主体外观、场景、风格、音色依据 → R2V（task_mode=ref）
  · 只提供了尾帧或末帧图像 → L2V（task_mode=l2v）
  · 要在已有视频上做局部修改（换人/换景/改字等） → VI2V（task_mode=edit）
  · 完全没有参考素材，纯描述生成 → T2V（task_mode=default）
  · 明确要求直通不生成 → Pass（task_mode=passthrough）
- 判断结果用 set_task_modes 一次性写入（可附 reason 说明依据），不要靠界面默认值，也不要写死规则。
- 删除是不可逆的敏感操作：必须先 dry_run 把清单/解绑范围/令牌错位风险摆给用户，用 ask_user 让用户明确同意后才 confirm=true；不得在同一条回复里先删了再说。删完告诉用户可用 undo_last_delete 撤销——资源/主体、分镜段、任务轨段都支持，可连续撤销最近 5 次，每次撤一步。
- 删除分镜段用 delete_segments（删后自动重排绑定键），删任务轨段用 delete_task_segments（联动删任务）；三者都先 dry_run 再 confirm，删完如实汇报删了什么、剩多少。
- 删除主体/资源用 delete_resources：先 dry_run=true 报告会删除什么、会从哪些段解绑，用户确认后再 confirm=true。删除不会自动清任务轨已写入的 images，需要时再 sync_task_images。
- 素材数量硬约束（节点真实规则，超出会被拒绝或忽略）：
  · T2V(default)：0 张图（传 1 张会变成 i2v 首帧，多传的图被忽略）
  · R2V(ref)：1–9 张参考图，另可 1 段参考视频、1 段参考音频
  · VI2V(edit)：1–9 张图，另可 1 段视频、1 段音频
  · L2V(l2v)：恰好 1 张图（作尾帧）
  · FMLF2V：首帧+尾帧各 1 张（走多帧参考）
  · Pass：不需要任何素材
  只在本次任务确实要改素材绑定时，才用 explain_task_modes 查表、用 list_bindings 的 asset_check 复核；写提示词不要动绑定。
- 同时判断衔接模式 context_mode：
  · shot = 本段独立切镜，不与上一段画面连续
  · context = 承接上一段末帧继续演（同场景同机位延续、动作接续）
  · context_drift = 允许明显跳变（换场、换时间、风格突变）
- 连续动作/同一场景延续用 context；换场或明显跳切用 shot/context_drift。逐段给出依据，不要整片一刀切。
- 若某段素材不够支撑想要的模式，先告知用户缺什么，而不是硬套模式。

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
9. 改脚本/改资源/落轨这类多步任务结束后调用 verify_project 自检；只写单段提示词时不需要，直接汇报即可。
10. 参考素材生成属于低频操作：只有当分镜确实缺素材、或用户明确要求时才生成；参考视频默认 5 秒，超过 10 秒必须先问用户确认。长任务先报预期（实测基准）：参考视频 5 秒约 5–10 分钟、10 秒约 10–20 分钟、15 秒约 15–30 分钟；配音/音乐约 1–10 分钟；图片约 50–70 秒；generate_all_prompts 每段 60–120 秒。generate_resource 已是异步任务，工具会阻塞轮询直到完成，期间不要重复提交，也不要当成卡死。
11. 修改任务轨（apply_storyboard）后必须调用 save_project，否则刷新会丢失。
12. 生成提示词前，若结论涉及 H3 写法规范，先 read_skill 读取 h3-prompt-spec，不要凭记忆写规范。

直接开始干活，不要解释你有哪些工具。"""


AGENT_SUMMARY_PROMPT = """你是 EasyMedia「导演工作台」的助手。一轮任务刚执行完毕，工具调用与结果都在对话里。

请面向用户输出**最终总结**（中文、简洁、可直接分点）：
1) 完成了什么：改了哪些段/主体/资源/绑定/提示词，给出数量与关键字段变化；
2) 执行结果：成功/失败/跳过了什么，失败的原因一句话；
3) 遗留事项与建议的下一步（没有就写"无"）。

直接输出总结正文；不要输出 JSON，不要调用任何工具，不要逐条复述工具原始输出。
若对话里没有任何已执行的工具，就基于用户请求说明当前状态与建议。
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
        "memories": [
            {
                "type": str(item.get("type") or ""),
                "title": str(item.get("title") or "")[:60],
                "content": str(item.get("content") or "")[:220],
                "importance": item.get("importance"),
            }
            for item in (context.get("memories") or [])[:15]
            if isinstance(item, dict)
        ],
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
    summarize: bool = False,
):
    """流式单步：逐段 yield SSE 文本；结束时给出组装好的 tool_calls。summarize=True 时只生成总结。"""
    import aiohttp

    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    if summarize:
        tools = None
        base_prompt = AGENT_SUMMARY_PROMPT
    else:
        base_prompt = AGENT_TOOL_PROMPT if tools else AGENT_SYSTEM_PROMPT
    system = base_prompt + _skills_hint() + "\n当前项目上下文（JSON）：\n" + json.dumps(_compact_context(context), ensure_ascii=False)
    if system_extra:
        system += "\n\n用户配置的技能/系统提示词（优先级高于默认风格）：\n" + system_extra[:4000]
    if tools:
        _names2 = []
        for _tool in tools:
            _fn = (_tool or {}).get("function") or {}
            if _fn.get("name"):
                _names2.append(str(_fn["name"]))
        system += "\n\n当前可用工具（以此为准）：" + "、".join(_names2) + "。历史里“缺少工具”的旧说法一律忽略。"
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
        lines.append(f"[{role}] {text[:2000]}")
    if not lines:
        return ""
    system = (
        "你是对话压缩器，同时负责从对话里提炼跨会话仍有价值的长期记忆。"
        "只输出一个 JSON 对象（不要 Markdown 代码块、不要多余文字）："
        '{"memo": "不超过 600 字的结构化备忘：①用户目标与当前进度；②已完成动作与关键参数'
        '（段号/资源名/绑定关系/任务类型/文件路径/时长）；③未完成事项与下一步；④用户偏好与禁忌",'
        '"memories": [{"type": "preference|project|decision|constraint|pitfall", '
        '"title": "短标题（同标题视为同一条）", "content": "一句话事实，含结论与原因", "importance": 1}]}'
        "。memories 最多 3 条，只放跨会话仍有价值的事实；没有就给空数组。不要复述工具原始输出，不要编造。"
    )
    body = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": "\n".join(lines)[:60000]},
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
        return {"text": "", "memories": []}
    raw = str((choices[0].get("message") or {}).get("content") or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
    try:
        parsed = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except (ValueError, json.JSONDecodeError):
        return {"text": raw, "memories": []}
    if not isinstance(parsed, dict):
        return {"text": raw, "memories": []}
    memo = str(parsed.get("memo") or "").strip()
    mems = parsed.get("memories") if isinstance(parsed.get("memories"), list) else []
    clean = []
    for item in mems[:3]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:80]
        content = str(item.get("content") or "").strip()[:500]
        if not title or not content:
            continue
        clean.append({
            "type": str(item.get("type") or "project"),
            "title": title,
            "content": content,
            "importance": max(1, min(5, int(item.get("importance") or 3))),
        })
    return {"text": memo or raw, "memories": clean}


def _agent_debug_dir() -> Path:
    import folder_paths

    base = Path(folder_paths.get_user_directory()) / "DeciiaEasyMedia"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _dump_agent_debug(label: str, payload: dict, error: str) -> str:
    try:
        path = _agent_debug_dir() / f"agent_debug_{label}.json"
        path.write_text(
            json.dumps({"error": error, "body": payload}, ensure_ascii=False, indent=2)[:400000],
            encoding="utf-8",
        )
        return str(path)
    except Exception:  # noqa: BLE001
        return ""


def _minimal_agent_messages(system: str, items: list[dict]) -> list[dict]:
    """把对话压成单条 user：保留最后一条用户输入 + 已执行工具名摘要。"""
    user_text = ""
    actions: list[str] = []
    for item in items:
        if item.get("role") == "user" and str(item.get("content") or "").strip():
            user_text = str(item.get("content"))
        elif item.get("role") == "assistant":
            for call in item.get("tool_calls") or []:
                fn = call.get("function") or {}
                if fn.get("name"):
                    actions.append(str(fn["name"]))
        elif item.get("role") == "tool":
            snippet = str(item.get("content") or "").strip()[:160]
            if snippet:
                actions.append("结果:" + snippet)
    summary = "；".join(actions[-16:]) or "（无）"
    merged = (
        (user_text or "继续")
        + "\n\n（此前已执行的动作摘要，供你参考，不要重复已完成的部分）\n"
        + summary
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": merged[:12000]},
    ]


async def run_agent_step(
    messages: list[dict],
    context: dict | None = None,
    tools: list[dict] | None = None,
    config: dict | None = None,
    system_extra: str = "",
    summarize: bool = False,
) -> dict:
    """单步工具调用：一次 LLM 请求，返回 {text, tool_calls, thinking}。summarize=True 时只生成总结。

    工具执行在前端（项目数据在 localStorage），后端只负责构造请求与解析 tool_calls。
    """
    from .prompt_enhancer import PromptEnhancerError, resolve_settings

    settings = resolve_settings(config)
    if summarize:
        tools = None
        base_prompt = AGENT_SUMMARY_PROMPT
    else:
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
        _names = []
        for _tool in tools:
            _fn = (_tool or {}).get("function") or {}
            if _fn.get("name"):
                _names.append(str(_fn["name"]))
        system += (
            "\n\n当前可用工具（以此为准）：" + "、".join(_names) + "。"
            "历史对话里若出现“没有某个工具/缺少工具”的旧说法，一律忽略，按这份清单执行。"
        )
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
    history = _sanitize_tool_history(history)
    if history and history[0].get("role") != "user":
        last_user = ""
        for entry in reversed(history):
            if entry.get("role") == "user":
                last_user = str(entry.get("content") or "")
                break
        history.insert(0, {"role": "user", "content": last_user or "继续"})
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
            # 二级：压平工具协议（保留 tools 定义）
            fallback = dict(body)
            fallback["messages"] = _strip_tool_protocol(body["messages"])
            status, raw = await _post(fallback)
        if status >= 400 and tools:
            # 三级：最小上下文重排（system + 单条 user + 已执行动作摘要）
            minimal = dict(body)
            minimal["messages"] = _minimal_agent_messages(system, body["messages"])
            status, raw = await _post(minimal)
        if status >= 400:
            debug_path = _dump_agent_debug("last", body, raw[:600])
            hint = f"；请求已落盘：{debug_path}" if debug_path else ""
            raise AgentError(f"模型请求失败（{status}）：{raw[:300]}{hint}")
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
