import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MultiTrackPreviewResolutionInput } from '@/lib/multitrack-utils'
import { createDefaultTrackData } from '@/lib/multitrack-utils'
import type { ProjectKind, TrackData } from '@/types/multitrack'
import {
  TimelineConflictError,
  createProjectTimeline,
  deleteProjectTimeline,
  listTimelineProjects,
  loadProjectTimeline,
  saveProjectTimeline,
  stripProjectMeta,
  timelineSignature,
  validateProjectName,
  type TimelineProjectSummary,
  type TimelineResolutionSnapshot,
} from '@/lib/project-timeline'

interface ProjectBarProps {
  app: unknown
  t: (path: string, params?: Record<string, string | number>) => string
  data: TrackData
  resolution: MultiTrackPreviewResolutionInput
  /** 载入/新建/删除后由编辑器统一写回（走撤销栈与节点值更新）。 */
  onApply: (
    trackData: TrackData,
    meta: { name: string; updated_at: number; kind?: ProjectKind } | null,
    snapshot?: { format?: string | null; resolution?: TimelineResolutionSnapshot | null } | null,
  ) => void
}

const PROJECT_KIND_OPTIONS: Array<{ value: ProjectKind; label: string }> = [
  { value: 'video', label: '视频项目' },
  { value: 'audio', label: '音频项目' },
  { value: 'image', label: '图片项目' },
]

const MP_PRESET: TimelineResolutionSnapshot = {
  preset: 'width x height (megapixels)',
  aspect_ratio: '9:16 (Portrait Widescreen)',
  megapixels: 1.0,
}
const IMAGE_PRESET: TimelineResolutionSnapshot = {
  preset: 'width x height (megapixels)',
  aspect_ratio: '9:16 (Portrait Widescreen)',
  megapixels: 2.0,
}
const AUDIO_PRESET: TimelineResolutionSnapshot = {
  preset: 'width x height (custom)',
  width: 64,
  height: 64,
}

/** 新建项目时的画布预设：音频 64×64，视频/图片 MP 9:16 1.0。 */
const PROJECT_KIND_RESOLUTION: Record<ProjectKind, TimelineResolutionSnapshot | null> = {
  video: MP_PRESET,
  image: IMAGE_PRESET,
  audio: AUDIO_PRESET,
}


type EditingState = { mode: 'new' | 'saveAs'; value: string } | null

/**
 * 项目签名 = 轨道数据 + 分辨率/格式快照。
 * 分辨率是节点 widget 而非轨道数据，只按轨道算签名会让「只改画幅」不算未保存改动，
 * 自动保存与切项目提示都不触发 → 快照永远停在旧值。
 */
function projectSignature(trackData: TrackData, snapshot?: TimelineResolutionSnapshot | null): string {
  return timelineSignature(trackData) + '|' + JSON.stringify(snapshot ?? {})
}

const BUTTON_CLASS = 'h-7 rounded border border-neutral-600 bg-neutral-800 px-2 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40'
const PRIMARY_CLASS = 'h-7 rounded border border-sky-600 bg-sky-700 px-2 text-xs text-white hover:bg-sky-600 disabled:opacity-40'

/** 防抖自动保存：停止编辑多久后写盘（毫秒）。 */
const AUTOSAVE_DEBOUNCE_MS = 2500
/** 自动保存失败后的重试延迟（毫秒）。 */
const AUTOSAVE_RETRY_DELAY_MS = 2000

interface DialogApi {
  confirm?: (options: { title?: string; message?: string }) => Promise<boolean>
}

interface ToastApi {
  add?: (options: { severity?: string; summary?: string; detail?: string; life?: number }) => void
}

function extensionDialog(app: unknown): DialogApi | undefined {
  return (app as { extensionManager?: { dialog?: DialogApi } } | undefined)?.extensionManager?.dialog
}

function extensionToast(app: unknown): ToastApi | undefined {
  return (app as { extensionManager?: { toast?: ToastApi } } | undefined)?.extensionManager?.toast
}

