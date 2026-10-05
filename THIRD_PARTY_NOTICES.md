# Third-party notices


## H3 T8 fork（2026-10-04）

`nodes/h3_t8_fork/` 下的节点与算法摘取自
[t8star/comfyui-minimax-h3-audio-T8](https://github.com/t8star/comfyui-minimax-h3-audio-T8)
（`GPL-3.0-or-later`），并入本项目（GPL-3.0）并按同许可证分发。

搬运内容（算法本体未改动）：
- Dual-Clock 采样核心与 `dual_clock_euler`、`native_flow`/`beta57` 调度（`h3_t8/sampling.py` 摘取）
- Learned Latent Upscale 核心与 ParityPlan / Reconcile 节点（`learned_latent_upscale_advanced.py` 等）
- Two-Pass Detail Mixer（Tail/Model-Time-Bias/STG/RF-Restart 全套）
- Semantic Bridge（`semantic_bridge.py`/`semantic_bridge_trans.py`/`semantic_bridge_profiles.py`）
- HyperVAE 2× 加载（`hyper_vae_2x.py`）、AV Decode

改动说明：节点 id 统一改为 `easy deciiaH3*` 前缀并归入 `EasyUse/H3/T8fork` 分类，
与原 T8 包可共存；跨模块导入收拢为 fork 包内相对导入；`warn_patch_stack` 简化为纯日志；
`vae_decode_audio` 改用 ComfyUI 核心实现。

模型权重不随本仓库分发：
- Semantic Bridge 模型：https://huggingface.co/t8star/Semantic-Bridge-Comfy 与
  https://huggingface.co/t8star/semantic_bridge_T8-comic-combat （放 `models/semantic_bridge/t8_compat`）
- 学习放大器与 HyperVAE 2× 权重：见原 T8 仓库 README（放 `models/latent_upscaler` / `models/vae`）
