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
  onContentChange?: (patch: Partial<MultiTrackSegment['content']>) => void
}

export function CameraSegmentEditor({ segment, currentTime, onContentChange }: CameraSegmentEditorProps) {
  const presentation = getSegmentTrackPresentation('camera')
  const camera = useMemo(() => normalizeCamera(segment.content.camera), [segment.content.camera])
  const durationFrames = Math.max(1, segment.end_frame - segment.start_frame)
  const localFrame = Math.max(0, Math.min(durationFrames - 1, Math.round(currentTime - segment.start_frame)))
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const embedHostRef = useRef<HTMLDivElement | null>(null)
  const mountedEmbedRef = useRef<{ container: HTMLElement; parent: HTMLElement | null; next: Node | null } | null>(null)
  const [embedded, setEmbedded] = useState(false)

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
      frame: localFrame,
      preset,
      easing: 'ease_in_out' as CameraEasing,
    }]
    patchCamera({ keyframes })
  }

  /** 确保 Director 节点存在并把当前相机段状态写进去。 */
  async function prepareDirectorNode(): Promise<Record<string, unknown>> {
    const { app, graph, liteGraph } = resolveComfyGraph()
    if (!graph) throw new Error('找不到 ComfyUI 画布（comfyAPI.app.app 不可用）')
    const response = await fetch('/easy-media/camera/editor-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera, fps: 24, frames: durationFrames }),
    })
    if (!response.ok) throw new Error(`生成编辑器状态失败（HTTP ${response.status}）`)
    const result = await response.json() as { state?: Record<string, unknown> }
    if (!result.state) throw new Error('编辑器状态为空，请先设置预设或关键帧')
    let node: Record<string, unknown> | null | undefined = findDirectorNode(graph)
    if (!node) {
      if (!liteGraph?.createNode) throw new Error('无法自动创建节点：请在画布双击搜索 MajoorOmniCamDirector 手动添加')
      node = liteGraph.createNode(OMNICAM_DIRECTOR_TYPE)
      if (!node) throw new Error(`创建 ${OMNICAM_DIRECTOR_TYPE} 节点失败（类型未注册？）`)
      node.pos = [80, 80]
      graph.add?.(node)
    }
    const widgets = (node.widgets as Array<{ name: string; value: unknown }> | undefined) ?? []
    const setWidget = (name: string, value: unknown) => {
      const widget = widgets.find((item) => item.name === name)
      if (widget) widget.value = value
    }
    setWidget('state_json', JSON.stringify(result.state))
    setWidget('width', 1280)
    setWidget('height', 720)
    setWidget('fps', 24)
    setWidget('duration_seconds', durationFrames / 24)
    setWidget('render_mode', 'omni_ref')
    node.properties = { ...(node.properties as Record<string, unknown> | undefined), easyCameraSegmentId: segment.id }
    app?.canvas?.setDirty?.(true, true)
    graph.setDirtyCanvas?.(true, true)
    return node
  }

  /** 把 Director 的 inline 编辑器 DOM 搬进本面板并显示。 */
  async function embedDirector(node: Record<string, unknown>) {
    const host = embedHostRef.current
    if (!host) throw new Error('面板容器未就绪')
    // runtime 由扩展在节点入图后异步挂载，最多等 4 秒
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
    setEmbedded(true)
  }

  async function openOmniCamEditor() {
    try {
      setNotice(null)
      const node = await prepareDirectorNode()
      try {
        await embedDirector(node)
        setNotice({ kind: 'ok', text: '3D 编辑器已嵌入本面板，可直接编排运镜' })
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

  // 切换相机段时：把新段状态写回节点并刷新内嵌视口
  useEffect(() => {
    if (!embedded) return
    let cancelled = false
    void (async () => {
      try {
        const { graph } = resolveComfyGraph()
        if (!findDirectorNode(graph)) return
        getDirectorRuntime(findDirectorNode(graph))?.inlineView?.hide?.()
        const refreshed = await prepareDirectorNode()
        if (cancelled) return
        getDirectorRuntime(refreshed)?.restoreFromWidgetsHeadless?.()
        await embedDirector(refreshed)
        if (!cancelled) setNotice({ kind: 'ok', text: '已切换到当前相机段' })
      } catch (error) {
        console.debug('[EasyMedia] sync embedded director failed', error)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.id])

  async function importFromOmniCamEditor() {
    try {
      setNotice(null)
      const { graph } = resolveComfyGraph()
      if (!graph) {
        setNotice({ kind: 'error', text: '找不到 ComfyUI 画布，无法读取 3D 编辑器节点' })
        return
      }
      const node = findDirectorNode(graph)
      if (!node) {
        setNotice({ kind: 'error', text: '画布上没有 MajoorOmniCamDirector 节点，请先「打开 3D 编辑器」' })
        return
      }
      const widgets = (node.widgets as Array<{ name: string; value: unknown }> | undefined) ?? []
      const stateJson = widgets.find((item) => item.name === 'state_json')?.value
      if (typeof stateJson !== 'string' || !stateJson.trim()) return
      const response = await fetch('/easy-media/camera/compile-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: stateJson }),
      })
      if (!response.ok) return
      const result = await response.json() as { prompt?: string }
      const patch: Record<string, unknown> = {
        omnicam_state: stateJson as unknown as Record<string, unknown>,
        ...(result.prompt ? { compiled_prompt: result.prompt } : {}),
      }
      const recordingPath = widgets.find((item) => item.name === 'recording_path')?.value
      const projectName = (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName
      if (typeof recordingPath === 'string' && recordingPath.trim() && projectName) {
        try {
          const attach = await fetch('/easy-media/camera/attach-playblast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_name: projectName, segment_id: segment.id, recording_path: recordingPath }),
          })
          if (attach.ok) {
            const attached = await attach.json() as { playblast?: string }
            if (attached.playblast) patch.playblast = attached.playblast
          }
        } catch (error) {
          console.debug('[EasyMedia] attach playblast failed', error)
        }
      }
      patchCamera(patch as Partial<CameraData>)
      setNotice({
        kind: 'ok',
        text: patch.playblast
          ? `已取回运镜描述，并挂载预演：${String(patch.playblast)}`
          : '已取回运镜描述（未检测到录制文件 recording_path）',
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

  return (
    <div className="flex min-h-24 w-full min-w-0 flex-col gap-2 overflow-y-auto rounded-sm bg-background p-2" data-camera-editor>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5" style={{ color: presentation.textColor }}>
          <Camera className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium">相机 · {cameraPresetLabel(camera.preset)}</span>
          <span className="text-[9px] opacity-70">{durationFrames} 帧</span>
        </div>
        <Button type="button" size="sm" variant="secondary" className="h-6 px-2 text-[10px]" onClick={() => addKeyframe(camera.preset ?? 'static')}>
          <Plus className="mr-1 h-3 w-3" /> 在第 {localFrame} 帧加关键帧
        </Button>
      </div>

      {(camera.keyframes ?? []).length === 0 ? (
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
              <span className="w-12 text-[10px] text-muted-foreground">帧 {key.frame}</span>
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 w-fit px-2 text-[10px]"
            onClick={() => { void compileWithOmniCam() }}
          >
            生成运镜描述（OmniCam）
          </Button>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[10px]"
              onClick={() => { void openOmniCamEditor() }}
            >
              打开 3D 编辑器
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
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              onClick={() => { void importFromOmniCamEditor() }}
            >
              从 3D 编辑器取回
            </Button>
            {camera.playblast ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => patchCamera({ playblast: undefined })}
              >
                清除预演
              </Button>
            ) : null}
          </div>
          <div className="relative w-full overflow-hidden rounded border border-border bg-black/30" style={{ minHeight: 420 }}>
            <div ref={embedHostRef} className="h-[420px] w-full" />
            {embedded ? null : (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[10px] text-muted-foreground">
                点「打开 3D 编辑器」在此处加载 OmniCam 视口（不再切换画布节点）
              </div>
            )}
          </div>
          {notice ? (
            <div className={notice.kind === 'error' ? 'text-[9px] text-destructive' : 'text-[9px] text-muted-foreground'}>
              {notice.text}
            </div>
          ) : null}
        </div>
      )}

      <textarea
        className="min-h-16 w-full resize-y rounded border border-border bg-card p-2 text-[10px] leading-relaxed"
        placeholder="编译后的英文运镜描述（留空则由关键帧自动生成）"
        value={camera.compiled_prompt ?? ''}
        onChange={(event) => patchCamera({ compiled_prompt: event.target.value })}
      />
      <div className="text-[9px] text-muted-foreground">
        提示词预览：{compileCameraPrompt(camera)}
      </div>
      {camera.playblast ? (
        <div className="truncate text-[9px] text-muted-foreground" title={camera.playblast}>
          预演：{camera.playblast}
        </div>
      ) : null}
    </div>
  )
}
