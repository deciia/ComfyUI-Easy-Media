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
  onApply: (trackData: TrackData, meta: { name: string; updated_at: number } | null) => void
}

type EditingState = { mode: 'new' | 'saveAs'; value: string } | null

const BUTTON_CLASS = 'h-7 rounded border border-neutral-600 bg-neutral-800 px-2 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40'
const PRIMARY_CLASS = 'h-7 rounded border border-sky-600 bg-sky-700 px-2 text-xs text-white hover:bg-sky-600 disabled:opacity-40'

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

  async function handleSelect(name: string) {
    if (!name || name === currentName) return
    if (dirty && pendingSwitch !== name) {
      setPendingSwitch(name)
      setMessage(t('multitrack.projectConfirmSwitch'))
      return
    }
    setPendingSwitch(null)
    setBusy(true)
    setMessage('')
    try {
      const document_ = await loadProjectTimeline(app, name)
      const trackData = { ...document_.track_data, project: { name: document_.project_name, updated_at: document_.updated_at } }
      savedSignatureRef.current = timelineSignature(trackData)
      lastLoadedAtRef.current = document_.updated_at
      onApply(trackData, { name: document_.project_name, updated_at: document_.updated_at })
      setMessage(t('multitrack.projectLoaded', { project: document_.project_name }))
    } catch (error) {
      const text = error instanceof Error ? error.message : ''
      setMessage(text === 'not_found' ? t('multitrack.projectNoTimeline') : (text || t('multitrack.projectFailed')))
    } finally {
      setBusy(false)
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
      onApply(trackData, { name: document_.project_name, updated_at: document_.updated_at })
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
    if (!pendingDelete) {
      setPendingDelete(true)
      setMessage(t('multitrack.projectDeleteConfirm'))
      return
    }
    setPendingDelete(false)
    setBusy(true)
    setMessage('')
    try {
      await deleteProjectTimeline(app, currentName)
      const trackData = stripProjectMeta(data)
      savedSignatureRef.current = null
      lastLoadedAtRef.current = null
      onApply(trackData, null)
      setMessage(t('multitrack.projectDeleted'))
      void refreshProjects()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('multitrack.projectFailed'))
    } finally {
      setBusy(false)
    }
  }

  const options = useMemo(() => {
    const names = projects.map((project) => project.project_name)
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
          <button type="button" className={PRIMARY_CLASS} disabled={busy || currentName === ''}
            onClick={() => void handleSave()}>
            {busy ? '…' : t('multitrack.projectSave')}
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={busy}
            onClick={() => { setEditing({ mode: 'saveAs', value: currentName }); setMessage('') }}>
            {t('multitrack.projectSaveAs')}
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={busy || currentName === ''}
            onClick={() => void handleDelete()}>
            {pendingDelete ? t('multitrack.projectDeleteConfirmShort') : t('multitrack.projectDelete')}
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={busy}
            onClick={() => { void refreshProjects(); setMessage('') }}>
            {t('multitrack.projectRefresh')}
          </button>
        </>
      )}

      {message ? <span className="ml-1 text-neutral-400">{message}</span> : null}
    </div>
  )
}
