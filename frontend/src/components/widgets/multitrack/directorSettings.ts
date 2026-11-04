export interface DirectorSettings {
  save: {
    targets: { task: boolean; video: boolean; audio: boolean; subtitle: boolean }
    defaultVariant: 'a' | 'b'
    overwrite: 'merge' | 'fill-missing' | 'replace'
    writeImages: boolean
    writeSegmentSettings: boolean
  }
  audio: {
    roleTracks: Record<string, string>
    defaultDb: Record<string, number>
    referenceMuted: boolean
  }
  subtitle: {
    enabled: boolean
    fromDialogue: boolean
    fromTaggedDescription: boolean
    keepSpeaker: boolean
    bilingual: boolean
    generateSpeech: boolean
    style: { font_size: number; color: string; outline_color: string; background_opacity: number; y: number }
  }
  agent: {
    includeNodeSettings: boolean
    includeTrackData: boolean
    includePlan: boolean
    includeManualSubjects: boolean
    includeManualResources: boolean
    includeBindings: boolean
    /** 技能预设：h3 / action / arthouse / animation / custom */
    skillPreset: string
    /** 提示词写作规则（作为 system_extra 随对话发送） */
    promptRules: string
  }
  api: { provider: string; model: string; base_url: string }
}

export const DEFAULT_DIRECTOR_SETTINGS: DirectorSettings = {
  save: {
    targets: { task: true, video: false, audio: false, subtitle: false },
    defaultVariant: 'a',
    overwrite: 'merge',
    writeImages: true,
    writeSegmentSettings: true,
  },
  audio: {
    roleTracks: { voice: '音频·口播', lipsync: '音频·原声', sfx: '音频·音效', bgm: '音频·BGM', reference: '音频·参考' },
    defaultDb: { voice: 0, lipsync: 0, sfx: -6, bgm: -18, reference: 0 },
    referenceMuted: true,
  },
  subtitle: {
    enabled: false,
    fromDialogue: true,
    fromTaggedDescription: false,
    keepSpeaker: false,
    bilingual: false,
    generateSpeech: false,
    style: { font_size: 42, color: '#ffffff', outline_color: '#000000', background_opacity: 0.35, y: 0.82 },
  },
  agent: {
    includeNodeSettings: true,
    includeTrackData: true,
    includePlan: true,
    includeManualSubjects: true,
    includeManualResources: true,
    includeBindings: true,
    skillPreset: 'h3',
    promptRules: '',
  },
  api: { provider: '', model: '', base_url: '' },
}

export const DEFAULT_PROMPT_RULES = "当用户要求为分镜段写「用户提示词」时，输出 H3 官方提示词的简化版：\n- 用〔主体名〕占位引用主体与资源（不要自己编 <Subject n> 编号，编号由前端按绑定分配）\n- 六要素齐全：主体定义句（〔名〕是…，由〔图名〕定义）→ 场景与动作（时间顺序）→ 镜头语言 → 声音 → 台词（<d>…</d>）→ 禁止项（文字/字幕/水印）\n- 按段时长安排 [Shot N]，不虚构素材；台词前不加引导语\n- 每段结果用 ```userprompt 段N\n…\n``` 代码块包裹，段号从 1 起\n- 同时给出需要的主体与资源清单（名称/一句话定义/建议素材），供用户到「主体与资源」页完善\n- 台词一律写 `<Subject n> (S1) says: <d>[Chinese] …</d>`（说话人用圆括号稳定 ID，不要写成裸 S1）；音色引用写 `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`\n- 写分镜时：镜头若写了微表情，必须同时给出该镜台词（H3 只在含 <d> 台词标签的镜头渲染面部表情）；单镜表演点不超过 5 个，景别之外补一个构图关系"

