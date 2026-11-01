# P3a · Easy Project All-in-One（beta3）参考工作流

MiniMax H3「一采 + 二采 + 多轨项目」All-in-One 参考工作流。一条链路里包含：多轨编辑器项目时间线、参考图/音/视频挂载、OmniCam 相机编排运动层、语义桥（T8）+ HyperVAE 2× 超级解码、一采/二采双阶段采样与 LoRA 加速、以及 **RTX / VOSR2 / SeedVR2 三条超分出口**。

> 工作流文件：[Easy_Project_AllInOnev_deciia_beta3.json](./Easy_Project_AllInOnev_deciia_beta3.json) · 预览：[Easy_Project_AllInOnev_deciia_beta3.jpg](./Easy_Project_AllInOnev_deciia_beta3.jpg)
> 已脱敏：项目名、LoRA 预设名、笔记中的个人代号、参考素材文件名均改为 `example_*` 等中性占位，并清除了节点里缓存的本机成片路径信息；**节点与连线与原版完全一致（含 bypass 的辅助节点）**。**参考素材需要换成你自己的**（见下方「快速上手」）。

---

## 1. 依赖插件清单

### 本插件（必装）

| 插件 | 用到的节点 | 地址 |
|---|---|---|
| **ComfyUI_Deciia_EasyMedia**（本仓库） | `easy multiTrackEditor` 多轨编辑器、`easy multitrackProject` 项目生成、`easy multitrackProjectVideoCombine` 项目合并、`easy saveVideo` ×4（保存媒体）、`easy clipTiming`、`easy makeImageList / makeVideoList / makeAudioList`、`easy modelLoaderPack`、`easy multiTrackAddSubtitleToVIdeo`、`easy deciiaH3SemanticBridgeConfig` ×2、`easy deciiaH3HyperVAE2xLoader` | https://github.com/deciia/ComfyUI-Easy-Media |

### 配套 Deciia 插件（必装）

| 插件 | 用到的节点 | 地址 |
|---|---|---|
| **ComfyUI_Deciia_EasyUse** | `DeciiaVideoModelLoader` 四合一模型加载、`DeciiaSamplerPreset` ×2 采样预设、`DeciiaSparseSolAttn` 稀疏注意力、`DeciiaVramSafeLoraStack` ×3 显存安全 LoRA 串；**并收录了下述班长captain 的 6 个节点**（`banzhang_nodes/` 子包） | https://github.com/deciia/ComfyUI_Deciia_EasyUse |

### 班长captain 整理分享的节点（已收录于 ComfyUI_Deciia_EasyUse）

以下 6 个节点是 **班长captain**（B站昵称）整理分享的节点/功能（含其自身的设计与改进），插件未整体开源，经班长captain 同意，把这 6 个节点收录进 **ComfyUI_Deciia_EasyUse**（`banzhang_nodes/` 子包，代码与原插件一致并注明来源）。**安装 EasyUse 即可用，无需另装班长插件。**

| 节点 | 说明 |
|---|---|
| 🛡️⚡ **显存守卫** `BanZhang_VRAM_Guard` | 运行前预留显存，防瞬时峰值 OOM |
| 📈 **活动监视器·内存显存** `BanZhang_Mem_Graph` | 画布实时内存/显存曲线（含净化标记） |
| **班长 MiniMax H3 预览覆盖** `MiniMaxH3PreviewOverride` | taeh3 迷你 VAE 实时预览 |
| 🔍 **RTX 超分降噪** `BanZhang_RTX_SuperResolution` | 需 pip 安装 NVIDIA Maxine VFX（nvvfx） |
| 🎞️ **RIFE 插帧** `BanZhang_RIFE_Interpolation` | 权重首次运行自动下载 |
| 🧹 **全能系统净化** `BanZhang_VRAM_Cleaner` | 内存/显存/缓存一键清理 |

### 第三方插件

| 插件 | 用到的节点 | 地址 |
|---|---|---|
| **Goohaitools**（孤海） | `GH_ImageVideoComparer` ×3 图像/视频对比、`忽略多组` （按组批量 bypass） | https://github.com/goohai/Goohaitools-comfyui |
| **ComfyUI-Majoor-OmniCam**（运动层相机编排） | `MajoorOmniCamDirector` 导演、`MajoorOmniCamExtractor` 提取器、`MajoorOmniCamMonitor` 监视器（h3_native） | https://github.com/MajoorWaldi/ComfyUI-Majoor-OmniCam |
| **ComfyUI-KJNodes**（kijai） | `MiniMaxChunkFeedForward`、`MiniMaxLowVRAMAttention`、`MiniMaxH3MemoryEfficientSageAttentionPatch`（H3 省显存三件套） | https://github.com/kijai/ComfyUI-KJNodes |
| **comfyui-minimax-h3-audio-T8**（T8mars） | `MiniMaxH3SemanticBridgeComposeT8` 语义桥多桥组合 | https://github.com/T8mars/comfyui-minimax-h3-audio-T8 |
| **TE-Speed-VOSR2**（VOSR2 超分） | `TESpeedVOSR2Loader / Settings / Image` | https://github.com/tl2012tl/TE-Speed-VOSR2 |
| **Comfyui-Memory_Cleanup**（LAOGOU-666） | `RAMCleanup`、`VRAMCleanup`（临时清内存显存组） | https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup |
| **ComfyUI_Comfyroll_CustomNodes**（Suzie1） | `CR Prompt Text`（台词/旁白文本） | https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes |
| SeedVR2 超分子图（**默认 bypass，可选**） | `SeedVR2Preprocess / Conditioning / PostProcessing` —— ComfyUI **内置**节点（`comfy_extras/nodes_seedvr.py`，需较新版本 ComfyUI），启用时需自备 SeedVR2 模型权重 | ComfyUI 内置 |

