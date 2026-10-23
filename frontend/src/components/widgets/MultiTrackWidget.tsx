import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, ExternalLink, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCanvasScale } from '@/hooks/use-canvas-scale'
import { useElementWidth } from '@/hooks/use-element-width'
import { useMultiTrackHistory } from '@/hooks/use-multitrack-history'
import { useMultiTrackResolutionInput } from '@/hooks/use-multitrack-resolution-input'
import type { ReactWidgetProps } from '@/lib/create-react-widget'
import { LocaleContext, translate } from '@/lib/i18n'
import {
  addDefaultTaskSegmentIfRangeEmpty,
  calculateReplacementAudioEndFrame,
  createDefaultTrackData,
  calculateTotalLength,
  cloneMultiTrackSegment,
  createMultiTrackAudioContent,
  createMultiTrackVideoContent,
  deleteSegmentsWithLinkedTasks,
  deleteSegmentWithLinkedTasks,
  distributeMultiTrackSegmentsEvenly,
  getMultiTrackTrackHeight,
  getInheritedTaskSegmentContent,
  getSelectedMultiTrackSegment,
  mergeSelectedTaskSegments,
  MULTITRACK_DEFAULT_VOLUME_DB,
  MULTITRACK_MEDIA_TRACK_LIMIT,
  MULTITRACK_MIN_DURATION_SECONDS,
  MULTITRACK_TRACK_COLORS,
  moveSelectedSegments,
  moveSegmentBetweenCompatibleTracks,
  normalizeTrackData,
  referenceModePatch,
  remapFrameToRate,
  remapTrackDataFrameRate,
  resizeTaskSegmentEnd,
  secondsToFrame,
  splitMultiTrackSegmentByFrames,
  snapSecondsToFrame,
  snapTimeToFrame,
  setMultiTrackAudioTrackLock,
  syncMatchingTasksToPrimaryVideoTrack,
  syncMatchingTasksToPrimaryVideoSegment,
  updateMultiTrackSegmentContent,
  updateMultiTrackSegmentDuration,
  snapMultiTrackResizeTime,
} from '@/lib/multitrack-utils'
import { mediaContentToViewUrl } from '@/lib/media-url'
import {
  MODEL_MISSING_EVENT,
  MissingModelError,
  downloadEasyMediaModel,
  parseMissingModelPayload,
  type MissingModelInfo,
} from '@/lib/model-download'
import {
  applySmartSplit,
  applySmartSplitToMatchingTasks,
  hasMatchingTaskSegment,
  requestSmartSplit,
  splitTrackSegmentAtFrame,
} from '@/lib/smart-split'
import {
  applySubtitleRecognition,
  DEFAULT_SUBTITLE_STYLE,
  MULTITRACK_SUBTITLE_COLOR,
  requestSubtitleRecognition,
  type SubtitleRecognitionMethod,
} from '@/lib/subtitle-recognition'
import {
  applySubtitleSpeechAudio,
  requestSubtitleSpeechAudio,
  type SubtitleSpeechSettings,
} from '@/lib/subtitle-speech'
import { createSubtitleSegmentsFromSrt } from '@/lib/subtitle-srt'
import { loadBrowserAudioMetadata } from '@/lib/audio-utils'
import { invalidateMediaListCache } from '@/stores/media-list-store'
import { uuid } from '@/lib/uuid'
import { loadBrowserVideoMetadata } from '@/lib/video-utils'
import { adjustMultiTrackEditorNodeHeight } from '@/lib/timeline-node-size'
import type { MultiTrack, MultiTrackSegment, MultiTrackSegmentContent, MultiTrackSourceType, MultiTrackTaskImage, MultiTrackType, TrackData } from '@/types/multitrack'
import { stripProjectMeta } from '@/lib/project-timeline'
import { readWorkspace } from './multitrack/agentStore'
import { readDirectorSettings } from './multitrack/directorSettings'
import { MultiTrackRuler, MULTITRACK_LEFT_GUTTER, MULTITRACK_RIGHT_RESERVE } from './multitrack/MultiTrackRuler'
import { MultiTrackToolbar } from './multitrack/MultiTrackToolbar'
import { ProjectBar } from './multitrack/ProjectBar'
import { PromptEnhancerModal } from './multitrack/PromptEnhancerModal'
import { PreviewArea } from './multitrack/PreviewArea'
import { SplitTaskSegmentDialog } from './multitrack/SplitTaskSegmentDialog'
import { TrackArea } from './multitrack/TrackArea'

type CustomEventCallback = (event: CustomEvent<unknown>) => void

interface EasyMediaEventApi {
  addCustomEventListener?: (type: string, callback: CustomEventCallback) => void
  removeCustomEventListener?: (type: string, callback: CustomEventCallback) => void
}

function ensureTrackData(raw: unknown): TrackData {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const data = raw as Partial<TrackData>
    if (Array.isArray(data.tracks)) {
      return normalizeTrackData(raw as Parameters<typeof normalizeTrackData>[0])
    }
  }
  return createDefaultTrackData()
}

function insertSegmentAtFrame(
  segments: MultiTrackSegment[],
  nextSegment: MultiTrackSegment,
): MultiTrackSegment[] {
  const sorted = [...segments].sort((left, right) => left.start_frame - right.start_frame)
  const insertIndex = sorted.filter((segment) => (
    segment.start_frame + (segment.end_frame - segment.start_frame) / 2 < nextSegment.start_frame
  )).length
  const before = sorted.slice(0, insertIndex)
  const previousEnd = before.at(-1)?.end_frame ?? 0
  const duration = nextSegment.end_frame - nextSegment.start_frame
  const insertedStart = Math.max(nextSegment.start_frame, previousEnd)
  const inserted = { ...nextSegment, start_frame: insertedStart, end_frame: insertedStart + duration }
  let cursor = inserted.end_frame
  const after = sorted.slice(insertIndex).map((segment) => {
    const segmentDuration = segment.end_frame - segment.start_frame
    const shiftedStart = Math.max(segment.start_frame, cursor)
    cursor = shiftedStart + segmentDuration
    return { ...segment, start_frame: shiftedStart, end_frame: cursor }
  })
  return [...before, inserted, ...after]
}

function getTrackLayoutHeight(data: TrackData): number {
  const taskOverview = data.task_overview === true
  return data.tracks.reduce(
    (height, track) => height + getMultiTrackTrackHeight(track.type, taskOverview),
    0,
  )
}

