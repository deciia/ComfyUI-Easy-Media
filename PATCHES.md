# 自定义改动清单（上游更新时逐条核对重放）

## 功能：直通(passthrough)任务段 — 视频轨素材直接进成片

| # | 文件 | 位置 | 改动 | 状态 |
|---|------|------|------|------|
| 1 | nodes/deciiapassthrough.py | 新文件 | 直通核心: 窗口覆盖检查/路径解析/ffmpeg staging/音频窗对位 | ✅已验证 |
| 2 | nodes/deciiapass_stage.py | 新文件 | 子图节点 easy deciiaPassthroughStage: staging+尾22帧解码 | ✅已验证 |
| 3 | nodes/project.py | import 区 | +from .deciiapassthrough import PASSTHROUGH_CONTEXT_FRAMES, is_passthrough_task | ✅ |
| 4 | nodes/project.py | selected_entries 之后 | +info_with_pass_entries 构建(直通段entry打包进tracks_info) | ✅ |
| 5 | nodes/project.py | fit_locked_video_timing 之后 | +直通分支: Stage→_h3_encode_context_media→h3ProjectArtifact→continue | ✅(链路级待P3实测) |
| 6 | utils/h3_project.py | h3_generation_mode | +passthrough→"passthrough" 哨兵映射 | ✅ |
| 7 | utils/h3_project.py | h3_task_type | +mode=="passthrough"→"passthrough" | ✅ |
| 8 | nodes/__init__.py | import 区 | +from .deciiapass_stage import * | ✅ |
| 9 | __init__.py | get_node_list | +DeciiaPassthroughStage 注册 | ✅(object_info确认) |

## 验证记录 (2026-09-23)
- object_info: easy deciiaPassthroughStage 注册成功, 节点总数 5076 (原5070)
- API 提交 Stage→saveVideo: success
- staging 产物: 3.00s/72帧/544x960/带音轨 ✓ (窗口24-96精确裁切)
- 尾上下文: 22帧/0.92s 张量流 ✓
- 修过的bug: stage_passthrough_media 内嵌音轨分支 filter 后置导致 -map [aout] 失败 → 已前置修复

## 阶段2: 前端 (2026-09-23 已构建)

| # | 文件 | 改动 | 状态 |
|---|------|------|------|
| 10 | frontend/src/types/multitrack.ts | MultiTrackTaskMode + 'passthrough' | ✅ |
| 11 | frontend/src/lib/multitrack-utils.ts | MODES 数组 + getMultiTrackTaskType 映射 | ✅ |
| 12 | frontend/messages/en.json | multitrackTaskModes.passthrough = "Pass" | ✅ |
| 13 | frontend/messages/zh.json | multitrackTaskModes.passthrough = "直通" | ✅ |
| 14 | dist/release | bun run build:release 重编(新chunk s1ry34ht 含直通, 旧chunk已清) | ✅服务器200可拉 |

注: TaskSegmentEditor.tsx 未改 — 下拉遍历 MULTITRACK_TASK_MODES, 自动带上新项;
显示文案走 getMultiTrackTaskType→multitrackTaskModes.passthrough 链路, 全自动。

## 阶段4: 直通段 continuity_mode 三态 (2026-09-23)

语义: 直通段下拉 = 出口语义(给下一段留什么); shot=切断 / context=留续接(默认) / swap=置灰
| # | 文件 | 改动 | 状态 |
|---|------|------|------|
| 15 | nodes/deciiapassthrough.py | +passthrough_continuity_mode() helper | ✅ |
| 16 | nodes/project.py 直通分支 | shot→不编码context+previous_context_cut=True; context→照旧 | ✅ |
| 17 | nodes/project.py 1594 guard | not previous_context_cut and not _h3_manifest_context_cut(...) 跳过load | ✅待实弹 |
| 18 | nodes/project.py | +_h3_manifest_context_cut() 读盘判跨run切断 | ✅ |
| 19 | nodes/minimax.py artifact | context_latent optional; None→占位latent+manifest context_cut | ✅E2E |
| 20 | nodes/minimax.py load | manifest context_cut→返回占位latent | ✅(对称验证) |
| 21 | nodes/deciiapass_stage.py | shot→跳过尾帧解码(占位张量) | ✅E2E |
| 22 | frontend TaskSegmentEditor.tsx | passthrough模式下 context_swap 置灰 | ✅已构建 |

E2E 验证: API 提交 Stage(shot)→Artifact success; manifest context_cut=True; 占位latent 127KB
注意: 测试中 task_mode=None 因测试tracks_info无task轨段; 真实链路(P3)不受影响

## 修复: 错误路径释放已保存段缓存 (2026-09-23, commit ec94794)

背景: 多轨项目 run 报错中断(节点异常/手动中断/校验错误)后, 已展开段子图的输出
(latent/解码帧/conditioning)全部驻留进程 commit 内存不释放。多次报错叠加后
顶穿 Windows commit 上限 → 0xc0000005 进程崩溃(09-23 16:40 实录 78.1GiB)。
普通工作流无此问题(单图缓存量级小), 唯多轨项目一图建全项目受影响。

| # | 文件 | 改动 | 状态 |
|---|------|------|------|
| 23 | utils/project_memory.py | +_release_on_prompt_error(): 失败时驱逐已保存段输出(媒体已落盘), 失败段 conditioning 保留供重试 | ✅ |
| 24 | utils/project_memory.py | install 时追加包装 PromptExecutor.handle_execution_error(ComfyUI 错误路径原本零清理) | ✅ |
| 25 | utils/project_memory.py | complete 包装器快照当前 ExecutionList 供错误钩子定位现场; headless 无 execution 模块时跳过 | ✅ |