function resolutionSnapshot(input: MultiTrackPreviewResolutionInput): TimelineResolutionSnapshot {
  const snapshot: TimelineResolutionSnapshot = {}
  if (typeof input.resolution === 'string') snapshot.preset = input.resolution
  if (typeof input.width === 'number') snapshot.width = input.width
  if (typeof input.height === 'number') snapshot.height = input.height
  if (typeof input.aspect_ratio === 'string') snapshot.aspect_ratio = input.aspect_ratio
  if (typeof input.megapixels === 'number') snapshot.megapixels = input.megapixels
  if (typeof input.resize_method === 'string') snapshot.resize_method = input.resize_method
  if (typeof input.resize_to_pixel === 'number') snapshot.resize_to_pixel = input.resize_to_pixel
  return snapshot
}

export function ProjectBar({ app, t, data, resolution, onApply }: Readonly<ProjectBarProps>) {
  const currentName = typeof data.project?.name === 'string' ? data.project.name : ''
  const [projects, setProjects] = useState<TimelineProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<EditingState>(null)
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [pendingNew, setPendingNew] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [newKind, setNewKind] = useState<ProjectKind>('video')
  const currentKind: ProjectKind = data.project?.kind ?? 'video'
  const createProjectRef = useRef<(name: string) => Promise<boolean>>(async () => false)
  createProjectRef.current = createProjectByName
  const switchProjectRef = useRef<(name: string) => Promise<void>>(async () => {})
  switchProjectRef.current = handleSelect
  const projectListRef = useRef<string[]>([])
  projectListRef.current = projects.filter((item) => item.has_timeline).map((item) => item.project_name)
  const nameRef = useRef('')
  // registry 里的快照提供器通过 ref 取最新值，避免 useEffect([]) 闭包拿到首次渲染的 resolution
  const resolutionSnapshotRef = useRef<() => TimelineResolutionSnapshot>(() => ({}))
  resolutionSnapshotRef.current = () => resolutionSnapshot(resolution)
  const formatRef = useRef<string | null>(null)
  formatRef.current = resolution.format ?? null
  nameRef.current = currentName
  useEffect(() => {
    const registry = globalThis as unknown as {
      __easyMediaCreateProject?: (name: string) => Promise<boolean>
      __easyMediaWorkspaceProject?: {
        name: string
        list: () => string[]
        switch: (name: string) => Promise<void>
        create: (name: string) => Promise<boolean>
      }
      /** 当前分辨率/格式快照：供 AI 助手 save_project 一并写盘（PUT 是整体覆盖，缺字段会抹掉快照）。 */
      __easyMediaResolutionSnapshot?: () => {
        resolution: TimelineResolutionSnapshot
        format: string | null
      }
    }
    const handler = (name: string) => createProjectRef.current(name)
    const workspace = {
      get name() {
        return nameRef.current
      },
      list: () => [...projectListRef.current],
      switch: (name: string) => switchProjectRef.current(name),
      create: (name: string) => createProjectRef.current(name),
    }
    const snapshotProvider = () => ({
      resolution: resolutionSnapshotRef.current(),
      format: formatRef.current,
    })
    registry.__easyMediaCreateProject = handler
    registry.__easyMediaWorkspaceProject = workspace
    registry.__easyMediaResolutionSnapshot = snapshotProvider
    return () => {
      if (registry.__easyMediaCreateProject === handler) delete registry.__easyMediaCreateProject
      if (registry.__easyMediaWorkspaceProject === workspace) delete registry.__easyMediaWorkspaceProject
      if (registry.__easyMediaResolutionSnapshot === snapshotProvider) delete registry.__easyMediaResolutionSnapshot
    }
  }, [])
  // 导演工作台读取当前项目名（避免跨层传参）
  useEffect(() => {
    const registry = globalThis as unknown as { __easyMediaProjectName?: string }
    registry.__easyMediaProjectName = currentName
  }, [currentName])
  const savedSignatureRef = useRef<string | null>(null)
  const lastLoadedAtRef = useRef<number | null>(null)
  // 自动保存：idle=待命 / saving=写盘中 / blocked=有冲突（停止自动保存） / error=失败
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'blocked' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const autoSaveBlockedRef = useRef(false)

  const currentSignature = useMemo(
    () => projectSignature(data, resolutionSnapshot(resolution)),
    [data, resolution],
  )
  const dirty = currentName !== '' && savedSignatureRef.current !== null
    && savedSignatureRef.current !== currentSignature

  useEffect(() => {
    savedSignatureRef.current = currentName ? currentSignature : null
    lastLoadedAtRef.current = typeof data.project?.updated_at === 'number' ? data.project.updated_at : null
    // 仅在项目名变化时重置基线，避免用户编辑过程中基线被刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentName])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listTimelineProjects(app))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('multitrack.projectFailed'))
    }
  }, [app, t])

  /** 磁盘上的当前项目比内存里的新（外部补了轨道/其它窗口保存过）且本地无改动时，自动重载。 */
  const syncCurrentProjectFromDisk = useCallback(async () => {
    if (!currentName || dirty) return
    try {
      const rows = await listTimelineProjects(app)
      const row = rows.find((item) => item.project_name === currentName)
      // 与内存里“最近一次保存/载入”的 updated_at 比较；不能用 data.project.updated_at，
      // 因为自动保存为了不产生撤销记录，不会把它写回节点数据。
      const memoryUpdatedAt = typeof lastLoadedAtRef.current === 'number'
        ? lastLoadedAtRef.current
        : (typeof data.project?.updated_at === 'number' ? data.project.updated_at : 0)
      if (!row?.has_timeline || Math.abs((row.updated_at ?? 0) - memoryUpdatedAt) <= 1e-3) return
      const document_ = await loadProjectTimeline(app, currentName)
      const trackData = {
        ...document_.track_data,
        project: { name: document_.project_name, updated_at: document_.updated_at, kind: document_.project_kind ?? currentKind },
      }
      savedSignatureRef.current = projectSignature(trackData, document_.resolution ?? null)
      lastLoadedAtRef.current = document_.updated_at
      onApply(
        trackData,
        { name: document_.project_name, updated_at: document_.updated_at, kind: document_.project_kind ?? currentKind },
        { format: document_.format, resolution: document_.resolution ?? null },
      )
      setMessage(t('multitrack.projectReloaded', { project: currentName }))
    } catch {
      // 自动重载失败保持静默，由用户手动选择项目时再报错
    }
  }, [app, t, currentName, dirty, data, onApply])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  // Ctrl/Cmd+S：在 ComfyUI 保存工作流的同时，把当前项目的时间线写回 timeline.json。
  // 不拦截默认行为（工作流照常保存）；仅在已选项目且有未保存改动时触发。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 's') return
      if (busy || !currentName || !dirty) return
      void handleSave(currentName)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, currentName, dirty, data, resolution, app, t])

  // 防抖自动保存：仅在「已绑定项目 + 有未保存改动 + 不在忙」时，停止编辑 2.5 秒后写盘。
  useEffect(() => {
    if (!currentName || !dirty || busy || autoSaveBlockedRef.current) return
    const timer = window.setTimeout(() => {
      void runAutoSave(1)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentName, dirty, busy, data, resolution])

  async function runAutoSave(retriesLeft: number) {
    if (!currentName || autoSaveBlockedRef.current) return
    setAutoSaveState('saving')
    try {
      const result = await saveProjectTimeline(app, {
        projectName: currentName,
        trackData: stripProjectMeta(data),
        projectKind: currentKind,
        resolution: resolutionSnapshot(resolution),
        format: resolution.format ?? null,
        baseUpdatedAt: lastLoadedAtRef.current,
      })
      savedSignatureRef.current = projectSignature(
        {
          ...stripProjectMeta(data),
          project: { name: result.project_name, updated_at: result.updated_at },
        },
        resolutionSnapshot(resolution),
      )
      lastLoadedAtRef.current = result.updated_at
      setLastSavedAt(result.updated_at)
      setAutoSaveState('idle')
    } catch (error) {
      if (error instanceof TimelineConflictError) {
        // 别的窗口先保存过：绝不再覆盖，停下来让用户手动处理
        lastLoadedAtRef.current = error.updatedAt
        autoSaveBlockedRef.current = true
        setAutoSaveState('blocked')
        setMessage(t('multitrack.projectConflict'))
        return
      }
      if (retriesLeft > 0) {
        window.setTimeout(() => void runAutoSave(retriesLeft - 1), AUTOSAVE_RETRY_DELAY_MS)
        return
      }
      setAutoSaveState('error')
      setMessage(t('multitrack.projectAutoSaveFailed'))
    }
  }

  async function handleSelect(name: string) {
    if (name === currentName) return
    if (!name) {
      // 切回「默认（仅保存在工作流中）」：保留当前内容，只解除项目绑定
      if (dirty && pendingSwitch !== '__default__') {
        setPendingSwitch('__default__')
        setMessage(t('multitrack.projectConfirmSwitch'))
        return
      }
      setPendingSwitch(null)
      savedSignatureRef.current = null
      lastLoadedAtRef.current = null
      autoSaveBlockedRef.current = false
      setAutoSaveState('idle')
      setLastSavedAt(null)
      onApply(stripProjectMeta(data), null)
      setMessage(t('multitrack.projectUnbound'))
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const document_ = await loadProjectTimeline(app, name)
      const loadedTracks = Array.isArray(document_.track_data?.tracks) ? document_.track_data.tracks.length : 0
      const wouldClearEditor = loadedTracks === 0 && data.tracks.length > 0
      if ((dirty || wouldClearEditor) && pendingSwitch !== name) {
        // 有未保存改动，或「载入空时间线会清空编辑器」→ 都要二次确认
        setPendingSwitch(name)
        setMessage(t(wouldClearEditor ? 'multitrack.projectEmptyConfirm' : 'multitrack.projectConfirmSwitch'))
        return
      }
      setPendingSwitch(null)
      const trackData = { ...document_.track_data, project: { name: document_.project_name, updated_at: document_.updated_at, kind: document_.project_kind ?? currentKind } }
      savedSignatureRef.current = projectSignature(trackData, document_.resolution ?? null)
      lastLoadedAtRef.current = document_.updated_at
      autoSaveBlockedRef.current = false
      setAutoSaveState('idle')
      setLastSavedAt(document_.updated_at)
      onApply(trackData, { name: document_.project_name, updated_at: document_.updated_at, kind: document_.project_kind ?? currentKind }, { format: document_.format, resolution: document_.resolution ?? null })
      setMessage(t('multitrack.projectLoaded', { project: document_.project_name }))
    } catch (error) {
      const text = error instanceof Error ? error.message : ''
      setMessage(text === 'not_found' ? t('multitrack.projectNoTimeline') : (text || t('multitrack.projectFailed')))
    } finally {
      setBusy(false)
      // 选中即刷新：载入后同步刷新项目列表（时间戳/摘要/新增项目）
      void refreshProjects()
    }
  }

  async function handleSave(name?: string, force = false) {
    const target = (name ?? currentName).trim()
    const invalid = validateProjectName(target)
    if (invalid) {
      setMessage(invalid === 'too_long' ? t('multitrack.projectNameTooLong') : t('multitrack.projectNameInvalid'))
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const result = await saveProjectTimeline(app, {
        projectName: target,
        trackData: stripProjectMeta(data),
        projectKind: currentKind,
        resolution: resolutionSnapshot(resolution),
        format: resolution.format ?? null,
        baseUpdatedAt: force ? null : lastLoadedAtRef.current,
      })
      const trackData = { ...stripProjectMeta(data), project: { name: result.project_name, updated_at: result.updated_at, kind: currentKind } }
      savedSignatureRef.current = projectSignature(trackData, resolutionSnapshot(resolution))
      lastLoadedAtRef.current = result.updated_at
      autoSaveBlockedRef.current = false
      setAutoSaveState('idle')
      setLastSavedAt(result.updated_at)
      onApply(trackData, { name: result.project_name, updated_at: result.updated_at, kind: currentKind })
      setEditing(null)
      setMessage(t('multitrack.projectSaved', { project: result.project_name }))
      void refreshProjects()
    } catch (error) {
      if (error instanceof TimelineConflictError) {
        lastLoadedAtRef.current = error.updatedAt
        autoSaveBlockedRef.current = true
        setAutoSaveState('blocked')
        setMessage(t('multitrack.projectConflict'))
      } else {
        setMessage(error instanceof Error ? error.message : t('multitrack.projectFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function createProjectByName(name: string): Promise<boolean> {
    const invalid = validateProjectName(name)
    if (invalid) {
      setMessage(invalid === 'too_long' ? t('multitrack.projectNameTooLong') : t('multitrack.projectNameInvalid'))
      return false
    }
    setBusy(true)
    setMessage('')
    try {
      let document_ = await createProjectTimeline(app, name, createDefaultTrackData(), newKind)
      // 新建接口（POST /timeline/new）只接收 track_data，不写分辨率/格式；
      // 这里补一次 PUT，把当前分辨率/格式快照写进新项目，否则新项目快照永远是 null。
      const createdSnapshot = PROJECT_KIND_RESOLUTION[newKind] ?? resolutionSnapshot(resolution)
      try {
        const saved = await saveProjectTimeline(app, {
          projectName: document_.project_name,
          trackData: document_.track_data,
          projectKind: newKind,
          resolution: createdSnapshot,
          format: resolution.format ?? null,
          baseUpdatedAt: document_.updated_at,
        })
        document_ = {
          ...document_,
          updated_at: saved.updated_at,
          resolution: createdSnapshot,
          format: resolution.format ?? null,
        }
      } catch {
        // 补写失败不阻塞新建
      }
      const trackData = { ...document_.track_data, project: { name: document_.project_name, updated_at: document_.updated_at, kind: document_.project_kind ?? currentKind } }
      savedSignatureRef.current = projectSignature(trackData, document_.resolution ?? null)
      lastLoadedAtRef.current = document_.updated_at
      onApply(trackData, { name: document_.project_name, updated_at: document_.updated_at, kind: document_.project_kind ?? currentKind }, { format: document_.format, resolution: document_.resolution ?? null })
      setEditing(null)
      setMessage(t('multitrack.projectLoaded', { project: document_.project_name }))
      void refreshProjects()
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      setMessage(detail === 'exists' ? t('multitrack.projectExists') : (detail || t('multitrack.projectFailed')))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    const name = editing?.value.trim() ?? ''
    if (!name) return
    if (data.tracks.length > 0 && !pendingNew) {
      setPendingNew(true)
      setMessage(t('multitrack.projectConfirmNew'))
      return
    }
    setPendingNew(false)
    await createProjectByName(name)
  }

  async function handleDelete() {
    if (!currentName) return
    const dialog = extensionDialog(app)
    console.info('[EasyMedia][ProjectBar] delete requested:', currentName, 'dialog=', !!dialog?.confirm, 'pendingDelete=', pendingDelete)
    if (dialog?.confirm) {
      let result: unknown
      try {
        result = await dialog.confirm({
          title: t('multitrack.projectDeleteTitle'),
          message: t('multitrack.projectDeleteMessage', { project: currentName }),
        })
      } catch (error) {
        console.warn('[EasyMedia][ProjectBar] dialog.confirm threw:', error)
        extensionToast(app)?.add?.({
          severity: 'error',
          summary: t('multitrack.projectDeleteFailed'),
          detail: error instanceof Error ? error.message : String(error),
          life: 5000,
        })
        return
      }
      console.info('[EasyMedia][ProjectBar] dialog.confirm ->', result, '(typeof', typeof result, ')')
      if (result === true) {
        // 用户明确确认，继续删除
      } else if (typeof result === 'boolean') {
        // 用户明确取消
        setMessage('')
        return
      } else if (!pendingDelete) {
        // 返回值不是布尔（版本差异）：退化为按钮二次点击确认，避免"确认了却什么都没发生"
        setPendingDelete(true)
        setMessage(t('multitrack.projectDeleteConfirm'))
        return
      }
    } else if (!pendingDelete) {
      // 兜底：拿不到对话框 API 时退化为二次点击确认
      setPendingDelete(true)
      setMessage(t('multitrack.projectDeleteConfirm'))
      return
    }
    setPendingDelete(false)
    setBusy(true)
    setMessage('')
    const target = currentName
    try {
      const deleted = await deleteProjectTimeline(app, target)
      console.info('[EasyMedia][ProjectBar] DELETE ->', target, 'deleted=', deleted)
      if (deleted !== true) {
        // 文件本来就不存在：仍然刷新列表，让下拉反映真实状态
        setMessage(t('multitrack.projectNoTimeline'))
        void refreshProjects()
        return
      }
      const trackData = stripProjectMeta(data)
      savedSignatureRef.current = null
      lastLoadedAtRef.current = null
      setProjects((items) => items.filter((item) => item.project_name !== target))
      onApply(trackData, null)
      setMessage(t('multitrack.projectDeleted'))
      extensionToast(app)?.add?.({
        severity: 'success',
        summary: t('multitrack.projectDeleteSuccess', { project: target }),
        detail: t('multitrack.projectDeleted'),
        life: 4000,
      })
      void refreshProjects()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('multitrack.projectFailed'))
      extensionToast(app)?.add?.({
        severity: 'error',
        summary: t('multitrack.projectDeleteFailed'),
        detail: error instanceof Error ? error.message : String(error),
        life: 5000,
      })
    } finally {
      setBusy(false)
    }
  }

  const options = useMemo(() => {
    // 只列出真正有时间线的项目：删除时间线后（包括目录被清理或仅剩产物）不再出现在下拉里
    const names = projects
      .filter((project) => project.has_timeline)
      .map((project) => project.project_name)
    if (currentName && !names.includes(currentName)) names.unshift(currentName)
    return names
  }, [projects, currentName])

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-700 px-2 py-1 text-xs text-neutral-200">
      <span className="text-neutral-400">
        {data.project?.kind === 'audio' ? '🎵' : data.project?.kind === 'image' ? '🖼️' : '🎬'} 项目
      </span>
      <select
        className="h-7 max-w-[12rem] rounded border border-neutral-600 bg-neutral-800 px-1 text-xs text-neutral-100 disabled:opacity-40"
        value={currentName}
        disabled={busy}
        onMouseDown={() => void (async () => {
          await refreshProjects()
          await syncCurrentProjectFromDisk()
        })()}
        onFocus={() => void (async () => {
          await refreshProjects()
          await syncCurrentProjectFromDisk()
        })()}
        onChange={(event) => void handleSelect(event.target.value)}
      >
        <option value="">{t('multitrack.projectDefault')}</option>
        {options.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      {currentName && dirty ? <span className="text-amber-400" title={t('multitrack.projectUnsaved')}>●</span> : null}

      {editing ? (
        <>
          {editing.mode === 'new' ? (
            <select
              className="h-7 rounded border border-neutral-600 bg-neutral-800 px-1 text-xs text-neutral-100"
              value={newKind}
              disabled={busy}
              title="新项目类型预设"
              onChange={(event) => setNewKind(event.target.value as ProjectKind)}
            >
              {PROJECT_KIND_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          ) : null}
          <input
            autoFocus
            className="h-7 w-40 rounded border border-neutral-600 bg-neutral-900 px-2 text-xs text-neutral-100"
            placeholder={t('multitrack.projectLabel')}
            value={editing.value}
            disabled={busy}
            onChange={(event) => setEditing({ mode: editing.mode, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void (editing.mode === 'new' ? handleCreate() : handleSave(editing.value))
              if (event.key === 'Escape') { setEditing(null); setPendingNew(false) }
            }}
          />
          <button type="button" className={PRIMARY_CLASS} disabled={busy}
            onClick={() => void (editing.mode === 'new' ? handleCreate() : handleSave(editing.value))}>
            {t('common.confirm')}
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={busy}
            onClick={() => { setEditing(null); setPendingNew(false); setMessage('') }}>
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <>
          <button type="button" className={BUTTON_CLASS} disabled={busy}
            onClick={() => { setEditing({ mode: 'new', value: '' }); setMessage(''); setPendingDelete(false); setPendingSwitch(null) }}>
            {t('multitrack.projectNew')}
          </button>
          <button type="button" className={PRIMARY_CLASS} disabled={busy}
            onClick={() => { setEditing({ mode: 'saveAs', value: currentName }); setMessage('') }}>
            {t('multitrack.projectSaveAs')}
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={busy || currentName === ''}
            onClick={() => void handleDelete()}>
            {pendingDelete ? t('multitrack.projectDeleteConfirmShort') : t('multitrack.projectDelete')}
          </button>
          <button
            type="button"
            className={BUTTON_CLASS}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, padding: 0 }}
            title={t('multitrack.projectWorkspaceHint')}
            aria-label={t('multitrack.projectWorkspace')}
            onClick={() => {
              const open = (globalThis as unknown as { __easyMediaOpenWorkspace?: () => void }).__easyMediaOpenWorkspace
              open?.()
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 4v16M10 8h8M10 12h8M10 16h5" />
            </svg>
          </button>
        </>
      )}

      {autoSaveState === 'saving' ? (
        <span className="text-neutral-400">{t('multitrack.projectAutoSaving')}</span>
      ) : null}
      {autoSaveState === 'idle' && lastSavedAt ? (
        <span className="text-neutral-500" title={t('multitrack.projectAutoSavedHint')}>
          {t('multitrack.projectAutoSaved', { time: new Date(lastSavedAt * 1000).toLocaleTimeString() })}
        </span>
      ) : null}
      {autoSaveState === 'error' ? (
        <span className="text-amber-400">{t('multitrack.projectAutoSaveFailed')}</span>
      ) : null}
      {message ? <span className="ml-1 text-neutral-400">{message}</span> : null}
    </div>
  )
}
