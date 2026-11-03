import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  CAMERA_EASINGS,
  CAMERA_PRESETS,
  compileCameraPrompt,
  normalizeCamera,
  cameraPresetLabel,
} from '@/lib/camera-presets'
import { getSegmentTrackPresentation } from '@/lib/multitrack-segment-style'
import { installOmniCamChinese, uninstallOmniCamChinese } from '@/lib/omnicam-zh'
import { MonitorCompileDialog } from './MonitorCompileDialog'
import { ExtractMotionDialog } from './ExtractMotionDialog'
import type { CameraData, CameraEasing, CameraKeyframe, CameraPreset, MultiTrackSegment } from '@/types/multitrack'

type ComfyGraphLike = {
  _nodes?: Array<Record<string, unknown>>
  add?: (node: unknown) => void
  setDirtyCanvas?: (a: boolean, b: boolean) => void
}
type ComfyCanvasLike = {
  graph?: ComfyGraphLike
  centerOnNode?: (node: unknown) => void
  setDirty?: (a: boolean, b: boolean) => void
}
type ComfyAppLike = { graph?: ComfyGraphLike; canvas?: ComfyCanvasLike; rootGraphInternal?: ComfyGraphLike }
type LiteGraphLike = { createNode?: (type: string) => Record<string, unknown> | null }

/**
 * 新版 ComfyUI 前端（Vue）只暴露 globalThis.comfyAPI.app.app；
 * 旧版是 window.app / window.LiteGraph。两条链都试，避免静默失败。
 */
function resolveComfyGraph(): {
  app: ComfyAppLike | undefined
  graph: ComfyGraphLike | undefined
  liteGraph: LiteGraphLike | undefined
} {
  const registry = globalThis as unknown as {
    comfyAPI?: {
      app?: { app?: ComfyAppLike }
      litegraph?: { LiteGraph?: LiteGraphLike }
    }
    app?: ComfyAppLike
    LiteGraph?: LiteGraphLike
  }
  const app = registry.comfyAPI?.app?.app ?? registry.app
  const graph = app?.rootGraphInternal ?? app?.canvas?.graph ?? app?.graph
  const liteGraph = registry.LiteGraph ?? registry.comfyAPI?.litegraph?.LiteGraph
  return { app, graph, liteGraph }
}

type DirectorViewLike = {
  container?: HTMLElement
  show?: () => Promise<unknown>
  hide?: () => boolean
  expand?: (anchor?: Element | null) => Promise<unknown>
}
type DirectorRuntimeLike = {
  inlineView?: DirectorViewLike
  restoreFromWidgetsHeadless?: () => void
  state?: { duration_frames?: number }
  shell?: { root?: HTMLElement; recordButton?: HTMLButtonElement; openButton?: HTMLButtonElement; secondaryButton?: HTMLButtonElement }
}

function getDirectorRuntime(node: Record<string, unknown> | null | undefined): DirectorRuntimeLike | undefined {
  if (!node) return undefined
  return (node as { __majoorOmniCamDirectorRuntime?: DirectorRuntimeLike }).__majoorOmniCamDirectorRuntime
}

const OMNICAM_DIRECTOR_TYPE = 'MajoorOmniCamDirector'

function findDirectorNode(graph: ComfyGraphLike | undefined) {
  return (graph?._nodes ?? []).find(
    (item) => item.comfyClass === OMNICAM_DIRECTOR_TYPE || item.type === OMNICAM_DIRECTOR_TYPE,
  )
}

interface CameraSegmentEditorProps {
  segment: MultiTrackSegment
  currentTime: number
  mediaSources?: Array<{ kind: 'video' | 'image'; label: string; path: string }>
  onContentChange?: (patch: Partial<MultiTrackSegment['content']>) => void
}

