import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PlanPreview, formatPlanSegmentBrief, type StoryboardPlan } from './PlanPreview'
import type { MultiTrackSegment } from '@/types/multitrack'

export type WorkspaceTab = 'storyboard' | 'subjects' | 'assets' | 'enhance'

const PANEL_BG = 'hsl(var(--card, 240 10% 10%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const BORDER = 'hsl(var(--border, 240 6% 25%))'

const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: '#e5e5e5',
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
}

export interface StoryboardTabProps {
  segments: MultiTrackSegment[]
  frameRate: number
  selectedSegmentId?: string
  onSelectSegment?: (id: string) => void
  onWritePrompt?: (segmentId: string, prompt: string) => void
  onGeneratePrompt?: (segmentId: string, brief: string) => Promise<string>
  generating?: boolean
  error?: string
  /** 导演级分镜规划（AI） */
  onPlan?: (input: {
    brief: string
    durationSeconds: number
    ratio: string
    style: string
  }) => Promise<StoryboardPlan | null>
  /** 把规划结果应用到任务轨（由多轨编辑器注册表执行） */
  onApplyPlan?: (items: Array<{ name: string; durationFrames: number; brief: string; prompt?: string }>) => boolean
  /** 规划结果里的主体/资源需求导入工作台 */
  onImportPlanSubjects?: (plan: StoryboardPlan) => void
  onImportPlanResources?: (plan: StoryboardPlan) => void
  planning?: boolean
}

interface StoryboardCard {
  id: string
  index: number
  label: string
  seconds: number
  startFrame: number
  endFrame: number
  prompt: string
  shots: number
  tokens: string[]
}

function tokensOf(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/<(Subject|Picture|Audio|Video)\s+(\d+)>/g)) {
    found.add(match[0])
  }
  return Array.from(found).slice(0, 8)
}

function buildCards(segments: MultiTrackSegment[], frameRate: number): StoryboardCard[] {
  return segments.map((segment, index) => {
    const content = segment.content as unknown as Record<string, unknown>
    const prompt = String(content?.user_prompt ?? content?.user_brief ?? '')
    const firstLine = prompt.split('\n').find((line) => line.trim()) ?? ''
    const label = firstLine.replace(/<[^>]+>/g, '').trim().slice(0, 18) || `镜头 ${index + 1}`
    const shots = (prompt.match(/\[Shot\s+\d+\]/gi) || []).length || (firstLine ? 1 : 0)
    return {
      id: segment.id,
      index: index + 1,
      label,
      seconds: Math.max(0, segment.end_frame - segment.start_frame) / Math.max(1, frameRate),
      startFrame: segment.start_frame,
      endFrame: segment.end_frame,
      prompt,
      shots,
      tokens: tokensOf(prompt),
    }
  })
}

