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

任务：把用户口语化、不规范的片段描述，改写成一条**官方规范、结构完整**的视频提示词。

硬性规则：
1. 输出必须是六个段落，段落键名保持英文小写，顺序固定：
   subject_definitions / summary / retention_analysis / detailed_description /
   overall_soundscape / non_diegetic_music
2. 参考标签沿用输入里给出的 `<Picture n>` / `<Audio n>` / `<Video n>`，**不得新增或改动编号**；
   出现 `<@名字>`、`<#名字:台词>`、`<d>…</d>` 等占位令牌时**原样保留**，不要翻译、不要解释。
3. `<d>` 内的台词保持原语言；中文台词写作 `<d>[Chinese] 台词</d>`。
4. 引用内容必须在 retention_analysis 里给出出现镜头：`<Picture 2> (appears in [Shot 1]): fully_preserved - …`。
5. 生成内容禁止出现字幕、水印、logo、文字叠加。
6. detailed_description 要按镜头顺序写：构图、主体外观与位置、环境与光线、动作与状态变化、
   运镜、当前声音，以及参考内容真正生效的位置；不要写成剧情梗概。
7. 如果给了参考素材补充/硬性要求，必须遵守；没给就不要编造事实。

输出只有提示词正文，不要任何解释、不要 Markdown 代码围栏。"""


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


def masked_config(config: dict) -> dict:
    """返回给前端的配置：api_key 只给是否存在与后四位。"""
    result = dict(config)
    key = str(result.get("api_key") or "")
    result["api_key"] = ""
    result["api_key_set"] = bool(key)
    result["api_key_tail"] = key[-4:] if len(key) >= 8 else ""
    return result


def resolve_settings(config: dict | None = None) -> ProviderSettings:
    data = config if config is not None else load_config()
    provider = str(data.get("provider") or DEFAULT_PROVIDER)
    defaults = PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS[DEFAULT_PROVIDER])
    base_url = str(data.get("base_url") or defaults["base_url"])
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
    lines = [
        f"输出语言：{options.get('output_language') or '中文'}",
        f"生成类型：{options.get('task_type') or 'Ref2VA'}",
        f"镜头数量：{options.get('shot_count') or 'AUTO'}",
        f"目标时长（秒）：{options.get('duration_seconds') or 5}",
        f"改写模式：{options.get('rewrite_mode') or 'balanced'}",
        f"目标长度（0=自动）：{options.get('description_word_target') or 0}",
        f"提示词模式：{options.get('prompt_mode') or '官方增强'}",
    ]
    subjects = payload.get("subjects") or []
    if subjects:
        subject_lines = []
        for subject in subjects[:16]:
            subject_lines.append(
                f"- {subject.get('name')}: {subject.get('description') or subject.get('role') or ''}"
            )
        lines.append("可用主体（令牌里出现的名字必须在此表中）：\n" + "\n".join(subject_lines))
    reference_context = str(options.get("reference_context") or "").strip()
    if reference_context:
        lines.append("参考素材补充：" + reference_context)
    constraints = str(options.get("constraints") or "").strip()
    if constraints:
        lines.append("硬性要求：" + constraints)
    lines.append("用户片段（可能不规范，请改写成规范版本）：\n" + brief)
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

    try:
        prompt = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise PromptEnhancerError("API 返回结构异常（缺少 choices.message.content）") from error
    prompt = str(prompt or "").strip()
    if prompt.startswith("```"):
        prompt = prompt.strip("`")
        prompt = prompt.split("\n", 1)[-1] if "\n" in prompt else prompt
    if not prompt:
        raise PromptEnhancerError("API 返回空提示词")
    return {
        "prompt": prompt,
        "provider": settings.provider,
        "model": settings.model,
    }
