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
}

const cache = new Map<string, WorkspaceCache>()
const listeners = new Map<string, Set<() => void>>()

export function readWorkspace(key: string): WorkspaceCache {
  return cache.get(key) ?? {}
}

export function writeWorkspace(key: string, patch: Partial<WorkspaceCache>) {
  cache.set(key, { ...readWorkspace(key), ...patch })
  for (const listener of listeners.get(key) ?? []) listener()
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
