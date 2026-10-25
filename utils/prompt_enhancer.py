"""提示词增强器（模态窗）后端：provider 配置 + 云模型调用。

设计文档 §6：模态窗只增强提示词，失败不覆盖原文；默认上传图片、可关闭；
API 配置由用户通过设置按钮写入 ComfyUI/user/DeciiaEasyMedia/prompt_studio.json。

只支持四家：deepseek / glm / minimax-cn / ark（均为 OpenAI 兼容 chat/completions）。
调用失败抛 ``PromptEnhancerError``，由路由转成 4xx/5xx 并保留原文。
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
from dataclasses import dataclass
from pathlib import Path

try:  # ComfyUI 运行时存在；单独导入本模块做静态检查时可能缺失
    import folder_paths
except Exception:  # pragma: no cover
    folder_paths = None

CONFIG_DIR_NAME = "DeciiaEasyMedia"
CONFIG_FILE_NAME = "prompt_studio.json"

PROVIDER_DEFAULTS = {
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1/chat/completions",
        "model": "deepseek-chat",
        "supports_image": False,
    },
    "glm": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": "glm-4.5v",
        "supports_image": True,
    },
    "minimax-cn": {
        "base_url": "https://api.minimaxi.com/v1/chat/completions",
        "model": "MiniMax-M3",
        "supports_image": True,
    },
    "ark": {
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        "model": "doubao-seed-1.6",
        "supports_image": True,
    },
}

DEFAULT_PROVIDER = "deepseek"

SYSTEM_PROMPT = """你是 MiniMax-H3 官方提示词规范（Ref2VA 全参考模式）的改写器。
结构基准：官方 ref-en.txt（可用 read_skill h3-ref2va-official 读取）。

任务：把用户口语化、不规范的片段描述，改写成一条结构规范、可直接使用的视频提示词。

必须遵守（其余自由发挥）：
1. 六段齐全、键名英文小写、顺序固定：
   subject_definitions / summary / retention_analysis / detailed_description /
   overall_soundscape / non_diegetic_music
2. 标签语义：
   - <Subject N> 用于**可复用的可见内容**：人物、动物、物体、场景、服装、道具、风格。
   - <Picture N> 只在图片本身充当某镜的首帧/关键帧/尾帧/构图锚点时才单列；
     图片若只是用来定义人物/场景/风格，写进对应 <Subject N> 的定义里引用它。
   - 只给了 <Picture n> 但内容其实是可复用单元时，可以新建 <Subject n> 并内嵌引用该图片。
   - 已有令牌编号含义不得改变。
3. 令牌编号必须落在本段实际拥有的素材范围内（给了几张图就只能用 <Picture 1..n>）。
4. 台词写在 <d>[Chinese] …</d> 内；<d> 外不要出现引号台词原文。
5. 六段正文语言按「输出语言」要求（默认中文即可），段名保持英文。
6. 画面不得出现字幕、水印、logo、文字叠加。
7. 如果给了参考素材补充/硬性要求，必须遵守；没给就不要编造事实。

写 detailed_description 时按播放顺序把构图、主体位置、环境光线、动作、运镜、当前声音写清楚；
参考关系在 subject_definitions / retention_analysis 里交代即可，不必每个镜头重复同一句注释。

