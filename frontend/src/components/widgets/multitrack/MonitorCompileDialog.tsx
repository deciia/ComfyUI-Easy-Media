import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { CameraData } from '@/types/multitrack'
import { EmbeddedNodePanel } from './EmbeddedNodePanel'
import { ensureNode, setWidgetValue, type ComfyGraphLike } from '@/lib/omnicam-embed'

interface MonitorCompileDialogProps {
  open: boolean
  /** 页签内联模式：不渲染遮罩层 */
  inline?: boolean
  camera: CameraData
  durationFrames: number
  playblast?: string
  onClose: () => void
  onApply: (prompt: string, reference?: MonitorCompileReference) => void
}

interface CompileResult {
  profile?: string
  final_prompt?: string
  target_length?: number
  target_fps?: number
  width?: number
  height?: number
  duration_seconds?: number
  frame_policy?: string
  has_reference_video?: boolean
  has_reference_frames?: boolean
  checks?: Array<{ id?: string; label?: string; state?: string; message?: string }>
  error?: string
  need_playblast?: boolean
  reference_video?: {
    video?: string
    frames?: number
    fps?: number
    width?: number
    height?: number
    profile?: string
  } | null
}

export type MonitorCompileReference = NonNullable<CompileResult['reference_video']>

export function MonitorCompileDialog({
  open,
  inline,
  camera,
  durationFrames,
  playblast,
  onClose,
  onApply,
}: MonitorCompileDialogProps) {
  const [profile, setProfile] = useState('h3_native')
  const [width, setWidth] = useState(832)
  const [height, setHeight] = useState(480)
  const [fps, setFps] = useState(24)
  const [guideSlot, setGuideSlot] = useState(1)
  const [basePrompt, setBasePrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CompileResult | null>(null)
  const [draft, setDraft] = useState('')
  const [panelTab, setPanelTab] = useState<'official' | 'quick'>('official')
  const [panelError, setPanelError] = useState<string | null>(null)

  /** 官方面板挂载前：确保 Director 存在、写入状态并连到 Monitor */
  async function prepareOfficial(node: Record<string, unknown>, graph: ComfyGraphLike) {
    try {
      const { node: director } = await ensureNode('MajoorOmniCamDirector')
      const state = camera.omnicam_state
      if (state && typeof state === 'object') {
        setWidgetValue(director, 'state_json', JSON.stringify(state))
        setWidgetValue(director, 'fps', 24)
        setWidgetValue(director, 'duration_seconds', durationFrames / 24)
      }
      const monitor = node
      graph.connect?.(director, 0, monitor, 0)
      setPanelError(null)
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error))
    }
  }

  const durationSeconds = useMemo(() => Math.max(0.1, durationFrames / 24), [durationFrames])
  const [profiles, setProfiles] = useState<Array<{ id: string; label?: string; semantic?: string }>>([])

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const response = await fetch('/easy-media/camera/profiles')
        if (!response.ok) return
        const data = await response.json() as { profiles?: Array<{ id: string; label?: string; semantic?: string }> }
        if (data.profiles?.length) {
          setProfiles(data.profiles)
          if (!data.profiles.some((item) => item.id === profile)) setProfile(data.profiles[0].id)
        }
      } catch (error) {
        console.debug('[EasyMedia] load profiles failed', error)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  async function compile() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/easy-media/camera/monitor-compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: camera.omnicam_state ?? undefined,
          target_profile: profile,
          playblast: playblast ?? '',
          width,
          height,
          target_fps: fps,
          duration_seconds: durationSeconds,
          guide_reference_index: guideSlot,
          base_prompt: basePrompt,
        }),
      })
      const payload = await response.json() as CompileResult
      if (!response.ok) {
        setResult(null)
        setError(payload.error ?? `编译失败（HTTP ${response.status}）`)
        return
      }
      setResult(payload)
      setDraft(payload.final_prompt ?? '')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const failedChecks = (result?.checks ?? []).filter((item) => (item.state ?? '').toUpperCase() !== 'PASS')

  return (
    <div
      className={inline
        ? 'flex w-full flex-col gap-2'
        : 'fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4'}
      role="dialog"
    >
      <div
        className={inline
          ? 'flex w-full flex-col gap-2'
          : 'flex max-h-[85vh] w-[min(760px,92vw)] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-background p-3 text-[11px]'}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">H3 编译（OmniCam Monitor）</span>
            <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">
              {panelTab === 'official' ? '官方面板' : '快速编译'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex overflow-hidden rounded border border-border">
              <button
                type="button"
                className={`px-2 py-0.5 text-[10px] ${panelTab === 'official' ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
                onClick={() => setPanelTab('official')}
              >
                官方面板
              </button>
              <button
                type="button"
                className={`px-2 py-0.5 text-[10px] ${panelTab === 'quick' ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
                onClick={() => setPanelTab('quick')}
              >
                快速编译
              </button>
            </div>
            {inline ? null : (
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClose}>
                关闭
              </Button>
            )}
          </div>
        </div>

        <div className="text-[9px] text-muted-foreground">
          {panelTab === 'official'
            ? '官方面板为执行驱动：需要在工作流里执行一次才会编译'
            : '快速编译：HTTP 直调，即时出结果'}
        </div>

        {panelTab === 'official' ? (
          <>
            {panelError ? <div className="text-[10px] text-destructive">{panelError}</div> : null}
            <EmbeddedNodePanel
              nodeType="MajoorOmniCamMonitor"
              widgetName="majoor_omnicam_monitor"
              active={panelTab === 'official'}
              prepare={prepareOfficial}
              onError={(message) => setPanelError(message)}
            />
          </>
        ) : (
          <>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">目标模型</span>
            <select
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              {profiles.length ? profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}{item.semantic ? `（${item.semantic}）` : ''}
                </option>
              )) : <option value="h3_native">h3_native（MiniMax H3 参考模式）</option>}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">引导槽位（&lt;Video N&gt;）</span>
            <input
              type="number"
              min={1}
              max={3}
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={guideSlot}
              onChange={(event) => setGuideSlot(Math.max(1, Math.min(3, Number(event.target.value) || 1)))}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">输出宽度</span>
            <input
              type="number"
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={width}
              onChange={(event) => setWidth(Number(event.target.value) || 832)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">输出高度</span>
            <input
              type="number"
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={height}
              onChange={(event) => setHeight(Number(event.target.value) || 480)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">帧率</span>
            <input
              type="number"
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={fps}
              onChange={(event) => setFps(Number(event.target.value) || 24)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">时长（秒）</span>
            <input
              type="number"
              step="0.1"
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={durationSeconds.toFixed(2)}
              onChange={() => undefined}
            />
          </label>
        </div>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">基础提示词（可选，会与相机描述合并）</span>
          <textarea
            className="min-h-12 w-full rounded border border-border bg-card p-1 text-[10px]"
            value={basePrompt}
            onChange={(event) => setBasePrompt(event.target.value)}
          />
        </label>

        <div className="flex items-center gap-2">
          <Button type="button" size="sm" className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => { void compile() }}>
            {busy ? '编译中…' : '编译'}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            预演：{playblast ? playblast.split('/').pop() : '未录制（H3 需要参考视频）'}
          </span>
        </div>

        {error ? <div className="text-[10px] text-destructive">{error}</div> : null}

        {result ? (
          <>
            <div className="text-[10px] text-muted-foreground">
              输出：{result.width}×{result.height} · {result.target_length} 帧 @ {result.target_fps}fps
              {result.frame_policy ? ` · ${result.frame_policy}` : ''}
              {result.has_reference_video ? ' · 含参考视频' : result.has_reference_frames ? ' · 含参考帧' : ''}
            </div>
            {failedChecks.length ? (
              <div className="text-[10px] text-destructive">
                {failedChecks.map((item) => `${item.state ?? ''} ${item.label ?? item.id ?? ''}${item.message ? `：${item.message}` : ''}`).join('；')}
              </div>
            ) : null}
            <details className="rounded border border-border p-1">
              <summary className="cursor-pointer text-[10px] text-muted-foreground">
                编译诊断（{result.checks?.length ?? 0} 项）
              </summary>
              <div className="mt-1 flex flex-col gap-0.5">
                {(result.checks ?? []).map((item) => (
                  <div key={item.id ?? item.label} className="text-[10px]">
                    <span className={(item.state ?? '').toUpperCase() === 'PASS' ? 'text-muted-foreground' : 'text-destructive'}>
                      {item.state ?? ''}
                    </span>
                    {' '}{item.label ?? item.id ?? ''}
                    {item.message ? <span className="text-muted-foreground">：{item.message}</span> : null}
                  </div>
                ))}
              </div>
            </details>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">编译后的提示词（可编辑，应用后注入任务段）</span>
              <textarea
                className="min-h-40 w-full rounded border border-border bg-card p-1 font-mono text-[10px] leading-relaxed"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[10px]"
                disabled={!draft.trim()}
                onClick={() => {
                  onApply(draft.trim(), result?.reference_video ?? undefined)
                  onClose()
                }}
              >
                应用到相机段
              </Button>
              {result?.reference_video?.video ? (
                <span className="text-[9px] text-muted-foreground" title={result.reference_video.video}>
                  并落地参考视频：{result.reference_video.frames} 帧 @
                  {Math.round(result.reference_video.fps ?? 24)}fps → {(result.reference_video.video.split('/').pop() ?? '')}
                </span>
              ) : null}
              {result?.reference_video?.video ? null : (
                <span className="text-[10px] text-muted-foreground">应用后：生成时注入任务段提示词</span>
              )}
            </div>
          </>
        ) : null}
          </>
        )}
      </div>
    </div>
  )
}
