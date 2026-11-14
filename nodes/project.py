from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

import folder_paths
import nodes as comfy_nodes
from comfy_api.latest import InputImpl, io
from comfy_execution.graph_utils import ExecutionBlocker, GraphBuilder, is_link
from comfy.utils import ProgressBar

from ..utils import instrument_node_timing, log_node_info
from ..utils.h3_presets import get_h3_preset_keys, load_h3_presets, select_h3_preset
from ..utils.h3_project import (
    clear_h3_project_segments_from,
    compose_h3_project_audio,
    compose_h3_project_images,
    compose_h3_project_video,
    load_h3_project_data,
    h3_active_segment_is_passthrough,
    h3_generation_mode,
    h3_locked_audio_track,
    h3_locked_video_track,
    minimax_frame_count,
    h3_project_filename_prefix,
    h3_second_pass_dimensions,
    h3_camera_prompt_for_range,
    inject_h3_camera_prompt,
    has_h3_context_latent,
    has_h3_first_pass_checkpoint,
    h3_task_entries,
    h3_task_is_passthrough,
    h3_task_type,
    initialize_h3_project,
    parse_tracks_info,
    crop_multitrack_project_media,
    prepare_multitrack_project_media,
    prepare_multitrack_project_task_info,
    safe_h3_project_name,
    select_h3_task_entries,
    validate_h3_project_outputs,
)
from ..utils.h3_timeline import load_timeline
from ..utils.models import detect_turbo_lora_from_prompt, detect_turbo_model
from ..utils.project_memory import (
    BOUNDARY_META,
    SEGMENT_META,
    install_project_memory_cleanup,
)
from ..utils.multitrack import (
    MULTITRACK_RUNTIME_CACHE_KEY,
    multitrack_runtime_cache,
)


TYPE_FAST_MODEL_LOADER = io.Custom(io_type="FAST_MODEL_LOADER")
TYPE_TRACKS_INFO = io.Custom(io_type="TRACKS_INFO")
TYPE_EASY_MEDIA = io.Custom(io_type="EASY_MEDIA")
TYPE_PROJECT_DATA = io.Custom(io_type="PROJECT_DATA")
TYPE_H3_PROJECT_STATIC_DATA = io.Custom(io_type="H3_PROJECT_STATIC_DATA")
H3_CONTEXT_CONTINUITY_MODES = {"context", "context_drift", "context_swap"}
H3_CONTEXT_SOURCE_FRAMES = 22


def _first_input(value: Any, default: Any = None) -> Any:
    if isinstance(value, (list, tuple)):
        return value[0] if value else default
    return value if value is not None else default


def _raw_project_input(value: Any) -> Any:
    """Unwrap list inputs without splitting a raw graph link."""
    if is_link(value):
        return value
    if isinstance(value, (list, tuple)) and len(value) == 1 and is_link(value[0]):
        return value[0]
    return _first_input(value)


