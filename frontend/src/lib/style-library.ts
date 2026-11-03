/** 视觉风格：配色 + 导演方法（只读适配本机 T8 资源；无则自建兜底）。 */

export type StyleKind = 'color' | 'creator'
export type StyleMode = 'off' | 'on' | 'experimental'
export type StyleScope = 'color_only' | 'color_and_light'

export interface StyleOption {
  id: string
  label_zh: string
  label_en: string
  category: string
  source: string
  summary_zh?: string
}

export interface StyleState {
  mode: StyleMode
  scope: StyleScope
  color: string
  creator: string
  colorName?: string
  creatorName?: string
  /** 最近一次编译出来的指令块（生成时直接附给后端） */
  instruction?: string
  source?: string
}

const KEY = (project: string) => `easy-media-style:${project}`

export const EMPTY_STYLE: StyleState = {
  mode: 'off',
  scope: 'color_only',
  color: '',
  creator: '',
}

export function readStyle(project: string): StyleState {
  if (!project) return { ...EMPTY_STYLE }
  try {
    const raw = localStorage.getItem(KEY(project))
    if (!raw) return { ...EMPTY_STYLE }
    const parsed = JSON.parse(raw) as Partial<StyleState>
    return {
      mode: (parsed.mode === 'on' || parsed.mode === 'experimental' ? parsed.mode : 'off') as StyleMode,
      scope: (parsed.scope === 'color_and_light' ? 'color_and_light' : 'color_only') as StyleScope,
      color: String(parsed.color ?? ''),
      creator: String(parsed.creator ?? ''),
      colorName: parsed.colorName ? String(parsed.colorName) : undefined,
      creatorName: parsed.creatorName ? String(parsed.creatorName) : undefined,
      instruction: parsed.instruction ? String(parsed.instruction) : undefined,
      source: parsed.source ? String(parsed.source) : undefined,
    }
  } catch {
    return { ...EMPTY_STYLE }
  }
}

export function writeStyle(project: string, next: StyleState): void {
  if (!project) return
  try {
    localStorage.setItem(KEY(project), JSON.stringify(next))
  } catch {
    /* 忽略存储失败 */
  }
}

export function isStyleActive(state: StyleState): boolean {
  return state.mode !== 'off' && Boolean(state.color || state.creator)
}

export function styleSummary(state: StyleState): string {
  if (!isStyleActive(state)) return '未启用'
  const parts: string[] = []
  if (state.colorName) parts.push(`配色 ${state.colorName}`)
  if (state.creatorName) parts.push(`导演 ${state.creatorName}`)
  if (!parts.length) parts.push('已选择风格')
  const scopeText = state.scope === 'color_and_light' ? '色彩+光影' : '仅色彩'
  return `${parts.join(' · ')}（${scopeText}）`
}

export async function fetchStyleList(kind: StyleKind, query = '', limit = 200): Promise<{
  items: StyleOption[]
  source: string
  total: number
}> {
  const params = new URLSearchParams({ kind, limit: String(limit) })
  if (query) params.set('q', query)
  const response = await fetch(`/easy-media/styles?${params.toString()}`)
  if (!response.ok) throw new Error(`风格列表读取失败（${response.status}）`)
  const data = await response.json() as { items?: StyleOption[]; source?: string; total?: number }
  return {
    items: Array.isArray(data.items) ? data.items : [],
    source: String(data.source ?? 'unknown'),
    total: Number(data.total ?? 0),
  }
}

export async function fetchStylePreview(state: StyleState): Promise<{
  instruction: string
  colorName?: string
  creatorName?: string
  source?: string
}> {
  const params = new URLSearchParams({
    color: state.color || '',
    creator: state.creator || '',
    scope: state.scope,
    mode: state.mode,
  })
  const response = await fetch(`/easy-media/styles/preview?${params.toString()}`)
  const data = await response.json() as {
    ok?: boolean
    error?: string
    instruction?: string
    color?: { name?: string } | null
    creator?: { name?: string } | null
    source?: string
  }
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error ?? `风格编译失败（${response.status}）`))
  }
  return {
    instruction: String(data.instruction ?? ''),
    colorName: data.color?.name,
    creatorName: data.creator?.name,
    source: data.source,
  }
}

/** 选中后重新编译并落盘，返回最新状态。 */
export async function applyStyle(project: string, next: StyleState): Promise<StyleState> {
  if (!isStyleActive(next)) {
    const cleared: StyleState = { ...next, mode: 'off', instruction: '' }
    writeStyle(project, cleared)
    return cleared
  }
  const preview = await fetchStylePreview(next)
  const updated: StyleState = {
    ...next,
    colorName: preview.colorName ?? next.colorName,
    creatorName: preview.creatorName ?? next.creatorName,
    instruction: preview.instruction,
    source: preview.source,
  }
  writeStyle(project, updated)
  return updated
}
