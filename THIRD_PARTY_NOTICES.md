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

## 主体库 / 提示词增强器（2026-10）

`utils/h3_subjects.py`、`nodes/subjects.py`、`utils/prompt_enhancer.py`、
`utils/h3_prompt_validate.py` 以及前端提示词增强器（`PromptEnhancerModal.tsx`、
`SubjectLibraryWidget.tsx`、`lib/prompt-presets.ts`）在**设计与数据结构**上参考了：

- [MiniMaxRefDirector-ComfyUI](https://github.com/Deciia/MiniMaxRefDirector-ComfyUI)（`GPL-3.0`）
  参考内容：主体模型字段（name / type / description / relationship / retention /
  imageFiles / audioFiles / videoFile）、确定性组装思路（主体绑定 → `<Subject n>` /
  `<Picture n>` / `<Audio n>` 编号由资源顺序派生）、提示词增强器的运镜 / 微表情 / 景别 /
  构图预设分类，以及三栏弹窗 + 分段预览的交互形态。
  说明：本仓库为独立实现（Python 侧自行编写，未复制其源码文件）；按 GPL-3.0 同许可证分发。

- [t8star/comfyui-minimax-h3-audio-T8](https://github.com/t8star/comfyui-minimax-h3-audio-T8)（`GPL-3.0-or-later`）
  参考内容：仅「曜石导演台」（分镜编排 / 素材库 / 每镜头三块提示词 / D1 预检与 D2 生成分层）
  的交互与数据形态，用于后续「四合一工作台」的设计参考。
  说明：本批次**未复制其源码**；如后续移植其代码或数据模型，将在此补充具体文件与改动说明。

- MiniMax H3 官方提示词结构（`subject_definitions` / `summary` / `retention_analysis` /
  `detailed_description` / `overall_soundscape` / `non_diegetic_music` 六段式，
  以及 `<Subject n>`、`<Picture n>`、`<Audio n>`、`<Video n>`、`<d>` 等标签）参考官方文档与
  示例工作流，用于生成提示词的结构校验与归一化。
