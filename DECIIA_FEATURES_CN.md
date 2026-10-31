# ComfyUI_Deciia_EasyMedia 我方新增功能说明

> 本文面向使用者，逐模块说明本 fork 相对上游**新增或重构**的能力：功能是什么、解决什么问题、具体怎么用（节点名 / 面板按钮 / 参数名）、以及边界在哪。
> 上游原生的能力（多轨编辑器本身、多轨任务输出、提示词增强器基础版、字幕/ASR、LTX/Bernini 节点等）不重复列举，只在必要时标注「上游既有」。

---

## 0. 与上游的关系

本仓库是 [yolain/ComfyUI-Easy-Media](https://github.com/yolain/ComfyUI-Easy-Media) 的 fork（基线见 `UPSTREAM.md`），**保留上游全部功能**并持续合并上游更新，在此之上叠加本地扩展。

扩展方向大致四个：

- **导演级工作流**：在「多轨编辑器」之上加了一整套创作台——分镜编排、主体与资源库、提示词增强工作台、AI 助手（工具调用 + 技能包），把「一句想法」推进到「可直接提交的多轨项目」。
- **项目化与持久化**：项目类型（视频 / 图片 / 音频）、项目时间线落盘（`timeline.json`）、自动保存与 Ctrl+S、时间线同时随工作流保存，以及项目级的采样模式与画布预设。
- **出片端重做**：把上游的「保存视频」重构成 **Save Media**——视频 / 图像序列 / 音频三种保存形态、多类型输入槽、缩略图网格、另存为、文件详情、调色台实时预览与烘焙、跨标签页保持上次成片。
- **H3 生产链路增强**：任务段级直通（passthrough）、上下文续接与 `context_cut` 切断、多率采样（视频只提交 1 次）、`audio_first` / `image_first` 采样模式、以及 T8 fork 的双钟采样 / 学习型潜空间放大 / 二采细节混合节点组。

---

## 1. 多轨编辑器扩展（easy multiTrackEditor）

上游已提供多轨编辑器本体（任务 / 视频 / 音频 / 字幕轨、片段裁剪、预览、`TRACKS_INFO` 输出）。本节写我们**新增或改造**的部分。

### 1.1 项目栏与项目类型

编辑器顶部项目栏（`项目` 下拉 + `新建` / `保存` / `另存为` / `删除` / `刷新`）由我们重做，新增「项目类型」概念，新建项目时先选类型：

| 项目类型 | 新建时画布预设 | 采样模式（强制） | 用途 |
|---|---|---|---|
| 视频项目 | 9:16 竖屏 @ 1.0 MP | 不变 | 常规视频生成 |
| 图片项目 | 9:16 竖屏 @ 2.0 MP | `image_first` | 出图：每段只解码 22 帧、挑候选帧 |
| 音频项目 | 64×64（极小画布） | `audio_first` | 有声书 / 配音 / 音效，只解码音频 |

- 项目类型**在创建时固定**，之后不再提供切换入口（避免画布与采样模式互相打架）。
- 后端会二次校验：项目类型为 `audio` / `image` 时，`easy multitrackProject` 会把 `sampling_mode` 强制成 `audio_first` / `image_first` 并打印提示，防止旧工作流跑错模式。
- 编辑器输出新增 **`PROJECT_NAME`**（`STRING`）：把它接到「多轨项目」或「多轨项目视频合并」的 `project_name` 输入，即可用连线覆盖手填值，避免三处手填不一致。未绑定项目时输出 `default`。

### 1.2 轨道、片段与参考作用域

- 轨道类型：任务轨、视频轨（最多 3 条）、音频轨（最多 3 条）、字幕轨；可拖拽左侧图标调整顺序。
- 视频 / 音频片段新增**参考范围**三态（右键菜单「参考范围」）：
  - **不作为参考**（off）
  - **对齐片段**（aligned）：只对与它时间重叠的任务片段生效，拖动片段即可改覆盖范围；
  - **全局使用**（global）：所有任务片段都能把它选作参考。
- 片段级**静音**：静音只是不参与生成（视频片段的原声一起静音），锁定 / 参考关系不受影响。
- 片段操作：右键菜单含 `复制片段` / `复制视频` / `复制音频` / `拆分片段` / `删除片段`，工具栏有 `均分片段` / `合并片段` / `智能分割` / `智能分割（仅任务）`。
- 任务片段编辑器（选中任务段后右侧面板）分 `逐段编辑` / `整体编辑` 两个页签；整版可用 `应用到所有` 把当前片的用户提示词覆盖到所有段（含 A/B 两稿）。
- 任务段参数：`任务模式`、`衔接模式`、`参考图像尺寸`、时长（帧 / 秒），以及提示词区的系统提示词 / 用户提示词 A/B。
- 参考音频额度：每条任务轨片段最多挂 **3 段参考音频**（`MULTITRACK_MAX_REFERENCE_AUDIOS = 3`，对应 H3 的 `ref_audio_1..3`）；上面任务模式表里的「参考音频 0–1」是任务判型用的额度，不是这个上限。

**任务模式 ↔ 素材约束**（面板与助手都按这张表校验，越界会被提示或写入被拒）：

| 任务模式 | 面板标签 | 映射到的 H3 类型 | 图片 | 参考视频 | 参考音频 |
|---|---|---|---|---|---|
| `default` | 文图 / T2V | 无图→`t2v`；1 图→`i2v`（首帧） | 0–1 | 0 | 0 |
| `ref` | R2V | 参考图→`r2v`；带参考视频→`rv2v` | 1–9 | 0–1 | 0–1 |
| `edit` | VI2V | 有图→`vi2v`；无图→`v2v` | 1–9 | 0–1 | 0–1 |
| `l2v` | L2V | `l2v`（尾帧） | 1 | 0 | 0 |
| `passthrough` | 直通 / Pass | 不采样，直接出片 | 0 | 0 | 0 |

- `衔接模式`：`分镜`（shot，切断）/ `上下文`（context，留续接）/ `上下文(漂移控制)`（context_drift，保留动作连续性同时替换外观）。直通段只保留「分镜 / 上下文」有效，漂移控制置灰，并提示「直通段：参考失效（该区间原样输出）」。
- `参考图像尺寸`：`匹配尺寸`（按生成面积缩放）/ `最大尺寸`（保留更大参考图，主体一致性更好但更慢）。

### 1.3 提示词引用：`@` 与官方令牌

- 用户提示词编辑区支持 **`@` 引用**：输入 `@` 弹出「可能@的内容」列表（图片 n / 音频 n / 视频 n），选中后插入一枚带缩略图的 chip。
- 写入时统一成 H3 官方令牌：`<Picture n>` / `<Audio n>` / `<Video n>`（主体场景另有 `<Subject n>`，见 §3）。编号口径与后端完全一致：
  - `<Picture n>`：任务段 `content.images` 里**未被禁用**的图片顺序（禁用的图不占号）；
  - `<Audio n>`：视频轨内嵌音轨先占号，再排音频轨；
  - `<Video n>`：视频轨顺序。
- 用户提示词 **A/B 两稿**：下单时按所选稿输出（选 A 出 A、选 B 出 B），可用于对比，或「A 存原稿 / B 存反推后的稿」。
- 提示词覆盖：编辑器输入 `prompt_override`（上游既有）可用 `easy minimaxPromptOverride` 等节点从外部整段覆盖；接上后轨道里的段提示词被忽略。若同时接了 `duration_frames`（如用 `easy clipTiming` 把 fps+秒换算成帧），则忽略任务轨、按该帧数重建单段，任务类型按接入的媒体自动推断。

### 1.4 项目保存 / 读取 / Ctrl+S

项目栏的行为：

- **`项目` 下拉**：列出磁盘上的项目；`默认（仅保存在工作流中）` 表示只靠工作流里的 `track_data` widget 保存，不落盘。
- **`保存`**：把当前时间线写到 `<output>/easy_media/projects/<项目名>/timeline.json`；**`另存为`** 换名写新项目；**`删除`** 需点两次确认，只删 `timeline.json`，不动视频产物 / `context_latent_*` / `project.json`。
- **自动保存**：停止编辑 **2.5 秒**后自动写盘，状态显示「保存中… / 已保存 HH:MM:SS」；失败会退化成「⚠ 自动保存失败，请用 Ctrl+S 手动保存」。
- **Ctrl+S**：在编辑器内按 `Ctrl+S`（macOS 为 `⌘+S`）立即保存，不触发浏览器保存网页。
- **时间线与工作流一起保存**：`track_data` 本身就是节点 widget，跟着 workflow 序列化；因此「同一份工作流 = 同一份时间线」，而具名项目额外获得一份磁盘副本（跨工作流复用、跨窗口共享）。
- **并发保护**：保存可携带 `base_updated_at`，与磁盘不一致时后端返回 409，前端提示「该项目已被其它窗口修改，请刷新后再保存」，不静默覆盖。
- 有未保存改动时切换项目 / 新建会要求二次点击确认（「再点一次切换（放弃改动）」）。

**已知限制**：单个 `timeline.json` 上限 8 MB（超出拒绝写入）；项目名会按 Windows 规则净化（禁路径分隔符、保留名、UTF-8 180 字节上限）；项目名绑定的是磁盘目录，重命名项目不会搬动已有生成产物。

---

## 2. 提示词增强工作台（导演工作台）

这是把「想法 → 分镜 → 主体/资源 → 最终提示词 → 写入任务轨」串起来的一体化工作台。

### 2.1 打开方式与总体布局

- 入口：在多轨编辑器里选中一个任务片段，点右侧任务片段编辑器「用户提示词」旁的 **✨（提示词增强）** 按钮，弹出 `导演工作台` 模态窗。
- 布局：左栏分镜/资源列表，中间编辑与预览，**右侧常驻 AI 助手栏**（可折叠）。顶栏有 `API 设置`（服务商 / 模型 / Base URL / API Key / 上传参考图给模型识别 / 配置保存位置）与 `关闭`。
- 页签共 **3 个**：`分镜编排` / `主体与资源` / `提示词增强`（早期设计里的第 4 个「素材」页已并入「主体与资源」，当前构建只有这 3 个）。
- 顶栏的 `保存到任务轨` 会先弹「完善度检测」面板，逐项列出：分镜脚本段数/时长、任务分段数与已写提示词比例、主体数与缺描述数量、资源需求匹配数；同时可勾选保存目标（`task` / `video` / `audio` / `subtitle`）。确认后一次把全部段写入任务轨（见 2.4）。

### 2.2 分镜编排页

- **生成整片分镜**：给出想法（时长、类型、人物、场景），AI 产出结构化分镜脚本——每段含名称、beat（戏剧功能）、时长、镜头表（景别 / 机位运动 / 动作 / 台词 / 微表情 / 声音 / 转场）、摘要、A 稿（简化版用户提示词）。
- **改写分镜**：在现有脚本上按修改要求重写（拆段 / 合并 / 改台词 / 调节奏 / 换风格）。
- **增删段**：新增一段（可指定插在某段之后）/ 删除某段。结构变更只会报告受影响的段与「已过期」的提示词，**不会自动重写**片段稿/终稿。
- **应用到任务轨**：把脚本落成任务轨片段（段名、时长、brief、任务类型、衔接模式、参考图）。默认只替换结构、不动任务轨里已有的提示词；只有明确要求时才连提示词一起写入。
- **导入主体 / 资源需求**：脚本生成后一键把主体、资源需求导入「主体与资源」页（缺件的会标记「缺素材」）。
- 段详情默认只读，点 `编辑` 才进入可改状态（`完成` 退出）；可改字段包括名称 / beat / 时长 / 摘要 / 导演备注 / 镜头表 / 台词。
- 兼容性：分镜脚本可与「曜石导演台」的文本分镜格式（`# 镜头名 | 4秒` + 正文）互相导入导出。

### 2.3 主体与资源页

- 三类资源：`Subject`（主体，可有子资源）、`Picture`、`Audio`、`Video`。主体字段：名称、类型、定义描述、引用关系、保留描述、是否「引用时自动追加资源」、绑定的子资源列表。
- 资源需求行会显示状态：已在资源池且已绑定素材 / 在资源池但缺素材（`去「主体与资源」补件`）/ 还没加入资源池。
- 画布上的 **`主体库` 节点**（`easy subjectLibrary`）里的主体会被本页合并进来（同名去重），见 §3。
- 共享资源浏览器可浏览 ComfyUI `input` / `output` 目录挑选素材；缩略图悬停可放大预览（限制在视口内）。

### 2.4 提示词增强页

这是"把分镜段写成模型提示词"的地方，也是本工作台最核心的一页：

- **A/B 稿对照**：左栏是「片段提示词（A/B 原稿，可粗）」，中栏编辑最终提示词，右栏是任务轨片段**只读对照**（A 版 / B 版 `user_prompt`、参考资源）。脚本段未落地到任务轨时会提示「请先在『分镜编排』点『应用到任务轨』」。
- **绑定清单与令牌契约**（严格同源）：
  - 编号按**绑定清单顺序**展开：主体先出，其子资源紧随；同类型按出现顺序编号；
  - 提交给工作流的 images 顺序 = 令牌编号顺序，因此改了绑定顺序就会重排编号；
  - 界面上「本段引用」逐条列出草稿里实际出现的令牌、对应资源名，未绑定的标 `未绑定`；
  - 助手侧有 `retoken_prompts` 工具按当前绑定**重排提示词令牌**（默认 dry-run 只给逐行 diff，`confirm=true` 才写回）；越界的「幽灵编号」会被整条移除，已升格为主体的图片会被改写成 `<Subject n>`。
- **令牌硬规则**：人物/四视图/面部特征必须用 `<Subject n>` 定义；用 `<Picture n>` 单独定义人物属结构错误，会被退回并给出改法（把图并入主体行）。该用主体却用了图片时会给出建议（写「仅借构图」可放行）。
- **提示词质量条**（编辑区上方）：
  - 按段任务类型自动切换 `六段式(R2V/VI2V)` / `三段式(T2V)`；
  - 检查缺失段落、缺失引用，一键插入缺失段的骨架；
  - 「本段引用」区可一键把某个资源按当前编号插入正文。
- **生成与校验**：`生成` 走所选模型（支持官方 H3 / 自定义 OpenAI 兼容端点 / 本地 llama.cpp），结果先过校验器（六段齐全、令牌还原、编号在段内资源范围、`<d>` 成对、`[Shot N]` 不越界、无字幕水印类描述）。**校验不通过不会替换原文**，只报失败项。
- **写入任务轨**：`写入任务轨（A）` / `写入任务轨（B）` 按钮把中栏最终提示词写回当前任务段的对应稿；`保存到任务轨` 则是全量写入（逐段带终稿、绑定参考图与任务类型）。
- **两种生成分层**：`片段稿(target=fragment)` 与 `终稿(target=final)` 是两个独立目标，助手被约束「只做当前段」，不会顺手改其它段。

### 2.5 AI 助手栏与工具调用

- 常驻右栏，支持 Enter 发送 / Shift+Enter 换行、工具调用轨迹（名称 / 参数 / 结果 / 状态）、`ask_user` 反问（除选项外还能自由文本回答）、`update_todos` 进度清单、`dump_state` 导出调试快照。
- 工具集共 **59 个**，按用途分组（下表为节选，未列出的还有 `delete_segments` / `update_segment` / `write_prompt` 等）：

| 组 | 工具 |
|---|---|
| 分镜 | `plan_storyboard` `revise_storyboard` `add_segment` `delete_segment` `merge_segments` `split_segment` `patch_segment` `get_plan` `get_segment` `list_segments` `apply_storyboard` `set_plan_settings` |
| 主体/资源 | `list_resources` `upsert_subject` `upsert_resource` `bind_resources` `link_subject_assets` `promote_pictures_to_subject` `plan_assets` `audit_assets` `delete_resources` `undo_last_delete` `set_resource_brief` `retoken_prompts` `list_bindings` |
| 提示词 | `generate_prompt` `generate_all_prompts` `write_prompt` `get_prompt_context` `validate_prompts` `fix_prompts` `explain_task_modes` |
| 任务轨 | `list_task_track` `set_task_modes` `delete_task_segments` `sync_task_images` `repair_task_images` `attach_media` |
| 素材/生成 | `list_input_files` `list_outputs` `list_projects` `inspect_images` `generate_resource` `generate_resources_batch` `get_generation_status` `run_generation` |
| 项目/记忆 | `verify_project` `save_project` `remember` `recall` `recall_memories` `memorize` |
| 技能/元 | `list_skills` `read_skill` `ask_user` `update_todos` `dump_state` |

- **意图-工具映射**：例如「资源需求」类请求只会走 `plan_assets` / `bind_resources`，绝不写提示词；「替换分镜 / 应用到任务轨」只允许走 `apply_storyboard`，禁止用 `set_task_modes` 或逐段改任务轨替代。
- **读图审片**：`inspect_images` 走 `/easy-media/agent/vision`，一次最多 6 张、单张 8 MB，输出「主体数量 / 构图机位 / 关键物件 / 明显错误 / 与提示词是否相符」要点式结论。
- **生成缺失资源**：`generate_resource(s)` 按 `resource_workflows.json` 里配置的 ComfyUI API 工作流跑图 / 配音 / 音乐 / 参考视频，结果自动挂到「主体与资源」页。
- **记忆**：项目级长期事实（素材路径、风格偏好、人物设定）可写入记忆，后续会话自动带上。

### 2.6 技能包（skills/*.md）

- 目录：`<ComfyUI>/user/DeciiaEasyMedia/skills/*.md`，每个文件就是一个技能包，纯 Markdown，改完即时生效（无需重启）。
- 系统提示里会自动附上「可用技能包」清单，并强制助手「写提示词/分镜前先 `read_skill` 按需读取，不要凭记忆编规范」——按需加载，避免一次性塞爆上下文。
- 项目类型分派：音频项目写提示词前先读有声书套路（角色音色表 + 切段表要先给用户确认），图片项目先读漫画套路（页/格拆分表先确认），视频项目读 H3 规范与 Ref2VA 官方写法。
- 我们维护的典型包：`h3-prompt-spec`（H3 写法规范）、`h3-ref2va-official`、`h3-base-official`、`task-modes`（任务模式决策表）、`audiobook-prompts`、`comic-prompts`、`style-presets`、`director-workflow`、`tool-routing`。

### 2.7 导演台设置

弹窗内 `API 设置` 与设置项会按项目名存到 `localStorage`（键 `easy-media-director-settings:<项目>`）：

- `保存目标`：task / video / audio / subtitle 四个开关；
- `默认稿`：A 或 B；`覆盖方式`：合并 / 只补缺 / 整体替换；`写入图片`、`写入段设置`；
- 音频：角色轨命名、各角色默认 dB、参考音频是否静音；
- 字幕：是否启用、来源（台词 / 带标签描述）、是否保留说话人、中英双语、是否生成配音、字号/颜色/描边/背景/纵向位置；
- 助手上下文开关：节点设置 / 轨道数据 / 分镜 / 手填主体 / 手填资源 / 绑定清单；`技能预设`（h3 / action / arthouse / animation / custom）与 `提示词写作规则`（自定义 system_extra）。

### 2.8 提示词工作台节点（easy promptStudio，中文显示名「提示词工作台」）

工作台模态窗负责「整片 + 全项目」，这个**节点**负责「边生成边改一段」的轻量场景：

- 输入：`轨道信息`（接多轨编辑器 / 多轨任务输出的 `TRACKS_INFO`）、`图像` / `音频` / `视频`（透传，并作为素材架编号兜底）、`系统提示词1`、`用户提示词2（基线）`、`previous`（链式依赖，只用于排序）、`task_index`（片段索引，0 起，`-1` = 整条时间线，此时素材架不可用）、`mode`（`改写` / `生成`）、`提示词3`（正文）。
- 输出：`PROMPT`（最终提示词，可交给提示词增强器或手动回填编辑器）+ `IMAGES` / `AUDIO` / `VIDEO` 透传。
- 面板上有**素材架**：把当前片段的图片/音频/视频以缩略图直接铺开；在正文里打 **`@`** 弹出带 32px 缩略图的列表（↑↓ 移动、Enter/Tab 选中、Esc 取消），插入后是一枚内联 16px 缩略图的 chip。支持撤销栈、粘贴转纯文本。
- 上方是上游只读区（`轨道信息` / `图像` / `音频` / `视频` / `系统提示词1` / `用户提示词2（基线）`），一行两个折叠 chip，点开才显示正文。
- 工具栏：`↻ 刷新`（重新解析素材）、`采用基线`（把用户提示词2 灌进提示词3）、`清空`、`复制`。
- 两种模式：`改写` —— 以提示词3 为准，留空回退用户提示词2；`生成` —— 只用提示词3。
- 素材编号口径与多轨编辑器完全一致（`<Picture n>` / `<Audio n>` / `<Video n>`），解析走同一个后端函数，不另写一套。
- **只读**：节点不改 `TRACKS_INFO`、不写回编辑器；回填由用户手动完成，或交给 `easy multitrackPromptEnhanceToProject`。

**已知限制**：`task_index=-1`（整条时间线）时素材架不可用；节点不保存素材文件、只引用路径，input 目录里的文件被移走会显示不出来；原生文本框已被面板接管（`computeSize` 收成 0 高度），需要在面板里编辑而不是双击 widget。

**本节已知限制**：设置存 `localStorage`，换浏览器或清缓存会丢；工作台只是**读**项目数据并回写任务段提示词/任务类型/参考图，不改动轨道结构与媒体文件本身；AI 侧能力依赖你配置的外部模型端点（未配置时报 API 错误，不影响手工编辑）。

---

## 3. 主体库节点（easy subjectLibrary）

- 节点：`easy subjectLibrary`（显示名 `主体库 / Subject Library`，分类 `EasyUse/MultiTrackEditor`），面板是主体卡片列表。
- 每个主体：`名称` / `类型` / `定义描述` / `引用关系` / `保留描述` / `绑定资源`（input 相对路径）/ `引用时自动追加资源`。
- 输出 `SUBJECT_CONFIG`，并附带 `global_prompt`（整支视频中持久出现的角色/物体/场景约束）、`problems`（名称非法、未绑定资源等校验提示）、`count`。
- 设计要点：主体**不保存编号**——`<Subject n>` / `<Picture n>` 的编号由任务段内资源顺序派生，所以插入/删除素材不会让已有提示词失效。不接此节点、不引用主体时，编辑器行为与原来完全一致（零侵入）。
- 兼容 RefDirector 的 `{"subject_data": {"subjects": [...]}}` 结构。
- 工作台「主体与资源」页会读取画布上所有 `主体库` 节点的主体（同名去重），两边共用一份数据。

**已知限制**：节点只负责「定义 + 校验 + 输出配置」，本身不渲染参考图；主体与素材的绑定仍要在「主体与资源」页完成；同名主体跨类型时需用 `类型:名称` 或 `id:` 指定。

---

## 4. 保存媒体（Save Media，节点 id 仍是 `easy saveVideo`，中文显示名「保存媒体（视频/音频/图片）」）

上游的「保存视频」被整体重构为 **Save Media**：一个节点吃三种媒体，产出三种保存形态。

### 4.1 输入槽与保存形态

| 参数 | 可选值 | 说明 |
|---|---|---|
| `input_mode` | `images+audio` / `video` | images+audio=把 IMAGES（可带 AUDIO）按 fps 编码成视频；video=直接保存 VIDEO（接了 AUDIO 则替换音轨） |
| `images` | IMAGE | images+audio 模式的图像序列 |
| `fps` | 1–120（默认 24） | images+audio 模式帧率 |
| `video` | VIDEO（运行时按实际类型分流） | 视频入口：保存 / 从其音轨另存音频 / 抽帧存图片；若实际接的是 IMAGE 会并入图像序列、接的是 AUDIO 会并入音轨 |
| `audio` | AUDIO | 可选音轨 |
| `media` | **多类型**：IMAGE / AUDIO / VIDEO / EASY_MEDIA | 「自动判断」槽：接什么存什么，并强制切换保存类型 |
| `save_kind` | `video` / `images` / `audio` | 保存形态；面板上是三个图标：🎬 保存视频 / 🖼️ 保存图像序列 / 🎵 保存音频 |
| `image_format` | PNG / JPG / WEBP | `save_kind=images` 时的图片格式（JPG/WEBP 质量 92） |
| `audio_format` | WAV / MP3 / FLAC | `save_kind=audio` 时的音频格式（MP3 192k） |
| `output_mode` | `save` / `preview_only` / `hide` / `hide&save` | 写 output / 只写 temp 并预览 / 只写 temp 不预览 / 写 output 不预览 |
| `video_format` | 跟随源(AUTO) / MP4(H264) / MP4(H265) / MOV(H264) / MOV(ProRes) / MKV(H264) / WEBM(AV1) / GIF / WEBP | AUTO、MP4(H264)、MKV、WEBM 走原生保存，其余走 FFmpeg 转码 |
| `custom_save_path` | 字符串 | 自定义保存目录（绝对路径直用，相对路径按 output 解析；仅 save / hide&save 生效） |
| `adopt_source_video` | 布尔 | 目标容器与源一致、未换音轨、未写元数据时直接流复制，不重编码 |
| `cleanup_after_save` | 布尔 | 出片后卸载模型并清显存（出错也清） |
| `notify_sound` | `sounds/` 目录里的音频 | 出片提示音，默认静音 |
| `filename_prefix` | 字符串 | 留空或填 `ComfyUI` 时自动回退 `easy_media/save` |

输出槽（四路）：`图像透传`、`视频透传`、`音频透传`、`文件路径`。

**自动判型与报错**：只接视频会自动进 video 通道；只接音频走纯音频通道；接了 `media` 槽则由输入类型决定保存形态。若所选保存形态与接线不符（例如只接音频却要存视频），会**明确报错并列出可用形态**，不再静默取第一个可用输入。

### 4.2 面板

- **视频详情**（默认折叠，标题栏可展开）：累计用时、文件名称、物理尺寸、总帧数（图片形态显示「N 张」）、播放时间、视频帧率、文件体积、编码格式、音频（有声/—），另有 `复制全部`。
- **路径行**：显示完整落盘路径，`打开目录` 直接调起资源管理器。
- **播放器**：保留 ComfyUI 原生控件条（时间码/进度/音量/全屏），节点宽度变化后会强制重排一次控件条；短视频会显示精确时长（避免原生播放器把 0.92s 圆成 `0:00`）。
  > 注意：播放器内的 `⋮` 三点菜单**已移除**——调色台与视频详情各自有独立按钮，避免与原生控件重复。
- **图像序列**：多图时显示**缩略图网格**（多选需点选），单图时显示静帧预览；`另存为…` 按钮**只在「图像序列」形态、且已选中某一张**时出现，走 `/easy-media/asset/save-as` 把该文件复制到你填写的完整目标路径。
- **音频**：显示音频播放条（只占播放条高度，不留空框）。
- **输入驱动**：切换接线会实时重算可用保存形态，不可用的图标按钮置灰并给出原因（「当前输入不支持，需要接 视频/图像+音频」等）。
- **跨标签页保持上次成片**：成片信息写进节点 `properties.easyVideoInfo`，跟工作流一起序列化，切标签页/重载工作流后播放器自动重新挂上上次的片子。若上次只写了 temp 且已被 ComfyUI 清理，会明确提示「把『输出模式』改成『保存』重新生成」。
- **保存 / 预览语义修正**：`save` 模式的节点在刷新后仍保留预览（历史 bug 已修）。

### 4.3 落盘行为

- **图像序列**：逐帧落盘，命名 `前缀_00005_0000_.png`（计数器 + 帧序号），详情面板给出首末文件名与总张数；元数据（workflow/prompt）在 `save_metadata` 打开时写入。
- **单图 + 音频**：自动把这张静帧铺满音频时长，输出等长视频（此前只会出 1 帧的极短视频）。
- **单图 + 无音频**：拒绝生成视频并提示「请把保存类型切成 🖼️ 保存图片」或补音频。
- **音频**：视频无独立 AUDIO 输入时从视频音轨抽取；WAV 直接复制，MP3/FLAC 走 FFmpeg（需系统有 ffmpeg）。
- **尺寸规整**：图像序列编码前会把宽高裁到偶数（避免编码器报错）。

### 4.4 调色台

- 入口：画面右下角按钮（`调色台（展开/收起）`）。
- 四组参数：`🎨 饱和度`；`✨ 泛光 Bloom`（强度 / 起点 / 范围）；`🌫️ 柔雾 Mist`（强度 / 柔焦范围 / 灰雾浓度）；`🔥 暖晕 Halation`（强度 / 起点 / 范围）。`♻️ 重置` 恢复默认。
- `应用并导出` 调 `/banzhang_api/bake_video` 做**真实烘焙**，返回新文件名并在状态行显示耗时。

**已知限制**：调色台在面板里的预览是用 CSS（`backdrop-filter` 叠层）做的**近似效果**，不是真实像素处理，最终以烘焙结果为准；烘焙接口由**班长插件**（ComfyUI_Deciia_Banzhang）提供，未装该插件时按钮会报错；MP3/FLAC、H265/MOV/ProRes/GIF/WEBP 输出依赖系统 FFmpeg；图像序列一次生成的文件数等于帧数（长片注意磁盘）。

---

## 5. 直通（passthrough）：任务段级直接出片

- 在任务段的任务模式里选 **`直通` / Pass**（`task_mode=passthrough`，仅 `format=MiniMax` 显示）。该段**不送采样**，直接把视频轨上覆盖该时间窗的素材裁切、编码、落盘进成片。
- 解决什么问题：混剪/补镜头/整段沿用实拍素材时，不必绕出去手工剪，也不必让模型重生成一遍。
- 实现要点：
  - `nodes/deciiapassthrough.py`：窗口覆盖检查、路径解析、FFmpeg staging、音频窗对位；
  - `nodes/deciiapass_stage.py`：子图节点 `easy deciiaPassthroughStage` 负责 staging + **尾部 22 帧上下文解码**（给下一段续接用）；
  - 直通段会打包进 `TRACKS_INFO`（`info_with_pass_entries`），并由 `utils/h3_project.py` 的哨兵映射走到直通分支。
- 衔接语义（直通段的 `衔接模式` 就是「给下一段留什么」）：
  - `分镜`（shot）：切断 —— 不解码尾帧上下文，写 manifest `context_cut=True`，下一段拿到占位 latent、独立开场；
  - `上下文`（context）：留续接（默认）—— 解码尾 22 帧当上下文；
  - `上下文(漂移控制)`：直通段置灰（直通不产生可漂移的二采上下文）。
- 实跑参考数据（PATCHES.md 记录）：窗口 24–96 精确裁切后 staging 产物 3.00s / 72 帧 / 544×960 / 带音轨；尾上下文 22 帧 / 0.92s。

**已知限制**：直通段不采样，所以段内的提示词、参考图、参考音频**全部失效**（面板会明确提示）；直通依赖 `format=MiniMax` 与多轨项目链路；若上游另有项目级 `sampling_mode=passthrough`（上游 #111 引入），两套并存互不干扰，具体用哪套看你的工作流——任务段级的那套是本 fork 的，生产工作流在用。

---

## 6. 多轨项目生成（easy multitrackProject）

上游节点，我们扩展了采样模式与项目类型联动。核心输入：`project_name`、`project_save`（new / override）、`segment_start_number`、`segment_count`（-1 = 全部）、`seed`、`sampling_plan`（light / medium / …）、`sampling_mode`。

`sampling_mode` 可选值：

| 模式 | 含义 |
|---|---|
| `single` | 单次采样 |
| `dual` | 一采 + 二采（高分辨率上下文分别处理） |
| `dual_t8` | 用 T8 fork 的双钟 + 学习放大 + Reconcile + DetailMixer 走二采（见 §9） |
| `selflift` | SelfLift 高清阶段（可挂独立模型） |
| `passthrough` | 项目级直通（上游形态，见 §5 的限制说明） |
| `audio_first` | 有声剧模式：极小占位画面、只解码音频；额外暴露 `视频提交次数`（默认 1）与 `仅音频分辨率`（64×64 / 32×32） |
| `image_first` | 出图模式：只解码视频、输出 22 帧、挑候选帧；额外暴露 `图片候选帧`（默认 `15`，逗号分隔，从 22 帧里挑） |

- `audio_first` / `image_first` 的两个子控件是**节点级 widget 追加在末尾**（避免旧工作流 `widgets_values` 按位置错位），并由 `web_panels/audio_first_visibility.js` 只在对应模式下显示。
- 其它常用参数：`1st_pass_only`（只跑并保存第一段的一采）、`disable_2nd_noise`、`upscale_by`（默认 1.25）、`upscale_model`、`tile_count`（2–8）、`upscaler_unload`（默认卸载放大模型）。
- 多率采样（`easy minimaxH3MultiRateSampler`）：把「视频提交次数」与音频阶梯解耦——**采样与 shift 交给 plan/预设与模型层，采样器只约束视频提交次数**，实现「音频更新 8 次、视频只提交 1 次」这类配方。

## 7. 多轨项目视频合并（easy multitrackProjectVideoCombine）

- 输入：`project_name`（`force_input`，建议接编辑器的 `PROJECT_NAME`）、`project_data`。
- 输出三路：`文件名前缀`（FILENAME_PREFIX）、`视频`（VIDEO）、`多媒体`（MEDIA，专用 `EASY_MEDIA` 类型，不会被误标成 VIDEO）。图片项目输出图像、视频槽被 `ExecutionBlocker` 挡住；音频项目输出音频。
- 面板可**预览未合并的分段成品**、选择自动/手动合并（`auto_combine=false` 时只做预览不出片），并按项目类型按段预览（音频项目逐段连续播放，图片项目可选每段候选帧）。
- **画布与分辨率预警**：出片前调 `/easy-media/project/canvas_inspect` 检查各段分辨率是否一致，不一致就在节点底部给出明细与可选画布方案（图片项目会跳过这条横幅）。

**已知限制**：合并以「项目目录里已生成的段」为准，未生成的段不会补；改分辨率后旧段不会自动重渲；`auto_combine` 关闭时输出被阻塞，下游节点拿不到媒体。

---

## 8. 上下文链（context latent / artifact / context_cut）

片段之间的「续接」不只是一句提示词，而是一份可落盘的上下文潜空间：

- `easy h3ProjectArtifact` 在段末保存上下文；`easy h3ProjectContextLatentLoad` 在段首取回。`context_latent` 现在是**可选输入/输出**：为 `None` 时写入占位 latent 并在 manifest 记 `context_cut`，下次读取时看到 `context_cut` 就返回占位 latent——这就是「上下文中断」的持久化表达（跨 run 也成立）。
- 衔接模式三态直接映射：`分镜` → 不编码上下文 + `previous_context_cut=True`；`上下文` → 照旧续接；`上下文(漂移控制)` → 用 drift_control 方案替换原先的加噪方案（保留更多运动细节，主体替换/动作迁移更稳，牺牲一点清晰度）。
- `easy h3ContextMediaTrim` / `easy h3MotionContextLatentTrim` / `easy removeH3MotionContextLatent` 负责上下文媒体的裁剪与潜空间清理。
- 显存策略：片段之间与完成二采后，高分辨率上下文只保留 **CPU 上尾部 22 帧音视频数据**，低分辨率一采检查点完整保留以支持稍后继续二采。

**已知限制**：上下文按项目目录 + 段序落盘，换项目名或删 `project.json` 会断链；`context_cut` 的占位 latent 只是标记，不携带任何画面信息。

---

## 9. H3 T8 fork 节点组（easy deciiaH3*）

来源 [t8star/comfyui-minimax-h3-audio-T8](https://github.com/t8star/comfyui-minimax-h3-audio-T8)（GPL-3.0-or-later，见 `THIRD_PARTY_NOTICES.md`），摘取并入本仓库，节点 id 统一加 `easy deciiaH3*` 前缀、归入 `EasyUse/H3/T8fork` 分类，可与原 T8 包共存。算法本体未改动。共 9 个节点：

| 节点 | 作用 |
|---|---|
| `easy deciiaH3DualClockSampler` | 视频/音频分离时钟的采样设置：`steps`、`shift_video`（默认 12）、`shift_audio`（默认 3）、`sampler_name`（`dual_clock_euler` 保留原始双钟路径，其它走 ComfyUI 原生 FLOW_AV）、`scheduler`（`native_flow` 原始 H3 flow 调度 / `beta57` alpha=0.5 beta=0.7 / 其它走内置）。输出 model + sampler + sigmas |
| `easy deciiaH3AVDecode` | 联合 AV latent 解码：输出 frames / generated_audio / video_latent / audio_latent（`decode_video` 可关闭只解音频） |
| `easy deciiaH3LearnedLatentUpscale` | 24 通道学习型 3D latent 放大器（只放视频、保留原生音频 latent）；输出尺寸必被 32 整除；`size_mode`（scale_by / megapixels / 指定宽高）、`aspect_policy`、`max_anisotropy`、`precision`、`release_policy`（offload_after / clear_after / keep_loaded） |
| `easy deciiaH3TwoPassLatentReconcile` | 一采/放大后的潜空间对账，保证二采轨迹可续 |
| `easy deciiaH3TwoPassParityPlan` | 生成二采 refine sigmas（供 DetailMixer 用） |
| `easy deciiaH3TwoPassDetailMixer` | 给「已有的部分高分辨率 refine 轨迹」追加 Tail 细分 / Model-Time Bias / H3 STG / 联合 AV RF Restart，而不是替换成新轨迹；需接 `refine_sigmas` |
| `easy deciiaH3SemanticBridgeConfig` | Semantic Bridge 模型与设置（T8 EXP） |
| `easy deciiaH3SemanticBridgeApply` | 把 Semantic Bridge 应用到条件（T8 EXP） |
| `easy deciiaH3HyperVAE2xLoader` | HyperVAE 2× 加载器 |

配套：多轨项目的 `sampling_mode=dual_t8` 就是把这套串起来的预设入口——「需要双钟调度 + 学习放大 + Reconcile + DetailMixer 时使用；不接 LoRA / 滑条照常工作」。

**已知限制**：模型权重不随仓库分发（Semantic Bridge 放 `models/semantic_bridge/t8_compat`，学习放大器放 `models/latent_upscaler`，HyperVAE 2× 放 `models/vae`）；这些节点标记为实验性（`is_experimental`），超过官方 1920×1088 参考面积不会被阻止，只会报显存风险；`dual_t8` 只在 MiniMax H3 链路有意义。

---

## 10. 其它

### 10.1 提示词结构校验（utils/h3_prompt_validate.py）

纯函数校验器，被工作台与助手共用：六段齐全（`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`）、令牌还原（`<Picture n>` / `<Audio n>` / `<Video n>` 编号不越界）、`[Shot n]` 不越界、`<d>` 成对、禁止字幕/水印类描述。生成结果不通过就不替换原文。

### 10.2 资源生成通道（utils/resource_gen.py）

配置文件 `<ComfyUI>/user/DeciiaEasyMedia/resource_workflows.json`，四类槽位 `image` / `voice` / `music` / `refvideo`，每类写 `workflow`（API 格式工作流路径）+ `output`（输出节点 id）+ `inputs`（`"节点id.字段名": "模板"`）。模板变量：`{{prompt}}` `{{text}}` `{{duration}}` `{{seed}}` `{{reference_image}}` `{{reference_audio}}` `{{negative}}`，其余按字面量写入。路由：`/easy-media/resource-workflows`（GET/PUT）、`/candidates`、`/inspect`、`/generate`、`/jobs/{job_id}`。配置界面在「主体与资源」页的资源生成设置里。

**已知限制**：只能跑 ComfyUI API 格式工作流（UI 格式要先「导出 API」）；任务为进程内阻塞式等待，参考视频往往 5–10 分钟。

### 10.3 轻量面板与前端兼容修复

- `web_panels/` 作为独立 `EXTENSION_WEB_DIRS` 挂载，放 Save Media 面板与 `audio_first` 控件显隐两类轻量扩展，便于热改不必重建 `dist`。
- 前端兼容：ComfyUI 1.53+ / React 19 下的多轨编辑器空白（React #185「Maximum update depth exceeded」）已修；`DYNAMICCOMBO_V3` 加载/运行时切换子 widget 导致 `widgets_values` 错位的问题由 `track-data-realign.ts` + `dynamic-combo-runtime-rebuild.ts` 兜住（含 `resolution` 切到 megapixels 时补建 `aspect_ratio` / `megapixels` 子控件）；`create-react-widget` 的 onChange 身份与渲染合并也做了稳定化。

### 10.4 稳定性：多轨 run 失败时释放缓存

多轨项目一次要建整项目，失败（节点异常 / 手动中断 / 校验错误）时已展开段的 latent、解码帧、conditioning 会留在进程 commit 内存里；多次叠加会顶穿 Windows commit 上限导致进程崩溃。现在失败路径会驱逐**已保存段**的输出（媒体已落盘），只保留失败段的 conditioning 供重试，日志出现：

```
[Easy Media][Project] Run failed at ...: released N cache references
```

**已知限制**：这是兜底，不替代「别在一次 run 里塞满整项目」的操作习惯；释放发生在错误路径，正常完成路径的内存由原有的 segment 缓存机制管理。

---

## 附录：本 fork 新增/改名的节点清单

| 节点 id | 状态 | 说明 |
|---|---|---|
| `easy promptStudio` | 新增 | 提示词工作台（素材架 + `@` 插入 + 改写/生成） |
| `easy subjectLibrary` | 新增 | 主体库 |
| `easy deciiaPassthroughStage` | 新增 | 直通 staging + 尾 22 帧解码（子图内使用） |
| `easy deciiaH3DualClockSampler` / `AVDecode` / `LearnedLatentUpscale` / `TwoPassLatentReconcile` / `TwoPassParityPlan` / `TwoPassDetailMixer` / `SemanticBridgeConfig` / `SemanticBridgeApply` / `HyperVAE2xLoader` | 新增（T8 fork） | 见 §9 |
| `easy saveVideo` | 重构 | 中文显示名「保存媒体（视频/音频/图片）」，能力即 §4 的 Save Media |
| `easy multiTrackEditor` | 扩展 | 项目栏/项目类型/参考作用域/`PROJECT_NAME` 输出等 |
| `easy multitrackProject` | 扩展 | `dual_t8` / `audio_first` / `image_first`、项目类型强制、候选帧 |
| `easy multitrackProjectVideoCombine` | 扩展 | MEDIA 输出、分段预览、画布预警 |
| `easy minimaxH3MultiRateSampler` | 新增 | 多率采样（只约束视频提交次数） |
