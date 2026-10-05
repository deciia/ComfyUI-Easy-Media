"""Deciia H3 T8 fork — 注册入口。

从 t8star/comfyui-minimax-h3-audio-T8 摘取的最小节点集（P3 双采移植用）。
节点 id 全部带 easy deciia* 前缀，可与原 T8 包共存不冲突。
来源与许可说明见仓库 THIRD_PARTY_NOTICES.md。
"""
from __future__ import annotations

from .fork_nodes import (
    MiniMaxH3DualClockSamplerT8 as DeciiaH3DualClockSampler,
    MiniMaxH3AVDecodeT8 as DeciiaH3AVDecode,
)
from .fork_learned_upscale import (
    MiniMaxH3LearnedLatentUpscaleT8Advanced as DeciiaH3LearnedLatentUpscale,
    MiniMaxH3TwoPassLatentReconcileT8Advanced as DeciiaH3TwoPassLatentReconcile,
    MiniMaxH3LearnedTwoPassParityPlanT8Advanced as DeciiaH3TwoPassParityPlan,
)
from .fork_detail_mixer import MiniMaxH3TwoPassDetailMixerT8Advanced as DeciiaH3TwoPassDetailMixer
from .fork_semantic_bridge import (
    MiniMaxH3SemanticBridgeConfigT8 as DeciiaH3SemanticBridgeConfig,
    MiniMaxH3SemanticBridgeApplyT8 as DeciiaH3SemanticBridgeApply,
)
from .fork_hyper_vae import MiniMaxH3HyperVAE2xLoaderEXPT8 as DeciiaH3HyperVAE2xLoader

# 供 GraphBuilder 内部图用 name→class 查询（与 get_node_list 注册同名）。
FORK_NODE_CLASSES = {
    "easy deciiaH3DualClockSampler": DeciiaH3DualClockSampler,
    "easy deciiaH3AVDecode": DeciiaH3AVDecode,
    "easy deciiaH3LearnedLatentUpscale": DeciiaH3LearnedLatentUpscale,
    "easy deciiaH3TwoPassLatentReconcile": DeciiaH3TwoPassLatentReconcile,
    "easy deciiaH3TwoPassParityPlan": DeciiaH3TwoPassParityPlan,
    "easy deciiaH3TwoPassDetailMixer": DeciiaH3TwoPassDetailMixer,
    "easy deciiaH3SemanticBridgeConfig": DeciiaH3SemanticBridgeConfig,
    "easy deciiaH3SemanticBridgeApply": DeciiaH3SemanticBridgeApply,
    "easy deciiaH3HyperVAE2xLoader": DeciiaH3HyperVAE2xLoader,
}

__all__ = [name for name in dir() if name.startswith("DeciiaH3")] + ["FORK_NODE_CLASSES"]
