"""Deciia H3 T8 fork — HyperVAE 2×。

来源: comfyui-minimax-h3-audio-T8 (t8star) h3_t8/hyper_vae_2x.py、
nodes_hyper_vae_2x.py，2026-10-04 全文搬运。
仅改: 节点 id 改 easy deciia* 前缀；内部导入合一；算法本体未改动。
"""
from __future__ import annotations

import json
from pathlib import Path
from types import MethodType

import torch
import torch.nn.functional as F
from safetensors import safe_open

from comfy_api.latest import io

CATEGORY = "EasyUse/H3/T8fork"

# ── hyper_vae_2x.py ──
"""Load the MiniMax H3 packed-RGB 2x VAE without patching ComfyUI core."""





PROJECTION_WEIGHT_SHAPE = (12_288, 2_048)
PROJECTION_BIAS_SHAPE = (12_288,)
RGB_PHASES = 4


def inspect_hyper_vae_2x(path: str | Path) -> dict:
    """Reject incompatible files from the safetensors header before loading 5 GB."""
    candidate = Path(path).expanduser().resolve(strict=True)
    if not candidate.is_file() or candidate.suffix.lower() != ".safetensors":
        raise ValueError("请选择 MiniMax H3 HyperVAE 2x 的 .safetensors 文件")
    with safe_open(str(candidate), framework="pt", device="cpu") as weights:
        keys = set(weights.keys())
        required = {
            "decoder.proj_out.weight": PROJECTION_WEIGHT_SHAPE,
            "decoder.proj_out.bias": PROJECTION_BIAS_SHAPE,
            "latents_mean": (24,),
            "latents_std": (24,),
        }
        for key, shape in required.items():
            if key not in keys or tuple(weights.get_slice(key).get_shape()) != shape:
                raise ValueError(f"不是支持的 H3 2x VAE：{key} 形状不匹配")
        if "encoder.down.5.block.0.conv1.weight" not in keys:
            raise ValueError("不是完整的 MiniMax H3 视频 VAE：缺少 encoder")
        metadata = weights.metadata() or {}
    try:
        adapter = json.loads(metadata["minimax_h3_x2_adapter"])
        video = json.loads(metadata["minimax_h3_video_vae"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("缺少 HyperVAE MiniMax 2x 元数据") from exc
    if (adapter.get("version") != 1 or adapter.get("packed_output_channels") != 12
            or adapter.get("pixel_shuffle_factor") != 2
            or adapter.get("encoder_unchanged") is not True
            or video.get("decoder_pixel_shuffle_factor") != 2
            or video.get("packed_decoder_output_channels") != 12):
        raise ValueError("HyperVAE 2x 元数据不符合当前解码合同")
    return {
        "path": str(candidate),
        "size_bytes": candidate.stat().st_size,
        "packed_channels": 12,
        "decode_scale": 2,
        "encode_scale": 16,
        "decode_scale_from_latent": 32,
    }


def pixel_shuffle_h3_images(images: torch.Tensor) -> torch.Tensor:
    """Convert [B,T,H,W,12] phase-packed RGB into [B,T,2H,2W,3].

    Deciia 2026-10-05：帧本地双射就地重排——pixel_shuffle 不跨帧（12×H×W 元素
    与 3×2H×2W 相同，仅重排），逐块把结果写回输入自身的存储。峰值由“输入+输出
    两份 8.5GB 再加 contiguous 拷贝”降为“输入本身 + 小块临时”（240 帧 640×1152
    情形约 8.5GB→0.3GB 额外开销）。等价性单测：逐块就地与整段重排 max|diff|=0。
    不涉及 ViT3DDecoder 的全局时间注意力（解码已在 super().decode 完成）。
    """
    if images.ndim != 5 or images.shape[-1] != 3 * RGB_PHASES:
        raise ValueError(f"HyperVAE 2x 解码预期 [B,T,H,W,12]，实际 {tuple(images.shape)}")
    if not images.is_contiguous():
        images = images.contiguous()
    batch, frames, height, width, _ = images.shape
    flat = images.view(batch, frames, -1)
    step = 8
    for b in range(batch):
        for lo in range(0, frames, step):
            hi = min(lo + step, frames)
            part = images[b, lo:hi].permute(0, 3, 1, 2).reshape(-1, 12, height, width)
            rgb = F.pixel_shuffle(part, upscale_factor=2)
            flat[b, lo:hi] = rgb.permute(0, 2, 3, 1).reshape(hi - lo, -1)
    return images.view(batch, frames, height * 2, width * 2, 3)


def _finalize_hyper_pixels(inner, part: torch.Tensor) -> torch.Tensor:
    """Keep the native 3-channel encoder statistics while decoding 12 phases."""
    if part.shape[1] != 12:
        raise ValueError(f"HyperVAE 解码头必须输出12通道，实际 {part.shape[1]}")
    std = inner.pixel_std.repeat_interleave(RGB_PHASES, dim=1).to(
        device=part.device, dtype=torch.float32
    )
    mean = inner.pixel_mean.repeat_interleave(RGB_PHASES, dim=1).to(
        device=part.device, dtype=torch.float32
    )
    return (part * std).add_(mean).clamp_(0.0, 1.0)


def load_hyper_vae_2x(path: str | Path):
    """Return a standard VAE-compatible object with native encode and 2x decode."""
    report = inspect_hyper_vae_2x(path)
    import comfy.ops
    import comfy.sd
    import comfy.utils
    import comfy.model_management as model_management

    state, metadata = comfy.utils.load_torch_file(report["path"], return_metadata=True)
    original_weight = state["decoder.proj_out.weight"]
    original_bias = state["decoder.proj_out.bias"]
    # Construct the stock H3 wrapper with a native-shaped *view* of the head.
    # All other weights, including the unchanged encoder, load through Comfy's
    # normal VAE/ModelPatcher path. Replace the head before first execution.
    native_shape_state = dict(state)
    native_shape_state["decoder.proj_out.weight"] = original_weight[:3_072]
    native_shape_state["decoder.proj_out.bias"] = original_bias[:3_072]
    vae = HyperVAE2x(sd=native_shape_state, metadata=metadata)
    inner = vae.first_stage_model
    projection = comfy.ops.disable_weight_init.Linear(2_048, 12_288, bias=True)
    projection.load_state_dict(
        {"weight": original_weight, "bias": original_bias},
        strict=True,
        assign=vae.patcher.is_dynamic(),
    )
    projection.to(dtype=vae.vae_dtype).eval()
    inner.decoder.proj_out = projection
    inner.decoder.out_channels = 12
    # The checkpoint stores RGB-phase groups: RRRR GGGG BBBB. Expand these
    # statistics only inside decode finalization; the encoder still needs RGB.
    inner._finalize_pixels = MethodType(_finalize_hyper_pixels, inner)
    model_management.archive_model_dtypes(inner)
    vae.size = None
    vae.patcher.size = 0
    vae.model_size()
    native_memory = vae.memory_used_decode
    vae.memory_used_decode = lambda shape, dtype: native_memory(shape, dtype) * 1.25
    report["status"] = "loaded_not_quality_qualified"
    report["video_vae_only"] = True
    report["audio_vae_unchanged"] = True
    return vae, report


# Importing Comfy only for the class avoids a global monkey-patch of its VAE
# factory. The public node still imports this module lazily on actual execution.
import comfy.sd  # noqa: E402


class HyperVAE2x(comfy.sd.VAE):
    def spacial_compression_decode(self):
        # Report the actual IMAGE geometry, not the internal packed buffer.
        return 32

    def decode(self, samples_in, vae_options={}):
        _check_h3_video_latent(samples_in)
        return pixel_shuffle_h3_images(super().decode(samples_in, vae_options))

    def decode_tiled(self, samples, tile_x=None, tile_y=None, overlap=None,
                     tile_t=None, overlap_t=None):
        _check_h3_video_latent(samples)
        packed = super().decode_tiled(samples, tile_x=tile_x, tile_y=tile_y,
                                      overlap=overlap, tile_t=tile_t,
                                      overlap_t=overlap_t)
        return pixel_shuffle_h3_images(packed)


def _check_h3_video_latent(samples: torch.Tensor) -> None:
    if samples.ndim != 5 or samples.shape[1] != 24:
        raise ValueError(f"HyperVAE 2x 仅接受 H3 视频 latent [B,24,T,H,W]，实际 {tuple(samples.shape)}")

# ── 节点壳 ──
class MiniMaxH3HyperVAE2xLoaderEXPT8(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        import folder_paths

        names = folder_paths.get_filename_list("vae")
        return io.Schema(
            node_id="easy deciiaH3HyperVAE2xLoader",
            display_name="Deciia HyperVAE 2× 加载 (T8 fork)",
            category="T8/MiniMax H3/VAE",
            is_experimental=True,
            description=(
                "加载 HyperVAE Krea2+MiniMax v2 2× 视频 VAE。编码仍为 H3 16×，解码为 32×；"
                "输出接原 video_vae，音频 VAE 不变。仅对显式选择的权重生效。"
            ),
            inputs=[
                io.Combo.Input(
                    "vae_name",
                    options=names or ["填写绝对路径"],
                    tooltip="直接列出 ComfyUI/models/vae 的文件；选择 HyperVAE 2× 权重。下方路径仅作旧图兼容覆盖。",
                ),
                io.String.Input(
                    "absolute_path",
                    default="",
                    tooltip="可选兼容项，通常留空；填写后优先于 vae_name。",
                ),
            ],
            outputs=[io.Vae.Output("video_vae"), io.String.Output("report_json")],
        )

    @classmethod
    def execute(cls, vae_name, absolute_path=""):
        import folder_paths

        from .fork_hyper_vae import load_hyper_vae_2x

        override = str(absolute_path).strip().strip('"')
        if override:
            path = Path(override)
            if not path.is_absolute():
                raise ValueError("HyperVAE absolute_path 必须是绝对路径")
        else:
            if vae_name == "填写绝对路径":
                raise ValueError("请填写 HyperVAE 2× 文件的绝对路径")
            path = Path(folder_paths.get_full_path_or_raise("vae", vae_name))
        vae, report = load_hyper_vae_2x(path)
        return io.NodeOutput(vae, json.dumps(report, ensure_ascii=False, indent=2))


HYPER_VAE_2X_NODE_CLASSES = [MiniMaxH3HyperVAE2xLoaderEXPT8]

