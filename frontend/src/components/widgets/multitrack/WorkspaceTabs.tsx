import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PlanPreview, formatPlanSegmentBrief, type StoryboardPlan } from './PlanPreview'
import type { MultiTrackSegment } from '@/types/multitrack'

export type WorkspaceTab = 'storyboard' | 'subjects' | 'assets' | 'enhance'

const PANEL_BG = 'hsl(var(--card, 240 10% 10%))'
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
  onPlan?: (input: {
    brief: string
    durationSeconds: number
    ratio: string
    style: string
    instruction?: string
    previousPlan?: StoryboardPlan
  }, signal?: AbortSignal) => Promise<StoryboardPlan | null>
  onAgent?: (
    payload: { messages: Array<{ role: string; text: string }>; context: Record<string, unknown> },
    handlers: {
      onStep: (label: string) => void
      onText: (text: string) => void
      onPlan: (plan: StoryboardPlan) => void
      onAction: (action: string) => void
    },
    signal?: AbortSignal,
  ) => Promise<void>
  onApplyPlan?: (items: Array<{ name: string; durationFrames: number; brief: string; prompt?: string }>) => boolean
  onImportPlanSubjects?: (plan: StoryboardPlan) => void
  onImportPlanResources?: (plan: StoryboardPlan) => void
  planning?: boolean
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