/** 分镜编排：左边镜头卡，中间单镜详情，右边时间轴联动。 */
export function StoryboardTab({
  segments,
  frameRate,
  selectedSegmentId,
  onSelectSegment,
  onWritePrompt,
  onGeneratePrompt,
  generating = false,
  error = '',
  onPlan,
  onApplyPlan,
  onImportPlanSubjects,
  onImportPlanResources,
  planning = false,
}: StoryboardTabProps) {
  const cards = useMemo(() => buildCards(segments, frameRate), [segments, frameRate])
  const selected = cards.find((card) => card.id === selectedSegmentId) ?? cards[0]
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [story, setStory] = useState('')
  const [durationSeconds, setDurationSeconds] = useState(30)
  const [ratio, setRatio] = useState('16:9')
  const [style, setStyle] = useState('')
  const [plan, setPlan] = useState<StoryboardPlan | null>(null)
  const [planSaved, setPlanSaved] = useState(false)
  const [appliedNote, setAppliedNote] = useState('')
  const [importedNote, setImportedNote] = useState('')
  const draft = selected ? (drafts[selected.id] ?? selected.prompt) : ''
  const totalFrames = Math.max(1, ...cards.map((card) => card.endFrame))

  if (plan) {
    return (
      <PlanPreview
        plan={plan}
        saved={planSaved}
        onBack={() => setPlan(null)}
        appliedNote={appliedNote}
        onImportSubjects={onImportPlanSubjects ? () => {
          onImportPlanSubjects(plan)
          setImportedNote('已导入主体到「主体定义」页')
        } : undefined}
        onImportResources={onImportPlanResources ? () => {
          onImportPlanResources(plan)
          setImportedNote('已把资源需求导入「资源与生成」页')
        } : undefined}
        importedNote={importedNote}
        onSaveDraft={() => {
          try {
            window.localStorage.setItem('easy-media-storyboard-draft', JSON.stringify(plan))
            setPlanSaved(true)
          } catch (error) {
            console.warn('[EasyMedia] save storyboard draft failed', error)
          }
        }}
        onApply={() => {
          if (!onApplyPlan) return false
          const ok = onApplyPlan(plan.segments.map((segment) => ({
            name: segment.name,
            durationFrames: segment.duration_frames,
            brief: formatPlanSegmentBrief(segment),
          })))
          setAppliedNote(ok ? '已应用到任务轨（可用 Ctrl+Z 撤销）' : '应用失败：请先在编辑器里选中任务片段')
          return ok
        }}
      />
    )
  }

  const planner = (
    <div className="flex shrink-0 flex-col gap-1 border-b px-3 py-2" style={{ borderColor: BORDER }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium">我的想法</span>
        <span className="text-[10px] text-muted-foreground">说清楚想拍什么即可，AI 负责分镜、台词、节奏与微表情</span>
        <span className="ml-auto" />
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          总时长
          <input
            style={{ ...fieldStyle, width: 56 }}
            value={String(durationSeconds)}
            onChange={(event) => setDurationSeconds(Math.max(3, Number(event.target.value) || 30))}
          />
          秒
        </label>
        <select style={{ ...fieldStyle, width: 74 }} value={ratio} onChange={(event) => setRatio(event.target.value)}>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
        </select>
        <input
          style={{ ...fieldStyle, width: 140 }}
          placeholder="风格（可选）"
          value={style}
          onChange={(event) => setStyle(event.target.value)}
        />
        <Button
          size="sm"
          disabled={!onPlan || planning || !story.trim()}
          onClick={async () => {
            if (!onPlan) return
            const next = await onPlan({ brief: story, durationSeconds, ratio, style })
            if (next) {
              setPlan(next)
              setPlanSaved(false)
            }
          }}
        >
          {planning ? '规划中…' : 'AI 规划整片'}
        </Button>
      </div>
      <textarea
        style={{ ...fieldStyle, minHeight: 64, resize: 'vertical', fontSize: 12, lineHeight: 1.6 }}
        placeholder="例：老赵在修配厂门口发现车主偷偷把车开走，追上去拦住他；全程方言对话，结尾留悬念。"
        value={story}
        onChange={(event) => setStory(event.target.value)}
      />
      {error ? (
        <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>{error}</div>
      ) : null}
    </div>
  )

  if (cards.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {planner}
        <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-muted-foreground">
          任务轨还没有片段。可以直接用上面的「AI 规划整片」生成分镜，或先在多轨编辑器里添加任务片段。
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {planner}
      <div className="flex min-h-0 flex-1">
      {/* 左：镜头卡 */}
      <div className="flex w-[240px] shrink-0 flex-col gap-1 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-muted-foreground">
          <span>镜头卡</span>
          <span>{cards.length} 段 · {frameRate}fps</span>
        </div>
        {cards.map((card) => {
          const active = card.id === selected?.id
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelectSegment?.(card.id)}
              className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-left"
              style={{
                background: active ? 'hsl(var(--primary, 199 89% 48%) / 0.16)' : FIELD_BG,
                border: `1px solid ${active ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium">
                  {card.index}. {card.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {card.seconds.toFixed(1)}s
                </span>
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span>{card.shots} 镜</span>
                {card.tokens.slice(0, 3).map((token) => (
                  <span
                    key={token}
                    className="rounded-full px-1"
                    style={{ border: `1px solid ${BORDER}`, color: 'hsl(var(--highlight, 45 90% 55%))' }}
                  >
                    {token}
                  </span>
                ))}
                {card.tokens.length > 3 ? <span>+{card.tokens.length - 3}</span> : null}
              </div>
            </button>
          )
        })}
      </div>

      {/* 中：单镜详情 */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">
                镜头 {selected.index} · {selected.label}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {selected.startFrame}–{selected.endFrame} 帧（{selected.seconds.toFixed(2)}s）
              </span>
              <span className="rounded border px-1 text-[10px] text-muted-foreground" style={{ borderColor: BORDER }}>
                {selected.shots} 个镜头
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">引用：</span>
              {selected.tokens.length === 0 ? (
                <span className="text-muted-foreground">（无）</span>
              ) : (
                selected.tokens.map((token) => (
                  <span
                    key={token}
                    className="rounded-full px-1.5 py-0.5"
                    style={{ border: `1px solid ${BORDER}`, color: 'hsl(var(--highlight, 45 90% 55%))' }}
                  >
                    {token}
                  </span>
                ))
              )}
            </div>

            <textarea
              style={{ ...fieldStyle, minHeight: 260, flex: 1, resize: 'vertical', fontSize: 12, lineHeight: 1.6 }}
              value={draft}
              placeholder="这一段的提示词草稿（中文手写即可，可引用 <Subject n> / <Picture n>）"
              onChange={(event) => setDrafts((current) => ({ ...current, [selected.id]: event.target.value }))}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => onWritePrompt?.(selected.id, draft)}
                disabled={!onWritePrompt || draft === selected.prompt}
              >
                写入本段
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!onGeneratePrompt || generating}
                onClick={async () => {
                  if (!onGeneratePrompt) return
                  const next = await onGeneratePrompt(selected.id, draft)
                  if (next) setDrafts((current) => ({ ...current, [selected.id]: next }))
                }}
              >
                {generating ? '生成中…' : 'AI 优化本段'}
              </Button>
              <span className="text-[10px] text-muted-foreground">
                只改这一段，其它段不动；写入后可点「应用到时间线」（下一步实现 diff）
              </span>
            </div>

            {error ? (
              <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>
                {error}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {/* 右：时间轴联动 */}
      <div className="flex w-[300px] shrink-0 flex-col gap-2 p-3" style={{ borderLeft: `1px solid ${BORDER}` }}>
        <div className="text-[11px] text-muted-foreground">时间轴预览（点选定位）</div>
        <div className="flex flex-col gap-1">
          {cards.map((card) => {
            const left = (card.startFrame / totalFrames) * 100
            const width = Math.max(1.5, ((card.endFrame - card.startFrame) / totalFrames) * 100)
            const active = card.id === selected?.id
            return (
              <button
                key={card.id}
                type="button"
                className="relative h-5 w-full rounded"
                style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}
                title={`${card.label} · ${card.seconds.toFixed(1)}s`}
                onClick={() => onSelectSegment?.(card.id)}
              >
                <span
                  className="absolute inset-y-0 rounded"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: active ? 'hsl(var(--primary, 199 89% 48%))' : 'hsl(var(--primary, 199 89% 48%) / 0.45)',
                  }}
                />
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>0</span>
          <span>{(totalFrames / frameRate).toFixed(1)}s</span>
        </div>
        <div className="mt-auto rounded-md p-2 text-[10px] leading-relaxed text-muted-foreground" style={{ border: `1px solid ${BORDER}`, background: PANEL_BG }}>
          四宫格草图预演、拆分/合并镜头、整片 AI 规划将在后续版本加入。
        </div>
      </div>
      </div>
    </div>
  )
}

/** ②③ 的占位页：先展示可读信息，后续接入写回。 */
export function SimpleTab({ title, hint, rows }: { title: string; hint: string; rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-4">
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
      <div className="flex flex-col divide-y" style={{ borderColor: BORDER }}>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 py-1.5 text-[12px]">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="truncate">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
