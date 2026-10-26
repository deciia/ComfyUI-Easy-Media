import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ListPlus, Save, Settings, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { PromptContentEditor, type PromptReferenceResource } from './PromptContentEditor'
import { StoryboardTab, type WorkspaceTab } from './WorkspaceTabs'
import { type WorkspaceSubject } from './WorkspacePanels'
import { AssetsTab } from './AssetsTab'
import { AssetsSharedBrowser } from './AssetsSharedBrowser'
import { PromptQualityBar } from './PromptQualityBar'
import { ReferenceBar } from './ReferenceBar'
import { DirectorSettingsModal } from './DirectorSettingsModal'
import { readDirectorSettings, writeDirectorSettings, type DirectorSettings } from './directorSettings'
import { AgentRail } from './AgentRail'
import {
  addResourceFromShared,
  bindResourceFile,
  defaultRelationship,
  ensureHydrated,
  kindToType,
  patchResource,
  readWorkspace,
  readBindings,
  removeResource,
  resourceUid,
  unbindResourceFile,
  subscribeWorkspace,
  typeToKind,
  upsertResource,
  writeBindings,
  writeWorkspace,
  type ProjectResource,
} from './agentStore'
import { ScriptTab } from './ScriptTab'
import { formatPlanSegmentBrief } from './PlanPreview'
import type { MultiTrackSegment } from '@/types/multitrack'
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
  /** 四页签工作台：任务轨完整片段（分镜编排用） */
  workspaceSegments?: MultiTrackSegment[]
  /** 时间线帧率（分镜时长换算） */
  workspaceFrameRate?: number
  /** 把草稿提示词写入指定任务片段 */
  onWriteSegmentPrompt?: (segmentId: string, prompt: string) => void
  /** 把选中的图片资源挂到任务片段 */
  onAttachImages?: (segmentId: string, images: Array<{ name: string; subfolder: string }>) => void
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


/** 从画布读取「主体库」节点的完整主体（读不到就返回空） */
function readSubjectLibrarySubjects(): WorkspaceSubject[] {
  try {
    const canvas = (globalThis as unknown as { comfyAPI?: { app?: { app?: { canvas?: { graph?: { _nodes?: unknown[] } } } } } })
      .comfyAPI?.app?.app?.canvas
    const nodes = canvas?.graph?._nodes
    if (!Array.isArray(nodes)) return []
    const items: WorkspaceSubject[] = []
    const seen = new Set<string>()
    for (const node of nodes) {
      const entry = node as { type?: string; comfyClass?: string; widgets?: Array<{ name?: string; value?: unknown }> }
      const isLibrary = entry.comfyClass === 'easy subjectLibrary' || entry.type === 'easy subjectLibrary'
      if (!isLibrary) continue
      const raw = entry.widgets?.find((widget) => widget.name === 'subject_data')?.value
      const parsed = typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw) } catch { return null } })()
        : (raw as Record<string, unknown> | null)
      const subjects = (parsed as { subjects?: Array<Record<string, unknown>> } | null)?.subjects
      if (!Array.isArray(subjects)) continue
      for (const subject of subjects) {
        const name = typeof subject?.name === 'string' ? subject.name.trim() : ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        const retentionRaw = subject.retention
        const retention = Array.isArray(retentionRaw)
          ? retentionRaw.map((item) => String(item)).filter(Boolean)
          : (typeof retentionRaw === 'string' ? retentionRaw.split(/[，,、]/).map((item) => item.trim()).filter(Boolean) : [])
        items.push({
          id: `subject-${items.length + 1}`,
          name,
          type: typeof subject.type === 'string' && subject.type ? subject.type : '人物',
          description: typeof subject.description === 'string' ? subject.description : '',
          retention,
        })
      }
    }
    return items
  } catch {
    return []
  }
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

const SECTION_KEYS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
  'integrated_multimodal_description',
] as const

