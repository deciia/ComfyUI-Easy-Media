import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatPlanSegmentBrief } from './PlanPreview'
import {
  patchWorkspaceMessages,
  readWorkspace,
  subscribeWorkspace,
  writeWorkspace,
  type AgentMessage,
  type StoryboardPlanLike,
} from './agentStore'

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

const TAB_HINTS: Record<string, string> = {
  storyboard: '可以让我生成分镜、改分镜（拆段/合并/改台词/调节奏），或把分镜应用到任务轨。',
  subjects: '可以让我从分镜推导主体、补描述与保留项、检查跨段一致性。',
  assets: '可以让我按分镜列资源需求、匹配 input 素材、发起生成并挂到片段。',
  enhance: '可以让我把某一段分镜写成模型提示词。',
}

export interface AgentRailProps {
  projectKey: string
  tab: string
  segments: Array<{ index: number; name: string; durationSeconds: number }>
  subjects: Array<{ name: string }>
  resources: Array<{ name: string }>
  frameRate: number
  ratio: string
  onApplyPlan?: (plan: StoryboardPlanLike) => boolean
}

/** 常驻右侧 AI 助手：弹窗持有，切页签不卸载；内含 对话/轨迹/上下文 三个标签页。 */
export function AgentRail({
  projectKey,
  tab,
  segments,
  subjects,
  resources,
  frameRate,
  ratio,
}: AgentRailProps) {
  const [messages, setMessages] = useState<AgentMessage[]>(() => readWorkspace(projectKey).messages ?? [])
  const [busy, setBusy] = useState(() => Boolean(readWorkspace(projectKey).agentBusy))
  const [input, setInput] = useState(() => readWorkspace(projectKey).chatInput ?? '')
  const [model, setModel] = useState('')
  const [railTab, setRailTab] = useState<'chat' | 'trace' | 'context'>('chat')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => subscribeWorkspace(projectKey, () => {
    setMessages(readWorkspace(projectKey).messages ?? [])
    setBusy(Boolean(readWorkspace(projectKey).agentBusy))
  }), [projectKey])

  useEffect(() => {
    let cancelled = false
    fetch('/easy-media/agent/info')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.ok) setModel(String(data.model || ''))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    writeWorkspace(projectKey, { chatInput: input })
  }, [projectKey, input])

  const plan = readWorkspace(projectKey).plan ?? null
  const contextChips = useMemo(() => {
    const chips = [`项目 ${projectKey || '未命名'}`, `${segments.length} 段`, `${frameRate}fps`, ratio]
    if (subjects.length) chips.push(`${subjects.length} 主体`)
    if (resources.length) chips.push(`${resources.length} 资源`)
    return chips
  }, [projectKey, segments.length, frameRate, ratio, subjects.length, resources.length])

  const traceRows = useMemo(
    () => messages.flatMap((message, messageIndex) => (
      (message.steps ?? []).map((step) => ({ key: `${message.id}-${step.label}-${messageIndex}`, messageIndex, label: step.label, status: step.status }))
    )),
    [messages],
  )

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const stamp = Date.now()
    const replyId = `a-${stamp}`
    const controller = new AbortController()
    abortRef.current = controller
    writeWorkspace(projectKey, { agentBusy: true })
    setBusy(true)
    const startedAt = Date.now()
    patchWorkspaceMessages(projectKey, (current) => [
      ...current,
      { id: `u-${stamp}`, role: 'user', text },
      { id: replyId, role: 'assistant', text: '', status: 'running', steps: [] },
    ])
    setRailTab('chat')
    const timer = window.setInterval(() => {
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === replyId ? { ...message, elapsedMs: Date.now() - startedAt } : message
      )))
    }, 500)
    const update = (patch: Partial<AgentMessage>) => {
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === replyId ? { ...message, ...patch } : message
      )))
    }
    const textOf = () => (readWorkspace(projectKey).messages ?? []).find((message) => message.id === replyId)?.text ?? ''
    try {
      const response = await fetch('/easy-media/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...(readWorkspace(projectKey).messages ?? []).map((message) => ({ role: message.role, text: message.text })),
            { role: 'user', text },
          ],
          context: {
            project: projectKey,
            frame_rate: frameRate,
            ratio,
            tab,
            plan,
            segments: segments.map((segment) => ({
              index: segment.index,
              name: segment.name,
              duration_seconds: segment.durationSeconds,
            })),
            subjects: subjects.map((subject) => subject.name),
            planned_resources: resources.map((resource) => resource.name),
          },
        }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`智能体请求失败（HTTP ${response.status}）`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          index = buffer.indexOf('\n\n')
          const line = block.split('\n').find((item) => item.startsWith('data:'))
          if (!line) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          const type = String(event.type || '')
          if (type === 'step') {
            patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
              message.id === replyId
                ? {
                    ...message,
                    steps: [
                      ...(message.steps ?? []).map((step) => ({ ...step, status: 'done' as const })),
                      { label: String(event.label || ''), status: 'running' as const },
                    ],
                  }
                : message
            )))
          } else if (type === 'text') {
            update({ text: `${textOf()}${String(event.text || '')}` })
          } else if (type === 'plan') {
            const next = event.plan as StoryboardPlanLike
            writeWorkspace(projectKey, { plan: next })
            update({ planResult: { segments: next.segments.length, seconds: next.total_seconds } })
          } else if (type === 'action') {
            update({ text: `${textOf()}\n已执行：${String(event.label || event.action || '')}` })
          } else if (type === 'error') {
            update({ status: 'failed', text: `[错误] ${String(event.message || '')}` })
          }
        }
      }
      const latest = (readWorkspace(projectKey).messages ?? []).find((message) => message.id === replyId)
      update({
        status: latest?.status === 'failed' ? 'failed' : 'done',
        elapsedMs: Date.now() - startedAt,
        steps: (latest?.steps ?? []).map((step) => ({ ...step, status: 'done' as const })),
      })
    } catch (failure) {
      update({
        status: controller.signal.aborted ? 'done' : 'failed',
        elapsedMs: Date.now() - startedAt,
        text: controller.signal.aborted ? '已停止。' : `请求失败：${String(failure)}`,
      })
    } finally {
      window.clearInterval(timer)
      abortRef.current = null
      writeWorkspace(projectKey, { agentBusy: false })
      setBusy(false)
    }
  }


  return (
    <div className="flex w-[360px] shrink-0 flex-col gap-2 p-2" style={{ borderLeft: `1px solid ${BORDER}`, background: PANEL_BG }}>
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium">AI 助手</span>
        {model ? (
          <span className="rounded-full px-1.5 text-[10px] text-muted-foreground" style={{ border: `1px solid ${BORDER}` }}>
            {model}
          </span>
        ) : null}
        {busy ? (
          <span className="ml-auto rounded px-1 text-[10px]" style={{ border: `1px solid ${PRIMARY}`, color: PRIMARY }}>
            运行中
          </span>
        ) : null}
      </div>
      <div className="flex gap-1 text-[11px]">
        {(['chat', 'trace', 'context'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className="rounded px-2 py-0.5"
            style={{
              border: `1px solid ${railTab === key ? PRIMARY : BORDER}`,
              color: railTab === key ? PRIMARY : undefined,
            }}
            onClick={() => setRailTab(key)}
          >
            {key === 'chat' ? '对话' : key === 'trace' ? '轨迹' : '上下文'}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
        {contextChips.map((chip) => (
          <span key={chip} className="rounded-full px-1.5" style={{ border: `1px solid ${BORDER}` }}>{chip}</span>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        {railTab === 'chat' ? (
          <>
            <div className="text-[10px] leading-relaxed text-muted-foreground">{TAB_HINTS[tab] ?? TAB_HINTS.storyboard}</div>
            {messages.length === 0 ? (
              <div className="rounded px-2 py-1 text-[11px] leading-relaxed text-muted-foreground" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
                直接说想法，例如「写一个天空鲸落掉深海回家的故事」。生成后可以说「拆第 2 段」「台词改方言」「应用」。
              </div>
            ) : null}
            {messages.map((message) => (
              <div
                key={message.id}
                className="rounded px-2 py-1.5 text-[11px] leading-relaxed"
                style={{
                  background: message.role === 'user' ? `${PRIMARY} / 0.14` : FIELD_BG,
                  border: `1px solid ${BORDER}`,
                }}
              >
                <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span>{message.role === 'user' ? '我' : '导演助手'}</span>
                  {message.status === 'running' ? (
                    <span className="rounded px-1" style={{ border: `1px solid ${PRIMARY}`, color: PRIMARY }}>
                      {((message.elapsedMs ?? 0) / 1000).toFixed(0)}s
                    </span>
                  ) : message.status === 'failed' ? (
                    <span className="rounded px-1" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>失败</span>
                  ) : message.elapsedMs ? (
                    <span>{(message.elapsedMs / 1000).toFixed(1)}s</span>
                  ) : null}
                </div>
                {message.steps?.length ? (
                  <div className="mb-1 flex flex-col gap-0.5">
                    {message.steps.map((step, stepIndex) => (
                      <div key={`${step.label}-${stepIndex}`} className="flex items-start gap-1 text-[10px] text-muted-foreground">
                        <span style={{ color: step.status === 'done' ? PRIMARY : step.status === 'failed' ? '#fbbf24' : undefined }}>
                          {step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : '●'}
                        </span>
                        <span>{step.label}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {message.text ? <div className="whitespace-pre-wrap">{message.text}</div> : null}
                {message.planResult ? (
                  <div className="mt-1.5 flex items-center gap-2 rounded p-1.5" style={{ background: PANEL_BG, border: `1px solid ${BORDER}` }}>
                    <span className="text-[10px]">分镜 {message.planResult.segments} 段 · {message.planResult.seconds}s</span>

                  </div>
                ) : null}
              </div>
            ))}
          </>
        ) : railTab === 'trace' ? (
          <div className="flex flex-col gap-1">
            {traceRows.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">还没有执行轨迹。</div>
            ) : traceRows.map((row) => (
              <div key={row.key} className="flex items-start gap-1 rounded px-2 py-1 text-[10px]" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
                <span style={{ color: row.status === 'done' ? PRIMARY : row.status === 'failed' ? '#fbbf24' : undefined }}>
                  {row.status === 'done' ? '✓' : row.status === 'failed' ? '✕' : '●'}
                </span>
                <span className="text-muted-foreground">#{row.messageIndex + 1}</span>
                <span>{row.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-[11px]">
            <div className="rounded p-2" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
              <div className="text-muted-foreground">项目</div>
              <div>{projectKey || '未命名'}</div>
              <div className="mt-1 text-muted-foreground">当前分镜</div>
              <div>{plan ? `${plan.title || '未命名'} · ${plan.segments.length} 段 · ${plan.total_seconds}s` : '（无）'}</div>
            </div>
            <div className="rounded p-2" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
              <div className="text-muted-foreground">任务片段（{segments.length}）</div>
              {segments.length === 0
                ? <div className="text-muted-foreground">（空任务轨）</div>
                : segments.map((segment) => (
                  <div key={`${segment.index}-${segment.name}`} className="truncate">{segment.index}. {segment.name} · {segment.durationSeconds.toFixed(1)}s</div>
                ))}
            </div>
            <div className="rounded p-2" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
              <div className="text-muted-foreground">主体（{subjects.length}）</div>
              <div>{subjects.map((subject) => subject.name).join('、') || '（空）'}</div>
            </div>
            <div className="rounded p-2" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
              <div className="text-muted-foreground">资源需求（{resources.length}）</div>
              <div>{resources.map((resource) => resource.name).join('、') || '（空）'}</div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={!plan} onClick={() => writeWorkspace(projectKey, { plan: null })}>
                丢弃分镜
              </Button>
              <Button size="sm" variant="secondary" onClick={() => writeWorkspace(projectKey, { messages: [] })}>
                清空对话
              </Button>
            </div>
          </div>
        )}
      </div>

      <textarea
        style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }}
        placeholder={plan ? '继续提要求，例如：第 2 段拆两段 / 应用' : '例：写一个天空鲸落掉深海回家的故事。'}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy ? false : !input.trim()}
          onClick={() => {
            if (busy) {
              abortRef.current?.abort()
              writeWorkspace(projectKey, { agentBusy: false })
              setBusy(false)
              return
            }
            void send()
          }}
        >
          {busy ? '停止' : '发送'}
        </Button>

      </div>
    </div>
  )
}

export function planBriefOf(plan: StoryboardPlanLike) {
  return plan.segments.map((segment) => ({
    name: segment.name,
    durationFrames: segment.duration_frames,
    brief: formatPlanSegmentBrief(segment as never),
  }))
}
