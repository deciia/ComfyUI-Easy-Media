import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PlanPreview, formatPlanSegmentBrief, type StoryboardPlan } from './PlanPreview'
import { readWorkspace, subscribeWorkspace, writeWorkspace } from './agentStore'
import type { MultiTrackSegment } from '@/types/multitrack'

export type WorkspaceTab = 'storyboard' | 'subjects' | 'assets' | 'enhance'

const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const BORDER = 'hsl(var(--border, 240 6% 25%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'

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
  onApplyPlan?: (items: Array<{ name: string; durationFrames: number; brief: string; prompt?: string }>) => boolean
  onImportPlanSubjects?: (plan: StoryboardPlan) => void
  onImportPlanResources?: (plan: StoryboardPlan) => void
  planning?: boolean
  projectKey?: string
  /** 已废弃：对话移到常驻右栏，保留字段避免调用方类型报错 */
  onPlan?: any
  onAgent?: any
}

interface Card {
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
  for (const match of text.matchAll(/<(Subject|Picture|Audio|Video)\s+(\d+)>/g)) found.add(match[0])
  return Array.from(found).slice(0, 6)
}

function buildCards(segments: MultiTrackSegment[], frameRate: number): Card[] {
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

/** 分镜编排（左侧区域）：镜头卡 + 预览/详情；AI 对话在常驻右栏。 */
export function StoryboardTab({
  segments,
  frameRate,
  selectedSegmentId,
  onSelectSegment,
  onWritePrompt,
  onGeneratePrompt,
  generating = false,
  error = '',
  onApplyPlan,
  onImportPlanSubjects,
  onImportPlanResources,
  projectKey: incomingProjectKey,
}: StoryboardTabProps) {
  const projectKey = incomingProjectKey || (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'
  const cards = useMemo(() => buildCards(segments, frameRate), [segments, frameRate])
  const selected = cards.find((card) => card.id === selectedSegmentId) ?? cards[0]

  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [appliedNote, setAppliedNote] = useState('')
  const [importedNote, setImportedNote] = useState('')
  const [, setStoreVersion] = useState(0)

  // 直接读共享存储：避免局部副本与右栏写入不同步
  const plan = (readWorkspace(projectKey).plan as StoryboardPlan | null) ?? null
  const busy = Boolean(readWorkspace(projectKey).agentBusy)

  useEffect(() => subscribeWorkspace(projectKey, () => {
    setStoreVersion((value) => value + 1)
  }), [projectKey])

  const draft = selected ? (drafts[selected.id] ?? selected.prompt) : ''

  const preview = (value: StoryboardPlan) => (
    <PlanPreview
      plan={value}
      saved={false}
      appliedNote={appliedNote}
      importedNote={importedNote}
      onBack={() => writeWorkspace(projectKey, { plan: null })}
      onSaveDraft={() => {
        try {
          window.localStorage.setItem(`easy-media-storyboard:${projectKey}`, JSON.stringify(value))
          setImportedNote('草稿已保存')
        } catch (saveError) {
          setImportedNote(`保存失败：${String(saveError)}`)
        }
      }}
      onImportSubjects={onImportPlanSubjects ? () => {
        onImportPlanSubjects(value)
        setImportedNote('已导入主体到「主体定义」页')
      } : undefined}
      onImportResources={onImportPlanResources ? () => {
        onImportPlanResources(value)
        setImportedNote('已把资源需求导入「资源与生成」页')
      } : undefined}
      onApply={() => {
        if (!onApplyPlan) return false
        const ok = onApplyPlan(value.segments.map((segment) => ({
          name: segment.name,
          durationFrames: segment.duration_frames,
          brief: formatPlanSegmentBrief(segment),
        })))
        setAppliedNote(ok ? '已应用到任务轨（可 Ctrl+Z 撤销）' : '应用失败：请先选中任务片段')
        return ok
      }}
    />
  )

  // 空任务轨：骨架 / 预览 / 引导
  if (cards.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="text-[12px] font-medium">镜头卡</div>
        {busy ? (
          <div className="flex flex-col gap-1">
            {[1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: FIELD_BG, border: `1px solid ${BORDER}`, opacity: 0.55 }}>
                <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: PRIMARY }} />
                <span className="text-[11px] text-muted-foreground">第 {index} 段 生成中…</span>
              </div>
            ))}
          </div>
        ) : plan ? (
          <div className="flex min-h-0 flex-1 flex-col">{preview(plan)}</div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <div className="max-w-[420px] text-[12px] leading-relaxed text-muted-foreground">
              任务轨还没有片段。
              <br />在右侧告诉助手你的想法（例如「写一个天空鲸落掉深海回家的故事」），
              生成分镜后点「应用到任务轨」就会落成片段。
            </div>
          </div>
        )}
        {error ? <div className="text-[11px]" style={{ color: '#fbbf24' }}>{error}</div> : null}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[220px] shrink-0 flex-col gap-1 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="px-1 pb-1 text-[11px] text-muted-foreground">镜头卡</div>
        {cards.map((card) => {
          const active = card.id === selected?.id
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelectSegment?.(card.id)}
              className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-left"
              style={{
                background: active ? `${PRIMARY} / 0.16` : FIELD_BG,
                border: `1px solid ${active ? PRIMARY : BORDER}`,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium">{card.index}. {card.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{card.seconds.toFixed(1)}s</span>
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span>{card.shots} 镜</span>
                {card.tokens.slice(0, 2).map((token) => (
                  <span key={token} className="rounded-full px-1" style={{ border: `1px solid ${BORDER}`, color: 'hsl(var(--highlight, 45 90% 55%))' }}>
                    {token}
                  </span>
                ))}
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-auto p-2">
        {plan ? preview(plan) : selected ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">镜头 {selected.index} · {selected.label}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {selected.startFrame}–{selected.endFrame} 帧（{selected.seconds.toFixed(2)}s）
              </span>
            </div>
            <textarea
              style={{ ...fieldStyle, minHeight: 300, resize: 'vertical', fontSize: 12, lineHeight: 1.6 }}
              value={draft}
              placeholder="这一段的提示词草稿（可引用 <Subject n> / <Picture n>）"
              onChange={(event) => {
                if (!selected) return
                setDrafts((current) => ({ ...current, [selected.id]: event.target.value }))
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => selected && onWritePrompt?.(selected.id, draft)} disabled={!onWritePrompt || draft === selected.prompt}>
                写入本段
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!onGeneratePrompt || generating}
                onClick={async () => {
                  if (!selected || !onGeneratePrompt) return
                  const next = await onGeneratePrompt(selected.id, draft)
                  if (next) setDrafts((current) => ({ ...current, [selected.id]: next }))
                }}
              >
                {generating ? '生成中…' : 'AI 优化本段'}
              </Button>
            </div>
          </div>
        ) : null}
        {appliedNote ? <div className="mt-2 text-[10px]" style={{ color: PRIMARY }}>{appliedNote}</div> : null}
        {error ? <div className="mt-2 text-[11px]" style={{ color: '#fbbf24' }}>{error}</div> : null}
      </div>
    </div>
  )
}

export function SimpleTab({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col gap-2 p-4">
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  )
}
