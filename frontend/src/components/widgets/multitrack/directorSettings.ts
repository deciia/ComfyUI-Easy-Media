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
  },
  api: { provider: '', model: '', base_url: '' },
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
