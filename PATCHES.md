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

## 待做
- 阶段3: P3 实弹(直通段×manifest 登记×尾段context续接)
- 直通段 shot 的 P3 实弹验证(下一段独立开场)
- "回"字截断根因深挖(已列必查项)