其余 `LoadImage / LoadVideo / LoadAudio / SaveVideo / GetVideoComponents / LoraLoaderBypassModelOnly / ModelAttentionBackend / ResizeImageMaskNode / SplitImageWithAlpha / MaskToImage` 均为 ComfyUI 内置节点。

## 2. 模型与权重清单

| 类型 | 文件 | 说明 |
|---|---|---|
| diffusion_models | `MiniMax-H3/minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors` | H3 hybrid FL2VA+Ref2VA int8 主模型 |
| text_encoders | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | Qwen3-VL 32B NVFP4 |
| vae | `minimax_h3_video_vae_int8_convrot.safetensors`、`minimax_h3_audio_vae_fp32.safetensors` | 视频 / 音频 VAE |
| loras（一采加速） | `MiniMax-H3/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` | 4 步 turbo |
| loras（二采） | `MiniMax-H3/minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors` | 4 步 DMAD |
| loras（超采） | `hyperVAEKrea2Minimax_v20MinimaxX2Upscale.safetensors` | HyperVAE 2×（T8 fork 超级解码） |
| loras（上采样器） | `h3_upscaler_lms_v0.1.safetensors` | multitrackProject 上采样 |
| vae（预览） | `taeh3.safetensors` | 班长 H3 预览覆盖用的迷你 VAE |
| loras（LoRA 串预设中的可选行） | `MMH3-MPOV`、`H3_Combat_V2`、`Motion_Repair_V2`、`Bunny_weapon_combatV1`、`minimax_h3_dmad_full_dareties…` 等 | 预设里默认大多关闭，按需自备 |
| RTX 超分 | NVIDIA Maxine VFX（nvvfx） | 需 pip 安装 nvvfx 依赖包（RTX 超分节点启用时） |
| RIFE 插帧 | v4.26 权重 | 首次运行自动下载 |
| VOSR2 / SeedVR2 | 各自模型权重 | 启用对应超分出口时需要 |

## 3. 快速上手

1. 按上表装齐插件、下齐模型。
2. **替换参考素材**（脱敏后为占位名）：
   - 图片：`example_ref_01.png`（四视图）、`example_ref_02/03.jpg`（人物）、`example_ref_04.jpg`（场景）→ 在各 `LoadImage` 里选你自己的图；
   - 音频：`example_voice_ref_10s.wav` → `LoadAudio` 里选你自己的参考音色（约 10 秒干声最佳）。
   - 多轨编辑器任务段提示词里的 `<Picture n>` / `<Audio 1>` 令牌编号会随挂载顺序自动对齐，无需手改。
3. 常用开关：
   - 显存紧张 → 打开 🛡️⚡ 显存守卫（阈值 0.2）与「临时清内存显存」组；
   - 想要实时预览 → 保持「班长 MiniMax H3 预览覆盖」开启（taeh3 迷你 VAE）；
   - 超分出口三选一：RTX（快）/ VOSR2（平滑，适合人脸）/ SeedVR2（细节锐利，适合景观巨构），不用的保持 bypass。
4. 生成入口在 `easy multitrackProject`（项目名已脱敏为 `example_project`，可自行改）；四路 `easy saveVideo` 分别直存、RTX、VOSR2、SeedVR2 出口。

## 4. 脱敏改动清单（相对原版）

> 只做**重命名与缓存清除**，不增删任何节点和连线（含 bypass 的辅助节点，原样保留）。

| 位置 | 处理 |
|---|---|
| multitrackProject 项目名 | 个人项目名 → `example_project` |
| LoRA 串预设名 ×2 | 去掉预设名中的个人代号 |
| MarkdownNote | 去掉笔记中的个人代号 |
| 参考图片文件名 ×4 | 个人素材文件名 → `example_ref_01~04` |
| 参考音频文件名 | 个人参考音频文件名 → `example_voice_ref_10s.wav` |
| easy saveVideo ×4 | 删除 `properties.easyVideoInfo`（缓存的本机成片绝对路径） |
| 文件名前缀 | 去掉尾部多余空格 |

节点数与连线数与原版一致（87 / 89）；布局、分组、参数与原版一致。

## 5. 致谢

- **班长captain**（B站昵称）——显存守卫 / H3 预览覆盖 / 活动监视器 / RTX 超分 / RIFE 插帧 / 系统净化等节点的整理分享者，上述节点经其同意收录进 ComfyUI_Deciia_EasyUse；
- **孤海 goohai**（Goohaitools 图像/视频对比、忽略多组）；
- **MajoorWaldi**（OmniCam 相机编排）、**T8mars**（H3 语义桥 T8）、**kijai**（KJNodes）、**tl2012tl**（TE-Speed-VOSR2）、**LAOGOU-666**（Memory Cleanup）、**Suzie1**（Comfyroll）；
- **yolain/ComfyUI-Easy-Media** 上游项目。
