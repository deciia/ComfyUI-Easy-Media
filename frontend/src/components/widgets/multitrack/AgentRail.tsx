import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatPlanSegmentBrief } from './PlanPreview'
import { readDirectorSettings } from './directorSettings'
import { DEFAULT_PROMPT_RULES } from './directorSettings'

/** 把 ```userprompt 段N``` 代码块写入分镜脚本段的 promptA */
function fillPromptA(projectKey: string, segIndex: number, text: string): boolean {
  const cache = readWorkspace(projectKey)
  const plan = cache.plan as { segments?: Array<Record<string, unknown>> } | null
  if (!plan?.segments || segIndex < 0 || segIndex >= plan.segments.length) return false
  const segments = plan.segments.map((segment, index) => (
    index === segIndex ? { ...segment, promptA: text } : segment
  ))
  writeWorkspace(projectKey, { plan: { ...(plan as Record<string, unknown>), segments } as never })
  return true
}
import {
  ensureHydrated,
  patchWorkspaceMessages,
  readResources,
  readWorkspace,
  subscribeWorkspace,
  upsertResource,
  patchResource,
  writeBindings,
  writeWorkspace,
  type AgentMessage,
  type ProjectResource,
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
  assets: '可以让我按分镜列资源需求、匹配 input/output 素材、补缺件；绑定到分镜段在「提示词增强」里做。',
  enhance: '可以让我把某一段分镜写成模型提示词。',
}

