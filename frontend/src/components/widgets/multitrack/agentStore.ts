/** 工作台会话存储：AI 助手与各页签共享（按项目隔离）。 */

export type AgentStepStatus = 'running' | 'done' | 'failed'

export interface AgentStep {
  label: string
  status: AgentStepStatus
}

export interface AgentMessage {
  /** D-P1：工具调用轨迹（name/args/result/status） */
  toolCalls?: Array<{
    id: string
    name: string
    args?: unknown
    result?: string
    status?: 'running' | 'success' | 'error'
  }>
  /** D-P1：需要用户点选的提问（ask_user 工具） */
  question?: {
    id: string
    text: string
    options: string[]
    answer?: string
  }
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

export type ResourceType = 'Subject' | 'Picture' | 'Video' | 'Audio'
export type ResourceStatus = 'need' | 'generating' | 'ready' | 'failed'

export interface ProjectResource {
  id: string
  type: ResourceType
  name: string
  /** 仅 Subject：人物/物体/场景（自由文本，与旧主体库 type 对齐） */
  subjectKind?: string
  relationship: string
  description: string
  retention: string[]
  status: ResourceStatus
  imageFile?: string
  videoFile?: string
  audioFile?: string
  /** 仅 Subject：引用的图片/视频/音频资源 id */
  childResourceIds?: string[]
  source: 'shared' | 'generated' | 'manual'
  sharedPath?: string
  subfolder?: string
  sharedRoot?: 'input' | 'output' | 'temp'
  /** 仅 Audio：落轨角色 voice/lipsync/sfx/bgm/reference（决定保存到哪条音频轨） */
  trackRole?: string
  generator?: { workflow?: string; brief?: string; seed?: number }
  createdAt: number
  updatedAt: number
}

export function resourceUid(prefix = 'res'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function defaultRelationship(type: ResourceType): string {
  return type === 'Audio' ? 'reference' : 'fully_preserved'
}

export function relationshipOptions(type: ResourceType): Array<{ value: string; label: string }> {
  if (type === 'Audio') {
    return [
      { value: 'fully_copy', label: 'fully copy（整体照搬音轨）' },
      { value: 'partially_copy', label: 'partially copy（部分复制/增删）' },
      { value: 'reference', label: 'reference（只引音色/节奏）' },
      { value: 'weak_reference', label: 'weak reference（仅氛围相似）' },
    ]
  }
  return [
    { value: 'fully_preserved', label: 'fully preserved（完整保留）' },
    { value: 'partially_preserved', label: 'partially preserved（部分保留）' },
    { value: 'attribute_transfer', label: 'attribute transfer（特征转移）' },
    { value: 'weak_reference', label: 'weak reference（仅弱参考）' },
  ]
}

export function kindToType(kind: string): ResourceType {
  if (kind === 'audio') return 'Audio'
  if (kind === 'video') return 'Video'
  return 'Picture'
}

export function typeToKind(type: ResourceType): 'image' | 'audio' | 'video' {
  if (type === 'Audio') return 'audio'
  if (type === 'Video') return 'video'
  return 'image'
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
  resources?: ProjectResource[]
  /** ④ 提示词增强的引用绑定：键 `${segmentId}:${variant}` -> 资源 id 列表 */
  bindings?: Record<string, string[]>
  /** 智能体执行清单：计划 → 执行 → 勾选 */
  todos?: Array<{ text: string; status: string }>
  /** 项目长期记忆（key → value），注入助手上下文 */
  notes?: Record<string, string>
  /** 断点续跑：上一轮工具循环的完整消息（含 tool_calls/tool 结果） */
  agentRun?: Array<Record<string, unknown>>
  /** 运行中插话：排队等待注入的用户消息 */
  pendingInject?: string
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
  if ('resources' in patch) mirror(`easy-media-project-resources:${key}`, patch.resources)
  if ('bindings' in patch) mirror(`easy-media-bindings:${key}`, patch.bindings)
  if ('messages' in patch) {
    // 对话历史持久化：跟随项目键；只保留最近 200 条，且单条 text/thinking/gen 截断到 20000 字符
    try {
      const capped = (patch.messages ?? []).slice(-200).map((message) => ({
        ...message,
        text: message.text.length > 20000 ? message.text.slice(0, 20000) : message.text,
        thinking: message.thinking && message.thinking.length > 20000 ? message.thinking.slice(0, 20000) : message.thinking,
        gen: message.gen && message.gen.length > 20000 ? message.gen.slice(0, 20000) : message.gen,
      }))
      window.localStorage.setItem(`easy-media-messages:${key}`, JSON.stringify(capped))
    } catch {
      /* 超出配额时静默放弃镜像 */
    }
  }
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
  if (!('messages' in next)) {
    try {
      const raw = window.localStorage.getItem(`easy-media-messages:${key}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          // 上次运行被刷新/关闭打断的消息：running -> stopped，避免永远显示“运行中”
          next.messages = parsed.map((message) => (
            message && message.status === 'running'
              ? { ...message, status: 'stopped', text: message.text || '（上次运行被中断）' }
              : message
          ))
          changed = true
        }
      }
    } catch {
      /* 忽略坏数据 */
    }
  }
  if (!('bindings' in next)) {
    try {
      const raw = window.localStorage.getItem(`easy-media-bindings:${key}`)
      if (raw) {
        next.bindings = JSON.parse(raw)
        changed = true
      }
    } catch {
      /* 忽略坏数据 */
    }
  }
  if (!('resources' in next)) {
    try {
      const raw = window.localStorage.getItem(`easy-media-project-resources:${key}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          next.resources = parsed
          changed = true
        }
      }
    } catch {
      /* 忽略坏数据 */
    }
  }
  // 一次性迁移：旧主体 / 旧资源需求 → 统一资源表
  if (!('resources' in next)) {
    const now = Date.now()
    const migrated: ProjectResource[] = []
    for (const raw of (next.subjects as Array<Record<string, unknown>> | undefined) ?? []) {
      migrated.push({
        id: String(raw.id ?? resourceUid('res-subject')),
        type: 'Subject',
        name: String(raw.name ?? ''),
        subjectKind: String(raw.type ?? '人物'),
        relationship: 'fully_preserved',
        description: String(raw.description ?? ''),
        retention: Array.isArray(raw.retention) ? (raw.retention as string[]) : [],
        status: 'ready',
        childResourceIds: [],
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const raw of (next.plannedResources as Array<{ kind: string; name: string; purpose?: string }> | undefined) ?? []) {
      const type = kindToType(String(raw.kind ?? 'image'))
      migrated.push({
        id: resourceUid('res-need'),
        type,
        name: String(raw.name ?? ''),
        relationship: defaultRelationship(type),
        description: String(raw.purpose ?? ''),
        retention: [],
        status: 'need',
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      })
    }
    if (migrated.length > 0) {
      next.resources = migrated
      changed = true
    }
  }
  if (changed) cache.set(key, next)
}

export function readResources(key: string): ProjectResource[] {
  return readWorkspace(key).resources ?? []
}

export function writeResources(key: string, resources: ProjectResource[]) {
  writeWorkspace(key, { resources })
}

export function upsertResource(key: string, resource: ProjectResource) {
  const current = readResources(key)
  const index = current.findIndex((item) => item.id === resource.id)
  const next = index >= 0
    ? current.map((item, i) => (i === index ? { ...item, ...resource, updatedAt: Date.now() } : item))
    : [...current, resource]
  writeResources(key, next)
}

export function patchResource(key: string, id: string, patch: Partial<ProjectResource>) {
  writeResources(
    key,
    readResources(key).map((item) => (item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item)),
  )
}

export function removeResource(key: string, id: string) {
  const current = readResources(key)
  writeResources(
    key,
    current
      .filter((item) => item.id !== id)
      .map((item) => (
        item.childResourceIds?.includes(id)
          ? { ...item, childResourceIds: item.childResourceIds.filter((child) => child !== id) }
          : item
      )),
  )
}

/** 从共享资源新建一条项目资源（图片/音频/视频） */
export function addResourceFromShared(
  key: string,
  item: { name: string; subfolder?: string; kind: 'image' | 'audio' | 'video'; root?: 'input' | 'output' | 'temp' },
  patch: Partial<ProjectResource> = {},
): ProjectResource {
  const type = kindToType(item.kind)
  const bare = item.name.replace(/\.[^.]+$/, '')
  const resource: ProjectResource = {
    id: resourceUid('res-shared'),
    type,
    name: patch.name ?? bare,
    relationship: patch.relationship ?? defaultRelationship(type),
    description: patch.description ?? '',
    retention: patch.retention ?? [],
    status: 'ready',
    source: 'shared',
    sharedRoot: item.root ?? 'input',
    sharedPath: item.subfolder ? `${item.subfolder}/${item.name}` : item.name,
    subfolder: item.subfolder,
    imageFile: type === 'Picture' ? item.name : undefined,
    audioFile: type === 'Audio' ? item.name : undefined,
    videoFile: type === 'Video' ? item.name : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  }
  upsertResource(key, resource)
  return resource
}

/** 把共享资源文件绑定到一条已存在的项目资源（缺件补齐） */
export function bindResourceFile(
  key: string,
  resourceId: string,
  item: { name: string; subfolder?: string; kind: 'image' | 'audio' | 'video'; root?: 'input' | 'output' | 'temp' },
) {
  const resource = readResources(key).find((entry) => entry.id === resourceId)
  if (!resource) return
  const subfolder = item.subfolder ?? ''
  patchResource(key, resourceId, {
    status: 'ready',
    source: 'shared',
    sharedRoot: item.root ?? 'input',
    sharedPath: subfolder ? `${subfolder}/${item.name}` : item.name,
    subfolder,
    imageFile: resource.type === 'Picture' ? item.name : undefined,
    videoFile: resource.type === 'Video' ? item.name : undefined,
    audioFile: resource.type === 'Audio' ? item.name : undefined,
  })
}

/** 解绑共享文件：回到缺件状态 */
export function unbindResourceFile(key: string, resourceId: string) {
  patchResource(key, resourceId, {
    status: 'need',
    sharedRoot: undefined,
    sharedPath: undefined,
    subfolder: undefined,
    imageFile: undefined,
    videoFile: undefined,
    audioFile: undefined,
  })
}

/** 读取某个 段:变体 的绑定资源 id */
export function readBindings(key: string, bindingKey: string): string[] {
  return readWorkspace(key).bindings?.[bindingKey] ?? []
}

/** 写入某个 段:变体 的绑定资源 id */
export function writeBindings(key: string, bindingKey: string, ids: string[]) {
  const current = readWorkspace(key).bindings ?? {}
  writeWorkspace(key, { bindings: { ...current, [bindingKey]: ids } })
}

/** 主体挂/卸子资源 */
export function setSubjectChildren(key: string, subjectId: string, childIds: string[]) {
  patchResource(key, subjectId, { childResourceIds: childIds })
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
