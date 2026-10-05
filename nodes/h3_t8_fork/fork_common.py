"""Deciia H3 T8 fork — 公共构件。

来源: comfyui-minimax-h3-audio-T8 (t8star) h3_t8/core.py、sampling.py、
motion_quality_advanced.py、patch_stack_policy.py，2026-10-04 摘取搬运。
仅改: 相对导入收拢为本模块内定义；warn_patch_stack 简化为纯日志。
算法本体未改动。发布说明见仓库 THIRD_PARTY_NOTICES.md。
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
from typing import Any

import torch

log = logging.getLogger(__name__)

TURBO_DUAL_CLOCK_TEST_STEPS = 8

_PROFILE_NFE = {
    "stock20": 20,
    "turbo_standard8": TURBO_DUAL_CLOCK_TEST_STEPS,
    "turbo_ema8": TURBO_DUAL_CLOCK_TEST_STEPS,
    "turbo_fl2v8": TURBO_DUAL_CLOCK_TEST_STEPS,
    "custom_strict": None,
}


def warn_patch_stack(message):
    """简化版: 仅打日志(原版还挂审计上下文, fork不需要)。"""
    log.warning("[Deciia H3 T8 fork 组合风险提示] %s; continuing.", message)


def nested_av_parts(av_latent: dict) -> tuple[torch.Tensor, torch.Tensor]:
    if not isinstance(av_latent, dict) or "samples" not in av_latent:
        raise ValueError("Expected a MiniMax H3 joint AV LATENT")
    samples = av_latent["samples"]
    if not getattr(samples, "is_nested", False):
        raise ValueError("Expected a nested MiniMax H3 joint video/audio latent")
    parts = tuple(samples.unbind())
    if len(parts) != 2:
        raise ValueError(f"Expected exactly two AV latent parts, got {len(parts)}")
    video, audio = parts
    if video.ndim != 5 or audio.ndim != 4:
        raise ValueError(
            "Unexpected MiniMax H3 AV latent layout: "
            f"video={tuple(video.shape)}, audio={tuple(audio.shape)}"
        )
    if video.shape[0] != 1 or audio.shape[0] != 1:
        raise ValueError("MiniMax H3 currently supports batch size 1 only")
    return video, audio



def split_noise_masks(av_latent: dict, video: torch.Tensor, audio: torch.Tensor):
    masks = av_latent.get("noise_mask")
    if masks is None:
        return None, None
    if getattr(masks, "is_nested", False):
        parts = tuple(masks.unbind())
        if len(parts) == 2:
            return parts
    # A legacy video-only mask must never be silently discarded.
    if isinstance(masks, torch.Tensor):
        return masks, None
    raise ValueError("Unsupported AV noise_mask layout")



def shift_sigma(base_sigma, shift: float):
    return shift * base_sigma / (1.0 + (shift - 1.0) * base_sigma)



def time_shift_sigma(sigma, from_shift: float, to_shift: float):
    base_sigma = sigma / (from_shift + sigma * (1.0 - from_shift))
    return shift_sigma(base_sigma, to_shift)



def _inverse_shift_sigma(sigmas: torch.Tensor, shift: float) -> torch.Tensor:
    if not math.isfinite(shift) or shift <= 0.0:
        raise ValueError("sigma shift must be finite and greater than zero")
    denominator = shift + sigmas * (1.0 - shift)
    if not bool(torch.all(denominator > 0.0)):
        raise ValueError("sigma shift produced an invalid base-flow denominator")
    base = sigmas / denominator
    if not bool(torch.isfinite(base).all()):
        raise ValueError("inverse sigma shift produced NaN or Inf")
    return base



def _schedule_sha(values: torch.Tensor) -> str:
    canonical = canonical_json([format(float(value), ".17g") for value in values])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()



def _validate_h3_sigmas(sigmas: torch.Tensor, profile: str) -> torch.Tensor:
    if not isinstance(sigmas, torch.Tensor):
        raise TypeError("sigmas must be a torch.Tensor")
    if sigmas.ndim != 1 or sigmas.numel() < 2:
        raise ValueError("H3 sigmas must be a one-dimensional tensor with at least two values")
    if not sigmas.dtype.is_floating_point:
        raise TypeError("H3 sigmas must use a floating-point dtype")

    values = sigmas.detach().to(device="cpu", dtype=torch.float64)
    if not bool(torch.isfinite(values).all()):
        raise ValueError("H3 sigmas contain NaN or Inf")
    if float(values.min()) < -1e-9 or float(values.max()) > 1.0 + 1e-9:
        raise ValueError("H3 Flow sigmas must stay inside the normalized [0, 1] range")
    if abs(float(values[-1])) > 1e-9:
        raise ValueError("H3 sigma schedule must end at exactly zero")
    if not bool(torch.all(values[:-1] > values[1:])):
        raise ValueError("H3 sigmas must be strictly descending with no duplicate steps")
    if profile not in _PROFILE_NFE:
        raise ValueError(f"unsupported H3 schedule profile: {profile!r}")

    expected_nfe = _PROFILE_NFE[profile]
    actual_nfe = int(values.numel() - 1)
    if expected_nfe is not None and actual_nfe != expected_nfe:
        raise ValueError(
            f"profile {profile!r} requires {expected_nfe} steps, got {actual_nfe}"
        )
    return values



def canonical_json(value: Any, *, indent: int | None = None) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        indent=indent,
        separators=None if indent is not None else (",", ":"),
        sort_keys=True,
    )



def decode_av_latent(av_latent: dict, video_vae, audio_vae, decode_video=True):
    """来源: h3_t8/audio_ops.py decode_av_latent；vae_decode_audio 改用 comfy 核心实现。

    decode_video=False（Deciia 2026-10-05）：跳过原生 VAE 像素解码，frames 出口
    返回空占位张量。供“AVDecode→VAEDecode(HyperVAE)”拓扑使用——像素由 HyperVAE
    链产出，原生解码的 2GB+ 帧张量纯属浪费且挤占内存峰值。
    """
    from comfy_extras.nodes_audio import vae_decode_audio
    video, audio = nested_av_parts(av_latent)
    if decode_video:
        images = video_vae.decode(video)
        if images.ndim == 5:
            images = images.reshape(-1, *images.shape[-3:])
    else:
        images = torch.empty((0, 8, 8, 3), dtype=torch.float32)
    decoded_audio = vae_decode_audio(audio_vae, {"samples": audio})
    video_latent = {key: value for key, value in av_latent.items() if key not in {"samples", "noise_mask"}}
    audio_latent = video_latent.copy()
    video_latent["samples"] = video
    audio_latent["samples"] = audio
    masks = av_latent.get("noise_mask")
    if getattr(masks, "is_nested", False):
        video_mask, audio_mask = masks.unbind()
        video_latent["noise_mask"] = video_mask
        audio_latent["noise_mask"] = audio_mask
    return images, decoded_audio, video_latent, audio_latent