/** 段名单独成行但缺冒号时补上（兼容模型输出 "summary" 换行再接正文的写法） */
function normalizeSectionHeadings(value: string): string {
  if (!value) return value
  let next = value
  for (const key of SECTION_KEYS) {
    const pattern = new RegExp(`(^|\\n)[ \\t]*(${key})[ \\t]*(?:\\*\\*)?(?=\\n|$)`, 'gi')
    next = next.replace(pattern, (_match, lead: string, name: string) => `${lead}${name.toLowerCase()}:`)
  }
  return next
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
  workspaceSegments = [],
  workspaceFrameRate = 30,
  onWriteSegmentPrompt,
  resourceTokens = [],
}: PromptEnhancerModalProps) {
  const t = useT()
  const [brief, setBrief] = useState(initialBrief)
  const [draftPrompt, setDraftPrompt] = useState('')
  const [finalA, setFinalA] = useState('')
  const [finalB, setFinalB] = useState('')
  const [resultTab, setResultTab] = useState<'preview' | 'script' | 'track' | 'ai'>('preview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appearance, setAppearance] = useState(() => {
    const ui = Number(globalThis.localStorage?.getItem('easy-media-ui-scale') || 0)
    const chat = Number(globalThis.localStorage?.getItem('easy-media-chat-scale') || 0)
    return {
      uiScale: ui >= 70 && ui <= 200 ? ui : 100,
      chatScale: chat >= 80 && chat <= 200 ? chat : 100,
    }
  })
  useEffect(() => {
    function onAppearance(event: Event) {
      const detail = (event as CustomEvent<{ uiScale?: number; chatScale?: number }>).detail ?? {}
      setAppearance((current) => ({
        uiScale: typeof detail.uiScale === 'number' ? detail.uiScale : current.uiScale,
        chatScale: typeof detail.chatScale === 'number' ? detail.chatScale : current.chatScale,
      }))
    }
    globalThis.addEventListener?.('easy-media-appearance-change', onAppearance)
    return () => globalThis.removeEventListener?.('easy-media-appearance-change', onAppearance)
  }, [])
  const settingsProject = (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'
  const [directorSettings, setDirectorSettings] = useState<DirectorSettings>(() => readDirectorSettings(settingsProject))
  const [abTab, setAbTab] = useState<'a' | 'b'>(() => readDirectorSettings((globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default').save.defaultVariant)
  const [previewVariant, setPreviewVariant] = useState<'a' | 'b'>('a')
  const [finalCopied, setFinalCopied] = useState(false)
  const activePrompt = abTab === 'a' ? brief : draftPrompt
  const finalDraft = previewVariant === 'a' ? finalA : finalB
  const setFinalDraft = (value: string) => (previewVariant === 'a' ? setFinalA(value) : setFinalB(value))
  const bindingProjectKey = (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'
  // ④ 只编辑分镜脚本段（plan.segments）；任务轨段仅只读对照
  const [activeScriptIndex, setActiveScriptIndex] = useState(0)
  const scriptPlan = readWorkspace(bindingProjectKey).plan as { segments?: Array<Record<string, unknown>> } | null
  const scriptSegments = scriptPlan?.segments ?? []
  const activeScriptSegment = scriptSegments[activeScriptIndex] as Record<string, unknown> | undefined
  const patchScriptSegment = (patch: Record<string, unknown>) => {
    const current = readWorkspace(bindingProjectKey).plan as { segments?: Array<Record<string, unknown>> } | null
    if (!current?.segments) return
    const segments = current.segments.map((segment, index) => (
      index === activeScriptIndex ? { ...segment, ...patch } : segment
    ))
    writeWorkspace(bindingProjectKey, { plan: { ...(current as Record<string, unknown>), segments } as never })
  }
  const matchedTaskSegment = (() => {
    const key = `sk-${activeScriptIndex + 1}`
    return workspaceSegments.find((item) => (
      String((item.content as unknown as { stable_key?: string })?.stable_key ?? '') === key
    )) ?? workspaceSegments[activeScriptIndex]
  })()
  const matchedTrackSegmentId = scriptSegments.length > 0 ? matchedTaskSegment?.id : undefined
  /** 当前段任务类型 → 素材约束用的 mode key（惰性求值，避免在 taskTypeOfCurrentSegment 定义前执行） */
  const currentTaskModeKey = () => {
    const label = String(taskTypeOfCurrentSegment() || '').trim().toUpperCase()
    if (label === 'L2V') return 'l2v'
    if (label === 'R2V') return 'ref'
    if (label === 'VI2V') return 'edit'
    if (label === 'PASS' || label === 'PASSTHROUGH') return 'passthrough'
    return 'default'
  }

  const bindingKey = `script-${activeScriptIndex}:${previewVariant}`
  const boundIds = readBindings(bindingProjectKey, bindingKey)

  /** 段内令牌编号契约：绑定清单顺序展开（主体→自身+子图），同类型按出现顺序编号 */
  const computeBindingTokens = (ids: string[]): Map<string, string> => {
    const map = new Map<string, string>()
    const counters: Record<string, number> = { Subject: 0, Picture: 0, Audio: 0, Video: 0 }
    const bump = (kind: string) => {
      counters[kind] = (counters[kind] ?? 0) + 1
      return `<${kind} ${counters[kind]}>`
    }
    for (const id of ids) {
      const resource = resources.find((item) => item.id === id)
      if (!resource) continue
      if (resource.type === 'Subject') {
        // 主体承载身份，其子图不单独占 <Picture n> 编号（作为主体来源内嵌引用）
        map.set(resource.id, bump('Subject'))
        for (const childId of resource.childResourceIds ?? []) {
          const child = resources.find((item) => item.id === childId)
          if (!child) continue
          if (child.type === 'Audio') map.set(child.id, bump('Audio'))
          else if (child.type === 'Video') map.set(child.id, bump('Video'))
        }
        continue
      }
      if (resource.type === 'Picture') map.set(resource.id, bump('Picture'))
      else if (resource.type === 'Audio') map.set(resource.id, bump('Audio'))
      else if (resource.type === 'Video') map.set(resource.id, bump('Video'))
    }
    return map
  }
  /** 当前段任务类型：段级 settings > 脚本级 plan.settings > 任务轨 task_mode > 默认 */
  const taskTypeOfCurrentSegment = (): string => {
    const planNow = readWorkspace(bindingProjectKey).plan as
      | { settings?: { taskType?: string }; segments?: Array<Record<string, unknown>> }
      | null
    const segSettings = (planNow?.segments?.[activeScriptIndex] as { settings?: { taskType?: string } } | undefined)?.settings
    const segType = String(segSettings?.taskType ?? '').trim()
    if (segType) return segType.toUpperCase()
    const planType = String(planNow?.settings?.taskType ?? '').trim()
    if (planType) return planType.toUpperCase()
    // 兜底：任务轨上该段的 task_mode（default/ref/edit/l2v/passthrough）
    const taskMode = String((matchedTaskSegment?.content as unknown as { task_mode?: string })?.task_mode ?? '').trim().toLowerCase()
    if (taskMode === 'ref' || taskMode === 'edit') return 'R2V'
    if (taskMode === 'l2v') return 'L2V'
    if (taskMode === 'passthrough') return 'PASS'
    if (taskMode === 'default') return 'T2V'
    // 缺省推断（与助手 generate_prompt 一致）：本段有绑定素材或稿内令牌 → R2V，否则 T2V
    const draftText = `${brief}\n${abTab === 'b' ? draftPrompt : ''}\n${finalDraft || finalPrompt}`
    const hasTokens = /<(Subject|Picture|Audio|Video)\s+\d+>/i.test(draftText)
    if (boundIds.length > 0 || hasTokens) return 'R2V'
    return ''
  }

  /** 令牌 → 名称：优先脚本段上缓存的 tokenLabels，其次按需求清单顺序，最后按主体库 */
  const buildTokenNameMap = (): Map<string, string> => {
    const map = new Map<string, string>()
    const labels = (activeScriptSegment as unknown as { tokenLabels?: Record<string, string> } | undefined)?.tokenLabels
    if (labels && typeof labels === 'object') {
      for (const [token, name] of Object.entries(labels)) {
        if (typeof name === 'string' && name.trim()) map.set(token, name.trim())
      }
      return map
    }
    const counters: Record<string, number> = { Subject: 0, Picture: 0, Audio: 0, Video: 0 }
    const push = (kind: string, name: string) => {
      counters[kind] = (counters[kind] ?? 0) + 1
      map.set(`<${kind} ${counters[kind]}>`, name)
    }
    const seg = activeScriptSegment as unknown as {
      needs?: Array<{ kind?: string; name?: string }>
      needResources?: Array<{ kind?: string; name?: string }>
      resources?: Array<{ kind?: string; name?: string }>
    } | undefined
    const needs = seg?.needs ?? seg?.needResources ?? seg?.resources ?? []
    for (const item of needs) {
      const name = String(item?.name ?? '').trim()
      if (!name) continue
      const kindRaw = String(item?.kind ?? 'Subject').toLowerCase()
      const kind = kindRaw.startsWith('sub') ? 'Subject' : kindRaw.startsWith('aud') ? 'Audio' : kindRaw.startsWith('vid') ? 'Video' : 'Picture'
      push(kind, name)
    }
    if (map.size === 0) {
      const names = readSubjectLibraryNames()
      names.forEach((name, index) => map.set(`<Subject ${index + 1}>`, name))
    }
    return map
  }

  /** 底部「本段引用」：以草稿里实际出现的令牌为准，名称尽力解析，未绑定则标注 */
  const buildReferencedItems = () => {
    const items: Array<{ key: string; token: string; name: string; type: string; unbound: boolean }> = []
    const boundTokenValues = new Set(computeBindingTokens(boundIds).values())
    const nameMap = buildTokenNameMap()
    const text = `${brief}\n${abTab === 'b' ? draftPrompt : ''}\n${finalDraft || finalPrompt}`
    const seen = new Set<string>()
    for (const match of text.matchAll(/<(Subject|Picture|Audio|Video)\s+(\d+)>/g)) {
      const token = `<${match[1]} ${Number(match[2])}>`
      if (seen.has(token)) continue
      seen.add(token)
      items.push({
        key: `token-${token}`,
        token,
        name: nameMap.get(token) ?? '',
        type: match[1],
        unbound: !boundTokenValues.has(token),
      })
    }
    return items
  }

  /** @ 选中未绑定资源：自动补绑定（子图绑父主体），按新编号返回替换资源 */
  /** 分镜段 user_prompt 物化：〔名〕→ 官方令牌；匹配到资源则自动补绑定，未匹配保留占位 */
  const materializePlanUserPrompt = (text: string): string => {
    const names = Array.from(new Set(
      Array.from(text.matchAll(/〔([^〕]+)〕/g)).map((match) => match[1].trim()).filter(Boolean),
    ))
    if (names.length === 0) return text
    const nextIds = [...boundIds]
    const nameToResource = new Map<string, ProjectResource>()
    for (const name of names) {
      const found = resources.find((item) => item.name === name && item.type === 'Subject')
        ?? resources.find((item) => item.name === name)
      if (!found) continue
      nameToResource.set(name, found)
      const parent = resources.find((item) => item.type === 'Subject' && (item.childResourceIds ?? []).includes(found.id))
      const bindId = parent ? parent.id : found.id
      if (!nextIds.includes(bindId)) nextIds.push(bindId)
    }
    if (nameToResource.size === 0) return text
    writeBindings(bindingProjectKey, bindingKey, nextIds)
    const tokens = computeBindingTokens(nextIds)
    return text.replace(/〔([^〕]+)〕/g, (whole, name: string) => {
      const found = nameToResource.get(name.trim())
      return (found && tokens.get(found.id)) || whole
    })
  }
  const handleResourceChosen = (resource: PromptReferenceResource): PromptReferenceResource => {
    const target = resources.find((item) => `res-${item.id}` === resource.id)
    if (!target) return resource
    const bindingTokens = computeBindingTokens(boundIds)
    if (bindingTokens.has(target.id)) return resource
    const parent = resources.find((item) => item.type === 'Subject' && (item.childResourceIds ?? []).includes(target.id))
    const bindId = parent ? parent.id : target.id
    const nextIds = boundIds.includes(bindId) ? boundIds : [...boundIds, bindId]
    writeBindings(bindingProjectKey, bindingKey, nextIds)
    const nextTokens = computeBindingTokens(nextIds)
    const token = nextTokens.get(target.id)
    if (!token) return resource
    const index = Number(token.replace(/^<\w+\s+(\d+)>$/, '$1'))
    return { ...resource, token, index }
  }
  // 片段稿缓冲 → 脚本段 promptA/promptB（只有缓冲本身变化才写，终稿更新不得连带写回）
  useEffect(() => {
    if (!activeScriptSegment) return
    const timer = window.setTimeout(() => {
      patchScriptSegment({ promptA: brief, promptB: draftPrompt })
      lastPushedRef.current = { ...lastPushedRef.current, promptA: brief, promptB: draftPrompt }
    }, 600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, draftPrompt, activeScriptIndex])
  // 终稿 → 脚本段 finalA/finalB（独立一条，绝不带 promptA/promptB）
  useEffect(() => {
    if (!activeScriptSegment) return
    const timer = window.setTimeout(() => {
      patchScriptSegment({ finalA, finalB })
      lastPushedRef.current = { ...lastPushedRef.current, finalA, finalB }
    }, 600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalA, finalB, activeScriptIndex])
  // 外部写入（助手 write_prompt / 其它视图）→ 只读同步进编辑缓冲；这里绝不回写
  useEffect(() => {
    const planNow = readWorkspace(bindingProjectKey).plan as { segments?: Array<Record<string, unknown>> } | null
    const seg = planNow?.segments?.[activeScriptIndex] as Record<string, unknown> | undefined
    if (!seg) return
    const stored = {
      promptA: String(seg.promptA ?? ''),
      promptB: String(seg.promptB ?? ''),
      finalA: String(seg.finalA ?? ''),
      finalB: String(seg.finalB ?? ''),
    }
    const pushed = lastPushedRef.current
    if (stored.promptA && stored.promptA !== pushed.promptA) {
      pushed.promptA = stored.promptA
      setBrief(repairSpacing(stored.promptA))
    }
    if (stored.promptB && stored.promptB !== pushed.promptB) {
      pushed.promptB = stored.promptB
      setDraftPrompt(stored.promptB)
    }
    if (stored.finalA !== pushed.finalA) {
      pushed.finalA = stored.finalA
      setFinalA(normalizeSectionHeadings(stored.finalA))
    }
    if (stored.finalB !== pushed.finalB) {
      pushed.finalB = stored.finalB
      setFinalB(stored.finalB)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceStoreVersion])
  // 脚本段减少时把选中夹回有效范围
  useEffect(() => {
    if (scriptSegments.length === 0) {
      if (activeScriptIndex !== 0) setActiveScriptIndex(0)
      return
    }
    if (activeScriptIndex > scriptSegments.length - 1) setActiveScriptIndex(scriptSegments.length - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptSegments.length])
  const selectScriptSegment = (index: number) => {
    if (index === activeScriptIndex) return
    patchScriptSegment({ promptA: brief, promptB: draftPrompt, finalA, finalB })
    setActiveScriptIndex(index)
  }
  const [options, setOptions] = useState<EnhancerOptions>(DEFAULT_OPTIONS)
  const [workspaceStoreVersion, setWorkspaceStoreVersion] = useState(0)
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_CONFIG)
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [busy, setBusy] = useState(false)
  const [translating] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [autoFixes, setAutoFixes] = useState<string[]>([])
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('storyboard')
  const [assetsRailTab, setAssetsRailTab] = useState<'shared' | 'ai'>('shared')
  const [projectName, setProjectName] = useState(() => {
    try {
      return (globalThis as unknown as { __easyMediaWorkspaceProject?: { name: string } })
        .__easyMediaWorkspaceProject?.name || ''
    } catch {
      return ''
    }
  })
  const [projectMenu, setProjectMenu] = useState<string[]>([])
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [workspaceReloadKey, setWorkspaceReloadKey] = useState(0)
  const [saveCheckOpen, setSaveCheckOpen] = useState(false)
  const [replaceArmed, setReplaceArmed] = useState(false)

  async function confirmCreateProject() {
    const create = (globalThis as unknown as {
      __easyMediaCreateProject?: (name: string) => Promise<boolean>
    }).__easyMediaCreateProject
    const name = newProjectName.trim()
    if (!create || !name) return
    const ok = await create(name)
    if (ok) {
      setProjectName(name)
      setCreatingProject(false)
      try {
        window.localStorage.removeItem(`easy-media-storyboard:${name}`)
      } catch {
        /* ignore */
      }
    } else {
      setCreatingProject(false)
    }
  }
  const [workspaceGenerating, setWorkspaceGenerating] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
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
  // 主体/资源统一走「项目资源」表（含迁移）：关弹窗、刷新都不丢
  const workspaceKey = projectName || 'default'
  useEffect(() => {
    ensureHydrated(workspaceKey)
    const cached = readWorkspace(workspaceKey)
    if (!('resources' in cached) && !('subjects' in cached)) {
      // 首次进入该项目：从画布主体库播种为 Subject 资源
      const now = Date.now()
      writeWorkspace(workspaceKey, {
        resources: readSubjectLibrarySubjects().map((subject) => ({
          id: subject.id || resourceUid('res-subject'),
          type: 'Subject' as const,
          name: subject.name,
          subjectKind: subject.type || '人物',
          relationship: 'fully_preserved',
          description: subject.description ?? '',
          retention: subject.retention ?? [],
          status: 'ready' as const,
          childResourceIds: [],
          source: 'manual' as const,
          createdAt: now,
          updatedAt: now,
        })),
      })
    }
    setWorkspaceStoreVersion((value) => value + 1)
    return subscribeWorkspace(workspaceKey, () => setWorkspaceStoreVersion((value) => value + 1))
  }, [workspaceKey])

  const resources = readWorkspace(workspaceKey).resources ?? []
  const workspaceSubjects: WorkspaceSubject[] = resources
    .filter((item) => item.type === 'Subject')
    .map((item) => ({
      id: item.id,
      name: item.name,
      type: item.subjectKind || '人物',
      description: item.description,
      retention: item.retention,
      childResourceIds: item.childResourceIds ?? [],
    }))
  const plannedResources = resources
    .filter((item) => item.type !== 'Subject')
    .map((item) => ({ kind: typeToKind(item.type), name: item.name, purpose: item.description }))

  // 主体编辑 → 写回资源表（含增删与子资源引用）
  const setWorkspaceSubjects: React.Dispatch<React.SetStateAction<WorkspaceSubject[]>> = (action) => {
    // 必须以存储里的最新资源表为基准：同一事件里可能刚新增过资源，
    // 用渲染快照重建会把它覆盖掉（表现为"已添加但引用数仍为 0"）。
    const freshResources = readWorkspace(workspaceKey).resources ?? []
    const current: WorkspaceSubject[] = freshResources
      .filter((item) => item.type === 'Subject')
      .map((item) => ({
        id: item.id,
        name: item.name,
        type: item.subjectKind || '人物',
        description: item.description,
        retention: item.retention,
        childResourceIds: item.childResourceIds ?? [],
      }))
    const next = typeof action === 'function'
      ? (action as (prev: WorkspaceSubject[]) => WorkspaceSubject[])(current)
      : action
    const now = Date.now()
    const keepIds = new Set(next.map((item) => item.id))
    const nextResources: ProjectResource[] = freshResources
      .filter((item) => item.type !== 'Subject' || keepIds.has(item.id))
      .map((item) => {
        if (item.type !== 'Subject') return item
        const updated = next.find((subject) => subject.id === item.id)
        if (!updated) return item
        return {
          ...item,
          name: updated.name,
          subjectKind: updated.type,
          description: updated.description,
          retention: updated.retention,
          childResourceIds: updated.childResourceIds ?? item.childResourceIds ?? [],
          updatedAt: now,
        }
      })
    const existing = new Set(nextResources.filter((item) => item.type === 'Subject').map((item) => item.id))
    for (const subject of next) {
      if (existing.has(subject.id)) continue
      nextResources.push({
        id: subject.id || resourceUid('res-subject'),
        type: 'Subject',
        name: subject.name,
        subjectKind: subject.type,
        relationship: 'fully_preserved',
        description: subject.description,
        retention: subject.retention ?? [],
        status: 'ready',
        childResourceIds: subject.childResourceIds ?? [],
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      })
    }
    writeWorkspace(workspaceKey, { resources: nextResources })
  }

  // 资源需求编辑 → 写回资源表（kind+name 作匹配键）
  const setPlannedResources: React.Dispatch<React.SetStateAction<Array<{ kind: string; name: string; purpose?: string }>>> = (action) => {
    const current = plannedResources
    const next = typeof action === 'function'
      ? (action as (prev: Array<{ kind: string; name: string; purpose?: string }>) => Array<{ kind: string; name: string; purpose?: string }>)(current)
      : action
    const keyOf = (item: { kind: string; name: string }) => `${item.kind}::${item.name}`
    const wanted = new Map(next.map((item) => [keyOf(item), item]))
    const now = Date.now()
    const nextResources: ProjectResource[] = (readWorkspace(workspaceKey).resources ?? [])
      .filter((item) => item.type === 'Subject' || wanted.has(`${typeToKind(item.type)}::${item.name}`))
      .map((item) => {
        if (item.type === 'Subject') return item
        const target = wanted.get(`${typeToKind(item.type)}::${item.name}`)
        if (!target) return item
        return { ...item, name: target.name, description: target.purpose ?? item.description, updatedAt: now }
      })
    const existing = new Set(
      nextResources.filter((item) => item.type !== 'Subject').map((item) => `${typeToKind(item.type)}::${item.name}`),
    )
    for (const item of next) {
      const key = keyOf(item)
      if (existing.has(key)) continue
      const type = kindToType(item.kind)
      nextResources.push({
        id: resourceUid('res-need'),
        type,
        name: item.name,
        relationship: defaultRelationship(type),
        description: item.purpose ?? '',
        retention: [],
        status: 'need',
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      })
    }
    writeWorkspace(workspaceKey, { resources: nextResources })
  }

  const onAddSharedResource = (item: { name: string; subfolder: string; kind: 'image' | 'audio' | 'video' }) => (
    addResourceFromShared(workspaceKey, item)
  )
  const onPatchProjectResource = (id: string, patch: Partial<ProjectResource>) => {
    patchResource(workspaceKey, id, patch)
  }
  const onRemoveProjectResource = (id: string) => {
    removeResource(workspaceKey, id)
  }
  const onBindProjectResourceFile = (
    id: string,
    item: { name: string; subfolder?: string; kind: 'image' | 'audio' | 'video'; root?: 'input' | 'output' | 'temp' },
  ) => {
    bindResourceFile(workspaceKey, id, item)
  }
  const onUnbindProjectResourceFile = (id: string) => {
    unbindResourceFile(workspaceKey, id)
  }

  const onCreateProjectResource = () => {
    const now = Date.now()
    upsertResource(workspaceKey, {
      id: resourceUid('res'),
      type: 'Picture',
      name: '新资源',
      relationship: 'fully_preserved',
      description: '',
      retention: [],
      status: 'need',
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    })
  }

  const [mentionTab, setMentionTab] = useState<'all' | 'subject' | 'picture' | 'video' | 'audio'>('all')
  const [globalDraft, setGlobalDraft] = useState(globalPrompt)
  const [lastGenerated, setLastGenerated] = useState(initialResult)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const skipAutosaveRef = useRef(true)
  /** 记录本地已写回的值，用于区分「外部写入」与「自己刚写的」 */
  const lastPushedRef = useRef({ promptA: '', promptB: '', finalA: '', finalB: '' })
  const [mentionPos, setMentionPos] = useState<{ top: number; left: number } | null>(null)

  const candidates = useMemo(() => {
    type Cand = { token: string; label: string; type?: string; thumbnailUrl?: string; path?: string; insert?: string }
    const list: Cand[] = []
    const counters: Record<string, number> = { Subject: 0, Picture: 0, Audio: 0, Video: 0 }
    const nextLabel = (type: string) => {
      counters[type] = (counters[type] ?? 0) + 1
      return `<${type} ${counters[type]}>`
    }
    const thumbOf = (resource: ProjectResource) => {
      if (resource.type !== 'Picture' || !resource.imageFile) return undefined
      const sub = resource.subfolder ? `&subfolder=${encodeURIComponent(resource.subfolder)}` : ''
      return `/view?filename=${encodeURIComponent(resource.imageFile)}&type=${resource.sharedRoot ?? 'input'}${sub}`
    }
    const seen = new Set<string>()
    const pushResource = (resource: ProjectResource, tag: string) => {
      if (seen.has(resource.id)) return
      seen.add(resource.id)
      const type = resource.type === 'Subject' ? 'subject'
        : resource.type === 'Picture' ? 'picture'
          : resource.type === 'Audio' ? 'audio' : 'video'
      list.push({
        token: `@${resource.name}`,
        label: tag ? `${resource.name}（${tag}）` : resource.name,
        type,
        thumbnailUrl: thumbOf(resource),
        insert: nextLabel(resource.type),
      })
    }
    // 1) 当前段已绑定的资源置顶
    for (const id of boundIds) {
      const resource = resources.find((item) => item.id === id)
      if (resource) pushResource(resource, '已绑定')
    }
    // 2) 项目资源池（主体优先，再图片/音频/视频）
    for (const resource of resources) {
      if (resource.type === 'Subject') pushResource(resource, '')
    }
    for (const resource of resources) {
      if (resource.type !== 'Subject') pushResource(resource, resource.status === 'ready' ? '' : '未就绪')
    }
    // 3) 画布主体库补充（去重）
    for (const name of libraryNames) {
      const token = `@${name}`
      if (list.some((item) => item.token === token)) continue
      list.push({ token, label: name, type: 'subject', insert: nextLabel('Subject') })
    }
    // 4) 任务段已挂素材
    for (const item of resourceTokens) {
      const entry: Cand = {
        token: item.token,
        label: item.label,
        type: item.type,
        thumbnailUrl: item.thumbnailUrl,
      }
      const kind = item.type === 'image' ? 'picture' : (item.type ?? 'picture')
      if (kind === 'picture') {
        entry.path = imagePaths?.[counters.Picture ?? 0]
        entry.insert = nextLabel('Picture')
      } else if (kind === 'audio') {
        entry.insert = nextLabel('Audio')
      } else if (kind === 'video') {
        entry.insert = nextLabel('Video')
      } else {
        entry.insert = nextLabel('Subject')
      }
      list.push(entry)
    }
    return list
  }, [resources, boundIds, libraryNames, resourceTokens, imagePaths])
  const referenced = useMemo(() => {
    const names = new Set(parseMentions(brief))
    // 官方令牌 <Subject n> 也视为引用了对应主体
    for (const match of brief.matchAll(/<Subject\s+(\d+)>/gi)) {
      const name = libraryNames[Number(match[1]) - 1]
      if (name) names.add(name)
    }
    return Array.from(names)
  }, [brief, libraryNames])


  // 切换脚本段 / 脚本内容变化后，从脚本段刷新编辑缓冲
  // A 栏兜底顺序：promptA → 脚本段 brief（分镜内容拼装）→ 对应任务段 user_prompt
  useEffect(() => {
    skipAutosaveRef.current = true
    const planNow = readWorkspace(bindingProjectKey).plan as { segments?: Array<Record<string, unknown>> } | null
    const seg = planNow?.segments?.[activeScriptIndex] as Record<string, unknown> | undefined
    const trackContent = (matchedTaskSegment?.content ?? {}) as unknown as Record<string, unknown>
    // A 栏取值链：promptA → 分镜段 user_prompt（〔名〕物化为令牌并自动绑定）→ 任务段 user_prompt
    let promptA = String(seg?.promptA ?? '').trim() || String(trackContent.user_prompt ?? '')
    if (seg && !String(seg.promptA ?? '').trim() && String(seg.user_prompt ?? '').trim()) {
      const rawUserPrompt = String(seg.user_prompt)
      const materialized = materializePlanUserPrompt(rawUserPrompt)
      // 未解析出任何令牌时不落盘，保留〔名〕等用户补全主体后下次再试
      if (materialized !== rawUserPrompt) {
        promptA = materialized
        patchScriptSegment({ promptA: materialized })
      } else {
        promptA = rawUserPrompt
      }
    }
    setBrief(repairSpacing(promptA))
    setDraftPrompt(String(seg?.promptB ?? trackContent.user_prompt_b ?? ''))
    setFinalA(normalizeSectionHeadings(String(seg?.finalA ?? '')))
    setFinalB(String(seg?.finalB ?? ''))
    lastPushedRef.current = {
      promptA: String(seg?.promptA ?? ''),
      promptB: String(seg?.promptB ?? ''),
      finalA: String(seg?.finalA ?? ''),
      finalB: String(seg?.finalB ?? ''),
    }
    const fixedResult = repairSpacing(initialResult)
    setResult(fixedResult)
    setSections(splitSections(fixedResult))
    setLastGenerated(normalizeSectionHeadings(repairSpacing(initialResult)))
    setFailures([])
    setError('')
    const timer = window.setTimeout(() => {
      skipAutosaveRef.current = false
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId, activeScriptIndex, bindingProjectKey])

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
    const tokens = computeBindingTokens(boundIds)
    const counters: Record<string, number> = { Subject: 0, Picture: 0, Audio: 0, Video: 0 }
    for (const token of tokens.values()) {
      const matched = token.match(/^<(\w+)\s+(\d+)>$/)
      if (matched) {
        const kind = matched[1]
        counters[kind] = Math.max(counters[kind] ?? 0, Number(matched[2]))
      }
    }
    const bump = (kind: string) => {
      counters[kind] = (counters[kind] ?? 0) + 1
      return { index: counters[kind], token: `<${kind} ${counters[kind]}>` }
    }
    const viewOf = (resource: ProjectResource) => {
      if (resource.type !== 'Picture' || !resource.imageFile) return undefined
      const sub = resource.subfolder ? `&subfolder=${encodeURIComponent(resource.subfolder)}` : ''
      return `/view?filename=${encodeURIComponent(resource.imageFile)}&type=${resource.sharedRoot ?? 'input'}${sub}`
    }
    const list: PromptReferenceResource[] = []
    const pushWithToken = (resource: ProjectResource, label: string, token?: string) => {
      const kind = resource.type
      const slot = token ? { index: Number(token.replace(/^<\w+\s+(\d+)>$/, '$1')), token } : bump(kind)
      const type = resource.type === 'Subject' ? 'subject'
        : resource.type === 'Picture' ? 'image'
          : resource.type === 'Audio' ? 'audio' : 'video'
      list.push({
        id: `res-${resource.id}`,
        type,
        index: slot.index,
        label,
        detail: slot.token,
        token: slot.token,
        color: TOKEN_COLORS[kind === 'Subject' ? 'subject' : kind === 'Picture' ? 'picture' : kind === 'Audio' ? 'audio' : 'video'],
        thumbnailUrl: viewOf(resource),
      })
    }
    // 1) 绑定清单顺序展开（编号契约，不再置顶重排——就是绑定顺序本身）
    for (const id of boundIds) {
      const resource = resources.find((item) => item.id === id)
      if (!resource) continue
      if (resource.type === 'Subject') {
        pushWithToken(resource, resource.name, tokens.get(resource.id))
      } else {
        pushWithToken(resource, resource.name, tokens.get(resource.id))
      }
    }
    // 2) 未绑定资源池：续号（主体优先）
    const seen = new Set(boundIds)
    for (const resource of resources) {
      if (resource.type === 'Subject' && !seen.has(resource.id)) pushWithToken(resource, resource.name)
    }
    for (const resource of resources) {
      if (resource.type !== 'Subject' && !seen.has(resource.id)) {
        const parent = resources.find((item) => item.type === 'Subject' && (item.childResourceIds ?? []).includes(resource.id))
        if (!parent || !seen.has(parent.id)) pushWithToken(resource, resource.name)
      }
    }
    // 3) 画布主体库补充（按 label 去重）
    const seenSubjectNames = new Set(list.filter((item) => item.type === 'subject').map((item) => item.label))
    for (const name of libraryNames) {
      if (seenSubjectNames.has(name)) continue
      const slot = bump('Subject')
      list.push({ id: `subject-${slot.index}`, type: 'subject', index: slot.index, label: name, detail: slot.token, token: slot.token, color: TOKEN_COLORS.subject })
    }
    // 4) 任务段已挂素材兜底
    for (const item of resourceTokens) {
      const kind = item.type === 'image' ? 'Picture' : (item.type === 'audio' ? 'Audio' : item.type === 'video' ? 'Video' : 'Picture')
      const slot = bump(kind)
      const type = kind === 'Picture' ? 'image' : kind === 'Audio' ? 'audio' : 'video'
      list.push({
        id: `${kind}-${slot.index}`,
        type,
        index: slot.index,
        label: item.label,
        detail: item.label,
        token: slot.token,
        color: TOKEN_COLORS[kind === 'Picture' ? 'picture' : kind === 'Audio' ? 'audio' : 'video'],
        thumbnailUrl: item.thumbnailUrl || (kind === 'Picture' ? inputViewUrl(imagePaths?.[slot.index - 1]) : undefined),
      })
    }
    return list
  }, [resources, boundIds, resourceTokens, imagePaths, libraryNames])

  function presetPayload() {
    return {
      camera_motion: presets.camera_motion ?? [],
      expression: presets.expression ?? [],
      shot_size: presets.shot_size ?? [],
      framing: presets.framing ?? [],
    }
  }

  /** 发送前确定性清洗：去分镜元信息行、中文章节名映射为官方字段名；令牌原样保留 */
  const sanitizeBriefForGenerate = (text: string): string => {
    const sectionMap: Array<[RegExp, string]> = [
      [/^\s*【画面描述】\s*$/gm, 'integrated_multimodal_description:'],
      [/^\s*【主体定义】\s*$/gm, 'subject_definitions:'],
      [/^\s*【环境音】\s*$/gm, 'overall_soundscape:'],
      [/^\s*【配乐】\s*$/gm, 'non_diegetic_music:'],
    ]
    let out = text
    for (const [pattern, replacement] of sectionMap) out = out.replace(pattern, replacement)
    return out
      .split('\n')
      .filter((line) => !/^\s*(beat|时长|duration|shots|镜头表|导演说明|衔接|参考图)\s*[:：]/i.test(line))
      .join('\n')
      .trim()
  }

  /** 分镜任务模式 → 后端模板参数 */
  const taskTemplateOf = (raw: string): { task_type: string; task_mode: string } => {
    const value = raw.toLowerCase()
    if (value.includes('r2v') || value.includes('ref')) return { task_type: 'r2v', task_mode: 'ref' }
    if (value.includes('fmlf2v') || value.includes('fl2v')) return { task_type: 'i2v', task_mode: 'default' }
    if (value.includes('vi2v') || value.includes('edit')) return { task_type: 'r2v', task_mode: 'ref' }
    if (value.includes('l2v')) return { task_type: 'l2v', task_mode: 'l2v' }
    return { task_type: 't2v', task_mode: 'default' }
  }

  async function postGenerate(payloadOptions: Record<string, unknown>, text: string) {
    const response = await fetch('/easy-media/prompt-studio/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify((() => {
        // D2：任务模式（脚本段 > 脚本级 > 默认）、段时长、输出语言
        // 注意：options 里存在默认 task_type='Ref2VA' / duration_seconds=5，必须覆盖而不是并列传，否则后端读 options 优先会屏蔽
        const segSettings = (activeScriptSegment as unknown as { settings?: { taskType?: string } } | undefined)?.settings
        const planSettings = (scriptPlan as unknown as { settings?: { taskType?: string } } | null)?.settings
        const rawTask = segSettings?.taskType || planSettings?.taskType || ''
        const mapped = taskTemplateOf(rawTask)
        const segmentDuration = Number((activeScriptSegment as unknown as { duration_seconds?: number } | undefined)?.duration_seconds ?? 0) || 0
        const language = String(payloadOptions.output_language ?? options.output_language ?? '')
        return {
          brief: sanitizeBriefForGenerate(text),
          options: {
            ...options,
            ...payloadOptions,
            ...presetPayload(),
            task_type: mapped.task_type,
            task_mode: mapped.task_mode,
            task_label: rawTask,
            ...(segmentDuration > 0 ? { duration_seconds: segmentDuration } : {}),
            output_language: language,
          },
          global_prompt: globalDraft,
          task_type: mapped.task_type,
          task_mode: mapped.task_mode,
          duration_seconds: segmentDuration || undefined,
          language,
        // D2：主体带令牌/描述/保留项（绑定主体用契约编号，未绑定按池序续号）
        subjects: (() => {
          const subjectEntries = editorResources.filter((item) => item.type === 'subject')
          return subjectEntries.map((entry) => {
            const pool = resources.find((item) => item.name === entry.label.replace(/（.*）$/, ''))
            return {
              token: entry.token,
              name: pool?.name ?? entry.label,
              description: pool?.description ?? '',
              retention: pool?.retention ?? [],
            }
          })
        })(),
        // D2：本段绑定清单（编号契约同源）
        bindings: {
          pictures: editorResources.filter((item) => item.type === 'image').map((item) => ({ token: item.token, name: item.label })),
          audio: editorResources.filter((item) => item.type === 'audio').map((item) => ({ token: item.token, name: item.label })),
          video: editorResources.filter((item) => item.type === 'video').map((item) => ({ token: item.token, name: item.label })),
        },
          images: imagePaths ?? [],
          picture_count: pictureCount ?? null,
          audio_count: audioCount ?? null,
          video_count: videoCount ?? null,
        }
      })()),
    })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, data }
  }

  function setResultText(text: string) {
    setResult(text)
    setSections(splitSections(text))
  }

  /** 把「生成标准提示词」这件事交给 AI 助手执行（进度显示在右栏对话里） */
  /** 「分镜→片段」：派给 AI 助手写片段提示词（白话、不要求六段），不可用则回退本地构建 */
  function askAgentFragment(): boolean {
    const registry = globalThis as unknown as { __easyMediaAgentAsk?: (text: string) => void }
    if (!registry.__easyMediaAgentAsk) return false
    const segment = activeScriptSegment as unknown as Record<string, unknown> | undefined
    const name = String(segment?.name ?? `第 ${activeScriptIndex + 1} 段`)
    const seconds = Number(segment?.duration_seconds ?? 0) || 0
    const tokenRows = editorResources.filter((item) => item.type === 'subject' || item.type === 'image' || item.type === 'audio')
    const bindingTable = tokenRows.map((item) => `${item.token}=${item.label}`).join('｜')
  const aspectRatio = String((globalThis as unknown as { __easyMediaTimelineSummary?: () => { ratio?: string } }).__easyMediaTimelineSummary?.()?.ratio ?? '9:16')
    const subjectCount = editorResources.filter((item) => item.type === 'subject').length
    const pictureCount = editorResources.filter((item) => item.type === 'image').length
    const audioCount = editorResources.filter((item) => item.type === 'audio').length
    setResultTab('ai')
    registry.__easyMediaAgentAsk([
      `只做第 ${activeScriptIndex + 1} 段「${name}」的片段稿：用 write_prompt(index=${activeScriptIndex + 1}, target=fragment) 写入，不要动终稿和其它段。`,
      '',
      '【格式（照抄形状，标签不要另起一行）】',
      '概述：<一句话：画幅 + 时长；场景、人物、基调、观众该看什么>',
      '钩子：<一句话>',
      '[Shot 1] 约 X.Xs｜<景别>：<机位/构图/动作/节奏>',
      '<d>[Chinese] <台词原文></d>   ← 台词必须这样写，不要用「台词：」',
      '[Shot 2] …（同上）',
      '声音：<现场声；独立音频才带令牌>',
      '规定：标签后直接接冒号与内容，同一行；不要写成「概述」独占一行再换行写字。',
      '',
      '**不要沿用本对话里之前那段片段稿的写法**：按下面的格式从头写。',
      '',
      '【事实】',
      `本段令牌表：${bindingTable || '（无绑定）'}`,
      `可用编号：Subject ≤ ${subjectCount}，Picture ≤ ${pictureCount}，Audio ≤ ${audioCount}；时长 ${seconds || '?'} 秒；画幅 ${aspectRatio}`,
      '**时长与画幅不要写成标题**：放进概述第一句（如「9:16 竖屏，10 秒，维修车间内景」）。',
      '',
      '【写法】',
      '第一句就是「概述：」，不要写「第 N 段｜段名（10s）」这类标题行——终稿没有标题，标题会误导。',
      '概述（2–4 句）：第一句带时长与画幅；再写在哪儿、谁在场、什么基调（光线/景深/风格）、观众该看什么。',
      '[Shot N] 约 Xs｜景别：只写镜头与画面实现（机位/构图/动作/节奏/切换）；概述说过的不要重复。',
      '台词只用 <d>[Chinese] 原文</d>（每句一条），不要写成「台词：…」；声音写现场声。',
      '优先用主体：已建 <Subject n> 的（人物/场景/道具）就用主体，没建主体的才用 <Picture n>；只想借构图时写「仅借构图」。',
      '主体/资源直接写进句子：<Subject 1>（老赵）坐在 <Picture 1>（工作台）前…；括号紧跟令牌，保留说明只在首次出现写一次。',
      '说话角色的音色可省（主体定义里已有）；只有独立音频（配乐/环境/音效）才写进「声音」。',
      '语言、详略、镜头描述方式随你。',
      '',
      '',
      '【样例】（照这个密度和口吻写，内容按本段换）',
      '概述：9:16 竖屏，10 秒；维修车间内景，<Subject 1>（老赵）坐在 <Picture 1>（工作台，保留台面质感与台灯落位）前；冷调侧顶光、浅景深，写实记录风格；整段是「劝人别乱花钱却劝你修整套」的反差开场，注意力压在老赵的表情和手边那只坏油嘴上。',
      '钩子：最不建议乱花钱的人，反而劝你修整套。',
      '[Shot 1] 约 4.5s｜中近景：<Subject 1> 坐在 <Picture 1> 前直对镜头口播，右手压在擦布上',
      '<d>[Chinese] 修油嘴这行，我是最不建议大家乱花钱的。</d>',
      '[Shot 2] 约 3s｜俯拍特写：一只积碳发黑的油嘴从画外落入 <Picture 2>（保留盘内排布与积碳状态）的盘里，弹一下停住',
      '[Shot 3] 约 2.5s｜中近景：切回同机位，<Subject 1> 抬手在台面轻按两下',
      '<d>[Chinese] 先别急着骂，听完再决定。</d>',
      '声音：口播 + 台面闷响，车间底噪持续；无独立配乐。',
      '',
      '【禁区】',
      '不写标题行（第 N 段｜段名｜时长）；不写文件名（.jpg/.png/.wav）；不列「可用素材」清单；不写六段键名或禁字幕句；不扩展范围。',
    ].join('\n'))
    return true
  }

function askAgentGenerate(language: '中文' | 'English') {
  const registry = globalThis as unknown as { __easyMediaAgentAsk?: (text: string) => void }
  const segmentName = String((activeScriptSegment as unknown as { name?: string })?.name ?? `第 ${activeScriptIndex + 1} 段`)

  const tokenRows = editorResources.filter((item) => item.type === 'subject' || item.type === 'image' || item.type === 'audio')
  const bindingTable = tokenRows.map((item) => `${item.token}=${item.label}`).join('｜')
  const shotCount = Array.isArray((activeScriptSegment as { shots?: unknown[] } | undefined)?.shots)
    ? ((activeScriptSegment as { shots?: unknown[] }).shots ?? []).length
    : 0
  const seconds = Number((activeScriptSegment as { duration_seconds?: number } | undefined)?.duration_seconds ?? 0) || 0
  const aspectRatio = String((globalThis as unknown as { __easyMediaTimelineSummary?: () => { ratio?: string } }).__easyMediaTimelineSummary?.()?.ratio ?? '9:16')
  const directive = [
    `只做第 ${activeScriptIndex + 1} 段「${segmentName}」的终稿：用 write_prompt(index=${activeScriptIndex + 1}, target=final) 写入，不要动片段稿和其它段（${language === 'English' ? '英文' : '中文'}正文）。`,
    '',
    '【事实】',
    `本段令牌表：${bindingTable || '（无绑定）'}`,
    `可用编号：Subject ≤ ${tokenRows.filter((item) => item.type === 'subject').length}，Picture ≤ ${tokenRows.filter((item) => item.type === 'image').length}，Audio ≤ ${tokenRows.filter((item) => item.type === 'audio').length}；时长 ${seconds || '?'} 秒；画幅 ${aspectRatio}；镜头数 ${shotCount}`,
    '',
    '【三份输入，先读】',
    '1. get_segment：完整分镜（镜头/台词/时长/settings），镜头数与台词以它为准；',
    '2. get_prompt_context：本段绑定与保留项，编号照抄；',
    '3. 文末片段稿：用户的意图与补充，优先级高于你的自由发挥。需要时 read_skill h3-prompt-spec。',
    '',
    '【六段怎么写】',
    'subject_definitions：每令牌一行。`<Subject n>` 写身份+保留项+排除项（可写 whose identity, facial structure, hairstyle, body proportions and wardrobe come from `<Picture n>`）；`<Picture n>` 只提供身份/构图时写明 it is not a mandatory first frame；`<Audio n>` 写 is the voice-timbre reference for `<Subject n> (Sx)`。',
    'summary：以任务类型前缀开头（[reference generation]，有音色参考则 [reference generation + audio reference]），写明「时长-second + 画幅」；不引入新令牌。',
    'retention_analysis：只列本段出现的令牌，一令牌一行；画面标记用 fully_preserved / partially_preserved / attribute_transfer / weak_reference，音频用 fully_copy / partially_copy / reference / weak_reference。形如 `<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - …`；音频写 reference - the target speaker follows `<Audio n>`\'s voice timbre and delivery without copying the original signal。',
    'detailed_description：逐镜写七要素——构图、主体外观与位置、环境与光线、动作与状态变化、镜头运动、当前声音、参考内容在这镜哪里生效；不要写成剧情摘要或参考关系清单。',
    `detailed_description 时间码：` + '[Shot 1] 无时间戳；其后 `[Shot N] At MM:SS.mmm, …`，递增且小于总时长。',
    '台词只在视觉时间线：`<Subject n> (Sx) says: <d>[Chinese] 原文</d>`；(Sx) 不进定义行、不进 <d>；与分镜一字不改。',
    'overall_soundscape 只写环境声与可见动作的声音，不复述台词；non_diegetic_music 写 N/A 或具体配乐。',
    '结尾固定加一行禁字幕/水印句。',
    '【六段怎么写】',
    'subject_definitions：每个绑定令牌一行。`<Subject n>` 写身份 + 必须保留的项 + 明确排除项（不复制参考图的版式/背景/机位）；`<Picture n>` 只写"提供哪一帧或哪件道具的依据"；`<Audio n>` 写 `is the voice-timbre reference for <Subject n> (Sx)`（无说话人则写仅音色参考）。',
    'summary：一段话讲清这段演了什么（地点/人物/动作/情绪落点），可带 `[reference generation + audio reference]` 之类标记。',
    'retention_analysis：只列本段真正出现过的令牌；逐项写"保留什么 + 不复制什么"；音频项写 `reference - 仅取音色与语速`，不要写 `reused`。',
    `detailed_description：先一句风格/画幅/时长总述，再逐镜。` +
      '[Shot 1] 不带时间戳，[Shot 2] 起写 `At 00:0X.XXX`，时间码按分镜各镜时长累加、末镜结束等于总时长。',
    '台词：`<Subject n> (Sx) says: <d>[Chinese] 原文</d>`。`(Sx)` 只在音色归属行与发声处出现，不许进定义行、不许进 <d>；分镜每句台词都要出现，一字不改。',
    'overall_soundscape：只写现场声；non_diegetic_music：无配乐就写「无配乐」，有就写清风格与情绪。两段都不要复述 detailed_description。',
    '结尾固定加一行禁字幕/水印句。',
    '',
    '【禁区】',
    '**本次只产终稿**：只调用一次 write_prompt(target=final)。不得调用 target=fragment，不得改片段稿、不得改其它段——用户没要求就不要生成片段提示词。',
    '不扩展范围；不编造分镜里没有的镜头/台词/动作。',
    '单镜出现的道具不要升格成 `<Subject n>`（跨段一致才建主体），用 `<Picture n>` 或句内描述；编号不得越界。',
    '返回 needs_revision 时按 problems 改一次再写，不要 force/auto_align 绕过。',
    '',
    '片段稿：',
    '---------',
    String(activePrompt ?? '').trim() || '（空，按分镜与绑定补全）',
    '---------',
  ].join('\n')
  if (!registry.__easyMediaAgentAsk) return false
  setResultTab('ai')
  registry.__easyMediaAgentAsk(directive)
  return true
}

async function handleGenerate(language?: '中文' | 'English', sourcePrompt?: string) {
    const outputLanguage = language ?? options.output_language
    setBusy(true)
    setError('')
    setFailures([])
    setAutoFixes([])
    setResult('')
    setSections([])
    try {
      const { ok, data } = await postGenerate({ output_language: outputLanguage }, sourcePrompt ?? brief)
      if (!ok) {
        setError(String(data?.error || t('multitrack.enhancerFailed')))
        return
      }
      const generated = String(data?.prompt || '')
      const normalized = normalizeSectionHeadings(generated)
      setResultText(generated)
      setLastGenerated(normalized)
      // 生成结果直接落进「最终提示词」编辑器：通过校验即可一键写入任务轨
      setFinalDraft(normalized)
      setFailures(Array.isArray(data?.failures) ? data.failures : [])
      setAutoFixes(Array.isArray(data?.contract?.auto_fixed) ? (data.contract.auto_fixed as string[]) : [])
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

  const finalPrompt = normalizeSectionHeadings(sections.length ? joinSections(sections) : (result || lastGenerated))
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
        background: 'rgba(0,0,0,0.92)',
        padding: 0,
      }}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        onClose()
      }}
    >
      <div
        className="easy-media-scope"
        style={{
          ['--easy-chat-scale' as never]: String(appearance.chatScale / 100),
          display: 'flex',
          flexDirection: 'column',
          // 缩放：布局盒先按 1/scale 缩小，再用 transform 放大，保证放大后贴合窗口不出屏
          width: `${100 / (appearance.uiScale / 100)}vw`,
          height: `${100 / (appearance.uiScale / 100)}vh`,
          transform: `scale(${appearance.uiScale / 100})`,
          transformOrigin: 'center center',
          background: PANEL_BG,
          border: 'none',
          borderRadius: 0,
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
            <div className="relative ml-1">
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-[11px]"
                style={{ borderColor: BORDER }}
                onClick={() => {
                  const bridge = (globalThis as unknown as {
                    __easyMediaWorkspaceProject?: { list: () => string[] }
                  }).__easyMediaWorkspaceProject
                  setProjectMenu(bridge ? bridge.list() : [])
                  setProjectMenuOpen((value) => !value)
                }}
              >
                {projectName || '未选择项目'} ▾
              </button>
              {projectMenuOpen ? (
                <div
                  className="absolute left-0 top-7 z-10 max-h-64 w-56 overflow-auto rounded border p-1 text-[11px]"
                  style={{ background: PANEL_BG, borderColor: BORDER }}
                >
                  {projectMenu.length === 0 ? (
                    <div className="px-2 py-1 text-muted-foreground">（没有可载入的项目）</div>
                  ) : projectMenu.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="block w-full rounded px-2 py-1 text-left hover:bg-white/10"
                      onClick={async () => {
                        setProjectMenuOpen(false)
                        const bridge = (globalThis as unknown as {
                          __easyMediaWorkspaceProject?: { switch: (value: string) => Promise<void> }
                        }).__easyMediaWorkspaceProject
                        if (!bridge) return
                        await bridge.switch(name)
                        setProjectName(name)
                        setWorkspaceReloadKey((value) => value + 1)
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {creatingProject ? (
              <>
                <input
                  style={{ ...fieldStyle, width: 120, padding: '2px 4px' }}
                  placeholder="新项目名"
                  value={newProjectName}
                  autoFocus
                  onChange={(event) => setNewProjectName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void confirmCreateProject()
                    if (event.key === 'Escape') setCreatingProject(false)
                  }}
                />
                <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => void confirmCreateProject()}>
                  确认
                </Button>
                <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => setCreatingProject(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setCreatingProject(true)
                  setNewProjectName('')
                }}
              >
                + 新建
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="保存到任务轨（先检测完善度）"
              className="h-7 w-7"
              onClick={() => setSaveCheckOpen((value) => !value)}
            >
              <ListPlus className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="保存分镜草稿"
              className="h-7 w-7"
              onClick={() => window.dispatchEvent(new CustomEvent('easy-media.workspace.save'))}
            >
              <Save className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={t('multitrack.enhancerSettings')}
              className={cn('h-7 w-7', view === 'settings' && 'text-primary')}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" title={t('multitrack.enhancerClose')} className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          {([
            ['storyboard', '分镜编排'],
                        ['assets', '主体与资源'],
            ['enhance', '提示词增强'],
          ] as Array<[WorkspaceTab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="rounded px-2 py-1 text-[12px]"
              style={{
                background: workspaceTab === key ? 'hsl(var(--primary, 199 89% 48%) / 0.18)' : 'transparent',
                color: workspaceTab === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
                border: `1px solid ${workspaceTab === key ? 'hsl(var(--primary, 199 89% 48%))' : 'transparent'}`,
              }}
              onClick={() => setWorkspaceTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {saveCheckOpen ? (
          (() => {
            const storeKey = projectName || 'default'
            const plan = readWorkspace(storeKey).plan
            const segs = workspaceSegments
            const prompted = segs.filter((segment) => String((segment.content as unknown as { user_prompt?: string } | null)?.user_prompt ?? '').trim()).length
            const subjects = workspaceSubjects
            const noDesc = subjects.filter((subject) => !(subject.description ?? '').trim()).length
            const planned = plannedResources.length
            const rows: Array<{ ok: boolean; text: string }> = [
              { ok: Boolean(plan), text: plan ? `分镜脚本：${plan.segments.length} 段 · ${plan.total_seconds}s` : '分镜脚本：未生成（将只保留现有任务分段）' },
              { ok: segs.length > 0, text: `任务分段：${segs.length} 段${segs.length ? `，已写提示词 ${prompted}/${segs.length}` : ''}` },
              { ok: subjects.length > 0, text: `主体：${subjects.length} 个${noDesc ? `，${noDesc} 个缺描述` : ''}` },
              { ok: true, text: `资源需求：${planned} 项（匹配情况见「项目资源」页）` },
            ]
            const registry = (globalThis as unknown as {
              __easyMediaApplyStoryboard?: (items: Array<{ name: string; durationFrames: number; brief: string }>) => boolean
            }).__easyMediaApplyStoryboard
            return (
              <div
                className="fixed right-3 top-12 z-50 flex w-[380px] flex-col gap-2 rounded-lg p-3 text-[12px]"
                style={{ background: PANEL_BG, border: `1px solid ${BORDER}`, boxShadow: '0 12px 32px rgba(0,0,0,0.5)' }}
              >
                <div className="text-[13px] font-medium">保存到任务轨 · 完善度检测</div>
                {rows.map((row) => (
                  <div key={row.text} className="flex items-start gap-2">
                    <span style={{ color: row.ok ? 'hsl(var(--primary, 199 89% 48%))' : '#fbbf24' }}>{row.ok ? '✓' : '⚠'}</span>
                    <span>{row.text}</span>
                  </div>
                ))}
                <div className="mt-1 border-t pt-1" style={{ borderColor: BORDER }}>
                  <div className="mb-1 text-[11px] text-muted-foreground">保存目标（同步到导演台设置）</div>
                  <div className="flex flex-wrap gap-3">
                    {(['task', 'video', 'audio', 'subtitle'] as const).map((key) => (
                      <label key={key} className="flex cursor-pointer items-center gap-1 text-[11px]">
                        <input
                          type="checkbox"
                          checked={directorSettings.save.targets[key]}
                          onChange={(event) => {
                            const next = {
                              ...directorSettings,
                              save: {
                                ...directorSettings.save,
                                targets: { ...directorSettings.save.targets, [key]: event.target.checked },
                              },
                            }
                            setDirectorSettings(next)
                            writeDirectorSettings(settingsProject, next)
                          }}
                        />
                        {{ task: '任务轨', video: '视频轨', audio: '音频轨', subtitle: '字幕轨' }[key]}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  本次将写入：提示词 {abTab.toUpperCase()} 版 1 条
                  {directorSettings.save.writeImages ? ` · 参考图 ${(() => {
                    const pictures = boundIds.flatMap((id) => {
                      const resource = resources.find((item) => item.id === id)
                      if (!resource) return []
                      if (resource.type === 'Subject') {
                        return (resource.childResourceIds ?? [])
                          .map((childId) => resources.find((item) => item.id === childId))
                          .filter((item): item is ProjectResource => Boolean(item) && item!.type === 'Picture')
                      }
                      return resource.type === 'Picture' ? [resource] : []
                    })
                    return pictures.filter((item) => item.imageFile || item.name).length
                  })()} 张` : ''}
                  {directorSettings.save.targets.audio ? ` · 音频段 ${(() => {
                    const audios = boundIds.flatMap((id) => {
                      const resource = resources.find((item) => item.id === id)
                      if (!resource) return []
                      if (resource.type === 'Subject') {
                        return (resource.childResourceIds ?? [])
                          .map((childId) => resources.find((item) => item.id === childId))
                          .filter((item): item is ProjectResource => Boolean(item) && item!.type === 'Audio')
                      }
                      return resource.type === 'Audio' ? [resource] : []
                    })
                    return audios.filter((item) => item.audioFile || item.name).length
                  })()} 个` : ''}
                  {directorSettings.save.targets.video ? ` · 视频段 ${(() => {
                    const videos = boundIds.flatMap((id) => {
                      const resource = resources.find((item) => item.id === id)
                      if (!resource) return []
                      if (resource.type === 'Subject') {
                        return (resource.childResourceIds ?? [])
                          .map((childId) => resources.find((item) => item.id === childId))
                          .filter((item): item is ProjectResource => Boolean(item) && item!.type === 'Video')
                      }
                      return resource.type === 'Video' ? [resource] : []
                    })
                    return videos.filter((item) => item.videoFile || item.name).length
                  })()} 个` : ''}
                  {directorSettings.save.targets.subtitle && directorSettings.subtitle.enabled ? ` · 字幕 ${(() => {
                    let count = 0
                    if (directorSettings.subtitle.fromDialogue) {
                      const planData = readWorkspace(storeKey).plan as { segments?: Array<{ shots?: Array<Record<string, unknown>> }> } | null
                      for (const planSegment of planData?.segments ?? []) {
                        for (const shot of planSegment.shots ?? []) {
                          for (const entry of (shot as { dialogue?: Array<{ line?: string }> }).dialogue ?? []) {
                            count += String(entry.line ?? '').trim()
                              .split(/(?<=[。！？；…])/).map((item) => item.trim()).filter(Boolean).length
                          }
                        }
                      }
                    }
                    if (directorSettings.subtitle.fromTaggedDescription) {
                      for (const subject of workspaceSubjects) {
                        count += Array.from((subject.description ?? '').matchAll(/<#([^:>]+):([^>]+)>/g)).length
                      }
                    }
                    return count
                  })()} 句` : ''}
                </div>
                {prompted < segs.length ? (
                  <div className="text-[11px] text-muted-foreground">提示：还有 {segs.length - prompted} 段没写提示词，可在「提示词增强」页补齐。</div>
                ) : null}
                <div className="mt-1 flex justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setSaveCheckOpen(false); setReplaceArmed(false) }}>返回完善</Button>
                  <Button
                    size="sm"
                    variant={directorSettings.save.overwrite === 'replace' && !replaceArmed ? 'secondary' : 'default'}
                    disabled={!plan || !registry}
                    onClick={() => {
                      if (!plan || !registry) return
                      if (directorSettings.save.overwrite === 'replace' && !replaceArmed) {
                        setReplaceArmed(true)
                        return
                      }
                      registry(plan.segments.map((segment) => ({
                        name: segment.name,
                        durationFrames: segment.duration_frames,
                        brief: formatPlanSegmentBrief(segment as never),
                      })))
                      setReplaceArmed(false)
                      setSaveCheckOpen(false)
                    }}
                  >
                    {directorSettings.save.overwrite === 'replace'
                      ? (replaceArmed ? '⚠ 确认整轨替换（手改将丢失）' : `仍然保存（${{ merge: '合并', 'fill-missing': '仅补缺', replace: '整轨替换' }[directorSettings.save.overwrite]}）`)
                      : '仍然保存'}
                  </Button>
                </div>
              </div>
            )
          })()
        ) : null}
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
        ) : workspaceTab !== 'enhance' ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
            {workspaceTab === 'storyboard' ? (
<StoryboardTab
              key={workspaceReloadKey}
              projectKey={(globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'}
              segments={workspaceSegments}
              frameRate={workspaceFrameRate}
              selectedSegmentId={segmentId}
              onSelectSegment={(id) => onActivateSegment?.(id)}
              onWritePrompt={onWriteSegmentPrompt}
              onGeneratePrompt={async (_segmentId, brief) => {
                setWorkspaceGenerating(true)
                setWorkspaceError('')
                try {
                  const { ok, data } = await postGenerate({ language: 'English' }, brief)
                  if (!ok) {
                    setWorkspaceError(String((data as { error?: string })?.error || '生成失败'))
                    return ''
                  }
                  return String((data as { prompt?: string })?.prompt || '')
                } catch (error) {
                  setWorkspaceError(String(error))
                  return ''
                } finally {
                  setWorkspaceGenerating(false)
                }
              }}
              generating={workspaceGenerating}
              planning={workspaceGenerating}
              error={workspaceError}
              onImportPlanSubjects={(plan) => {
                setWorkspaceSubjects((current) => {
                  const next = [...current]
                  const seen = new Set(next.map((item) => item.name))
                  for (const segment of plan.segments) {
                    for (const subject of segment.subjects) {
                      if (!subject.name || seen.has(subject.name)) continue
                      seen.add(subject.name)
                      next.push({
                        id: `plan-subject-${next.length + 1}`,
                        name: subject.name,
                        type: subject.type || '人物',
                        description: subject.description || '',
                        retention: subject.retention || [],
                      })
                    }
                  }
                  return next
                })
              }}
              onImportPlanResources={(plan) => {
                const seen = new Set<string>()
                const next: Array<{ kind: string; name: string; purpose?: string }> = []
                for (const segment of plan.segments) {
                  for (const resource of segment.resources) {
                    const key = `${resource.kind}:${resource.name}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    next.push({ kind: resource.kind, name: resource.name, purpose: resource.for })
                  }
                }
                setPlannedResources(next)
              }}
              onOpenAssets={() => setWorkspaceTab('assets')}
              onOpenEnhance={(index?: number) => {
                if (typeof index === 'number' && index >= 0) setActiveScriptIndex(index)
                setWorkspaceTab('enhance')
              }}
              onApplyPlan={(items) => {
                const registry = globalThis as unknown as {
                  __easyMediaApplyStoryboard?: (value: typeof items) => boolean
                }
                if (!registry.__easyMediaApplyStoryboard) return false
                try {
                  return registry.__easyMediaApplyStoryboard(items)
                } catch (error) {
                  console.error('[EasyMedia] apply storyboard failed', error)
                  return false
                }
              }}
            />
            ) : (
              <AssetsTab
                subjects={workspaceSubjects}
                onSubjectsChange={(next) => setWorkspaceSubjects(next)}
                resources={resources}
                onAddFromShared={onAddSharedResource}
                onPatch={onPatchProjectResource}
                onRemove={onRemoveProjectResource}
                onCreateEmpty={onCreateProjectResource}
                onBindFile={onBindProjectResourceFile}
                onUnbindFile={onUnbindProjectResourceFile}
              />
            )}
            </div>
            {workspaceTab === 'assets' ? (
              <div className="flex min-h-0 w-[460px] shrink-0 flex-col" style={{ borderLeft: `1px solid ${BORDER}` }}>
                <div className="flex shrink-0 gap-1 p-2 pb-0 text-[11px]">
                  {([['shared', '共享资源'], ['ai', 'AI 助手']] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className="rounded px-2 py-0.5"
                      style={{ border: `1px solid ${assetsRailTab === key ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`, color: assetsRailTab === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined }}
                      onClick={() => setAssetsRailTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ display: assetsRailTab === 'shared' ? undefined : 'none' }}>
                  <AssetsSharedBrowser onAdd={(item) => onAddSharedResource?.(item as never)} />
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ display: assetsRailTab === 'ai' ? undefined : 'none' }}>
              <AgentRail
    width="fill"
    active={assetsRailTab === 'ai'}
                projectKey={(globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'}
                tab={workspaceTab}
                frameRate={workspaceFrameRate}
                ratio={(() => {
                  const summary = (globalThis as unknown as { __easyMediaTimelineSummary?: () => { ratio?: string } }).__easyMediaTimelineSummary
                  try { return summary?.().ratio || '16:9' } catch { return '16:9' }
                })()}
                segments={workspaceSegments.map((segment, index) => {
                  const content = segment.content as unknown as { user_prompt?: string; images?: Array<{ file_name?: string; name?: string }> }
                  const promptText = String(content?.user_prompt ?? '')
                  const label = promptText.split('\n').find((line) => line.trim())?.replace(/<[^>]+>/g, '').trim().slice(0, 18) || `镜头 ${index + 1}`
                  return {
                    index: index + 1,
                    name: label,
                    durationSeconds: Math.max(0, segment.end_frame - segment.start_frame) / Math.max(1, workspaceFrameRate),
                    images: (content?.images ?? []).map((item) => String(item?.file_name ?? item?.name ?? '')).filter(Boolean),
                    hasPrompt: promptText.trim().length > 0,
                  }
                })}
                subjects={workspaceSubjects.map((subject) => ({ name: subject.name, desc: String(subject.description ?? '').slice(0, 120) }))}
                audioTracks={(() => {
                  const summary = (globalThis as unknown as { __easyMediaTimelineSummary?: () => { audio: string[] } }).__easyMediaTimelineSummary
                  try { return summary?.().audio ?? [] } catch { return [] }
                })()}
                resources={plannedResources.map((resource) => ({ name: resource.name }))}
                onApplyPlan={(next) => {
                  const registry = (globalThis as unknown as {
                    __easyMediaApplyStoryboard?: (items: Array<{ name: string; durationFrames: number; brief: string }>) => boolean
                  }).__easyMediaApplyStoryboard
                  if (!registry) return false
                  return registry(next.segments.map((segment) => ({
                    name: segment.name,
                    durationFrames: segment.duration_frames,
                    brief: formatPlanSegmentBrief(segment as never),
                  })))
                }}
              />
                </div>
              </div>
            ) : (
              <AgentRail
                projectKey={(globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'}
                tab={workspaceTab}
                frameRate={workspaceFrameRate}
                ratio={(() => {
                  const summary = (globalThis as unknown as { __easyMediaTimelineSummary?: () => { ratio?: string } }).__easyMediaTimelineSummary
                  try { return summary?.().ratio || '16:9' } catch { return '16:9' }
                })()}
                segments={workspaceSegments.map((segment, index) => {
                  const content = segment.content as unknown as { user_prompt?: string; images?: Array<{ file_name?: string; name?: string }> }
                  const promptText = String(content?.user_prompt ?? '')
                  const label = promptText.split('\n').find((line) => line.trim())?.replace(/<[^>]+>/g, '').trim().slice(0, 18) || `镜头 ${index + 1}`
                  return {
                    index: index + 1,
                    name: label,
                    durationSeconds: Math.max(0, segment.end_frame - segment.start_frame) / Math.max(1, workspaceFrameRate),
                    images: (content?.images ?? []).map((item) => String(item?.file_name ?? item?.name ?? '')).filter(Boolean),
                    hasPrompt: promptText.trim().length > 0,
                  }
                })}
                subjects={workspaceSubjects.map((subject) => ({ name: subject.name, desc: String(subject.description ?? '').slice(0, 120) }))}
                audioTracks={(() => {
                  const summary = (globalThis as unknown as { __easyMediaTimelineSummary?: () => { audio: string[] } }).__easyMediaTimelineSummary
                  try { return summary?.().audio ?? [] } catch { return [] }
                })()}
                resources={plannedResources.map((resource) => ({ name: resource.name }))}
                onApplyPlan={(next) => {
                  const registry = (globalThis as unknown as {
                    __easyMediaApplyStoryboard?: (items: Array<{ name: string; durationFrames: number; brief: string }>) => boolean
                  }).__easyMediaApplyStoryboard
                  if (!registry) return false
                  return registry(next.segments.map((segment) => ({
                    name: segment.name,
                    durationFrames: segment.duration_frames,
                    brief: formatPlanSegmentBrief(segment as never),
                  })))
                }}
              />
            )}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '270px minmax(0, 1fr) 460px', flex: 1, minHeight: 0 }}>
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
                  <details className="flex flex-col gap-1">
                    <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">
                      全局提示词（整个项目）
                      {globalDraft.trim() ? ` · 已填 ${globalDraft.trim().length} 字` : ' · 未填写（点击展开）'}
                    </summary>
                    <textarea
                      style={{ ...fieldStyle, minHeight: 64, resize: 'vertical', fontSize: 12, lineHeight: 1.5 }}
                      value={globalDraft}
                      onChange={(event) => {
                        setGlobalDraft(event.target.value)
                        onGlobalPromptChange?.(event.target.value)
                      }}
                      placeholder="约束整支视频中持久出现的角色/物体/场景（来自主体库的全局提示词）"
                    />
                  </details>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className={labelClass}>片段提示词（A/B 原稿，可粗）</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="secondary"
                      className="h-6 whitespace-nowrap px-2 text-[11px]"
                      title="把 A 栏的片段提示词直接作为最终提示词"
                      disabled={!activePrompt.trim()}
                      onClick={() => setFinalDraft(normalizeSectionHeadings(activePrompt))}
                    >
                      直接导入➡️
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-6 whitespace-nowrap px-2 text-[11px]"
                      disabled={busy || translating}
                      onClick={() => { if (!askAgentGenerate('English')) void handleGenerate('English', activePrompt) }}
                    >
                      生成英文➡️
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-6 whitespace-nowrap px-2 text-[11px]"
                      disabled={busy || translating}
                      onClick={() => { if (!askAgentGenerate('中文')) void handleGenerate('中文', activePrompt) }}
                    >
                      生成中文➡️
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-muted-foreground">分镜脚本段</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6 px-2 text-[11px]"
                    disabled={activeScriptIndex <= 0}
                    onClick={() => selectScriptSegment(activeScriptIndex - 1)}
                  >
                    ◀
                  </Button>
                  <select
                    style={{ ...fieldStyle, width: 220 }}
                    value={String(activeScriptIndex)}
                    onChange={(event) => selectScriptSegment(Number(event.target.value))}
                  >
                    {scriptSegments.length === 0 ? (
                      <option value="0">（脚本为空，先去「分镜编排」新建）</option>
                    ) : scriptSegments.map((item, index) => {
                      const record = item as Record<string, unknown>
                      const hasA = Boolean(String(record.finalA ?? '').trim())
                      const hasB = Boolean(String(record.finalB ?? '').trim())
                      const name = String(record.name ?? `镜头 ${index + 1}`)
                      return (
                        <option key={index} value={String(index)}>
                          {`${index + 1}. ${name}${hasA ? ' ✓A' : ''}${hasB ? ' ✓B' : ''}`}
                        </option>
                      )
                    })}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6 px-2 text-[11px]"
                    disabled={activeScriptIndex >= scriptSegments.length - 1}
                    onClick={() => selectScriptSegment(activeScriptIndex + 1)}
                  >
                    ▶
                  </Button>
                  <span className="text-[10px] text-neutral-500">✓ = 已写最终提示词；任务轨在右栏「任务轨」只读对照</span>
                </div>
                <div className="flex items-center gap-1">
                  {([['a', 'A · 片段提示词'], ['b', 'B · 我的尝试']] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className="rounded px-2 py-0.5 text-[11px]"
                      style={{
                        border: '1px solid ' + (abTab === key ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--border, 240 6% 25%))'),
                        color: abTab === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
                      }}
                      onClick={() => setAbTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="ml-auto text-[10px] text-neutral-500">
                    {abTab === 'a' ? '手写或从分镜导入' : '自由填写，作 AI 参考'}
                  </span>
                  {abTab === 'a' && activeScriptSegment ? (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{ border: `1px solid ${BORDER}` }}
                      title="把分镜段的名称/镜头/台词拼成原稿填入 A 栏"
                      onClick={() => {
                        const briefFromPlan = String(formatPlanSegmentBrief(activeScriptSegment as never) ?? '').trim()
                        if (!briefFromPlan) return
                        setBrief(briefFromPlan)
                        patchScriptSegment({ promptA: briefFromPlan })
                      }}
                    >
                      ⤓ 从分镜导入原稿
                    </button>
                  ) : null}
                  {abTab === 'a' && activeScriptSegment ? (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{ border: `1px solid ${BORDER}` }}
                      title="把分镜脚本（名称/画面/节奏/镜头/台词）与本段绑定的主体、资源合成便于编辑的片段提示词"
                      onClick={() => {
                        if (askAgentFragment()) return
                        const segment = activeScriptSegment as unknown as Record<string, unknown>
                        const tokens = computeBindingTokens(boundIds)
                        const line: string[] = []
                        line.push(`第 ${activeScriptIndex + 1} 段｜${String(segment.name ?? '')}（${Number(segment.duration_seconds ?? 0) || '?'}s）`)
                        if (String(segment.summary ?? '').trim()) line.push(`画面：${String(segment.summary).trim()}`)
                        if (String(segment.beat ?? '').trim()) line.push(`节奏：${String(segment.beat).trim()}`)
                        const shots = Array.isArray(segment.shots) ? (segment.shots as Array<Record<string, unknown>>) : []
                        if (shots.length) {
                          line.push('镜头：')
                          shots.forEach((shot, i) => {
                            const parts = [String(shot.framing ?? ''), String(shot.action ?? '')].filter(Boolean).join('，')
                            if (parts) line.push(`- 镜头 ${i + 1}：${parts}`)
                          })
                        }
                        const actorLines: string[] = []
                        for (const id of boundIds) {
                          const resource = resources.find((item) => item.id === id)
                          if (!resource) continue
                          const token = tokens.get(resource.id) ?? ''
                          if (!token) continue
                          const retention = (resource.retention ?? []).slice(0, 4).join('、')
                          actorLines.push(retention ? `${token}（保留：${retention}）` : token)
                        }
                        if (actorLines.length) {
                          line.push('人物与资源：')
                          line.push(...actorLines)
                        }
                        const dialogues = (String(segment.promptA ?? '') + String(segment.summary ?? '')).match(/<d>[\s\S]*?<\/d>/g)
                        if (dialogues?.length) line.push(`台词：${dialogues.join(' ')}`)
                        const text = line.join('\n')
                        setBrief(text)
                        patchScriptSegment({ promptA: text })
                      }}
                    >
                      ⤓ 分镜→片段
                    </button>
                  ) : null}
                </div>
              <div className="text-[11px] text-neutral-500">
                片段提示词：白话描述即可（分镜脚本 + 主体/资源），不需要六段式；生成终稿时再规范化。
              </div>
                <div
                  className="min-h-0 flex-1 overflow-hidden rounded-md"
                  style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}
                >
                  <PromptContentEditor
                    value={abTab === 'a' ? brief : draftPrompt}
                    onChange={(next) => (abTab === 'a' ? setBrief(next) : setDraftPrompt(next))}
                    ariaLabel={t('multitrack.enhancerBrief')}
                    placeholder={abTab === 'a' ? t('multitrack.enhancerBriefPlaceholder') : '自己试着写一版最终效果（作为 AI 参考，不直接送模型）'}
                    resources={editorResources}
                    mentionsEnabled
                    onResourceChosen={handleResourceChosen}
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
                  <span className={labelClass}>本段引用：</span>
                  {(() => {
                    const items = buildReferencedItems()
                    if (items.length === 0) return <span className="text-[11px] text-neutral-500">（无）</span>
                    return items.map((item) => {
                      const color = item.type === 'Subject' ? '#a78bfa' : item.type === 'Picture' ? '#f59e0b' : item.type === 'Audio' ? '#38bdf8' : '#34d399'
                      return (
                        <span
                          key={item.key}
                          className="rounded border px-1.5 py-0.5 text-[11px]"
                          style={{ borderColor: color, color: item.unbound ? undefined : color }}
                          title={`${item.token}${item.unbound ? '（未绑定，仅文本令牌）' : ''}`}
                        >
                          {item.unbound ? '⚠ ' : ''}{item.name || item.token}
                          {item.name ? <span className="ml-1 text-[9px] uppercase opacity-70">{item.token}</span> : null}
                          {item.unbound ? <span className="ml-1 text-[9px] opacity-70">未绑定</span> : null}
                        </span>
                      )
                    })
                  })()}
                </div>
              </div>

              {/* 右栏：结果（可编辑，按段拆分） */}
              <div className="flex min-h-0 min-w-0 flex-col gap-1 ">
                <div className="flex items-center justify-between">
                  <div className="flex gap-1">
                    {([['preview', '预览'], ['script', '分镜'], ['track', '任务轨'], ['ai', 'AI 助手']] as const).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-[11px]"
                        style={{
                          border: `1px solid ${resultTab === key ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
                          color: resultTab === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
                        }}
                        onClick={() => setResultTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {resultTab === 'script' ? (
                  <ScriptTab projectKey={bindingProjectKey} segmentIndex={activeScriptIndex} />
                ) : null}
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto" style={{ display: resultTab === 'preview' ? undefined : 'none' }}>
                  <PromptQualityBar
                    prompt={finalDraft || finalPrompt || (sections.length ? joinSections(sections) : '')}
                    resources={resources}
                    referenceMode={/ref|r2v|reference/i.test(String(options.prompt_mode ?? ''))}
                    taskType={taskTypeOfCurrentSegment()}
                    onChangePrompt={(next) => setFinalDraft(next)}
                  />
                                    <ReferenceBar
                    resources={resources}
                    boundIds={boundIds}
                    onChange={(ids) => writeBindings(bindingProjectKey, bindingKey, ids)}
                    prompt={finalDraft || finalPrompt}
                    onInsertTokens={(next) => setFinalDraft(next)}
                    taskMode={currentTaskModeKey()}
                  />
<div className="flex items-center justify-between gap-2 text-[11px] text-neutral-400">
                  <span className="flex min-w-0 items-center gap-1">最终提示词
                  <span className="flex items-center gap-1">
                    {([['a', 'A 版'], ['b', 'B 版']] as const).map(([key, text]) => (
                      <button
                        key={key}
                        type="button"
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          border: `1px solid ${previewVariant === key ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
                          color: previewVariant === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
                        }}
                        onClick={() => setPreviewVariant(key)}
                      >
                        {text}
                      </button>
                    ))}
                  </span>
                  <span className="truncate">（会保存到任务轨对应 A/B 用户提示词）</span></span>
                  <button
                    type="button"
                    title={finalCopied ? '已复制' : '复制最终提示词'}
                    aria-label={finalCopied ? '已复制' : '复制最终提示词'}
                    className="shrink-0 rounded p-1 hover:bg-white/10"
                    style={{ border: `1px solid ${BORDER}` }}
                    onClick={async () => {
                      const text = finalDraft || finalPrompt
                      if (!text) return
                      try {
                        await navigator.clipboard.writeText(text)
                      } catch {
                        const area = document.createElement('textarea')
                        area.value = text
                        document.body.appendChild(area)
                        area.select()
                        document.execCommand('copy')
                        document.body.removeChild(area)
                      }
                      setFinalCopied(true)
                      setTimeout(() => setFinalCopied(false), 1500)
                    }}
                  >
                    {finalCopied ? <Check size={13} color="hsl(var(--primary, 199 89% 48%))" /> : <Copy size={13} />}
                  </button>
                </div>
                  <div className="min-h-[160px] shrink-0 overflow-hidden rounded-md" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
                    <PromptContentEditor
                      value={finalDraft || finalPrompt}
                      onChange={(next) => setFinalDraft(next)}
                      ariaLabel="最终提示词"
                      placeholder="AI 生成结果会出现在这里，也可手改；写入任务轨的就是这段文本"
                      resources={editorResources}
                      mentionsEnabled
                      onResourceChosen={handleResourceChosen}
                      highlightPromptSemantics
                      className="h-full min-h-[160px] border-none bg-transparent"
                      testId="enhancer-final-editor"
                    />
                  </div>
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
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto" style={{ display: resultTab === 'track' ? undefined : 'none' }}>
                  <div className="text-[11px] text-muted-foreground">任务轨片段（只读对照，不可编辑）</div>
                  {!matchedTaskSegment ? (
                    <div className="rounded p-2 text-[11px]" style={{ border: `1px dashed ${BORDER}` }}>
                      该分镜脚本段尚未落地到任务轨。请先在「分镜编排」点「应用到任务轨」，再回来对照。
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span>片段 {String(matchedTaskSegment.id)}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {matchedTaskSegment.start_frame}–{matchedTaskSegment.end_frame} 帧
                        </span>
                        <span className="text-muted-foreground">
                          任务 {String(((matchedTaskSegment.content as unknown as { task_mode?: string })?.task_mode) ?? '—')}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">A 版 user_prompt</div>
                      <div className="whitespace-pre-wrap rounded p-2 text-[11px]" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
                        {String((matchedTaskSegment.content as unknown as { user_prompt?: string })?.user_prompt ?? '') || '（空）'}
                      </div>
                      <div className="text-[10px] text-muted-foreground">B 版 user_prompt</div>
                      <div className="whitespace-pre-wrap rounded p-2 text-[11px]" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
                        {String((matchedTaskSegment.content as unknown as { user_prompt_b?: string })?.user_prompt_b ?? '') || '（空）'}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ display: resultTab === 'ai' ? undefined : 'none' }}>
                  <AgentRail
                    active={resultTab === 'ai'}
                    projectKey={(globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'}
                    tab="enhance"
                    segments={segments.map((item, index) => ({ index, name: item.label, durationSeconds: 0, hasPrompt: Boolean((item as unknown as { prompt?: string }).prompt) }))}
                    subjects={workspaceSubjects.map((subject) => ({ name: subject.name, desc: String(subject.description ?? '').slice(0, 80) }))}
                    resources={resources.map((item) => ({ name: item.name }))}
                    frameRate={workspaceFrameRate}
                    ratio={(() => {
                      try {
                        const summary = (globalThis as unknown as { __easyMediaTimelineSummary?: () => { ratio?: string } }).__easyMediaTimelineSummary
                        return summary?.().ratio || '16:9'
                      } catch {
                        return '16:9'
                      }
                    })()}
                  />
                </div>
                {error ? (
                  <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', background: 'rgba(146,64,14,0.18)', color: '#fbbf24' }}>{error}</div>
                ) : null}
                {autoFixes.length > 0 && failures.length === 0 ? (
                  <div className="rounded p-1.5 text-[10px]" style={{ border: `1px solid ${BORDER}`, color: '#86efac' }}>
                    已自动修复：{autoFixes.join('、')}
                  </div>
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
                  const target = finalDraft || finalPrompt
                  if (!target) return
                  // 展开绑定（主体→子资源）
                  const expand = (ids: string[]) => ids.flatMap((id) => {
                    const resource = resources.find((item) => item.id === id)
                    if (!resource) return []
                    if (resource.type === 'Subject') {
                      return (resource.childResourceIds ?? [])
                        .map((childId) => resources.find((item) => item.id === childId))
                        .filter((item): item is ProjectResource => Boolean(item))
                    }
                    return [resource]
                  })
                  const expanded = expand(boundIds)
                  const imagesList = directorSettings.save.writeImages
                    ? expanded
                        .filter((item) => item.type === 'Picture' && (item.imageFile || item.name))
                        .map((item) => ({
                          name: item.imageFile ?? item.name,
                          subfolder: item.subfolder,
                          sourceType: (item.sharedRoot === 'output' ? 'output' : 'input') as 'input' | 'output',
                        }))
                    : undefined
                  const audioItems = directorSettings.save.targets.audio
                    ? expanded
                        .filter((item) => item.type === 'Audio' && (item.audioFile || item.name))
                        .map((item) => ({
                          name: item.audioFile ?? item.name,
                          subfolder: item.subfolder,
                          sourceType: (item.sharedRoot === 'output' ? 'output' : 'input') as 'input' | 'output',
                          trackRole: item.trackRole ?? 'voice',
                          trackName: directorSettings.audio.roleTracks[item.trackRole ?? 'voice'],
                          volumeDb: directorSettings.audio.defaultDb[item.trackRole ?? 'voice'] ?? 0,
                        }))
                    : []
                  const videoItems = directorSettings.save.targets.video
                    ? expanded
                        .filter((item) => item.type === 'Video' && (item.videoFile || item.name))
                        .map((item) => ({
                          name: item.videoFile ?? item.name,
                          subfolder: item.subfolder,
                          sourceType: (item.sharedRoot === 'output' ? 'output' : 'input') as 'input' | 'output',
                        }))
                    : []
                  const subtitleEnabled = directorSettings.save.targets.subtitle && directorSettings.subtitle.enabled
                  const targetSegmentId = matchedTrackSegmentId
                  let written = false
                  if (!targetSegmentId) {
                    setError('该分镜脚本段尚未落地到任务轨；请先在「分镜编排」点「应用到任务轨」。')
                    return
                  }
                  // W4：一体化保存（任务段+音视频+字幕，单次提交 → 撤销单步）
                  if (targetSegmentId) {
                    const allRegistry = globalThis as unknown as {
                      __easyMediaApplyAll?: (
                        segmentId: string,
                        payload: Record<string, unknown>,
                      ) => boolean
                    }
                    if (allRegistry.__easyMediaApplyAll) {
                      try {
                        const segSettings = (activeScriptSegment as unknown as {
                          settings?: { taskType?: string; contextMode?: string; refImageSize?: string }
                        } | undefined)?.settings
                        const planSettingsNow = (readWorkspace(bindingProjectKey).plan as {
                          settings?: { taskType?: string; contextMode?: string; refImageSize?: string }
                        } | null)?.settings
                        const mappedTask = taskTemplateOf(taskTypeOfCurrentSegment())
                        written = allRegistry.__easyMediaApplyAll(targetSegmentId, {
                          prompt: target,
                          variant: previewVariant,
                          // 任务模式/衔接/参考图：段级 > 脚本级（与分镜编排的优先级一致）
                          taskMode: mappedTask.task_mode,
                          continuityMode: segSettings?.contextMode || planSettingsNow?.contextMode || undefined,
                          refImageSize: segSettings?.refImageSize || planSettingsNow?.refImageSize || undefined,
                          images: imagesList,
                          audio: audioItems,
                          video: videoItems,
                          subtitleEnabled,
                          subtitleVariant: previewVariant,
                        })
                      } catch (error) {
                        console.error('[EasyMedia] apply all failed', error)
                      }
                    }
                  }
                  // 回退：旧两步路径
                  if (!written && targetSegmentId) {
                    const legacy = globalThis as unknown as {
                      __easyMediaSaveTracks?: (segmentId: string, payload: Record<string, unknown>) => boolean
                      __easyMediaUpdateSegment?: (segmentId: string, payload: Record<string, unknown>) => boolean
                    }
                    if (legacy.__easyMediaSaveTracks && (audioItems.length > 0 || videoItems.length > 0 || subtitleEnabled)) {
                      try {
                        legacy.__easyMediaSaveTracks(targetSegmentId, { audio: audioItems, video: videoItems, subtitleEnabled, subtitleVariant: previewVariant })
                      } catch (error) {
                        console.error('[EasyMedia] save tracks failed', error)
                      }
                    }
                    if (legacy.__easyMediaUpdateSegment) {
                      try {
                        written = legacy.__easyMediaUpdateSegment(targetSegmentId, { prompt: target, variant: previewVariant, images: imagesList })
                      } catch (error) {
                        console.error('[EasyMedia] update segment failed', error)
                      }
                    }
                  }
                  if (!written) onApply(target, brief, globalDraft)
                }}
                disabled={!(finalDraft || finalPrompt) || failures.length > 0 || scriptSegments.length === 0}
              >
                写入任务轨（{previewVariant === 'a' ? 'A' : 'B'}）
              </Button>
            </div>
          </>
        )}
      </div>
      <DirectorSettingsModal
        open={settingsOpen}
        settings={directorSettings}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          setDirectorSettings(next)
          writeDirectorSettings(settingsProject, next)
        }}
      />
    </div>,
    document.body,
  )
}
