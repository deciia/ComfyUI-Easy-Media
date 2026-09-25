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
| 35 | frontend/src/lib/dynamic-combo-runtime-rebuild.ts (新) | 运行时切换 DYNAMICCOMBO_V3 主选项(如 resolution 切 megapixels)时按 schema 重建子 widget: 删旧键子widget→按新键 inputs.required 建新→回填保存值; setValue 包装+300ms 轮询兜底+onConfigure 初始对账. 修复 1.53+ 前端切换后子选项不出现/旧子widget残留(官方 upstream 同样未处理, 见 issue #108) | ✅ 无头验证: 往返切换 auto↔megapixels 子widget增删正确; 9:16+0.5 保存序列化完整五元组 |

验证(Edge CDP 无头): 单editor/单project/editor+project组合/完整33节点工作流 全部
#185=0; node14 track_data 渲染 444 元素/73KB HTML, 截图确认时间轴/轨道/预览/参数
面板完整, 内容为真实项目数据。构建: bun run build:release。

上游同步指引(若作者后续更新导致冲突, 按此重放):
- 依赖锁定看 package.json 的 overrides/resolutions 两个键
- 其余补丁均为独立小文件或在既有文件上的局部改动, git diff 905c32d^..905c32d
  -- frontend/src 即为完整指纹清单
- 若上游官方修复了 DYNAMICCOMBO_V3 加载重建(子widget缺失→值错位), #31 可移除

## 功能：提示词工作台 (Prompt Studio) — 本地新增节点

| # | 文件 | 位置 | 改动 | 状态 |
|---|------|------|------|------|
| 1 | nodes/prompt_studio.py | 新文件 | 节点 `easy promptStudio` + 只读解析路由 `/easy-media/prompt-studio/resolve` | ✅ py_compile 通过 |
| 2 | nodes/__init__.py | import 区 | +`from .prompt_studio import *` | ✅ |
| 3 | __init__.py | get_node_list（Deciia 本地新增段） | +`PromptStudio` | ✅ |
| 4 | dist/release/deciia_prompt_studio.js | 新文件 | 前端面板：素材点选插入 / 提示词预览 / 改写对比 / 复制 | ✅ node --check |
| 5 | dist/dev/deciia_prompt_studio.js | 新文件 | 同上副本（`dist/dev/` 被 .gitignore 忽略，仅本机） | ✅ |
| 6 | locales/zh/nodeDefs.json | 末尾 | +`easy promptStudio` 中文标签 | ✅ |

### 设计约束（勿破坏）
- **素材编号必须与编辑器一致**：`<Picture n>` = 任务段 `content.images` 里非静音项顺序；
  `<Audio n>` = 视频轨内嵌音轨先占号、再排音频轨；`<Video n>` = 视频轨顺序。
  解析复用 `utils.multitrack._parse_track_data` + `nodes.basic._multitrack_task_entries`，不要另写一套。
- **只读**：不修改 TRACKS_INFO、不写回编辑器。回填由用户手动完成，或交给官方「多轨提示词增强到项目」。
- **标记只输出规范写法** `<Picture n>` / `<Audio n>` / `<Video n>`；`@图片1` 之别名只在报告里提示，不静默改写用户原文。
- 前端是 bun 构建产物目录（`bun run build`），本 JS 为手写独立扩展、**不参与构建**；
  **上游/本地重建 dist 后需把该文件重新放回 release 与 dev**。

### 上游同步指引
- 改动点仅三处：`nodes/prompt_studio.py`（新文件，可原样保留）、`nodes/__init__.py` 一行 import、
  `__init__.py` 一行注册。上游若调整 node 列表结构，按这两行重放即可。
- 前端文件与构建链无关，冲突风险仅来自 dist 重建覆盖。

## 功能：多轨提示词增强器升级（参考 🤖 AI 全能生成）

| # | 文件 | 改动 | 状态 |
|---|------|------|------|
| 1 | utils/llm_api.py | 新增 `CUSTOM_OPENAI_MODEL = "自定义 (OpenAI 兼容)"`；`MODEL_CONFIGS` 增条目（无 seed、视频走抽帧兜底、允许空密钥）；`PROMPT_ENHANCER_PRESETS` / `prompt_enhancer_preset_text` | ✅实测 |
| 2 | utils/llm_api.py | `PromptEnhancerClient` 增 `endpoint` / `api_model` / `temperature` 参数；`self.endpoint`/`self.api_model` 取代硬编码；空密钥不发 Authorization（`_request_headers`）；OpenAI 分支按需带 temperature | ✅实测 |
| 3 | nodes/basic.py | 两个节点（增强器 + 增强到项目）在 `api_account` **之后**追加节点级输入：`preset` / `endpoint` / `api_model_name` / `temperature`，execute 同步接收并透传 | ✅实测 |
| 4 | locales/zh/nodeDefs.json | 上述 4 个端口的中文名与提示 | ✅ |
| 5 | dist/release/chunks/index-vbk6nbdt.js | 余额面板厂商表补 `custom` 条目（否则选「自定义」时按模型名匹配失败报错） | ✅ |

### 设计红线（勿破坏）
- **新参数必须作为节点级 widget 追加在 `api_account` 之后**。前端默认按位置还原存档（`namedValuesRestore` 默认 false，`getRestoredWidgetValue` 走 positional 分支），把新项插到中间会让同节点后续 widget（seed / enabled / api_account）整体错位。
- 自定义模型只能**追加**在 `PROMPT_ENHANCER_MODELS` 末尾，同理保护存档位置。
- 预设只对有 system 角色的第三方 / 自定义模型生效；H3 官方接口（h3-context-ir）没有系统指令位，预设对它无效——这是接口事实，不是 bug。
- 自定义端点默认 `supports_seed=False`、`supports_video_data_uri=False`（视频抽帧成 image_url），以兼容任意第三方 / 本地端点。

### 上游同步指引
- 冲突集中在 `utils/llm_api.py`（客户端构造与两处 endpoint/model 引用）和 `nodes/basic.py`（两处 schema 尾部 + 两处 execute 签名）。上游若重构这两个区域，按本表重放即可。
- `dist/release/chunks/*.js` 是构建产物：**上游重建 dist 会覆盖余额面板补丁**，需重新加 `Ys.custom` 与 `{id:"custom",modelNames:[Ys.custom]}` 两个片段（备份见 `D:/workspace/_node_backups/20260925_prompt_studio/`）。

## 提示词工作台：面板重做（素材架 + 富文本 @ 插入）

按用户设计重做面板：入口补齐「轨道信息 / 图像 / 音频 / 视频 / 系统提示词1 /
用户提示词2（基线）」，主体只留「提示词3」；素材以缩略图直接铺在素材架上，
编辑区打 `@` 弹列表、选中后插入缩略图 chip；去掉提示词预览、素材编号对照与
分类型展示区。

| 文件 | 改动 |
| --- | --- |
| `nodes/prompt_studio.py` | 端口改为 tracks_info/images/audio/video/system_prompt/user_prompt/previous/task_index/mode/prompt；输出改 PROMPT + IMAGES/AUDIO/VIDEO 透传；`media_view_url` 按前端 `Gv()` 口径重写；路由返回统一 `items[]`（含 token/label/name/url）并夹住越界索引 |
| `dist/release/deciia_prompt_studio.js`（+ `dist/dev/` 副本） | 整体重写：素材架缩略图 + contenteditable 富文本编辑器（chip 内联 16px 缩略图、`@` 菜单 32px 缩略图、↑↓/Enter/Tab/Esc、撤销栈、粘贴转纯文本）+ 上游只读区 |
| `locales/zh/nodeDefs.json` | `easy promptStudio` 的端口名与描述更新（新增 图像/音频/视频/系统提示词1，改名 用户提示词2、提示词3，去掉 内容说明） |

### 教训（改这个包前必读）

1. **前端默认按位置还原 widget 存档**（`namedValuesRestore` 默认 false），
   所以给已有节点加参数**只能追加在最后**；插在中间会让 seed/enabled、
   API_KEY 等一起错位。本次 4 个新参数全部追加在 `api_account` 之后。
2. **素材预览地址口径**：多轨编辑器里的图片存的是
   `file_path = "yusheng\ep2\老赵四视图.png"`（input 相对路径，子目录在路径里，
   没有 `subfolder` 字段）。要按前端 `Gv()` 的口径：`url` / `local_path` 直用，
   其余按最后一个斜杠拆出 `filename` + `subfolder`，`type` 取 `source_type`。
   自己拼 `subfolder=` 空串会 404。
3. **接管原生输入框**：面板要自己画正文时，把原生 widget
   `computeSize = () => [0, -4]`（+ `hidden = true`）收成 0 高度，
   值仍照常序列化，不必删 widget。
4. **ES module 语法自查**：`node --check` 不吃 `import`，拷成 `.mjs` 再检查。
5. 重启验证时 `/object_info/<含空格的节点名>` 要 URL 编码成 `%20`。


### 09-25 晚 · 第二轮：UI 实测修正（无头 Edge 探针驱动）

用 Playwright 无头 msedge 打开 8188、程序化建出「多轨编辑器（灌真实 track_data）+ 工作台」，
读 DOM 真值取证（`probe_ui3.py`），实测发现并修掉 4 个问题：

| 文件 | 改动 | 实测证据 |
| --- | --- | --- |
| `nodes/prompt_studio.py` | `system_prompt` / `user_prompt` 加 `force_input=True` | 节点上原生文本框与面板只读区**重复出现两处**（异恒反馈）；改后 `/object_info` 里 `forceInput: true`，端口照常接线、不再出框 |
| `dist/release/deciia_prompt_studio.js` | 上游只读区改「一行两个折叠 chip（默认折叠）+ 展开时正文整行」 | 上游占用 48px → **19px** |
| 同上 | 面板高度配比 `computeSize = [w, max(340, h-112)]`；新建默认 460×700；`.dps-ed` min-height 152 | 编辑区 118px → **244px**（占面板约 2/3） |
| 同上 | 按钮文案缩短（`↻ 刷新` / `复制`） | 工具栏 48px（两行）→ **22px**（一行） |

**方法教训**：
1. 取证要用真实浏览器读 DOM（`window.app.graph` / `getBoundingClientRect`），
   AI 看图读中文会误字，只能当线索、必须用 DOM 复测。
2. `write_file` 覆盖已存在的脚本会被**静默拒绝** —— 重启脚本别复用旧文件名，
   否则跑的是旧脚本（本次因此多起了一个抢不到 8188 端口的僵尸进程，已清理）。
3. 重启脚本里杀进程要按 `Get-NetTCPConnection -LocalPort 8188` 取 PID，
   并用 `Get-CimInstance` 复查有无残留 `main.py` 进程，确认只剩一个监听者。


### 09-25 晚 · 增强器 404 修复（端点接受基址）

**现象**：P3 节点 80「多轨提示词增强器」（通道=自定义 OpenAI 兼容）报
`RuntimeError: Prompt enhancement failed: openai API HTTP 404`。

**根因**：`endpoint` 填的是**基址** `https://api.deepseek.com`，而代码里
`self.endpoint` 是**原样使用**的 → POST 到域名根路径，自然是 404。
（DeepSeek 边缘不带 key 一律回 401，带 key 走错路径才 404 —— 这也是这次能定位的原因。）

| 文件 | 改动 |
| --- | --- |
| `utils/llm_api.py` | 新增 `normalize_openai_endpoint()`：基址自动补全 `/v1/chat/completions`（`/api/v4` 这类网关路径补成 `/api/v4/chat/completions`），**已填全路径的存档原样返回**；`self.endpoint` 走归一化；缺端点的报错文案同步更新 |
| 同上 | "returned an empty prompt" 改为带诊断：`finish_reason` / `reasoning_content` 长度 / `reasoning_tokens` / 实际 `max_tokens`，推理占满时直接提示调大 max_tokens |

**实测**（用 P3 节点 80 的真实 key + 模型 `deepseek-flash`，只读 `/v1/models` 确认可用模型
= `['deepseek-flash', 'deepseek-v4-pro']`）：

- 端点仍填基址 → 实际请求 `https://api.deepseek.com/v1/chat/completions` → **成功出词**（176 字）
- `max_tokens=120000`（节点存档值，限额 131072）→ 成功
- 故意 `max_tokens=64` → 报错给出 `finish_reason=length，reasoning_tokens=64` 的线索

**注意**：`deepseek-flash` 是**推理模型**（先 `reasoning_content` 再 `content`），
max_tokens 给小了会出现"正文为空"；自定义通道默认 4096，够用。

**坑**：往类体里插模块级辅助函数会 IndentationError —— 辅助函数要放在 class 之前。


## 待做
- 阶段3: P3 实弹(直通段×manifest 登记×尾段context续接)
- 直通段 shot 的 P3 实弹验证(下一段独立开场)
- "回"字截断根因深挖(已列必查项)
- [挂起-0924] 二采 tiled forward 832x1440 偶发 0xc0000005(c10.dll 写已释放显存映射, 16:40/19:35 两录, dump已解析)。
  异恒决定: 不降二采倍率/不弃二采/不降驱动/不做大改源码。根因方向: torch 2.13.0+cu130 线程池与
  nvcuda64 交互的内存生命周期竞态。候选小改(未批准, 等拍板): h3_tiling 每 tile .cpu() 前加
  torch.cuda.synchronize(); 上游 yolain/ComfyUI-Easy-Media 亦未修(4 commit 未见触及)。


### 09-25 · `easy saveVideo` 重构：DynamicCombo → 固定输入

**现象**：P3 里「保存视频」节点重载/重启后参数错位。

**根因（无头 Edge 载入 P3 读 DOM 真值）**：存档 `widgets_values = ['video', 24, 'preview_only']`，
但 DynamicCombo 的子控件（只有 images+audio 模式才有 `fps`）在加载期尚未创建 →
前端按位置还原时整体错位一格：`input_mode='video'` ✓ 而 `output_mode='24'`、`filename_prefix='preview_only'`。
`output_mode='24'` 会让 `write_temp=False`、`hide_preview=False` → 直接写 output 且推预览，行为完全偏离预期。

**重构**：
- `input_mode` / `output_mode`：`io.DynamicCombo.Input` → `io.Combo.Input`（普通下拉，选项字符串不变）
- `images` / `fps` / `video` / `audio` 提为固定输入（IMAGE/VIDEO/AUDIO 是 socket 类型，不占控件位）
- `execute()` 改平铺签名，并保留 dict 兼容分支（旧动态负载仍可解）
- 控件顺序保持 `input_mode, fps, output_mode, save_metadata, filename_prefix` → 老存档按位置还原自然对上

**连带**：`nodes/project.py` API 构图去掉 `input_mode.*` 前缀；`tests/test_minimax_node.py` 10 处键名更新；
`tests/test_easy_save_video.py` 调用改平铺 + 桩件补 `PromptServer.instance.routes/sockets`。

**验证（真机）**：
- `/object_info`：required=`[input_mode, fps, output_mode, save_metadata, filename_prefix]`，optional=`[images, video, audio]`
- 无头 Edge 载 P3：node25 = `video / 24 / preview_only / false / ComfyUI`（错位消失）
- `/prompt` 实跑：video 模式 + `preview_only` → 落 `temp/probe_sv_video_00001_.mp4`（865 KB）；
  images+audio + `hide&save` → 落 `output/probe_sv_images_00001_.mp4`（5 帧 64×64），均 `success`

**遗留**：P3 存档里该节点 `inputs` 仍带旧孤儿端口 `input_mode.video` / `input_mode.audio`（link 为空，无害）；
`input_mode` 类子输入图在 basic.py（resolution）等处也存在同构隐患，本次未动。


### 09-25 · 存量工作流迁移（saveVideo 静态化的连带）

`easy saveVideo` 由 DynamicCombo 静态化后，旧存档里 `input_mode.images/audio/fps/video` 这些带点端口
在 schema 里已不存在 → 前端把它们当**孤儿端口**保留：看着像重复端口（本地化缺失时显示成英文 `video`/`audio`），
连线还会被一起提交（`"input_mode.images": [...]`，后端不认识），且 Ctrl+S 也清不掉（serialize 会写回）。

扫全目录命中 4 个文件并已迁移（整目录备份 `D:/workspace/wf_backups/migrate_savevideo_*`）：
| 文件 | 问题 | 处置 |
| --- | --- | --- |
| MinimaxH3_ForLoop_MultiShot.json node33 | images/fps/audio 三路连线在带点端口上 | 端口改名并把 links[].target_slot 重算到新序（images=0/audio=2/fps=4） |
| MiniMaxH3_v1.3.1_Easy_Project_AllInOne.json node25 | video 连线在带点端口；named 值错位（save_metadata="ComfyUI"） | 改名为 video（slot1）；值按新序重写成 5 项 |
| P3a-Easy_Project_AllInOnev_1.3.1.json node25 | 值错位（fps="preview_only"、output_mode="ComfyUI"） | 值重写；连线 video←17:0、filename_prefix←17:1 保留 |
| P3-Easy_Project_AllInOnev_优化.json node25 | 仅两个空孤儿端口 | 删除孤儿，值已有 |

迁移要点：**`widgets_values`（按位置）与 `widgets_values_named`（按名）都要改**——
旧存档的 named 表同样是错位时写下的（如 `{input_mode:'video', output_mode:24, filename_prefix:'preview_only'}`），
只修一个的话，不同浏览器因还原策略不同仍会各自错。

验证（无头 Edge 逐个文件）：端口序列 = `images, video, audio, input_mode, fps, output_mode, save_metadata, filename_prefix`、
无带点端口、连线落点正确（graphToPrompt 的源节点/槽位）、控件值正确、切标签页后值不丢 → 4/4 PASS。

## 2026-09-25 工作台面板高度被"重置"（computeSize 自引用）

**症状**：用户调整提示词工作台节点高度后，载入/配置时高度被顶高（"有概率重置"）。

**根因**：`deciia_prompt_studio.js` 里
`node._dpsDomW.computeSize = () => [node.size[0], Math.max(340, (node.size[1] || 700) - 112)]`
引用了节点自身高度，而前端给"节点上其他控件"的真实预算约 206px（112 太低）。前端把
`computeSize 高度 + 其他控件高度` 当作节点最小高度 → 每轮 configure 顶高 (206-112)=94px。
实测：存档 1011 → 载入 1106；缩到 460x500 → 重载 460x594。

**改法**：
1. `computeSize` 固定 `[node.size[0], 240]`（切断自引用；面板用 `height:100%` 吃满节点高度）
2. `.dps-ed` min-height 152 → 100
3. 去掉 `onNodeCreated` 里"尺寸偏小就顶到 460x700"的兜底（不再主动改节点尺寸）

**验证**（无头 Edge 载入 P3）：存档 510x1011 → 载入 510x1012（Δ1px）；设 460x520 → 重载保持 460x520；
新建节点默认 400x256；面板高度始终 = 节点高 - 238，无溢出。

## 2026-09-25 同步上游 bd4ebf2 (#110) — reference 双模式跳过冗余 TE

**上游改动**：`nodes/project.py` 的二采条件加 `generation_mode != "reference"`（reference 模式没有画布尺寸关键帧，
两次采样分辨率必然一致，可以共用文本/媒体嵌入，不必为二采再跑一遍 TE）；`tests/test_minimax_node.py` +26（新增 dual+ref 图结构断言）；两个 CHANGELOG。

**合并安全性判定（针对本 fork 已重构的前提）**：
- `git merge-tree` 退出码 0 → 无文本冲突；实际改动面仅 4 个上游文件
- 未涉及 `dist/` 与前端源码 → **不需要 `bun run build:release`**（本 fork dist 带补丁，撞上就得重建，这次绕开）
- 本 fork 在同文件（`nodes/project.py`）的改动集中在直通段与 saveVideo 平键化，与上游那处 hunk 无重叠；上游 hunk 的上下文行（`base_positive = second_pass_positive = conditioning.out(0)` 一线）本地未动

**验证**：
- 树级核对：`deciiaPassthroughStage` / `_deciiapass_entries` / `_h3_manifest_context_cut` / `easy saveVideo` / `PromptStudio` 挂点全在；`input_mode.` 动态键残留 0；上游新条件落地 1 处
- `py_compile` 全绿；merge commit 第二父节点 = 上游 `bd4ebf2`（真合并，非 origin/main 的假合并）
- **上游新增测试 headless 实跑：`1 passed`**（配方见下）；同文件基线其余 247 条仍因 `routes.py: PromptServer.instance` 缺失而 ERROR —— 环境性断裂，与本次合并无关
- 重启后 `/object_info`：5113 个节点类型，自有节点 `easy saveVideo` / `easy promptStudio` / `easy multitrackProject` / `easy deciiaPassthroughStage` 均在
- `git ls-remote origin refs/heads/main` 与本地 HEAD 一致

**headless 跑本仓 pytest 的桩件配方**（`pytest -p <plugin>`，插件置于 PYTHONPATH）：
1. `sys.modules["server"]` 装宽松桩件：`PromptServer.instance` 必须带 `routes`（get/post/delete/patch，返回装饰器）、`sockets={}`、`app.middlewares=[]`，其余属性用 `__getattr__` 兜底（`test_easy_save_video.py` 里只有 `routes`，上游那条还需要 `app`）
2. 本 fork 新增模块（如 `easy_media.nodes.deciiapassthrough`）不在上游测试的桩件表里 → 预注册，并给出 `PASSTHROUGH_CONTEXT_FRAMES=22` 与 `is_passthrough_task` / `passthrough_continuity_mode` 两个函数；**兜底切勿返回类对象**，否则 `inspect.getsourcefile` 会崩
3. 命令：`cd <ComfyUI 根> && PYTHONPATH=<scratch> python -m pytest custom_nodes/ComfyUI_Deciia_EasyMedia/tests/test_minimax_node.py -k <测试名> -q -p <插件模块名>`
4. 报 "ERROR at setup ... PromptServer" 属基线断裂，先按第 1 条补齐桩件再判断是不是真失败
