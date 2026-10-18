import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MultiTrackPreviewResolutionInput } from '@/lib/multitrack-utils'
import type { TrackData } from '@/types/multitrack'
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
    meta: { name: string; updated_at: number } | null,
    snapshot?: { format?: string | null } | null,
  ) => void
}

type EditingState = { mode: 'new' | 'saveAs'; value: string } | null

const BUTTON_CLASS = 'h-7 rounded border border-neutral-600 bg-neutral-800 px-2 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40'
const PRIMARY_CLASS = 'h-7 rounded border border-sky-600 bg-sky-700 px-2 text-xs text-white hover:bg-sky-600 disabled:opacity-40'

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
  const savedSignatureRef = useRef<string | null>(null)
  const lastLoadedAtRef = useRef<number | null>(null)

  const currentSignature = useMemo(() => timelineSignature(data), [data])
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
      const trackData = { ...document_.track_data, project: { name: document_.project_name, updated_at: document_.updated_at } }
      savedSignatureRef.current = timelineSignature(trackData)
      lastLoadedAtRef.current = document_.updated_at
      onApply(trackData, { name: document_.project_name, updated_at: document_.updated_at }, { format: document_.format })
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

  async function handleSave(name?: string) {
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
        resolution: resolutionSnapshot(resolution),
        format: resolution.format ?? null,
        baseUpdatedAt: lastLoadedAtRef.current,
      })
      const trackData = { ...stripProjectMeta(data), project: { name: result.project_name, updated_at: result.updated_at } }
      savedSignatureRef.current = timelineSignature(trackData)
      lastLoadedAtRef.current = result.updated_at
      onApply(trackData, { name: result.project_name, updated_at: result.updated_at })
      setEditing(null)
      setMessage(t('multitrack.projectSaved', { project: result.project_name }))
      void refreshProjects()
    } catch (error) {
      if (error instanceof TimelineConflictError) {
        lastLoadedAtRef.current = error.updatedAt
        setMessage(t('multitrack.projectConflict'))
      } else {
        setMessage(error instanceof Error ? error.message : t('multitrack.projectFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    const name = editing?.value.trim() ?? ''
    const invalid = validateProjectName(name)
    if (invalid) {
      setMessage(invalid === 'too_long' ? t('multitrack.projectNameTooLong') : t('multitrack.projectNameInvalid'))
      return
    }
    if (data.tracks.length > 0 && !pendingNew) {
      setPendingNew(true)
      setMessage(t('multitrack.projectConfirmNew'))
      return
    }
    setPendingNew(false)
    setBusy(true)
    setMessage('')
    try {
      const document_ = await createProjectTimeline(app, name)
      const trackData = { ...document_.track_data, project: { name: document_.project_name, updated_at: document_.updated_at } }
      savedSignatureRef.current = timelineSignature(trackData)
      lastLoadedAtRef.current = document_.updated_at
      onApply(trackData, { name: document_.project_name, updated_at: document_.updated_at }, { format: document_.format })
      setEditing(null)
      setMessage(t('multitrack.projectLoaded', { project: document_.project_name }))
      void refreshProjects()
    } catch (error) {
      const text = error instanceof Error ? error.message : ''
      setMessage(text === 'exists' ? t('multitrack.projectExists') : (text || t('multitrack.projectFailed')))
    } finally {
      setBusy(false)
    }
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
      <span className="text-neutral-400">{t('multitrack.projectLabel')}</span>
      <select
        className="h-7 max-w-[12rem] rounded border border-neutral-600 bg-neutral-800 px-1 text-xs text-neutral-100 disabled:opacity-40"
        value={currentName}
        disabled={busy}
        onMouseDown={() => void refreshProjects()}
        onFocus={() => void refreshProjects()}
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
        </>
      )}

      {message ? <span className="ml-1 text-neutral-400">{message}</span> : null}
    </div>
  )
}