export const PROMPT_RULES_PRESETS: Record<string, string> = {
  h3: "当用户要求为分镜段写「用户提示词」时，输出 H3 官方提示词的简化版：\\n- 用〔主体名〕占位引用主体与资源（不要自己编 <Subject n> 编号，编号由前端按绑定分配）\\n- 六要素齐全：主体定义句（〔名〕是…，由〔图名〕定义）→ 场景与动作（时间顺序）→ 镜头语言 → 声音 → 台词（<d>…</d>）→ 禁止项（文字/字幕/水印）\\n- 按段时长安排 [Shot N]，不虚构素材；台词前不加引导语\\n- 每段结果用 ```userprompt 段N\\n…\\n``` 代码块包裹，段号从 1 起\\n- 同时给出需要的主体与资源清单（名称/一句话定义/建议素材），供用户到「主体与资源」页完善",
  action: "当用户要求为分镜段写「用户提示词」时，输出 H3 官方提示词的简化版：\\n- 用〔主体名〕占位引用主体与资源（不要自己编 <Subject n> 编号，编号由前端按绑定分配）\\n- 六要素齐全：主体定义句（〔名〕是…，由〔图名〕定义）→ 场景与动作（时间顺序）→ 镜头语言 → 声音 → 台词（<d>…</d>）→ 禁止项（文字/字幕/水印）\\n- 按段时长安排 [Shot N]，不虚构素材；台词前不加引导语\\n- 每段结果用 ```userprompt 段N\\n…\\n``` 代码块包裹，段号从 1 起\\n- 同时给出需要的主体与资源清单（名称/一句话定义/建议素材），供用户到「主体与资源」页完善\\n动作片风格加强：\\n- 节奏：单段 2-4 个快切镜头，动作链清晰（起手→发力→结果），每镜 ≤2s\\n- 运镜：多用跟拍/甩镜/低角度推近，动势连贯，切点踩在动作发力瞬间\\n- 声音：拟音强化（金属撞击/风压/脚步），台词短促有力\\n- 禁止慢镜堆砌与无意义运镜",
  arthouse: "当用户要求为分镜段写「用户提示词」时，输出 H3 官方提示词的简化版：\\n- 用〔主体名〕占位引用主体与资源（不要自己编 <Subject n> 编号，编号由前端按绑定分配）\\n- 六要素齐全：主体定义句（〔名〕是…，由〔图名〕定义）→ 场景与动作（时间顺序）→ 镜头语言 → 声音 → 台词（<d>…</d>）→ 禁止项（文字/字幕/水印）\\n- 按段时长安排 [Shot N]，不虚构素材；台词前不加引导语\\n- 每段结果用 ```userprompt 段N\\n…\\n``` 代码块包裹，段号从 1 起\\n- 同时给出需要的主体与资源清单（名称/一句话定义/建议素材），供用户到「主体与资源」页完善\\n文艺片风格加强：\\n- 节奏：单段 1-2 个长镜头，允许静观与留白，情绪先行于事件\\n- 运镜：固定机位或缓慢横移，浅焦深，光影与天气参与叙事\\n- 声音：环境声为主（雨/风扇/远处人声），配乐克制或缺失\\n- 台词少而轻，多靠动作与视线传达",
  animation: "当用户要求为分镜段写「用户提示词」时，输出 H3 官方提示词的简化版：\\n- 用〔主体名〕占位引用主体与资源（不要自己编 <Subject n> 编号，编号由前端按绑定分配）\\n- 六要素齐全：主体定义句（〔名〕是…，由〔图名〕定义）→ 场景与动作（时间顺序）→ 镜头语言 → 声音 → 台词（<d>…</d>）→ 禁止项（文字/字幕/水印）\\n- 按段时长安排 [Shot N]，不虚构素材；台词前不加引导语\\n- 每段结果用 ```userprompt 段N\\n…\\n``` 代码块包裹，段号从 1 起\\n- 同时给出需要的主体与资源清单（名称/一句话定义/建议素材），供用户到「主体与资源」页完善\\n动画风格加强：\\n- 表演夸张化：挤压拉伸、预备动作与跟随动作明显，表情幅度大\\n- 运镜与构图风格化：允许跳切/速度线/图形化转场\\n- 声音：卡通拟音与节奏化配乐\\n- 明确画风关键词（如 2D 手绘/三渲二/停摆质感）写进主体定义",
}

export function settingsKey(project: string): string {
  return `easy-media-director-settings:${project || 'default'}`
}

export function readDirectorSettings(project: string): DirectorSettings {
  try {
    const raw = window.localStorage.getItem(settingsKey(project))
    if (!raw) return DEFAULT_DIRECTOR_SETTINGS
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_DIRECTOR_SETTINGS,
      ...parsed,
      save: { ...DEFAULT_DIRECTOR_SETTINGS.save, ...(parsed.save ?? {}), targets: { ...DEFAULT_DIRECTOR_SETTINGS.save.targets, ...(parsed.save?.targets ?? {}) } },
      audio: { ...DEFAULT_DIRECTOR_SETTINGS.audio, ...(parsed.audio ?? {}) },
      subtitle: { ...DEFAULT_DIRECTOR_SETTINGS.subtitle, ...(parsed.subtitle ?? {}), style: { ...DEFAULT_DIRECTOR_SETTINGS.subtitle.style, ...(parsed.subtitle?.style ?? {}) } },
      agent: { ...DEFAULT_DIRECTOR_SETTINGS.agent, ...(parsed.agent ?? {}) },
      api: { ...DEFAULT_DIRECTOR_SETTINGS.api, ...(parsed.api ?? {}) },
    }
  } catch {
    return DEFAULT_DIRECTOR_SETTINGS
  }
}

export function writeDirectorSettings(project: string, settings: DirectorSettings) {
  try {
    window.localStorage.setItem(settingsKey(project), JSON.stringify(settings))
  } catch {
    /* ignore */
  }
}

export const AUDIO_PROMPT_RULES = `音频项目（语音/口播）的提示词规则：
- 时间轴用 [Audio Segment N] + At 00:0X.XXX，不要用 [Shot N]，不写景别/机位/构图/光线/镜头运动
- 不写画幅与分辨率；不要写「黑场」「无可见元素」这类画面占位，画面可自然简述一句或省略
- 字段：subject_definitions / summary / retention_analysis（可省）/ detailed_description / overall_soundscape / non_diegetic_music
- 每个 [Audio Segment N] 只描述一个说话人、只放一句台词，结尾用「他说：」或「她说：」紧跟 <d>[Chinese] 原文</d>
- 声音写中文完整第三人称陈述句：①谁在说+声音质感 ②音色沿用谁+什么独立生成 ③目标演绎（语速/停顿/情绪机制）④节奏重声明（可省）
- 句间静默单独成句（如「句间静默约 0.3 秒。」）
- 音色参考写：<Audio 1> 是 <Subject 1> (老赵) 的音色参考：只取音色、共鸣与音高质感；不复用语速、停顿节奏与情绪节奏，这些按本段台词重新生成
- 不要写对演员说戏的祈使句（如「语速再提一点，把车主的判断原样掀过去」）、不要用引号复述台词
- 说话人写半角圆括号稳定 ID：(S1)、(S2)
- overall_soundscape 无环境声写 N/A；non_diegetic_music 无配乐写 N/A`

export const IMAGE_PROMPT_RULES = `图片项目规则：只写静态画面（主体、构图、光线、材质、风格与禁止项），不写时间轴、镜头切换、台词与配音。`