export interface AgentRailProps {
  projectKey: string
  tab: string
  segments: Array<{ index: number; name: string; durationSeconds: number; images?: string[]; hasPrompt?: boolean }>
  subjects: Array<{ name: string; desc?: string }>
  audioTracks?: string[]
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
  onApplyPlan,
  audioTracks = [],
}: AgentRailProps) {
  const [messages, setMessages] = useState<AgentMessage[]>(() => readWorkspace(projectKey).messages ?? [])
  const [busy, setBusy] = useState(() => Boolean(readWorkspace(projectKey).agentBusy))
  const [input, setInput] = useState(() => readWorkspace(projectKey).chatInput ?? '')
    const [fillArmed, setFillArmed] = useState<string | null>(null)
  const [inputHeight, setInputHeight] = useState(72)
  const [expanded, setExpanded] = useState(false)
  const prevHeightRef = useRef(72)
  const inputAreaRef = useRef<HTMLDivElement | null>(null)
  const heightDragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  useEffect(() => {
    function onMove(event: MouseEvent) {
      const drag = heightDragRef.current
      if (!drag) return
      setInputHeight(Math.max(64, Math.min(640, drag.startHeight + (drag.startY - event.clientY))))
    }
    function onUp() {
      heightDragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])
  const [model, setModel] = useState('')
  const [railTab, setRailTab] = useState<'chat' | 'trace' | 'context'>('chat')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    ensureHydrated(projectKey)
    return subscribeWorkspace(projectKey, () => {
      setMessages(readWorkspace(projectKey).messages ?? [])
      setBusy(Boolean(readWorkspace(projectKey).agentBusy))
    })
  }, [projectKey])

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

  /** ---------- D-P1：工具定义（前端执行，只改项目数据） ---------- */
  const AGENT_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_segments',
        description: '列出分镜脚本所有段（序号/名称/时长/任务类型/是否已写提示词/绑定数量）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_segment',
        description: '读取某段完整内容（promptA/promptB/finalA/finalB/设置/镜头/台词）',
        parameters: {
          type: 'object',
          properties: { index: { type: 'number', description: '段序号，从 1 开始' } },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'patch_segment',
        description: '修改某段的用户提示词/最终提示词/生成设置（只写项目数据，不动任务轨）',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '段序号，从 1 开始' },
            promptA: { type: 'string', description: 'A 版片段提示词（用户稿）' },
            promptB: { type: 'string', description: 'B 版片段提示词' },
            finalA: { type: 'string', description: 'A 版最终提示词' },
            finalB: { type: 'string', description: 'B 版最终提示词' },
            taskType: { type: 'string', description: 'r2v / fmlf2v / vi2v / l2v / passthrough' },
            continuityMode: { type: 'string', description: 'shot / context / context_drift' },
            refImageSize: { type: 'string', description: 'match / max' },
          },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_resources',
        description: '列出项目主体与资源（名称/类型/描述/保留项/是否有文件）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'upsert_subject',
        description: '新增或更新一个主体（按名称匹配，存在则更新描述与保留项）',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            retention: { type: 'array', items: { type: 'string' }, description: '必须保持不变的特征' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bind_resources',
        description: '把资源绑定到某段某变体（按资源名称，子资源自动跟随主体）',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number' },
            variant: { type: 'string', enum: ['a', 'b'] },
            resource_names: { type: 'array', items: { type: 'string' } },
          },
          required: ['index', 'resource_names'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_prompt',
        description: '为该段调用提示词生成接口，产出标准提示词并写入 finalA/finalB',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number' },
            variant: { type: 'string', enum: ['a', 'b'] },
            language: { type: 'string', enum: ['中文', 'English'] },
          },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_storyboard',
        description: '把当前分镜脚本应用到任务轨（需要用户在编辑器可用时执行）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: '向用户提问并给出选项（当需要用户拍板时使用）',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['question', 'options'],
        },
      },
    },
  ] as const

  const readPlan = () => (readWorkspace(projectKey).plan ?? null) as (StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) | null

  const writePlanSegment = (index1: number, patch: Record<string, unknown>) => {
    const planNow = readPlan()
    if (!planNow?.segments) return { error: '当前没有分镜脚本' }
    const index0 = index1 - 1
    if (index0 < 0 || index0 >= planNow.segments.length) return { error: `段 ${index1} 不存在（共 ${planNow.segments.length} 段）` }
    const segments = planNow.segments.map((segment, i) => (i === index0 ? { ...segment, ...patch } : segment))
    writeWorkspace(projectKey, { plan: { ...(planNow as Record<string, unknown>), segments } as never })
    return { ok: true, index: index1 }
  }

  const taskTemplate = (raw: string) => {
    const value = String(raw || '').toLowerCase()
    if (value.includes('r2v') || value.includes('ref')) return { task_type: 'r2v', task_mode: 'ref' }
    if (value.includes('fmlf2v') || value.includes('fl2v')) return { task_type: 'i2v', task_mode: 'default' }
    if (value.includes('vi2v') || value.includes('edit')) return { task_type: 'r2v', task_mode: 'ref' }
    if (value.includes('l2v')) return { task_type: 'l2v', task_mode: 'l2v' }
    return { task_type: 't2v', task_mode: 'default' }
  }

  async function executeAgentTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const planNow = readPlan()
    const segments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
    if (name === 'list_segments') {
      return {
        count: segments.length,
        segments: segments.map((segment, i) => {
          const settings = (segment.settings ?? {}) as Record<string, unknown>
          return {
            index: i + 1,
            name: String(segment.name ?? ''),
            duration_seconds: Number(segment.duration_seconds ?? settings.duration ?? 0),
            task_type: String(settings.taskType ?? ''),
            continuity: String(settings.contextMode ?? ''),
            has_promptA: Boolean(String(segment.promptA ?? '').trim()),
            has_finalA: Boolean(String(segment.finalA ?? '').trim()),
          }
        }),
      }
    }
    if (name === 'get_segment') {
      const index0 = Number(args.index ?? 0) - 1
      const segment = segments[index0]
      if (!segment) return { error: `段 ${Number(args.index)} 不存在` }
      return { index: index0 + 1, segment }
    }
    if (name === 'patch_segment') {
      const patch: Record<string, unknown> = {}
      for (const key of ['promptA', 'promptB', 'finalA', 'finalB'] as const) {
        if (typeof args[key] === 'string') patch[key] = args[key]
      }
      const settingsPatch: Record<string, unknown> = {}
      if (typeof args.taskType === 'string') settingsPatch.taskType = args.taskType
      if (typeof args.continuityMode === 'string') settingsPatch.contextMode = args.continuityMode
      if (typeof args.refImageSize === 'string') settingsPatch.refImageSize = args.refImageSize
      if (Object.keys(settingsPatch).length) {
        const index0 = Number(args.index ?? 0) - 1
        patch.settings = { ...((segments[index0]?.settings ?? {}) as Record<string, unknown>), ...settingsPatch }
      }
      return writePlanSegment(Number(args.index ?? 0), patch)
    }
    if (name === 'list_resources') {
      const pool = readResources(projectKey) as ProjectResource[]
      return {
        subjects: pool.filter((item) => item.type === 'Subject').map((item) => ({
          name: item.name,
          description: item.description ?? '',
          retention: item.retention ?? [],
          children: (item.childResourceIds ?? []).length,
        })),
        resources: pool.filter((item) => item.type !== 'Subject').map((item) => ({
          name: item.name,
          type: item.type,
          status: item.status,
          has_file: Boolean(item.imageFile || item.audioFile || item.videoFile),
        })),
      }
    }
    if (name === 'upsert_subject') {
      const subjectName = String(args.name ?? '').trim()
      if (!subjectName) return { error: 'name 不能为空' }
      const pool = readResources(projectKey) as ProjectResource[]
      const existing = pool.find((item) => item.type === 'Subject' && item.name === subjectName)
      const retention = Array.isArray(args.retention) ? args.retention.map(String) : undefined
      if (existing) {
        patchResource(projectKey, existing.id, {
          description: typeof args.description === 'string' ? args.description : existing.description,
          ...(retention ? { retention } : {}),
        })
        return { ok: true, updated: subjectName }
      }
      upsertResource(projectKey, {
        id: `subject-${Date.now().toString(36)}`,
        type: 'Subject',
        name: subjectName,
        relationship: 'reuse',
        description: typeof args.description === 'string' ? args.description : '',
        retention: retention ?? [],
        status: 'need',
        childResourceIds: [],
        source: 'manual',
      } as unknown as ProjectResource)
      return { ok: true, created: subjectName }
    }
    if (name === 'bind_resources') {
      const index1 = Number(args.index ?? 0)
      const variant = String(args.variant ?? 'a') === 'b' ? 'b' : 'a'
      const names = Array.isArray(args.resource_names) ? args.resource_names.map(String) : []
      if (!segments[index1 - 1]) return { error: `段 ${index1} 不存在` }
      const pool = readResources(projectKey) as ProjectResource[]
      const ids = names
        .map((resourceName) => pool.find((item) => item.name === resourceName))
        .filter((item): item is ProjectResource => Boolean(item))
        .map((item) => item.id)
      if (!ids.length) return { error: '没有匹配到资源，请先用 list_resources 确认名称' }
      const key = `script-${index1 - 1}:${variant}`
      writeBindings(projectKey, key, ids)
      return { ok: true, bound: ids.length, names: names.filter((resourceName) => pool.some((item) => item.name === resourceName)) }
    }
    if (name === 'generate_prompt') {
      const index1 = Number(args.index ?? 0)
      const segment = segments[index1 - 1]
      if (!segment) return { error: `段 ${index1} 不存在` }
      const variant = String(args.variant ?? 'a') === 'b' ? 'b' : 'a'
      const sourcePrompt = String((variant === 'b' ? segment.promptB : segment.promptA) ?? segment.promptA ?? segment.user_prompt ?? '').trim()
      if (!sourcePrompt) return { error: `段 ${index1} 的 ${variant.toUpperCase()} 稿为空，请先写片段提示词` }
      const settings = (segment.settings ?? {}) as Record<string, unknown>
      const mapped = taskTemplate(String(settings.taskType ?? ''))
      const duration = Number(segment.duration_seconds ?? 0) || 6
      const response = await fetch('/easy-media/prompt-studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: sourcePrompt,
          options: { ...mapped, duration_seconds: duration, output_language: String(args.language ?? '中文') },
          task_type: mapped.task_type,
          task_mode: mapped.task_mode,
          duration_seconds: duration,
          language: String(args.language ?? '中文'),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return { error: String(data?.error || `生成失败（HTTP ${response.status}）`) }
      const prompt = String(data?.prompt || '')
      if (!prompt) return { error: '生成结果为空' }
      writePlanSegment(index1, variant === 'b' ? { finalB: prompt } : { finalA: prompt })
      return { ok: true, index: index1, variant, chars: prompt.length, failures: data?.failures ?? [] }
    }
    if (name === 'apply_storyboard') {
      const planCurrent = readWorkspace(projectKey).plan
      if (!planCurrent || !onApplyPlan) return { error: '当前没有可应用的分镜脚本' }
      const ok = onApplyPlan(planCurrent)
      return ok ? { ok: true, applied: true } : { error: '应用失败：编辑器可能不可用' }
    }
    if (name === 'ask_user') {
      const answer = await askUser(String(args.question ?? ''), Array.isArray(args.options) ? args.options.map(String) : ['好的', '算了'])
      return { answer }
    }
    return { error: `未知工具：${name}` }
  }

  const askResolveRef = useRef<((answer: string) => void) | null>(null)
  function askUser(question: string, options: string[]): Promise<string> {
    return new Promise((resolve) => {
      askResolveRef.current = resolve
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === activeReplyRef.current
          ? { ...message, question: { id: `q-${Date.now()}`, text: question, options } }
          : message
      )))
    })
  }
  function answerQuestion(answer: string) {
    const resolve = askResolveRef.current
    askResolveRef.current = null
    patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
      message.id === activeReplyRef.current && message.question
        ? { ...message, question: { ...message.question, answer } }
        : message
    )))
    resolve?.(answer)
  }
  const activeReplyRef = useRef<string>('')

  /** D-P1：前端驱动的工具循环（最多 8 步） */
  async function sendStepLoop() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const stamp = Date.now()
    const replyId = `a-${stamp}`
    const controller = new AbortController()
    abortRef.current = controller
    activeReplyRef.current = replyId
    writeWorkspace(projectKey, { agentBusy: true })
    setBusy(true)
    const startedAt = Date.now()
    patchWorkspaceMessages(projectKey, (current) => [
      ...current,
      { id: `u-${stamp}`, role: 'user', text },
      { id: replyId, role: 'assistant', text: '', status: 'running', steps: [], toolCalls: [] },
    ])
    setRailTab('chat')
    const update = (patch: Partial<AgentMessage>) => {
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === replyId ? { ...message, ...patch } : message
      )))
    }
    const appendText = (delta: string) => {
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === replyId ? { ...message, text: `${message.text}${delta}` } : message
      )))
    }
    const upsertToolCall = (call: { id: string; name: string; args?: unknown; result?: string; status?: 'running' | 'success' | 'error' }) => {
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => {
        if (message.id !== replyId) return message
        const list = message.toolCalls ?? []
        const exists = list.some((item) => item.id === call.id)
        return {
          ...message,
          toolCalls: exists ? list.map((item) => (item.id === call.id ? { ...item, ...call } : item)) : [...list, call],
        }
      }))
    }

    const buildContext = () => {
      const agent = readDirectorSettings(projectKey).agent
      const context: Record<string, unknown> = { project: projectKey, tab }
      if (agent.includeNodeSettings) {
        context.frame_rate = frameRate
        context.ratio = ratio
      }
      if (agent.includePlan) context.plan = plan
      if (agent.includeTrackData) {
        context.segments = segments.map((segment) => ({
          index: segment.index,
          name: segment.name,
          duration_seconds: segment.durationSeconds,
          images: segment.images ?? [],
          has_prompt: Boolean(segment.hasPrompt),
        }))
        context.audio_tracks = audioTracks
      }
      if (agent.includeManualSubjects) {
        context.subjects = subjects.map((subject) => ({ name: subject.name, description: subject.desc ?? '' }))
      }
      if (agent.includeManualResources) {
        context.planned_resources = resources.map((resource) => resource.name)
      }
      if (agent.includeBindings) {
        const bindings = readWorkspace(projectKey).bindings ?? {}
        context.bindings = Object.entries(bindings).map(([key, ids]) => ({
          segment_variant: key,
          resources: ids
            .map((id) => (readWorkspace(projectKey).resources ?? []).find((item) => item.id === id)?.name)
            .filter(Boolean),
        }))
      }
      return context
    }

    const history = (readWorkspace(projectKey).messages ?? [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, text: message.text }))
    const chatMessages: Array<Record<string, unknown>> = [...history]
    let stepCount = 0
    try {
      for (let step = 0; step < 8; step += 1) {
        if (controller.signal.aborted) break
        stepCount = step + 1
        const response = await fetch('/easy-media/agent/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            messages: chatMessages,
            context: buildContext(),
            tools: AGENT_TOOLS,
            system_extra: readDirectorSettings(projectKey).agent.promptRules || DEFAULT_PROMPT_RULES,
          }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data?.ok) throw new Error(String(data?.error || `请求失败（HTTP ${response.status}）`))
        const replyText = String(data.text || '')
        if (replyText) appendText(replyText)
        const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
        if (!calls.length) break
        chatMessages.push({
          role: 'assistant',
          text: replyText,
          tool_calls: calls.map((call: { id: string; name: string; arguments: string }) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        })
        for (const call of calls as Array<{ id: string; name: string; arguments: string }>) {
          upsertToolCall({ id: call.id, name: call.name, args: call.arguments, status: 'running' })
          let parsedArgs: Record<string, unknown> = {}
          try {
            parsedArgs = JSON.parse(call.arguments || '{}')
          } catch {
            parsedArgs = {}
          }
          try {
            const result = await executeAgentTool(call.name, parsedArgs)
            upsertToolCall({
              id: call.id,
              name: call.name,
              args: parsedArgs,
              status: result.error ? 'error' : 'success',
              result: JSON.stringify(result).slice(0, 2000),
            })
            chatMessages.push({ role: 'tool', tool_call_id: call.id, text: JSON.stringify(result).slice(0, 4000) })
          } catch (toolError) {
            const message = toolError instanceof Error ? toolError.message : String(toolError)
            upsertToolCall({ id: call.id, name: call.name, args: parsedArgs, status: 'error', result: message })
            chatMessages.push({ role: 'tool', tool_call_id: call.id, text: JSON.stringify({ error: message }) })
          }
        }
      }
      update({
        status: controller.signal.aborted ? 'done' : 'done',
        elapsedMs: Date.now() - startedAt,
        steps: [{ label: `工具循环 ${stepCount} 步`, status: controller.signal.aborted ? 'failed' : 'done' }],
        ...(controller.signal.aborted ? { text: '已停止。' } : {}),
      })
    } catch (failure) {
      const aborted = controller.signal.aborted
      update({
        status: aborted ? 'done' : 'failed',
        elapsedMs: Date.now() - startedAt,
        text: aborted ? '已停止。' : `请求失败：${String(failure)}`,
      })
    } finally {
      abortRef.current = null
      writeWorkspace(projectKey, { agentBusy: false })
      setBusy(false)
    }
  }

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
          system_extra: readDirectorSettings(projectKey).agent.promptRules || DEFAULT_PROMPT_RULES,
          messages: [
            ...(readWorkspace(projectKey).messages ?? []).map((message) => ({ role: message.role, text: message.text })),
            { role: 'user', text },
          ],
          context: (() => {
            const agent = readDirectorSettings(projectKey).agent
            const context: Record<string, unknown> = { project: projectKey, tab }
            if (agent.includeNodeSettings) {
              context.frame_rate = frameRate
              context.ratio = ratio
            }
            if (agent.includePlan) context.plan = plan
            if (agent.includeTrackData) {
              context.segments = segments.map((segment) => ({
                index: segment.index,
                name: segment.name,
                duration_seconds: segment.durationSeconds,
                images: segment.images ?? [],
                has_prompt: Boolean(segment.hasPrompt),
              }))
              context.audio_tracks = audioTracks
            }
            if (agent.includeManualSubjects) {
              context.subjects = subjects.map((subject) => ({ name: subject.name, description: subject.desc ?? '' }))
            }
            if (agent.includeManualResources) {
              context.planned_resources = resources.map((resource) => resource.name)
            }
            if (agent.includeBindings) {
              const bindings = readWorkspace(projectKey).bindings ?? {}
              context.bindings = Object.entries(bindings).map(([key, ids]) => ({
                segment_variant: key,
                resources: ids
                  .map((id) => (readWorkspace(projectKey).resources ?? []).find((item) => item.id === id)?.name)
                  .filter(Boolean),
              }))
            }
            return context
          })(),
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
          } else if (type === 'think') {
            patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
              message.id === replyId
                ? { ...message, thinking: `${message.thinking ?? ''}${String(event.text || '')}` }
                : message
            )))
          } else if (type === 'gen') {
            patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
              message.id === replyId
                ? { ...message, gen: `${message.gen ?? ''}${String(event.text || '')}` }
                : message
            )))
          } else if (type === 'text') {
            update({ text: `${textOf()}${String(event.text || '')}` })
          } else if (type === 'plan') {
            const next = event.plan as StoryboardPlanLike
            writeWorkspace(projectKey, { plan: next })
            update({
              text: '',
              thinking: undefined,
              gen: undefined,
              planResult: { segments: next.segments.length, seconds: next.total_seconds },
            })
          } else if (type === 'action') {
            const action = String(event.action || '')
            if (action === 'apply_storyboard') {
              const planNow = readWorkspace(projectKey).plan
              if (planNow && onApplyPlan) {
                const ok = onApplyPlan(planNow)
                update({ text: `${textOf()}\n${ok ? '已应用到任务轨（可 Ctrl+Z 撤销）。' : '应用失败：请确认编辑器处于可用状态。'}` })
              } else {
                update({ text: `${textOf()}\n[错误] 当前没有可应用的分镜脚本。` })
              }
            } else {
              update({ text: `${textOf()}\n已执行：${String(event.label || event.action || '')}` })
            }
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
                {message.thinking ? (
                  <details className="mb-1 rounded px-1.5 py-1 text-[10px]" style={{ background: FIELD_BG, opacity: 0.8 }}>
                    <summary className="cursor-pointer text-muted-foreground">
                      💭 思考过程（{message.thinking.length} 字）
                    </summary>
                    <div className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap leading-relaxed">{message.thinking}</div>
                  </details>
                ) : null}
                {message.gen ? (
                  <details className="mb-1 rounded px-1.5 py-1 text-[10px]" style={{ background: FIELD_BG, opacity: 0.8 }}>
                    <summary className="cursor-pointer text-muted-foreground">
                      📝 生成过程（{message.gen.length} 字）
                    </summary>
                    <div className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap leading-relaxed">{message.gen}</div>
                  </details>
                ) : null}
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
                {message.toolCalls?.length ? (
                  <div className="mt-1 flex flex-col gap-1">
                    {message.toolCalls.map((call) => (
                      <details
                        key={call.id}
                        className="rounded px-1.5 py-1 text-[10px]"
                        style={{ border: `1px solid ${BORDER}`, background: FIELD_BG }}
                      >
                        <summary className="cursor-pointer select-none">
                          <span style={{ color: call.status === 'error' ? '#fbbf24' : PRIMARY }}>
                            {call.status === 'error' ? '✕' : call.status === 'running' ? '●' : '✓'}
                          </span>
                          {' '}
                          {call.name}
              </summary>
                        <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {call.args ? JSON.stringify(call.args).slice(0, 600) : ''}
                        </div>
                        {call.result ? (
                          <div className="mt-1 whitespace-pre-wrap">{String(call.result).slice(0, 1200)}</div>
                        ) : null}
                      </details>
                    ))}
                  </div>
                ) : null}
                {message.question ? (
                  <div className="mt-1 rounded p-1.5 text-[11px]" style={{ border: `1px solid ${BORDER}`, background: PANEL_BG }}>
                    <div>{message.question.text}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {message.question.options.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{
                            border: `1px solid ${message.question?.answer === option ? PRIMARY : BORDER}`,
                            color: message.question?.answer === option ? PRIMARY : undefined,
                          }}
                          disabled={Boolean(message.question?.answer)}
                          onClick={() => answerQuestion(option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {(message.role === 'assistant' && message.text ? Array.from(message.text.matchAll(/```userprompt\s*段(\d+)[^\n]*\n([\s\S]*?)```/g)) : []).map((match, blockIndex) => {
                  const segIndex = Number(match[1]) - 1
                  const body = match[2].trim()
                  const key = `${message.id}-${blockIndex}`
                  const planNow = readWorkspace(projectKey).plan as { segments?: Array<Record<string, unknown>> } | null
                  const target = planNow?.segments?.[segIndex]
                  const hasExisting = Boolean(String(target?.promptA ?? '').trim())
                  return (
                    <div key={key} className="mt-1 flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{ border: `1px solid ${BORDER}` }}
                        onClick={() => {
                          if (hasExisting && fillArmed !== key) {
                            setFillArmed(key)
                            return
                          }
                          if (fillPromptA(projectKey, segIndex, body)) setFillArmed(null)
                        }}
                      >
                        {hasExisting && fillArmed !== key
                          ? `段${match[1]} 已有 A 稿，再点一次覆盖`
                          : `⤓ 填入 片段提示词 A（段${match[1]}）`}
                      </button>
                    </div>
                  )
                })}
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

      <div
        ref={inputAreaRef}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
      >
        <div
          title="上下拖动调整输入框高度"
          style={{ height: 6, cursor: 'ns-resize', borderRadius: 3, background: 'hsl(var(--border, 240 6% 25%))', opacity: 0.6 }}
          onMouseDown={(event) => {
            heightDragRef.current = { startY: event.clientY, startHeight: inputHeight }
          }}
        />
        <textarea
          style={{
            ...fieldStyle,
            minHeight: 64,
            height: expanded ? Math.max(360, inputHeight) : inputHeight,
            maxHeight: 640,
            resize: 'none',
            overflowY: 'auto',
            lineHeight: 1.55,
          }}
          placeholder={plan ? '继续提要求，例如：第 2 段拆两段 / 应用' : '例：写一个天空鲸落掉深海回家的故事。'}
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            const el = event.currentTarget
            if (!expanded) {
              el.style.height = 'auto'
              setInputHeight(Math.max(64, Math.min(240, el.scrollHeight)))
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          title={expanded ? '还原高度' : '放大输入框'}
          style={{
            position: 'absolute',
            right: 6,
            bottom: 6,
            zIndex: 2,
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            border: '1px solid hsl(var(--border, 240 6% 25%))',
            background: 'hsl(var(--background, 240 10% 8%))',
            color: 'hsl(var(--muted-foreground, 240 5% 65%))',
            fontSize: 11,
            cursor: 'pointer',
          }}
          onClick={() => {
            if (!expanded) {
              prevHeightRef.current = inputHeight
              setInputHeight(480)
              setExpanded(true)
            } else {
              setInputHeight(prevHeightRef.current || 72)
              setExpanded(false)
            }
          }}
        >
          {expanded ? '⤡' : '⤢'}
        </button>
      </div>
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
            void sendStepLoop()
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
