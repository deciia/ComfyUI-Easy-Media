import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Settings, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { PromptContentEditor, type PromptReferenceResource } from './PromptContentEditor'
import { PRESET_GROUPS, togglePreset } from '@/lib/prompt-presets'
import { cn } from '@/lib/utils'

/**
 * 提示词增强器（模态窗）。
 *
 * - 三栏：左（预设 chip + 选项）/ 中（手写草稿，@ 可插入资源与主体）/ 右（生成结果，可编辑、按段拆分）
 * - 任务类型与时长不在弹窗里设置：多轨编辑器节点上已有
 * - 已引用主体：从草稿里的 @令牌 解析展示
 * - 窗口不透明，浮在所有 UI 之上；点外部或 Esc 关闭
 */

export interface PromptEnhancerModalProps {
  initialBrief: string
  onApply: (prompt: string, brief: string, globalPrompt?: string) => void
  onClose: () => void
  pictureCount?: number
  audioCount?: number
  videoCount?: number
  imagePaths?: string[]
  /** 上次生成并替换的规范版（重新打开时恢复显示） */
  initialResult?: string
  /** 整个项目的全局提示词（来自主体库节点） */
  globalPrompt?: string
  onGlobalPromptChange?: (value: string) => void
  /** 当前任务片段 id */
  segmentId?: string
  /** 可切换的任务片段列表 */
  segments?: Array<{ id: string; label: string }>
  /** 请求编辑器切换选中片段（通过自定义事件） */
  onActivateSegment?: (id: string) => void
  /** 自动保存草稿与规范版 */
  onAutosave?: (payload: { brief: string; generated: string }) => void
  resourceTokens?: Array<{ token: string; label: string; type?: string; thumbnailUrl?: string }>
}

interface EnhancerOptions {
  task_type: string
  shot_count: string
  rewrite_mode: string
  output_language: string
  prompt_mode: string
  official_skill_profile: string
  creative_preset: string
  duration_seconds: number
  description_word_target: number
  constraints: string
  reference_template: string
}

interface ProviderConfig {
  provider: string
  base_url: string
  model: string
  api_key: string
  api_key_tail?: string
  api_key_set?: boolean
  upload_images: boolean
}

interface Section {
  title: string
  body: string
}

const PROVIDERS = ['deepseek', 'glm', 'minimax-cn', 'ark'] as const
const SHOT_COUNTS = ['AUTO', '1', '2', '3', '4', '5', '6', '8', '10'] as const
const REWRITE_MODES = ['strict', 'balanced', 'creative'] as const
const PROMPT_MODES = ['官方增强', '参考模板融合'] as const
const SKILL_PROFILES = ['现有兼容（保留中英文）', '官方 Skill 严格（全英文协议）'] as const
const CREATIVE_PRESETS = [
  '无（仅核心规则）',
  'AUTO（根据意图判断）',
  '极简产品广告',
  '品牌宣传短片',
  '3D 动画短片',
  '音乐 MV 动态字幕（官方）',
  '双人合作游戏开场',
] as const


const DEFAULT_OPTIONS: EnhancerOptions = {
  task_type: 'Ref2VA',
  shot_count: 'AUTO',
  rewrite_mode: 'balanced',
  output_language: '中文',
  prompt_mode: PROMPT_MODES[0],
  official_skill_profile: SKILL_PROFILES[0],
  creative_preset: CREATIVE_PRESETS[0],
  duration_seconds: 5,
  description_word_target: 0,
  constraints: '',
  reference_template: '',
}

const DEFAULT_CONFIG: ProviderConfig = {
  provider: 'deepseek',
  base_url: '',
  model: '',
  api_key: '',
  upload_images: true,
}

const PANEL_BG = 'hsl(var(--card, 240 10% 10%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const BORDER = 'hsl(var(--border, 240 6% 25%))'
const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: 'hsl(var(--foreground, 0 0% 90%))',
  fontSize: 12,
  padding: '4px 8px',
  outline: 'none',
  width: '100%',
}
const labelClass = 'text-[11px] text-neutral-400'

/** 从提示词里解析 @令牌（已引用主体/资源） */
function parseMentions(text: string): string[] {
  const found: string[] = []
  const regex = /<@([^>]+)>|<#([^:>]+):[^>]*>|(?:^|[\s，,。;；])@([^\s@<>，,。.;；:：!?！？、()（）\[\]【】]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const name = (match[1] || match[2] || match[3] || '').trim()
    if (name && !found.includes(name)) found.push(name)
  }
  return found
}


