"""MiniMax H3 多速率采样（复制自 h3_t8/sampling_multirate_exp.py，改为吃外部 sigma 阶梯）。

与上游 EXP/T8 版本的差异只有一处：
- 上游在 setup 时按 video_steps/audio_steps 自己算 sigmas 与宏边界；
- 这里接受外部 sigmas（例如 Deciia 采样预设的 8 步阶梯），宏边界在采样开始时
  按 len(schedule)-1 与 video_steps 现推，因此任意阶梯都能配 video_steps=1
  （音频 8 次 DiT、视频只提交 1 次）。
"""
from __future__ import annotations

import math

import torch

import comfy.model_sampling
import comfy.samplers
import comfy.utils
from comfy.k_diffusion.sampling import to_d


class MiniMaxH3MultiRateFlowSampling(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
    @property
    def audio_scale(self):
        return 1.0


def nested_av_parts(av_latent: dict):
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
    return video, audio


def shift_sigma(base_sigma, shift: float):
    return shift * base_sigma / (1.0 + (shift - 1.0) * base_sigma)


def time_shift_sigma(sigma, from_shift: float, to_shift: float):
    base_sigma = sigma / (from_shift + sigma * (1.0 - from_shift))
    return shift_sigma(base_sigma, to_shift)


def time_shift_slope(sigma, from_shift: float, to_shift: float):
    base_sigma = sigma / (from_shift + sigma * (1.0 - from_shift))
    numerator = to_shift * (1.0 + (from_shift - 1.0) * base_sigma) ** 2
    denominator = from_shift * (1.0 + (to_shift - 1.0) * base_sigma) ** 2
    return numerator / denominator


def macro_indices_for(schedule_len: int, video_steps: int) -> tuple[int, ...]:
    """把外部阶梯切成 video_steps 个宏窗口（运行时推导，不绑定具体步数）。"""
    micro = int(schedule_len) - 1
    if micro < 1:
        raise ValueError("MiniMax H3 MultiRate needs at least one sigma step")
    video_steps = max(1, min(int(video_steps), micro))
    return tuple(round(i * micro / video_steps) for i in range(video_steps + 1))


def _audio_step_scale(sigma_video, sigma_audio, slope_audio, denoise_mask, audio_velocity_is_raw):
    flat_scale = -sigma_video
    dual_scale = -sigma_audio if audio_velocity_is_raw else -sigma_audio / slope_audio
    if denoise_mask is None:
        return dual_scale
    return flat_scale + denoise_mask * (dual_scale - flat_scale)


def _sample_multirate_euler(
    model, x, sigmas, extra_args=None, callback=None, disable=None,
    *, video_values: int, packed_values: int, shift_video: float, shift_audio: float,
    video_steps: int, audio_velocity_is_raw: bool = False,
):
    extra_args = {} if extra_args is None else extra_args
    if x.shape[-1] != packed_values:
        raise ValueError(
            "MiniMax H3 packed latent changed after MultiRate setup: "
            f"expected {packed_values} values, got {x.shape[-1]}"
        )
    macro_indices = macro_indices_for(len(sigmas), video_steps)
    denoise_mask = extra_args.get("denoise_mask")
    audio_mask = None
    if denoise_mask is not None:
        if denoise_mask.shape[-1] != packed_values:
            raise ValueError("MiniMax H3 denoise mask does not match the packed AV latent")
        audio_mask = denoise_mask[..., video_values:]

    video = x[..., :video_values]
    audio = x[..., video_values:]
    s_in = x.new_ones([x.shape[0]])
    progress = iter(comfy.utils.model_trange(len(sigmas) - 1, disable=disable))

    for macro in range(len(macro_indices) - 1):
        first_micro = macro_indices[macro]
        after_last_micro = macro_indices[macro + 1]
        sigma_macro_start = sigmas[first_micro]
        sigma_macro_end = sigmas[after_last_micro]
        video_start = video
        video_derivative = None

        for expected_step in range(first_micro, after_last_micro):
            step = next(progress)
            if step != expected_step:
                raise RuntimeError("MiniMax H3 MultiRate progress iterator returned an unexpected step")

            sigma_video = sigmas[step]
            sigma_video_next = sigmas[step + 1]
            if video_derivative is None:
                video_eval = video_start
            else:
                video_eval = video_start + video_derivative * (sigma_video - sigma_macro_start)

            x_eval = torch.cat((video_eval, audio), dim=-1)
            denoised = model(x_eval, sigma_video * s_in, **extra_args)
            derivative = to_d(x_eval, sigma_video, denoised)
            if video_derivative is None:
                video_derivative = derivative[..., :video_values]
            audio_derivative = derivative[..., video_values:]

            sigma_audio = time_shift_sigma(sigma_video, shift_video, shift_audio)
            sigma_audio_next = time_shift_sigma(sigma_video_next, shift_video, shift_audio)
            slope_audio = time_shift_slope(sigma_video, shift_video, shift_audio)
            video_delta = sigma_video_next - sigma_video
            audio_delta = sigma_audio_next - sigma_audio
            if not audio_velocity_is_raw:
                audio_delta = audio_delta / slope_audio
            if audio_mask is not None:
                audio_delta = video_delta + audio_mask * (audio_delta - video_delta)

            if callback is not None:
                video_endpoint = video_start - video_derivative * sigma_macro_start
                audio_endpoint_scale = _audio_step_scale(
                    sigma_video, sigma_audio, slope_audio, audio_mask, audio_velocity_is_raw,
                )
                audio_endpoint = audio + audio_derivative * audio_endpoint_scale
                callback({
                    "x": x_eval,
                    "i": step,
                    "sigma": sigma_video,
                    "sigma_hat": sigma_video,
                    "denoised": torch.cat((video_endpoint, audio_endpoint), dim=-1),
                })

            audio = audio + audio_derivative * audio_delta

        video = video_start + video_derivative * (sigma_macro_end - sigma_macro_start)

    return torch.cat((video, audio), dim=-1)


def _sigma_values(sigmas) -> list[float]:
    values: list[float] = []
    if isinstance(sigmas, torch.Tensor):
        return [float(v) for v in sigmas.flatten().tolist()]
    for item in sigmas:
        if isinstance(item, torch.Tensor):
            values.append(float(item.reshape(-1)[0]))
        else:
            values.append(float(item))
    return values


def _model_shifts(model) -> tuple[float, float]:
    """偏移值来自模型层（项目侧统一施加），节点本身不提供偏移设置。"""
    options = getattr(getattr(model, "model_options", None), "get", None)
    transformer_options = (options.get("transformer_options", {}) if callable(options) else {}) or {}
    try:
        shift_video = float(transformer_options.get("minimax_h3_sigma_shift_video", 12.0))
    except (TypeError, ValueError):
        shift_video = 12.0
    try:
        shift_audio = float(transformer_options.get("minimax_h3_sigma_shift_audio", 3.0))
    except (TypeError, ValueError):
        shift_audio = 3.0
    return shift_video, shift_audio


def build_multirate_sampling(
    model,
    av_latent: dict,
    sigmas,
    video_steps: int = 1,
):
    """只约束「视频提交 video_steps 次」；采样器设置与偏移都不在本节点内。

    返回 (model, sampler, sigmas)：
    - model 原样返回（不克隆、不改 shift），偏移仍由项目/模型层负责；
    - sigmas 原样返回（不做 shift_sigma），阶梯完全来自采样方案或外接预设；
    - sampler 仅改变“视频提交节奏”：音频每步更新，视频只在宏步提交。
    """
    video, audio = nested_av_parts(av_latent)
    if video.shape[1] != 24 or audio.shape[1] != 32 or audio.shape[2] != 2:
        raise ValueError(
            "Unexpected MiniMax H3 AV channels: "
            f"video={tuple(video.shape)}, audio={tuple(audio.shape)}"
        )

    sigmas_tensor = torch.tensor(_sigma_values(sigmas), dtype=torch.float32)
    shift_video, shift_audio = _model_shifts(model)
    audio_velocity_is_raw = callable(getattr(getattr(model, "model", None), "audio_scale", None))

    video_values = math.prod(video.shape[1:])
    packed_values = video_values + math.prod(audio.shape[1:])

    def sampler_function(model_wrap, x, schedule, extra_args=None, callback=None, disable=None):
        return _sample_multirate_euler(
            model_wrap, x, schedule,
            extra_args=extra_args, callback=callback, disable=disable,
            video_values=video_values, packed_values=packed_values,
            shift_video=shift_video, shift_audio=shift_audio,
            video_steps=int(video_steps), audio_velocity_is_raw=audio_velocity_is_raw,
        )

    sampler_function.__name__ = "sample_minimax_h3_multirate_audio_first"
    sampler = comfy.samplers.KSAMPLER(sampler_function)
    return model, sampler, sigmas_tensor