def _hidden_project_input_link(hidden_inputs: Any, name: str) -> Any | None:
    """Recover the original prompt link after an input was materialized."""
    prompt = _first_input(getattr(hidden_inputs, "prompt", None))
    unique_id = str(_first_input(getattr(hidden_inputs, "unique_id", None), ""))
    if not isinstance(prompt, dict) or not unique_id:
        return None
    node = prompt.get(unique_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return None
    value = inputs.get(name)
    return value if is_link(value) else None


def _require_minimax_h3_model(model: Any) -> None:
    """Reject project expansion for models other than ComfyUI's MiniMaxH3."""
    base_model = getattr(model, "model", None)
    model_config = getattr(base_model, "model_config", None)
    config_name = type(model_config).__name__ if model_config is not None else "unknown"
    unet_config = getattr(model_config, "unet_config", None)
    image_model = (
        unet_config.get("image_model")
        if isinstance(unet_config, dict)
        else None
    )
    if config_name != "MiniMaxH3" and image_model != "minimax_h3":
        raise ValueError(
            "easy multitrackProject currently supports only MiniMaxH3 models; "
            f"received {config_name}."
        )


def _h3_node_mapping(node_id: str) -> Any | None:
    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    return mappings.get(node_id) if isinstance(mappings, dict) else None


def _h3_required_node_defaults(node_id: str) -> dict[str, Any]:
    node_class = _h3_node_mapping(node_id)
    if node_class is None:
        return {}
    input_types = getattr(node_class, "INPUT_TYPES", None)
    if not callable(input_types):
        return {}
    try:
        schema = input_types()
    except (AttributeError, RuntimeError, TypeError) as error:
        raise RuntimeError(f"Unable to inspect {node_id} inputs: {error}") from error
    required = schema.get("required", {}) if isinstance(schema, dict) else {}
    defaults: dict[str, Any] = {}
    for name, specification in required.items():
        if (
            isinstance(specification, (list, tuple))
            and len(specification) > 1
            and isinstance(specification[1], dict)
            and "default" in specification[1]
        ):
            default = specification[1]["default"]
            options = specification[0]
            if (
                isinstance(options, (list, tuple))
                and options
                and default not in options
            ):
                # 2026-11-14：部分第三方节点把下拉项的默认值写成非字符串
                # （KJNodes 的 ImageResizeKJv2 就把 keep_proportion 默认写成
                # False），子图里直接透传会让节点拿到 bool 当字符串用，
                # 报 'bool' object has no attribute 'startswith'。
                # 遇到非法默认值时退回第一个合法选项。
                default = options[0]
            defaults[name] = default
        elif (
            isinstance(specification, (list, tuple))
            and specification
            and isinstance(specification[0], (list, tuple))
            and specification[0]
        ):
            defaults[name] = specification[0][0]
    return defaults


def _h3_image_resize_inputs(
    image: Any, width: int, height: int
) -> dict[str, Any]:
    node_class = _h3_node_mapping("ImageResizeKJv2")
    if node_class is None:
        raise RuntimeError(
            "Dual H3 sampling without a latent upscale model requires "
            "ImageResizeKJv2 from ComfyUI-KJNodes."
        )
    input_types = getattr(node_class, "INPUT_TYPES", None)
    schema = input_types() if callable(input_types) else {}
    required = schema.get("required", {}) if isinstance(schema, dict) else {}
    method_spec = required.get("upscale_method")
    methods = method_spec[0] if isinstance(method_spec, (list, tuple)) else []
    if "nvidia_rtx_vsr" not in methods:
        raise RuntimeError(
            "The installed ImageResizeKJv2 does not support the required "
            "nvidia_rtx_vsr upscale method."
        )
    inputs = _h3_required_node_defaults("ImageResizeKJv2")
    inputs.update(
        {
            "image": image,
            "width": width,
            "height": height,
            "upscale_method": "nvidia_rtx_vsr",
            # 与 KJNodes 原意一致：只缩放、不变形不改比例。
            "keep_proportion": "stretch",
        }
    )
    return inputs


def _h3_latent_upscale_inputs(
    latent: Any,
    model_name: str,
    width: int,
    height: int,
) -> dict[str, Any]:
    return {
        "latent": latent,
        "model_name": model_name,
        "mode": "target dimensions",
        "mode.width": width,
        "mode.height": height,
        "align": 32,
        "enable_temporal_chunking": True,
        "force_unload": True,
    }


def _h3_encode_context_media(
    graph: GraphBuilder,
    images: Any,
    audio: Any,
    vae: Any,
    audio_vae: Any,
    node_prefix: str,
    context_frames: int = 22,
) -> Any:
    """Encode a phase-aligned video suffix and the delivered audio timeline."""
    video_tail = graph.node(
        "easy h3ContextMediaTrim",
        id=f"{node_prefix}_encode_trim",
        images=images,
        audio=audio,
        trim_frames=0,
        output_frames=int(context_frames),
        phase_align_video_encode=True,
    )
    encoded_video = graph.node(
        "VAEEncode",
        id=f"{node_prefix}_video_encode",
        pixels=video_tail.out(0),
        vae=vae,
    )
    encoded_audio = graph.node(
        "VAEEncodeAudio",
        id=f"{node_prefix}_audio_encode",
        audio=video_tail.out(1),
        vae=audio_vae,
    )
    return graph.node(
        "LTXVConcatAVLatent",
        id=f"{node_prefix}_concat",
        video_latent=encoded_video.out(0),
        audio_latent=encoded_audio.out(0),
    ).out(0)


def _h3_encode_audio_context(
    graph: GraphBuilder,
    audio: Any,
    audio_vae: Any,
    trim_frames: Any,
    output_frames: Any,
    fps: float,
    pad_audio: bool,
    prefix: str,
) -> tuple[Any, Any]:
    """Trim and encode an audio-only context without touching the video VAE."""
    trimmed = graph.node(
        "easy h3ContextMediaTrim",
        id=f"{prefix}_trim",
        audio=audio,
        trim_frames=trim_frames,
        output_frames=output_frames,
        fps=fps,
        pad_audio=pad_audio,
    ).out(1)
    encoded = graph.node(
        "VAEEncodeAudio", id=f"{prefix}_encode", audio=trimmed, vae=audio_vae,
    ).out(0)
    context = graph.node(
        "easy h3AudioContextLatent", id=f"{prefix}_latent",
        audio_latent=encoded, output_frames=output_frames,
    ).out(0)
    return trimmed, context

def _timed_h3_project_graph(
    graph: GraphBuilder,
    project_name: str,
    segment_nodes: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Tag timing and segment cache lifetimes without changing node inputs."""
    expanded = graph.finalize()
    timed_types = {
        "SamplerCustomAdvanced",
        "easy h3SamplingPreviewSampler",
        "VAEEncode",
        "VAEEncodeAudio",
        "VAEDecode",
        "VAEDecodeAudio",
    }
    persistent_media_types = {
        "easy h3ProjectStaticPrepare",
        "easy multiTrackTaskOutput",
    }
    for node_id, node in expanded.items():
        if (
            segment_nodes is not None
            and node_id in segment_nodes
            and node["class_type"] not in persistent_media_types
        ):
            node.setdefault("_meta", {})[SEGMENT_META] = segment_nodes[node_id]
            if node["class_type"] == "easy h3ProjectArtifact":
                node["_meta"][BOUNDARY_META] = True
        if node["class_type"] not in timed_types:
            continue
        target = _h3_node_mapping(node["class_type"])
        if target is not None:
            instrument_node_timing(target)
        operation = node_id.rsplit(".", 1)[-1]
        node.setdefault("_meta", {})["easy_media_timing"] = f"{project_name} / {operation}"
    if segment_nodes:
        install_project_memory_cleanup()
    return expanded

def _h3_resolve_pass_sampling(
    graph: GraphBuilder,
    *,
    pass_name: str,
    sampler: Any,
    sigmas: Any,
    preset_name: str,
    has_second_pass: bool,
    is_turbo: bool,
) -> tuple[Any, Any]:
    if preset_name == "custom" or sampler is not None or sigmas is not None:
        if sampler is None or sigmas is None:
            raise ValueError(
                f"Custom H3 {pass_name.replace('_', ' ')} sampling requires "
                "both sampler and sigmas."
            )
        return sampler, sigmas

    preset = select_h3_preset(
        load_h3_presets(),
        preset_name,
        "dual" if has_second_pass else "single",
        is_turbo,
    )
    sampler_key = "sampler_2nd" if pass_name == "second_pass" else "sampler"
    sigmas_key = "sigmas_2nd" if pass_name == "second_pass" else "sigmas"
    sampler = graph.node(
        "KSamplerSelect",
        id=f"{pass_name}_sampler",
        sampler_name=preset.get(sampler_key, preset["sampler"]),
    ).out(0)
    sigma_node = graph.node(
        "ManualSigmas",
        id=f"{pass_name}_sigmas",
        sigmas=preset.get(sigmas_key, preset["sigmas"]),
    )
    sigmas = sigma_node.out(0)
    if has_second_pass and "split_step" in preset:
        split = graph.node(
            "SplitSigmas",
            id=f"{pass_name}_split_sigmas",
            sigmas=sigmas,
            step=int(preset["split_step"]),
        )
        sigmas = split.out(1 if pass_name == "second_pass" else 0)
    return sampler, sigmas


def _h3_resolve_context_second_pass_sigmas(
    graph: GraphBuilder,
    *,
    preset_name: str,
    is_turbo: bool,
    has_custom_second_pass_sampling: bool,
) -> Any | None:
    """Build the preset-only sigma schedule used by context pass two."""
    if has_custom_second_pass_sampling or preset_name == "custom":
        return None
    preset = select_h3_preset(
        load_h3_presets(),
        preset_name,
        "dual",
        is_turbo,
    )
    context_sigmas = preset.get("sigmas_2nd_context")
    if context_sigmas is None:
        return None
    return graph.node(
        "ManualSigmas",
        id="second_pass_context_sigmas",
        sigmas=context_sigmas,
    ).out(0)


def _h3_project_kind(project_name: Any) -> str:
    """从项目 timeline.json 读取项目类型，读不到按 video 处理。"""
    try:
        timeline = load_timeline(project_name)
    except Exception:
        return "video"
    kind = str(timeline.get("project_kind") or "video").strip().lower()
    return kind if kind in {"video", "audio", "image"} else "video"


_H3_SAMPLING_MODE_FOLLOW = "跟随节点"

# 2026-11-14：图片任务（image_first）帧数档位。H3 原生帧数是 17n+5 的网格点。
_IMAGE_FRAME_TIER_FOLLOW = "跟随上游"
_IMAGE_FRAME_TIER_FRAMES = {"1 帧": 1, "5 帧": 5, "22 帧": 22, "124 帧": 124}
_IMAGE_FRAME_TIERS = (_IMAGE_FRAME_TIER_FOLLOW, *tuple(_IMAGE_FRAME_TIER_FRAMES))
_H3_SAMPLING_MODE_CHOICES = (
    _H3_SAMPLING_MODE_FOLLOW,
    "single",
    "dual",
    "dual_t8",
    "selflift",
    "passthrough",
    "audio_first",
    "image_first",
)


def _h3_sampling_mode_config(value: Any) -> tuple[str, dict[str, Any]]:
    """Normalize the DynamicCombo value and accept a plain legacy mode value."""
    config = _first_input(value)
    if config is None:
        return "single", {}
    if isinstance(config, str):
        config = {"sampling_mode": config}
    if not isinstance(config, dict):
        raise TypeError("sampling_mode must be a DynamicCombo configuration dictionary.")

    sampling_mode = str(_first_input(config.get("sampling_mode"), "single"))
    # Keep workflows saved with the original mode name loadable.
    if sampling_mode == "dual_selflift":
        sampling_mode = "selflift"
    if sampling_mode not in {
        "single", "dual", "dual_t8", "selflift", "passthrough", "audio_first",
        "image_first",
    }:
        raise ValueError(
            "sampling_mode must be 'single', 'dual', 'dual_t8', 'selflift', "
            "'passthrough', or 'audio_first'"
        )
    return sampling_mode, config


def _h3_tiling_config(value: Any) -> tuple[bool, int]:
    config = _first_input(value)
    if config is None:
        return False, 0
    if isinstance(config, bool):
        return config, 2
    if isinstance(config, str):
        enabled = config.lower() == "true"
        return enabled, 2 if enabled else 0
    if not isinstance(config, dict):
        raise TypeError("enabled_tiling must be a DynamicCombo configuration dictionary")
    enabled = str(_first_input(config.get("enabled_tiling"), "false")).lower() == "true"
    if not enabled:
        return False, 0
    tile_count = int(_first_input(config.get("tile_count"), 2))
    if not 2 <= tile_count <= 8:
        raise ValueError("tile_count must be between 2 and 8")
    return True, tile_count


def _h3_resolve_selflift_sigmas(
    graph: GraphBuilder,
    *,
    sigmas: Any,
    preset_name: str,
    is_turbo: bool,
) -> Any:
    """Resolve one complete schedule for the progressive SelfLift sampler."""
    if sigmas is not None:
        return sigmas
    if preset_name == "custom":
        raise ValueError(
            "selflift with the custom sampling plan requires sigmas; "
            "the sampler itself is always Euler"
        )
    preset = select_h3_preset(
        load_h3_presets(),
        preset_name,
        "single",
        is_turbo,
    )
    return graph.node(
        "ManualSigmas",
        id="selflift_sigmas",
        sigmas=preset["sigmas"],
    ).out(0)


def _h3_apply_shift_override(
    graph: GraphBuilder,
    model: Any,
    *,
    node_id: str,
    shift_video: float,
    shift_audio: float,
) -> Any:
    """在模型层统一施加 H3 视频/音频 sigma 偏移（2026-10-13）。

    等价于核心节点 MiniMaxH3SigmaShift：patch model_sampling（shift / audio_shift）
    并把同一对偏移经 transformer_options 交给 DiT，因此挂在这个模型上的任何采样器
    都会继承它。每个项目只插一次（切勿放进段循环，否则每段都会多克隆一次模型）。
    """
    if model is None:
        return None
    return graph.node(
        "MiniMaxH3SigmaShift",
        id=node_id,
        model=model,
        shift_video=float(shift_video),
        shift_audio=float(shift_audio),
    ).out(0)


def _h3_second_pass_model(
    value: Any,
    *,
    model: Any,
) -> Any:
    """Resolve the optional second-pass model while preserving latent compatibility."""
    model_loader = _first_input(value)
    if model_loader is None:
        return model
    if not isinstance(model_loader, dict):
        raise TypeError("model_loader_2nd must contain a FAST_MODEL_LOADER dictionary.")

    second_model = model_loader.get("model")
    if second_model is None:
        raise ValueError("model_loader_2nd is missing required component: model")
    return second_model


class EasyH3SamplingPreviewSampler(io.ComfyNode):
    """SamplerCustomAdvanced with an optional preview-VAE event callback."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy h3SamplingPreviewSampler",
            display_name="H3 Sampling Preview Sampler",
            category="EasyUse/H3/dev",
            inputs=[
                io.Noise.Input("noise"),
                io.Guider.Input("guider"),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                io.Latent.Input("latent_image"),
                io.Boolean.Input("enabled_tiling", default=False, optional=True),
                io.Int.Input(
                    "tile_count",
                    default=2,
                    min=2,
                    max=8,
                    step=1,
                    optional=True,
                ),
                io.Vae.Input("preview_vae", optional=True),
                io.String.Input("preview_node_id", default="", optional=True),
                io.Int.Input(
                    "generated_frame_count", default=1, min=1, optional=True
                ),
                io.Float.Input("preview_fps", default=24.0, min=0.01, optional=True),
                io.Int.Input("segment_index", default=0, min=0, optional=True),
                io.String.Input("sampling_pass", default="sampling", optional=True),
            ],
            outputs=[
                io.Latent.Output(display_name="output"),
                io.Latent.Output(display_name="denoised_output"),
            ],
            is_dev_only=True,
        )

    @classmethod
    def execute(
        cls,
        noise: Any,
        guider: Any,
        sampler: Any,
        sigmas: Any,
        latent_image: dict[str, Any],
        enabled_tiling: bool = False,
        tile_count: int = 2,
        preview_vae: Any | None = None,
        preview_node_id: str = "",
        generated_frame_count: int = 1,
        preview_fps: float = 24.0,
        segment_index: int = 0,
        sampling_pass: str = "sampling",
    ) -> io.NodeOutput:
        import comfy.model_management
        import comfy.nested_tensor
        import comfy.sample
        import comfy.utils
        import latent_preview

        from ..utils.sampling_preview import (
            create_preview_callback,
            preview_frame_count,
            preview_playback_fps,
        )

        latent = latent_image.copy()
        samples = comfy.sample.fix_empty_latent_channels(
            guider.model_patcher,
            latent["samples"],
            latent.get("downscale_ratio_spacial"),
            latent.get("downscale_ratio_temporal"),
        )
        latent["samples"] = samples
        sampling_guider = guider
        if enabled_tiling:
            streams = (
                list(samples.unbind())
                if getattr(samples, "is_nested", False)
                else [samples]
            )
            from ..modules.selflift.h3_tiling import tiled_model

            patched_model = tiled_model(
                guider.model_patcher,
                [tuple(stream.shape) for stream in streams],
                tile_count=int(tile_count),
            )
            sampling_guider = copy.copy(guider)
            sampling_guider.model_patcher = patched_model
            sampling_guider.model_options = patched_model.model_options

        noise_mask = latent.get("noise_mask")
        x0_output: dict[str, Any] = {}
        if preview_vae is not None and preview_node_id:
            preview_callback = create_preview_callback(
                sampling_guider.model_patcher,
                preview_vae,
                node_id=preview_node_id,
                requested_frames=preview_frame_count(generated_frame_count),
                fps=preview_playback_fps(generated_frame_count, preview_fps),
                segment_index=int(segment_index),
                sampling_pass=sampling_pass,
            )
            progress = comfy.utils.ProgressBar(int(sigmas.shape[-1]) - 1)

            def callback(step: int, x0: Any, state: Any, total: int) -> None:
                x0_output["x0"] = x0
                preview_callback(step, x0, state, total)
                progress.update_absolute(step + 1, total)
        else:
            callback = latent_preview.prepare_callback(
                sampling_guider.model_patcher,
                int(sigmas.shape[-1]) - 1,
                x0_output,
            )

        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
        sampled = sampling_guider.sample(
            noise.generate_noise(latent),
            samples,
            sampler,
            sigmas,
            denoise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=noise.seed,
        ).to(comfy.model_management.intermediate_device())

        output = latent.copy()
        output.pop("downscale_ratio_spacial", None)
        output.pop("downscale_ratio_temporal", None)
        output["samples"] = sampled
        if "x0" not in x0_output:
            return io.NodeOutput(output, output)

        denoised = x0_output["x0"]
        if getattr(sampled, "is_nested", False) and not getattr(
            denoised, "is_nested", False
        ):
            latent_shapes = [tensor.shape for tensor in sampled.unbind()]
            denoised = comfy.nested_tensor.NestedTensor(
                comfy.utils.unpack_latents(denoised, latent_shapes)
            )
        denoised = sampling_guider.model_patcher.model.process_latent_out(
            denoised.cpu()
        )
        denoised_output = latent.copy()
        denoised_output["samples"] = denoised
        return io.NodeOutput(output, denoised_output)



class EasyH3ProjectStaticPrepare(io.ComfyNode):
    """Resolve seed-independent model, media, and sampling resources."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy h3ProjectStaticPrepare",
            display_name="H3 Project Static Prepare",
            category="EasyUse/H3/dev",
            is_dev_only=True,
            enable_expand=True,
            inputs=[
                TYPE_FAST_MODEL_LOADER.Input("model_loader", optional=True),
                TYPE_FAST_MODEL_LOADER.Input("model_loader_2nd", optional=True),
                TYPE_TRACKS_INFO.Input("tracks_info", optional=True),
                TYPE_H3_PROJECT_STATIC_DATA.Input("project_static", optional=True),
                io.AnyType.Input(
                    "previous",
                    optional=True,
                    tooltip="Optional dependency on the previous saved segment.",
                ),
                io.Int.Input("task_start_frame", default=0, min=0, optional=True),
                io.Int.Input("task_index", default=0, min=0, optional=True),
                io.Int.Input("task_duration_frames", default=1, min=1, optional=True),
                io.Float.Input("fps", default=24.0, min=0.001, optional=True),
                io.Combo.Input("generation_mode", options=["reference", "multi_frames", "last_frame"], default="multi_frames", optional=True),
                io.String.Input("sampling_plan", default="light", optional=True),
                io.Combo.Input("sampling_mode", options=["single", "dual", "dual_t8", "selflift", "passthrough", "audio_first", "image_first"], default="single", optional=True,
                    tooltip="dual_t8: LBH双钟双采(T8 fork)。需要双钟调度+学习放大+Reconcile+DetailMixer时使用; 不接LoRA/滑条照常工作。audio_first: 有声剧模式，极小占位画面、只解码音频。"),
                io.Sampler.Input("sampler", optional=True, raw_link=True),
                io.Sigmas.Input("sigmas", optional=True, raw_link=True),
                io.Sampler.Input("sampler_2nd", optional=True, raw_link=True),
                io.Sigmas.Input("sigmas_2nd", optional=True, raw_link=True),
                io.Boolean.Input("run_second_pass", default=False, optional=True),
                io.Boolean.Input("has_context_second_pass", default=False, optional=True),
                io.Boolean.Input("turbo_hint", default=False, optional=True),
            ],
            outputs=[
                TYPE_H3_PROJECT_STATIC_DATA.Output("PROJECT_STATIC"),
                TYPE_TRACKS_INFO.Output("TASK_TRACKS_INFO"),
                io.Model.Output("MODEL"), io.Model.Output("MODEL_2ND"),
                io.Clip.Output("CLIP"), io.Vae.Output("VAE"),
                io.Vae.Output("AUDIO_VAE"), io.Vae.Output("PREVIEW_VAE"),
                io.Audio.Output("LOCKED_AUDIO"),
                io.Sampler.Output("SAMPLER"), io.Sigmas.Output("SIGMAS"),
                io.Sampler.Output("SAMPLER_2ND"), io.Sigmas.Output("SIGMAS_2ND"),
                io.Sigmas.Output("CONTEXT_SIGMAS_2ND"),
            ],
        )

    @classmethod
    def execute(
        cls,
        model_loader: Any | None = None,
        model_loader_2nd: Any | None = None,
        tracks_info: Any | None = None,
        project_static: Any | None = None,
        previous: Any | None = None,
        task_start_frame: int = 0,
        task_index: int = 0,
        task_duration_frames: int = 1,
        fps: float = 24.0,
        generation_mode: str = "multi_frames",
        sampling_plan: str = "light",
        sampling_mode: str = "single",
        sampler: Any | None = None,
        sigmas: Any | None = None,
        sampler_2nd: Any | None = None,
        sigmas_2nd: Any | None = None,
        semantic_bridge: Any | None = None,
        output_vae: Any | None = None,
        run_second_pass: bool = False,
        has_context_second_pass: bool = False,
        turbo_hint: bool = False,
    ) -> io.NodeOutput:
        del previous
        try:
            if project_static is not None:
                if not isinstance(project_static, dict):
                    raise TypeError("project_static must contain H3 project static data")
                segment_cache = project_static.get("_segment_cache")
                segment_cache_key = (
                    "h3_project_segment",
                    int(task_start_frame),
                    int(task_index),
                    int(task_duration_frames),
                    float(fps),
                    str(generation_mode),
                )
                cached_segment = (
                    segment_cache.get(segment_cache_key)
                    if isinstance(segment_cache, dict)
                    else None
                )
                if (
                    isinstance(cached_segment, tuple)
                    and len(cached_segment) == 2
                ):
                    cached_task_info = cached_segment[0]
                    cached_task_info["_easy_media_cache_status"] = {
                        **project_static.get("_cache_status", {}),
                        "segment_media": "命中恢复缓存",
                    }
                    return io.NodeOutput(
                        project_static,
                        cached_task_info,
                        None, None, None, None, None, None,
                        cached_segment[1],
                        None, None, None, None, None,
                    )
                task_audio, task_video, task_locked_audio = crop_multitrack_project_media(
                    project_static["shared_audio"], project_static["shared_video"],
                    project_static["full_locked_audio"], int(task_start_frame),
                    int(task_duration_frames), float(fps),
                )
                task_info = prepare_multitrack_project_task_info(
                    project_static["task_tracks_info_base"], project_static["shared_images"],
                    task_audio if generation_mode == "reference" else [],
                    task_video if generation_mode == "reference" else [],
                    task_entry=next(
                        (entry for index, entry in enumerate(h3_task_entries(project_static["task_tracks_info_base"]))
                         if index == int(task_index)),
                        None,
                    ),
                )
                multitrack_runtime_cache(task_info, create=True)
                task_info["_easy_media_cache_status"] = {
                    **project_static.get("_cache_status", {}),
                    "segment_media": "首次加载",
                }
                if isinstance(segment_cache, dict):
                    segment_cache[segment_cache_key] = (
                        task_info,
                        task_locked_audio,
                    )
                return io.NodeOutput(
                    project_static, task_info, None, None, None, None, None,
                    None, task_locked_audio,
                    None, None, None, None, None,
                )

            media_data = None
            locked = None
            if tracks_info is not None:
                runtime_cache = multitrack_runtime_cache(
                    tracks_info,
                    create=True,
                )
                cached_media = (
                    runtime_cache.get("h3_project_media")
                    if isinstance(runtime_cache, dict)
                    else None
                )
                if isinstance(cached_media, dict):
                    media_data = cached_media
                    locked = cached_media.get("full_locked_audio")
                    media_data["_cache_status"] = {
                        "project_media": "命中恢复缓存",
                    }
                else:
                    info = parse_tracks_info(tracks_info)
                    log_node_info(
                        "H3 Project Static Prepare",
                        "开始加载项目媒体（包括锁定视频原声）",
                    )
                    task_base, images, audio, video, locked = (
                        prepare_multitrack_project_media(info)
                    )
                    log_node_info("H3 Project Static Prepare", "项目媒体加载完成")
                    task_base.pop(MULTITRACK_RUNTIME_CACHE_KEY, None)
                    media_data = {
                        "task_tracks_info_base": task_base,
                        "shared_images": images,
                        "shared_audio": audio,
                        "shared_video": video,
                        "full_locked_audio": locked,
                        "_segment_cache": {},
                        "_cache_status": {
                            "project_media": "首次加载",
                        },
                    }
                    if isinstance(runtime_cache, dict):
                        runtime_cache["h3_project_media"] = media_data
                if model_loader is None:
                    return io.NodeOutput(
                        media_data, None, None, None, None, None, None, None,
                        locked, None, None, None, None, None,
                    )

            loader = _first_input(model_loader)
            if not isinstance(loader, dict):
                raise TypeError("model_loader must contain a FAST_MODEL_LOADER dictionary")
            model, clip, vae = loader.get("model"), loader.get("clip"), loader.get("vae")
            audio_vae, preview_vae = loader.get("audio_vae"), loader.get("preview_vae")
            missing = [name for name, value in (("model", model), ("clip", clip),
                       ("vae", vae), ("audio_vae", audio_vae)) if value is None]
            if missing:
                raise ValueError("model_loader is missing required components: " + ", ".join(missing))
            _require_minimax_h3_model(model)
            second_model = _h3_second_pass_model(model_loader_2nd, model=model)
            _require_minimax_h3_model(second_model)
            static_data = {
                "model": model, "second_model": second_model, "clip": clip,
                "vae": vae, "audio_vae": audio_vae,
                "preview_vae": preview_vae,
            }
            if media_data is not None:
                static_data = {**media_data, **static_data}
            first_is_turbo = detect_turbo_model(model).is_turbo or bool(turbo_hint)
            second_is_turbo = first_is_turbo
            if run_second_pass and second_model is not model:
                second_is_turbo = detect_turbo_model(second_model).is_turbo
            graph = GraphBuilder()
            first_sampler = None
            if sampling_mode == "passthrough":
                first_sampler = first_sigmas = None
            elif sampling_mode == "selflift":
                first_sigmas = _h3_resolve_selflift_sigmas(
                    graph, sigmas=sigmas, preset_name=str(sampling_plan),
                    is_turbo=first_is_turbo,
                )
            else:
                first_sampler, first_sigmas = _h3_resolve_pass_sampling(
                    graph, pass_name="first_pass", sampler=sampler, sigmas=sigmas,
                    preset_name=str(sampling_plan), has_second_pass=sampling_mode == "dual",
                    is_turbo=first_is_turbo,
                )
            second_sampler = second_sigmas = context_sigmas = None
            if run_second_pass:
                custom_second = sampler_2nd is not None or sigmas_2nd is not None
                second_sampler, second_sigmas = _h3_resolve_pass_sampling(
                    graph, pass_name="second_pass", sampler=sampler_2nd,
                    sigmas=sigmas_2nd, preset_name=str(sampling_plan),
                    has_second_pass=True, is_turbo=second_is_turbo,
                )
                if has_context_second_pass:
                    context_sigmas = _h3_resolve_context_second_pass_sigmas(
                        graph, preset_name=str(sampling_plan), is_turbo=second_is_turbo,
                        has_custom_second_pass_sampling=custom_second,
                    )
            return io.NodeOutput(
                static_data, None, model, second_model, clip, vae, audio_vae,
                preview_vae, locked, first_sampler, first_sigmas, second_sampler,
                second_sigmas, context_sigmas, expand=graph.finalize(),
            )
        except (KeyError, TypeError, ValueError, RuntimeError) as error:
            raise RuntimeError(f"Failed to prepare H3 project static inputs: {error}") from error


# 2026-11-14：控件按采样模式分组后，id 带「模式·」前缀；这里把新 id 映射回
# 旧的内部键名，执行逻辑一律继续读旧名（避免大范围改动引入风险）。
_MODE_INPUT_ALIASES = {
    "音频·视频提交次数": "视频提交次数",
    "音频·仅音频分辨率": "仅音频分辨率",
    "图片·候选帧": "图片候选帧",
    "图片·帧数档位": "图片帧数档位",
    "◆ 采样模式": "采样模式覆盖",
    "◆ 自抬升·过渡点": "过渡点覆盖",
    "◆ 自抬升·低清比例": "低清比例覆盖",
    "二采·仅一采预览": "1st_pass_only",
    "二采·禁用噪声": "disable_2nd_noise",
    "二采·放大倍率": "upscale_by",
    "二采·放大模型": "upscale_model",
    "二采·启用分块": "enabled_tiling",
    "二采·分块数": "tile_count",
    "偏移·视频": "shift_video",
    "偏移·音频": "shift_audio",
    "自抬升·卸载放大模型": "upscaler_unload",
    "自抬升·权重下限": "w_min",
    "自抬升·权重上限": "w_max",
}


# (侧栏镜像控件, 原生子控件键, 节点默认值)
_MIRROR_SPECS = (
    ("◆ 图片·候选帧", "图片候选帧", "15"),
    ("◆ 图片·帧数档位", "图片帧数档位", _IMAGE_FRAME_TIER_FOLLOW),
    ("◆ 音频·提交次数", "视频提交次数", 1),
    ("◆ 音频·分辨率", "仅音频分辨率", "64x64"),
    ("◆ 二采·放大倍率", "upscale_by", 1.25),
    ("◆ 二采·放大模型", "upscale_model", "None"),
    ("◆ 二采·启用分块", "enabled_tiling", False),
    ("◆ 二采·分块数", "tile_count", 2),
    ("◆ 自抬升·权重下限", "w_min", 0.25),
    ("◆ 自抬升·权重上限", "w_max", 0.7),
)


def _same_value(left, right) -> bool:
    """镜像值与原生值是否等价（数值按 float 比较，其余按字符串）。"""
    try:
        return float(left) == float(right)
    except (TypeError, ValueError):
        return str(left).strip() == str(right).strip()


def _apply_flat_overrides(kwargs):
    """侧栏镜像控件覆盖节点原生值：只有它与原生值不同、且不是默认值时才生效。"""
    for mirror, target, default in _MIRROR_SPECS:
        if mirror not in kwargs:
            continue
        value = _first_input(kwargs.get(mirror), default)
        native = kwargs.get(target, default)
        if _same_value(value, native) or _same_value(value, default):
            continue
        if target in ("视频提交次数", "tile_count"):
            try:
                value = int(float(value))
            except (TypeError, ValueError):
                continue
        elif isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        kwargs[target] = value
    return kwargs


def _apply_mode_input_aliases(kwargs):
    """把带模式前缀的控件 id 复制回旧内部键名（旧名已存在时不覆盖）。"""
    if not kwargs:
        return kwargs
    for new_key, old_key in _MODE_INPUT_ALIASES.items():
        if new_key in kwargs and old_key not in kwargs:
            kwargs[old_key] = kwargs[new_key]
    return kwargs


def _image_first_inputs():
    """image_first 模式专属控件（只在选中该模式时渲染）。"""
    return [
        io.String.Input(
            "图片·候选帧",
            default="15",
            tooltip=(
                "仅 image_first 生效：从生成帧里挑哪些帧作为图片候选，逗号分隔，"
                "例如 0,3,7,11,15,19,21；只填 15 表示单帧。"
                "必须小于实际帧数，调小帧数后要同步调小本项。"
            ),
        ),
        io.Combo.Input(
            "图片·帧数档位",
            options=list(_IMAGE_FRAME_TIERS),
            default=_IMAGE_FRAME_TIER_FOLLOW,
            tooltip=(
                "仅 image_first 生效：用档位直接覆盖每个任务段的帧数，"
                "不再跟段长 / ComfyTV 时长走。1 帧最省时（实验），5 帧快，"
                "22 帧是原生网格点，124 帧是训练区间（最慢）。"
                "「跟随上游」= 保持原有行为。"
            ),
        ),
    ]


_AUDIO_FIRST_RESOLUTIONS = ("64x64", "32x32", "跟随上游")


def _audio_first_resolution_options():
    return list(_AUDIO_FIRST_RESOLUTIONS)


def _audio_first_inputs():
    """audio_first 模式专属控件。"""
    return [
        io.Int.Input(
            "音频·视频提交次数",
            default=1,
            min=1,
            max=64,
            step=1,
            tooltip=(
                "仅 audio_first 生效：音频每步更新，视频只在这些次数上提交；"
                "1 = 整段只提交一次。"
            ),
        ),
        io.Combo.Input(
            "音频·仅音频分辨率",
            options=_audio_first_resolution_options(),
            default="64x64",
            tooltip=(
                "仅 audio_first 生效：占位画面 64x64（推荐，音质稳定）或 "
                "32x32（更快）；「跟随上游」= 不缩图，直接用多轨信息里的分辨率"
                "（其它模式的默认行为）。真实音频时长仍由段时长决定。"
            ),
        ),
    ]


def _second_pass_inputs():
    """二采（dual / dual_t8 / selflift）共用的高清阶段控件。"""
    return [
        io.Boolean.Input(
            "二采·仅一采预览",
            default=False,
            tooltip=(
                "Run and save only the first selected segment's "
                "first pass. Turn this off on the next run to "
                "resume directly from that checkpoint at pass two."
            ),
            advanced=True,
        ),
        io.Boolean.Input(
            "二采·禁用噪声",
            default=False,
            tooltip="Disable noise in second-pass for dual-sampling",
            advanced=True,
        ),
        io.Float.Input(
            "二采·放大倍率",
            default=1.250,
            min=1.0,
            max=8.0,
            step=0.001,
            round=0.001,
            extra_dict={"precision": 3},
        ),
        io.Combo.Input(
            "二采·放大模型",
            options=["None"] + folder_paths.get_filename_list("latent_upscale_models"),
            default="None",
            advanced=True,
        ),
        io.Boolean.Input(
            "二采·启用分块",
            default=False,
            tooltip="Enable shared high-resolution H3 spatial tiling.",
        ),
        io.Int.Input(
            "二采·分块数",
            default=2,
            min=2,
            max=8,
            step=1,
            tooltip="Spatial tile count shared by Dual and SelfLift high-res sampling.",
        ),
    ]


def _selflift_extra_inputs():
    """selflift 额外的高级控件（放大器卸载与伪影修正区间）。"""
    return [
        io.Boolean.Input(
            "自抬升·卸载放大模型",
            default=True,
            advanced=True,
            tooltip=(
                "高级：SelfLift 学习放大器完成举升后立即从显存卸载（默认开启，与 "
                "YZ金鱼 SelfLift Progressive Sampler 的 upscaler_unload 一致），把"
                "显存让给高清阶段——12GB 卡上尤其有用。关闭则保留在显存中供后续复用"
                "（省去重新加载的几百毫秒）。仅 selflift 模式生效。"
            ),
        ),
        io.Float.Input(
            "自抬升·权重下限",
            default=0.25,
            min=0.0,
            max=1.0,
            step=0.05,
            advanced=True,
            tooltip=(
                "高级：SelfLift 伪影一致性修正的强度下限（默认 0.25 = 原本硬编码值，"
                "不动即与旧行为完全一致）。两组推荐值（成对使用，改一个请同时改另一个）："
                "①温和（现行默认）w_min / w_max = 0.25 / 0.7——配合学习放大器防过矫；"
                "②论文 & YZ金鱼 SelfLift Progressive Sampler 默认 = 0.5 / 1.0——修正更"
                "彻底、画面更锐。约束 0 ≤ w_min ≤ w_max ≤ 1，违反时采样开始会明确报错"
                "（不静默纠正）。仅 selflift 模式生效。"
            ),
        ),
        io.Float.Input(
            "自抬升·权重上限",
            default=0.7,
            min=0.0,
            max=1.0,
            step=0.05,
            advanced=True,
            tooltip=(
                "高级：SelfLift 伪影一致性修正的强度上限（默认 0.7 = 原本硬编码值，"
                "不动即与旧行为完全一致）。约束 0 ≤ w_min ≤ w_max ≤ 1。仅 selflift 模式生效。"
            ),
        ),
    ]

class EasyMultiTrackProject(io.ComfyNode):
    @classmethod
    def _sampling_plan_options(cls) -> list[str]:
        """Return sorted sampling plan keys: user presets first, then 'custom'."""
        return get_h3_preset_keys()

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy multitrackProject",
            display_name="多轨项目 · H3 生成",
            category="EasyUse/MultiTrackEditor",
            description=(
                "Build and execute a multi-track MiniMax H3 project with optional "
                "first-pass and second-pass sampling."
            ),
            is_input_list=True,
            enable_expand=True,
            not_idempotent=True,
            inputs=[
                TYPE_TRACKS_INFO.Input("tracks_info"),
                TYPE_FAST_MODEL_LOADER.Input(
                    "model_loader", raw_link=True, lazy=True,
                ),
                TYPE_FAST_MODEL_LOADER.Input(
                    "model_loader_2nd",
                    optional=True,
                    raw_link=True,
                    lazy=True,
                    tooltip=(
                        "Optional second-pass model for Dual sampling or the "
                        "high-resolution SelfLift stage. Encoding and VAE "
                        "components remain from the first-pass loader."
                    ),
                ),
                io.Sampler.Input(
                    "sampler", optional=True, raw_link=True, lazy=True,
                ),
                io.Sampler.Input("sampler_2nd", optional=True, raw_link=True, lazy=True, tooltip=(
                    "Optional second-pass sampler. "
                )),
                io.Sigmas.Input(
                    "sigmas", optional=True, raw_link=True, lazy=True,
                ),
                io.Sigmas.Input("sigmas_2nd", optional=True, raw_link=True, lazy=True, tooltip=(
                    "Optional second-pass sigmas. "
                )),
                io.Custom(io_type="T8_SEMANTIC_BRIDGE").Input(
                    "semantic_bridge", optional=True, raw_link=True, lazy=True,
                    tooltip=(
                        "Optional H3 Semantic Bridge (T8 fork): 连接 easy deciiaH3SemanticBridgeConfig 输出。"
                        "不接或输入为空时完全不启用（条件原样透传）。应用于一采与二采的 positive 条件。"
                    ),
                ),
                io.Vae.Input(
                    "output_vae", optional=True, raw_link=True, lazy=True,
                    tooltip=(
                        "Optional final-decode VAE override (e.g. easy deciiaH3HyperVAE2xLoader 2× VAE)."
                        "仅替换最终成片像素解码；编码/一采预览/上下文重编码仍用主 VAE。不接=不启用。"
                    ),
                ),
                io.String.Input("project_name", default=""),
                io.Combo.Input(
                    "project_save",
                    options=["new", "override"],
                    default="override",
                ),
                io.Int.Input(
                    "segment_start_number",
                    default=1,
                    min=1,
                    max=0x7FFFFFFF,
                    step=1,
                    tooltip="The task segment start number."
                ),
                io.Int.Input(
                    "segment_count",
                    default=-1,
                    min=-1,
                    max=0x7FFFFFFF,
                    step=1,
                    tooltip=(
                        "Maximum task segments in this queue. When set to -1, "
                        "override mode deletes saved segments from "
                        "segment_start_number onward before regeneration; new "
                        "mode preserves existing video and latent files."
                    ),
                ),
                io.Int.Input(
                    "seed",
                    default=42,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    step=1,
                    control_after_generate=io.ControlAfterGenerate.fixed,
                ),
                io.Combo.Input(
                    "sampling_plan",
                    options=cls._sampling_plan_options(),
                    default="light",
                ),
                io.DynamicCombo.Input(
                    "sampling_mode",
                    options=[
                        io.DynamicCombo.Option("single", []),
                        io.DynamicCombo.Option("dual", _second_pass_inputs()),
                        io.DynamicCombo.Option("dual_t8", _second_pass_inputs()),
                        io.DynamicCombo.Option("audio_first", _audio_first_inputs()),
                        io.DynamicCombo.Option("image_first", _image_first_inputs()),
                        io.DynamicCombo.Option(
                            "selflift",
                            [
                                # 2026-10-17：原地替换旧 transition_ratio（槽位/数量不变，
                                # 旧工作流 widget 值不错位），改为双语义「过渡点」。
                                io.Float.Input(
                                    "transition_point",
                                    default=0.6,
                                    min=0.0,
                                    max=10000.0,
                                    step=0.05,
                                    tooltip=(
                                        "过渡点：0~1 = 比例（低清阶段占用的 NFE 比例，"
                                        "内部自动换算成步数）；≥1 = 步数（低清评估次数，"
                                        "四舍五入取整，与 selflift-Avatar 的 transition_step "
                                        "同义）。例：7 次评估时 0.71≈5 步；直接填 5 也是 "
                                        "5 步。越界会在采样开始时明确报错，不静默夹取。"
                                    ),
                                ),
                                io.Float.Input(
                                    "lowres_scale",
                                    default=0.6,
                                    min=0.25,
                                    max=1.0,
                                    step=0.001,
                                    round=0.001,
                                    extra_dict={"precision": 3},
                                    tooltip=(
                                        "Scale of the low-resolution prefix relative "
                                        "to the target latent."
                                    ),
                                ),
                            ]
                            + _second_pass_inputs()
                            + _selflift_extra_inputs(),
                        ),
                        io.DynamicCombo.Option("passthrough", []),
                    ],
                ),
                # 高级输入（2026-10-11）：追加在列表末尾，避免旧工作流 widget 值错位；
                # 默认折叠，节点底部原生「显示高级输入」按钮展开。新增高级参数往这组里加。
                io.Float.Input(
                    "偏移·视频",
                    default=12.0,
                    min=0.01,
                    max=100.0,
                    step=0.01,
                    advanced=True,
                    tooltip=(
                        "高级：视频 sigma 偏移（默认 12.0 = H3 模型默认值）。适用范围："
                        "除 dual_t8（其双钟链路自行处理，不受此控件影响）外，single / dual / "
                        "selflift 都生效——在模型层统一施加一次，作用于视频档位与 DiT 的"
                        "时间步换算。一般无需改动，只有换用 DMAD 等特殊协议时才需要；"
                        "若 sigmas 由外部节点生成，本值须与 sigmas 生成端保持同一偏移，"
                        "否则档位与模型假设不一致。改动影响很大。"
                    ),
                ),
                io.Float.Input(
                    "偏移·音频",
                    default=3.0,
                    min=0.01,
                    max=100.0,
                    step=0.01,
                    advanced=True,
                    tooltip=(
                        "高级：音频 sigma 偏移（默认 3.0 = H3 模型默认值）。适用范围："
                        "除 dual_t8（其双钟链路自行处理）外，single / dual / selflift 都生效，"
                        "与视频偏移一起在模型层施加。它决定音频与视频 sigma 的比例 "
                        "audio_scale = 视频偏移 ÷ 音频偏移（12/3 → 4，12/2 → 6）："
                        "DMAD 协议用 2.0，其余情况保持 3.0。改动影响很大，非必要不要改。"
                    ),
                ),
                # 2026-11-07：ComfyTV 侧栏只能渲染普通控件（DynamicCombo 会被整块跳过），
                # 因此把「采样模式」与 selflift 的两个子项各做一份普通控件覆盖入口。
                # 默认「跟随节点 / 0」= 不生效，旧工作流与画布行为完全不变。
                io.Combo.Input(
                    "◆ 采样模式",
                    options=list(_H3_SAMPLING_MODE_CHOICES),
                    default=_H3_SAMPLING_MODE_FOLLOW,
                    optional=True,
                    advanced=True,
                    tooltip=(
                        "仅 ComfyTV 侧栏使用：非「跟随节点」时覆盖画布上的采样模式下拉"
                        "（selflift 会归一化）。P3a 日常使用保持「跟随节点」。"
                    ),
                ),
                io.Float.Input(
                    "◆ 自抬升·过渡点",
                    default=0.0,
                    min=0.0,
                    max=10000.0,
                    step=0.05,
                    optional=True,
                    advanced=True,
                    tooltip=(
                        "仅 ComfyTV：>0 时覆盖 selflift 的过渡点（0~1 比例、≥1 步数）；"
                        "0 = 跟随画布上 selflift 子项。"
                    ),
                ),
                io.Float.Input(
                    "◆ 自抬升·低清比例",
                    default=0.0,
                    min=0.0,
                    max=1.0,
                    step=0.001,
                    optional=True,
                    advanced=True,
                    tooltip=(
                        "仅 ComfyTV：>0 时覆盖 selflift 的低清比例（0.25~1）；"
                        "0 = 跟随画布上 selflift 子项。"
                    ),
                ),
                # 2026-11-14：ComfyTV 侧栏用的普通控件镜像。默认值与节点原生控件完全一致，
                # 侧栏里看到的数字就是画布上的数字；只有与原生值不同时才覆盖（见
                # _MIRROR_SPECS 的比较逻辑），所以旧工作流行为不变。
                io.String.Input("◆ 图片·候选帧", default="15", optional=True, advanced=True,
                                tooltip="image_first 生效；默认与 图片·候选帧 相同。"),
                io.Combo.Input("◆ 图片·帧数档位", options=list(_IMAGE_FRAME_TIERS),
                               default=_IMAGE_FRAME_TIER_FOLLOW, optional=True, advanced=True,
                               tooltip="image_first 生效；默认与 图片·帧数档位 相同。"),
                io.Int.Input("◆ 音频·提交次数", default=1, min=1, max=64, step=1,
                             optional=True, advanced=True,
                             tooltip="audio_first 生效；默认与 音频·视频提交次数 相同。"),
                io.Combo.Input("◆ 音频·分辨率", options=_audio_first_resolution_options(),
                               default="64x64", optional=True, advanced=True,
                               tooltip="audio_first 生效；默认与 音频·仅音频分辨率 相同。"),
                io.Float.Input("◆ 二采·放大倍率", default=1.25, min=1.0, max=8.0, step=0.001,
                               optional=True, advanced=True,
                               tooltip="dual/dual_t8/selflift 生效；默认与 二采·放大倍率 相同。"),
                io.Combo.Input("◆ 二采·放大模型",
                               options=["None"] + folder_paths.get_filename_list("latent_upscale_models"),
                               default="None", optional=True, advanced=True,
                               tooltip="dual/dual_t8/selflift 生效；默认与 二采·放大模型 相同。"),
                io.Boolean.Input("◆ 二采·启用分块", default=False, optional=True, advanced=True,
                                 tooltip="dual/dual_t8/selflift 生效；默认与 二采·启用分块 相同。"),
                io.Int.Input("◆ 二采·分块数", default=2, min=2, max=8, step=1,
                             optional=True, advanced=True,
                             tooltip="dual/dual_t8/selflift 生效；默认与 二采·分块数 相同。"),
                io.Float.Input("◆ 自抬升·权重下限", default=0.25, min=0.0, max=1.0, step=0.001,
                               optional=True, advanced=True,
                               tooltip="selflift 生效；默认与 自抬升·权重下限 相同。"),
                io.Float.Input("◆ 自抬升·权重上限", default=0.7, min=0.0, max=1.0, step=0.001,
                               optional=True, advanced=True,
                               tooltip="selflift 生效；默认与 自抬升·权重上限 相同。"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
            outputs=[
                io.String.Output("PROJECT_NAME"),
                io.Audio.Output("LOCKED_AUDIO"),
                io.String.Output("SAMPLING_MODE", display_name="采样模式"),
            ],
        )

    @classmethod
    def execute(cls, **kwargs: Any) -> io.NodeOutput:
        kwargs = _apply_mode_input_aliases(kwargs)
        node_name = "MultiTrack Project"
        progress_total = 100
        progress_bar = ProgressBar(progress_total)
        progress_value = 0

        def report_step(target: float) -> None:
            nonlocal progress_value
            progress_value = max(
                progress_value,
                min(progress_total, int(round(target))),
            )
            progress_bar.update_absolute(progress_value, progress_total)

        report_step(0)
        selected_model_loader = _raw_project_input(kwargs.get("model_loader"))
        uses_linked_prepare = is_link(selected_model_loader)
        if not uses_linked_prepare and not isinstance(selected_model_loader, dict):
            raise TypeError("model_loader must contain a FAST_MODEL_LOADER dictionary.")

        model = None if uses_linked_prepare else selected_model_loader.get("model")
        clip = None if uses_linked_prepare else selected_model_loader.get("clip")
        vae = None if uses_linked_prepare else selected_model_loader.get("vae")
        audio_vae = None if uses_linked_prepare else selected_model_loader.get("audio_vae")
        preview_vae = None if uses_linked_prepare else selected_model_loader.get("preview_vae")
        preview_node_id = str(
            _first_input(
                getattr(getattr(cls, "hidden", None), "unique_id", None),
                "",
            )
        )
        has_sampling_preview = bool(preview_node_id) and (uses_linked_prepare or preview_vae is not None)
        missing_components = [] if uses_linked_prepare else [
            name
            for name, value in (("model", model), ("clip", clip), ("vae", vae))
            if value is None
        ]
        if missing_components:
            raise ValueError(
                "model_loader is missing required components: "
                + ", ".join(missing_components)
            )
        if not uses_linked_prepare:
            _require_minimax_h3_model(model)
        info = parse_tracks_info(kwargs.get("tracks_info"))
        hidden_inputs = getattr(cls, "hidden", None)
        validate_h3_project_outputs(
            info,
            getattr(hidden_inputs, "prompt", None),
            getattr(hidden_inputs, "unique_id", None),
        )
        report_step(5)

        sampling_mode, sampling_config = _h3_sampling_mode_config(
            kwargs.get("sampling_mode")
        )
        sample_mode_override = str(
            _first_input(kwargs.get("采样模式覆盖"), _H3_SAMPLING_MODE_FOLLOW)
        ).strip()
        if (
            sample_mode_override
            and sample_mode_override != _H3_SAMPLING_MODE_FOLLOW
            and sample_mode_override in _H3_SAMPLING_MODE_CHOICES
            and sample_mode_override != sampling_mode
        ):
            print(
                f"[EasyMedia] 采样模式覆盖：{sampling_mode} → {sample_mode_override}"
                "（来自 ComfyTV 侧栏）"
            )
            sampling_mode, sampling_config = _h3_sampling_mode_config(
                sample_mode_override
            )
        # 项目类型（图片/音频/视频）与采样模式解耦：不再按项目类型强制 image_first / audio_first，
        # 采样模式完全由输入决定（ComfyTV 侧才能手动设置）。
        # 2026-11-14：模式专属控件已搬进 sampling_mode 的 DynamicCombo 选项，
        # 它们以子键形式出现在 sampling_config 里。先合并回 kwargs 再跑一次别名映射，
        # 下方所有 kwargs.get("图片候选帧") 之类的旧读法保持不变。
        if isinstance(sampling_config, dict):
            for _child_key, _child_value in sampling_config.items():
                if _child_key in ("sampling_mode",):
                    continue
                kwargs.setdefault(_child_key, _child_value)
            kwargs = _apply_mode_input_aliases(kwargs)
        kwargs = _apply_flat_overrides(kwargs)
        is_passthrough = sampling_mode == "passthrough"
        is_selflift = sampling_mode == "selflift"
        is_dual_t8 = sampling_mode == "dual_t8"
        is_audio_first = sampling_mode == "audio_first"
        is_image_first = sampling_mode == "image_first"
        image_candidate_frames = str(
            _first_input(kwargs.get("图片候选帧"), "15")
        ).strip()
        image_frame_tier = str(
            _first_input(kwargs.get("图片帧数档位"), _IMAGE_FRAME_TIER_FOLLOW)
        ).strip()
        image_frame_override = _IMAGE_FRAME_TIER_FRAMES.get(image_frame_tier, 0)
        _effective = []
        _ignored = []
        if is_audio_first:
            _effective += ["音频·视频提交次数", "音频·仅音频分辨率"]
        else:
            _ignored += ["音频·视频提交次数", "音频·仅音频分辨率"]
        if is_image_first:
            _effective += ["图片·候选帧", "图片·帧数档位"]
        else:
            _ignored += ["图片·候选帧", "图片·帧数档位"]
        if sampling_mode in ("dual", "dual_t8") or is_selflift:
            _effective += ["二采·放大倍率", "二采·放大模型", "二采·禁用噪声"]
        else:
            _ignored += ["二采·放大倍率", "二采·放大模型", "二采·禁用噪声"]
        if is_selflift:
            _effective += ["◆ 自抬升·过渡点", "◆ 自抬升·低清比例", "自抬升·卸载放大模型", "自抬升·权重下限", "自抬升·权重上限"]
        else:
            _ignored += ["◆ 自抬升·过渡点", "◆ 自抬升·低清比例", "自抬升·卸载放大模型", "自抬升·权重下限", "自抬升·权重上限"]
        if image_frame_override > 0 and is_image_first:
            print(
                f"[EasyMedia] 图片帧数档位：{image_frame_tier}"
                f" → 每个任务段固定 {image_frame_override} 帧（覆盖段长计算）"
            )
        print(
            f"[EasyMedia] 采样模式={sampling_mode}；生效："
            + ("、".join(_effective) or "无")
            + "；忽略："
            + ("、".join(_ignored) or "无")
        )
        try:
            multirate_video_steps = int(
                _first_input(
                    kwargs.get("视频提交次数"),
                    _first_input(
                        sampling_config.get("视频提交次数"),
                        _first_input(
                            sampling_config.get("multirate_video_steps"),
                            _first_input(kwargs.get("multirate_video_steps"), 1),
                        ),
                    ),
                )
            )
        except (TypeError, ValueError):
            multirate_video_steps = 1
        multirate_video_steps = max(1, multirate_video_steps)
        # audio_first 固定走 MultiRate：音频每步更新、视频只提交 N 次
        use_multirate = is_audio_first
        # 高级输入（2026-10-11）：视频/音频 sigma 偏移覆盖；默认值 = 原本硬编码值，向后兼容
        def _shift_value(raw, fallback: float) -> float:
            """旧工作流 widget 错位可能给到空串/0 等脏值——非法时回落默认，避免采样崩。"""
            try:
                value = float(_first_input(raw, fallback))
            except (TypeError, ValueError):
                return fallback
            return value if value > 0 else fallback

        shift_video_override = _shift_value(kwargs.get("shift_video"), 12.0)
        shift_audio_override = _shift_value(kwargs.get("shift_audio"), 3.0)
        has_second_pass = sampling_mode in ("dual", "dual_t8")
        transition_ratio = 0.6
        lowres_scale = 0.6
        # 过渡点（2026-10-17 原地替换 transition_ratio 的双语义控件）：
        #   0~1 = 比例（低位默认 0.6 换算）；>=1 = 步数；脏值/负数 → 回退 0.6 比例。
        # 兼容：老文件/老 API prompt 里可能仍是 transition_ratio 或顶层 transition_step。
        transition_step_override = 0
        upscaler_unload = True
        # 伪影修正强度区间（2026-10-17 起可在高级输入里手调；默认=原硬编码值）
        w_min_override = 0.25
        w_max_override = 0.7
        tiling_enabled, _default_tile = _h3_tiling_config(kwargs.get("enabled_tiling"))
        # 2026-11-14：启用分块从 DynamicCombo 改为普通布尔，分块数是独立整数控件
        try:
            tile_count = int(_first_input(kwargs.get("tile_count"), _default_tile))
        except (TypeError, ValueError):
            tile_count = _default_tile
        if tiling_enabled and not 2 <= tile_count <= 8:
            raise ValueError("tile_count must be between 2 and 8")
        if is_selflift:
            raw_point = sampling_config.get("transition_point")
            if raw_point is None:
                raw_point = sampling_config.get("transition_ratio")
            if raw_point is None:
                raw_point = kwargs.get("transition_step")
            if raw_point is None:
                raw_point = kwargs.get("transition_ratio")
            try:
                point_override = float(_first_input(kwargs.get("过渡点覆盖"), 0.0))
            except (TypeError, ValueError):
                point_override = 0.0
            if math.isfinite(point_override) and point_override > 0.0:
                raw_point = point_override
            try:
                transition_point = float(_first_input(raw_point, 0.6))
            except (TypeError, ValueError):
                transition_point = 0.6
            if not math.isfinite(transition_point) or transition_point < 0.0:
                transition_point = 0.6
            if transition_point >= 1.0:
                # 步数语义：四舍五入取整；越界由引擎比对 sigmas 档数后明确报错（不夹取）
                transition_step_override = int(round(transition_point))
            elif transition_point > 0.0:
                # 比例语义
                transition_ratio = transition_point
                transition_step_override = 0
            else:
                # 0/非法值：回退默认比例 0.6（自 lift 引擎按比例换算）
                transition_step_override = 0
            lowres_scale = float(
                _first_input(sampling_config.get("lowres_scale"), 0.6)
            )
            try:
                lowres_override = float(
                    _first_input(kwargs.get("低清比例覆盖"), 0.0)
                )
            except (TypeError, ValueError):
                lowres_override = 0.0
            if math.isfinite(lowres_override) and lowres_override > 0.0:
                lowres_scale = min(1.0, max(0.25, lowres_override))
            upscaler_unload = bool(
                _first_input(kwargs.get("upscaler_unload"), True)
            )
            try:
                w_min_override = float(_first_input(kwargs.get("w_min"), 0.25))
            except (TypeError, ValueError):
                w_min_override = 0.25
            try:
                w_max_override = float(_first_input(kwargs.get("w_max"), 0.7))
            except (TypeError, ValueError):
                w_max_override = 0.7
            if not math.isfinite(w_min_override) or not 0.0 <= w_min_override <= 1.0:
                w_min_override = 0.25
            if not math.isfinite(w_max_override) or not 0.0 <= w_max_override <= 1.0:
                w_max_override = 0.7
            legacy_highres_tiling = bool(
                _first_input(sampling_config.get("highres_tiling"), False)
            )
            if legacy_highres_tiling and not tiling_enabled:
                tiling_enabled = True
                tile_count = 0
        first_pass_only = bool(
            _first_input(
                sampling_config.get("1st_pass_only"),
                _first_input(kwargs.get("1st_pass_only"), False),
            )
        )
        run_second_pass = has_second_pass and not first_pass_only
        if is_selflift:
            first_pass_only = False
        disable_2nd_noise = bool(
            _first_input(
                sampling_config.get("disable_2nd_noise"),
                _first_input(kwargs.get("disable_2nd_noise"), False),
            )
        )
        second_model = model
        second_model_loader = None
        if run_second_pass or is_selflift or is_dual_t8:
            # 2026-10-05：dual_t8 也解析 model_loader_2nd —— 接了就用它作二采模型
            # （DetailMixer 的 model 入参），不接回落一采模型（P8a 兼容行为）。
            # 普通dual/selflift 原逻辑不变。
            configured_second_loader = sampling_config.get("model_loader_2nd")
            second_model_loader = _raw_project_input(
                configured_second_loader if configured_second_loader is not None
                else kwargs.get("model_loader_2nd")
            )
            if not uses_linked_prepare:
                second_model = _h3_second_pass_model(second_model_loader, model=model)
                _require_minimax_h3_model(second_model)
        report_step(10)

        # dual_t8/T8fork 注入（2026-10-04）：原始链接透传，段循环内构造内部图节点。
        bridge_link = _raw_project_input(
            sampling_config.get("semantic_bridge")
            if sampling_config.get("semantic_bridge") is not None
            else kwargs.get("semantic_bridge")
        )
        if bridge_link is None:
            bridge_link = _raw_project_input(kwargs.get("semantic_bridge"))
        output_vae_link = _raw_project_input(
            sampling_config.get("output_vae")
            if sampling_config.get("output_vae") is not None
            else kwargs.get("output_vae")
        )
        if output_vae_link is None:
            output_vae_link = _raw_project_input(kwargs.get("output_vae"))
        has_semantic_bridge = bridge_link is not None
        has_output_vae = output_vae_link is not None
        if (has_semantic_bridge or has_output_vae) and not (
            is_dual_t8 or has_second_pass or is_selflift
        ):
            # 单采模式也允许 bridge（只影响一采 positive）；output_vae 任何模式可用。
            pass

        hidden_inputs = getattr(cls, "hidden", None)
        prompt_turbo_detection = None
        turbo_detection = None if uses_linked_prepare else detect_turbo_model(model)
        if uses_linked_prepare or not turbo_detection.is_turbo:
            prompt_turbo_detection = detect_turbo_lora_from_prompt(
                getattr(hidden_inputs, "prompt", None),
                getattr(hidden_inputs, "unique_id", None),
            )
            if uses_linked_prepare or prompt_turbo_detection is not None:
                turbo_detection = prompt_turbo_detection
        first_is_turbo = bool(turbo_detection and turbo_detection.is_turbo)
        report_step(15)
        second_turbo_detection = turbo_detection
        if run_second_pass and not uses_linked_prepare and second_model is not model:
            second_turbo_detection = detect_turbo_model(second_model)
            report_step(16)
        second_is_turbo = bool(second_turbo_detection and second_turbo_detection.is_turbo)

        safe_project_name = safe_h3_project_name(kwargs.get("project_name"))
        project_save = str(_first_input(kwargs.get("project_save"), "new"))
        if project_save not in {"new", "override"}:
            raise ValueError("project_save must be 'new' or 'override'")
        upscale_by = float(
            _first_input(
                sampling_config.get("upscale_by"),
                _first_input(kwargs.get("upscale_by"), 1.250),
            )
        )
        if not math.isfinite(upscale_by) or upscale_by < 1:
            raise ValueError(
                "upscale_by must be a finite value greater than or equal to 1"
            )

        first_pass_width = int(info["width"])
        first_pass_height = int(info["height"])
        if is_audio_first:
            # 有声剧：把画面压到最低档，算力交给音频；真实音频时长仍由段时长决定。
            # 2026-11-07：新增「跟随上游」= 不缩图，直接继承多轨信息的分辨率。
            placeholder_raw = str(
                _first_input(
                    kwargs.get("仅音频分辨率"),
                    _first_input(
                        sampling_config.get("仅音频分辨率"),
                        _first_input(
                            sampling_config.get("audio_first_resolution"),
                            _first_input(kwargs.get("audio_first_resolution"), "64x64"),
                        ),
                    ),
                )
            ).strip()
            if placeholder_raw == "跟随上游":
                placeholder_size = 0
            else:
                placeholder_size = 32 if placeholder_raw.startswith("32") else 64
            if placeholder_size:
                first_pass_width = first_pass_height = placeholder_size
        audio_only = is_audio_first or (first_pass_width, first_pass_height) == (32, 32)
        fps = float(info["frame_rate"])
        target_width, target_height = h3_second_pass_dimensions(
            first_pass_width,
            first_pass_height,
            run_second_pass,
            upscale_by,
        )
        # Keep task inputs at the configured size; exports use the final size.
        # 2026-10-05：接 HyperVAE 2× 时段文件实际输出为 target×2（1280×2304 级），
        # manifest 画布必须同步放大，否则 VideoCombine 的 ffmpeg overlay=0:0 会把
        # 2× 段裁到画布左上角（表现为“画面放大了几倍”）。未接 HyperVAE 时不变。
        output_info = {
            **info,
            "width": (
                target_width
                if audio_only or not has_output_vae
                else target_width * 2
            ),
            "height": (
                target_height
                if audio_only or not has_output_vae
                else target_height * 2
            ),
            # 2026-10-05：记录本次生成的关键设置，供合并节点前端推算
            # “参数变更后的即将生成分辨率”并实时预警（无需运行）。
            "audio_only": bool(audio_only),
            "image_first": bool(is_image_first),
            "图片候选帧": image_candidate_frames,
            "图片帧数档位": image_frame_tier,
            "sampling_mode": sampling_mode,
            "gen_settings": {
                "base_width": first_pass_width,
                "base_height": first_pass_height,
                "upscale_by": upscale_by,
                "second_pass": bool(run_second_pass),
                "hyper_vae": bool(has_output_vae),
            },
        }
        initialize_h3_project(
            safe_project_name,
            output_info,
            folder_paths.get_output_directory(),
        )
        all_entries = h3_task_entries(info)
        segment_start_number = int(_first_input(kwargs.get("segment_start_number"), 1))
        if segment_start_number < 1:
            raise ValueError("segment_start_number must be at least 1")
        segment_start_index = segment_start_number - 1
        segment_count = int(_first_input(kwargs.get("segment_count"), -1))
        selected_entries = select_h3_task_entries(
            all_entries,
            segment_start_index,
            segment_count,
        )
        if not selected_entries:
            raise ValueError(
                "No H3 task segments are available from segment_start_number."
            )
        has_sampling_tasks = not is_passthrough and any(
            not h3_task_is_passthrough(entry) for _, entry in selected_entries
        )

        first_selected_index, first_selected_entry = selected_entries[0]
        first_selected_task = first_selected_entry.get("task", {})
        first_selected_content = (
            first_selected_task.get("content", {})
            if isinstance(first_selected_task, dict)
            else {}
        )
        first_selected_continuity = (
            str(first_selected_content.get("continuity_mode", "shot")).lower()
            if isinstance(first_selected_content, dict)
            else "shot"
        )
        if first_selected_continuity == "context_test":
            first_selected_continuity = "context"
        if (
            first_selected_index > 0
            and first_selected_continuity in H3_CONTEXT_CONTINUITY_MODES
            and not is_passthrough
            and not h3_task_is_passthrough(first_selected_entry)
        ):
            previous_index = first_selected_index - 1
            if not has_h3_context_latent(
                safe_project_name,
                previous_index,
                resolution="high",
                output_directory=folder_paths.get_output_directory(),
            ):
                raise ValueError(
                    f"Cannot start segment {first_selected_index + 1} with "
                    f"{first_selected_continuity}: segment {previous_index + 1} "
                    "has no active context latent. Generate or restore the "
                    "previous segment first."
                )
            previous_is_passthrough = (
                h3_active_segment_is_passthrough(
                    safe_project_name,
                    previous_index,
                    folder_paths.get_output_directory(),
                )
                if is_selflift else False
            )
            if is_selflift and not has_h3_context_latent(
                safe_project_name,
                previous_index,
                resolution="low",
                output_directory=folder_paths.get_output_directory(),
                allow_low_fallback=previous_is_passthrough,
            ):
                raise ValueError(
                    f"Cannot start SelfLift segment {first_selected_index + 1} "
                    f"with {first_selected_continuity}: segment "
                    f"{previous_index + 1} has no active low-resolution context "
                    "latent. Regenerate the previous segment with SelfLift first."
                )
        resume_task_index: int | None = None
        if run_second_pass and selected_entries:
            first_selected_index = selected_entries[0][0]
            if has_h3_first_pass_checkpoint(
                safe_project_name,
                first_selected_index,
                folder_paths.get_output_directory(),
            ):
                resume_task_index = first_selected_index
                log_node_info(
                    node_name,
                    f"Resuming segment {first_selected_index} from its first-pass checkpoint",
                )

        if project_save == "override" and segment_count == -1:
            clear_h3_project_segments_from(
                safe_project_name,
                (
                    resume_task_index + 1
                    if resume_task_index is not None
                    else segment_start_index
                ),
                folder_paths.get_output_directory(),
            )
            report_step(19)

        if first_pass_only and has_second_pass:
            selected_entries = selected_entries[:1]
        log_node_info(
            node_name,
            f"Found {len(all_entries)} segments; processing {len(selected_entries)}",
        )
        report_step(20)
        first_pass_seed = int(_first_input(kwargs.get("seed"), 42))
        second_pass_seed = first_pass_seed
        selected_upscale_model = str(
            _first_input(
                sampling_config.get("upscale_model"),
                _first_input(kwargs.get("upscale_model"), "None"),
            )
        )
        if not uses_linked_prepare and audio_vae is None:
            raise ValueError(
                "model_loader must include audio_vae to decode MiniMax H3 audio."
            )
        report_step(25)

        graph = GraphBuilder()
        report_step(27)
        preset_name = str(_first_input(kwargs.get("sampling_plan"), "medium"))
        has_context_second_pass = run_second_pass and has_sampling_tasks and any(
            task_index > 0 and isinstance(entry.get("task"), dict)
            and not h3_task_is_passthrough(entry)
            and isinstance(entry["task"].get("content"), dict)
            and str(entry["task"]["content"].get("continuity_mode", "shot")).lower()
            in H3_CONTEXT_CONTINUITY_MODES for task_index, entry in selected_entries
        )
        if uses_linked_prepare:
            def raw_sampling_input(name: str) -> Any:
                value = sampling_config.get(name)
                return _raw_project_input(value if value is not None else kwargs.get(name))

            tracks_info_link = _hidden_project_input_link(
                hidden_inputs,
                "tracks_info",
            )
            project_media_static = graph.node(
                "easy h3ProjectStaticPrepare",
                id="project_media_prepare",
                tracks_info=tracks_info_link or info,
            )
            model_inputs = {
                "model_loader": selected_model_loader,
                "sampling_plan": preset_name,
                "sampling_mode": sampling_mode if has_sampling_tasks else "passthrough",
                "run_second_pass": run_second_pass and has_sampling_tasks,
                "has_context_second_pass": has_context_second_pass,
                "turbo_hint": first_is_turbo,
            }
            for name, value in (
                ("model_loader_2nd", second_model_loader),
                ("sampler", raw_sampling_input("sampler")),
                ("sigmas", raw_sampling_input("sigmas")),
                ("sampler_2nd", raw_sampling_input("sampler_2nd")),
                ("sigmas_2nd", raw_sampling_input("sigmas_2nd")),
            ):
                if value is not None:
                    model_inputs[name] = value
            project_model_static = graph.node(
                "easy h3ProjectStaticPrepare",
                id="project_model_prepare",
                **model_inputs,
            )
            model, second_model = project_model_static.out(2), project_model_static.out(3)
            clip, vae = project_model_static.out(4), project_model_static.out(5)
            audio_vae, preview_vae = project_model_static.out(6), project_model_static.out(7)
            full_locked_audio = project_media_static.out(8)
            first_pass_sampler, first_pass_sigmas = project_model_static.out(9), project_model_static.out(10)
            second_pass_sampler, second_pass_sigmas = project_model_static.out(11), project_model_static.out(12)
            context_second_pass_sigmas = project_model_static.out(13)
            task_tracks_info_base = shared_images = shared_audio = shared_video = None
        else:
            (task_tracks_info_base, shared_images, shared_audio, shared_video,
             full_locked_audio) = prepare_multitrack_project_media(info)
            first_pass_sampler = first_pass_sigmas = None
            if has_sampling_tasks and any(
                task_index != resume_task_index and not h3_task_is_passthrough(entry)
                for task_index, entry in selected_entries
            ):
                if is_selflift:
                    first_pass_sigmas = _h3_resolve_selflift_sigmas(
                        graph, sigmas=_first_input(kwargs.get("sigmas")),
                        preset_name=preset_name, is_turbo=first_is_turbo)
                else:
                    first_pass_sampler, first_pass_sigmas = _h3_resolve_pass_sampling(
                        graph, pass_name="first_pass", sampler=_first_input(kwargs.get("sampler")),
                        sigmas=_first_input(kwargs.get("sigmas")), preset_name=preset_name,
                        has_second_pass=has_second_pass, is_turbo=first_is_turbo)
            second_pass_sampler = second_pass_sigmas = context_second_pass_sigmas = None
            if run_second_pass and has_sampling_tasks:
                configured_sampler = _first_input(sampling_config.get("sampler_2nd"), _first_input(kwargs.get("sampler_2nd")))
                configured_sigmas = _first_input(sampling_config.get("sigmas_2nd"), _first_input(kwargs.get("sigmas_2nd")))
                custom_second = configured_sampler is not None or configured_sigmas is not None
                second_pass_sampler, second_pass_sigmas = _h3_resolve_pass_sampling(
                    graph, pass_name="second_pass", sampler=configured_sampler,
                    sigmas=configured_sigmas, preset_name=preset_name,
                    has_second_pass=True, is_turbo=second_is_turbo)
                if has_context_second_pass:
                    context_second_pass_sigmas = _h3_resolve_context_second_pass_sigmas(
                        graph, preset_name=preset_name, is_turbo=second_is_turbo,
                        has_custom_second_pass_sampling=custom_second)
        report_step(31)

        # 偏移（sigma shift）适用范围（2026-10-13）：single / dual / selflift 都在模型层
        # 统一施加一次；dual_t8 由双钟链路（DualClock / DetailMixer）自行处理，保持原行为，
        # 避免双重施加；passthrough 不采样、无采样任务时也不插入。位置必须在段循环之外，
        # 否则每段都会多克隆一次模型。
        if not is_dual_t8 and not is_passthrough and has_sampling_tasks:
            first_model_input = model
            model = _h3_apply_shift_override(
                graph,
                first_model_input,
                node_id="h3_shift_override",
                shift_video=shift_video_override,
                shift_audio=shift_audio_override,
            )
            if second_model_loader is None or second_model is first_model_input:
                # 未接二采加载器：二采/高清阶段与一采共用同一模型，复用同一份 patch 输出。
                second_model = model
            else:
                second_model = _h3_apply_shift_override(
                    graph,
                    second_model,
                    node_id="h3_shift_override_2nd",
                    shift_video=shift_video_override,
                    shift_audio=shift_audio_override,
                )
            log_node_info(
                node_name,
                "H3 sigma shift video={:g} audio={:g} applied at model layer "
                "(all sampling modes except dual_t8)".format(
                    shift_video_override,
                    shift_audio_override,
                ),
            )

        report_step(33)

        previous_hires_context_latent: Any | None = None
        previous_low_context_latent: Any | None = None
        previous_artifact: Any | None = None
        last_project_output: Any | None = None
        report_step(35)

        segment_total = len(selected_entries)
        segment_nodes: dict[str, int] = {}
        for segment_position, (task_index, entry) in enumerate(selected_entries):
            previous_graph_nodes = set(graph.nodes)
            dual_t8_refine_sigmas = None
            def report_segment_step(
                phase: float,
                *,
                current_position: int = segment_position,
            ) -> None:
                target = 35 + 60 * (current_position + phase) / segment_total
                report_step(target)

            task_type = h3_task_type(entry, info)
            generation_mode = h3_generation_mode(task_type)
            task = entry.get("task", {})
            content = task.get("content", {}) if isinstance(task, dict) else {}
            if is_image_first:
                content = dict(content) if isinstance(content, dict) else {}
                content["continuity_mode"] = "shot"
            task_is_passthrough = is_passthrough or h3_task_is_passthrough(entry)
            locked_audio_track = h3_locked_audio_track(entry, info)
            locked_video_track = h3_locked_video_track(entry, info)
            has_task_locked_audio = locked_audio_track is not None
            preserve_source_timing = not audio_only and (
                has_task_locked_audio or locked_video_track is not None
            )
            fit_locked_video_timing = (
                preserve_source_timing
                and locked_video_track is not None
            )

            ref_image_size = (
                str(content.get("ref_image_size", "match")).lower()
                if isinstance(content, dict)
                else "match"
            )
            report_segment_step(0.0)
            report_segment_step(0.04)
            task_start_frame = max(0, int(entry.get("start_frame", 0)))
            task_end_frame = max(
                task_start_frame,
                int(entry.get("end_frame", task_start_frame)),
            )
            task_duration_frames = max(1, task_end_frame - task_start_frame)
            if image_frame_override > 0 and is_image_first:
                # 档位优先于段长：图片任务只出这几帧，段长再长也不追加。
                # 只在 image_first 生效：音频/视频模式的段长同时决定音频时长，
                # 若被帧数档位改写会让出片时长错乱。
                task_duration_frames = image_frame_override
            if uses_linked_prepare:
                segment_static = graph.node(
                    "easy h3ProjectStaticPrepare", id=f"segment_static_prepare_{task_index}",
                    project_static=project_media_static.out(0), task_start_frame=task_start_frame,
                    task_index=task_index,
                    task_duration_frames=task_duration_frames, fps=fps,
                    generation_mode="reference" if task_is_passthrough else generation_mode,
                    **(
                        {"previous": previous_artifact}
                        if previous_artifact is not None
                        else {}
                    ),
                )
                task_tracks_info, task_locked_audio = segment_static.out(1), segment_static.out(8)
                task_output = graph.node(
                    "easy multiTrackTaskOutput",
                    id=f"task_{task_index}",
                    tracks_info=task_tracks_info,
                    task_index=task_index,
                    prompt_format="default",
                )
                base_task_length = task_output.out(3)
                if preserve_source_timing:
                    base_task_length = task_duration_frames
            else:
                task_shared_audio, task_shared_video, task_locked_audio = crop_multitrack_project_media(
                    shared_audio, shared_video, full_locked_audio, task_start_frame,
                    task_duration_frames, fps,
                )
                task_tracks_info = prepare_multitrack_project_task_info(
                    task_tracks_info_base, shared_images,
                    task_shared_audio if generation_mode == "reference" or task_is_passthrough else [],
                    task_shared_video if generation_mode == "reference" or task_is_passthrough else [],
                    task_entry=entry,
                )
                task_output = graph.node(
                    "easy multiTrackTaskOutput", id=f"task_{task_index}",
                    tracks_info=task_tracks_info,
                    **({"previous": previous_artifact} if previous_artifact is not None else {}),
                    task_index=task_index, prompt_format="default",
                )
                base_task_length = task_output.out(3)
                if preserve_source_timing:
                    base_task_length = task_duration_frames
            if task_is_passthrough:
                if audio_only:
                    raise ValueError("Passthrough requires a video project, not audio-only mode")
                passthrough = graph.node(
                    "easy h3PassthroughVideo",
                    id=f"passthrough_video_{task_index}",
                    videos=task_output.out(6),
                    # Deciia 2026-10-04：直通段音频取任务窗音轨混音（AUDIO 槽），
                    # 见 docs/DESIGN_track_segment_flags_20261004.md。
                    audio=task_output.out(5),
                    frame_count=task_duration_frames,
                    fps=fps,
                    width=target_width,
                    height=target_height,
                    project_name=safe_project_name,
                    segment_index=task_index,
                )
                context_latent = _h3_encode_context_media(
                    graph, passthrough.out(1), passthrough.out(2), vae, audio_vae,
                    f"passthrough_context_{task_index}",
                )
                runtime_context_latent = graph.node(
                    "easy h3MotionContextLatentTrim",
                    id=f"trim_hires_context_latent_{task_index}",
                    latent=context_latent,
                    context_length=str(H3_CONTEXT_SOURCE_FRAMES),
                ).out(0)
                saved_video_end = graph.node(
                    "easy h3SegmentSaveEnd",
                    id=f"save_end_{task_index}",
                    video_path=passthrough.out(0),
                    project_name=safe_project_name,
                    segment_index=task_index,
                )
                artifact_inputs = {
                    "project_name": safe_project_name,
                    "project_save": project_save,
                    "segment_index": task_index,
                    "context_latent": runtime_context_latent,
                    "video_path": saved_video_end.out(0),
                    "tracks_info": output_info,
                    "continuity_mode": "shot",
                    "seed": first_pass_seed,
                    "sampling_pass": "single",
                }
                if previous_artifact is not None:
                    artifact_inputs["previous"] = previous_artifact
                artifact = graph.node(
                    "easy h3ProjectArtifact",
                    id=f"artifact_{task_index}",
                    **artifact_inputs,
                )
                previous_artifact = last_project_output = artifact.out(0)
                previous_hires_context_latent = runtime_context_latent
                previous_low_context_latent = runtime_context_latent
                segment_nodes.update({
                    node_id: task_index
                    for node_id in graph.nodes.keys() - previous_graph_nodes
                })
                report_segment_step(1.0)
                continue
            continuity_mode = (
                str(content.get("continuity_mode", "shot")).lower()
                if isinstance(content, dict)
                else "shot"
            )
            if continuity_mode == "context_test":
                continuity_mode = "context"
            uses_context = continuity_mode in H3_CONTEXT_CONTINUITY_MODES
            uses_swap = continuity_mode in {"context_drift", "context_swap"}
            aligned_task_length: Any = (
                minimax_frame_count(base_task_length, round_up=True)
                if preserve_source_timing
                else base_task_length
            )
            task_length: Any = aligned_task_length
            will_have_context_continuity = (
                uses_context
                and (previous_hires_context_latent is not None or task_index > 0)
            )
            context_source_frames = H3_CONTEXT_SOURCE_FRAMES
            context_generation_frames = 34
            if will_have_context_continuity:
                task_length = graph.node(
                    "ComfyMathExpression",
                    id=f"context_length_{task_index}",
                    expression=f"a + {context_generation_frames}",
                    **{"values.a": task_length},
                ).out(1)
            report_segment_step(0.10)
            camera_prompt_node = graph.node(
                "easy h3CameraPromptInject",
                id=f"camera_prompt_{task_index}",
                prompt=task_output.out(1),
                project_name=safe_project_name,
                start_frame=task_start_frame,
                end_frame=task_end_frame,
            )
            conditioning_inputs = {
                "clip": clip, "vae": vae, "audio_vae": audio_vae,
                "images": task_output.out(4), "prompt": camera_prompt_node.out(0),
                "mode": generation_mode,
                "width": target_width if is_selflift else first_pass_width,
                "height": target_height if is_selflift else first_pass_height,
                "length": task_length, "ref_image_size": ref_image_size,
            }
            if generation_mode == "reference":
                conditioning_inputs.update({
                    "audios": task_output.out(5),
                    "videos": task_output.out(6),
                })
                if fit_locked_video_timing:
                    conditioning_inputs["locked_video_timing_frames"] = (
                        aligned_task_length
                    )
            encoded_conditioning = graph.node(
                "easy minimaxH3ToVideo",
                id=f"conditioning_{task_index}",
                **conditioning_inputs,
            )
            conditioning = graph.node(
                "easy h3ConditioningCache",
                id=f"conditioning_cache_{task_index}",
                project_name=safe_project_name,
                segment_index=task_index,
                tracks_info=task_tracks_info,
                task_output_ready=task_output.out(1),
                model=model,
                clip=clip,
                vae=vae,
                audio_vae=audio_vae,
                conditioning=encoded_conditioning.out(0),
                latent=encoded_conditioning.out(1),
            )
            base_positive = second_pass_positive = conditioning.out(0)
            second_pass_template_latent = None
            # Reference conditioning has no canvas-sized keyframes. Its text and
            # media embeddings can be shared by both sampling resolutions.
            # dual_t8 例外：Reconcile 需要二采分辨率模板 latent，reference 模式也重建。
            _needs_second_template = is_dual_t8 and (
                first_pass_width,
                first_pass_height,
            ) != (target_width, target_height)
            if run_second_pass and (
                generation_mode != "reference" or _needs_second_template
            ) and (
                first_pass_width,
                first_pass_height,
            ) != (target_width, target_height):
                second_inputs = {
                    **conditioning_inputs,
                    "width": target_width,
                    "height": target_height,
                }
                _second_cond_node = graph.node(
                    "easy minimaxH3ToVideo",
                    id=f"second_pass_conditioning_{task_index}",
                    **second_inputs,
                )
                second_pass_positive = _second_cond_node.out(0)
                if is_dual_t8:
                    # dual_t8：Reconcile 需要二采分辨率的模板 latent。
                    second_pass_template_latent = _second_cond_node.out(1)
            initial_latent = conditioning.out(1)
            positive = base_positive

            # Deciia 2026-10-04：Semantic Bridge（T8 fork）应用于两采 positive。
            if has_semantic_bridge:
                positive = graph.node(
                    "easy deciiaH3SemanticBridgeApply",
                    id=f"bridge_first_{task_index}",
                    conditioning=positive,
                    semantic_bridge=bridge_link,
                ).out(0)
                if second_pass_positive is not positive:
                    second_pass_positive = graph.node(
                        "easy deciiaH3SemanticBridgeApply",
                        id=f"bridge_second_{task_index}",
                        conditioning=second_pass_positive,
                        semantic_bridge=bridge_link,
                    ).out(0)

            if (
                uses_context
                and previous_hires_context_latent is None
                and task_index > 0
            ):
                report_segment_step(0.14)
                loaded_hires_context = graph.node(
                    "easy h3ProjectContextLatentLoad",
                    id=f"load_hires_context_{task_index}",
                    project_name=safe_project_name,
                    segment_index=task_index - 1,
                    resolution="high",
                )
                previous_hires_context_latent = loaded_hires_context.out(0)
                if has_second_pass or is_selflift:
                    loaded_low_context = graph.node(
                        "easy h3ProjectContextLatentLoad",
                        id=f"load_low_context_{task_index}",
                        project_name=safe_project_name,
                        segment_index=task_index - 1,
                        resolution="low",
                    )
                    previous_low_context_latent = loaded_low_context.out(0)
                else:
                    previous_low_context_latent = previous_hires_context_latent
                report_segment_step(0.18)
            context_trim_frames: Any | None = None
            first_pass_context_trim_frames: Any | None = None
            first_pass_context_latent = (
                previous_low_context_latent
                if has_second_pass
                else previous_hires_context_latent
            )
            has_context_continuity = (
                uses_context
                and first_pass_context_latent is not None
            )
            # Lock task audio after the context source is known so its timeline
            # can be shifted behind the copied source prefix. The extra 12
            # generated frames required by H3's temporal grid are removed from
            # the tail after decoding, not from the task's opening frames.
            if has_task_locked_audio:
                report_segment_step(0.20)
                initial_latent = graph.node(
                    "easy minimaxH3AudioLock",
                    id=f"audio_lock_{task_index}",
                    latent=initial_latent,
                    audio_vae=audio_vae,
                    audio=task_locked_audio,
                    remix_strength=1.0,
                    short_audio_mode="silence",
                    prepend_frames=(
                        context_source_frames if has_context_continuity else 0
                    ),
                    frame_rate=fps,
                ).out(0)

            first_pass_sampling_model = model
            if is_dual_t8:
                # Deciia 2026-10-04：dual_t8 预构造（须早于 context_swap，
                # 让上下文连续段的噪声调度用双钟 sigmas 而非 preset sigmas）。
                dual_clock = graph.node(
                    "easy deciiaH3DualClockSampler",
                    id=f"dual_clock_{task_index}",
                    model=first_pass_sampling_model,
                    av_latent=initial_latent,
                    steps=8, shift_video=shift_video_override, shift_audio=shift_audio_override,
                    sampler_name="dual_clock_euler", scheduler="native_flow",
                )
                parity_plan = graph.node(
                    "easy deciiaH3TwoPassParityPlan",
                    id=f"parity_plan_{task_index}",
                    model=dual_clock.out(0),
                    base_steps=9, coarse_steps=4, refine_steps=5,
                )
                first_pass_sampler = dual_clock.out(1)
                first_pass_sigmas = parity_plan.out(0)
                dual_t8_refine_sigmas = parity_plan.out(1)
            if has_context_continuity:
                report_segment_step(0.22)
                if uses_swap:
                    context_swap = graph.node(
                        "easy MiniMaxH3ContextSwap",
                        id=f"first_pass_context_swap_noise_{task_index}",
                        model=model,
                        latent=initial_latent,
                        context_latent=first_pass_context_latent,
                        sigmas=first_pass_sigmas,
                        context_length=str(context_source_frames),
                        seed=(first_pass_seed + task_index) & 0xFFFFFFFFFFFFFFFF,
                        continue_audio=True,
                        freeze_audio=False,
                    )
                    first_pass_sampling_model = context_swap.out(0)
                    initial_latent = context_swap.out(1)
                    first_pass_context_trim_frames = context_swap.out(2)
                    context_trim_frames = first_pass_context_trim_frames
                else:
                    motion_context = graph.node(
                        "easy MiniMaxH3MotionContextHard",
                        id=f"hard_motion_context_{task_index}",
                        conditioning=positive,
                        vae=vae,
                        latent=initial_latent,
                        context_latent=first_pass_context_latent,
                        context_length=str(context_source_frames),
                        video_transition_steps=4,
                        audio_transition_steps=4,
                        video_anchor_only=not audio_only,
                    )
                    positive = motion_context.out(0)
                    first_pass_context_trim_frames = motion_context.out(1)
                    context_trim_frames = first_pass_context_trim_frames
                    initial_latent = motion_context.out(2)
            else:
                report_segment_step(0.22)

            report_segment_step(0.28)
            selflift_low_latent: Any | None = None
            if is_selflift:
                report_segment_step(0.38)
                selflift_inputs: dict[str, Any] = {
                    "model": first_pass_sampling_model,
                    "highres_model": (
                        second_model
                        if second_model_loader is not None
                        else first_pass_sampling_model
                    ),
                    "positive": positive,
                    "vae": vae,
                    "latent_image": initial_latent,
                    "sigmas": first_pass_sigmas,
                    "seed": first_pass_seed,
                    "transition_ratio": transition_ratio,
                    "transition_step": transition_step_override,
                    "upscaler_unload": upscaler_unload,
                    "lowres_scale": lowres_scale,
                    "rho": 0.1 if has_context_continuity else 0.0,
                    "w_max": w_max_override,
                    "w_min": w_min_override,
                    "upscaler_model": selected_upscale_model,
                    "enabled_tiling": tiling_enabled,
                    "tile_count": tile_count,
                }
                if has_sampling_preview:
                    selflift_inputs.update({
                        "preview_vae": preview_vae,
                        "preview_node_id": preview_node_id,
                        "generated_frame_count": task_length,
                        "preview_fps": fps,
                        "segment_index": task_index,
                        "sampling_pass": "selflift",
                    })
                if (
                    has_context_continuity
                    and previous_low_context_latent is not None
                ):
                    selflift_inputs["low_context_latent"] = previous_low_context_latent
                if previous_artifact is not None:
                    selflift_inputs["previous"] = previous_artifact
                selflift_sample = graph.node(
                    "easy minimaxH3SelfLiftSampler",
                    id=f"selflift_sample_{task_index}",
                    **selflift_inputs,
                )
                first_pass_latent = selflift_sample.out(0)
                selflift_low_latent = selflift_sample.out(1)
            else:
                if is_dual_t8:
                    # Deciia 2026-10-04：LBH 双钟一采 guider（DualClock/ParityPlan
                    # 已在 context_swap 前预构造）。
                    first_pass_guider = graph.node(
                        "BasicGuider",
                        id=f"first_pass_guider_{task_index}",
                        model=dual_clock.out(0),
                        conditioning=positive,
                    )
                else:
                    if use_multirate:
                        multirate = graph.node(
                            "easy minimaxH3MultiRateSampler",
                            id=f"multirate_{task_index}",
                            model=first_pass_sampling_model,
                            av_latent=initial_latent,
                            sigmas=first_pass_sigmas,
                            video_steps=multirate_video_steps,
                        )
                        first_pass_sampling_model = multirate.out(0)
                        first_pass_sampler = multirate.out(1)
                        first_pass_sigmas = multirate.out(2)
                    first_pass_guider = graph.node(
                        "BasicGuider",
                        id=f"first_pass_guider_{task_index}",
                        model=first_pass_sampling_model,
                        conditioning=positive,
                    )
                if task_index == resume_task_index:
                    report_segment_step(0.38)
                    first_pass_latent = graph.node(
                        "easy h3ProjectContextLatentLoad",
                        id=f"resume_first_pass_{task_index}",
                        project_name=safe_project_name,
                        segment_index=task_index,
                    ).out(0)
                else:
                    report_segment_step(0.32)
                    first_pass_noise = graph.node(
                        "RandomNoise",
                        id=f"first_pass_noise_{task_index}",
                        noise_seed=first_pass_seed,
                    )
                    report_segment_step(0.38)
                    sampling_inputs: dict[str, Any] = {
                        "noise": first_pass_noise.out(0),
                        "guider": first_pass_guider.out(0),
                        "sampler": first_pass_sampler,
                        "sigmas": first_pass_sigmas,
                        "latent_image": initial_latent,
                        "project_name": safe_project_name,
                        "segment_index": task_index,
                    }
                    if previous_artifact is not None:
                        sampling_inputs["previous"] = previous_artifact
                    sampling_start = graph.node(
                        "easy h3SegmentSamplingStart",
                        id=f"sampling_start_{task_index}",
                        sampling_pass="first",
                        **sampling_inputs,
                    )
                    preview_inputs = (
                        {
                            "preview_vae": preview_vae,
                            "preview_node_id": preview_node_id,
                            "generated_frame_count": task_length,
                            "preview_fps": fps,
                            "segment_index": task_index,
                            "sampling_pass": "first",
                        }
                        if has_sampling_preview
                        else {}
                    )
                    first_pass_sample = graph.node(
                        "easy h3SamplingPreviewSampler"
                        if has_sampling_preview
                        else "SamplerCustomAdvanced",
                        id=f"first_pass_sample_{task_index}",
                        noise=sampling_start.out(0),
                        guider=sampling_start.out(1),
                        sampler=sampling_start.out(2),
                        sigmas=sampling_start.out(3),
                        latent_image=sampling_start.out(4),
                        **preview_inputs,
                    )
                    first_pass_latent = first_pass_sample.out(1)
            final_latent = first_pass_latent
            report_segment_step(0.42)

            if run_second_pass:
                segment_second_pass_sigmas = second_pass_sigmas
                if (
                    uses_context
                    and previous_hires_context_latent is not None
                    and context_second_pass_sigmas is not None
                ):
                    segment_second_pass_sigmas = context_second_pass_sigmas
                if audio_only or upscale_by <= 1:
                    report_segment_step(0.46)
                    upscaled_latent = final_latent
                else:
                    report_segment_step(0.45)
                    separated = graph.node(
                        "LTXVSeparateAVLatent",
                        id=f"separate_first_pass_{task_index}",
                        av_latent=final_latent,
                    )
                    if selected_upscale_model != "None":
                        report_segment_step(0.50)
                        upscaled_video = graph.node(
                            "easy minimaxH3LatentUpscaler",
                            id=f"latent_upscale_{task_index}",
                            **_h3_latent_upscale_inputs(
                                separated.out(0),
                                selected_upscale_model,
                                target_width,
                                target_height
                            ),
                        )
                        video_latent = upscaled_video.out(0)
                    else:
                        report_segment_step(0.48)
                        first_pass_images = graph.node(
                            "VAEDecode",
                            id=f"first_pass_decode_{task_index}",
                            samples=separated.out(0),
                            vae=vae,
                        )
                        report_segment_step(0.51)
                        resized = graph.node(
                            "ImageResizeKJv2",
                            id=f"first_pass_resize_{task_index}",
                            **_h3_image_resize_inputs(
                                first_pass_images.out(0),
                                target_width,
                                target_height,
                            ),
                        )
                        report_segment_step(0.54)
                        encoded_video = graph.node(
                            "VAEEncode",
                            id=f"first_pass_reencode_{task_index}",
                            pixels=resized.out(0),
                            vae=vae,
                        )
                        video_latent = encoded_video.out(0)

                    report_segment_step(0.57)
                    upscaled_latent = graph.node(
                        "LTXVConcatAVLatent",
                        id=f"first_pass_recombine_{task_index}",
                        video_latent=video_latent,
                        audio_latent=separated.out(1),
                    ).out(0)

                second_pass_sampling_model = second_model
                if (
                    uses_context
                    and previous_hires_context_latent is not None
                ):
                    report_segment_step(0.59)
                    # Second pass is deliberately kept as an ordinary hi-res refine path.
                    # No context noise, no split-prior, and no Drift-Control patching here.
                    hires_continuity = graph.node(
                        "easy MiniMaxH3HiResContinuity",
                        id=f"hires_continuity_{task_index}",
                        current_hires_latent=upscaled_latent,
                        previous_hires_latent=previous_hires_context_latent,
                        context_length=str(H3_CONTEXT_SOURCE_FRAMES),
                        video_transition_steps=4,
                        video_anchor_only=not audio_only,
                    )
                    upscaled_latent = hires_continuity.out(0)
                    context_trim_frames = hires_continuity.out(1)

                report_segment_step(0.62)
                second_pass_noise = graph.node(
                    "DisableNoise" if disable_2nd_noise else "RandomNoise",
                    id=f"second_pass_noise_{task_index}",
                    **({} if disable_2nd_noise else {"noise_seed": second_pass_seed}),
                )
                report_segment_step(0.66)
                if is_dual_t8:
                    # Deciia 2026-10-04：LBH 二采（T8 fork）。
                    # Reconcile(放大latent ↔ 二采模板latent) → DetailMixer(refine_sigmas)。
                    _highres_template = (
                        second_pass_template_latent
                        if second_pass_template_latent is not None
                        else initial_latent
                    )
                    reconcile = graph.node(
                        "easy deciiaH3TwoPassLatentReconcile",
                        id=f"reconcile_{task_index}",
                        learned_latent=upscaled_latent,
                        highres_template=_highres_template,
                        positive=second_pass_positive,
                        audio_policy="auto",
                        second_pass_audio_source="legacy_policy",
                        second_pass_audio_strength=0.0,
                    )
                    upscaled_latent = reconcile.out(0)
                    second_pass_positive = reconcile.out(1)
                    detail_mixer = graph.node(
                        "easy deciiaH3TwoPassDetailMixer",
                        id=f"detail_mixer_{task_index}",
                        model=second_pass_sampling_model,
                        av_latent=upscaled_latent,
                        refine_sigmas=dual_t8_refine_sigmas,
                        shift_video=shift_video_override, shift_audio=shift_audio_override,
                        enable_tail=False, extra_tail_steps=3, tail_spacing="video_sigma_linear",
                        enable_model_time_bias=False, bias=-0.025,
                        bias_start_progress=0.7, bias_end_progress=0.95, bias_domain="video_sigma",
                        enable_stg=False, stg_scale=0.35, stg_double_blocks="25",
                        stg_start_progress=0.25, stg_end_progress=0.85,
                        enable_restart=False, restart_video_sigma=0.15, restart_steps=3,
                        restart_seed=2608193401,
                    )
                    second_pass_guider = graph.node(
                        "BasicGuider",
                        id=f"second_pass_guider_{task_index}",
                        model=detail_mixer.out(0),
                        conditioning=second_pass_positive,
                    )
                    second_pass_sampler = detail_mixer.out(1)
                    segment_second_pass_sigmas = detail_mixer.out(2)
                else:
                    second_pass_guider = graph.node(
                        "BasicGuider",
                        id=f"second_pass_guider_{task_index}",
                        model=second_pass_sampling_model,
                        conditioning=second_pass_positive,
                    )
                report_segment_step(0.71)
                second_sampling_start = graph.node(
                    "easy h3SegmentSamplingStart",
                    id=f"second_sampling_start_{task_index}",
                    noise=second_pass_noise.out(0),
                    guider=second_pass_guider.out(0),
                    sampler=second_pass_sampler,
                    sigmas=segment_second_pass_sigmas,
                    latent_image=upscaled_latent,
                    project_name=safe_project_name,
                    segment_index=task_index,
                    sampling_pass="second",
                )
                second_preview_inputs = (
                    {
                        "preview_vae": preview_vae,
                        "preview_node_id": preview_node_id,
                        "generated_frame_count": task_length,
                        "preview_fps": fps,
                        "segment_index": task_index,
                        "sampling_pass": "second",
                    }
                    if has_sampling_preview
                    else {}
                )
                if tiling_enabled:
                    second_preview_inputs.update({
                        "enabled_tiling": True,
                        "tile_count": tile_count,
                    })
                second_pass_sample = graph.node(
                    "easy h3SamplingPreviewSampler"
                    if has_sampling_preview or tiling_enabled
                    else "SamplerCustomAdvanced",
                    id=f"second_pass_sample_{task_index}",
                    noise=second_sampling_start.out(0),
                    guider=second_sampling_start.out(1),
                    sampler=second_sampling_start.out(2),
                    sigmas=second_sampling_start.out(3),
                    latent_image=second_sampling_start.out(4),
                    **second_preview_inputs,
                )
                final_latent = second_pass_sample.out(1)
            else:
                report_segment_step(0.71)

            low_stage_context_latent = (
                selflift_low_latent
                if is_selflift and selflift_low_latent is not None
                else first_pass_latent
                if has_second_pass
                else final_latent
            )
            hires_context_reencoded = False
            low_context_reencoded = False
            if audio_only:
                output_audio = graph.node(
                    "VAEDecodeAudio",
                    id=f"decode_audio_{task_index}",
                    samples=final_latent,
                    vae=audio_vae,
                ).out(0)
                project_hires_context_latent = final_latent
                project_low_context_latent = low_stage_context_latent
                if context_trim_frames is not None:
                    output_audio, project_hires_context_latent = _h3_encode_audio_context(
                        graph, output_audio, audio_vae, context_trim_frames,
                        base_task_length, fps, not has_task_locked_audio,
                        f"hires_audio_context_{task_index}",
                    )
                    if (has_second_pass and run_second_pass) or (
                        is_selflift and selflift_low_latent is not None
                    ):
                        low_audio = graph.node(
                            "VAEDecodeAudio", id=f"low_audio_context_decode_{task_index}",
                            samples=low_stage_context_latent, vae=audio_vae,
                        ).out(0)
                        _, project_low_context_latent = _h3_encode_audio_context(
                            graph, low_audio, audio_vae, first_pass_context_trim_frames,
                            base_task_length, fps, not has_task_locked_audio,
                            f"low_audio_context_{task_index}",
                        )
                    else:
                        project_low_context_latent = project_hires_context_latent

                report_segment_step(0.89)
                saved_audio = output_audio
                if has_task_locked_audio:
                    saved_audio = graph.node(
                        "easy h3LockedAudioSelect",
                        id=f"locked_audio_select_{task_index}",
                        generated_audio=output_audio,
                        locked_audio=task_locked_audio,
                    ).out(0)
                saved_media_inputs = {
                    "audio": saved_audio,
                }
            else:
                report_segment_step(0.76)
                if is_image_first:
                    if has_output_vae:
                        # 2026-11-07：图片模式也支持 HyperVAE 2× ——
                        # 与视频路径一样先 cleanGpuUsed 腾显存，再用 AVDecode 拆出
                        # video_latent（HyperVAE 只吃 [B,24,T,H,W]，拒绝 AV 合并 latent），
                        # 最后交给 HyperVAE 解码出 2× 分辨率的帧。
                        cleaned_latent = graph.node(
                            "easy cleanGpuUsed",
                            id=f"pre_decode_clean_{task_index}",
                            anything=final_latent,
                        ).out(0)
                        av_decoded = graph.node(
                            "easy deciiaH3AVDecode",
                            id=f"av_decode_{task_index}",
                            av_latent=cleaned_latent,
                            video_vae=vae,
                            audio_vae=audio_vae,
                            decode_video=False,
                        )
                        hyper_decoded = graph.node(
                            "VAEDecode",
                            id=f"hyper_decode_{task_index}",
                            samples=av_decoded.out(2),
                            vae=output_vae_link,
                        )
                        output_images = hyper_decoded.out(0)
                    else:
                        decoded_images = graph.node(
                            "VAEDecode",
                            id=f"decode_image_frames_{task_index}",
                            samples=final_latent,
                            vae=vae,
                        )
                        output_images = decoded_images.out(0)
                    output_audio = None
                elif has_output_vae:
                    # Deciia 2026-10-05：对齐 P8a 拓扑 —— 采样结束后先
                    # cleanGpuUsed（清节点缓存+卸载模型+清 CUDA 缓存）再进解码，
                    # 给 HyperVAE 2× 腾出显存/内存余量（P8a #900038 同款位置）。
                    cleaned_latent = graph.node(
                        "easy cleanGpuUsed",
                        id=f"pre_decode_clean_{task_index}",
                        anything=final_latent,
                    ).out(0)
                    # AVDecode 只做 AV 拆分（视频用原生 VAE，返回 video_latent），
                    # HyperVAE 2× 走 comfy 原生 VAEDecode（自带 OOM 回退 tiled、
                    # 分批与预分配缓冲）。音频取 generated_audio（P8a 同款）。
                    av_decoded = graph.node(
                        "easy deciiaH3AVDecode",
                        id=f"av_decode_{task_index}",
                        av_latent=cleaned_latent,
                        video_vae=vae,
                        audio_vae=audio_vae,
                        decode_video=False,
                    )
                    hyper_decoded = graph.node(
                        "VAEDecode",
                        id=f"hyper_decode_{task_index}",
                        samples=av_decoded.out(2),
                        vae=output_vae_link,
                    )
                    output_images = hyper_decoded.out(0)
                    output_audio = av_decoded.out(1)
                else:
                    decoded_images = graph.node(
                        "VAEDecode",
                        id=f"decode_video_{task_index}",
                        samples=final_latent,
                        vae=vae,
                    )
                    report_segment_step(0.80)
                    decoded_audio = graph.node(
                        "VAEDecodeAudio",
                        id=f"decode_audio_{task_index}",
                        samples=final_latent,
                        vae=audio_vae,
                    )
                    output_images = decoded_images.out(0)
                    output_audio = decoded_audio.out(0)
                if context_trim_frames is not None or preserve_source_timing:
                    report_segment_step(0.84)
                    trimmed = graph.node(
                        "easy h3ContextMediaTrim",
                        id=f"motion_context_trim_{task_index}",
                        images=output_images,
                        audio=output_audio,
                        trim_frames=(
                            context_trim_frames if context_trim_frames is not None else 0
                        ),
                        output_frames=base_task_length,
                        pad_audio=not has_task_locked_audio,
                        **(
                            {"fit_video_duration": True}
                            if fit_locked_video_timing
                            else {}
                        ),
                        fps=fps,
                    )
                    output_images = trimmed.out(0)
                    output_audio = trimmed.out(1)
                else:
                    report_segment_step(0.84)

                if has_task_locked_audio:
                    locked_audio_align = graph.node(
                        "easy h3LockedAudioDurationAlign",
                        id=f"locked_audio_duration_align_{task_index}",
                        images=output_images,
                        audio=output_audio,
                        fps=fps,
                    )
                    output_audio = locked_audio_align.out(0)

                saved_audio = output_audio
                if has_task_locked_audio:
                    saved_audio = graph.node(
                        "easy h3LockedAudioSelect",
                        id=f"locked_audio_select_{task_index}",
                        generated_audio=output_audio,
                        locked_audio=task_locked_audio,
                    ).out(0)

                project_hires_context_latent = final_latent
                project_low_context_latent = low_stage_context_latent
                low_delivered_images: Any | None = None
                if context_trim_frames is not None or preserve_source_timing:
                    # Rebuild continuity from the delivered span after removing
                    # the optional context head and temporal-grid tail.
                    project_hires_context_latent = _h3_encode_context_media(
                        graph,
                        output_images,
                        output_audio,
                        vae,
                        audio_vae,
                        f"hires_context_{task_index}",
                    )
                    hires_context_reencoded = True
                    if (has_second_pass and run_second_pass) or (
                        is_selflift and selflift_low_latent is not None
                    ):
                        low_context_images = graph.node(
                            "VAEDecode",
                            id=f"low_context_video_decode_{task_index}",
                            samples=low_stage_context_latent,
                            vae=vae,
                        )
                        low_context_audio = graph.node(
                            "VAEDecodeAudio",
                            id=f"low_context_audio_decode_{task_index}",
                            samples=low_stage_context_latent,
                            vae=audio_vae,
                        )
                        low_context_media = graph.node(
                            "easy h3ContextMediaTrim",
                            id=f"low_context_trim_{task_index}",
                            images=low_context_images.out(0),
                            audio=low_context_audio.out(0),
                            trim_frames=(
                                first_pass_context_trim_frames
                                if first_pass_context_trim_frames is not None
                                else 0
                            ),
                            output_frames=base_task_length,
                            **(
                                {"fit_video_duration": True}
                                if fit_locked_video_timing
                                else {}
                            ),
                            fps=fps,
                        )
                        low_delivered_images = low_context_media.out(0)
                        project_low_context_latent = _h3_encode_context_media(
                            graph,
                            low_context_media.out(0),
                            low_context_media.out(1),
                            vae,
                            audio_vae,
                            f"low_context_{task_index}",
                        )
                        low_context_reencoded = True
                    else:
                        project_low_context_latent = project_hires_context_latent
                        low_context_reencoded = hires_context_reencoded
                report_segment_step(0.89)
                # Keep decoded audio for latent continuity, but deliver the original
                # task audio in the video so the project needs no separate WAV.
                saved_video = graph.node(
                    "easy saveVideo",
                    id=f"save_video_{task_index}",
                    input_mode="images+audio",
                    # 本地 video.py 已把 DynamicCombo 换成扁平普通下拉 + 固定输入，
                    # 因此这里必须传扁平键（原 input_mode.images/audio/fps 点前缀只在
                    # DynamicCombo 形式下合法，会报 unexpected keyword argument）。
                    images=output_images,
                    **( {"audio": saved_audio} if saved_audio is not None else {} ),
                    fps=fps,
                    output_mode="hide&save",
                    filename_prefix=(
                        f"easy_media/projects/{safe_project_name}/"
                        f".staging_video_{task_index}"
                    ),
                )
                saved_video_end = graph.node(
                    "easy h3SegmentSaveEnd",
                    id=f"save_end_{task_index}",
                    # saveVideo 输出槽顺序：0 图像 / 1 视频 / 2 音频 / 3 文件路径。
                    # 这里要的是磁盘上的暂存文件路径（STRING），不是 VIDEO 对象。
                    video_path=saved_video.out(3),
                    project_name=safe_project_name,
                    segment_index=task_index,
                )
                saved_media_inputs = {"video_path": saved_video_end.out(0)}

            saved_hires_context_latent = project_hires_context_latent
            saved_low_context_latent = project_low_context_latent
            hires_trim_inputs: dict[str, Any] = {
                "latent": saved_hires_context_latent,
                "context_length": str(context_source_frames),
            }
            if not audio_only and not hires_context_reencoded:
                hires_trim_inputs.update({"anchor_images": output_images, "vae": vae})
            runtime_hires_context_latent = graph.node(
                "easy h3MotionContextLatentTrim",
                id=f"trim_hires_context_latent_{task_index}",
                **hires_trim_inputs,
            ).out(0)
            if has_second_pass or is_selflift:
                low_trim_inputs: dict[str, Any] = {
                    "latent": saved_low_context_latent,
                    "context_length": str(context_source_frames),
                }
                if not audio_only and not low_context_reencoded:
                    low_anchor_images = low_delivered_images
                    if low_anchor_images is None:
                        if (has_second_pass and run_second_pass) or (
                            is_selflift and selflift_low_latent is not None
                        ):
                            low_anchor_images = graph.node(
                                "VAEDecode",
                                id=f"low_anchor_decode_video_{task_index}",
                                samples=low_stage_context_latent,
                                vae=vae,
                            ).out(0)
                        else:
                            low_anchor_images = output_images
                    low_trim_inputs.update(
                        {"anchor_images": low_anchor_images, "vae": vae}
                    )
                runtime_low_context_latent = graph.node(
                    "easy h3MotionContextLatentTrim",
                    id=f"trim_low_context_latent_{task_index}",
                    **low_trim_inputs,
                ).out(0)
            else:
                runtime_low_context_latent = runtime_hires_context_latent
            completed_sampling_pass = (
                "first"
                if first_pass_only and has_second_pass
                else "second"
                if has_second_pass
                else "single"
            )
            # A pass-two resume needs the full sampled span, while continuity
            # uses the re-encoded delivered span (also saved as low context).
            checkpoint_latent = (
                first_pass_latent if preserve_source_timing else saved_hires_context_latent
            )
            artifact_inputs: dict[str, Any] = {
                "project_name": safe_project_name,
                "project_save": project_save,
                "segment_index": task_index,
                "context_latent": (
                    checkpoint_latent
                    if completed_sampling_pass == "first"
                    else runtime_hires_context_latent
                ),
                **saved_media_inputs,
                "tracks_info": output_info,
                "continuity_mode": continuity_mode,
                "seed": first_pass_seed,
                "sampling_pass": completed_sampling_pass,
            }
            if has_second_pass or is_selflift:
                artifact_inputs["context_latent_low"] = (
                    saved_low_context_latent
                    if completed_sampling_pass == "first"
                    else runtime_low_context_latent
                )
            if previous_artifact is not None:
                artifact_inputs["previous"] = previous_artifact
            report_segment_step(0.95)
            artifact = graph.node(
                "easy h3ProjectArtifact",
                id=f"artifact_{task_index}",
                **artifact_inputs,
            )
            previous_artifact = artifact.out(0)
            last_project_output = artifact.out(0)
            previous_hires_context_latent = runtime_hires_context_latent
            previous_low_context_latent = runtime_low_context_latent
            segment_nodes.update({
                node_id: task_index
                for node_id in graph.nodes.keys() - previous_graph_nodes
            })
            report_segment_step(1.0)

        if last_project_output is None:
            log_node_info(node_name, "Project graph produced no task output")
            raise RuntimeError("H3 project graph produced no task output")
        report_step(100)
        return io.NodeOutput(
            last_project_output,
            full_locked_audio,
            str(sampling_mode or ""),
            expand=_timed_h3_project_graph(graph, safe_project_name, segment_nodes),
        )


def _h3_audio_payload(path: Any) -> dict[str, Any]:
    """把合成好的 WAV 读成 ComfyUI AUDIO 结构：[1, C, T] + sample_rate。"""
    import soundfile as sf
    import torch

    waveform, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    tensor = torch.from_numpy(waveform.T).unsqueeze(0)
    return {"waveform": tensor, "sample_rate": int(sample_rate)}


class EasyH3CameraPromptInject(io.ComfyNode):
    """把项目相机轨里与当前段重叠的运镜描述注入提示词（不改变其它字段）。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy h3CameraPromptInject",
            display_name="相机提示词注入",
            category="EasyMedia",
            description="读取项目相机轨，把运镜描述插入 detailed_description 开头。",
            inputs=[
                io.String.Input("prompt"),
                io.String.Input("project_name", default=""),
                io.Int.Input("start_frame", default=0, min=0),
                io.Int.Input("end_frame", default=0, min=0),
            ],
            outputs=[io.String.Output(display_name="提示词")],
        )

    @classmethod
    def execute(cls, prompt: str, project_name: str = "", start_frame: int = 0,
                end_frame: int = 0) -> io.NodeOutput:
        camera = h3_camera_prompt_for_range(project_name, start_frame, end_frame)
        return io.NodeOutput(inject_h3_camera_prompt(prompt, camera))