function titleOf(segment: MultiTrackSegment): string {
  const content = segment.content as unknown as Record<string, unknown>
  const prompt = String(content?.user_prompt ?? content?.user_brief ?? '')
  return (prompt.split('\n').find((line) => line.trim()) ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 18) || '未命名'
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
  onAgent,
  onApplyPlan,
  onImportPlanSubjects,
  onImportPlanResources,
  planning = false,
}: StoryboardTabProps) {
  const projectKey = (globalThis as unknown as { __easyMediaProjectName?: string }).__easyMediaProjectName || 'default'
  const cards = useMemo(() => buildCards(segments, frameRate), [segments, frameRate])
  const selected = cards.find((card) => card.id === selectedSegmentId) ?? cards[0]

  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [durationSeconds, setDurationSeconds] = useState(30)
  const [ratio, setRatio] = useState('16:9')
  const [style, setStyle] = useState('')
  const [plan, setPlan] = useState<StoryboardPlan | null>(() => {
    try {
      const raw = window.localStorage.getItem(`easy-media-storyboard:${projectKey}`)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })
  const [planSaved, setPlanSaved] = useState(false)
  const [appliedNote, setAppliedNote] = useState('')
  const [importedNote, setImportedNote] = useState('')
  const [rightTab, setRightTab] = useState<'chat' | 'timeline'>('chat')
  const [chatInput, setChatInput] = useState('')
  type AgentStep = { label: string; status: 'running' | 'done' | 'failed' }
  type AgentMessage = {
    id: string
    role: 'user' | 'assistant' | 'system'
    text: string
    steps?: AgentStep[]
    status?: 'running' | 'done' | 'failed'
    elapsedMs?: number
  }
  const [chatMessages, setChatMessages] = useState<AgentMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const draft = selected ? (drafts[selected.id] ?? selected.prompt) : ''
  const totalFrames = Math.max(1, ...cards.map((card) => card.endFrame))

  const selectCard = (id: string) => {
    onSelectSegment?.(id)
    setRightTab('timeline')
  }

  const updateMessage = (id: string, patch: Partial<AgentMessage>) => {
    setChatMessages((current) => current.map((message) => (message.id === id ? { ...message, ...patch } : message)))
  }

  async function sendMessage() {
    const text = chatInput.trim()
    if (!text || (!onPlan && !onAgent)) return
    setChatInput('')
    const stamp = Date.now()
    const userId = `u-${stamp}`
    const replyId = `a-${stamp}`
    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = Date.now()
    setChatMessages((current) => [
      ...current,
      { id: userId, role: 'user', text },
      { id: replyId, role: 'assistant', text: '', status: 'running', steps: [] },
    ])
    const timer = window.setInterval(() => {
      updateMessage(replyId, { elapsedMs: Date.now() - startedAt })
    }, 500)
    const pushStep = (label: string) => {
      setChatMessages((current) => current.map((message) => (
        message.id === replyId
          ? {
              ...message,
              steps: [
                ...(message.steps ?? []).map((step) => ({ ...step, status: 'done' as const })),
                { label, status: 'running' as const },
              ],
            }
          : message
      )))
    }
    const appendText = (chunk: string) => {
      setChatMessages((current) => current.map((message) => (
        message.id === replyId ? { ...message, text: `${message.text}${chunk}` } : message
      )))
    }
    const finish = (status: 'done' | 'failed') => {
      setChatMessages((current) => current.map((message) => (
        message.id === replyId
          ? {
              ...message,
              status,
              elapsedMs: Date.now() - startedAt,
              steps: (message.steps ?? []).map((step) => ({ ...step, status: 'done' as const })),
            }
          : message
      )))
    }
    try {
      if (onAgent) {
        await onAgent(
          {
            messages: [
              ...chatMessages.map((message) => ({ role: message.role, text: message.text })),
              { role: 'user', text },
            ],
            context: {
              project: projectKey,
              frame_rate: frameRate,
              ratio,
              plan,
              segments: segments.map((segment, index) => ({
                index: index + 1,
                name: titleOf(segment),
                duration_seconds: Math.max(0, segment.end_frame - segment.start_frame) / Math.max(1, frameRate),
              })),
            },
          },
          {
            onStep: pushStep,
            onText: appendText,
            onPlan: (next) => {
              setPlan(next)
              setAppliedNote('')
              setPlanSaved(false)
            },
            onAction: (action) => {
              if (action !== 'apply_storyboard' || !onApplyPlan || !plan) return
              onApplyPlan(plan.segments.map((segment) => ({
                name: segment.name,
                durationFrames: segment.duration_frames,
                brief: formatPlanSegmentBrief(segment),
              })))
              setAppliedNote('已应用到任务轨（可 Ctrl+Z 撤销）')
            },
          },
          controller.signal,
        )
        finish(controller.signal.aborted ? 'done' : 'done')
      } else if (onPlan) {
        const next = plan
          ? await onPlan({ brief: '', durationSeconds, ratio, style, instruction: text, previousPlan: plan }, controller.signal)
          : await onPlan({ brief: text, durationSeconds, ratio, style }, controller.signal)
        if (next) {
          setPlan(next)
          setAppliedNote('')
          setPlanSaved(false)
          appendText(`已完成：${next.segments.length} 段 / ${next.total_seconds}s。`)
        } else {
          appendText(error || '规划失败，请重试')
        }
        finish('done')
      }
    } catch (failure) {
      appendText(controller.signal.aborted ? '已停止。' : `请求失败：${String(failure)}`)
      finish(controller.signal.aborted ? 'done' : 'failed')
    } finally {
      window.clearInterval(timer)
      abortRef.current = null
    }
  }

  function stopMessage() {
    abortRef.current?.abort()
    abortRef.current = null
  }

  function saveDraft() {
    if (!plan) return
    try {
      window.localStorage.setItem(`easy-media-storyboard:${projectKey}`, JSON.stringify(plan))
      setPlanSaved(true)
      setImportedNote('草稿已保存')
    } catch (saveError) {
      setImportedNote(`保存失败：${String(saveError)}`)
    }
  }

  useEffect(() => {
    function onSave() {
      saveDraft()
    }
    window.addEventListener('easy-media.workspace.save', onSave)
    return () => window.removeEventListener('easy-media.workspace.save', onSave)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, projectKey])

  const composer = (compact: boolean) => (
    <div className="flex min-h-0 flex-col gap-2">
      {compact ? null : (
        <>
          <div className="text-center text-[16px] font-medium">今天要做点什么？</div>
          <div className="text-center text-[11px] text-muted-foreground">
            说出想法，AI 负责分镜、台词、节奏与微表情；生成后可应用到任务轨，再逐镜精修。
          </div>
        </>
      )}
      <div className="flex min-h-0 flex-col gap-1 overflow-auto px-0.5">
        {planning && chatMessages.length === 0 ? (
          <div className="rounded px-2 py-1 text-[11px]" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
            正在生成分镜…
          </div>
        ) : null}
        {chatMessages.map((message) => (
          <div
            key={message.id}
            className="rounded px-2 py-1.5 text-[11px] leading-relaxed"
            style={{
              background: message.role === 'user' ? `${PRIMARY} / 0.14` : FIELD_BG,
              border: `1px solid ${BORDER}`,
            }}
          >
            <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>{message.role === 'user' ? '我' : message.role === 'system' ? '系统' : '导演助手'}</span>
              {message.status === 'running' ? (
                <span className="rounded px-1" style={{ border: `1px solid ${PRIMARY}`, color: PRIMARY }}>
                  运行中 {((message.elapsedMs ?? 0) / 1000).toFixed(0)}s
                </span>
              ) : message.status === 'failed' ? (
                <span className="rounded px-1" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>失败</span>
              ) : message.elapsedMs ? (
                <span>{(message.elapsedMs / 1000).toFixed(1)}s</span>
              ) : null}
            </div>
            {message.steps?.length ? (
              <div className="mb-1 flex flex-col gap-0.5">
                {message.steps.map((step) => (
                  <div key={step.label} className="flex items-start gap-1 text-[10px] text-muted-foreground">
                    <span style={{ color: step.status === 'done' ? PRIMARY : step.status === 'failed' ? '#fbbf24' : undefined }}>
                      {step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : '●'}
                    </span>
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {message.text ? <div className="whitespace-pre-wrap">{message.text}</div> : null}
            {message.role === 'assistant' && message.status === 'running' ? (
              <div className="mt-1 flex gap-2 text-[10px]">
                <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={stopMessage}>
                  停止
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <textarea
        style={{ ...fieldStyle, minHeight: compact ? 64 : 96, resize: 'vertical', fontSize: 13, lineHeight: 1.6 }}
        placeholder={plan ? '继续提修改要求：第 2 段拆两段 / 台词改方言 / 整体更压抑' : '例：写一个天空鲸落掉深海回家的故事。'}
        value={chatInput}
        onChange={(event) => setChatInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void sendMessage()
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        总时长
        <input
          style={{ ...fieldStyle, width: 52, padding: '2px 4px' }}
          value={String(durationSeconds)}
          onChange={(event) => setDurationSeconds(Math.max(3, Number(event.target.value) || 30))}
        />
        秒
        <select style={{ ...fieldStyle, width: 66, padding: '2px 4px' }} value={ratio} onChange={(event) => setRatio(event.target.value)}>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
        </select>
        <input
          style={{ ...fieldStyle, width: 110, padding: '2px 4px' }}
          placeholder="风格（可选）"
          value={style}
          onChange={(event) => setStyle(event.target.value)}
        />
        <span className="ml-auto" />
        <Button size="sm" disabled={!onPlan || (!chatInput.trim() && !planning)} onClick={() => (planning ? stopMessage() : void sendMessage())}>
          {planning ? '停止生成' : plan ? '发送修改' : '生成分镜'}
        </Button>
      </div>
      {error ? <div className="text-[11px]" style={{ color: '#fbbf24' }}>{error}</div> : null}
    </div>
  )

  if (cards.length === 0 && !plan && !planning) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="flex w-[600px] max-w-full flex-col gap-3 rounded-xl p-5" style={{ background: PANEL_BG, border: `1px solid ${BORDER}` }}>
          {composer(false)}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]" style={{ borderColor: BORDER }}>
        {importedNote ? <span className="text-[10px] text-muted-foreground">{importedNote}</span> : null}
        {appliedNote ? <span className="text-[10px]" style={{ color: PRIMARY }}>{appliedNote}</span> : null}
        {error ? <span className="text-[10px]" style={{ color: '#fbbf24' }}>{error}</span> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{cards.length} 段 · {frameRate}fps</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[220px] shrink-0 flex-col gap-1 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
          <div className="px-1 pb-1 text-[11px] text-muted-foreground">镜头卡</div>
          {cards.length === 0 ? (
            planning ? (
              <div className="flex flex-col gap-1">
                {[1, 2, 3, 4, 5].map((index) => (
                  <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: FIELD_BG, border: `1px solid ${BORDER}`, opacity: 0.55 }}>
                    <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: PRIMARY }} />
                    <span className="text-[11px] text-muted-foreground">第 {index} 段 生成中…</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-1 text-[10px] leading-relaxed text-muted-foreground">
                任务轨还没有片段。先在中间预览点「应用到任务轨」，生成后这里会出现镜头卡。
              </div>
            )
          ) : null}
          {cards.map((card) => {
            const active = card.id === selected?.id
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => selectCard(card.id)}
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
          {plan ? (
            <PlanPreview
              plan={plan}
              saved={planSaved}
              appliedNote={appliedNote}
              importedNote={importedNote}
              onBack={() => setPlan(null)}
              onSaveDraft={saveDraft}
              onImportSubjects={onImportPlanSubjects ? () => {
                onImportPlanSubjects(plan)
                setImportedNote('已导入主体到「主体定义」页')
              } : undefined}
              onImportResources={onImportPlanResources ? () => {
                onImportPlanResources(plan)
                setImportedNote('已把资源需求导入「资源与生成」页')
              } : undefined}
              onApply={() => {
                if (!onApplyPlan) return false
                const ok = onApplyPlan(plan.segments.map((segment) => ({
                  name: segment.name,
                  durationFrames: segment.duration_frames,
                  brief: formatPlanSegmentBrief(segment),
                })))
                setAppliedNote(ok ? '已应用到任务轨（可 Ctrl+Z 撤销）' : '应用失败：请先在编辑器里选中任务片段')
                return ok
              }}
            />
          ) : planning ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <div className="text-[13px] font-medium">正在生成分镜…</div>
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                理解需求 → 定叙事骨架 → 分段 → 写镜头表 → 推导主体与资源
                <br />约 1–3 分钟，结果会显示在这里。
              </div>
            </div>
          ) : selected ? (
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
        </div>

        <div className="flex w-[320px] shrink-0 flex-col gap-2 p-2" style={{ borderLeft: `1px solid ${BORDER}` }}>
          <div className="flex gap-1">
            {(['chat', 'timeline'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className="rounded px-2 py-0.5 text-[11px]"
                style={{
                  border: `1px solid ${rightTab === key ? PRIMARY : BORDER}`,
                  color: rightTab === key ? PRIMARY : undefined,
                }}
                onClick={() => setRightTab(key)}
              >
                {key === 'chat' ? 'AI 对话' : '时间轴预览'}
              </button>
            ))}
          </div>
          {rightTab === 'chat' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              {composer(true)}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
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
                      onClick={() => selectCard(card.id)}
                    >
                      <span
                        className="absolute inset-y-0 rounded"
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          background: active ? PRIMARY : `${PRIMARY} / 0.45`,
                        }}
                      />
                    </button>
                  )
                })}
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
                <span>0</span>
                <span>{(totalFrames / frameRate).toFixed(1)}s</span>
              </div>
            </div>
          )}
        </div>
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
