import type { TrackData } from '@/types/multitrack'

/**
 * 项目时间线（多轨编辑器轨道数据）的前端客户端。
 *
 * 与后端 `utils/h3_timeline.py` 对应：
 *   GET    /easy-media/project/timeline?project_name=  读取时间线
 *   PUT    /easy-media/project/timeline               保存（可带 base_updated_at 做并发校验）
 *   POST   /easy-media/project/timeline/new           新建
 *   DELETE /easy-media/project/timeline?project_name= 只删时间线
 *   GET    /easy-media/project/timelines              项目 + 时间线摘要
 */

export interface TimelineProjectSummary {
  project_name: string
  has_timeline: boolean
  updated_at: number
  tracks: number
  segments: number
  prompt_segments: number
  duration_seconds: number
  video_count: number
  error?: string | null
}

export interface TimelineResolutionSnapshot {
  preset?: string
  width?: number
  height?: number
  aspect_ratio?: string
  megapixels?: number
}

export interface ProjectTimelineDocument {
  version: number
  project_name: string
  updated_at: number
  resolution?: TimelineResolutionSnapshot | null
  format?: string | null
  track_data: TrackData
  meta?: Record<string, unknown>
  gen_settings_snapshot?: Record<string, unknown> | null
}

export interface SaveTimelineResult {
  project_name: string
  updated_at: number
  path: string
  bytes: number
}

export class TimelineConflictError extends Error {
  readonly updatedAt: number

  constructor(message: string, updatedAt: number) {
    super(message)
    this.name = 'TimelineConflictError'
    this.updatedAt = updatedAt
  }
}

interface EasyMediaApi {
  api?: {
    fetchApi?: (path: string, options?: RequestInit) => Promise<Response>
  }
}

async function request(
  app: unknown,
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const fetchApi = (app as EasyMediaApi | undefined)?.api?.fetchApi
  if (typeof fetchApi !== 'function') throw new Error('app.api.fetchApi is unavailable')
  const response = await fetchApi(path, options)
  let payload: Record<string, unknown> = {}
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return { status: response.status, payload }
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
  const message = payload.error
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/** 客户端粗校验：非空、不含路径分隔符（真正净化在后端完成）。 */
export function validateProjectName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'invalid'
  if (trimmed === '.' || trimmed === '..') return 'invalid'
  if (trimmed.length > 120) return 'too_long'
  return null
}

export async function listTimelineProjects(app: unknown): Promise<TimelineProjectSummary[]> {
  const { status, payload } = await request(app, '/easy-media/project/timelines')
  if (status !== 200) throw new Error(errorMessage(payload, 'Failed to list timeline projects'))
  const projects = payload.projects
  if (!Array.isArray(projects)) return []
  return projects.filter((item): item is TimelineProjectSummary => (
    !!item && typeof item === 'object' && typeof (item as TimelineProjectSummary).project_name === 'string'
  ))
}

export async function loadProjectTimeline(app: unknown, projectName: string): Promise<ProjectTimelineDocument> {
  const query = encodeURIComponent(projectName)
  const { status, payload } = await request(app, `/easy-media/project/timeline?project_name=${query}`)
  if (status === 404) throw new Error('not_found')
  if (status !== 200) throw new Error(errorMessage(payload, 'Failed to load timeline'))
  return payload as unknown as ProjectTimelineDocument
}

export async function saveProjectTimeline(
  app: unknown,
  payload: {
    projectName: string
    trackData: TrackData
    resolution?: TimelineResolutionSnapshot | null
    format?: string | null
    baseUpdatedAt?: number | null
  },
): Promise<SaveTimelineResult> {
  const body: Record<string, unknown> = {
    project_name: payload.projectName,
    timeline: {
      version: 1,
      resolution: payload.resolution ?? null,
      format: payload.format ?? null,
      track_data: payload.trackData,
    },
  }
  if (typeof payload.baseUpdatedAt === 'number' && Number.isFinite(payload.baseUpdatedAt)) {
    body.base_updated_at = payload.baseUpdatedAt
  }
  const { status, payload: response } = await request(app, '/easy-media/project/timeline', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (status === 409) {
    const updatedAt = typeof response.updated_at === 'number' ? response.updated_at : 0
    throw new TimelineConflictError(errorMessage(response, 'Timeline conflict'), updatedAt)
  }
  if (status !== 200) throw new Error(errorMessage(response, 'Failed to save timeline'))
  return response as unknown as SaveTimelineResult
}

export async function createProjectTimeline(
  app: unknown,
  projectName: string,
  template?: TrackData | null,
): Promise<ProjectTimelineDocument> {
  const body: Record<string, unknown> = { project_name: projectName }
  if (template) body.template = { track_data: template }
  const { status, payload } = await request(app, '/easy-media/project/timeline/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (status === 409) throw new Error('exists')
  if (status !== 201) throw new Error(errorMessage(payload, 'Failed to create timeline'))
  return payload as unknown as ProjectTimelineDocument
}

export async function deleteProjectTimeline(app: unknown, projectName: string): Promise<boolean> {
  const query = encodeURIComponent(projectName)
  const { status, payload } = await request(app, `/easy-media/project/timeline?project_name=${query}`, {
    method: 'DELETE',
  })
  if (status !== 200) throw new Error(errorMessage(payload, 'Failed to delete timeline'))
  return payload.deleted === true
}

/** 去掉挂在 track_data 上的项目标记，用于比较“内容是否变化”。 */
export function stripProjectMeta(trackData: TrackData): TrackData {
  const { project: _project, ...rest } = trackData as TrackData & { project?: unknown }
  return rest as TrackData
}

/** 内容指纹：忽略 project 字段，用于未保存改动检测。 */
export function timelineSignature(trackData: TrackData): string {
  try {
    return JSON.stringify(stripProjectMeta(trackData))
  } catch {
    return ''
  }
}