class EasyH3CameraPlayblast(io.ComfyNode):
    """读取项目相机轨的预演视频，输出视频/帧/运镜提示词（层B 手工接线用）。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy h3CameraPlayblast",
            display_name="相机预演（OmniCam）",
            category="EasyMedia",
            description="读取相机轨的预演视频与运镜描述，可接到 H3 的参考视频/参考帧。",
            inputs=[
                io.String.Input("project_name", default=""),
                io.Int.Input("start_frame", default=0, min=0),
                io.Int.Input("end_frame", default=0, min=0),
                io.String.Input("playblast_path", default="", optional=True),
            ],
            outputs=[
                io.Video.Output(display_name="预演视频"),
                io.Image.Output(display_name="预演帧"),
                io.String.Output(display_name="运镜提示词"),
                io.String.Output(display_name="轨迹 JSON"),
            ],
        )

    @classmethod
    def execute(cls, project_name: str = "", start_frame: int = 0, end_frame: int = 0,
                playblast_path: str = "") -> io.NodeOutput:
        import json as _json
        import os

        from ..utils.camera_omnicam import compile_camera_motion_scene, compile_camera_prompt
        from ..utils.h3_project import inject_h3_camera_prompt  # noqa: F401
        from ..utils.h3_timeline import load_timeline

        camera: dict = {}
        frames = max(2, int(end_frame or 0) - int(start_frame or 0) or 120)
        try:
            timeline = load_timeline(project_name)
            tracks = (timeline.get("track_data") or {}).get("tracks") or []
            for track in tracks:
                if not isinstance(track, dict) or track.get("type") != "camera":
                    continue
                for segment in track.get("segments") or []:
                    seg_start = int(segment.get("start_frame") or 0)
                    seg_end = int(segment.get("end_frame") or seg_start)
                    if seg_end <= int(start_frame) or seg_start >= int(end_frame):
                        continue
                    camera = segment.get("camera") or (segment.get("content") or {}).get("camera") or {}
        except Exception:
            camera = camera if isinstance(camera, dict) else {}
        prompt = str((camera or {}).get("compiled_prompt") or "").strip()
        if not prompt:
            prompt = compile_camera_prompt(camera, fps=24, frames=frames)
        scene = compile_camera_motion_scene(camera, fps=24, frames=frames)

        video = None
        path = str(playblast_path or (camera or {}).get("playblast") or "").strip()
        if path:
            from comfy_api.latest import InputImpl
            import folder_paths

            candidates = [
                path,
                os.path.join(folder_paths.get_input_directory(), path),
                os.path.join(folder_paths.get_output_directory(), path),
            ]
            for candidate in candidates:
                if os.path.isfile(candidate):
                    try:
                        video = InputImpl.VideoFromFile(candidate)
                    except Exception:
                        video = None
                    break
        frames_out = None
        if video is not None:
            try:
                frames_out, _audio, _fps = video.get_components()
            except Exception:
                frames_out = None
        return io.NodeOutput(video, frames_out, prompt, _json.dumps(scene, ensure_ascii=False))


class EasyMultiTrackProjectVideoCombine(io.ComfyNode):
    """Combine a project timeline configured by the React project widget."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy multitrackProjectVideoCombine",
            display_name="MultiTrack Project Video Combine",
            category="EasyUse/MultiTrackEditor",
            description=(
                "Preview and combine the active videos from a MultiTrack project."
            ),
            inputs=[
                io.String.Input("project_name", force_input=True),
                TYPE_PROJECT_DATA.Input("project_data"),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[
                io.String.Output("FILENAME_PREFIX", display_name="文件名前缀"),
                io.Video.Output("VIDEO", display_name="视频"),
                TYPE_EASY_MEDIA.Output("MEDIA", display_name="多媒体"),
                io.Audio.Output("AUDIO", display_name="音频"),
                io.Image.Output("IMAGES", display_name="图片流", is_output_list=True),
            ],
            not_idempotent=True,
        )

    @classmethod
    def execute(cls, project_name: str, project_data: Any) -> io.NodeOutput:
        data = project_data
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError as error:
                raise ValueError(f"project_data is not valid JSON: {error}") from error
        if not isinstance(data, dict):
            raise TypeError("project_data must contain a dictionary or JSON object")
        auto_combine = data.get("auto_combine", True) is not False
        safe_name = safe_h3_project_name(project_name)
        if safe_h3_project_name(data.get("project_name")) != safe_name:
            data = {"project_name": safe_name, "clips": []}
        try:
            from server import PromptServer

            PromptServer.instance.send_sync(
                "easy-media.project.selected",
                {
                    "node_id": str(
                        getattr(getattr(cls, "hidden", None), "unique_id", "")
                    ),
                    "project_name": safe_name,
                },
            )
        except (AttributeError, ImportError, RuntimeError) as error:
            print(  # noqa: T201 - rendering must not fail when UI notifications are unavailable
                f"[Easy Media][Project] Unable to notify the frontend: {error}"
            )
        if not auto_combine:
            blocker = ExecutionBlocker(None)
            return io.NodeOutput(blocker, blocker, blocker, blocker, blocker)
        fresh_data = load_h3_project_data(safe_name)
        if fresh_data.get("image_first"):
            images = compose_h3_project_images(safe_name, data)
            # 图片流槽是 output_list：ComfyUI 会把列表逐项展开成多次下游执行。
            # 2026-11-14：整批作为「单元素列表」输出，下游一次拿到 [N,H,W,C]。
            # 原实现拆成每帧 [1,H,W,C]，导致「保存媒体」每次只看到 1 张，
            # 图片转视频阈值永远不触发（用户报 24 帧仍存图）。
            # 整批输出后：保存节点能数到 N 帧存视频；超分节点内部仍按帧循环。
            image_list = [images]
            # 2026-11-14：未使用的视频/音频槽不再返回 ExecutionBlocker。
            # 核心 execution.process_inputs 判定「任一输入是 blocker 就整节点阻断」
            # （不区分是否可选），图片流槽接给「超分调度」等带可选音频口的节点时，
            # 会让整个下游被静默跳过。改为 None：下游拿不到媒体，保存节点自行空转。
            return io.NodeOutput(
                h3_project_filename_prefix(safe_name),
                None,
                images,
                None,
                image_list,
            )
        if fresh_data.get("audio_only"):
            composed_audio = compose_h3_project_audio(safe_name, data)
            audio_payload = _h3_audio_payload(composed_audio)
            try:
                from server import PromptServer

                PromptServer.instance.send_sync(
                    "easy-media.project.audio",
                    {
                        "project_name": safe_name,
                        "path": str(composed_audio),
                        "filename": composed_audio.name,
                        "subfolder": composed_audio.parent.relative_to(
                            Path(folder_paths.get_output_directory())
                        ).as_posix(),
                    },
                )
            except (AttributeError, ImportError, RuntimeError, ValueError):
                pass
            return io.NodeOutput(
                h3_project_filename_prefix(safe_name),
                None,
                audio_payload,
                audio_payload,
                None,
            )
        composed_path = compose_h3_project_video(safe_name, data)
        composed_video = InputImpl.VideoFromFile(str(composed_path))
        # 2026-11-10（用户需求）：音频槽在视频工程下也输出成片音轨；
        # 图片流槽改为按工程类型输出——图片工程出候选帧，
        # 视频工程出合并视频的每一帧。
        from ..utils.video import decode_video_frames_to_tensors, extract_video_audio

        video_audio = extract_video_audio(composed_video)
        if video_audio is None:
            print("[EasyMedia] 合并视频无音轨：音频输出为空")
        try:
            video_frames = decode_video_frames_to_tensors(composed_path)
        except (RuntimeError, OSError) as error:
            print(f"[EasyMedia] 视频帧解码失败，图片流为空：{error}")
            video_frames = None
        return io.NodeOutput(
            h3_project_filename_prefix(safe_name),
            composed_video,
            composed_video,
            video_audio,
            video_frames,
        )
