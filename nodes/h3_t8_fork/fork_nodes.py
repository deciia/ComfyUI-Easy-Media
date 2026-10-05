"""Deciia H3 T8 fork — DualClock / AVDecode 节点壳。

来源: comfyui-minimax-h3-audio-T8 (t8star) h3_t8/nodes.py 两类，
2026-10-04 摘取搬运。仅改: 节点 id 改 easy deciia* 前缀；
核心实现改指 fork 内模块；算法调用未改。
"""
from __future__ import annotations

from comfy_api.latest import io

from .fork_dual_clock import (
    DEFAULT_SAMPLER_NAME,
    DEFAULT_SCHEDULER_NAME,
    SAMPLER_OPTIONS,
    SCHEDULER_OPTIONS,
    setup_dual_clock_sampling,
)
from .fork_common import decode_av_latent

CATEGORY = "EasyUse/H3/T8fork"


class MiniMaxH3DualClockSamplerT8(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy deciiaH3DualClockSampler",
            display_name="Deciia H3 Dual-Clock Sampler (T8 fork)",
            description=(
                "MiniMax H3 sampling setup with separate video/audio clocks. "
                "The default dual_clock_euler + native_flow path is unchanged; other ComfyUI "
                "samplers use native FLOW_AV support."
            ),
            category=CATEGORY,
            inputs=[
                io.Model.Input("model"),
                io.Latent.Input("av_latent"),
                io.Int.Input("steps", default=4, min=1, max=1000),
                io.Float.Input("shift_video", default=12.0, min=0.01, max=100.0, step=0.01, advanced=True),
                io.Float.Input("shift_audio", default=3.0, min=0.01, max=100.0, step=0.01, advanced=True),
                io.Combo.Input(
                    "sampler_name",
                    options=SAMPLER_OPTIONS,
                    default=DEFAULT_SAMPLER_NAME,
                    optional=True,
                    display_name="sampler / 采样器",
                    tooltip=(
                        "dual_clock_euler preserves the original T8 explicit dual-clock path. "
                        "Other choices use ComfyUI's native MiniMax H3 FLOW_AV protocol."
                    ),
                ),
                io.Combo.Input(
                    "scheduler",
                    options=SCHEDULER_OPTIONS,
                    default=DEFAULT_SCHEDULER_NAME,
                    optional=True,
                    display_name="scheduler / 调度器",
                    tooltip=(
                        "native_flow preserves the original shifted uniform H3 flow schedule. "
                        "beta57 uses ComfyUI's beta scheduler with alpha=0.5 and beta=0.7. "
                        "Other choices use ComfyUI's built-in scheduler implementation."
                    ),
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model"),
                io.Sampler.Output(display_name="sampler"),
                io.Sigmas.Output(display_name="sigmas"),
            ],
        )

    @classmethod
    def execute(
        cls,
        model,
        av_latent,
        steps,
        shift_video,
        shift_audio,
        sampler_name=DEFAULT_SAMPLER_NAME,
        scheduler=DEFAULT_SCHEDULER_NAME,
    ):
        return io.NodeOutput(*setup_dual_clock_sampling(
            model,
            av_latent,
            steps,
            shift_video,
            shift_audio,
            sampler_name,
            scheduler,
        ))


class MiniMaxH3AVDecodeT8(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy deciiaH3AVDecode", display_name="Deciia H3 AV 解码 (T8 fork)", category=CATEGORY,
            inputs=[io.Latent.Input("av_latent"), io.Vae.Input("video_vae"), io.Vae.Input("audio_vae"),
                    io.Boolean.Input("decode_video", default=True)],
            outputs=[io.Image.Output("frames"), io.Audio.Output("generated_audio"),
                     io.Latent.Output("video_latent"), io.Latent.Output("audio_latent")],
        )

    @classmethod
    def execute(cls, av_latent, video_vae, audio_vae, decode_video=True):
        return io.NodeOutput(*decode_av_latent(av_latent, video_vae, audio_vae, decode_video=decode_video))