export function MultiTrackWidget({ value, onChange, app, node }: Readonly<ReactWidgetProps<TrackData>>) {
  const committedData = ensureTrackData(value)
  const committedDataKey = JSON.stringify(committedData)
  const [resizePreviewData, setResizePreviewData] = useState<TrackData | null>(null)
  const data = resizePreviewData ?? committedData
  const taskOverview = data.task_overview === true
  const dataRef = useRef(committedData)
  dataRef.current = committedData
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  const [selectedTaskMarkerId, setSelectedTaskMarkerId] = useState<string | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null)
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(() => new Set())
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false)
  const workspaceInstanceId = useRef(`ws-${Math.random().toString(36).slice(2, 8)}`).current
  const openWorkspaceRef = useRef<() => void>(() => {})

  // 提示词增强器切换任务片段：把切换函数登记到全局，弹窗直接调用（事件作为兜底）
  useEffect(() => {
    const activate = (id: string) => {
      // 走编辑器自己的选中逻辑（会同步播放头/清 marker 等），不要裸 setState
      handleSelectSegment(id, 'replace')
    }
    const registry = globalThis as unknown as {
      __easyMediaActivateSegment?: (id: string) => void
    }
    registry.__easyMediaActivateSegment = activate

    function onActivateSegment(event: Event) {
      const detail = (event as CustomEvent<{ id?: string }>).detail
      if (detail?.id) activate(detail.id)
    }
    window.addEventListener('easy-media.segment.activate', onActivateSegment as EventListener)
    return () => {
      if (registry.__easyMediaActivateSegment === activate) delete registry.__easyMediaActivateSegment
      window.removeEventListener('easy-media.segment.activate', onActivateSegment as EventListener)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [editingSubtitleSegmentId, setEditingSubtitleSegmentId] = useState<string | null>(null)
  const [splittingTaskSegmentId, setSplittingTaskSegmentId] = useState<string | null>(null)
  const [isSmartSplitting, setIsSmartSplitting] = useState(false)
  const [isRecognizingSubtitles, setIsRecognizingSubtitles] = useState(false)
  const [syncPlayNonce, setSyncPlayNonce] = useState(0)
  const [missingModel, setMissingModel] = useState<MissingModelInfo | null>(null)
  const [isDownloadingModel, setIsDownloadingModel] = useState(false)
  const [modelDownloadError, setModelDownloadError] = useState<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const timelineContainerRef = useRef<HTMLDivElement>(null)
  const startedAtRef = useRef(0)
  const startTimeRef = useRef(0)
  const currentTimeRef = useRef(0)
  const previousViewportTimeRef = useRef(0)
  const timelineWidth = Math.max(1, useElementWidth(timelineContainerRef))
  const scaledTimelineWidth = timelineWidth * zoom
  const canvasScale = useCanvasScale(app)
  const resolutionInput = useMultiTrackResolutionInput(node)
  const resolutionRef = useRef(resolutionInput)
  resolutionRef.current = resolutionInput
  // React's wheel listener can be passive; cancel native scrolling before moving the timeline.
  // useLayoutEffect attaches the non-passive listener before paint so the very first wheel
  // gesture on the timeline is intercepted rather than falling through to native scroll.
  useLayoutEffect(() => {
    const container = timelineContainerRef.current
    if (!container) return

    function handleWheel(event: WheelEvent) {
      if (!container || container.scrollWidth <= container.clientWidth || event.ctrlKey || event.metaKey) return
      if (event.target instanceof Element && event.target.closest('[data-capture-wheel="true"]')) return

      event.preventDefault()

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientWidth : 1
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      container.scrollLeft = Math.max(0, Math.min(
        container.scrollWidth - container.clientWidth,
        container.scrollLeft + delta * unit,
      ))
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [timelineContainerRef])
  useLayoutEffect(() => {
    const previousTime = previousViewportTimeRef.current
    previousViewportTimeRef.current = currentTime
    const container = timelineContainerRef.current
    if ((!isPlaying && !isScrubbing) || !container || !container.clientWidth || data.total_length <= 0) return

    const visibleWidth = container.clientWidth
    const playableWidth = Math.max(1, scaledTimelineWidth - MULTITRACK_LEFT_GUTTER - MULTITRACK_RIGHT_RESERVE)
    const playheadX = MULTITRACK_LEFT_GUTTER + currentTime / data.total_length * playableWidth
    const pageWidth = visibleWidth * 0.9
    const margin = visibleWidth * 0.02
    const maxScroll = Math.max(0, scaledTimelineWidth - visibleWidth)
    const scrollLeft = container.scrollLeft

    if (isPlaying && !isScrubbing && currentTime < previousTime) {
      container.scrollLeft = 0
    } else if (playheadX > scrollLeft + visibleWidth - margin) {
      const pages = Math.ceil((playheadX - scrollLeft - visibleWidth + margin) / pageWidth)
      container.scrollLeft = Math.min(maxScroll, scrollLeft + pages * pageWidth)
    } else if ((playheadX < scrollLeft || (isScrubbing && currentTime < previousTime)) &&
      playheadX < scrollLeft + margin) {
      const pages = Math.ceil((scrollLeft + margin - playheadX) / pageWidth)
      container.scrollLeft = Math.max(0, scrollLeft - pages * pageWidth)
    }
  }, [currentTime, isPlaying, isScrubbing, scaledTimelineWidth, data.total_length])
  const selectedSegment = selectedSegmentIds.size <= 1
    ? getSelectedMultiTrackSegment(data, selectedSegmentId)
    : null
  const selectedTaskSegments = selectedSegmentIds.size > 1
    ? data.tracks.flatMap((track) => (
        track.type === 'task'
          ? track.segments.filter((segment) => selectedSegmentIds.has(segment.id))
          : []
      ))
    : []
  const hasOnlySelectedTaskSegments = selectedTaskSegments.length === selectedSegmentIds.size
    && selectedTaskSegments.length > 1
  const canMergeSelectedTaskSegments = mergeSelectedTaskSegments(data.tracks, selectedSegmentIds) !== null
  const previewSelectedSegment = selectedSegment ?? (hasOnlySelectedTaskSegments
    ? getSelectedMultiTrackSegment(data, selectedSegmentId)
    : null)
  const selectedTaskTrackSegments = previewSelectedSegment?.trackType === 'task'
    ? data.tracks.find((track) => track.id === previewSelectedSegment.trackId && track.type === 'task')?.segments ?? [previewSelectedSegment.segment]
    : undefined
  const splittingTaskSegment = splittingTaskSegmentId
    ? data.tracks
        .find((track) => track.type === 'task' && track.segments.some((segment) => segment.id === splittingTaskSegmentId))
        ?.segments.find((segment) => segment.id === splittingTaskSegmentId) ?? null
    : null
  const handleTrackDataChange = useCallback((nextData: TrackData) => {
    const heightDelta = getTrackLayoutHeight(nextData) - getTrackLayoutHeight(dataRef.current)
    adjustMultiTrackEditorNodeHeight(node, heightDelta)
    dataRef.current = nextData
    onChange(nextData)
  }, [node, onChange])
  const {
    canUndo,
    canRedo,
    commitChange: commitTrackChange,
    undo: undoTrackChange,
    redo: redoTrackChange,
  } = useMultiTrackHistory(committedData, handleTrackDataChange)
  const locale = app?.ui?.settings?.settingsValues?.['Comfy.Locale']
  const t = (path: string, params?: Record<string, string | number>) => translate(locale, path, params)
  const missingModelDirectoryName = missingModel?.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

  function commitNormalizedTrackChange(nextData: TrackData) {
    commitTrackChange(normalizeTrackData(nextData))
  }

  /** 项目栏载入/新建/删除后的统一写回：带上 project 标记，走撤销栈。 */
  function applyProjectTimeline(
    nextData: TrackData,
    meta: { name: string; updated_at: number } | null,
    snapshot?: { format?: string | null } | null,
  ) {
    const withMeta: TrackData = meta
      ? { ...nextData, project: { name: meta.name, updated_at: meta.updated_at } }
      : stripProjectMeta(nextData)
    commitNormalizedTrackChange(withMeta)
    // 恢复项目保存的“视频格式”：上下文接续、参考图 match/max 等控件只在 format=MiniMax 时渲染，
    // 不恢复会让载入后的编辑器看起来“丢了功能”。
    const savedFormat = snapshot?.format
    if (typeof savedFormat === 'string' && savedFormat.length > 0) {
      const widgets = (node as { widgets?: Array<{ name?: string; value?: unknown; callback?: (value: unknown) => void }> } | null)?.widgets ?? []
      const formatWidget = widgets.find((widget) => widget?.name === 'format')
      if (formatWidget && formatWidget.value !== savedFormat) {
        formatWidget.value = savedFormat
        try {
          formatWidget.callback?.(savedFormat)
        } catch {
          // 忽略回调异常：节点值已写入
        }
        ;(app as { canvas?: { setDirty?: (dirty: boolean, canvas?: unknown) => void } } | null)?.canvas?.setDirty?.(true)
      }
    }
  }

  function setSingleSelectedSegment(segmentId: string | null) {
    setSelectedSegmentId(segmentId)
    setSelectedSegmentIds(segmentId ? new Set([segmentId]) : new Set())
  }

  function setPlayheadTime(time: number) {
    const nextTime = snapTimeToFrame(time, data.frame_rate)
    currentTimeRef.current = nextTime
    setCurrentTime(nextTime)
  }

  function handleSelectSegment(segmentId: string, mode: 'replace' | 'toggle' | 'add' = 'replace') {
    const taskSegment = data.tracks
      .find((track) => track.type === 'task' && track.segments.some((segment) => segment.id === segmentId))
      ?.segments.find((segment) => segment.id === segmentId)
    if (
      taskSegment &&
      (currentTimeRef.current < taskSegment.start_frame || currentTimeRef.current >= taskSegment.end_frame)
    ) {
      setPlayheadTime(taskSegment.start_frame)
    }
    setSelectedTaskMarkerId(null)
    setSelectedSegmentIds((current) => {
      if (mode === 'replace') {
        setSelectedSegmentId(segmentId)
        return new Set([segmentId])
      }
      const next = new Set(current)
      if (mode === 'toggle' && next.has(segmentId)) {
        next.delete(segmentId)
        setSelectedSegmentId((active) => active === segmentId ? next.values().next().value ?? null : active)
        return next
      }
      next.add(segmentId)
      setSelectedSegmentId(segmentId)
      return next
    })
  }

  function handleSelectSegments(segmentIds: string[]) {
    setSelectedTaskMarkerId(null)
    const next = new Set(segmentIds)
    setSelectedSegmentIds(next)
    setSelectedSegmentId(segmentIds.at(-1) ?? null)
  }

  function handleClearSelection() {
    setSingleSelectedSegment(null)
    setSelectedTaskMarkerId(null)
  }

  useEffect(() => {
    setResizePreviewData(null)
    const validSegmentIds = new Set(committedData.tracks.flatMap((track) => track.segments.map((segment) => segment.id)))
    setSelectedSegmentIds((current) => {
      const next = new Set([...current].filter((segmentId) => validSegmentIds.has(segmentId)))
      setSelectedSegmentId((active) => active && !validSegmentIds.has(active) ? next.values().next().value ?? null : active)
      return next
    })
    setSelectedTaskMarkerId((markerId) => (
      markerId && committedData.task_markers?.some((marker) => marker.id === markerId)
        ? markerId
        : null
    ))
  }, [committedDataKey])

  function canAddTaskMarkerAtCurrentTime(): boolean {
    const frame = snapTimeToFrame(currentTime, data.frame_rate)
    return frame > 0 &&
      frame <= data.total_length &&
      !(data.task_markers ?? []).some((marker) => marker.frame === frame)
  }

  function handleAddTaskMarker() {
    const frame = snapTimeToFrame(currentTime, data.frame_rate)
    if (!canAddTaskMarkerAtCurrentTime()) return
    const marker = { id: uuid(), frame }
    commitNormalizedTrackChange({
      ...data,
      task_markers: [...(data.task_markers ?? []), marker],
    })
    setSingleSelectedSegment(null)
    setSelectedTaskMarkerId(marker.id)
  }

  function handleDeleteTaskMarker(markerId: string) {
    if (!(data.task_markers ?? []).some((marker) => marker.id === markerId)) return
    commitNormalizedTrackChange({
      ...data,
      task_markers: (data.task_markers ?? []).filter((marker) => marker.id !== markerId),
    })
    setSelectedTaskMarkerId((selected) => selected === markerId ? null : selected)
  }

  function handleMoveTaskMarker(markerId: string, frame: number) {
    const snappedFrame = snapTimeToFrame(frame, data.frame_rate)
    const taskMarkers = data.task_markers ?? []
    const marker = taskMarkers.find((candidate) => candidate.id === markerId)
    if (!marker || marker.frame === snappedFrame) return
    if (snappedFrame <= 0 || snappedFrame > data.total_length) return
    if (taskMarkers.some((candidate) => candidate.id !== markerId && candidate.frame === snappedFrame)) return

    commitNormalizedTrackChange({
      ...data,
      task_markers: taskMarkers.map((candidate) => (
        candidate.id === markerId ? { ...candidate, frame: snappedFrame } : candidate
      )),
    })
  }

  function handleTaskOverviewChange(enabled: boolean) {
    commitNormalizedTrackChange({
      ...committedData,
      task_overview: enabled,
    })
  }

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    if (!selectedSegmentId || selectedSegmentIds.size !== 1) return
    const taskTrack = data.tracks.find((track) => (
      track.type === 'task' && track.segments.some((segment) => segment.id === selectedSegmentId)
    ))
    const selectedTaskSegment = taskTrack?.segments.find((segment) => segment.id === selectedSegmentId)
    if (!taskTrack || !selectedTaskSegment) return
    if (currentTime >= selectedTaskSegment.start_frame && currentTime < selectedTaskSegment.end_frame) return

    const taskSegmentAtPlayhead = taskTrack.segments.find((segment) => (
      currentTime >= segment.start_frame && currentTime < segment.end_frame
    ))
    if (!taskSegmentAtPlayhead || taskSegmentAtPlayhead.id === selectedSegmentId) return
    setSingleSelectedSegment(taskSegmentAtPlayhead.id)
  }, [currentTime, data.tracks, selectedSegmentId, selectedSegmentIds])

  useEffect(() => {
    const syncNode = node as { __easyMediaSyncPlay?: (startAt: number, muted?: boolean) => void }
    syncNode.__easyMediaSyncPlay = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      currentTimeRef.current = 0
      startTimeRef.current = 0
      startedAtRef.current = performance.now()
      setCurrentTime(0)
      setIsPlaying(true)
      setSyncPlayNonce((value) => value + 1)
    }
    return () => {
      if (syncNode.__easyMediaSyncPlay) delete syncNode.__easyMediaSyncPlay
    }
  }, [node])

  useEffect(() => {
    const api = app.api as EasyMediaEventApi | undefined
    if (!api?.addCustomEventListener || !api.removeCustomEventListener) return
    const handleMissingModel: CustomEventCallback = (event) => {
      const model = parseMissingModelPayload(event.detail)
      if (!model) return
      setMissingModel(model)
      setModelDownloadError(null)
      setIsDownloadingModel(false)
    }
    api.addCustomEventListener(MODEL_MISSING_EVENT, handleMissingModel)
    return () => api.removeCustomEventListener?.(MODEL_MISSING_EVENT, handleMissingModel)
  }, [app])

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }

    startedAtRef.current = performance.now()
    startTimeRef.current = currentTimeRef.current

    function tick(now: number) {
      const elapsed = (now - startedAtRef.current) / 1000
      const next = snapTimeToFrame(startTimeRef.current + secondsToFrame(elapsed, data.frame_rate), data.frame_rate)
      if (next >= data.total_length) {
        currentTimeRef.current = 0
        startTimeRef.current = 0
        startedAtRef.current = now
        setCurrentTime(0)
        setSyncPlayNonce((value) => value + 1)
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      currentTimeRef.current = next
      setCurrentTime(next)
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [isPlaying, syncPlayNonce, data.frame_rate, data.total_length])

  async function handleAddVideo(
    trackId: string,
    filePath: string,
    sourceType: MultiTrackSourceType,
    requestedStartFrame?: number,
    requestedEndFrame?: number,
    previewUrl?: string,
  ) {
    const content = createMultiTrackVideoContent(filePath, sourceType)
    if (previewUrl) content.url = previewUrl
    const src = mediaContentToViewUrl(content)
    let duration: number | undefined
    if (src) {
      try {
        const metadata = await loadBrowserVideoMetadata(src)
        if (Number.isFinite(metadata.duration) && metadata.duration > 0) duration = metadata.duration
      } catch (error) {
        console.error('[MultiTrackWidget] failed to read video metadata:', error)
      }
    }

    const latestData = dataRef.current
    const addedVideoRange = { added: false, startFrame: 0, endFrame: 0 }
    const videoUpdatedTracks = latestData.tracks.map((track) => {
      if (track.id !== trackId) return track
      const startFrame = requestedStartFrame === undefined
        ? snapTimeToFrame(track.segments.reduce((max, segment) => Math.max(max, segment.end_frame), 0), latestData.frame_rate)
        : Math.max(0, Math.round(requestedStartFrame))
      const endFrame = requestedEndFrame === undefined
        ? startFrame + Math.max(1, snapSecondsToFrame(duration ?? MULTITRACK_MIN_DURATION_SECONDS, latestData.frame_rate))
        : Math.max(startFrame + 1, Math.round(requestedEndFrame))
      addedVideoRange.added = true
      addedVideoRange.startFrame = startFrame
      addedVideoRange.endFrame = endFrame
      return {
        ...track,
        segments: (() => {
          const nextSegment: MultiTrackSegment = {
            id: uuid(),
            start_frame: startFrame,
            end_frame: endFrame,
            color: track.color,
            content: {
              ...content,
              ...(duration === undefined ? {} : { duration }),
            },
          }
          if (requestedStartFrame === undefined) return [...track.segments, nextSegment]
          return insertSegmentAtFrame(track.segments, nextSegment)
        })(),
      }
    })
    const taskSyncedTracks = requestedStartFrame === undefined
      ? videoUpdatedTracks
      : syncMatchingTasksToPrimaryVideoTrack(latestData.tracks, videoUpdatedTracks)
    const updatedTracks = addedVideoRange.added
      ? addDefaultTaskSegmentIfRangeEmpty(taskSyncedTracks, addedVideoRange.startFrame, addedVideoRange.endFrame)
      : taskSyncedTracks

    commitNormalizedTrackChange({
      ...latestData,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, latestData.frame_rate),
    })
  }

  async function handleAddAudio(
    trackId: string,
    filePath: string,
    sourceType: MultiTrackSourceType,
    previewUrl?: string,
    requestedStartFrame?: number,
    requestedEndFrame?: number,
  ) {
    const content = createMultiTrackAudioContent(filePath, sourceType)
    if (previewUrl) content.url = previewUrl
    const src = mediaContentToViewUrl(content)
    let duration: number | undefined
    if (src) {
      try {
        duration = (await loadBrowserAudioMetadata(src)).duration
      } catch (error) {
        console.error('[MultiTrackWidget] failed to read audio metadata:', error)
      }
    }
    const latestData = dataRef.current
    const updatedTracks = latestData.tracks.map((track) => {
      if (track.id !== trackId || track.type !== 'audio') return track
      const startFrame = requestedStartFrame === undefined
        ? track.segments.reduce((max, segment) => Math.max(max, segment.end_frame), 0)
        : Math.max(0, Math.round(requestedStartFrame))
      const endFrame = requestedEndFrame === undefined
        ? startFrame + Math.max(1, snapSecondsToFrame(duration ?? MULTITRACK_MIN_DURATION_SECONDS, latestData.frame_rate))
        : Math.max(startFrame + 1, Math.round(requestedEndFrame))
      return {
        ...track,
        segments: (() => {
          const nextSegment: MultiTrackSegment = {
            id: uuid(),
            start_frame: startFrame,
            end_frame: endFrame,
            color: track.color,
            content: { ...content, ...(duration === undefined ? {} : { duration }) },
          }
          if (requestedStartFrame === undefined) return [...track.segments, nextSegment]
          return insertSegmentAtFrame(track.segments, nextSegment)
        })(),
      }
    })
    commitNormalizedTrackChange({ ...latestData, tracks: updatedTracks, total_length: calculateTotalLength(updatedTracks, latestData.frame_rate) })
  }

  async function handleReplaceAudio(
    trackId: string,
    segmentId: string,
    filePath: string,
    sourceType: MultiTrackSourceType,
    previewUrl?: string,
  ) {
    const content = createMultiTrackAudioContent(filePath, sourceType)
    if (previewUrl) content.url = previewUrl
    const src = mediaContentToViewUrl(content)
    let duration: number | null = null
    if (src) {
      try {
        duration = (await loadBrowserAudioMetadata(src)).duration
      } catch (error) {
        console.error('[MultiTrackWidget] failed to read replacement audio metadata:', error)
      }
    }

    const latestData = dataRef.current
    const updatedTracks = latestData.tracks.map((track) => {
      if (track.id !== trackId || track.type !== 'audio') return track
      return {
        ...track,
        segments: track.segments.map((segment) => {
          if (segment.id !== segmentId) return segment
          return {
            ...segment,
            end_frame: duration === null
              ? segment.end_frame
              : calculateReplacementAudioEndFrame(segment, duration, latestData.frame_rate),
            origin_start_frame: segment.start_frame,
            content: {
              ...content,
              ...(duration === null ? {} : { duration }),
              muted: segment.content.muted ?? content.muted,
              volume_db: segment.content.volume_db ?? content.volume_db,
              shared_reference: segment.content.shared_reference === true,
            },
          }
        }),
      }
    })
    commitNormalizedTrackChange({
      ...latestData,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, latestData.frame_rate),
    })
  }

  function handleAddTrack(type: MultiTrackType) {
    if (type !== 'video' && type !== 'audio' && type !== 'subtitle') return
    const trackNumber = data.tracks.filter((track) => track.type === type).length
    if (trackNumber >= MULTITRACK_MEDIA_TRACK_LIMIT) return
    const hasAudioControls = type === 'video' || type === 'audio'
    const track: MultiTrack = {
      id: uuid(),
      name: `${type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : 'Subtitle'} ${trackNumber}`,
      type,
      color: type === 'subtitle' ? MULTITRACK_SUBTITLE_COLOR : MULTITRACK_TRACK_COLORS[type],
      muted: false,
      solo: hasAudioControls ? false : undefined,
      volume_db: hasAudioControls ? MULTITRACK_DEFAULT_VOLUME_DB : undefined,
      locked: false,
      segments: [],
    }
    commitNormalizedTrackChange({ ...data, tracks: [...data.tracks, track] })
  }

  function handleDeleteTrack(trackId: string) {
    const target = data.tracks.find((track) => track.id === trackId)
    const firstVideoTrackId = data.tracks.find((track) => track.type === 'video')?.id
    if (!target || target.type === 'task' || target.id === firstVideoTrackId) return
    const segmentIds = new Set(target.segments.map((segment) => segment.id))
    const updatedTracks = data.tracks.filter((track) => track.id !== trackId)
    commitNormalizedTrackChange({ ...data, tracks: updatedTracks, total_length: calculateTotalLength(updatedTracks, data.frame_rate) })
    setSelectedSegmentIds((current) => {
      const next = new Set([...current].filter((segmentId) => !segmentIds.has(segmentId)))
      setSelectedSegmentId((active) => active && segmentIds.has(active) ? next.values().next().value ?? null : active)
      return next
    })
  }

  function handleReorderTrack(sourceTrackId: string, targetTrackId: string) {
    const sourceIndex = data.tracks.findIndex((track) => track.id === sourceTrackId)
    const targetIndex = data.tracks.findIndex((track) => track.id === targetTrackId)
    const sourceTrack = data.tracks[sourceIndex]
    const targetTrack = data.tracks[targetIndex]
    if (
      sourceIndex < 0 ||
      targetIndex < 0 ||
      sourceIndex === targetIndex ||
      sourceTrack?.type === 'task' ||
      targetTrack?.type === 'task'
    ) return

    const tracks = [...data.tracks]
    tracks[sourceIndex] = targetTrack
    tracks[targetIndex] = sourceTrack
    commitNormalizedTrackChange({ ...data, tracks })
  }

  // Deciia P1: patch one media segment's content flags (segment-level lock /
  // mute / reference scope). Track-level audio_locked is unaffected — the
  // backend resolves "track overrides segment" per design doc.
  function handleSegmentContentChange(
    trackId: string,
    segmentId: string,
    patch: Partial<MultiTrackSegment['content']>,
  ) {
    const tracks = data.tracks.map((track) => {
      if (track.id !== trackId) return track
      const segments = track.segments.map((segment) => (
        segment.id === segmentId
          ? { ...segment, content: { ...segment.content, ...patch } }
          : segment
      ))
      return { ...track, segments }
    })
    commitNormalizedTrackChange({ ...data, tracks })
  }

  function handleTrackAudioSettingsChange(
    trackId: string,
    patch: Partial<Pick<MultiTrack, 'muted' | 'solo' | 'audio_locked'>>,
  ) {
    if ('audio_locked' in patch) {
      commitNormalizedTrackChange(
        setMultiTrackAudioTrackLock(data, trackId, patch.audio_locked === true),
      )
      return
    }
    if ('solo' in patch) {
      const target = data.tracks.find((track) => track.id === trackId)
      if (!target || (target.type !== 'video' && target.type !== 'audio')) return

      const nextSolo = patch.solo === true
      const updatedTracks = data.tracks.map((track) => {
        if (track.type !== 'video' && track.type !== 'audio') return track
        if (track.id === trackId) {
          return {
            ...track,
            ...patch,
            solo: nextSolo,
            muted: nextSolo ? false : track.muted,
          }
        }
        return {
          ...track,
          solo: false,
          muted: nextSolo ? true : false,
        }
      })
      commitNormalizedTrackChange({ ...data, tracks: updatedTracks })
      return
    }

    commitNormalizedTrackChange({
      ...data,
      tracks: data.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track),
    })
  }

  function handleTrackVisibilityChange(trackId: string, visible: boolean) {
    commitNormalizedTrackChange({
      ...data,
      tracks: data.tracks.map((track) => (
        track.id === trackId && track.type === 'subtitle'
          ? { ...track, visible }
          : track
      )),
    })
  }

  function handleReferenceModeChange(
    trackId: string,
    segmentId: string,
    mode: 'off' | 'aligned' | 'global',
  ) {
    commitNormalizedTrackChange({
      ...data,
      tracks: data.tracks.map((track) => {
        if (track.id !== trackId || (track.type !== 'audio' && track.type !== 'video')) return track
        return {
          ...track,
          segments: track.segments.map((segment) => (
            segment.id === segmentId
              ? {
                  ...segment,
                  content: {
                    ...segment.content,
                    ...referenceModePatch(mode),
                  },
                }
              : segment
          )),
        }
      }),
    })
  }

  function handleSharedReferenceChange(trackId: string, segmentId: string, enabled: boolean) {
    commitNormalizedTrackChange({
      ...data,
      tracks: data.tracks.map((track) => {
        if (track.id !== trackId || (track.type !== 'audio' && track.type !== 'video')) return track
        return {
          ...track,
          segments: track.segments.map((segment) => ({
            ...segment,
            content: {
              ...segment.content,
              shared_reference: enabled && segment.id === segmentId,
              speaker_reference: undefined,
            },
          })),
        }
      }),
    })
  }

  async function handleReplaceVideo(
    trackId: string,
    segmentId: string,
    filePath: string,
    sourceType: MultiTrackSourceType,
    previewUrl?: string,
  ) {
    const content = createMultiTrackVideoContent(filePath, sourceType)
    if (previewUrl) content.url = previewUrl
    const src = mediaContentToViewUrl(content)
    let duration: number | undefined
    if (src) {
      try {
        const metadata = await loadBrowserVideoMetadata(src)
        if (Number.isFinite(metadata.duration) && metadata.duration > 0) duration = metadata.duration
      } catch (error) {
        console.error('[MultiTrackWidget] failed to read replacement video metadata:', error)
      }
    }

    const updatedTracks = data.tracks.map((track) => {
      if (track.id !== trackId) return track
      return {
        ...track,
        segments: track.segments.map((segment) => (
          segment.id === segmentId
            ? {
                ...segment,
                content: {
                  ...content,
                  ...(duration === undefined ? {} : { duration }),
                  shared_reference: segment.content.shared_reference === true,
                },
              }
            : segment
        )),
      }
    })

    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
  }

  function handleAddTaskSegment(
    trackId: string,
    requestedStartFrame?: number,
    requestedEndFrame?: number,
    images?: MultiTrackTaskImage[],
  ) {
    const updatedTracks = data.tracks.map((track) => {
      if (track.id !== trackId || track.type !== 'task') return track
      const startFrame = requestedStartFrame === undefined
        ? snapTimeToFrame(
            track.segments.reduce((max, segment) => Math.max(max, segment.end_frame), 0),
            data.frame_rate,
          )
        : Math.max(0, Math.round(requestedStartFrame))
      const endFrame = requestedEndFrame === undefined
        ? startFrame + Math.max(1, secondsToFrame(5, data.frame_rate))
        : Math.max(startFrame + 1, Math.round(requestedEndFrame))
      const nextSegment: MultiTrackSegment = {
        id: uuid(),
        start_frame: startFrame,
        end_frame: endFrame,
        color: track.color,
        content: {
          media_type: 'none' as const,
          ...getInheritedTaskSegmentContent(track.segments, startFrame, track.task_mode ?? 'default'),
          images: images ?? [],
        },
      }
      return {
        ...track,
        segments: requestedStartFrame === undefined
          ? [...track.segments, nextSegment]
          : insertSegmentAtFrame(track.segments, nextSegment),
      }
    })

    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
  }

  function handleAddSubtitleSegment(trackId: string, requestedStartFrame?: number, requestedEndFrame?: number) {
    const updatedTracks = data.tracks.map((track) => {
      if (track.id !== trackId || track.type !== 'subtitle') return track
      const startFrame = requestedStartFrame === undefined
        ? snapTimeToFrame(
            track.segments.reduce((max, segment) => Math.max(max, segment.end_frame), 0),
            data.frame_rate,
          )
        : Math.max(0, Math.round(requestedStartFrame))
      const endFrame = requestedEndFrame === undefined
        ? startFrame + Math.max(1, secondsToFrame(5, data.frame_rate))
        : Math.max(startFrame + 1, Math.round(requestedEndFrame))
      const existingStyle = track.segments.find((segment) => segment.content.subtitle_style)?.content.subtitle_style
      const nextSegment: MultiTrackSegment = {
        id: uuid(),
        start_frame: startFrame,
        end_frame: endFrame,
        color: track.color || MULTITRACK_SUBTITLE_COLOR,
        content: {
          media_type: 'subtitle' as const,
          text: '默认文字',
          subtitle_style: { ...(existingStyle ?? DEFAULT_SUBTITLE_STYLE) },
        },
      }
      return {
        ...track,
        segments: requestedStartFrame === undefined
          ? [...track.segments, nextSegment]
          : insertSegmentAtFrame(track.segments, nextSegment),
      }
    })

    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
  }

  function handleImportSubtitles(trackId: string, srtText: string, startFrame: number) {
    const latestData = dataRef.current
    const updatedTracks = latestData.tracks.map((track) => {
      if (track.id !== trackId || track.type !== 'subtitle') return track
      const existingStyle = track.segments.find((segment) => segment.content.subtitle_style)?.content.subtitle_style
      const importedSegments = createSubtitleSegmentsFromSrt(srtText, {
        color: track.color || MULTITRACK_SUBTITLE_COLOR,
        createId: () => uuid(),
        frameRate: latestData.frame_rate,
        startFrame: Math.max(0, Math.round(startFrame)),
        subtitleStyle: existingStyle ?? DEFAULT_SUBTITLE_STYLE,
      })
      const importStart = importedSegments.reduce(
        (minimum, segment) => Math.min(minimum, segment.start_frame),
        importedSegments[0].start_frame,
      )
      const importEnd = importedSegments.reduce(
        (maximum, segment) => Math.max(maximum, segment.end_frame),
        importedSegments[0].end_frame,
      )
      const outsideImportRange = track.segments.filter((segment) => (
        segment.end_frame <= importStart || segment.start_frame >= importEnd
      ))
      return {
        ...track,
        segments: [...outsideImportRange, ...importedSegments]
          .sort((left, right) => left.start_frame - right.start_frame),
      }
    })

    commitNormalizedTrackChange({
      ...latestData,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, latestData.frame_rate),
    })
  }

  function handleDeleteSegment(segmentId: string) {
    const idsToDelete = selectedSegmentIds.has(segmentId) ? selectedSegmentIds : new Set([segmentId])
    const updatedTracks = idsToDelete.size > 1
      ? deleteSegmentsWithLinkedTasks(data.tracks, idsToDelete, data.frame_rate)
      : deleteSegmentWithLinkedTasks(data.tracks, segmentId, data.frame_rate)
    const totalLength = calculateTotalLength(updatedTracks, data.frame_rate)
    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: totalLength,
    })
    handleClearSelection()
    setCurrentTime((time) => Math.min(time, totalLength))
  }

  function handleDistributeTaskSegments(trackId: string) {
    const updatedTracks = data.tracks.map((track) => (
      track.id === trackId && track.type === 'task'
        ? { ...track, segments: distributeMultiTrackSegmentsEvenly(track.segments, data.total_length) }
        : track
    ))
    commitNormalizedTrackChange({ ...data, tracks: updatedTracks })
  }

  function handleCloneSegment(trackId: string, segmentId: string) {
    let clonedSegmentId: string | null = null
    let trackEnd = 0
    const updatedTracks = data.tracks.map((track) => {
      if (track.id !== trackId) return track
      const result = cloneMultiTrackSegment(track.segments, segmentId)
      if (!result) return track
      clonedSegmentId = result.clonedSegmentId
      trackEnd = result.segments.reduce((max, segment) => Math.max(max, segment.end_frame), 0)
      return { ...track, segments: result.segments }
    })
    if (!clonedSegmentId) return
    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: Math.max(data.total_length, trackEnd),
    })
    setSingleSelectedSegment(clonedSegmentId)
  }

  function handleMergeSelectedTaskSegments() {
    const result = mergeSelectedTaskSegments(data.tracks, selectedSegmentIds)
    if (!result) return
    commitNormalizedTrackChange({
      ...data,
      tracks: result.tracks,
      total_length: calculateTotalLength(result.tracks, data.frame_rate),
    })
    setSingleSelectedSegment(result.mergedSegmentId)
  }

  function handleSplitTaskSegment(segmentId: string, targetFrames: number) {
    let splitSegmentIds: string[] = []
    const updatedTracks = data.tracks.map((track) => {
      if (track.type !== 'task' || !track.segments.some((segment) => segment.id === segmentId)) return track
      const result = splitMultiTrackSegmentByFrames(track.segments, segmentId, targetFrames)
      if (!result) return track
      splitSegmentIds = result.splitSegmentIds
      return { ...track, segments: result.segments }
    })
    if (splitSegmentIds.length === 0) return
    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
    setSelectedSegmentIds(new Set(splitSegmentIds))
    setSelectedSegmentId(splitSegmentIds[0] ?? null)
  }

  function buildResizedTrackData(sourceData: TrackData, segmentId: string, edge: 'start' | 'end', nextTime: number): TrackData {
    const resizedTracks = sourceData.tracks.map((track) => {
      if (track.type === 'task' && edge === 'end' && track.segments.some((segment) => segment.id === segmentId)) {
        return {
          ...track,
          segments: resizeTaskSegmentEnd(
            track.segments,
            segmentId,
            snapTimeToFrame(nextTime, sourceData.frame_rate),
          ),
        }
      }
      return {
        ...track,
        segments: track.segments.map((segment) => {
          if (segment.id !== segmentId) return segment
          const sortedSegments = [...track.segments].sort((a, b) => a.start_frame - b.start_frame)
          const segmentIndex = sortedSegments.findIndex((item) => item.id === segmentId)
          const prevSegment = segmentIndex > 0 ? sortedSegments[segmentIndex - 1] : null
          const nextSegment = segmentIndex >= 0 && segmentIndex < sortedSegments.length - 1
            ? sortedSegments[segmentIndex + 1]
            : null
          const hasReadableSlotSource = segment.content.source_type !== 'slot' || Boolean(segment.content.url)
          const sourceDuration = hasReadableSlotSource && segment.content.duration && segment.content.duration > 0
            ? Math.max(1, snapSecondsToFrame(segment.content.duration, sourceData.frame_rate))
            : Number.POSITIVE_INFINITY

          if (edge === 'start') {
            const nextStart = snapTimeToFrame(nextTime, sourceData.frame_rate)
            const minStart = Math.max(0, prevSegment?.end_frame ?? 0, segment.end_frame - sourceDuration)
            const maxStart = segment.end_frame - 1
            const startFrame = Math.max(minStart, Math.min(nextStart, maxStart))
            return {
              ...segment,
              start_frame: startFrame,
              ...(
                startFrame !== segment.start_frame && (track.type === 'video' || track.type === 'audio')
                  ? { origin_start_frame: segment.origin_start_frame ?? segment.start_frame }
                  : {}
              ),
            }
          }

          const nextEnd = snapTimeToFrame(nextTime, sourceData.frame_rate)
          const minEnd = segment.start_frame + 1
          const maxEnd = Math.min(nextSegment?.start_frame ?? Number.POSITIVE_INFINITY, segment.start_frame + sourceDuration)
          return {
            ...segment,
            end_frame: Math.max(minEnd, Math.min(nextEnd, maxEnd)),
          }
        }).sort((a, b) => a.start_frame - b.start_frame),
      }
    })
    const updatedTracks = syncMatchingTasksToPrimaryVideoSegment(
      sourceData.tracks,
      resizedTracks,
      segmentId,
    )
    return {
      ...sourceData,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, sourceData.frame_rate),
    }
  }

  function snappedResizeTime(segmentId: string, edge: 'start' | 'end', nextTime: number, brakeDistanceFrames: number): number {
    return snapEnabled
      ? snapMultiTrackResizeTime(committedData, segmentId, edge, nextTime, brakeDistanceFrames, currentTimeRef.current)
      : snapTimeToFrame(nextTime, committedData.frame_rate)
  }

  function handleResizeSegmentPreview(segmentId: string, edge: 'start' | 'end', nextTime: number, brakeDistanceFrames = 0) {
    setResizePreviewData(buildResizedTrackData(
      committedData,
      segmentId,
      edge,
      snappedResizeTime(segmentId, edge, nextTime, brakeDistanceFrames),
    ))
  }

  function handleResizeSegment(segmentId: string, edge: 'start' | 'end', nextTime: number, brakeDistanceFrames = 0) {
    setResizePreviewData(null)
    commitNormalizedTrackChange(buildResizedTrackData(
      committedData,
      segmentId,
      edge,
      snappedResizeTime(segmentId, edge, nextTime, brakeDistanceFrames),
    ))
  }

  function handleMoveSegment(segmentId: string, targetTrackId: string, nextStartTime: number) {
    const updatedTracks = selectedSegmentIds.has(segmentId)
      ? moveSelectedSegments(data.tracks, selectedSegmentIds, segmentId, targetTrackId, nextStartTime, data.frame_rate)
      : moveSegmentBetweenCompatibleTracks(data.tracks, segmentId, targetTrackId, nextStartTime, data.frame_rate)

    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
  }

  function handleGlobalSettingsChange(patch: Partial<Pick<TrackData, 'muted' | 'volume_db' | 'frame_rate'>>) {
    const nextFrameRate = patch.frame_rate
    if (typeof nextFrameRate === 'number' && nextFrameRate > 0 && nextFrameRate !== data.frame_rate) {
      const remapped = remapTrackDataFrameRate(data, nextFrameRate)
      const nextCurrentTime = remapFrameToRate(currentTimeRef.current, data.frame_rate, remapped.frame_rate)
      currentTimeRef.current = nextCurrentTime
      setCurrentTime(nextCurrentTime)
      commitNormalizedTrackChange({
        ...remapped,
        ...patch,
        frame_rate: remapped.frame_rate,
      })
      return
    }

    commitNormalizedTrackChange({ ...data, ...patch, frame_rate: data.frame_rate })
  }

  function handleSelectedSegmentContentChange(patch: Partial<MultiTrackSegmentContent>) {
    if (!selectedSegmentId) return
    if (selectedSegment?.trackType === 'subtitle' && patch.subtitle_style) {
      const { subtitle_style: subtitleStyle, ...selectedSegmentPatch } = patch
      const hasSelectedSegmentPatch = Object.keys(selectedSegmentPatch).length > 0
      const updatedTracks = data.tracks.map((track) => {
        if (track.id !== selectedSegment.trackId || track.type !== 'subtitle') return track
        return {
          ...track,
          segments: track.segments.map((segment) => ({
            ...segment,
            content: {
              ...segment.content,
              ...(hasSelectedSegmentPatch && segment.id === selectedSegmentId ? selectedSegmentPatch : {}),
              subtitle_style: subtitleStyle,
            },
          })),
        }
      })
      commitNormalizedTrackChange({
        ...data,
        tracks: updatedTracks,
      })
      return
    }
    commitNormalizedTrackChange(updateMultiTrackSegmentContent(data, selectedSegmentId, patch))
  }

  function handleTrackSegmentsContentChange(updates: Array<{ segmentId: string; patch: Partial<MultiTrackSegmentContent> }>) {
    const updateMap = new Map(updates.map((update) => [update.segmentId, update.patch]))
    const updatedTracks = data.tracks.map((track) => ({
      ...track,
      segments: track.segments.map((segment) => {
        const patch = updateMap.get(segment.id)
        if (!patch) return segment
        return {
          ...segment,
          content: {
            ...segment.content,
            ...patch,
          },
        }
      }),
    }))
    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
    })
  }

  // 项目栏「工作台」按钮：选中第一个任务片段并通知编辑器打开弹窗
  useEffect(() => {
    const openWorkspace = () => {
      // 声明弹窗归属本节点实例：避免多节点同时各开一层
      ;(globalThis as unknown as { __easyMediaWorkspaceModalOwner?: string }).__easyMediaWorkspaceModalOwner = workspaceInstanceId
      const taskTrack = data.tracks.find((track) => track.type === 'task')
      const firstSegment = taskTrack?.segments?.[0]
      if (firstSegment) handleSelectSegment(firstSegment.id, 'replace')
      setWorkspaceModalOpen(true)
    }
    openWorkspaceRef.current = openWorkspace
    const registry = globalThis as unknown as {
      __easyMediaOpenWorkspace?: () => void
      __easyMediaTimelineSummary?: () => { ratio: string; audio: string[]; video: string[] }
    }
    registry.__easyMediaOpenWorkspace = openWorkspace
    registry.__easyMediaTimelineSummary = () => ({
      ratio: String(resolutionRef.current?.aspect_ratio || ''),
      audio: data.tracks
        .filter((track) => track.type === 'audio')
        .flatMap((track) => track.segments.map((segment) => String(((segment.content as unknown as { file_name?: string; user_prompt?: string })?.file_name || (segment.content as unknown as { user_prompt?: string })?.user_prompt || '').split('\n')[0].slice(0, 40))))
        .filter(Boolean),
      video: data.tracks
        .filter((track) => track.type === 'video')
        .flatMap((track) => track.segments.map((segment) => String(((segment.content as unknown as { file_name?: string; user_prompt?: string })?.file_name || (segment.content as unknown as { user_prompt?: string })?.user_prompt || '').split('\n')[0].slice(0, 40))))
        .filter(Boolean),
    })
    return () => {
      if (registry.__easyMediaOpenWorkspace === openWorkspace) delete registry.__easyMediaOpenWorkspace
    }
  }, [data])

  // 片段 ✦ 或项目栏图标：统一打开节点层工作台（弹窗不随片段卸载）
  useEffect(() => {
    function open() {
      // 只让当前注册表持有者响应，避免多个节点实例各开一层弹窗
      const registry = globalThis as unknown as { __easyMediaOpenWorkspace?: () => void }
      if (registry.__easyMediaOpenWorkspace !== openWorkspaceRef.current) return
      openWorkspaceRef.current()
    }
    window.addEventListener('easy-media.workspace.open', open)
    return () => window.removeEventListener('easy-media.workspace.open', open)
  }, [])

  // 分镜编排：把规划结果落成任务轨片段（只由弹窗「应用到任务轨」调用）
  useEffect(() => {
    const applyStoryboard = (items: Array<{
      id?: string
      name: string
      durationFrames: number
      brief: string
      prompt?: string
      taskMode?: string
      continuityMode?: string
      refImageSize?: string
      stableKey?: string
    }>) => {
      const taskTrack = data.tracks.find((track) => track.type === 'task')
      if (!taskTrack || items.length === 0) return false
      let cursor = 0
      const stamp = Date.now()
      const existingSegments = taskTrack.segments ?? []
      const byKey = new Map<string, MultiTrackSegment>()
      const byIndex = new Map<number, MultiTrackSegment>()
      existingSegments.forEach((segment, index) => {
        const key = String((segment.content as unknown as { stable_key?: string })?.stable_key ?? '')
        if (key) byKey.set(key, segment)
        byIndex.set(index, segment)
      })
      const usedIds = new Set<string>()
      const segments: MultiTrackSegment[] = items.map((item, index) => {
        const stableKey = item.stableKey || `sk-${index + 1}`
        const matched = byKey.get(stableKey) ?? byIndex.get(index)
        if (matched) usedIds.add(matched.id)
        const previous = (matched?.content ?? {}) as Record<string, unknown>
        const frames = Math.max(1, Math.round(item.durationFrames))
        const start = cursor
        cursor += frames
        return {
          id: item.id || matched?.id || `task-${stamp}-${index + 1}`,
          start_frame: start,
          end_frame: start + frames,
          color: matched?.color ?? taskTrack.color ?? 'var(--primary)',
          content: {
            ...previous,
            media_type: 'none',
            stable_key: stableKey,
            task_mode: (item.taskMode as never) ?? (previous.task_mode as never) ?? 'default',
            continuity_mode: (item.continuityMode as never) ?? (previous.continuity_mode as never) ?? undefined,
            ref_image_size: (item.refImageSize as never) ?? (previous.ref_image_size as never) ?? undefined,
            user_brief: item.brief,
            user_prompt: item.prompt ?? String(previous.user_prompt ?? ''),
            user_prompt_b: previous.user_prompt_b,
            user_prompt_variant: previous.user_prompt_variant ?? 'a',
          },
        } as unknown as MultiTrackSegment
      })
      // 孤儿段（脚本里已不存在）保留在末尾，不自动删除
      const orphans = existingSegments.filter((segment) => !usedIds.has(segment.id))
      if (orphans.length > 0) {
        segments.push(...orphans.map((segment) => ({ ...segment })))
      }
      const updatedTracks = data.tracks.map((track) => (
        track.id === taskTrack.id ? { ...track, segments } : track
      ))
      commitNormalizedTrackChange({
        ...data,
        tracks: updatedTracks,
        total_length: calculateTotalLength(updatedTracks, data.frame_rate),
      })
      // 旧片段已被替换，选中态必须指向新片段，否则编辑器会因选中失效而卸载（弹窗随之关闭）
      const firstNewId = segments[0]?.id
      if (firstNewId) {
        setSelectedTaskMarkerId(null)
        setSelectedSegmentIds(new Set([firstNewId]))
        setSelectedSegmentId(firstNewId)
      }
      return true
    }
    const registry = globalThis as unknown as { __easyMediaApplyStoryboard?: typeof applyStoryboard }
    registry.__easyMediaApplyStoryboard = applyStoryboard
    return () => {
      if (registry.__easyMediaApplyStoryboard === applyStoryboard) {
        delete registry.__easyMediaApplyStoryboard
      }
    }
  }, [data])

  // 写入通道：把④产出的最终提示词与段设置写进指定任务轨片段（按 A/B variant）
  useEffect(() => {
    const updateSegment = (
      segmentId: string,
      payload: {
        prompt?: string
        variant?: 'a' | 'b'
        taskMode?: string
        continuityMode?: string
        refImageSize?: string
        images?: Array<{ name: string; subfolder?: string }>
      },
    ) => {
      const taskTrack = data.tracks.find((track) => track.type === 'task')
      const segment = taskTrack?.segments.find((item) => item.id === segmentId)
      if (!segment) return false
      const patch: Record<string, unknown> = {}
      if (typeof payload.prompt === 'string') {
        if (payload.variant === 'b') patch.user_prompt_b = payload.prompt
        else patch.user_prompt = payload.prompt
      }
      if (payload.variant) patch.user_prompt_variant = payload.variant
      if (payload.taskMode) patch.task_mode = payload.taskMode
      if (payload.continuityMode) patch.continuity_mode = payload.continuityMode
      if (payload.refImageSize) patch.ref_image_size = payload.refImageSize
      if (payload.images) {
        const stamp = Date.now()
        patch.images = payload.images.map((item, index) => ({
          id: `img-${stamp}-${index + 1}`,
          source_type: 'input',
          file_name: item.name,
          subfolder: item.subfolder ?? '',
        }))
      }
      patchTaskSegmentContent(segmentId, patch)
      return true
    }
    const registry = globalThis as unknown as { __easyMediaUpdateSegment?: typeof updateSegment }
    registry.__easyMediaUpdateSegment = updateSegment
    return () => {
      if (registry.__easyMediaUpdateSegment === updateSegment) {
        delete registry.__easyMediaUpdateSegment
      }
    }
  })

  // 写入通道（W2/W4）：音视频/字幕落轨 + 一体化保存（单次提交，撤销单步）
  useEffect(() => {
    type AssetItem = {
      name: string
      subfolder?: string
      sourceType?: 'input' | 'output'
      trackRole?: string
      trackName?: string
      volumeDb?: number
    }
    type SavePayload = {
      audio: AssetItem[]
      video: AssetItem[]
      subtitleEnabled?: boolean
      subtitleVariant?: 'a' | 'b'
    }

    /** 在给定轨道副本上落音频/视频/字幕，返回新轨道数组（不提交） */
    const buildAssetTracks = (
      tracksIn: MultiTrack[],
      segment: MultiTrackSegment,
      payload: SavePayload,
      stamp: number,
    ): MultiTrack[] => {
      let tracks = [...tracksIn]
      const start = segment.start_frame
      const end = segment.end_frame

      const ensureTrack = (name: string, type: 'audio' | 'video' | 'subtitle', muted: boolean) => {
        const found = tracks.find((track) => track.type === type && track.name === name)
        if (found) return found
        const created: MultiTrack = {
          id: `track-${type}-${stamp}-${tracks.length + 1}`,
          name,
          type,
          color: 'var(--primary)',
          muted,
          locked: false,
          segments: [],
        }
        tracks = [...tracks, created]
        return created
      }

      const upsertSegment = (track: MultiTrack, item: AssetItem, mediaType: 'audio' | 'video') => {
        const stableKey = `asset-${segment.id}-${mediaType}-${item.trackRole ?? 'video'}-${item.name}`
        const content: Record<string, unknown> = {
          media_type: mediaType,
          source_type: item.sourceType ?? 'input',
          file_name: item.name,
          subfolder: item.subfolder ?? '',
          stable_key: stableKey,
          asset_kind: 'reference',
        }
        if (mediaType === 'audio') {
          content.volume_db = item.volumeDb ?? 0
        }
        const newSegment = {
          id: `seg-${mediaType}-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
          start_frame: start,
          end_frame: end,
          content: content as unknown as MultiTrackSegment['content'],
          color: track.color ?? 'var(--primary)',
        } as MultiTrackSegment
        tracks = tracks.map((current) => (
          current.id === track.id
            ? {
                ...current,
                segments: [
                  ...current.segments.filter((existing) => (
                    (existing.content as unknown as { stable_key?: string })?.stable_key !== stableKey
                  )),
                  newSegment,
                ],
              }
            : current
        ))
      }

      for (const item of payload.audio) {
        const role = item.trackRole ?? 'voice'
        const trackName = item.trackName || `音频·${role}`
        const track = ensureTrack(trackName, 'audio', role === 'reference')
        upsertSegment(track, item, 'audio')
      }
      for (const item of payload.video) {
        const track = tracks.find((current) => current.type === 'video' && current.name === '视频')
          ?? ensureTrack('视频', 'video', false)
        upsertSegment(track, item, 'video')
      }

      // 字幕（按导演台设置抽取台词，按字数比例分配时间，幂等）
      if (payload.subtitleEnabled) {
        const projectKey = data.project?.name ?? 'default'
        const settings = readDirectorSettings(projectKey)
        const store = readWorkspace(projectKey)
        const lines: Array<{ text: string; speaker?: string }> = []
        if (settings.subtitle.fromDialogue) {
          const plan = store.plan as { segments?: Array<{ shots?: Array<Record<string, unknown>> }> } | null
          const stableKey = String((segment.content as unknown as { stable_key?: string })?.stable_key ?? '')
          const planIndex = Number.parseInt(stableKey.replace(/^sk-/, ''), 10)
          const planSegment = Number.isFinite(planIndex) ? plan?.segments?.[planIndex - 1] : undefined
          for (const shot of planSegment?.shots ?? []) {
            const dialogue = (shot as { dialogue?: Array<{ speaker?: string; line?: string }> }).dialogue ?? []
            for (const entry of dialogue) {
              const raw = String(entry.line ?? '').trim()
              if (!raw) continue
              for (const part of raw.split(/(?<=[。！？；…])/).map((item) => item.trim()).filter(Boolean)) {
                lines.push({ text: part, speaker: entry.speaker })
              }
            }
          }
        }
        if (settings.subtitle.fromTaggedDescription) {
          const boundIds = store.bindings?.[`${segment.id}:${payload.subtitleVariant ?? 'a'}`] ?? []
          for (const subject of (store.resources ?? []).filter((item) => item.type === 'Subject' && boundIds.includes(item.id))) {
            for (const match of (subject.description ?? '').matchAll(/<#([^:>]+):([^>]+)>/g)) {
              lines.push({ speaker: match[1].trim(), text: match[2].trim() })
            }
          }
        }
        const cleaned = lines
          .map((line) => ({
            speaker: line.speaker,
            text: line.text.replace(/<\/?d>/g, '').replace(/[“”"]/g, '').trim(),
          }))
          .filter((line) => line.text.length > 0)
        if (cleaned.length > 0) {
          const track = ensureTrack('字幕', 'subtitle', false)
          const total = Math.max(1, end - start)
          const weights = cleaned.map((line) => Math.max(1, line.text.length))
          const weightSum = weights.reduce((acc, value) => acc + value, 0)
          let durations = weights.map((value) => Math.max(24, Math.round((total * value) / weightSum)))
          if (durations.reduce((acc, value) => acc + value, 0) > total) {
            durations = weights.map((value) => Math.max(1, Math.round((total * value) / weightSum)))
          }
          const subtitleSegments: MultiTrackSegment[] = []
          let cursor = start
          cleaned.forEach((line, index) => {
            const duration = durations[index]
            const text = settings.subtitle.keepSpeaker && line.speaker ? `${line.speaker}：${line.text}` : line.text
            subtitleSegments.push({
              id: `seg-sub-${stamp}-${index}`,
              start_frame: cursor,
              end_frame: Math.min(end, cursor + duration),
              content: {
                media_type: 'subtitle',
                text,
                stable_key: `sub-${segment.id}-${index}`,
                subtitle_style: {
                  font_size: settings.subtitle.style.font_size,
                  color: settings.subtitle.style.color,
                  outline_color: settings.subtitle.style.outline_color,
                  background_color: '#000000',
                  background_opacity: settings.subtitle.style.background_opacity,
                  x: 0.5,
                  y: settings.subtitle.style.y,
                  width: 0.9,
                },
              } as unknown as MultiTrackSegment['content'],
              color: track.color ?? 'var(--primary)',
            } as MultiTrackSegment)
            cursor += duration
          })
          const prefix = `sub-${segment.id}-`
          tracks = tracks.map((current) => (
            current.id === track.id
              ? {
                  ...current,
                  segments: [
                    ...current.segments.filter((existing) => !String((existing.content as unknown as { stable_key?: string })?.stable_key ?? '').startsWith(prefix)),
                    ...subtitleSegments,
                  ],
                }
              : current
          ))
        }
      }
      return tracks
    }

    /** 一体化保存：任务段 patch + 音视频/字幕落轨，单次提交（撤销单步） */
    const applyAll = (
      segmentId: string,
      payload: SavePayload & {
        prompt?: string
        variant?: 'a' | 'b'
        taskMode?: string
        continuityMode?: string
        refImageSize?: string
        images?: Array<{ name: string; subfolder?: string }>
      },
    ) => {
      const taskTrack = data.tracks.find((track) => track.type === 'task')
      const segment = taskTrack?.segments.find((item) => item.id === segmentId)
      if (!taskTrack || !segment) return false
      const stamp = Date.now()
      let tracks = [...data.tracks]
      const patch: Record<string, unknown> = {}
      if (typeof payload.prompt === 'string') {
        if (payload.variant === 'b') patch.user_prompt_b = payload.prompt
        else patch.user_prompt = payload.prompt
      }
      if (payload.variant) patch.user_prompt_variant = payload.variant
      if (payload.taskMode) patch.task_mode = payload.taskMode
      if (payload.continuityMode) patch.continuity_mode = payload.continuityMode
      if (payload.refImageSize) patch.ref_image_size = payload.refImageSize
      if (payload.images) {
        patch.images = payload.images.map((item, index) => ({
          id: `img-${stamp}-${index + 1}`,
          source_type: 'input',
          file_name: item.name,
          subfolder: item.subfolder ?? '',
        }))
      }
      tracks = tracks.map((track) => (
        track.id === taskTrack.id
          ? {
              ...track,
              segments: track.segments.map((item) => (
                item.id === segmentId
                  ? { ...item, content: { ...item.content, ...patch } as MultiTrackSegment['content'] }
                  : item
              )),
            }
          : track
      ))
      const patchedSegment = tracks
        .find((track) => track.id === taskTrack.id)
        ?.segments.find((item) => item.id === segmentId)
      if (!patchedSegment) return false
      tracks = buildAssetTracks(tracks, patchedSegment, payload, stamp)
      commitNormalizedTrackChange({
        ...data,
        tracks,
        total_length: calculateTotalLength(tracks, data.frame_rate),
      })
      return true
    }

    /** 兼容旧入口：仅落音视频/字幕 */
    const saveTracks = (segmentId: string, payload: SavePayload) => {
      const taskTrack = data.tracks.find((track) => track.type === 'task')
      const segment = taskTrack?.segments.find((item) => item.id === segmentId)
      if (!segment) return false
      const tracks = buildAssetTracks([...data.tracks], segment, payload, Date.now())
      commitNormalizedTrackChange({
        ...data,
        tracks,
        total_length: calculateTotalLength(tracks, data.frame_rate),
      })
      return true
    }

    const registry = globalThis as unknown as {
      __easyMediaSaveTracks?: typeof saveTracks
      __easyMediaApplyAll?: typeof applyAll
    }
    registry.__easyMediaSaveTracks = saveTracks
    registry.__easyMediaApplyAll = applyAll
    return () => {
      if (registry.__easyMediaSaveTracks === saveTracks) delete registry.__easyMediaSaveTracks
      if (registry.__easyMediaApplyAll === applyAll) delete registry.__easyMediaApplyAll
    }
  })

  function patchTaskSegmentContent(segmentId: string, patch: Record<string, unknown>) {
    const taskTrack = data.tracks.find((track) => track.type === 'task')
    if (!taskTrack) return
    const updatedTracks = data.tracks.map((track) => (
      track.id === taskTrack.id
        ? {
            ...track,
            segments: track.segments.map((segment) => (
              segment.id === segmentId
                ? { ...segment, content: { ...segment.content, ...patch } as MultiTrackSegment['content'] }
                : segment
            )),
          }
        : track
    ))
    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
  }

  function attachTaskSegmentImages(segmentId: string, items: Array<{ name: string; subfolder: string }>) {
    const taskTrack = data.tracks.find((track) => track.type === 'task')
    const segment = taskTrack?.segments.find((item) => item.id === segmentId)
    if (!segment) return
    const current = ((segment.content as unknown as { images?: unknown[] }).images ?? []) as unknown[]
    const stamp = Date.now()
    const appended = items.map((item, index) => ({
      id: `img-${stamp}-${index + 1}`,
      source_type: 'input',
      file_name: item.name,
      subfolder: item.subfolder || undefined,
    }))
    patchTaskSegmentContent(segmentId, { images: [...current, ...appended] })
  }

  function handleTaskTrackSegmentsChange(segments: MultiTrackSegment[]) {
    if (selectedSegment?.trackType !== 'task') return
    const updatedTracks = data.tracks.map((track) => (
      track.id === selectedSegment.trackId ? { ...track, segments } : track
    ))
    commitNormalizedTrackChange({
      ...data,
      tracks: updatedTracks,
      total_length: calculateTotalLength(updatedTracks, data.frame_rate),
    })
  }

  function handleSelectedSegmentDurationChange(duration: number) {
    if (!selectedSegmentId) return
    commitNormalizedTrackChange(updateMultiTrackSegmentDuration(data, selectedSegmentId, duration, data.frame_rate))
  }

  async function handleSmartSplit(segmentId: string) {
    const segment = data.tracks
      .find((track) => track.type === 'video' && track.segments.some((item) => item.id === segmentId))
      ?.segments.find((item) => item.id === segmentId)
    if (!segment || isSmartSplitting) return

    setIsPlaying(false)
    setIsSmartSplitting(true)
    try {
      const result = await requestSmartSplit(segment, data.frame_rate)
      commitNormalizedTrackChange(applySmartSplit(data, segmentId, result))
    } catch (error) {
      if (error instanceof MissingModelError) {
        setMissingModel(error.model)
        setModelDownloadError(null)
        return
      }
      console.error('[MultiTrackWidget] smart split failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      try {
        app.extensionManager.toast.add({
          severity: 'error',
          summary: t('multitrack.smartSplitFailed'),
          detail: message,
          life: 5000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show smart split error:', toastError)
      }
    } finally {
      setIsSmartSplitting(false)
    }
  }

  async function handleSmartSplitTasks(segmentId: string) {
    const segment = data.tracks
      .find((track) => track.type === 'video' && track.segments.some((item) => item.id === segmentId))
      ?.segments.find((item) => item.id === segmentId)
    if (!segment || isSmartSplitting) return
    if (!hasMatchingTaskSegment(data, segmentId)) {
      try {
        app.extensionManager.toast.add({
          severity: 'warn',
          summary: t('multitrack.smartSplitTasksOnly'),
          detail: t('multitrack.noMatchingTaskSegment'),
          life: 4000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show task split warning:', toastError)
      }
      return
    }

    setIsPlaying(false)
    setIsSmartSplitting(true)
    try {
      const result = await requestSmartSplit(segment, data.frame_rate)
      commitNormalizedTrackChange(applySmartSplitToMatchingTasks(data, segmentId, result))
    } catch (error) {
      if (error instanceof MissingModelError) {
        setMissingModel(error.model)
        setModelDownloadError(null)
        return
      }
      console.error('[MultiTrackWidget] task-only smart split failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      try {
        app.extensionManager.toast.add({
          severity: 'error',
          summary: t('multitrack.smartSplitFailed'),
          detail: message,
          life: 5000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show smart split error:', toastError)
      }
    } finally {
      setIsSmartSplitting(false)
    }
  }

  async function handleRecognizeSubtitles(segmentId: string, method: SubtitleRecognitionMethod) {
    const segment = data.tracks
      .find((track) => (track.type === 'video' || track.type === 'audio') && track.segments.some((item) => item.id === segmentId))
      ?.segments.find((item) => item.id === segmentId)
    if (!segment || isRecognizingSubtitles) return

    setIsPlaying(false)
    setIsRecognizingSubtitles(true)
    try {
      const result = await requestSubtitleRecognition(segment, data.frame_rate, method)
      commitNormalizedTrackChange(applySubtitleRecognition(data, segmentId, result))
    } catch (error) {
      if (error instanceof MissingModelError) {
        setMissingModel(error.model)
        setModelDownloadError(null)
        return
      }
      console.error('[MultiTrackWidget] subtitle recognition failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      try {
        app.extensionManager?.toast?.add({
          severity: 'error',
          summary: t('multitrack.subtitleRecognitionFailed'),
          detail: message,
          life: 5000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show subtitle recognition error:', toastError)
      }
    } finally {
      setIsRecognizingSubtitles(false)
    }
  }

  async function handleGenerateSubtitleSpeech(
    segment: MultiTrackSegment,
    settings: SubtitleSpeechSettings,
  ) {
    if (segment.content.media_type !== 'subtitle') return
    setIsPlaying(false)
    try {
      const result = await requestSubtitleSpeechAudio({
        ...settings,
        text: segment.content.text ?? '',
      })
      invalidateMediaListCache('outputs')
      const latestData = dataRef.current
      commitNormalizedTrackChange(applySubtitleSpeechAudio(latestData, {
        subtitleSegmentId: segment.id,
        startFrame: segment.start_frame,
        endFrame: segment.end_frame,
        filePath: result.filePath,
        duration: result.duration,
      }))
      try {
        app.extensionManager?.toast?.add({
          severity: 'success',
          summary: t('multitrack.subtitleSpeechComplete'),
          detail: result.message || t('multitrack.subtitleSpeechSaved', { path: result.absolutePath || result.filePath }),
          life: 5000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show subtitle speech success:', toastError)
      }
    } catch (error) {
      if (error instanceof MissingModelError) {
        setMissingModel(error.model)
        setModelDownloadError(null)
        return
      }
      console.error('[MultiTrackWidget] subtitle speech generation failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      try {
        app.extensionManager?.toast?.add({
          severity: 'error',
          summary: t('multitrack.subtitleSpeechFailed'),
          detail: message,
          life: 5000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show subtitle speech error:', toastError)
      }
    }
  }

  function handleCutSegment(segmentId: string, splitFrame: number) {
    commitNormalizedTrackChange(splitTrackSegmentAtFrame(data, segmentId, splitFrame))
  }

  function handleCutAtCurrentTime() {
    const splitFrame = snapTimeToFrame(currentTime, data.frame_rate)
    const targetSegmentIds = selectedSegmentIds.size > 0
      ? Array.from(selectedSegmentIds)
      : data.tracks.flatMap((track) => (
        track.segments
          .filter((segment) => splitFrame > segment.start_frame && splitFrame < segment.end_frame)
          .map((segment) => segment.id)
      ))
    if (targetSegmentIds.length === 0) return

    const originalSegmentCount = data.tracks.reduce((count, track) => count + track.segments.length, 0)
    const nextData = targetSegmentIds.reduce(
      (currentData, segmentId) => splitTrackSegmentAtFrame(currentData, segmentId, splitFrame),
      data,
    )
    const nextSegmentCount = nextData.tracks.reduce((count, track) => count + track.segments.length, 0)
    if (nextSegmentCount === originalSegmentCount) return

    commitNormalizedTrackChange(nextData)
  }

  function getTrimTargetSegmentIds(trimFrame: number): string[] {
    const candidateSegmentIds = selectedSegmentIds.size > 0
      ? selectedSegmentIds
      : new Set(data.tracks.flatMap((track) => track.segments.map((segment) => segment.id)))

    return data.tracks.flatMap((track) => (
      track.segments
        .filter((segment) => (
          candidateSegmentIds.has(segment.id) &&
          trimFrame > segment.start_frame &&
          trimFrame < segment.end_frame
        ))
        .map((segment) => segment.id)
    ))
  }

  function canTrimAtCurrentTime(): boolean {
    const trimFrame = snapTimeToFrame(currentTime, data.frame_rate)
    return getTrimTargetSegmentIds(trimFrame).length > 0
  }

  function handleTrimAtCurrentTime(edge: 'start' | 'end') {
    const trimFrame = snapTimeToFrame(currentTime, data.frame_rate)
    const targetSegmentIds = getTrimTargetSegmentIds(trimFrame)
    if (targetSegmentIds.length === 0) return

    const nextData = targetSegmentIds.reduce(
      (currentData, segmentId) => buildResizedTrackData(currentData, segmentId, edge, trimFrame),
      data,
    )
    commitNormalizedTrackChange(nextData)
  }

  async function handleDownloadMissingModel() {
    if (!missingModel || isDownloadingModel) return
    setIsDownloadingModel(true)
    setModelDownloadError(null)
    try {
      const downloadedModel = await downloadEasyMediaModel(missingModel.name)
      setMissingModel(null)
      try {
        app.extensionManager?.toast?.add({
          severity: 'success',
          summary: t('modelDownload.downloadComplete'),
          detail: t('modelDownload.downloadCompleteDetail', { name: downloadedModel.display_name }),
          life: 5000,
        })
      } catch (toastError) {
        console.error('[MultiTrackWidget] failed to show model download success:', toastError)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setModelDownloadError(message)
    } finally {
      setIsDownloadingModel(false)
    }
  }

  function handleManualDownload() {
    if (!missingModel) return
    for (const url of missingModel.urls ?? [missingModel.url]) {
      globalThis.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <LocaleContext.Provider value={locale}>
      <TooltipProvider>
        <div
          className="relative flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden rounded text-foreground font-sans text-xs select-none"
          aria-busy={isSmartSplitting || isRecognizingSubtitles}
        >
          <PreviewArea
            data={data}
            currentTime={currentTime}
            selectedSegment={previewSelectedSegment}
            isPlaying={isPlaying}
            playbackNonce={syncPlayNonce}
            node={node}
            app={app}
            editingSubtitleSegmentId={editingSubtitleSegmentId}
            onSubtitleEditRequestHandled={() => setEditingSubtitleSegmentId(null)}
            onSelectSegment={(segmentId) => handleSelectSegment(segmentId)}
            onGlobalSettingsChange={handleGlobalSettingsChange}
            onSelectedSegmentContentChange={handleSelectedSegmentContentChange}
            taskSegments={selectedTaskTrackSegments}
            selectedTaskSegments={hasOnlySelectedTaskSegments ? selectedTaskSegments : undefined}
            onTrackSegmentsContentChange={handleTrackSegmentsContentChange}
            onTaskTrackSegmentsChange={handleTaskTrackSegmentsChange}
            onSelectedSegmentDurationChange={handleSelectedSegmentDurationChange}
            onGenerateSubtitleSpeech={handleGenerateSubtitleSpeech}
          />
          <ProjectBar
            app={app}
            t={t}
            data={data}
            resolution={resolutionInput}
            onApply={applyProjectTimeline}
          />

      {workspaceModalOpen && (globalThis as unknown as { __easyMediaWorkspaceModalOwner?: string }).__easyMediaWorkspaceModalOwner === workspaceInstanceId ? (
        <PromptEnhancerModal
          initialBrief=""
          initialResult=""
          onApply={() => {}}
          onClose={() => {
            setWorkspaceModalOpen(false)
            const registry = globalThis as unknown as { __easyMediaWorkspaceModalOwner?: string }
            if (registry.__easyMediaWorkspaceModalOwner === workspaceInstanceId) registry.__easyMediaWorkspaceModalOwner = undefined
          }}
          workspaceSegments={data.tracks.find((track) => track.type === 'task')?.segments ?? []}
          workspaceFrameRate={data.frame_rate}
          segmentId={selectedSegmentId ?? undefined}
          onActivateSegment={(id) => handleSelectSegment(id, 'replace')}
          onWriteSegmentPrompt={(id, prompt) => patchTaskSegmentContent(id, { user_prompt: prompt })}
          onAttachImages={(id, images) => attachTaskSegmentImages(id, images)}
        />
      ) : null}
          <MultiTrackToolbar
            currentTime={currentTime}
            totalLength={data.total_length}
            frameRate={data.frame_rate}
            isPlaying={isPlaying}
            zoom={zoom}
            snapEnabled={snapEnabled}
            taskOverview={taskOverview}
            timelineCollapsed={timelineCollapsed}
            onPlayPause={() => setIsPlaying((value) => !value)}
            onZoomChange={setZoom}
            onSnapEnabledChange={setSnapEnabled}
            canAddTaskMarker={canAddTaskMarkerAtCurrentTime()}
            onAddTaskMarker={handleAddTaskMarker}
            onTaskOverviewChange={handleTaskOverviewChange}
            onToggleTimeline={() => setTimelineCollapsed((collapsed) => !collapsed)}
            canDelete={selectedSegmentIds.size > 0}
            onDeleteSelected={() => {
              if (selectedSegmentId) handleDeleteSegment(selectedSegmentId)
            }}
            onCutAtCurrentTime={handleCutAtCurrentTime}
            canTrimCenter={canTrimAtCurrentTime()}
            canTrimLeft={canTrimAtCurrentTime()}
            canTrimRight={canTrimAtCurrentTime()}
            onTrimLeftAtCurrentTime={() => handleTrimAtCurrentTime('start')}
            onTrimRightAtCurrentTime={() => handleTrimAtCurrentTime('end')}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undoTrackChange}
            onRedo={redoTrackChange}
          />
          <div
            data-testid="multitrack-timeline-panel"
            aria-hidden={timelineCollapsed}
            className={`grid shrink-0 transition-[grid-template-rows] duration-300 ease-in-out ${timelineCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}
          >
            <div className="min-h-0 shrink-0 overflow-hidden">
              <div ref={timelineContainerRef} data-testid="multitrack-timeline-scroll" className="no-scrollbar shrink-0 overflow-x-auto overflow-y-hidden">
                <div className="min-h-full" style={{ width: scaledTimelineWidth, minWidth: '100%' }}>
                  <MultiTrackRuler
                    totalLength={data.total_length}
                    frameRate={data.frame_rate}
                    width={scaledTimelineWidth}
                    canvasScale={canvasScale}
                    currentTime={currentTime}
                    taskMarkers={data.task_markers ?? []}
                    selectedTaskMarkerId={selectedTaskMarkerId}
                    onSeek={setPlayheadTime}
                    onScrubStart={() => setIsScrubbing(true)}
                    onScrubEnd={() => setIsScrubbing(false)}
                    onSelectTaskMarker={(markerId) => {
                      setSingleSelectedSegment(null)
                      setSelectedTaskMarkerId(markerId)
                    }}
                    onMoveTaskMarker={handleMoveTaskMarker}
                    onDeleteTaskMarker={handleDeleteTaskMarker}
                  />
                  <TrackArea
                    data={data}
                    node={node}
                    app={app}
                    width={scaledTimelineWidth}
                    currentTime={currentTime}
                    snapEnabled={snapEnabled}
                    canvasScale={canvasScale}
                    selectedSegmentIds={selectedSegmentIds}
                    taskOverview={taskOverview}
                    onAddVideo={handleAddVideo}
                    onAddAudio={handleAddAudio}
                    onReplaceAudio={handleReplaceAudio}
                    onAddTrack={handleAddTrack}
                    onAddSubtitleSegment={handleAddSubtitleSegment}
                    onImportSubtitles={handleImportSubtitles}
                    onReplaceVideo={handleReplaceVideo}
                    onAddTaskSegment={handleAddTaskSegment}
                    onSelectSegment={handleSelectSegment}
                    onSelectSegments={handleSelectSegments}
                    onClearSelection={handleClearSelection}
                    onDeleteSegment={handleDeleteSegment}
                    onDeleteTrack={handleDeleteTrack}
                    onReorderTrack={handleReorderTrack}
                    onTrackVisibilityChange={handleTrackVisibilityChange}
                    onTrackAudioSettingsChange={handleTrackAudioSettingsChange}
            onSegmentContentChange={handleSegmentContentChange}
                    onSharedReferenceChange={handleSharedReferenceChange}
              onReferenceModeChange={handleReferenceModeChange}
                    onDistributeTaskSegments={handleDistributeTaskSegments}
                    onCloneTaskSegment={handleCloneSegment}
                    canMergeSelectedTaskSegments={canMergeSelectedTaskSegments}
                    onMergeSelectedTaskSegments={handleMergeSelectedTaskSegments}
                    onSplitTaskSegment={setSplittingTaskSegmentId}
                    onResizeSegment={handleResizeSegment}
                    onResizeSegmentPreview={handleResizeSegmentPreview}
                    onMoveSegment={handleMoveSegment}
                    onSmartSplit={handleSmartSplit}
                    onSmartSplitTasks={handleSmartSplitTasks}
                    onRecognizeSubtitles={handleRecognizeSubtitles}
                    onEditSubtitleSegment={setEditingSubtitleSegmentId}
                    cutMode={false}
                    onCutSegment={handleCutSegment}
                    format={resolutionInput.format}
                  />
                </div>
              </div>
            </div>
          </div>
          {isSmartSplitting ? (
            <div
              className="absolute inset-0 z-50 flex items-center justify-center bg-background/80"
              data-testid="smart-split-overlay"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-2 rounded border border-border bg-background px-3 py-2 text-foreground shadow-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('multitrack.smartSplitting')}</span>
              </div>
            </div>
          ) : null}
          {isRecognizingSubtitles ? (
            <div
              className="absolute inset-0 z-50 flex items-center justify-center bg-background/80"
              data-testid="subtitle-recognition-overlay"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-2 rounded border border-border bg-background px-3 py-2 text-foreground shadow-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('multitrack.recognizingSubtitles')}</span>
              </div>
            </div>
          ) : null}
          <SplitTaskSegmentDialog
            segment={splittingTaskSegment}
            frameRate={data.frame_rate}
            open={Boolean(splittingTaskSegmentId)}
            onOpenChange={(open) => {
              if (!open) setSplittingTaskSegmentId(null)
            }}
            onConfirm={handleSplitTaskSegment}
          />
          {missingModel ? (
            <div
              className="absolute inset-0 z-[60] flex items-center justify-center bg-background/90 p-4"
              data-testid="missing-model-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="missing-model-title"
            >
              <div className="w-full max-w-md rounded border border-border bg-background p-4 text-foreground shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 id="missing-model-title" className="text-sm font-semibold">
                      {t('modelDownload.title', { name: missingModel.display_name })}
                    </h3>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {t('modelDownload.description', {
                        name: missingModel.display_name,
                        directory: missingModelDirectoryName,
                      })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setMissingModel(null)}
                    aria-label={t('modelDownload.close')}
                    disabled={isDownloadingModel}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-3 rounded border border-border bg-muted px-2 py-1.5 font-mono text-[8px] leading-4 text-foreground break-all">
                  {missingModel.path}
                </div>
                {modelDownloadError ? (
                  <p className="mt-3 text-xs leading-5 text-destructive">{modelDownloadError}</p>
                ) : null}
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleManualDownload}
                    disabled={isDownloadingModel}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('modelDownload.manual')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleDownloadMissingModel}
                    disabled={isDownloadingModel}
                  >
                    {isDownloadingModel ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {isDownloadingModel ? t('modelDownload.downloading') : t('modelDownload.auto')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </TooltipProvider>
    </LocaleContext.Provider>
  )
}