/** 由 input 相对路径生成 ComfyUI 的 /view URL（用作缩略图兜底） */
function inputViewUrl(path?: string): string | undefined {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/')
  if (/^https?:/i.test(normalized)) return normalized
  const parts = normalized.split('/').filter(Boolean)
  const filename = parts.pop()
  if (!filename) return undefined
  const query = new URLSearchParams({ filename, subfolder: parts.join('/'), type: 'input' })
  return `/view?${query.toString()}`
}

/** 用镜像层量出光标在 textarea 内的坐标（相对 textarea 左上角） */
function caretPosition(el: HTMLTextAreaElement, caret: number): { top: number; left: number } {
  const style = window.getComputedStyle(el)
  const mirror = document.createElement('div')
  const props = [
    'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ]
  for (const prop of props) mirror.style.setProperty(prop, style.getPropertyValue(prop) || '')
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.left = '-9999px'
  mirror.style.top = '0'
  mirror.textContent = el.value.slice(0, caret)
  const span = document.createElement('span')
  span.textContent = '\u200b'
  mirror.appendChild(span)
  document.body.appendChild(mirror)
  const lineHeight = parseFloat(style.lineHeight || '16') || 16
  const nextTop = span.offsetTop - el.scrollTop + lineHeight
  const nextLeft = span.offsetLeft
  document.body.removeChild(mirror)
  return { top: Math.max(0, nextTop), left: Math.max(0, nextLeft) }
}

/** 从画布读取「主体库」节点里定义的主体名（读不到就返回空） */
function readSubjectLibraryNames(): string[] {
  try {
    const canvas = (globalThis as unknown as { comfyAPI?: { app?: { app?: { canvas?: { graph?: { _nodes?: unknown[] } } } } } })
      .comfyAPI?.app?.app?.canvas
    const nodes = canvas?.graph?._nodes
    if (!Array.isArray(nodes)) return []
    const names: string[] = []
    for (const node of nodes) {
      const item = node as { type?: string; comfyClass?: string; widgets?: Array<{ name?: string; value?: unknown }> }
      const isLibrary = item.comfyClass === 'easy subjectLibrary' || item.type === 'easy subjectLibrary'
      if (!isLibrary) continue
      const widget = item.widgets?.find((entry) => entry.name === 'subject_data')
      const raw = widget?.value
      const parsed = typeof raw === 'string' ? (() => {
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      })() : (raw as Record<string, unknown> | null)
      const subjects = (parsed as { subjects?: Array<{ name?: string }> } | null)?.subjects
      if (Array.isArray(subjects)) {
        for (const subject of subjects) {
          if (typeof subject?.name === 'string' && subject.name.trim()) names.push(subject.name.trim())
        }
      }
    }
    return names
  } catch {
    return []
  }
}



/** contentEditable 编辑区：文本 + 行内 chip 渲染，原生光标/选区可见。 */
const TOKEN_COLORS: Record<string, string> = {
  subject: '#fde047',
  picture: 'hsl(var(--primary) / 0.85)',
  audio: '#38bdf8',
  video: '#34d399',
}

/** 修复被旧版 contentEditable innerText 污染的多余换行（令牌/单词之间被插入 \n）。 */
function repairSpacing(value: string): string {
  if (!value) return value
  return value
    // 令牌前后紧贴的换行
    .replace(/\n+(?=<(?:Subject|Picture|Audio|Video)\s+\d+>)/g, ' ')
    .replace(/(<(?:Subject|Picture|Audio|Video)\s+\d+>)\n+/g, '$1 ')
    .replace(/(<\(?(?:S\d+|d|cutoff|scenetrans)>?)\n+/g, '$1 ')
    // 短行（仅一个词或一个片段）粘回上一行
    .replace(/\n(?=[^\n]{1,24}\n)/g, (match, offset, whole) => {
      const rest = whole.slice(offset + 1)
      const line = rest.split('\n')[0].trim()
      // 六段标题行必须独占一行，绝不合并
      if (/^(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*[:：]?$/i.test(line)) {
        return match
      }
      // 只有纯词/纯标点时合并
      return /^[\w\-',.;:!?()]+$/.test(line) ? ' ' : match
    })
    // 连续空行收敛
    .replace(/\n{3,}/g, '\n\n')
}

/** 把规范提示词按六段标题拆分（识别不到就返回空） */
function splitSections(text: string): Section[] {
  if (!text.trim()) return []
  const headingRe = /(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*[:：]/gi
  const hits: Array<{ title: string; index: number; length: number }> = []
  let match: RegExpExecArray | null
  while ((match = headingRe.exec(text)) !== null) {
    hits.push({ title: match[1].toLowerCase(), index: match.index, length: match[0].length })
  }
  if (hits.length < 2) return []
  const sections: Section[] = []
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i]
    const next = hits[i + 1]
    const body = text.slice(hit.index + hit.length, next ? next.index : text.length)
    sections.push({ title: hit.title, body: body.replace(/^\s*\n+|\n+\s*$/g, '').trim() })
  }
  return sections
}

function joinSections(sections: Section[]): string {
  return sections.map((section) => `${section.title}:\n${section.body}`).join('\n\n')
}

export function PromptEnhancerModal({
  initialBrief,
  onApply,
  onClose,
  pictureCount,
  audioCount,
  videoCount,
  imagePaths,
  initialResult = '',
  globalPrompt = '',
  onGlobalPromptChange,
  segmentId,
  segments = [],
  onActivateSegment,
  onAutosave,
  resourceTokens = [],
}: PromptEnhancerModalProps) {
  const t = useT()
  const [brief, setBrief] = useState(initialBrief)
  const [options, setOptions] = useState<EnhancerOptions>(DEFAULT_OPTIONS)
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_CONFIG)
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [busy, setBusy] = useState(false)
  const [translating] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [result, setResult] = useState(initialResult)
  const [sections, setSections] = useState<Section[]>(() => splitSections(initialResult))
  const [configPath, setConfigPath] = useState('')
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const briefRef = useRef<HTMLTextAreaElement>(null)
  const chipInsertRef = useRef<{ insertMention: (token: string, query: string) => void } | null>(null)
  const [presets, setPresets] = useState<Record<string, string[]>>({
    camera_motion: [],
    expression: [],
    shot_size: [],
    framing: [],
  })

  const libraryNames = useMemo(() => readSubjectLibraryNames(), [])
  const [mentionTab, setMentionTab] = useState<'all' | 'subject' | 'picture' | 'video' | 'audio'>('all')
  const [maximized, setMaximized] = useState(false)
  const [globalDraft, setGlobalDraft] = useState(globalPrompt)
  const [lastGenerated, setLastGenerated] = useState(initialResult)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const skipAutosaveRef = useRef(true)
  const [mentionPos, setMentionPos] = useState<{ top: number; left: number } | null>(null)
  const officialToken = (type: string | undefined, index: number): string => {
    const kind = type ?? 'picture'
    if (kind === 'subject') return `<Subject ${index + 1}>`
    if (kind === 'audio') return `<Audio ${index + 1}>`
    if (kind === 'video') return `<Video ${index + 1}>`
    return `<Picture ${index + 1}>`
  }

  const candidates = useMemo(() => {
    const list: Array<{ token: string; label: string; type?: string; thumbnailUrl?: string; path?: string; insert?: string }> = []
    libraryNames.forEach((name, index) => {
      list.push({ token: `@${name}`, label: name, type: 'subject', insert: `<Subject ${index + 1}>` })
    })
    let imageIndex = 0
    let audioIndex = 0
    let videoIndex = 0
    for (const item of resourceTokens) {
      const entry: { token: string; label: string; type?: string; thumbnailUrl?: string; path?: string; insert?: string } = {
        token: item.token,
        label: item.label,
        type: item.type,
        thumbnailUrl: item.thumbnailUrl,
      }
      const kind = item.type === 'image' ? 'picture' : (item.type ?? 'picture')
      if (kind === 'picture') {
        entry.path = imagePaths?.[imageIndex]
        entry.insert = `<Picture ${imageIndex + 1}>`
        imageIndex += 1
      } else if (kind === 'audio') {
        entry.insert = `<Audio ${audioIndex + 1}>`
        audioIndex += 1
      } else if (kind === 'video') {
        entry.insert = `<Video ${videoIndex + 1}>`
        videoIndex += 1
      } else {
        entry.insert = officialToken(kind, 0)
      }
      list.push(entry)
    }
    return list
  }, [libraryNames, resourceTokens])
  const referenced = useMemo(() => {
    const names = new Set(parseMentions(brief))
    // 官方令牌 <Subject n> 也视为引用了对应主体
    for (const match of brief.matchAll(/<Subject\s+(\d+)>/gi)) {
      const name = libraryNames[Number(match[1]) - 1]
      if (name) names.add(name)
    }
    return Array.from(names)
  }, [brief, libraryNames])


  // 切换任务片段后，用新片段的内容刷新两栏（并跳过这次变化触发的自动保存）
  useEffect(() => {
    skipAutosaveRef.current = true
    const fixedResult = repairSpacing(initialResult)
    setBrief(repairSpacing(initialBrief))
    setResult(fixedResult)
    setSections(splitSections(fixedResult))
    setLastGenerated(repairSpacing(initialResult))
    setFailures([])
    setError('')
    const timer = window.setTimeout(() => {
      skipAutosaveRef.current = false
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/easy-media/prompt-studio/config')
        if (!response.ok) return
        const data = await response.json()
        if (cancelled) return
        const loaded = data?.config
        if (loaded && typeof loaded === 'object') {
          setConfig((current) => ({
            ...current,
            provider: typeof loaded.provider === 'string' ? loaded.provider : current.provider,
            base_url: typeof loaded.base_url === 'string' ? loaded.base_url : current.base_url,
            model: typeof loaded.model === 'string' ? loaded.model : current.model,
            api_key_set: Boolean(loaded.api_key_set),
            api_key_tail: typeof loaded.api_key_tail === 'string' ? loaded.api_key_tail : '',
            upload_images: loaded.upload_images !== false,
          }))
        }
      } catch {
        // 配置读取失败不影响手写
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])


  // 防抖自动保存：草稿 / 规范版改动 1.2 秒后写入当前片段
  useEffect(() => {
    if (skipAutosaveRef.current) return
    if (!onAutosave) return
    const timer = window.setTimeout(() => {
      const generated = sections.length ? joinSections(sections) : (result || lastGenerated)
      onAutosave({ brief, generated })
      setSavedAt(Date.now())
    }, 1200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, result, sections])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])


  function updateBrief(next: string, caret?: number) {
    setBrief(next)
    const position = caret ?? next.length
    const before = next.slice(0, position)
    const match = /@([^\s@<>，,。.;；:：!?！？、()（）\[\]【】]*)$/.exec(before)
    if (match) {
      setMention({ query: match[1], start: position - match[0].length, end: position })
      const element = briefRef.current
      if (element) setMentionPos(caretPosition(element, position))
    } else {
      setMention(null)
      setMentionPos(null)
    }
  }

  function applyMention(token: string, insert?: string) {
    if (!mention) return
    const inserted = insert ?? token
    if (chipInsertRef.current) {
      chipInsertRef.current.insertMention(inserted, mention.query)
      setMention(null)
      setMentionPos(null)
      return
    }
    const next = `${brief.slice(0, mention.start)}${inserted} ${brief.slice(mention.end)}`
    setMention(null)
    updateBrief(next, mention.start + inserted.length + 1)
    briefRef.current?.focus()
  }

  const editorResources = useMemo<PromptReferenceResource[]>(() => {
    const list: PromptReferenceResource[] = []
    libraryNames.forEach((name, index) => {
      list.push({
        id: `subject-${index + 1}`,
        type: 'subject',
        index: index + 1,
        label: name,
        detail: `<Subject ${index + 1}>`,
        token: `<Subject ${index + 1}>`,
        color: TOKEN_COLORS.subject,
      })
    })
    let pictureIndex = 0
    let audioIndex = 0
    let videoIndex = 0
    for (const item of resourceTokens) {
      const kind = item.type === 'image' ? 'picture' : (item.type ?? 'picture')
      if (kind === 'picture') {
        pictureIndex += 1
        list.push({
          id: `picture-${pictureIndex}`,
          type: 'image',
          index: pictureIndex,
          label: item.label,
          detail: item.label,
          token: `<Picture ${pictureIndex}>`,
          color: TOKEN_COLORS.picture,
          thumbnailUrl: item.thumbnailUrl || inputViewUrl(imagePaths?.[pictureIndex - 1]),
        })
      } else if (kind === 'audio') {
        audioIndex += 1
        list.push({
          id: `audio-${audioIndex}`,
          type: 'audio',
          index: audioIndex,
          label: item.label,
          detail: item.label,
          token: `<Audio ${audioIndex}>`,
          color: TOKEN_COLORS.audio,
        })
      } else if (kind === 'video') {
        videoIndex += 1
        list.push({
          id: `video-${videoIndex}`,
          type: 'video',
          index: videoIndex,
          label: item.label,
          detail: item.label,
          token: `<Video ${videoIndex}>`,
          color: TOKEN_COLORS.video,
        })
      }
    }
    return list
  }, [resourceTokens, imagePaths, libraryNames])

  function presetPayload() {
    return {
      camera_motion: presets.camera_motion ?? [],
      expression: presets.expression ?? [],
      shot_size: presets.shot_size ?? [],
      framing: presets.framing ?? [],
    }
  }

  async function postGenerate(payloadOptions: Record<string, unknown>, text: string) {
    const response = await fetch('/easy-media/prompt-studio/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brief: text,
        options: { ...options, ...payloadOptions, ...presetPayload() },
        global_prompt: globalDraft,
        subjects: libraryNames.map((name, index) => ({ name, label: `<Subject ${index + 1}>` })),
        images: imagePaths ?? [],
        picture_count: pictureCount ?? null,
        audio_count: audioCount ?? null,
        video_count: videoCount ?? null,
      }),
    })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, data }
  }

  function setResultText(text: string) {
    setResult(text)
    setSections(splitSections(text))
  }

  async function handleGenerate(language?: '中文' | 'English') {
    const outputLanguage = language ?? options.output_language
    setBusy(true)
    setError('')
    setFailures([])
    setResult('')
    setSections([])
    try {
      const { ok, data } = await postGenerate({ output_language: outputLanguage }, brief)
      if (!ok) {
        setError(String(data?.error || t('multitrack.enhancerFailed')))
        return
      }
      const generated = String(data?.prompt || '')
      setResultText(generated)
      setLastGenerated(generated)
      setFailures(Array.isArray(data?.failures) ? data.failures : [])
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('multitrack.enhancerFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveConfig() {
    setSavingConfig(true)
    setError('')
    try {
      const response = await fetch('/easy-media/prompt-studio/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: config.provider,
          base_url: config.base_url,
          model: config.model,
          api_key: config.api_key,
          upload_images: config.upload_images,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(String(data?.error || t('multitrack.enhancerFailed')))
        return
      }
      setConfig((current) => ({
        ...current,
        api_key: '',
        api_key_set: Boolean(data?.config?.api_key_set),
        api_key_tail: String(data?.config?.api_key_tail || ''),
      }))
      setConfigPath(String(data?.path || ''))
      setView('main')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('multitrack.enhancerFailed'))
    } finally {
      setSavingConfig(false)
    }
  }

  const finalPrompt = sections.length ? joinSections(sections) : (result || lastGenerated)
  const filteredMentions = mention
    ? candidates
        .filter((item) => mentionTab === 'all' || (item.type ?? 'picture') === mentionTab)
        .filter((item) => !mention.query || item.label.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 10)
    : []

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: maximized ? 'rgba(0,0,0,0.92)' : 'rgba(0,0,0,0.55)',
        padding: maximized ? 0 : 10,
      }}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        onClose()
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: maximized ? '100vw' : 'min(96vw, 1480px)',
          height: maximized ? '100vh' : 'min(92vh, 1000px)',
          background: PANEL_BG,
          border: maximized ? 'none' : `1px solid ${BORDER}`,
          borderRadius: maximized ? 0 : 10,
          boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
          overflow: 'hidden',
          color: '#e5e5e5',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('multitrack.enhancerTitle')}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={t('multitrack.enhancerSettings')}
              className={cn('h-7 w-7', view === 'settings' && 'text-primary')}
              onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
            >
              <Settings className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" title={t('multitrack.enhancerMaximize')} className="h-7 w-7" onClick={() => setMaximized((value) => !value)}>
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" title={t('multitrack.enhancerClose')} className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {view === 'settings' ? (
          <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerProvider')}</span>
                <select style={fieldStyle} value={config.provider} onChange={(event) => setConfig({ ...config, provider: event.target.value })}>
                  {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerModel')}</span>
                <input style={fieldStyle} value={config.model} placeholder="留空用默认" onChange={(event) => setConfig({ ...config, model: event.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>
                  {t('multitrack.enhancerApiKey')}
                  {config.api_key_set ? `（已保存 …${config.api_key_tail || ''}）` : ''}
                </span>
                <input style={fieldStyle} type="password" value={config.api_key} placeholder={config.api_key_set ? '已保存，留空不修改' : 'sk-...'} onChange={(event) => setConfig({ ...config, api_key: event.target.value })} />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.enhancerBaseUrl')}</span>
              <input style={fieldStyle} value={config.base_url} placeholder="留空使用默认" onChange={(event) => setConfig({ ...config, base_url: event.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={config.upload_images} onChange={(event) => setConfig({ ...config, upload_images: event.target.checked })} />
              {t('multitrack.enhancerUploadImages')}
            </label>
            <div className="text-[11px] text-neutral-500">
              {t('multitrack.enhancerConfigPath')}: ComfyUI/user/DeciiaEasyMedia/prompt_studio.json{configPath ? '（已保存）' : ''}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setView('main')}>{t('common.cancel')}</Button>
              <Button onClick={() => void handleSaveConfig()} disabled={savingConfig}>{t('common.save')}</Button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '290px minmax(0, 1.4fr) minmax(0, 1fr)', flex: 1, minHeight: 0 }}>
              {/* 左栏：预设 + 选项（任务类型/时长已移除：编辑器节点上已有） */}
              <div className="flex min-h-0 flex-col gap-3 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
                {PRESET_GROUPS.map((group) => (
                  <div key={group.id} className="flex flex-col gap-1">
                    <span className={labelClass}>{group.label}</span>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-[11px]"
                        style={{
                          background: (presets[group.id] ?? []).length === 0 ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--card, 240 10% 10%))',
                          border: `1px solid ${(presets[group.id] ?? []).length === 0 ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--border, 240 6% 25%))'}`,
                          color: (presets[group.id] ?? []).length === 0 ? 'hsl(var(--background, 240 10% 8%))' : 'hsl(var(--muted-foreground, 240 5% 65%))',
                        }}
                        onClick={() => setPresets({ ...presets, [group.id]: [] })}
                      >
                        模型自由决定
                      </button>
                      {group.options.map((option) => {
                        const active = (presets[group.id] ?? []).includes(option.key)
                        return (
                          <button
                            key={option.key}
                            type="button"
                            title={option.key}
                            className="rounded px-1.5 py-0.5 text-[11px]"
                            style={{
                              background: active ? 'hsl(var(--card, 240 10% 10%))' : 'hsl(var(--card, 240 10% 10%))',
                              border: `1px solid ${active ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--border, 240 6% 25%))'}`,
                              color: active ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--muted-foreground, 240 5% 65%))',
                            }}
                            onClick={() => setPresets({ ...presets, [group.id]: togglePreset(presets[group.id] ?? [], option.key) })}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerShotCount')}</span>
                    <select style={fieldStyle} value={options.shot_count} onChange={(event) => setOptions({ ...options, shot_count: event.target.value })}>
                      {SHOT_COUNTS.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerRewriteMode')}</span>
                    <select style={fieldStyle} value={options.rewrite_mode} onChange={(event) => setOptions({ ...options, rewrite_mode: event.target.value })}>
                      {REWRITE_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerWordTarget')}</span>
                    <input style={fieldStyle} type="number" min={0} max={1000} step={50} value={options.description_word_target} onChange={(event) => setOptions({ ...options, description_word_target: Number(event.target.value) || 0 })} />
                  </label>
                  <label className="col-span-2 flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerPromptMode')}</span>
                    <select style={fieldStyle} value={options.prompt_mode} onChange={(event) => setOptions({ ...options, prompt_mode: event.target.value })}>
                      {PROMPT_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                  <label className="col-span-2 flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerSkillProfile')}</span>
                    <select style={fieldStyle} value={options.official_skill_profile} onChange={(event) => setOptions({ ...options, official_skill_profile: event.target.value })}>
                      {SKILL_PROFILES.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                  <label className="col-span-2 flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerPreset')}</span>
                    <select style={fieldStyle} value={options.creative_preset} onChange={(event) => setOptions({ ...options, creative_preset: event.target.value })}>
                      {CREATIVE_PRESETS.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                </div>

                <label className="flex flex-col gap-1">
                  <span className={labelClass}>{t('multitrack.enhancerConstraints')}</span>
                  <textarea
                    style={{ ...fieldStyle, minHeight: 52, resize: 'vertical' }}
                    value={options.constraints}
                    onChange={(event) => setOptions({ ...options, constraints: event.target.value })}
                    placeholder={t('multitrack.enhancerConstraintsPlaceholder')}
                  />
                </label>
                {options.prompt_mode === '参考模板融合' ? (
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>{t('multitrack.enhancerReferenceTemplate')}</span>
                    <textarea
                      style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }}
                      value={options.reference_template}
                      onChange={(event) => setOptions({ ...options, reference_template: event.target.value })}
                    />
                  </label>
                ) : null}
              </div>

              {/* 中栏：草稿 + @ 引用 */}
              <div className="flex min-h-0 min-w-0 flex-col gap-1 p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
                <div className="flex flex-col gap-1">
                  <span className={labelClass}>全局提示词（整个项目）</span>
                  <textarea
                    style={{ ...fieldStyle, minHeight: 64, resize: 'vertical', fontSize: 12, lineHeight: 1.5 }}
                    value={globalDraft}
                    onChange={(event) => {
                      setGlobalDraft(event.target.value)
                      onGlobalPromptChange?.(event.target.value)
                    }}
                    placeholder="约束整支视频中持久出现的角色/物体/场景（来自主体库的全局提示词）"
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className={labelClass}>{t('multitrack.enhancerBrief')}</span>
                  {segments.length > 1 ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          const index = segments.findIndex((item) => item.id === segmentId)
                          const previous = segments[(index - 1 + segments.length) % segments.length]
                          if (!previous || !onActivateSegment) return
                          try { onAutosave?.({ brief, generated: sections.length ? joinSections(sections) : (result || lastGenerated) }) } catch (saveError) { console.warn("[EasyMedia][enhancer] autosave failed", saveError) }
                          onActivateSegment(previous.id)
                        }}
                      >
                        ◀
                      </Button>
                      <select
                        style={{ ...fieldStyle, width: 132, height: 24 }}
                        value={segmentId ?? segments[0]?.id}
                        onChange={(event) => {
                          if (event.target.value === segmentId) return
                          try { onAutosave?.({ brief, generated: sections.length ? joinSections(sections) : (result || lastGenerated) }) } catch (saveError) { console.warn("[EasyMedia][enhancer] autosave failed", saveError) }
                          onActivateSegment?.(event.target.value)
                        }}
                      >
                        {segments.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                      </select>
                      <Button
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          const index = segments.findIndex((item) => item.id === segmentId)
                          const next = segments[(index + 1) % segments.length]
                          if (!next || !onActivateSegment) return
                          try { onAutosave?.({ brief, generated: sections.length ? joinSections(sections) : (result || lastGenerated) }) } catch (saveError) { console.warn("[EasyMedia][enhancer] autosave failed", saveError) }
                          onActivateSegment(next.id)
                        }}
                      >
                        ▶
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="text-[11px] text-neutral-500">点上方标签可引用主体/资源</div>
                <div
                  className="min-h-0 flex-1 overflow-hidden rounded-md"
                  style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}
                >
                  <PromptContentEditor
                    value={brief}
                    onChange={(next) => setBrief(next)}
                    ariaLabel={t('multitrack.enhancerBrief')}
                    placeholder={t('multitrack.enhancerBriefPlaceholder')}
                    resources={editorResources}
                    mentionsEnabled
                    highlightPromptSemantics
                    className="h-full border-none bg-transparent"
                    testId="enhancer-brief-editor"
                  />
                  {mention && filteredMentions.length > 0 ? (
                    <div
                      style={{
                        position: 'fixed',
                        left: Math.max(8, Math.min(mentionPos?.left ?? 120, window.innerWidth - 300)),
                        top: Math.max(8, Math.min(mentionPos?.top ?? 120, window.innerHeight - 260)),
                        zIndex: 2147483001,
                        background: 'hsl(var(--card, 240 10% 10%))',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: 4,
                        maxHeight: 180,
                        overflow: 'auto',
                        minWidth: 200,
                      }}
                    >
                      <div className="mb-1 flex flex-wrap gap-1 border-b border-border pb-1">
                        {(['all', 'subject', 'picture', 'video', 'audio'] as const).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={{
                              background: mentionTab === tab ? 'hsl(var(--primary, 199 89% 48%))' : 'transparent',
                              color: mentionTab === tab ? '#fff' : 'hsl(var(--muted-foreground, 240 5% 65%))',
                              border: `1px solid ${mentionTab === tab ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--border, 240 6% 25%))'}`,
                            }}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              setMentionTab(tab)
                            }}
                          >
                            {tab === 'all' ? '全部' : tab === 'subject' ? '主体' : tab === 'picture' ? '图片' : tab === 'video' ? '视频' : '音频'}
                          </button>
                        ))}
                      </div>
                      {filteredMentions.map((item) => (
                        <button
                          key={item.token}
                          type="button"
                          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-neutral-200 hover:bg-neutral-700"
                          onMouseDown={(event) => {
                            event.preventDefault()
                            applyMention(item.token, item.insert)
                          }}
                        >
                          {item.thumbnailUrl || inputViewUrl(item.path) ? (
                            <img src={item.thumbnailUrl || inputViewUrl(item.path)} alt="" style={{ width: 26, height: 26, objectFit: 'cover', borderRadius: 4 }} />
                          ) : (
                            <span style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'hsl(var(--muted, 240 5% 18%))', fontSize: 10 }}>
                              {(item.type ?? 'subject').slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          <span className="text-[10px] uppercase text-neutral-500">{item.type ?? 'subject'}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className={labelClass}>已引用主体：</span>
                  {referenced.length === 0 ? (
                    <span className="text-[11px] text-neutral-500">（无）</span>
                  ) : (
                    referenced.map((name) => (
                      <span key={name} className="rounded border border-highlight/60 bg-highlight/10 px-1.5 py-0.5 text-[11px] text-primary">
                        @{name}
                      </span>
                    ))
                  )}
                </div>
              </div>

              {/* 右栏：结果（可编辑，按段拆分） */}
              <div className="flex min-h-0 min-w-0 flex-col gap-1 p-2">
                <div className="flex items-center justify-between">
                  <span className={labelClass}>{t('multitrack.enhancerPreview')}</span>
                  <div className="flex gap-1">
                    <Button variant="secondary" className="h-6 px-2 text-[11px]" disabled={busy || translating || !brief.trim()} onClick={() => void handleGenerate('English')}>生成英文</Button>
                    <Button variant="secondary" className="h-6 px-2 text-[11px]" disabled={busy || translating || !brief.trim()} onClick={() => void handleGenerate('中文')}>生成中文</Button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
                  {sections.length > 0 ? (
                    sections.map((section, index) => (
                      <div key={section.title} className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="flex flex-1 items-center gap-2 text-[11px] font-medium text-primary">
                            {section.title}
                            <span className="h-px flex-1" style={{ background: 'hsl(var(--border, 240 6% 25%))' }} />
                          </span>
                        </div>
                                                <PromptContentEditor
                          value={section.body}
                          onChange={(next) => {
                            const list = sections.map((item, current) => (
                              current === index ? { ...item, body: next } : item
                            ))
                            setSections(list)
                            setResult(joinSections(list))
                          }}
                          ariaLabel={section.title}
                          placeholder={section.title}
                          resources={editorResources}
                          highlightPromptSemantics
                          className="border-none bg-transparent"
                          testId={`enhancer-section-${section.title}`}
                        />
                      </div>
                    ))
                  ) : (
                    <textarea
                      style={{ ...fieldStyle, flex: 1, resize: 'none', fontSize: 11, lineHeight: 1.55 }}
                      value={result || lastGenerated}
                      onChange={(event) => setResult(event.target.value)}
                    />
                  )}
                </div>
                {error ? (
                  <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', background: 'rgba(146,64,14,0.18)', color: '#fbbf24' }}>{error}</div>
                ) : null}
                {failures.length > 0 ? (
                  <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', background: 'rgba(146,64,14,0.18)', color: '#fbbf24' }}>
                    <div>{t('multitrack.enhancerValidationFailed')}</div>
                    <ul className="ml-4 list-disc">
                      {failures.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2">
              <span className="text-[11px] text-neutral-500">{t('multitrack.enhancerHint')}</span>
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <span className="shrink-0 text-[11px] text-muted-foreground">参考资源</span>
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  {resourceTokens.length === 0 ? (
                    <span className="text-[11px] text-neutral-500">（本段无参考资源）</span>
                  ) : (
                    resourceTokens.map((item) => {
                      const kind = item.type === 'image' ? 'picture' : (item.type ?? 'picture')
                      const color = kind === 'picture' ? '#a78bfa' : kind === 'audio' ? '#38bdf8' : kind === 'video' ? '#34d399' : '#f59e0b'
                      return (
                        <span
                          key={item.token}
                          className="rounded border px-1 py-0.5 text-[10px]"
                          style={{ borderColor: color, color }}
                          title={item.label}
                        >
                          {kind === 'picture' ? '图' : kind === 'audio' ? '音' : kind === 'video' ? '视' : '主'} · {item.label}
                        </span>
                      )
                    })
                  )}
                </div>
                <span className="ml-auto shrink-0 text-[11px] text-neutral-500">
                  草稿 {brief.length} 字{lastGenerated ? ` · 规范版 ${(sections.length ? joinSections(sections) : lastGenerated).length} 字` : ''}
                  {referenced.length ? ` · 引用 ${referenced.length}` : ''}
                  {savedAt ? ` · 已保存 ${new Date(savedAt).toLocaleTimeString()}` : ''}
                </span>
              </div>
              <Button
                className="shrink-0"
                onClick={() => {
                  if (finalPrompt) onApply(finalPrompt, brief, globalDraft)
                }}
                disabled={!finalPrompt || failures.length > 0}
              >
                {t('multitrack.enhancerApply')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