export function CameraSegmentEditor({ segment, currentTime, mediaSources, onContentChange }: CameraSegmentEditorProps) {
  const presentation = getSegmentTrackPresentation('camera')
  const camera = useMemo(() => normalizeCamera(segment.content.camera), [segment.content.camera])
  const durationFrames = Math.max(1, segment.end_frame - segment.start_frame)
  const localFrame = Math.max(0, Math.min(durationFrames - 1, Math.round(currentTime - segment.start_frame)))
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const embedHostRef = useRef<HTMLDivElement | null>(null)
  const mountedEmbedRef = useRef<{ container: HTMLElement; parent: HTMLElement | null; next: Node | null } | null>(null)
  const [embedded, setEmbedded] = useState(false)
  const syncListenerRef = useRef<{ runtime: DirectorRuntimeLike; handler: EventListener; progressHandler?: EventListener } | null>(null)
  const suppressSyncUntilRef = useRef(0)
  const syncTimerRef = useRef<number | null>(null)
  const lastSyncedStateRef = useRef('')
  const lastAttachedRecordingRef = useRef('')
  const lastPushedRef = useRef('')
  const pushTimerRef = useRef<number | null>(null)
  const suppressPushUntilRef = useRef(0)
  const [tab, setTab] = useState<'params' | 'viewport' | 'extract' | 'compile'>('params')
  const [directorFrame, setDirectorFrame] = useState(0)
  const [zhEnabled, setZhEnabled] = useState(() => localStorage.getItem('easyMedia.omnicamZh') !== 'off')

  // 面板卸载时把 3D 编辑器 DOM 还回节点，避免留下游离元素
  useEffect(() => () => {
    const saved = mountedEmbedRef.current
    if (!saved) return
    mountedEmbedRef.current = null
    try {
      if (saved.parent) saved.parent.insertBefore(saved.container, saved.next)
      saved.container.style.display = ''
      saved.container.style.width = ''
      saved.container.style.height = ''
    } catch (error) {
      console.debug('[EasyMedia] restore director container failed', error)
    }
  }, [])


  function patchCamera(patch: Partial<CameraData>) {
    const next = { ...camera, ...patch }
    next.keyframes = (next.keyframes ?? []).sort((left, right) => left.frame - right.frame)
    onContentChange?.({ camera: next })
  }

  function updateKeyframe(index: number, patch: Partial<CameraKeyframe>) {
    const keyframes = camera.keyframes ?? []
    const next = keyframes.map((key, i) => (i === index ? { ...key, ...patch } : key))
    patchCamera({ keyframes: next })
  }

  function addKeyframe(preset: CameraPreset = 'static') {
    const keyframes = [...(camera.keyframes ?? []), {
      frame: embedded ? (readDirectorFrame() ?? localFrame) : localFrame,
      preset,
      easing: 'ease_in_out' as CameraEasing,
    }]
    patchCamera({ keyframes })
  }

  const cameraSignature = useMemo(() => JSON.stringify({
    preset: camera.preset,
    easing: camera.easing,
    keyframes: camera.keyframes ?? [],
  }), [camera.preset, camera.easing, camera.keyframes])

  // 面板 → 3D：面板里改预设/关键帧后自动推给内嵌编辑器
  useEffect(() => {
    if (!embedded) return
    if (cameraSignature === lastPushedRef.current) return
    if (Date.now() < suppressPushUntilRef.current) {
      lastPushedRef.current = cameraSignature
      return
    }
    if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current)
    pushTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          lastPushedRef.current = cameraSignature
          suppressSyncUntilRef.current = Date.now() + 1500
          await prepareDirectorNode({ fromPresets: true })
          setNotice({ kind: 'ok', text: '面板改动已同步到 3D 编辑器' })
        } catch (error) {
          console.debug('[EasyMedia] push camera to director failed', error)
        }
      })()
    }, 350)
    return () => {
      if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraSignature, embedded])

  /** 确保 Director 节点存在、写入相机状态，并让活动编辑器严格对齐当前段的帧数。 */
  async function prepareDirectorNode(options: { fromPresets?: boolean } = {}): Promise<{ node: Record<string, unknown>; runtime?: DirectorRuntimeLike }> {
    const { app, graph, liteGraph } = resolveComfyGraph()
    if (!graph) throw new Error('找不到 ComfyUI 画布（comfyAPI.app.app 不可用）')
    const storedState = camera.omnicam_state
    const omniState = storedState && typeof storedState === 'object' && !Array.isArray(storedState)
      ? storedState as Record<string, unknown>
      : null
    const hasOmniCameras = Array.isArray((omniState as { cameras?: unknown[] } | null)?.cameras)
      && ((omniState as { cameras?: unknown[] }).cameras as unknown[]).length > 0
    let result: { state?: Record<string, unknown> }
    if (!options.fromPresets && hasOmniCameras) {
      // 已存在 3D 编排结果时优先用它，避免被预设关键帧覆盖
      result = { state: omniState as Record<string, unknown> }
    } else {
      const response = await fetch('/easy-media/camera/editor-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera, fps: 24, frames: durationFrames }),
      })
      if (!response.ok) throw new Error(`生成编辑器状态失败（HTTP ${response.status}）`)
      result = await response.json() as { state?: Record<string, unknown> }
    }
    if (!result.state) throw new Error('编辑器状态为空，请先设置预设或关键帧')
    let node: Record<string, unknown> | null | undefined = findDirectorNode(graph)
    if (!node) {
      if (!liteGraph?.createNode) throw new Error('无法自动创建节点：请在画布双击搜索 MajoorOmniCamDirector 手动添加')
      node = liteGraph.createNode(OMNICAM_DIRECTOR_TYPE)
      if (!node) throw new Error(`创建 ${OMNICAM_DIRECTOR_TYPE} 节点失败（类型未注册？）`)
      node.pos = [80, 80]
      graph.add?.(node)
    }
    let runtime = getDirectorRuntime(node)
    for (let i = 0; i < 40 && !runtime?.inlineView?.container; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      runtime = getDirectorRuntime(node)
    }
    suppressSyncUntilRef.current = Date.now() + 2500
    const widgets = (node.widgets as Array<{ name: string; value: unknown }> | undefined) ?? []
    const setWidget = (name: string, value: unknown) => {
      const widget = widgets.find((item) => item.name === name)
      if (widget) widget.value = value
    }
    const applyState = (state: Record<string, unknown>) => {
      const aligned = { ...state, fps: 24, duration_frames: durationFrames }
      setWidget('state_json', JSON.stringify(aligned))
      setWidget('width', 1280)
      setWidget('height', 720)
      setWidget('fps', 24)
      setWidget('duration_seconds', durationFrames / 24)
      setWidget('render_mode', 'omni_ref')
      return aligned
    }
    applyState(result.state)
    node.properties = { ...(node.properties as Record<string, unknown> | undefined), easyCameraSegmentId: segment.id }
    app?.canvas?.setDirty?.(true, true)
    graph.setDirtyCanvas?.(true, true)
    runtime?.restoreFromWidgetsHeadless?.()
    // 活动编辑器可能停在自己的默认时长上，校验后强制再对齐一次
    const liveFrames = runtime?.state?.duration_frames
    if (typeof liveFrames === 'number' && liveFrames !== durationFrames) {
      applyState({ ...(runtime?.state as Record<string, unknown> | undefined), ...result.state })
      runtime?.restoreFromWidgetsHeadless?.()
    }
    return { node, runtime }
  }

  function detachSyncListener() {
    const saved = syncListenerRef.current
    if (!saved) return
    const target = saved.runtime as unknown as EventTarget
    target.removeEventListener?.('statechange', saved.handler)
    if (saved.progressHandler) target.removeEventListener?.('playblastprogress', saved.progressHandler)
    syncListenerRef.current = null
    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current)
      syncTimerRef.current = null
    }
  }

  /** 3D 编辑器内的变更自动回写相机段（800ms 防抖）。 */
  function attachSyncListener(runtime: DirectorRuntimeLike | undefined) {
    const target = runtime as unknown as EventTarget | undefined
    if (!target?.addEventListener) return
    if (syncListenerRef.current?.runtime === runtime) return
    detachSyncListener()
    const handler = (() => {
      if (Date.now() < suppressSyncUntilRef.current) return
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current)
      syncTimerRef.current = window.setTimeout(() => { void autoImportState(true) }, 800)
    }) as EventListener
    target.addEventListener('statechange', handler)
    const progressHandler = ((event: Event) => {
      const detail = (event as CustomEvent<{ frame?: number; total?: number }>).detail ?? {}
      const frame = Number(detail.frame ?? 0)
      const total = Number(detail.total ?? 0)
      if (total > 0) setNotice({ kind: 'ok', text: `录制中 ${frame}/${total}…` })
    }) as EventListener
    target.addEventListener('playblastprogress', progressHandler)
    syncListenerRef.current = {
      runtime: runtime as DirectorRuntimeLike,
      handler,
      progressHandler,
    } as { runtime: DirectorRuntimeLike; handler: EventListener; progressHandler: EventListener }
  }

  /** 读取节点 state_json → 编译 → 写回相机段。silent=true 时用于自动同步。 */
  async function autoImportState(silent: boolean): Promise<boolean> {
    const { graph } = resolveComfyGraph()
    const node = findDirectorNode(graph)
    if (!node) return false
    const widgets = (node.widgets as Array<{ name: string; value: unknown }> | undefined) ?? []
    const stateJson = widgets.find((item) => item.name === 'state_json')?.value
    if (typeof stateJson !== 'string' || !stateJson.trim()) return false
    if (stateJson === lastSyncedStateRef.current) return false
    const response = await fetch('/easy-media/camera/compile-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: stateJson }),
    })
    if (!response.ok) return false
    const result = await response.json() as { prompt?: string }
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(stateJson) as Record<string, unknown>
    } catch {
      parsed = undefined
    }
    lastSyncedStateRef.current = stateJson
    suppressPushUntilRef.current = Date.now() + 1500
    patchCamera({
      ...(parsed ? { omnicam_state: parsed } : {}),
      ...(result.prompt ? { compiled_prompt: result.prompt } : {}),
    })
    setNotice(silent
      ? { kind: 'ok', text: `已自动同步 · ${new Date().toLocaleTimeString()}` }
      : { kind: 'ok', text: '已从 3D 编辑器取回运镜描述' })
    return true
  }

  /** 把提取/重建结果写入相机段，并载入 3D 视口。 */
  async function applyExtractedState(editorState: Record<string, unknown>) {
    try {
      const response = await fetch('/easy-media/camera/compile-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: editorState }),
      })
      const compiled = await response.json() as { prompt?: string }
      patchCamera({
        omnicam_state: editorState,
        ...(compiled.prompt ? { compiled_prompt: compiled.prompt } : {}),
      })
      await applyExplicitState(editorState)
      setNotice({ kind: 'ok', text: '运镜已从视频提取并载入 3D 视口' })
      setTab('viewport')
    } catch (error) {
      setNotice({ kind: 'error', text: `应用提取结果失败：${String(error)}` })
    }
  }

  /** 录制完成后自动把预演复制进项目并写回相机段。 */
  async function syncRecordingPath() {
    const { graph } = resolveComfyGraph()
    const node = findDirectorNode(graph)
    if (!node) return
    const widgets = (node.widgets as Array<{ name: string; value: unknown }> | undefined) ?? []
    const recording = widgets.find((item) => item.name === 'recording_path')?.value
    if (typeof recording !== 'string' || !recording.trim()) return
    if (recording === lastAttachedRecordingRef.current) return
    const projectName = (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName
    if (!projectName) {
      setNotice({ kind: 'error', text: '未打开项目，无法挂载预演' })
      return
    }
    try {
      const response = await fetch('/easy-media/camera/store-playblast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: projectName, segment_id: segment.id, recording_path: recording }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        setNotice({ kind: 'error', text: `挂载失败：${detail.error ?? response.status}` })
        return
      }
      const stored = await response.json() as { playblast?: string }
      if (!stored.playblast) {
        setNotice({ kind: 'error', text: '挂载失败：服务端未返回路径' })
        return
      }
      lastAttachedRecordingRef.current = recording
      patchCamera({ playblast: stored.playblast })
      window.dispatchEvent(new CustomEvent('easy-media:mount-camera-reference', {
        detail: {
          segmentId: segment.id,
          playblast: stored.playblast,
          startFrame: segment.start_frame,
          endFrame: segment.end_frame,
        },
      }))
      setNotice({ kind: 'ok', text: `预演已挂载到「相机参考」轨：${stored.playblast}` })
    } catch (error) {
      console.error('[EasyMedia] store playblast failed', error)
      setNotice({ kind: 'error', text: `挂载失败：${String(error)}` })
    }
  }

  /** 点击面板上的「录制预演」→ 触发 OmniCam 自身的 REC。 */
  function triggerRecord() {
    const { graph } = resolveComfyGraph()
    const runtime = getDirectorRuntime(findDirectorNode(graph))
    const shell = runtime?.shell
    // 优先使用外壳暴露的按钮对象（汉化改文案也不影响）
    let button: HTMLButtonElement | null = shell?.recordButton ?? null
    if (!button) {
      const root = shell?.root
      button = (root?.querySelector('.oc-node-shell-record') as HTMLButtonElement | null)
        ?? (root?.querySelector('button[class*="record"]') as HTMLButtonElement | null)
        ?? null
    }
    if (!button) {
      const root = shell?.root
      const candidates = root ? Array.from(root.querySelectorAll('button')) : []
      button = (candidates.find((item) => /REC|录制/i.test(item.textContent ?? '')) as HTMLButtonElement | undefined) ?? null
    }
    if (!button) {
      setNotice({ kind: 'error', text: '未找到录制按钮：请先点「加载 3D 视口」再试' })
      return
    }
    if (button.disabled) {
      setNotice({ kind: 'ok', text: '正在录制中，请等待完成…' })
      return
    }
    button.click()
    setNotice({ kind: 'ok', text: '已开始录制预演，录完会自动挂载' })
  }

  /** 把一份外部 state（如 Extractor 结果）直接写进 Director 并刷新内嵌视口。 */
  async function applyExplicitState(state: Record<string, unknown>) {
    const { app, graph, liteGraph } = resolveComfyGraph()
    if (!graph) throw new Error('找不到 ComfyUI 画布')
    let node: Record<string, unknown> | null | undefined = findDirectorNode(graph)
    if (!node) {
      if (!liteGraph?.createNode) throw new Error('无法自动创建节点')
      node = liteGraph.createNode(OMNICAM_DIRECTOR_TYPE)
      if (!node) throw new Error('创建 Director 节点失败')
      node.pos = [80, 80]
      graph.add?.(node)
    }
    let runtime = getDirectorRuntime(node)
    for (let i = 0; i < 40 && !runtime?.inlineView?.container; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      runtime = getDirectorRuntime(node)
    }
    suppressSyncUntilRef.current = Date.now() + 2500
    const widgets = (node.widgets as Array<{ name: string; value: unknown }> | undefined) ?? []
    const setWidget = (name: string, value: unknown) => {
      const widget = widgets.find((item) => item.name === name)
      if (widget) widget.value = value
    }
    const aligned = { ...state, fps: 24, duration_frames: durationFrames }
    setWidget('state_json', JSON.stringify(aligned))
    setWidget('width', 1280)
    setWidget('height', 720)
    setWidget('fps', 24)
    setWidget('duration_seconds', durationFrames / 24)
    setWidget('render_mode', 'omni_ref')
    app?.canvas?.setDirty?.(true, true)
    graph.setDirtyCanvas?.(true, true)
    runtime?.restoreFromWidgetsHeadless?.()
    await embedDirector(node)
    setTab('viewport')
  }

  /** 把 Director 的 inline 编辑器 DOM 搬进本面板并显示。 */
  async function embedDirector(node: Record<string, unknown>) {
    const host = embedHostRef.current
    if (!host) throw new Error('面板容器未就绪')
    let runtime = getDirectorRuntime(node)
    for (let i = 0; i < 40 && !runtime?.inlineView?.container; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      runtime = getDirectorRuntime(node)
    }
    const view = runtime?.inlineView
    const container = view?.container
    if (!view?.show || !container) {
      throw new Error('OmniCam 扩展未就绪（找不到 inlineView），请刷新页面后重试')
    }
    if (!mountedEmbedRef.current) {
      mountedEmbedRef.current = { container, parent: container.parentElement, next: container.nextSibling }
      container.style.display = 'flex'
      container.style.width = '100%'
      container.style.height = '100%'
      host.appendChild(container)
    } else if (container.parentElement !== host) {
      host.appendChild(container)
    }
    await view.show()
    attachSyncListener(runtime)
    setEmbedded(true)
  }

  async function openOmniCamEditor() {
    try {
      setTab('viewport')
      setNotice(null)
      const { node } = await prepareDirectorNode()
      try {
        await embedDirector(node)
        setNotice({ kind: 'ok', text: `3D 编辑器已嵌入面板（已对齐 ${durationFrames} 帧）` })
      } catch (embedError) {
        console.debug('[EasyMedia] embed director failed', embedError)
        const message = embedError instanceof Error ? embedError.message : String(embedError)
        const { app } = resolveComfyGraph()
        app?.canvas?.centerOnNode?.(node)
        setNotice({ kind: 'error', text: `无法嵌入面板：${message}。已把节点放到画布上，可在节点里点 OPEN DIRECTOR` })
      }
    } catch (error) {
      console.error('[EasyMedia] open OmniCam editor failed', error)
      setNotice({ kind: 'error', text: `打开失败：${String(error)}` })
    }
  }

  // 切换相机段 / 段长变化时：把新状态写回节点并刷新内嵌视口
  useEffect(() => {
    if (!embedded) return
    let cancelled = false
    void (async () => {
      try {
        const { graph } = resolveComfyGraph()
        if (!findDirectorNode(graph)) return
        getDirectorRuntime(findDirectorNode(graph))?.inlineView?.hide?.()
        const { node } = await prepareDirectorNode()
        if (cancelled) return
        await embedDirector(node)
        if (!cancelled) setNotice({ kind: 'ok', text: `已切换到当前相机段（${durationFrames} 帧）` })
      } catch (error) {
        console.debug('[EasyMedia] sync embedded director failed', error)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.id, durationFrames])

  // 已有 3D 状态的相机段：选中即自动加载视口
  useEffect(() => {
    if (embedded) return
    if (!camera.omnicam_state) return
    void openOmniCamEditor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.id])

  // 卸载时清理监听与定时器
  useEffect(() => () => {
    detachSyncListener()
  }, [])

  async function importFromOmniCamEditor() {
    try {
      setNotice(null)
      const { graph } = resolveComfyGraph()
      if (!findDirectorNode(graph)) {
        setNotice({ kind: 'error', text: '画布上没有可读的 MajoorOmniCamDirector 状态，请先加载 3D 视口' })
        return
      }
      const changed = await autoImportState(false)
      setTab('params')
      setNotice({
        kind: 'ok',
        text: changed
          ? '已从 3D 编辑器取回运镜描述与相机状态（预演仍需手动挂载）'
          : '3D 编辑器状态无变化，相机段已是最新',
      })
    } catch (error) {
      console.error('[EasyMedia] import OmniCam state failed', error)
      setNotice({ kind: 'error', text: `取回失败：${String(error)}` })
    }
  }

  async function compileWithOmniCam() {
    try {
      const response = await fetch('/easy-media/camera/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera,
          fps: 24,
          frames: durationFrames,
        }),
      })
      if (response.ok) {
        const result = await response.json() as { prompt?: string }
        if (result.prompt) {
          patchCamera({ compiled_prompt: result.prompt })
          return
        }
      }
    } catch (error) {
      console.debug('[EasyMedia] OmniCam compile failed, falling back to local compile', error)
    }
    patchCamera({ compiled_prompt: compileCameraPrompt(camera) })
  }

  function removeKeyframe(index: number) {
    const keyframes = (camera.keyframes ?? []).filter((_, i) => i !== index)
    patchCamera({ keyframes })
  }

  function readDirectorFrame(): number | null {
    const host = embedHostRef.current
    const scrub = host?.querySelector('input[data-role="scrub"]') as HTMLInputElement | null
    if (!scrub) return null
    const value = Number(scrub.value)
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }

  function seekDirector(frame: number) {
    const host = embedHostRef.current
    const scrub = host?.querySelector('input[data-role="scrub"]') as HTMLInputElement | null
    if (!scrub) return
    const clamped = Math.max(0, Math.min(durationFrames - 1, Math.round(frame)))
    scrub.value = String(clamped)
    scrub.dispatchEvent(new Event('input', { bubbles: true }))
    setDirectorFrame(clamped)
  }

  const editFrame = embedded ? directorFrame : localFrame

  // 视口打开时跟踪 3D 播放头，面板显示同一帧号
  useEffect(() => {
    if (!embedded) return
    const timer = window.setInterval(() => {
      const frame = readDirectorFrame()
      if (frame !== null) setDirectorFrame(frame)
    }, 400)
    return () => window.clearInterval(timer)
  }, [embedded])

  // 多轨播放头 → 3D 播放头（用户正在操作 3D 时不抢）
  useEffect(() => {
    if (!embedded || tab !== 'viewport') return
    const host = embedHostRef.current
    if (host && host.contains(document.activeElement)) return
    const timer = window.setTimeout(() => seekDirector(localFrame), 200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFrame, embedded, tab])

  return (
    <div className="flex min-h-24 w-full min-w-0 flex-col gap-2 overflow-y-auto rounded-sm bg-background p-2" data-camera-editor>
      <div className="sticky top-0 z-20 -mx-2 -mt-2 mb-1 flex items-center justify-between gap-2 rounded-t-sm bg-background px-2 py-1">
        <div className="flex items-center gap-1.5" style={{ color: presentation.textColor }}>
          <Camera className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium">相机 · {cameraPresetLabel(camera.preset)}</span>
          <span className="text-[9px] opacity-70">{durationFrames} 帧</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={zhEnabled ? '切换到英文界面' : '切换到中文界面'}
            onClick={() => {
              const next = !zhEnabled
              if (next) {
                installOmniCamChinese()
              } else {
                uninstallOmniCamChinese()
              }
              document.documentElement.dataset.easyOmnicamZh = next ? 'on' : 'off'
              localStorage.setItem('easyMedia.omnicamZh', next ? 'on' : 'off')
              setZhEnabled(next)
            }}
          >
            {zhEnabled ? 'EN' : '中'}
          </button>
          <div className="flex overflow-hidden rounded border border-border">
            {([
              ['params', '参数'],
              ['viewport', '3D编辑'],
              ['extract', '提取运镜'],
              ['compile', 'H3编译'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`px-2 py-0.5 text-[10px] ${tab === value ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
                onClick={() => {
                  setTab(value)
                  if (value === 'viewport' && !embedded) window.setTimeout(() => { void openOmniCamEditor() }, 0)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <Button type="button" size="sm" variant="secondary" className="h-6 px-2 text-[10px]" onClick={() => addKeyframe(camera.preset ?? 'static')}>
            <Plus className="mr-1 h-3 w-3" /> 在第 {editFrame} 帧加关键帧
          </Button>
        </div>
      </div>

      {tab === 'params' ? (
        (camera.keyframes ?? []).length === 0 ? (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>还没有关键帧：</span>
            <Select
              value={camera.preset ?? 'static'}
              onValueChange={(value) => patchCamera({ preset: value as CameraPreset })}
            >
              <SelectTrigger className="h-6 w-24 bg-card text-[10px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CAMERA_PRESETS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={camera.easing ?? 'ease_in_out'}
              onValueChange={(value) => patchCamera({ easing: value as CameraEasing })}
            >
              <SelectTrigger className="h-6 w-24 bg-card text-[10px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CAMERA_EASINGS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {(camera.keyframes ?? []).map((key, index) => (
              <div key={`${key.frame}-${index}`} className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="w-12 cursor-pointer text-left text-[10px] text-muted-foreground hover:text-foreground"
                  title="跳到该帧"
                  onClick={() => seekDirector(key.frame)}
                >
                  帧 {key.frame}
                </button>
                <Select
                  value={key.preset}
                  onValueChange={(value) => updateKeyframe(index, { preset: value as CameraPreset })}
                >
                  <SelectTrigger className="h-6 w-24 bg-card text-[10px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAMERA_PRESETS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={key.easing}
                  onValueChange={(value) => updateKeyframe(index, { easing: value as CameraEasing })}
                >
                  <SelectTrigger className="h-6 w-24 bg-card text-[10px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAMERA_EASINGS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => removeKeyframe(index)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )
      ) : null}

      {tab === 'params' ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 w-fit px-2 text-[10px]"
              onClick={() => { void compileWithOmniCam() }}
            >
              生成运镜描述（OmniCam）
            </Button>
          </div>
          <textarea
            className="min-h-16 w-full resize-y rounded border border-border bg-card p-2 text-[10px] leading-relaxed"
            placeholder="编译后的英文运镜描述（留空则由关键帧自动生成）"
            value={camera.compiled_prompt ?? ''}
            onChange={(event) => patchCamera({ compiled_prompt: event.target.value })}
          />
          <div className="text-[9px] text-muted-foreground">
            本地摘要（不注入 H3）：{compileCameraPrompt(camera)}
          </div>
          {camera.playblast ? (
            <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
              <span className="truncate" title={camera.playblast}>预演：{camera.playblast}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-5 w-5 shrink-0 text-destructive"
                aria-label="清除预演"
                title="清除预演"
                onClick={() => patchCamera({ playblast: undefined })}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ) : null}
        </>
      ) : tab === 'viewport' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-6 w-fit px-2 text-[10px]" onClick={triggerRecord}>
            录制预演
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 w-fit px-2 text-[10px]"
            onClick={() => { void syncRecordingPath() }}
          >
            挂载预演
          </Button>
          {embedded ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              onClick={() => {
                const { graph } = resolveComfyGraph()
                const view = getDirectorRuntime(findDirectorNode(graph))?.inlineView
                void view?.expand?.(embedHostRef.current)
              }}
            >
              全屏编辑
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[10px]"
              onClick={() => { void openOmniCamEditor() }}
            >
              加载 3D 视口
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={() => { void importFromOmniCamEditor() }}
          >
            从 3D 编辑器取回
          </Button>
        </div>
      ) : null}

      {tab === 'extract' ? (
        <ExtractMotionDialog
          open
          inline
          defaultVideo={camera.playblast ?? ''}
          sources={mediaSources}
          onClose={() => setTab('params')}
          onApply={(editorState) => { void applyExtractedState(editorState) }}
        />
      ) : null}

      {tab === 'compile' ? (
        <MonitorCompileDialog
          open
          inline
          camera={camera}
          durationFrames={durationFrames}
          playblast={camera.playblast}
          onClose={() => setTab('params')}
          onApply={(prompt) => {
            patchCamera({ compiled_prompt: prompt })
            setNotice({ kind: 'ok', text: 'H3 编译结果已写入相机段，生成时注入任务段提示词' })
          }}
        />
      ) : null}

      <div
        ref={embedHostRef}
        className={tab === 'viewport'
          ? 'relative w-full overflow-hidden rounded border border-border bg-black/30'
          : 'hidden'}
        style={{ minHeight: 520 }}
      />
      {tab === 'viewport' && !embedded ? (
        <div className="text-[9px] text-muted-foreground">点「加载 3D 视口」在此处加载 OmniCam 编辑器（不再切换画布节点）</div>
      ) : null}
      {notice ? (
        <div className={notice.kind === 'error' ? 'text-[9px] text-destructive' : 'text-[9px] text-muted-foreground'}>
          {notice.text}
        </div>
      ) : null}
    </div>
  )
}
