/** 工作台会话存储：AI 助手与各页签共享（按项目隔离）。 */

export type AgentStepStatus = 'running' | 'done' | 'failed'

export interface AgentStep {
  label: string
  status: AgentStepStatus
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  thinking?: string
  gen?: string
  steps?: AgentStep[]
  status?: 'running' | 'done' | 'failed'
  elapsedMs?: number
  planResult?: { segments: number; seconds: number }
}

export interface StoryboardPlanLike {
  title?: string
  logline?: string
  total_seconds: number
  total_frames?: number
  segments: Array<{
    index?: number
    name: string
    beat?: string
    duration_seconds?: number
    duration_frames: number
    summary?: string
    shots?: unknown[]
    subjects?: unknown[]
    resources?: unknown[]
    [key: string]: unknown
  }>
  [key: string]: unknown
}

export interface WorkspaceCache {
  plan?: StoryboardPlanLike | null
  messages?: AgentMessage[]
  agentBusy?: boolean
  durationSeconds?: number
  ratio?: string
  style?: string
  chatInput?: string
  tab?: string
  subjects?: unknown[]
  plannedResources?: Array<{ kind: string; name: string; purpose?: string }>
}

const cache = new Map<string, WorkspaceCache>()
const listeners = new Map<string, Set<() => void>>()

export function readWorkspace(key: string): WorkspaceCache {
  return cache.get(key) ?? {}
}

const DRAFT_KEY = 'easy-media-storyboard'

export function writeWorkspace(key: string, patch: Partial<WorkspaceCache>) {
  cache.set(key, { ...readWorkspace(key), ...patch })
  // 分镜/主体/资源需求变更自动镜像到 localStorage：刷新浏览器不丢
  const mirror = (lsKey: string, value: unknown) => {
    try {
      if (value) window.localStorage.setItem(lsKey, JSON.stringify(value))
      else window.localStorage.removeItem(lsKey)
    } catch {
      /* 存储失败不阻断 */
    }
  }
  if ('plan' in patch) mirror(`${DRAFT_KEY}:${key}`, patch.plan)
  if ('subjects' in patch) mirror(`easy-media-workspace-subjects:${key}`, patch.subjects)
  if ('plannedResources' in patch) mirror(`easy-media-workspace-resources:${key}`, patch.plannedResources)
  for (const listener of listeners.get(key) ?? []) listener()
}

/** 挂载时若内存无 plan，从 localStorage 恢复分镜草稿。 */
export function ensureHydrated(key: string) {
  const current = cache.get(key) ?? {}
  let changed = false
  const next: WorkspaceCache = { ...current }
  if (!('plan' in next)) {
    try {
      const raw = window.localStorage.getItem(`${DRAFT_KEY}:${key}`)
      const plan = raw ? JSON.parse(raw) : null
      if (plan && Array.isArray(plan.segments)) {
        next.plan = plan
        changed = true
      }
    } catch {
      /* 忽略坏草稿 */
    }
  }
  if (!('subjects' in next)) {
    try {
      const raw = window.localStorage.getItem(`easy-media-workspace-subjects:${key}`)
      if (raw) {
        next.subjects = JSON.parse(raw)
        changed = true
      }
    } catch {
      /* 忽略坏数据 */
    }
  }
  if (!('plannedResources' in next)) {
    try {
      const raw = window.localStorage.getItem(`easy-media-workspace-resources:${key}`)
      if (raw) {
        next.plannedResources = JSON.parse(raw)
        changed = true
      }
    } catch {
      /* 忽略坏数据 */
    }
  }
  if (changed) cache.set(key, next)
}

export function subscribeWorkspace(key: string, listener: () => void) {
  const set = listeners.get(key) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
  }
}

export function patchWorkspaceMessages(key: string, fn: (current: AgentMessage[]) => AgentMessage[]) {
  const current = readWorkspace(key).messages ?? []
  writeWorkspace(key, { messages: fn(current) })
}


export type PlanSegment = StoryboardPlanLike['segments'][number]

function recomputePlan(plan: StoryboardPlanLike, segments: PlanSegment[], fps: number): StoryboardPlanLike {
  let frames = 0
  let seconds = 0
  segments.forEach((segment, index) => {
    segment.index = index + 1
    const duration = Number(segment.duration_seconds) || 0
    segment.duration_frames = Math.round(duration * fps)
    frames += segment.duration_frames
    seconds += duration
  })
  return { ...plan, segments, total_seconds: Number(seconds.toFixed(2)), total_frames: frames }
}

/** 对分镜段列表做变更（增删改/排序），自动重算序号、帧数与总时长。 */
export function mutatePlanSegments(
  key: string,
  fps: number,
  fn: (segments: PlanSegment[]) => PlanSegment[],
) {
  const plan = readWorkspace(key).plan
  if (!plan) return
  try {
    const next = fn(plan.segments.map((segment) => ({ ...segment })))
    writeWorkspace(key, { plan: recomputePlan(plan, next, fps) })
  } catch (error) {
    console.warn('[EasyMedia] mutate plan failed', error)
  }
}

/** 手动新建一个空分镜（单段占位，可继续增删改）。 */
export function createEmptyPlan(key: string, fps: number) {
  const segment: PlanSegment = {
    index: 1,
    name: '未命名镜头',
    beat: '',
    duration_seconds: 4,
    duration_frames: Math.round(4 * fps),
    summary: '',
    shots: [],
    subjects: [],
    resources: [],
  }
  writeWorkspace(key, {
    plan: recomputePlan(
      { title: '未命名分镜', logline: '', tone: '', rhythm: '', total_seconds: 4, total_frames: Math.round(4 * fps), segments: [segment] },
      [segment],
      fps,
    ),
  })
}
