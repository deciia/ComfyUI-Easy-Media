import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PlanPreview, type StoryboardPlan } from './PlanPreview'
import { createEmptyPlan, ensureHydrated, mutatePlanSegments, readWorkspace, subscribeWorkspace, writeWorkspace } from './agentStore'
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
  onOpenAssets?: () => void
  planning?: boolean
  projectKey?: string
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

/** 分镜编排：左=分镜脚本（plan）+ 任务轨片段；中=整版预览/单段详情/落地编辑。AI 对话在常驻右栏。 */
export function StoryboardTab({
  segments,
  frameRate,
  selectedSegmentId,
  onSelectSegment,
  onWritePrompt,
  onGeneratePrompt,
  generating = false,
  error = '',
  onImportPlanSubjects,
  onImportPlanResources,
  onOpenAssets,
}: StoryboardTabProps) {
  const projectKey = (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'
  const cards = useMemo(() => buildCards(segments, frameRate), [segments, frameRate])
  const timelineSelected = cards.find((card) => card.id === selectedSegmentId) ?? null

  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [appliedNote] = useState('')
  const [importedNote, setImportedNote] = useState('')
  const [, setStoreVersion] = useState(0)
  const [planFocus, setPlanFocus] = useState<number | null>(null)

  const plan = (readWorkspace(projectKey).plan as StoryboardPlan | null) ?? null
  const busy = Boolean(readWorkspace(projectKey).agentBusy)

  useEffect(() => {
    ensureHydrated(projectKey)
    setStoreVersion((value) => value + 1)
    return subscribeWorkspace(projectKey, () => {
      setStoreVersion((value) => value + 1)
    })
  }, [projectKey])

  // 标题栏 💾：草稿已自动持久化，这里给个确认反馈
  useEffect(() => {
    function onSave() {
      setImportedNote('分镜草稿已自动保存 ✓')
    }
    window.addEventListener('easy-media.workspace.save', onSave)
    return () => window.removeEventListener('easy-media.workspace.save', onSave)
  }, [])

  const draft = timelineSelected ? (drafts[timelineSelected.id] ?? timelineSelected.prompt) : ''

  const preview = (value: StoryboardPlan) => (
    <PlanPreview
      plan={value}
      saved={false}
      appliedNote={appliedNote}
      importedNote={importedNote}
      onBack={() => setPlanFocus(null)}
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
        setImportedNote('已把主体导入「主体与资源」页')
      } : undefined}
      onImportResources={onImportPlanResources ? () => {
        onImportPlanResources(value)
        setImportedNote('已把资源需求导入「主体与资源」页（缺件需补素材）')
      } : undefined}
      editable
      onMutateSegments={(fn) => mutatePlanSegments(projectKey, frameRate, fn)}
    />
  )

  const planSegment = plan && planFocus != null ? plan.segments[planFocus] : null
  const planDetail = planSegment ? (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{planSegment.index}. {planSegment.name}</span>
        {planSegment.beat ? <span className="rounded-full px-1.5 text-[10px]" style={{ border: `1px solid ${BORDER}` }}>{planSegment.beat}</span> : null}
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {planSegment.duration_seconds}s · {planSegment.duration_frames}f · {(planSegment.shots ?? []).length} 镜
        </span>
        <span className="ml-auto" />
        <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => setPlanFocus(null)}>
          返回整版
        </Button>
      </div>
      {planSegment.summary ? <div className="text-[12px] leading-relaxed">{planSegment.summary}</div> : null}
      {planSegment.director_note ? (
        <div className="text-[11px] leading-relaxed text-muted-foreground">导演说明：{planSegment.director_note}</div>
      ) : null}
      <div className="flex flex-col gap-1">
        {(planSegment.shots ?? []).map((shot) => {
          const shotAny = shot as unknown as Record<string, unknown>
          const dialogue = (shotAny.dialogue as Array<{ speaker?: string; line?: string }> | undefined) ?? []
          return (
            <div key={String(shotAny.shot ?? shotAny.framing)} className="rounded px-2 py-1 text-[11px] leading-relaxed" style={{ background: FIELD_BG }}>
              <div className="flex flex-wrap items-center gap-1.5">
                {shotAny.framing ? <span className="rounded px-1 text-[10px]" style={{ border: `1px solid ${BORDER}` }}>{String(shotAny.framing)}</span> : null}
                {shotAny.camera ? <span className="text-[10px] text-muted-foreground">{String(shotAny.camera)}</span> : null}
              </div>
              {shotAny.action ? <div>{String(shotAny.action)}</div> : null}
              {dialogue.length > 0 ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {dialogue.map((line, index) => (
                    <div key={index}>
                      {line.speaker ? <span className="text-muted-foreground">{line.speaker}：</span> : null}
                      「{line.line}」
                    </div>
                  ))}
                </div>
              ) : null}
              {shotAny.micro_expression ? <div className="text-[10px] text-muted-foreground">微表情：{String(shotAny.micro_expression)}</div> : null}
              {shotAny.sound ? <div className="text-[10px] text-muted-foreground">声音：{String(shotAny.sound)}</div> : null}
              {shotAny.transition ? <div className="text-[10px] text-muted-foreground">衔接：{String(shotAny.transition)}</div> : null}
            </div>
          )
        })}
      </div>
      {(planSegment.subjects ?? []).length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">主体：</span>
          {(planSegment.subjects as Array<{ name: string; type?: string }>).map((subject) => (
            <span key={subject.name} className="rounded-full px-1.5" style={{ border: `1px solid ${BORDER}`, color: 'hsl(var(--highlight, 45 90% 55%))' }}>
              {subject.name}({subject.type})
            </span>
          ))}
        </div>
      ) : null}
      {(planSegment.resources ?? []).length > 0 ? (() => {
        const pool = readWorkspace(projectKey).resources ?? []
        const statusOf = (name: string) => {
          const hit = pool.find((item) => item.type !== 'Subject' && item.name === name)
          if (!hit) return 'absent'
          return hit.status === 'ready' ? 'ready' : 'need'
        }
        const entries = planSegment.resources as Array<{ kind?: string; name: string }>
        const readyCount = entries.filter((item) => statusOf(item.name) === 'ready').length
        const missingCount = entries.filter((item) => statusOf(item.name) !== 'ready').length
        return (
          <div className="flex flex-wrap items-center gap-1 text-[10px]">
            <span className="text-muted-foreground">
              资源（池中 ✓{readyCount} · 缺 {missingCount}）：
            </span>
            {entries.map((resource, index) => {
              const status = statusOf(resource.name)
              const color = status === 'ready' ? PRIMARY : status === 'need' ? '#fbbf24' : undefined
              return (
                <span
                  key={`${resource.kind}-${resource.name}-${index}`}
                  className="rounded-full px-1.5"
                  style={{ border: `1px solid ${color ?? BORDER}`, color }}
                  title={status === 'ready' ? '已在资源池且已绑定素材' : status === 'need' ? '在资源池但缺素材' : '还没加入资源池'}
                >
                  {status === 'ready' ? '✓' : status === 'need' ? '缺' : '·'}{resource.kind}:{resource.name}
                </span>
              )
            })}
            {onOpenAssets ? (
              <button
                type="button"
                className="ml-1 rounded px-1.5 py-0.5"
                style={{ border: `1px solid ${BORDER}` }}
                onClick={onOpenAssets}
              >
                去「主体与资源」补件
              </button>
            ) : null}
          </div>
        )
      })() : null}
    </div>
  ) : null

  // 左栏统一：busy 骨架 / plan 分组 / 任务轨分组
  const leftColumn = (
    <div className="flex w-[220px] shrink-0 flex-col gap-1 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
      {busy ? (
        <>
          <div className="px-1 pb-1 text-[11px] text-muted-foreground">分镜脚本（生成中）</div>
          <div className="flex flex-col gap-1">
            {[1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: FIELD_BG, border: `1px solid ${BORDER}`, opacity: 0.55 }}>
                <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: PRIMARY }} />
                <span className="text-[11px] text-muted-foreground">第 {index} 段 生成中…</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {!busy && plan ? (
        <>
          <div className="px-1 pb-1 text-[11px] text-muted-foreground">分镜脚本（{plan.segments.length} 段 · 未落地）</div>
          {plan.segments.map((segment, index) => {
            const active = planFocus === index
            return (
              <button
                key={`${index}-${segment.name}`}
                type="button"
                onClick={() => setPlanFocus(index)}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left"
                style={{
                  background: active ? `${PRIMARY} / 0.16` : FIELD_BG,
                  border: `1px solid ${active ? PRIMARY : BORDER}`,
                }}
              >
                <span className="truncate text-[12px] font-medium">{index + 1}. {segment.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{segment.duration_seconds}s</span>
              </button>
            )
          })}
          <button
            type="button"
            className="mt-0.5 rounded px-2 py-1 text-left text-[10px] text-muted-foreground"
            style={{ border: `1px dashed ${BORDER}` }}
            onClick={() => setPlanFocus(null)}
          >
            查看整版预览
          </button>
        </>
      ) : null}
      {cards.length > 0 ? (
        <>
          <div className="mt-1 px-1 pb-1 text-[11px] text-muted-foreground">任务轨片段（已落地）</div>
          {cards.map((card) => {
            const active = card.id === timelineSelected?.id
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
        </>
      ) : null}
      {!busy && !plan && cards.length === 0 ? (
        <div className="px-1 text-[10px] leading-relaxed text-muted-foreground">
          还没有分镜。在右侧让助手生成，或点下方按钮手动新建。
        </div>
      ) : null}
    </div>
  )

  // 中栏
  const middle = (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto p-2">
      {planFocus != null && planDetail ? (
        planDetail
      ) : plan ? (
        preview(plan)
      ) : timelineSelected ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">镜头 {timelineSelected.index} · {timelineSelected.label}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {timelineSelected.startFrame}–{timelineSelected.endFrame} 帧（{timelineSelected.seconds.toFixed(2)}s）
            </span>
          </div>
          <textarea
            style={{ ...fieldStyle, minHeight: 300, resize: 'vertical', fontSize: 12, lineHeight: 1.6 }}
            value={draft}
            placeholder="这一段的提示词草稿（可引用 <Subject n> / <Picture n>）"
            onChange={(event) => {
              if (!timelineSelected) return
              setDrafts((current) => ({ ...current, [timelineSelected.id]: event.target.value }))
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => timelineSelected && onWritePrompt?.(timelineSelected.id, draft)} disabled={!onWritePrompt || draft === timelineSelected.prompt}>
              写入本段
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!onGeneratePrompt || generating}
              onClick={async () => {
                if (!timelineSelected || !onGeneratePrompt) return
                const next = await onGeneratePrompt(timelineSelected.id, draft)
                if (next) setDrafts((current) => ({ ...current, [timelineSelected.id]: next }))
              }}
            >
              {generating ? '生成中…' : 'AI 优化本段'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="flex max-w-[460px] flex-col items-center gap-3 text-[12px] leading-relaxed text-muted-foreground">
            <div className="text-center">
              可以在右侧让助手生成分镜，也可以直接手动新建：
              <br />分镜会保存为项目草稿；导入主体/资源需求到「主体与资源」补齐素材后，再用标题栏保存按钮落到任务轨。
            </div>
            <Button size="sm" variant="secondary" onClick={() => createEmptyPlan(projectKey, frameRate)}>
              ✚ 手动新建分镜
            </Button>
          </div>
        </div>
      )}
      {importedNote ? <div className="mt-2 text-[10px] text-muted-foreground">{importedNote}</div> : null}
      {error ? <div className="mt-2 text-[11px]" style={{ color: '#fbbf24' }}>{error}</div> : null}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1">
      {leftColumn}
      {middle}
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
