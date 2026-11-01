import { useMemo } from 'react'
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

  async function openOmniCamEditor() {
    try {
      const response = await fetch('/easy-media/camera/editor-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera, fps: 24, frames: durationFrames }),
      })
      if (!response.ok) return
      const result = await response.json() as { state?: Record<string, unknown> }
      if (!result.state) return
      const win = window as unknown as {
        app?: { graph?: { _nodes?: Array<Record<string, unknown>>; add?: (node: unknown) => void; setDirtyCanvas?: (a: boolean, b: boolean) => void } }
        LiteGraph?: { createNode?: (type: string) => Record<string, unknown> }
      }
      const app = win.app
      const graph = app?.graph
      if (!graph || !win.LiteGraph?.createNode) return
      let node = graph._nodes?.find((item) => item.comfyClass === 'MajoorOmniCamDirector')
      if (!node) {
        node = win.LiteGraph.createNode('MajoorOmniCamDirector')
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
      graph.setDirtyCanvas?.(true, true)
    } catch (error) {
      console.debug('[EasyMedia] open OmniCam editor failed', error)
    }
  }

  async function importFromOmniCamEditor() {
    try {
      const win = window as unknown as { app?: { graph?: { _nodes?: Array<Record<string, unknown>> } } }
      const node = win.app?.graph?._nodes?.find((item) => item.comfyClass === 'MajoorOmniCamDirector')
      if (!node) return
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
      patchCamera({
        omnicam_state: stateJson as unknown as Record<string, unknown>,
        ...(result.prompt ? { compiled_prompt: result.prompt } : {}),
      })
    } catch (error) {
      console.debug('[EasyMedia] import OmniCam state failed', error)
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
    </div>
  )
}
