import { useState } from 'react'
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

export function ExtractMotionDialog({ open, defaultVideo, onClose, onApply }: ExtractMotionDialogProps) {
  const [video, setVideo] = useState(defaultVideo ?? '')
  const [method, setMethod] = useState('auto')
  const [maxDimension, setMaxDimension] = useState(840)
  const [simplify, setSimplify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExtractResult | null>(null)

  if (!open) return null

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = await fetch('/easy-media/camera/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video,
          method,
          max_dimension: maxDimension,
          simplify_keys: simplify,
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

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4" role="dialog">
      <div className="flex max-h-[85vh] w-[min(680px,92vw)] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-background p-3 text-[11px]">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium">从视频提取运镜（OmniCam Extractor）</div>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClose}>
            关闭
          </Button>
        </div>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            视频路径（项目视频轨文件、或 input/ 下的相对路径）
          </span>
          <input
            className="h-6 w-full rounded border border-border bg-card px-1 text-[10px]"
            value={video}
            placeholder="例：yusheng/ep1/xz_ref_v2_2s.mp4"
            onChange={(event) => setVideo(event.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">求解器</span>
            <select
              className="h-6 rounded border border-border bg-card px-1 text-[10px]"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <option value="auto">自动（优先 dpvo → pycolmap → opencv_sift）</option>
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

        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={simplify}
            onChange={(event) => setSimplify(event.target.checked)}
          />
          简化关键帧（保留运动形状，减少关键帧数量）
        </label>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-[10px]"
            disabled={busy || !video.trim()}
            onClick={() => { void run() }}
          >
            {busy ? '提取中…' : '开始提取'}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            提取基于单镜头连续画面；灰盒预演纹理太少会失败，请用实拍素材
          </span>
        </div>

        {error ? <div className="whitespace-pre-wrap text-[10px] text-destructive">{error}</div> : null}

        {result ? (
          <>
            <div className="text-[10px] text-muted-foreground">
              求解器：{result.method} · 关键帧：{keyframes}
              {typeof result.coverage === 'number' ? ` · 覆盖率：${(result.coverage * 100).toFixed(0)}%` : ''}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[10px]"
                disabled={keyframes <= 0 || !result.editor_state}
                onClick={() => {
                  if (result.editor_state) {
                    onApply(result.editor_state)
                    onClose()
                  }
                }}
              >
                应用到相机段
              </Button>
              <span className="text-[10px] text-muted-foreground">应用后 3D 视口会载入提取出的相机轨迹</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