输出只有提示词正文，不要解释、不要 Markdown 代码围栏。"""


class PromptEnhancerError(RuntimeError):
    """调用失败（配置缺失 / 网络错误 / 返回异常）。"""


@dataclass(frozen=True)
class ProviderSettings:
    provider: str
    base_url: str
    model: str
    api_key: str
    supports_image: bool
    timeout: float = 120.0
    upload_images: bool = True


def user_config_path() -> Path:
    if folder_paths is not None:
        base = Path(getattr(folder_paths, "base_path", "") or ".")
    else:  # pragma: no cover
        base = Path(".")
    return base / "user" / CONFIG_DIR_NAME / CONFIG_FILE_NAME


def _new_profile_id(existing: list[str]) -> str:
    index = 1
    while f"p{index}" in existing:
        index += 1
    return f"p{index}"


def normalize_profiles(config: dict) -> tuple[list[dict], str]:
    """返回 (profiles, active_profile)，并把旧的扁平配置自动迁移成单档。"""
    raw = config.get("profiles")
    profiles: list[dict] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            provider = str(item.get("provider") or "").strip()
            if not provider:
                continue
            defaults = PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])
            profiles.append({
                "id": str(item.get("id") or "").strip() or _new_profile_id([p["id"] for p in profiles]),
                "name": str(item.get("name") or "").strip() or f"{provider}",
                "provider": provider,
                "model": str(item.get("model") or defaults["model"]),
                "base_url": str(item.get("base_url") or defaults["base_url"]),
                "api_key": str(item.get("api_key") or ""),
                "supports_image": bool(item.get("supports_image", defaults["supports_image"])),
                "upload_images": bool(item.get("upload_images", config.get("upload_images", True))),
            })
    if not profiles:
        provider = str(config.get("provider") or "").strip()
        if provider:
            profiles.append({
                "id": "p1",
                "name": str(config.get("name") or provider),
                "provider": provider,
                "model": str(config.get("model") or PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])["model"]),
                "base_url": str(config.get("base_url") or PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])["base_url"]),
                "api_key": str(config.get("api_key") or ""),
                "supports_image": bool(config.get("supports_image", PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])["supports_image"])),
                "upload_images": bool(config.get("upload_images", True)),
            })
    active = str(config.get("active_profile") or "").strip()
    ids = [item["id"] for item in profiles]
    if active not in ids:
        active = ids[0] if ids else ""
    return profiles, active


def active_profile(config: dict | None = None) -> dict:
    """取当前生效的配置档（没有 profiles 时返回旧扁平结构）。"""
    data = config if config is not None else load_config()
    profiles, active = normalize_profiles(data)
    for item in profiles:
        if item["id"] == active:
            return item
    if profiles:
        return profiles[0]
    return dict(data)


def load_config(path: Path | None = None) -> dict:
    target = path or user_config_path()
    if not target.is_file():
        return {}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_config(config: dict, path: Path | None = None) -> Path:
    target = path or user_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target


def _mask_key(key: str) -> dict:
    return {
        "api_key": "",
        "api_key_set": bool(key),
        "api_key_tail": key[-4:] if len(key) >= 8 else "",
    }


def masked_config(config: dict) -> dict:
    """返回给前端的配置：每个配置档的 api_key 只给是否存在与后四位。"""
    profiles, active = normalize_profiles(config)
    masked_profiles = []
    for item in profiles:
        masked = {k: v for k, v in item.items() if k != "api_key"}
        masked.update(_mask_key(str(item.get("api_key") or "")))
        masked_profiles.append(masked)
    chosen = next((item for item in profiles if item["id"] == active), profiles[0] if profiles else {})
    result = {
        "profiles": masked_profiles,
        "active_profile": active,
        # 兼容旧前端：顶层继续给出当前档的扁平字段
        "provider": chosen.get("provider", ""),
        "model": chosen.get("model", ""),
        "base_url": chosen.get("base_url", ""),
        "supports_image": chosen.get("supports_image", False),
        "upload_images": chosen.get("upload_images", True),
        "timeout": config.get("timeout") or 120.0,
    }
    result.update(_mask_key(str(chosen.get("api_key") or "")))
    return result


def resolve_settings(config: dict | None = None) -> ProviderSettings:
    data = active_profile(config)
    raw_provider = str(data.get("provider") or "").strip()
    if not raw_provider:
        # 配置文件里 provider 被显式清空时不要静默回落到 deepseek，
        # 否则会拿别家的 key 去请求 deepseek 端点，报 401 但看不出原因
        if data.get("api_key") or data.get("model") or data.get("base_url"):
            raise PromptEnhancerError(
                "AI 模型配置不完整：缺少 provider（提供方）。请打开 导演台设置 → API，重新选择提供方与模型后保存。"
            )
        raw_provider = DEFAULT_PROVIDER
    provider = raw_provider
    defaults = PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])
    base_url = normalize_endpoint(provider, str(data.get("base_url") or defaults["base_url"]))
    model = str(data.get("model") or defaults["model"])
    api_key = str(data.get("api_key") or "")
    if not api_key:
        env_name = {
            "deepseek": "DEEPSEEK_API_KEY",
            "glm": "GLM_API_KEY",
            "minimax-cn": "MINIMAX_CN_API_KEY",
            "ark": "VOLCENGINE_API_KEY",
        }.get(provider, "")
        api_key = os.environ.get(env_name, "") if env_name else ""
    if not api_key:
        raise PromptEnhancerError(f"未配置 {provider} 的 API Key：请在提示词增强器的设置里填写")
    supports_image = bool(data.get("supports_image", defaults["supports_image"]))
    return ProviderSettings(
        provider=provider,
        base_url=base_url,
        model=model,
        api_key=api_key,
        supports_image=supports_image,
        timeout=float(data.get("timeout") or 120.0),
        upload_images=bool(data.get("upload_images", True)),
    )


def normalize_endpoint(provider: str, base_url: str) -> str:
    """把"服务商根地址 / 不完整地址"补全成 chat/completions 端点。

    用户常常只填根地址（如 https://open.bigmodel.cn/api/v1），直接 POST 会 404；
    这里按 provider 补全，已经是完整端点则原样返回。
    """
    url = (base_url or "").strip().rstrip("/")
    if not url:
        return PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])["base_url"]
    if url.endswith("/chat/completions"):
        return url
    defaults = PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])
    if provider == "glm":
        # 智谱：统一走 paas/v4
        if "/api/paas" in url:
            return url + "/chat/completions"
        if url.endswith("/api/v1") or url.endswith("/api"):
            return "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        return url + "/chat/completions"
    if provider == "deepseek":
        if url.endswith("/v1") or url.endswith("/api"):
            return url + "/chat/completions"
        if "api.deepseek.com" in url:
            return "https://api.deepseek.com/v1/chat/completions"
        return url + "/chat/completions"
    if provider == "ark":
        if url.endswith("/api/v3") or url.endswith("/v3"):
            return url + "/chat/completions"
        return url + "/chat/completions"
    if provider == "minimax-cn":
        if url.endswith("/v1") or url.endswith("/api"):
            return url + "/chat/completions"
        return url + "/chat/completions"
    return defaults["base_url"]


def _data_uri(path: str) -> str | None:
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return None
    if len(raw) > 8 * 1024 * 1024:
        return None
    mime = mimetypes.guess_type(path)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def build_messages(payload: dict, settings: ProviderSettings) -> list[dict]:
    brief = str(payload.get("brief") or "").strip()
    if not brief:
        raise PromptEnhancerError("片段提示词为空")
    options = payload.get("options") or {}

    # 翻译模式：只做语言转换，protect 令牌与 <d> 台词
    if str(options.get("mode") or "") == "translate":
        target = str(options.get("output_language") or "中文")
        return [
            {
                "role": "system",
                "content": (
                    "你是 MiniMax-H3 提示词的翻译器。把用户给出的提示词翻译成"
                    f"{target}。规则：段落键名（subject_definitions / summary / retention_analysis / "
                    "detailed_description / overall_soundscape / non_diegetic_music）与 "
                    "<Picture n>/<Audio n>/<Video n>/<Subject n> 标签保持英文原样；"
                    "<@…>、<#…:台词>、<d>…</d> 原样保留不翻译；只输出译文。"
                ),
            },
            {"role": "user", "content": brief},
        ]

    task_type = str(options.get("task_type") or payload.get("task_type") or "Ref2VA")
    task_mode = str(options.get("task_mode") or payload.get("task_mode") or "")
    duration_seconds = options.get("duration_seconds") or payload.get("duration_seconds") or 5
    lines = [
        f"输出语言：{payload.get('language') or options.get('output_language') or '中文'}"
        "（章节正文可用中文；<d> 台词保留原语言即可）",
        (f"全局约束（整支视频）：{payload.get('global_prompt')}" if payload.get("global_prompt") else ""),
        f"生成类型：{task_type}" + (f"（模式 {task_mode}）" if task_mode else ""),
        f"镜头数量：{options.get('shot_count') or 'AUTO'}",
        f"目标时长（秒）：{duration_seconds}",
        f"改写模式：{options.get('rewrite_mode') or 'balanced'}",
        f"目标长度（0=自动）：{options.get('description_word_target') or 0}",
        f"提示词模式：{options.get('prompt_mode') or '官方增强'}",
    ]

    def _family(label: str, values: object, hint: str) -> None:
        if isinstance(values, list):
            chosen = [str(item).strip() for item in values if str(item).strip()]
            if chosen and chosen != ["模型自由决定"]:
                lines.append(f"{label}（必须体现）：{'、'.join(chosen)}；{hint}")

    _family("运镜", options.get("camera_motion"), "用规范镜头语言写进每个镜头")
    _family("微表情", options.get("expression"), "写成可观察的面部细节，不要抽象形容词")
    _family("景别", options.get("shot_size"), "每个镜头明确景别")
    _family("构图关系", options.get("framing"), "写清人物与环境的相对位置")

    word_target = options.get("description_word_target")
    if word_target:
        lines.append(f"目标长度：约 {word_target} 词（0 表示自动）")
    skill_profile = str(options.get("official_skill_profile") or "")
    if skill_profile:
        lines.append(f"官方 Skill 协议：{skill_profile}（严格模式下所有说明字段使用英文，仅台词/歌词保留原语言）")
    reference_template = str(options.get("reference_template") or "").strip()
    if reference_template:
        lines.append("参考模板（提供镜头结构/节奏/运镜/风格参照，用户素材仍为准）：\n" + reference_template[:2000])

    subjects = payload.get("subjects") or []
    if subjects:
        subject_lines = []
        for index, subject in enumerate(subjects[:16], start=1):
            label = subject.get("label") or subject.get("token") or ""
            retention = subject.get("retention") or []
            retention_text = ""
            if retention:
                retention_text = "；保留特征：" + "、".join(str(item) for item in retention[:8])
            subject_lines.append(
                f"- {subject.get('name')} → {label or f'<Subject {index}>'}: "
                f"{subject.get('description') or subject.get('role') or ''}{retention_text}"
            )
        lines.append("可用主体（令牌里出现的名字必须在此表中，编号以此为准，禁止错位/重定义）：\n" + "\n".join(subject_lines))

    bindings = payload.get("bindings") or {}
    binding_parts = []
    for key, label in (("pictures", "图片"), ("audio", "音频"), ("video", "视频")):
        entries = bindings.get(key) or []
        if entries:
            binding_parts.append(
                label + "：" + "、".join(
                    f"{entry.get('token')}={entry.get('name')}" for entry in entries[:12] if isinstance(entry, dict)
                )
            )
    if binding_parts:
        lines.append("本段绑定素材（编号即下表，不要自行重排）：\n" + "\n".join(binding_parts) + "\n说明：主体自带的参考图（如四视图）已算作该主体的来源，不占用 <Picture n> 编号；<Picture n> 只对应下表中的图片。")
    reference_context = str(options.get("reference_context") or "").strip()
    if reference_context:
        lines.append("参考素材补充：" + reference_context)
    constraints = str(options.get("constraints") or "").strip()
    if constraints:
        lines.append("硬性要求：" + constraints)
    lines.append(
        "归一化要求：输出必须使用官方结构（subject_definitions / detailed_description（含 [Shot N] 与 At 00:0X.XXX 时间戳）/ "
        "overall_soundscape / non_diegetic_music）。R2V/VI2V 必须含 subject_definitions 六段式；T2V/L2V 可用三段式。"
        "用户片段中的中文自由描述、中文章节名都要就地改写成官方字段；"
        "<Subject n>/<Picture n>/<Audio n>/<Video n>/<d>…</d> 令牌保持编号含义不变，禁止重命名或重定义已有令牌；"
        "允许为人物/场景/风格这类可复用单元新建 <Subject n>，并在其定义里内嵌引用作为来源的 <Picture n>（图片本身不是某一镜的首帧/关键帧时不单列）；"
        "At 时间戳必须递增且不得超过目标时长；禁止出现文字、字幕、logo、水印。"
    )
    lines.append(
        "输出格式（硬性）：每个使用到的段名必须单独占一行、紧跟一个英文半角冒号，正文另起一行。"
        "正确示例：\n"
        "subject_definitions:\n"
        "<Subject 1> is the mechanic in <Picture 1>: mid-fifties, short grey-flecked crew cut, light stubble, dark grey work jacket with rolled cuffs; preserve face, hair, build and wardrobe; do not copy the four-view layout itself.\n"
        "<Picture 2> is the first frame of [Shot 1], showing the workbench from a slight high angle.\n\n"
        "summary:\n坠落之后的幽暗深海…\n\n"
        "retention_analysis:\n- <Subject 1> …\n"
        "禁止写成「## subject_definitions」「**subject_definitions**」「subject_definitions」后直接接正文，"
        "也不要使用中文全角冒号。"
    )
    lines.append(
        "用户片段（片段提示词：可能是白话提纲/分镜脚本/口语描述，**不要求六段式**，也不需要 H3 语法；\n"
        "你的任务是把它加上主体与资源引用，改写成结构规范的最终提示词）：\n" + brief
    )
    instruction = "\n".join(lines)

    content: list[dict] | str = instruction
    images = payload.get("images") or []
    if settings.upload_images and settings.supports_image and images:
        blocks: list[dict] = [{"type": "text", "text": instruction}]
        for index, path in enumerate(images[:6]):
            uri = _data_uri(str(path))
            if not uri:
                continue
            blocks.append({"type": "text", "text": f"参考图片 {index + 1}："})
            blocks.append({"type": "image_url", "image_url": {"url": uri}})
        content = blocks

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


_AT_TOKEN_RE = re.compile(r"<@([^>]+)>|@([^\s@<>，,。.;；:：!?！？、()（）\[\]【】]+)")


_SECTION_KEYS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
    "integrated_multimodal_description",
)


def normalize_section_headings(text: str) -> str:
    """把段名行未带冒号/带全角冒号/markdown 标记的写法统一成 ``key:``。"""
    if not text:
        return text
    result = text
    for key in _SECTION_KEYS:
        result = re.sub(
            rf"(?im)^[ \t]*(?:#{{1,6}}[ \t]*)?(?:\*\*)?[ \t]*{key}[ \t]*(?:\*\*)?[ \t]*[:：]?[ \t]*$",
            f"{key}:",
            result,
        )
    return result


def localize_tokens(prompt: str, subjects: list[dict]) -> tuple[str, list[str]]:
    """把提示词里的 @名字 换成官方标签（<Picture n> 优先，否则 <Subject N>）。"""
    mapping: dict[str, str] = {}
    for index, subject in enumerate(subjects or [], start=1):
        name = str(subject.get("name") or "").strip()
        if not name:
            continue
        mapping[name.casefold()] = str(subject.get("label") or subject.get("token") or f"<Subject {index}>")
    if not mapping:
        return prompt, []

    unresolved: list[str] = []

    def replace(match: re.Match) -> str:
        name = (match.group(1) or match.group(2) or "").strip()
        label = mapping.get(name.casefold())
        if label:
            return label
        unresolved.append(name)
        return match.group(0)

    return _AT_TOKEN_RE.sub(replace, prompt), unresolved


async def generate_prompt(payload: dict, config: dict | None = None) -> dict:
    """调用云模型生成规范提示词；失败抛 PromptEnhancerError。"""
    settings = resolve_settings(config)
    messages = build_messages(payload, settings)

    import aiohttp  # 延迟导入，便于纯函数测试

    body = {
        "model": settings.model,
        "messages": messages,
        "temperature": {"strict": 0.2, "balanced": 0.7, "creative": 1.2}.get(
            str((payload.get("options") or {}).get("rewrite_mode") or "balanced"), 0.7
        ),
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {settings.api_key}", "Content-Type": "application/json"}
    try:
        timeout = aiohttp.ClientTimeout(total=settings.timeout)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(settings.base_url, json=body, headers=headers) as response:
                raw = await response.text()
                if response.status >= 400:
                    raise PromptEnhancerError(f"API 返回 {response.status}: {raw[:300]}")
                data = json.loads(raw)
    except PromptEnhancerError:
        raise
    except Exception as error:  # noqa: BLE001 - 统一转成可展示错误
        raise PromptEnhancerError(f"调用失败: {error}") from error

    if "choices" not in data:
        detail = ""
        if isinstance(data, dict):
            detail = str(data.get("msg") or data.get("message") or data.get("error") or "")
            code = data.get("code")
            if code is not None:
                detail = f"code={code} {detail}".strip()
        raise PromptEnhancerError(
            f"API 返回非标准结构（可能是 Base URL 不对）：{detail[:200] or str(data)[:200]}"
        )
    try:
        message = data["choices"][0]["message"]
        prompt = message.get("content")
        if isinstance(prompt, list):
            prompt = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part) for part in prompt
            )
    except (KeyError, IndexError, TypeError) as error:
        raise PromptEnhancerError("API 返回结构异常（缺少 choices.message.content）") from error
    prompt = str(prompt or "").strip()
    if prompt.startswith("```"):
        prompt = prompt.strip("`")
        prompt = prompt.split("\n", 1)[-1] if "\n" in prompt else prompt
    if not prompt:
        raise PromptEnhancerError("API 返回空提示词")
    localized, unresolved = localize_tokens(prompt, payload.get("subjects") or [])
    return {
        "prompt": normalize_section_headings(localized),
        "provider": settings.provider,
        "model": settings.model,
        "unresolved_subjects": unresolved,
    }
