"""视觉读图：用支持图像的配置档描述/核对图片（与对话模型解耦）。"""
from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path

from .prompt_enhancer import (
    PROVIDER_DEFAULTS,
    PromptEnhancerError,
    load_config,
    normalize_endpoint,
    normalize_profiles,
)

MAX_BYTES = 8 * 1024 * 1024
MAX_IMAGES = 6

VISION_SYSTEM = (
    "你是画面审片员。用户会给你若干张图片（可能带文件名），请只描述你真实看到的内容，"
    "不要根据文件名猜测。输出要点式中文：\n"
    "1) 画面主体与数量（几个、什么、朝向）\n"
    "2) 构图与机位（景别、视角、主体位置）\n"
    "3) 关键物件与状态（工具/零件/车辆位置是否合理）\n"
    "4) 明显错误（穿帮、比例失调、悬浮、重复、文字水印）\n"
    "5) 与本段提示词是否相符（若不提供提示词则写：未提供）\n"
    "看不清就写看不清，禁止编造。"
)


def _vision_candidates(config: dict | None = None) -> list[dict]:
    """按优先级挑出支持图像的配置档：先支持图像的自定义档，再环境变量里的多模态 provider。"""
    data = config if config is not None else load_config()
    profiles, active = normalize_profiles(data)
    # 当前对话模型优先（用户确认 deepseek-flash 可直接读图）；不行再回退到其它支持图像的档
    ordered = sorted(
        profiles,
        key=lambda item: (0 if item.get("id") == active else 1, 0 if item.get("supports_image") else 2),
    )
    candidates = [
        {
            "provider": item["provider"],
            "model": item["model"],
            "base_url": normalize_endpoint(item["provider"], item["base_url"]),
            "api_key": item["api_key"],
            "label": (item.get("name") or item["provider"]) + ("" if item.get("id") == active else "（备用）"),
        }
        for item in ordered
        if item.get("api_key")
    ]
    if candidates:
        return candidates
    # 没有 image 档时，尝试内置多模态 provider + 环境变量 key
    import os

    for provider, defaults in PROVIDER_DEFAULTS.items():
        if not defaults.get("supports_image"):
            continue
        env_name = {
            "glm": "GLM_API_KEY",
            "minimax-cn": "MINIMAX_CN_API_KEY",
            "ark": "VOLCENGINE_API_KEY",
        }.get(provider)
        key = os.environ.get(env_name, "") if env_name else ""
        if key:
            candidates.append(
                {
                    "provider": provider,
                    "model": defaults["model"],
                    "base_url": normalize_endpoint(provider, defaults["base_url"]),
                    "api_key": key,
                    "label": f"{provider}（环境变量）",
                }
            )
    return candidates


def _data_uri(path: Path) -> str:
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        raise PromptEnhancerError(f"图片过大（>{MAX_BYTES // 1024 // 1024}MB）：{path.name}")
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


async def describe_images(paths: list[Path], question: str = "", prompt_hint: str = "") -> dict:
    """把图片交给多模态模型，返回文字描述。"""
    if not paths:
        raise PromptEnhancerError("没有可读的图片")
    if len(paths) > MAX_IMAGES:
        paths = paths[:MAX_IMAGES]
    candidates = _vision_candidates()
    if not candidates:
        raise PromptEnhancerError(
            "没有可用的视觉模型：请在 导演台设置 → API 新增一套「支持图像」的配置（如 GLM-4.5V / MiniMax-M3），"
            "或设置环境变量 GLM_API_KEY / MINIMAX_CN_API_KEY。当前对话模型不支持读图。"
        )

    text_parts = [VISION_SYSTEM, ""]
    if question.strip():
        text_parts.append(f"我的问题：{question.strip()}")
    if prompt_hint.strip():
        text_parts.append(f"对应提示词（用于核对是否相符）：{prompt_hint.strip()[:1200]}")
    text_parts.append("图片顺序与文件名：" + "、".join(path.name for path in paths))
    content: list[dict] = [{"type": "text", "text": "\n".join(text_parts)}]
    for path in paths:
        content.append({"type": "image_url", "image_url": {"url": _data_uri(path)}})

    import aiohttp

    errors: list[str] = []
    for candidate in candidates:
        body = {
            "model": candidate["model"],
            "messages": [
                {"role": "system", "content": VISION_SYSTEM},
                {"role": "user", "content": content},
            ],
            "temperature": 0.2,
            "stream": False,
        }
        headers = {"Authorization": f"Bearer {candidate['api_key']}", "Content-Type": "application/json"}
        try:
            timeout = aiohttp.ClientTimeout(total=180)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(candidate["base_url"], json=body, headers=headers) as response:
                    raw = await response.text()
                    if response.status >= 400:
                        errors.append(f"{candidate['label']}: HTTP {response.status} {raw[:160]}")
                        continue
                    data = json.loads(raw)
            message = ((data.get("choices") or [{}])[0].get("message") or {})
            text = message.get("content")
            if isinstance(text, list):
                text = "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in text)
            text = str(text or "").strip()
            if not text:
                errors.append(f"{candidate['label']}: 返回空内容")
                continue
            return {"text": text, "provider": candidate["provider"], "model": candidate["model"], "label": candidate["label"]}
        except Exception as error:  # noqa: BLE001
            errors.append(f"{candidate['label']}: {error}")
    raise PromptEnhancerError("视觉模型全部失败：\n" + "\n".join(errors[:4]))
