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

export const DEFAULT_PROMPT_RULES = "当用户要求为分镜段写「用户提示词」时，输出 H3 官方提示词的简化版：\n- 用〔主体名〕占位引用主体与资源（不要自己编 <Subject n> 编号，编号由前端按绑定分配）\n- 六要素齐全：主体定义句（〔名〕是…，由〔图名〕定义）→ 场景与动作（时间顺序）→ 镜头语言 → 声音 → 台词（<d>…</d>）→ 禁止项（文字/字幕/水印）\n- 按段时长安排 [Shot N]，不虚构素材；台词前不加引导语\n- 每段结果用 ```userprompt 段N\n…\n``` 代码块包裹，段号从 1 起\n- 同时给出需要的主体与资源清单（名称/一句话定义/建议素材），供用户到「主体与资源」页完善"

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
