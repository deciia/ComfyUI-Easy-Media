import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

interface ExtractMotionDialogProps {
  open: boolean
  defaultVideo?: string
  onClose: () => void
  onApply: (editorState: Record<string, unknown>) => void
}

interface ExtractResult {
  editor_state?: Record<string, unknown>
  keyframe_count?: number
  method?: string
  coverage?: number | null
  error?: string
}

type StepState = 'todo' | 'active' | 'done' | 'failed'

function Step({ index, label, state }: { index: number; label: string; state: StepState }) {
  const color = state === 'done'
    ? 'border-primary text-primary'
    : state === 'active'
      ? 'border-foreground text-foreground'
      : state === 'failed'
        ? 'border-destructive text-destructive'
        : 'border-border text-muted-foreground'
  return (
    <div className="flex items-center gap-1">
      <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${color}`}>
        {index}
      </span>
      <span className={`text-[10px] ${state === 'todo' ? 'text-muted-foreground' : ''}`}>{label}</span>
    </div>
  )
}

export function ExtractMotionDialog({ open, defaultVideo, onClose, onApply }: ExtractMotionDialogProps) {
  const [mode, setMode] = useState<'track' | 'reconstruct'>('track')
  const [video, setVideo] = useState(defaultVideo ?? '')
  const [method, setMethod] = useState('auto')
  const [maxDimension, setMaxDimension] = useState(840)
  const [simplify, setSimplify] = useState(true)
  const [positionSmoothing, setPositionSmoothing] = useState(0.15)
  const [motionScale, setMotionScale] = useState(1)
  const [levelHorizon, setLevelHorizon] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExtractResult | null>(null)
  const [applied, setApplied] = useState(false)

  const stepStates = useMemo<StepState[]>(() => {
    if (busy) return ['done', 'done', 'active', 'todo', 'todo']
    if (error) return ['failed', 'todo', 'todo', 'todo', 'todo']
    if (result) return ['done', 'done', 'done', applied ? 'done' : 'active', applied ? 'done' : 'todo']
    return ['active', 'todo', 'todo', 'todo', 'todo']
  }, [busy, error, result, applied])

  if (!open) return null

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    setApplied(false)
    try {
      const response = await fetch('/easy-media/camera/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video,
          method,
          max_dimension: maxDimension,
          simplify_keys: simplify,
          position_smoothing: positionSmoothing,
          motion_scale: motionScale,
          horizon_stabilization: levelHorizon,
        }),
      })
      const payload = await response.json() as ExtractResult
      if (!response.ok) {
        setError(payload.error ?? `提取失败（HTTP ${response.status}）`)
        return
      }
      setResult(payload)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const keyframes = result?.keyframe_count ?? 0
  const frames = keyframes
  const grade = error ? 'UNKNOWN' : result ? (keyframes > 30 ? 'GOOD' : 'FAIR') : 'UNKNOWN'
  const trackingState = busy ? 'TRACKING' : result ? 'DONE' : error ? 'FAILED' : 'IDLE'

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4" role="dialog">
      <div className="flex max-h-[88vh] w-[min(820px,94vw)] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-background p-3 text-[11px]">
        {/* 标题 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">OmniCam Extractor</span>
            <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">
              {busy ? 'RUNNING' : result ? 'DONE' : 'IDLE'}
            </span>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClose}>
            关闭
          </Button>
        </div>

        {/* 模式 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded border px-2 py-0.5 text-[10px] ${mode === 'track' ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}
            onClick={() => setMode('track')}
          >
            相机轨迹
          </button>
          <button
            type="button"
            disabled
            title="场景重建需要单张图像 + 深度模型，暂未接入"
            className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground opacity-50"
          >
            场景重建（暂未接入）
          </button>
        </div>

        {/* 步骤条 */}
        <div className="flex items-center gap-3 rounded border border-border px-2 py-1">
          <Step index={1} label="来源" state={stepStates[0]} />
          <span className="text-muted-foreground">→</span>
          <Step index={2} label="轨迹" state={stepStates[1]} />
          <span className="text-muted-foreground">→</span>
          <Step index={3} label="解算" state={stepStates[2]} />
          <span className="text-muted-foreground">→</span>
          <Step index={4} label="细化" state={stepStates[3]} />
          <span className="text-muted-foreground">→</span>
          <Step index={5} label="输出" state={stepStates[4]} />
        </div>

        {/* 来源 */}
        <div className="flex flex-col gap-1 rounded border border-border p-2">
          <span className="text-[10px] text-muted-foreground">来源视频（项目视频轨文件，或 input/ 下的相对路径）</span>
          <input
            className="h-6 w-full rounded border border-border bg-card px-1 text-[10px]"
            value={video}
            placeholder="例：yusheng/ep1/xz_ref_v2_2s.mp4"
            onChange={(event) => setVideo(event.target.value)}
          />
          <span className="text-[9px] text-muted-foreground">
            提示：灰盒预演纹理太少会解算失败；请用实拍/有纹理的素材
          </span>
        </div>

        {/* 解算参数 */}
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">求解器</span>
            <select
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <option value="auto">自动（dpvo → pycolmap → opencv_sift）</option>
              <option value="opencv_sift">OpenCV SIFT（本机可用）</option>
              <option value="dpvo">DPVO（需安装）</option>
              <option value="pycolmap">pycolmap（需安装）</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">分析分辨率上限</span>
            <input
              type="number"
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={maxDimension}
              onChange={(event) => setMaxDimension(Number(event.target.value) || 840)}
            />
          </label>
        </div>

        {/* 清理 */}
        <div className="flex flex-col gap-1 rounded border border-border p-2">
          <span className="text-[10px] text-muted-foreground">清理（CLEANUP）</span>
          <label className="flex items-center gap-2 text-[10px]">
            <span className="w-24 text-muted-foreground">位置平滑</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={positionSmoothing}
              onChange={(event) => setPositionSmoothing(Number(event.target.value))}
              className="flex-1"
            />
            <span className="w-8 text-right">{positionSmoothing.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2 text-[10px]">
            <span className="w-24 text-muted-foreground">运动缩放</span>
            <input
              type="range" min={0.1} max={5} step={0.1}
              value={motionScale}
              onChange={(event) => setMotionScale(Number(event.target.value))}
              className="flex-1"
            />
            <span className="w-8 text-right">{motionScale.toFixed(1)}</span>
          </label>
          <label className="flex items-center gap-2 text-[10px]">
            <span className="w-24 text-muted-foreground">水平校正</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={levelHorizon}
              onChange={(event) => setLevelHorizon(Number(event.target.value))}
              className="flex-1"
            />
            <span className="w-8 text-right">{levelHorizon.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <input type="checkbox" checked={simplify} onChange={(event) => setSimplify(event.target.checked)} />
            简化关键帧
          </label>
        </div>

        {/* 操作 */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-[10px]"
            disabled={busy || !video.trim()}
            onClick={() => { void run() }}
          >
            {busy ? '解算中…' : '开始解算'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[10px]"
            disabled={!result || keyframes <= 0}
            onClick={() => {
              if (!result?.editor_state) return
              onApply(result.editor_state)
              setApplied(true)
            }}
          >
            应用到相机段
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {result ? `关键帧 ${keyframes} · ${result.method ?? ''}` : '未解算'}
          </span>
        </div>

        {error ? <div className="whitespace-pre-wrap rounded border border-destructive/50 p-2 text-[10px] text-destructive">{error}</div> : null}

        {/* 诊断 */}
        <div className="rounded border border-border">
          <div className="border-b border-border px-2 py-1 text-[10px] font-medium">解算诊断（SOLVE DIAGNOSTICS）</div>
          <div className="grid grid-cols-2 gap-x-4 px-2 py-1 text-[10px]">
            <div className="flex justify-between"><span className="text-muted-foreground">帧数</span><span>{frames}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">跟踪状态</span><span>{trackingState}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">解算状态</span><span>{result ? 'SOLVED' : error ? 'FAILED' : 'UNKNOWN'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">运动评分</span><span>{grade}</span></div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">覆盖率</span>
              <span>{typeof result?.coverage === 'number' ? `${(result.coverage * 100).toFixed(0)}%` : '—'}</span>
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">已应用</span><span>{applied ? 'YES' : 'NO'}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