验证: 独立最小复现测试(scratch/test_error_path_release.py, 模拟段0/1保存+段2异常):
已保存段张量全部释放 ✅ 失败段 latent 驻留保留 ✅ py_compile ✅
仓库自带 pytest 套件在改动前即坏(conftest 依赖 PromptServer.instance), 与本改动无关。
生效标志: run 报错后日志出现 "[Easy Media][Project] Run failed at ...: released N cache references"

## 修复: 多轨编辑器前端空白 + React #185 (2026-09-24, commit 905c32d)

背景: ComfyUI 前端 1.53+/React 19 下, 多轨编辑器(easy multiTrackEditor)加载后
React 树被 "Maximum update depth exceeded"(#185) 中止 → widget 空白; 且
DYNAMICCOMBO_V3 子widget重建导致 widgets_values 错位, track_data 拿到 format
combo 字符串, JSON 解析失败 → 编辑器永久空白。两个独立 bug 叠加。

| # | 文件 | 改动 | 状态 |
|---|------|------|------|
| 26 | frontend/package.json + bun.lock | radix 全家升最新; overrides+resolutions 钉 react-compose-refs=1.1.5 / react-presence=1.1.10, 清除嵌套旧副本 | ✅ |
| 27 | frontend/src/components/ui/tooltip.tsx | Radix Tooltip → 同 API 轻量实现(无 Presence/Portal, 纯展示层) | ✅ |
| 28 | frontend/src/lib/create-react-widget.ts | onChange 稳定身份 + parseValue 引用缓存 + 同值短路 + 微任务合并渲染 | ✅ |
| 29 | frontend/src/components/widgets/multitrack/PreviewArea.tsx | 四个派生值(activeVideo/audioSources/taskImages/taskPrompt)useMemo 化(原每 render 新引用, effect 链重火) | ✅ |
| 30 | frontend/src/lib/project-sampling-preview-node.tsx | root.unmount() 延迟到 idle(原在 fireNodeRemovalLifecycle 提交中途同步执行); syncHostBounds 永续 rAF 自激循环剪除; nodeId prop 稳定化 | ✅ |
| 31 | frontend/src/lib/track-data-realign.ts (新) | onConfigure 后 track_data 值非合法 JSON 时, 从工作流自身 widgets_values 找回真 JSON 回填(setValue 需带 {} 上下文参数, 1.54 DOMWidgetImpl 强制); +Step2 combo 归位: format 收到 megapixels 浮点时按合法选项归回 "MiniMax"; setValue ctx 须含 canvas.graph_mouse | ✅ |
| 32 | frontend/src/hooks/use-canvas-scale.ts | 模块级单例 + useSyncExternalStore(原每 widget 各自 patch canvas.onDrawForeground + 绘制回调里同步 setState) | ✅ |
| 33 | nodes/basic.py | _resolve_configured_dimensions megapixels 分支: aspect_ratio 缺失且 resize_method 持 AspectRatio 枚举标签(前端错位脏值, 如 "9:16 (Portrait Widescreen)")时回填, 恢复 9:16@0.5MP≈768x1376; 非枚举脏值不误伤. 修复前端不重建 DYNAMICCOMBO_V3 子widget导致分辨率塌缩成 1024x1024 方形 | ✅ |
| 34 | frontend/src/lib/track-data-realign.ts | Step2 追加: 无合法候选的 combo(如 resize_method 持 AspectRatio 脏值)重置为第一合法选项, 消除红框; Step3(延迟120ms 避开 ComfyUI 异步值重放): megapixels 模式补建 resolution.aspect_ratio combo + resolution.megapixels number widget, 从保存值恢复 9:16/0.5, 提交 inputs 含全部 4 个 resolution.* 键 | ✅ |

验证(Edge CDP 无头): 单editor/单project/editor+project组合/完整33节点工作流 全部
#185=0; node14 track_data 渲染 444 元素/73KB HTML, 截图确认时间轴/轨道/预览/参数
面板完整, 内容为真实项目数据。构建: bun run build:release。

上游同步指引(若作者后续更新导致冲突, 按此重放):
- 依赖锁定看 package.json 的 overrides/resolutions 两个键
- 其余补丁均为独立小文件或在既有文件上的局部改动, git diff 905c32d^..905c32d
  -- frontend/src 即为完整指纹清单
- 若上游官方修复了 DYNAMICCOMBO_V3 加载重建(子widget缺失→值错位), #31 可移除

## 待做
- 阶段3: P3 实弹(直通段×manifest 登记×尾段context续接)
- 直通段 shot 的 P3 实弹验证(下一段独立开场)
- "回"字截断根因深挖(已列必查项)
- [挂起-0924] 二采 tiled forward 832x1440 偶发 0xc0000005(c10.dll 写已释放显存映射, 16:40/19:35 两录, dump已解析)。
  异恒决定: 不降二采倍率/不弃二采/不降驱动/不做大改源码。根因方向: torch 2.13.0+cu130 线程池与
  nvcuda64 交互的内存生命周期竞态。候选小改(未批准, 等拍板): h3_tiling 每 tile .cpu() 前加
  torch.cuda.synchronize(); 上游 yolain/ComfyUI-Easy-Media 亦未修(4 commit 未见触及)。
