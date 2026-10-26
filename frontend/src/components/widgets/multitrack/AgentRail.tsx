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
  readBindings,
  readResources,
  readWorkspace,
  subscribeWorkspace,
  upsertResource,
  patchResource,
  removeResource,
  writeBindings,
  writeWorkspace,
  type AgentMessage,
  type ProjectResource,
  type StoryboardPlanLike,
} from './agentStore'
import { AgentMarkdown } from './AgentMarkdown'
import { checkTaskModeAssets, maxImagesForTaskMode, TASK_MODE_SPECS } from '@/lib/task-mode-spec'
import { resolveBoundTokens } from './segmentTokens'

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
  /** 右栏宽度：数字=固定 px；'fill'=填满父容器（父级已有内边距时用） */
  width?: number | 'fill'
  /** 当前是否可见（父级页签切换时用于回到最新消息） */
  active?: boolean
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
  width,
  active = true,
}: AgentRailProps) {
  const [messages, setMessages] = useState<AgentMessage[]>(() => readWorkspace(projectKey).messages ?? [])
  const [busy, setBusy] = useState(() => Boolean(readWorkspace(projectKey).agentBusy))
  const [input, setInput] = useState(() => readWorkspace(projectKey).chatInput ?? '')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return []
    const pool = readResources(projectKey) as Array<{ name?: string; type?: string }>
    const query = mentionQuery.toLowerCase()
    return pool
      .filter((item) => item?.name && (!query || String(item.name).toLowerCase().includes(query)))
      .slice(0, 8)
      .map((item) => ({ name: String(item.name), type: String(item.type ?? '') }))
  }, [mentionQuery, projectKey])
    const [fillArmed, setFillArmed] = useState<string | null>(null)
  const [inputHeight, setInputHeight] = useState(72)
  const [expanded, setExpanded] = useState(false)
  const prevHeightRef = useRef(72)
  const inputAreaRef = useRef<HTMLDivElement | null>(null)
  const heightDragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  useEffect(() => {
    const registry = globalThis as unknown as { __easyMediaAgentAsk?: (text: string) => void }
    registry.__easyMediaAgentAsk = (text: string) => { void sendStepLoop(text, true) }
    return () => { delete registry.__easyMediaAgentAsk }
  })

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
  const [apiProfiles, setApiProfiles] = useState<Array<{ id: string; name: string; provider: string; model: string }>>([])
  const [activeProfileId, setActiveProfileId] = useState('')
  const [railTab, setRailTab] = useState<'chat' | 'trace' | 'context'>('chat')
  const abortRef = useRef<AbortController | null>(null)
  const progressRef = useRef<((text: string) => void) | null>(null)

  useEffect(() => {
    ensureHydrated(projectKey)
    return subscribeWorkspace(projectKey, () => {
      setMessages(readWorkspace(projectKey).messages ?? [])
      setBusy(Boolean(readWorkspace(projectKey).agentBusy))
    })
  }, [projectKey])

  useEffect(() => {
    let cancelled = false
    const loadInfo = () => {
      fetch('/easy-media/agent/info')
        .then((response) => response.json())
        .then((data) => {
          if (!cancelled && data?.ok) setModel(String(data.model || ''))
        })
        .catch(() => undefined)
      fetch('/easy-media/prompt-studio/config')
        .then((response) => response.json())
        .then((data) => {
          if (cancelled) return
          const cfg = (data && (data.config ?? data)) as Record<string, unknown>
          const list = Array.isArray(cfg.profiles) ? (cfg.profiles as Array<Record<string, unknown>>) : []
          setApiProfiles(list.map((item) => ({
            id: String(item.id ?? ''),
            name: String(item.name ?? item.provider ?? ''),
            provider: String(item.provider ?? ''),
            model: String(item.model ?? ''),
          })))
          setActiveProfileId(String(cfg.active_profile ?? ''))
        })
        .catch(() => undefined)
    }
    loadInfo()
    // 设置里切换 API 配置后刷新模型名
    globalThis.addEventListener?.('easy-media-api-changed', loadInfo)
    return () => {
      cancelled = true
      globalThis.removeEventListener?.('easy-media-api-changed', loadInfo)
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
        name: 'plan_storyboard',
        description: '按用户想法生成整片分镜脚本（段落/beat/时长/镜头表/台词/微表情/声音/简化版用户提示词）',
        parameters: {
          type: 'object',
          properties: {
            brief: { type: 'string', description: '用户的故事想法/文案，尽量保留原文' },
            duration_seconds: { type: 'number', description: '目标总时长（秒）' },
            ratio: { type: 'string', description: '画幅，如 9:16 / 16:9' },
            style: { type: 'string', description: '风格或参考描述' },
          },
          required: ['brief'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'revise_storyboard',
        description: '在现有分镜基础上按修改要求重写（拆段/合并/改台词/调节奏/换风格）',
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: '修改要求' },
          },
          required: ['instruction'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_segment',
        description: '在分镜脚本中新增一段（可指定插在哪个段之后）',
        parameters: {
          type: 'object',
          properties: {
            after_index: { type: 'number', description: '插在第几段之后；0 或不传=开头' },
            name: { type: 'string' },
            duration_seconds: { type: 'number' },
            beat: { type: 'string' },
            summary: { type: 'string' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_segment',
        description: '删除分镜脚本中的某一段',
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
        name: 'update_segment',
        description: '修改某段的元信息（名称/时长/beat/摘要/导演说明/镜头表），不动提示词',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number' },
            name: { type: 'string' },
            duration_seconds: { type: 'number' },
            beat: { type: 'string' },
            summary: { type: 'string' },
            director_note: { type: 'string' },
            shots: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '完整镜头表，替换原镜头' },
          },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'split_segment',
        description: '把某段对半拆成两段（时长各半，提示词清空待重写）',
        parameters: {
          type: 'object',
          properties: { index: { type: 'number' }, first_name: { type: 'string' }, second_name: { type: 'string' } },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'merge_segments',
        description: '把某段与它后面一段合并（时长相加，镜头表拼接）',
        parameters: {
          type: 'object',
          properties: { index: { type: 'number', description: '合并这一段的下一段' } },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_plan_settings',
        description: '设置脚本级生成参数（画幅/任务类型/衔接/参考图尺寸）',
        parameters: {
          type: 'object',
          properties: {
            ratio: { type: 'string' },
            taskType: { type: 'string', enum: ['r2v', 'fmlf2v', 'vi2v', 'l2v', 'passthrough'] },
            contextMode: { type: 'string', enum: ['shot', 'context', 'context_drift'] },
            refImageSize: { type: 'string', enum: ['match', 'max'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_skills',
        description: '列出可用技能包（H3 规范/题材预设等），写提示词前先查',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_skill',
        description: '读取某个技能包全文（按需加载，避免一次性塞进上下文）',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名（list_skills 返回的 name）' } },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_todos',
        description: '维护本次任务的执行清单（计划→执行→勾选），跨步可见，用于多阶段工作',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: '清单项：{text, status}，status = pending | doing | done',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'doing', 'done'] },
                },
                required: ['text'],
              },
            },
          },
          required: ['items'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把项目级事实写入长期记忆（如素材路径、风格偏好、人物设定），后续会话自动带上',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '短标识，如 老赵音色 / 画风偏好' },
            value: { type: 'string', description: '具体内容' },
          },
          required: ['key', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall',
        description: '读取项目长期记忆（不传 query 返回全部）',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memorize',
        description: '把跨会话仍有价值的事实写入项目长期记忆（用户偏好/项目决策/工程约束/踩坑）。同标题覆盖更新；importance>=4 的条目每轮对话都会自动注入',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['preference', 'project', 'decision', 'constraint', 'pitfall'], description: '记忆类型' },
            title: { type: 'string', description: '短标题，同标题视为同一条记忆（覆盖更新）' },
            content: { type: 'string', description: '一句话事实，含结论与原因' },
            importance: { type: 'number', description: '1-5，5 最高' },
          },
          required: ['type', 'title', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall_memories',
        description: '检索项目长期记忆（关键词匹配标题/内容，可按类型过滤）；不传 query 返回高权重全部',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，留空列出全部' },
            type: { type: 'string', description: '按类型过滤：preference/project/decision/constraint/pitfall' },
            limit: { type: 'number', description: '最多返回条数，默认 10' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'verify_project',
        description: '自检项目一致性：脚本段 vs 任务轨、A稿/终稿缺失、资源缺文件、主体无子资源、绑定缺失',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_projects',
        description: '列出已存在的项目（可切换/参考）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_project',
        description: '把当前任务轨保存到磁盘 timeline.json（等价 Ctrl+S 的项目保存）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'link_subject_assets',
        description: '给主体挂子资源（参考图/音色等），写入 childResourceIds',
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: '主体名称' },
            resources: { type: 'array', items: { type: 'string' }, description: '要挂的资源名称数组' },
            replace: { type: 'boolean', description: 'true=覆盖原引用，默认追加' },
          },
          required: ['subject', 'resources'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_resource_brief',
        description: '给资源写生成 brief（用于后续 generate_resource 的描述）',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '资源名称' },
            brief: { type: 'string', description: '生成描述' },
          },
          required: ['name', 'brief'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_task_track',
        description: '读取任务轨当前片段（帧范围/任务类型/是否有提示词），用于确认「应用到任务轨」是否生效',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
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
        name: 'plan_assets',
        description: '从分镜反推资产需求（只读，不建不删）：逐段列出稿内令牌 vs 已绑定、缺素材、缺绑定，并汇总需生成的资产、建议降级/合并的资产。生成任何资源前先用它出表给用户确认。',
        parameters: {
          type: 'object',
          properties: {
            segments: { type: 'array', items: { type: 'number' }, description: '只看这些段（1 起），留空看全部' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_prompt_context',
        description: '写提示词前先取上下文包：该段脚本要点、时长、任务类型/衔接、绑定资源与可用令牌编号（明确到 1..n）、已有 A/B 稿、写作检查清单。拿它之后再自由写作，不需要按固定模板填。',
        parameters: {
          type: 'object',
          properties: { index: { type: 'number', description: '段号，1 起' } },
          required: ['index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_prompt',
        description: '把一段的提示词写回脚本。只写 target 指定的那一种稿子：target=fragment 只写片段稿，target=final 只写最终提示词。默认不写任务轨、不改另一种稿子、不改其它段；这些都要显式传参或用户明确要求才做。',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '段号，1 起' },
            text: { type: 'string', description: '完整提示词正文' },
            variant: { type: 'string', enum: ['a', 'b'], description: '写 A 还是 B（默认 a）' },
            target: { type: 'string', enum: ['final', 'fragment'], description: 'final=最终提示词（默认）；fragment=片段提示词' },
            auto_align: { type: 'boolean', description: '默认 false：发现令牌编号与绑定不符时退回让你自己改；true 则由工具直接对齐编号（不改文字）' },
            to_task_track: { type: 'boolean', description: '同时写入任务轨（默认 false）' },
            force: { type: 'boolean', description: '忽略校验错误强写（默认 false）' },
          },
          required: ['index', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'retoken_prompts',
        description: '按当前绑定重排提示词令牌：读取 subject_definitions 里"令牌 → 名称"的对应，重建为当前绑定顺序的编号；已被升格为主体的图片改写成 <Subject n>，越界的幽灵编号整条移除。默认 dry_run 只给逐行 diff，confirm=true 才写回。',
        parameters: {
          type: 'object',
          properties: {
            indexes: { type: 'array', items: { type: 'number' }, description: '只处理这些段' },
            dry_run: { type: 'boolean', description: '默认 true（只看 diff）' },
            confirm: { type: 'boolean', description: '确认写回' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'validate_prompts',
        description: '校验各段提示词结构（只读）：令牌编号是否超出绑定数量、重复引用是否过多、是否含 None、是否缺"禁止文字/字幕/水印"、人物是否该用 Subject。返回逐段问题清单。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fix_prompts',
        description: '按规则自动修正提示词：把 None/N/A/undefined 换成「无」、缺失的"不得出现文字/字幕/水印"补一行。越界令牌只报告不擅自改（需重写）。',
        parameters: {
          type: 'object',
          properties: {
            indexes: { type: 'array', items: { type: 'number' }, description: '只处理这些段，留空处理全部' },
            dry_run: { type: 'boolean' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'promote_pictures_to_subject',
        description: '把若干图片资源升格为一个主体（Subject）：创建主体、把图片挂为其子图、并把各段绑定里的这些图片替换成该主体。用于"人物/招牌车被当成普通图片"的情况。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '主体名，如 老赵' },
            children: { type: 'array', items: { type: 'string' }, description: '作为子图的图片资源名（四视图等）' },
            description: { type: 'string', description: '主体描述（外观/服装/身份）' },
            retention: { type: 'array', items: { type: 'string' }, description: '保留项，如 面部特征/服装/发型' },
            drop_pictures: { type: 'boolean', description: '是否把这些图片从资源池顶层移除（默认 false，保留为子图）' },
            dry_run: { type: 'boolean', description: '只看影响面，不写入（默认 false）' },
          },
          required: ['name', 'children'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'audit_assets',
        description: '资产体检（只读，不改任何数据）：输出每个主体/资源被哪些段引用（引用矩阵）、零引用资产、只在 1 段出现的主体、稿内令牌缺口、疑似重复命名。用于防资产泛滥与判断该删/该降级/该合并。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'inspect_images',
        description: '读图（真正的多模态视觉）：把生成的图片交给视觉模型，返回画面描述与问题清单。核对出图是否合理时必须用它，不能靠文件名猜。一次最多 6 张。',
        parameters: {
          type: 'object',
          properties: {
            names: { type: 'array', items: { type: 'string' }, description: '项目资源名或图片文件名（自动查资源池定位路径）' },
            files: {
              type: 'array',
              description: '直接指定文件（优先级高于 names）',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  subfolder: { type: 'string' },
                  root: { type: 'string', enum: ['input', 'output', 'temp'] },
                },
                required: ['name'],
              },
            },
            question: { type: 'string', description: '想问的问题，例如"这张图有什么明显错误"' },
            prompt_hint: { type: 'string', description: '该段提示词，用于核对画面是否相符' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'undo_last_delete',
        description: '撤销最近一次删除（资源/主体、分镜段、任务轨段都支持）。可连续撤销最近 5 次，每次撤一步。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_task_segments',
        description: '删除任务轨上的段（按段号，1 起）。会联动删除关联任务；只影响任务轨，不改分镜脚本。需 confirm=true，建议先 dry_run=true。',
        parameters: {
          type: 'object',
          properties: {
            indexes: { type: 'array', items: { type: 'number' } },
            confirm: { type: 'boolean' },
            dry_run: { type: 'boolean' },
          },
          required: ['indexes'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_segments',
        description: '删除分镜脚本里的段（按段号）。只改脚本，不动任务轨；删后自动重排各段绑定键。必须 confirm=true，建议先 dry_run=true 预览。删空会拒绝。',
        parameters: {
          type: 'object',
          properties: {
            indexes: { type: 'array', items: { type: 'number' }, description: '要删除的段号（1 起），可多个' },
            confirm: { type: 'boolean' },
            dry_run: { type: 'boolean' },
          },
          required: ['indexes'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_resources',
        description: '删除主体或资源（按名称）。会同时：从主体子图关联里移除、从所有段的 A/B 绑定清单里解绑。必须传 confirm=true 才执行；删除前先用 list_resources 确认名称与引用情况。',
        parameters: {
          type: 'object',
          properties: {
            names: { type: 'array', items: { type: 'string' }, description: '要删除的主体/资源名称' },
            confirm: { type: 'boolean', description: '确认删除（必须为 true）' },
            dry_run: { type: 'boolean', description: '只报告会被删除/解绑的内容，不真正删除' },
          },
          required: ['names'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'explain_task_modes',
        description: '列出各任务类型允许的素材种类与数量上限（节点真实规则），用于决策前查表。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_task_modes',
        description: '按素材与稿内令牌判断并设置各段任务类型与衔接模式（助手自己决策，不要盲填）。task_mode: default=T2V(无参考素材) / ref=R2V(参考图或参考视频/音频做主体或风格依据) / l2v=L2V(给尾帧) / edit=VI2V(改现有视频) / passthrough=Pass(直通不生成)。可只传部分段。',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: '要设置的段',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: '段号，1 起' },
                  task_mode: { type: 'string', enum: ['default', 'ref', 'l2v', 'edit', 'passthrough'] },
                  context_mode: { type: 'string', enum: ['shot', 'context', 'context_drift'], description: '衔接：shot=独立切镜 / context=承接上一段末帧 / context_drift=允许漂移' },
                  reason: { type: 'string', description: '判断依据（一句话，会写进汇报）' },
                },
                required: ['index', 'task_mode'],
              },
            },
          },
          required: ['items'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'dump_state',
        description: '导出排障快照（各段 A/B 绑定、资源池文件字段、任务轨 stable_key 与 images），写入 user/DeciiaEasyMedia/agent_state_dump.json。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_bindings',
        description: '逐段列出已绑定的资源清单（含主体展开的子图）与稿内令牌，用来诊断"某段没绑图"的问题。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repair_task_images',
        description: '校验并修复任务轨图片：检查每个绑定图片文件是否真实存在，按名称主干找回真实文件（同名不同时间戳），写回资源后同步到任务轨。用于"图看起来绑了但预览空白/生成找不到文件"。',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '只处理该段（1 起），留空处理全部' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'sync_task_images',
        description: '把各段已绑定的图片资源同步写入任务轨对应片段的 images（修复绑定了但任务轨没图）。不传 index 则处理全部段。',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '只同步该段（1 起），留空同步全部' },
          },
          required: [],
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
        name: 'get_plan',
        description: '读取完整分镜脚本（每段名称/时长/beat/摘要/镜头/台词/设置/A稿长度/绑定的主体与资源）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_input_files',
        description: '列出 ComfyUI input 目录下的可用素材（图片/音频/视频），用于挑选参考图、参考音频',
        parameters: {
          type: 'object',
          properties: {
            subdir: { type: 'string', description: '子目录，如 yusheng/ep2' },
            limit: { type: 'number' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'upsert_resource',
        description: '新增或更新一个资源（图片/音频/视频），可同时挂文件路径',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['Picture', 'Audio', 'Video'] },
            relationship: { type: 'string', description: 'reuse / reference / style 等，可选' },
            description: { type: 'string' },
            file_path: { type: 'string', description: 'input 目录相对路径，如 yusheng/ep2/老赵四视图.png' },
          },
          required: ['name', 'type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'attach_media',
        description: '给已存在的资源挂上文件（图片/音频/视频）并置为 ready',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '资源名称' },
            file_path: { type: 'string', description: 'input 目录相对路径' },
          },
          required: ['name', 'file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_resource',
        description: '生成缺失资源（图片/配音/音乐/参考视频）。低频操作：仅缺素材或用户明确要求时才调用；参考视频默认 5 秒（≤10 秒），更长需用户确认。调用会阻塞等待完成（参考视频 5–10 分钟）',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['image', 'voice', 'music', 'refvideo'] },
            name: { type: 'string', description: '资源名称（已存在则更新，不存在则新建）' },
            prompt: { type: 'string', description: '画面/音乐描述（image/music/refvideo 用）' },
            text: { type: 'string', description: '配音文本（voice 用）' },
            duration: { type: 'number', description: '目标时长秒（music/refvideo 用）' },
            reference_file: { type: 'string', description: '参考素材 input 路径（音色/首帧/风格）' },
            ratio: { type: 'string', description: '画幅（image 用），如 9:16 / 16:9 / 3:4，留空沿用工作流默认' },
            reference_images_json: { type: 'string', description: 'image 用：合并台参考图 JSON 数组，传 [] 表示不带参考图' },
            prompt_override: { type: 'string', description: 'refvideo 专用：直接给出 prompt_override 文本（可含 [0-5s] 与 @图片1/@音频1 引用）' },
            negative: { type: 'string', description: '负面提示词（可选）' },
            resource_type: { type: 'string', enum: ['Picture', 'Audio', 'Video'], description: '资源类型，默认按 type 推断' },
            profile: { type: 'string', description: '档位名（如 fast / standard / final），取决于 resource_workflows.json 里配置了哪些' },
            inputs: { type: 'object', additionalProperties: true, description: '按次覆盖工作流输入，键为 节点id.字段名' },
          },
          required: ['type', 'name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_outputs',
        description: '列出项目最近的生成产物（视频/图片路径），用于生成后自查',
        parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_generation',
        description: '触发 ComfyUI 正式生成（等同点击运行队列）。调用前必须确认分镜已应用到任务轨',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_all_prompts',
        description: '为指定段批量生成标准提示词并写入 finalA（按段任务类型自动选模板）',
        parameters: {
          type: 'object',
          properties: {
            indices: { type: 'array', items: { type: 'number' }, description: '段序号数组；不传则全部段' },
            variant: { type: 'string', enum: ['a', 'b'] },
            language: { type: 'string', enum: ['中文', 'English'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_generation_status',
        description: '查询 ComfyUI 队列与最近生成结果（运行中/排队数/最近记录），用于判断生成是否完成',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: '最近记录条数，默认 3' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_resources_batch',
        description: '批量生成资源（最多 6 项，串行执行）。每项独立失败，不会中断其余项',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: '每项：{type,name,prompt,text,duration,reference_file,profile}',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  type: { type: 'string', enum: ['image', 'voice', 'music', 'refvideo'] },
                  name: { type: 'string' },
                  prompt: { type: 'string' },
                  text: { type: 'string' },
                  duration: { type: 'number' },
                  reference_file: { type: 'string' },
                  profile: { type: 'string' },
                },
                required: ['type', 'name'],
              },
            },
          },
          required: ['items'],
        },
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

  const writePlanAll = (planNext: StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) => {
    const fps = frameRate || 24
    let cursor = 0
    const segments = planNext.segments.map((segment, i) => {
      const duration = Math.max(1, Number(segment.duration_seconds ?? 0) || 4)
      const frames = Math.max(1, Math.round(duration * fps))
      const next = {
        ...segment,
        index: i + 1,
        duration_seconds: duration,
        duration_frames: frames,
        start_frame: cursor,
        end_frame: cursor + frames,
      }
      cursor += frames
      return next
    })
    const totalSeconds = segments.reduce((acc, segment) => acc + Number(segment.duration_seconds ?? 0), 0)
    writeWorkspace(projectKey, {
      plan: {
        ...(planNext as Record<string, unknown>),
        segments,
        total_seconds: Number(totalSeconds.toFixed(2)),
        total_frames: cursor,
        frame_rate: fps,
      } as never,
    })
  }

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
    if (name === 'add_segment') {
      if (!planNow) return { error: '当前没有分镜脚本，请先用 plan_storyboard 生成' }
      const after = Math.max(0, Math.min(segments.length, Number(args.after_index ?? 0) || 0))
      const neighbor = segments[Math.max(0, after - 1)]
      const newSegment = {
        name: String(args.name ?? `新段 ${after + 1}`),
        beat: String(args.beat ?? ''),
        duration_seconds: Number(args.duration_seconds ?? 4) || 4,
        summary: String(args.summary ?? ''),
        director_note: '',
        shots: [],
        subjects: [],
        resources: [],
        settings: { ...((neighbor?.settings as Record<string, unknown> | undefined) ?? ((planNow as Record<string, unknown>).settings as Record<string, unknown> | undefined) ?? {}) },
      }
      const nextSegments = [...segments.slice(0, after), newSegment, ...segments.slice(after)]
      writePlanAll({ ...(planNow as Record<string, unknown>), segments: nextSegments } as never)
      return { ok: true, inserted_at: after + 1, total: nextSegments.length }
    }
    if (name === 'delete_segment') {
      if (!planNow) return { error: '当前没有分镜脚本' }
      const index0 = Number(args.index ?? 0) - 1
      if (index0 < 0 || index0 >= segments.length) return { error: `段 ${Number(args.index)} 不存在` }
      const nextSegments = segments.filter((_segment, i) => i !== index0)
      if (!nextSegments.length) return { error: '不能删除最后一段（脚本至少保留一段）' }
      writePlanAll({ ...(planNow as Record<string, unknown>), segments: nextSegments } as never)
      return { ok: true, deleted: index0 + 1, total: nextSegments.length }
    }
    if (name === 'update_segment') {
      if (!planNow) return { error: '当前没有分镜脚本' }
      const index0 = Number(args.index ?? 0) - 1
      if (index0 < 0 || index0 >= segments.length) return { error: `段 ${Number(args.index)} 不存在` }
      const patch: Record<string, unknown> = {}
      for (const key of ['name', 'beat', 'summary', 'director_note'] as const) {
        if (typeof args[key] === 'string') patch[key] = args[key]
      }
      if (Number.isFinite(Number(args.duration_seconds))) patch.duration_seconds = Number(args.duration_seconds)
      if (Array.isArray(args.shots)) patch.shots = args.shots
      const nextSegments = segments.map((segment, i) => (i === index0 ? { ...segment, ...patch } : segment))
      writePlanAll({ ...(planNow as Record<string, unknown>), segments: nextSegments } as never)
      return { ok: true, updated: index0 + 1, fields: Object.keys(patch) }
    }
    if (name === 'split_segment') {
      if (!planNow) return { error: '当前没有分镜脚本' }
      const index0 = Number(args.index ?? 0) - 1
      const segment = segments[index0]
      if (!segment) return { error: `段 ${Number(args.index)} 不存在` }
      const duration = Math.max(1, Number(segment.duration_seconds ?? 4) || 4)
      const half = Math.max(0.5, Number((duration / 2).toFixed(1)))
      const baseName = String(segment.name ?? `段${index0 + 1}`)
      const shots = Array.isArray(segment.shots) ? (segment.shots as Array<Record<string, unknown>>) : []
      const mid = Math.ceil(shots.length / 2)
      const first = {
        ...segment,
        name: String(args.first_name ?? `${baseName}（上）`),
        duration_seconds: half,
        shots: shots.slice(0, mid),
        promptA: '', promptB: '', finalA: '', finalB: '',
      }
      const second = {
        ...segment,
        name: String(args.second_name ?? `${baseName}（下）`),
        duration_seconds: Number((duration - half).toFixed(1)),
        shots: shots.slice(mid),
        promptA: '', promptB: '', finalA: '', finalB: '',
      }
      const nextSegments = [...segments.slice(0, index0), first, second, ...segments.slice(index0 + 1)]
      writePlanAll({ ...(planNow as Record<string, unknown>), segments: nextSegments } as never)
      return { ok: true, split: index0 + 1, new_total: nextSegments.length }
    }
    if (name === 'merge_segments') {
      if (!planNow) return { error: '当前没有分镜脚本' }
      const index0 = Number(args.index ?? 0) - 1
      const first = segments[index0]
      const second = segments[index0 + 1]
      if (!first || !second) return { error: `段 ${Number(args.index)} 或下一段不存在` }
      const merged = {
        ...first,
        name: String(first.name ?? '') + '+' + String(second.name ?? ''),
        duration_seconds: Number((Number(first.duration_seconds ?? 0) + Number(second.duration_seconds ?? 0)).toFixed(1)),
        summary: [first.summary, second.summary].filter(Boolean).join('；'),
        shots: [
          ...(Array.isArray(first.shots) ? (first.shots as Array<Record<string, unknown>>) : []),
          ...(Array.isArray(second.shots) ? (second.shots as Array<Record<string, unknown>>) : []),
        ].slice(0, 6),
        promptA: '', promptB: '', finalA: '', finalB: '',
      }
      const nextSegments = [...segments.slice(0, index0), merged, ...segments.slice(index0 + 2)]
      writePlanAll({ ...(planNow as Record<string, unknown>), segments: nextSegments } as never)
      return { ok: true, merged: [index0 + 1, index0 + 2], new_total: nextSegments.length }
    }
    if (name === 'set_plan_settings') {
      if (!planNow) return { error: '当前没有分镜脚本' }
      const current = ((planNow as Record<string, unknown>).settings ?? {}) as Record<string, unknown>
      const nextSettings: Record<string, unknown> = { ...current }
      for (const key of ['ratio', 'taskType', 'contextMode', 'refImageSize'] as const) {
        if (typeof args[key] === 'string' && args[key]) nextSettings[key] = args[key]
      }
      writeWorkspace(projectKey, { plan: { ...(planNow as Record<string, unknown>), settings: nextSettings } as never })
      return { ok: true, settings: nextSettings }
    }
    if (name === 'get_plan') {
      if (!planNow) return { error: '当前没有分镜脚本' }
      return {
        title: String((planNow as Record<string, unknown>).title ?? ''),
        total_seconds: Number((planNow as Record<string, unknown>).total_seconds ?? 0),
        segments: segments.map((segment, i) => {
          const settings = (segment.settings ?? {}) as Record<string, unknown>
          const bindA = readBindings(projectKey, `script-${i}:a`).length
          const bindB = readBindings(projectKey, `script-${i}:b`).length
          return {
            index: i + 1,
            name: String(segment.name ?? ''),
            duration_seconds: Number(segment.duration_seconds ?? 0),
            beat: String(segment.beat ?? ''),
            summary: String(segment.summary ?? '').slice(0, 200),
            shots: ((segment.shots ?? []) as Array<Record<string, unknown>>).map((shot) => ({
              framing: shot.framing,
              action: String(shot.action ?? '').slice(0, 120),
              dialogue: shot.dialogue,
            })),
            settings: { taskType: settings.taskType ?? '', contextMode: settings.contextMode ?? '', refImageSize: settings.refImageSize ?? '' },
            promptA_len: String(segment.promptA ?? '').length,
            finalA_len: String(segment.finalA ?? '').length,
            bound_a: bindA,
            bound_b: bindB,
            subjects: ((segment.subjects ?? []) as Array<Record<string, unknown>>).map((item) => item.name),
            resources: ((segment.resources ?? []) as Array<Record<string, unknown>>).map((item) => item.name),
          }
        }),
      }
    }
    if (name === 'list_input_files') {
      const query = new URLSearchParams()
      if (typeof args.subdir === 'string' && args.subdir) query.set('subdir', args.subdir)
      query.set('limit', String(Number(args.limit ?? 60) || 60))
      const response = await fetch(`/easy-media/assets/input?${query.toString()}`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) return { error: String(data?.error || `列目录失败（HTTP ${response.status}）`) }
      return { root: data.root, items: (data.items ?? []).slice(0, Number(args.limit ?? 60)) }
    }
    if (name === 'upsert_resource' || name === 'attach_media') {
      const resourceName = String(args.name ?? '').trim()
      if (!resourceName) return { error: 'name 不能为空' }
      const pool = readResources(projectKey) as ProjectResource[]
      let target = pool.find((item) => item.name === resourceName)
      const filePath = typeof args.file_path === 'string' ? args.file_path.trim().replace(/\\/g, '/') : ''
      const fileName = filePath ? filePath.split('/').pop() || '' : ''
      const subfolder = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
      const kind = String(args.type ?? '').toLowerCase()
      const ext = (fileName.split('.').pop() || '').toLowerCase()
      const mediaKind = kind
        || (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext) ? 'picture'
          : ['wav', 'mp3', 'm4a', 'flac'].includes(ext) ? 'audio' : 'video')
      if (name === 'attach_media' && !target) return { error: `资源「${resourceName}」不存在，请先用 list_resources 确认，或改用 upsert_resource 新建` }
      if (!target) {
        const created = {
          id: `res-${Date.now().toString(36)}`,
          type: mediaKind === 'picture' ? 'Picture' : mediaKind === 'audio' ? 'Audio' : 'Video',
          name: resourceName,
          relationship: typeof args.relationship === 'string' && args.relationship ? args.relationship : 'reuse',
          description: typeof args.description === 'string' ? args.description : '',
          retention: [],
          status: filePath ? 'ready' : 'need',
          childResourceIds: [],
          source: 'manual',
          ...(fileName ? {
            ...(mediaKind === 'picture' ? { imageFile: fileName } : mediaKind === 'audio' ? { audioFile: fileName } : { videoFile: fileName }),
            subfolder,
            sharedRoot: 'input',
          } : {}),
        } as unknown as ProjectResource
        upsertResource(projectKey, created)
        return { ok: true, created: resourceName, type: created.type, file: fileName || null }
      }
      const patch: Record<string, unknown> = {}
      if (typeof args.description === 'string') patch.description = args.description
      if (typeof args.relationship === 'string' && args.relationship) patch.relationship = args.relationship
      if (fileName) {
        const targetKind = mediaKind || String(target.type).toLowerCase()
        if (targetKind === 'picture' || targetKind === 'image') patch.imageFile = fileName
        else if (targetKind === 'audio') patch.audioFile = fileName
        else patch.videoFile = fileName
        patch.subfolder = subfolder
        patch.sharedRoot = 'input'
        patch.status = 'ready'
      }
      patchResource(projectKey, target.id, patch as never)
      return { ok: true, updated: resourceName, file: fileName || undefined }
    }
    if (name === 'generate_resource') {
      const resourceType = String(args.type ?? '').trim()
      const targetName = String(args.name ?? '').trim()
      if (!resourceType || !targetName) return { error: 'type 与 name 必填' }
      const mediaKind = resourceType === 'image' ? 'picture' : resourceType === 'voice' || resourceType === 'music' ? 'audio' : 'video'
      const etaText = (() => {
        const seconds = Number(args.duration ?? 5) || 5
        if (resourceType === 'refvideo') {
          if (seconds <= 5) return '约 5–10 分钟'
          if (seconds <= 10) return '约 10–20 分钟'
          return '约 15–30 分钟'
        }
        if (resourceType === 'voice' || resourceType === 'music') return '约 1–10 分钟'
        return '约 1–2 分钟'
      })()
      progressRef.current?.(`⏳ 已提交「${targetName}」生成任务（${resourceType}，预计 ${etaText}），完成后会自动入库…`)
      const response = await fetch('/easy-media/resource-workflows/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          async: true,
          type: resourceType,
          params: {
            name: String(args.name ?? 'res'),
            prompt: String(args.prompt ?? ''),
            text: String(args.text ?? ''),
            duration: Number(args.duration ?? 5) || 5,
            ratio: String(args.ratio ?? ''),
            reference_images_json: String(args.reference_images_json ?? ''),
            inputs: (() => {
              const sizeMap: Record<string, [number, number]> = {
                '1:1': [1024, 1024],
                '4:3': [1360, 1024],
                '3:4': [1024, 1360],
                '16:9': [1824, 1024],
                '9:16': [1024, 1824],
                '2:3': [680, 1024],
                '3:2': [1024, 680],
              }
              const ratioKey = String(args.ratio ?? '').trim()
              const size = sizeMap[ratioKey]
              if (!size) return args.inputs && typeof args.inputs === 'object' ? args.inputs : undefined
              return {
                '682.画布宽度': size[0],
                '682.画布高度': size[1],
                ...(args.inputs && typeof args.inputs === 'object' ? args.inputs : {}),
              }
            })(),
            negative: String(args.negative ?? ''),
            reference_file: String(args.reference_file ?? ''),
            reference_image: String(args.reference_file ?? ''),
            reference_audio: String(args.reference_file ?? ''),
            prompt_override: args.prompt_override ?? String(args.prompt ?? '') + (args.duration ? ` [0-${args.duration}s]` : ''),
            profile: typeof args.profile === 'string' ? args.profile : undefined,
            seed: Math.floor(Math.random() * 1_000_000),
          },
        }),
      })
      const startData = await response.json().catch(() => ({}))
      if (!response.ok || !startData?.ok) {
        return {
          error: String(startData?.error || `提交失败（HTTP ${response.status}）`),
          hint: '请检查导演台设置 →「资源生成」是否为该类型配置了 API 格式工作流',
        }
      }
      const jobId = String(startData.job_id ?? '')
      if (!jobId) return { error: '生成任务未返回 job_id' }
      const startedAt = Date.now()
      let data: Record<string, unknown> = {}
      for (;;) {
        if (abortRef.current?.signal.aborted) return { error: '已取消等待（后台生成可能仍在继续）' }
        await new Promise((resolve) => window.setTimeout(resolve, 5000))
        const statusResponse = await fetch(`/easy-media/resource-workflows/jobs/${jobId}`)
        const statusData = await statusResponse.json().catch(() => ({}))
        if (!statusResponse.ok || !statusData?.ok) {
          return { error: String(statusData?.error || `查询任务失败（HTTP ${statusResponse.status}）`) }
        }
        if (statusData.status === 'done') {
          data = (statusData.result ?? {}) as Record<string, unknown>
          break
        }
        if (statusData.status === 'error') {
          return { error: String(statusData.error || '生成失败'), elapsed: Math.round((Date.now() - startedAt) / 1000) }
        }
        const limit = Number(statusData.timeout ?? 3600) + 120
        if (Number(statusData.elapsed ?? 0) > limit) {
          return { error: `等待超时（${Math.round(limit)}s）`, job_id: jobId }
        }
        if (Number(statusData.elapsed ?? 0) % 60 < 6) {
          progressRef.current?.(`…「${targetName}」已生成 ${Math.round(Number(statusData.elapsed ?? 0))}s / 预计 ${etaText}`)
        }
      }
      if (!data.ok) {
        return { error: String(data.error || '生成失败') }
      }
      const fileName = String(data.file_name || '')
      const subfolder = String(data.subfolder || '')
      const root = String(data.root || 'output') === 'input' ? 'input' : 'output'
      // 完成即播报：把缩略图贴进对话，边生成边能看
      if (fileName) {
        const params = new URLSearchParams({ filename: fileName, type: root })
        if (subfolder) params.set('subfolder', subfolder)
        const imageUrl = `/view?${params.toString()}`
        pushChatLine(`\n\n![${targetName || fileName}](${imageUrl})\n✅ 「${targetName || fileName}」完成（${Math.round((Date.now() - startedAt) / 1000)}s，已入库）\n`)
      }
      const pool = readResources(projectKey) as ProjectResource[]
      const existing = pool.find((item) => item.name === targetName)
      const filePatch = mediaKind === 'picture' ? { imageFile: fileName } : mediaKind === 'audio' ? { audioFile: fileName } : { videoFile: fileName }
      if (existing) {
        patchResource(projectKey, existing.id, { ...filePatch, subfolder, sharedRoot: root, status: 'ready' } as never)
      } else {
        upsertResource(projectKey, {
          id: `res-${Date.now().toString(36)}`,
          type: args.resource_type || (mediaKind === 'picture' ? 'Picture' : mediaKind === 'audio' ? 'Audio' : 'Video'),
          name: targetName,
          relationship: 'generated',
          description: String(args.prompt ?? args.text ?? ''),
          retention: [],
          status: 'ready',
          childResourceIds: [],
          source: 'generated',
          ...filePatch,
          subfolder,
          sharedRoot: root,
        } as unknown as ProjectResource)
      }
      return {
        ok: true,
        type: resourceType,
        name: targetName,
        file: fileName,
        path: data.path,
        note: '资源已生成并挂到主体与资源页，可直接 bind_resources 绑定',
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      }
    }
    if (name === 'list_outputs') {
      const limit = Number(args.limit ?? 8) || 8
      const response = await fetch(`/easy-media/assets/outputs?project=${encodeURIComponent(projectKey)}&limit=${limit}`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) return { error: String(data?.error || `查询产物失败（HTTP ${response.status}）`) }
      return { items: data.items ?? [] }
    }
    if (name === 'run_generation') {
      const app = (globalThis as unknown as { app?: { queuePrompt?: (number: number, batch: number) => Promise<unknown> } }).app
      if (!app?.queuePrompt) return { error: '当前环境无法触发队列（app.queuePrompt 不可用）' }
      try {
        await app.queuePrompt(0, 1)
        return { ok: true, queued: true, note: '已提交到 ComfyUI 队列，可用 list_outputs 查看产物' }
      } catch (error) {
        return { error: `提交失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (name === 'get_generation_status') {
      const limit = Math.max(1, Math.min(10, Number(args.limit ?? 3) || 3))
      const [queueResponse, historyResponse] = await Promise.all([
        fetch('/queue').catch(() => null),
        fetch(`/history?max_items=${limit}`).catch(() => null),
      ])
      const queue = queueResponse ? await queueResponse.json().catch(() => ({})) : {}
      const historyData = historyResponse ? await historyResponse.json().catch(() => ({})) : {}
      const running = (queue.queue_running ?? []).length
      const pending = (queue.queue_pending ?? []).length
      const recent = Object.entries(historyData).map(([promptId, entry]) => {
        const record = entry as Record<string, unknown>
        const status = (record.status ?? {}) as Record<string, unknown>
        const outputs = (record.outputs ?? {}) as Record<string, unknown>
        const files: string[] = []
        for (const nodeOutput of Object.values(outputs)) {
          const payload = nodeOutput as Record<string, unknown>
          for (const key of ['images', 'videos', 'gifs', 'audio']) {
            for (const item of (payload[key] ?? []) as Array<Record<string, unknown>>) {
              if (item?.filename) files.push(String(item.filename))
            }
          }
        }
        return {
          prompt_id: promptId,
          status: status.status_str ?? 'unknown',
          completed: Boolean(status.completed),
          files: files.slice(0, 6),
        }
      })
      return {
        running,
        pending,
        queue_empty: running === 0 && pending === 0,
        recent,
        hint: running === 0 && pending === 0 ? '队列空闲，可以开始新的生成' : '队列忙，等待或稍后查询',
      }
    }
    if (name === 'generate_resources_batch') {
      const rawItems = Array.isArray(args.items) ? args.items : []
      const items = rawItems.filter((item) => item && typeof item === 'object').slice(0, 6) as Array<Record<string, unknown>>
      if (!items.length) return { error: 'items 不能为空' }
      const results: Array<Record<string, unknown>> = []
      for (const item of items) {
        if (abortRef.current?.signal.aborted) {
          results.push({ name: item.name, error: '已取消' })
          break
        }
        const single = await executeAgentTool('generate_resource', item)
        results.push({
          name: String(item.name ?? ''),
          type: String(item.type ?? ''),
          ...single,
        })
      }
      const generated = results.filter((item) => !item.error).length
      return {
        ok: generated > 0,
        generated,
        failed: results.length - generated,
        total: items.length,
        results,
        note: generated > 0 ? '已生成并挂到资源池，可继续 bind_resources 绑定' : '全部失败，检查 resource_workflows.json 配置',
      }
    }
    if (name === 'generate_all_prompts') {
      const variant = String(args.variant ?? 'a') === 'b' ? 'b' : 'a'
      const requested = Array.isArray(args.indices) ? args.indices.map((item) => Number(item)) : null
      const planForAll = readPlan() as (StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) | null
      const scriptCount = planForAll?.segments?.length ?? segments.length
      const targets = (requested ?? Array.from({ length: scriptCount }, (_item, i) => i + 1))
        .filter((index) => index >= 1 && index <= scriptCount)
        .slice(0, 20)
      const results: Array<Record<string, unknown>> = []
      for (const index of targets) {
        const single = await executeAgentTool('generate_prompt', { index, variant, language: args.language ?? '中文' })
        results.push({ index, ...single })
      }
      return { ok: true, generated: results.filter((item) => !item.error).length, total: targets.length, results }
    }
    if (name === 'plan_storyboard' || name === 'revise_storyboard') {
      const isRevision = name === 'revise_storyboard'
      const brief = String(args.brief ?? '').trim()
      const instruction = String(args.instruction ?? '').trim()
      if (isRevision && !instruction) return { error: '缺少修改要求' }
      if (!isRevision && !brief) return { error: '缺少故事想法' }
      const planNow = readPlan()
      const body: Record<string, unknown> = {
        brief,
        instruction,
        duration_seconds: args.duration_seconds ?? undefined,
        ratio: args.ratio ?? ratio,
        style: args.style ?? undefined,
        frame_rate: frameRate || 24,
      }
      if (isRevision) {
        if (!planNow) return { error: '当前没有分镜脚本可修改' }
        body.previous_plan = planNow
      }
      const response = await fetch('/easy-media/prompt-studio/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) return { error: String(data?.error || `规划失败（HTTP ${response.status}）`) }
      const nextPlan = data.plan
      if (!nextPlan?.segments?.length) return { error: '规划结果为空' }
      const planDefaults = {
        ratio: String(args.ratio ?? ratio ?? '9:16'),
        frame_rate: frameRate || 24,
        taskType: String(args.task_type ?? args.taskType ?? 'R2V'),
        contextMode: 'shot',
        refImageSize: 'match',
        ...((nextPlan as { settings?: Record<string, unknown> }).settings ?? {}),
      }
      writeWorkspace(projectKey, { plan: { ...nextPlan, settings: planDefaults } as never })
      return {
        ok: true,
        segments: nextPlan.segments.length,
        total_seconds: nextPlan.total_seconds,
        title: nextPlan.title,
        note: '分镜已写入项目，可在「分镜编排」页查看，或让我继续完善主体与资源、生成提示词',
      }
    }
    if (name === 'list_skills') {
      const response = await fetch('/easy-media/agent/skills')
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) return { error: String(data?.error || `读取技能失败（HTTP ${response.status}）`) }
      return { skills: data.skills ?? [] }
    }
    if (name === 'read_skill') {
      const skillName = String(args.name ?? '').trim()
      if (!skillName) return { error: 'name 必填' }
      const response = await fetch(`/easy-media/agent/skills?name=${encodeURIComponent(skillName)}`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) return { error: String(data?.error || `技能不存在：${skillName}`) }
      return { name: skillName, content: String(data.content ?? '').slice(0, 12000) }
    }
    if (name === 'update_todos') {
      const rawItems = Array.isArray(args.items) ? args.items : []
      const items = rawItems
        .filter((item) => item && typeof item === 'object')
        .slice(0, 24)
        .map((item) => ({
          text: String((item as Record<string, unknown>).text ?? '').slice(0, 120),
          status: (['pending', 'doing', 'done'] as const).includes(String((item as Record<string, unknown>).status ?? '') as never)
            ? String((item as Record<string, unknown>).status)
            : 'pending',
        }))
      if (!items.length) return { error: 'items 不能为空' }
      writeWorkspace(projectKey, { todos: items } as never)
      return {
        ok: true,
        total: items.length,
        done: items.filter((item) => item.status === 'done').length,
        next: items.find((item) => item.status !== 'done')?.text ?? '全部完成',
      }
    }
    if (name === 'remember') {
      const key = String(args.key ?? '').trim().slice(0, 60)
      const value = String(args.value ?? '').trim().slice(0, 800)
      if (!key || !value) return { error: 'key 与 value 必填' }
      const notes = { ...((readWorkspace(projectKey).notes ?? {}) as Record<string, string>), [key]: value }
      writeWorkspace(projectKey, { notes } as never)
      return { ok: true, key, total: Object.keys(notes).length }
    }
    if (name === 'recall') {
      const notes = (readWorkspace(projectKey).notes ?? {}) as Record<string, string>
      const query = String(args.query ?? '').trim().toLowerCase()
      const entries = Object.entries(notes)
        .filter(([key, value]) => !query || key.toLowerCase().includes(query) || value.toLowerCase().includes(query))
        .slice(0, 30)
        .map(([key, value]) => ({ key, value }))
      return { count: entries.length, notes: entries }
    }
    if (name === 'memorize') {
      const allowed = ['preference', 'project', 'decision', 'constraint', 'pitfall']
      const rawType = String(args.type ?? 'project').trim()
      const mt = allowed.includes(rawType) ? rawType : 'project'
      const title = String(args.title ?? '').trim().slice(0, 80)
      const content = String(args.content ?? '').trim().slice(0, 500)
      if (!title || !content) return { error: 'title 与 content 必填' }
      const importance = Math.max(1, Math.min(5, Number(args.importance ?? 3) || 3))
      const list = ((readWorkspace(projectKey).memories ?? []) as Array<Record<string, unknown>>).slice()
      const record = { type: mt, title, content, importance, updatedAt: Date.now() }
      const idx = list.findIndex((item) => String(item.title ?? '') === title)
      if (idx >= 0) list[idx] = { ...list[idx], ...record }
      else list.push({ id: `mem-${Date.now().toString(36)}`, createdAt: Date.now(), ...record })
      list.sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0))
      writeWorkspace(projectKey, { memories: list.slice(0, 60) } as never)
      return { ok: true, type: mt, title, importance, merged: idx >= 0, total: Math.min(list.length, 60) }
    }
    if (name === 'recall_memories') {
      const list = ((readWorkspace(projectKey).memories ?? []) as Array<Record<string, unknown>>)
      const query = String(args.query ?? '').trim().toLowerCase()
      const typeFilter = String(args.type ?? '').trim()
      const limit = Math.max(1, Math.min(30, Number(args.limit ?? 10) || 10))
      const items = list
        .filter((item) => (!typeFilter || String(item.type ?? '') === typeFilter))
        .filter((item) => !query
          || String(item.title ?? '').toLowerCase().includes(query)
          || String(item.content ?? '').toLowerCase().includes(query))
        .sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0))
        .slice(0, limit)
        .map((item) => ({ type: item.type, title: item.title, content: item.content, importance: item.importance }))
      return { count: items.length, memories: items }
    }
    if (name === 'verify_project') {
      const planNow2 = readPlan() as (StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) | null
      const scriptSegments = planNow2?.segments ?? []
      const trackSegments = segments
      const pool = readResources(projectKey) as ProjectResource[]
      const issues: Array<{ level: string; where: string; message: string }> = []
      if (scriptSegments.length && trackSegments.length && scriptSegments.length !== trackSegments.length) {
        issues.push({
          level: 'warn',
          where: '任务轨',
          message: `脚本 ${scriptSegments.length} 段 vs 任务轨 ${trackSegments.length} 段，需重新 apply_storyboard`,
        })
      }
      scriptSegments.forEach((segment, i) => {
        const s = segment as Record<string, unknown>
        const name = String(s.name ?? `段 ${i + 1}`)
        if (!String(s.promptA ?? '').trim()) {
          issues.push({ level: 'warn', where: name, message: 'A 稿为空（提示词增强无法生成）' })
        }
        if (!String(s.finalA ?? '').trim()) {
          issues.push({ level: 'info', where: name, message: '终稿为空（可 generate_all_prompts）' })
        }
        if (!readBindings(projectKey, `script-${i + 1}:a`).length) {
          issues.push({ level: 'info', where: name, message: '未绑定任何主体/资源' })
        }
      })
      for (const resource of pool) {
        if (resource.type === 'Subject') {
          if (!(resource.childResourceIds ?? []).length) {
            issues.push({ level: 'info', where: `主体 ${resource.name}`, message: '没有挂参考图/音色' })
          }
          continue
        }
        const hasFile = Boolean(resource.imageFile || resource.audioFile || resource.videoFile)
        if (!hasFile) {
          issues.push({ level: 'warn', where: `资源 ${resource.name}`, message: '缺文件（status=' + String(resource.status ?? '?') + '）' })
        }
      }
      trackSegments.forEach((segment, i) => {
        if (!String((segment as { hasPrompt?: boolean }).hasPrompt)) {
          issues.push({ level: 'info', where: `任务轨段 ${i + 1}`, message: '没有提示词' })
        }
      })
      const counts = {
        scripts: scriptSegments.length,
        tracks: trackSegments.length,
        resources: pool.filter((item) => item.type !== 'Subject').length,
        subjects: pool.filter((item) => item.type === 'Subject').length,
        warn: issues.filter((item) => item.level === 'warn').length,
      }
      return { ok: counts.warn === 0, counts, issues: issues.slice(0, 30) }
    }
    if (name === 'list_projects') {
      const response = await fetch('/easy-media/project/timelines')
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return { error: String(data?.error || `读取项目列表失败（HTTP ${response.status}）`) }
      const rows = Array.isArray(data) ? data : (data.projects ?? data.timelines ?? [])
      return {
        current: projectKey,
        projects: (rows as Array<Record<string, unknown>>).slice(0, 60).map((row) => ({
          name: row.project_name,
          segments: row.segments,
          prompt_segments: row.prompt_segments,
          duration_seconds: row.duration_seconds,
          updated_at: row.updated_at,
        })),
      }
    }
    if (name === 'save_project') {
      const registry = (globalThis as unknown as { __easyMediaGetTrackData?: () => Record<string, unknown> | null }).__easyMediaGetTrackData
      if (!registry) return { error: '拿不到任务轨数据（弹窗可能不是从节点打开）' }
      const timeline = registry()
      if (!timeline) return { error: '任务轨为空，没有可保存内容' }
      const response = await fetch('/easy-media/project/timeline', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: projectKey, timeline: { version: 1, track_data: timeline } }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return { error: String(data?.error || `保存失败（HTTP ${response.status}）`) }
      return { ok: true, saved: true, project: projectKey, updated_at: data?.updated_at ?? null }
    }
    if (name === 'link_subject_assets') {
      const subjectName = String(args.subject ?? '').trim()
      const wanted = Array.isArray(args.resources) ? args.resources.map(String) : []
      if (!subjectName || !wanted.length) return { error: 'subject 与 resources 必填' }
      const pool = readResources(projectKey) as ProjectResource[]
      const subject = pool.find((item) => item.type === 'Subject' && item.name === subjectName)
      if (!subject) return { error: `主体「${subjectName}」不存在，请先用 upsert_subject 创建` }
      const matched = wanted.map((name) => pool.find((item) => item.name === name)).filter(Boolean) as ProjectResource[]
      const missing = wanted.filter((name) => !pool.some((item) => item.name === name))
      if (!matched.length) return { error: `没有匹配到资源：${wanted.join('、')}` }
      const nextIds = args.replace === true
        ? matched.map((item) => item.id)
        : Array.from(new Set([...(subject.childResourceIds ?? []), ...matched.map((item) => item.id)]))
      patchResource(projectKey, subject.id, { childResourceIds: nextIds } as never)
      return { ok: true, subject: subjectName, linked: matched.map((item) => item.name), missing, total: nextIds.length }
    }
    if (name === 'set_resource_brief') {
      const targetName = String(args.name ?? '').trim()
      const brief = String(args.brief ?? '').trim()
      if (!targetName || !brief) return { error: 'name 与 brief 必填' }
      const pool = readResources(projectKey) as ProjectResource[]
      const target = pool.find((item) => item.name === targetName)
      if (!target) return { error: `资源「${targetName}」不存在` }
      patchResource(projectKey, target.id, { brief, description: brief } as never)
      return { ok: true, name: targetName, brief_chars: brief.length }
    }
    if (name === 'list_task_track') {
      const registry = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      if (!registry) return { error: '没有可用的多轨编辑器上下文（弹窗可能不是从节点打开）' }
      let summary: { tasks?: Array<Record<string, unknown>> } = {}
      try {
        summary = registry() ?? {}
      } catch (error) {
        return { error: `读取任务轨失败：${error instanceof Error ? error.message : String(error)}` }
      }
      const tasks = summary.tasks ?? []
      return {
        count: tasks.length,
        tasks,
        note: tasks.length ? '任务轨已有片段' : '任务轨为空，需要先 apply_storyboard',
      }
    }
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
        const planSeg = (readPlan() as { segments?: Array<Record<string, unknown>> } | null)?.segments?.[index0]
        patch.settings = { ...((segments[index0]?.settings ?? {}) as Record<string, unknown>), ...(((planSeg?.settings ?? {}) as Record<string, unknown>)), ...settingsPatch }
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
    /** 删除前快照，压入撤销栈（保留最近 5 次，可连续撤销） */
    const saveDeleteSnapshot = (snapshot: Record<string, unknown>) => {
      const stack = ((readWorkspace(projectKey) as { deleteHistory?: Array<Record<string, unknown>> }).deleteHistory ?? [])
      const next = [...stack, { at: Date.now(), ...snapshot }].slice(-5)
      writeWorkspace(projectKey, { deleteHistory: next, lastDelete: next[next.length - 1] } as never)
    }

    /** 把当前节点内存里的任务轨写盘（不带 base_updated_at = 覆盖保存） */
    const flushProjectToDisk = async () => {
      const registry = (globalThis as unknown as { __easyMediaGetTrackData?: () => Record<string, unknown> | null }).__easyMediaGetTrackData
      const timeline = registry?.()
      if (!timeline) return { saved: false, reason: '拿不到任务轨数据' }
      try {
        const response = await fetch('/easy-media/project/timeline', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_name: projectKey, timeline: { version: 1, track_data: timeline } }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) return { saved: false, reason: String(data?.error || `HTTP ${response.status}`) }
        return { saved: true, updated_at: data?.updated_at ?? null }
      } catch (error) {
        return { saved: false, reason: String(error) }
      }
    }

    /** 按括号里的资源名，把令牌编号对齐到真实绑定（只改编号，不动任何文字） */
    const alignTokenNumbers = (segmentIndex: number, text: string) => {
      const ids = boundIdsForSegment(segmentIndex)
      const pool = readResources(projectKey) as ProjectResource[]
      const topLevel = ids
        .map((id) => pool.find((entry) => entry.id === id))
        .filter((item): item is ProjectResource => Boolean(item))
      const nameToToken = new Map<string, string>()
      let subjectNo = 0
      let pictureNo = 0
      let audioNo = 0
      let videoNo = 0
      for (const item of topLevel) {
        let token = ''
        if (item.type === 'Subject') { subjectNo += 1; token = `<Subject ${subjectNo}>` }
        else if (item.type === 'Picture') { pictureNo += 1; token = `<Picture ${pictureNo}>` }
        else if (item.type === 'Audio') { audioNo += 1; token = `<Audio ${audioNo}>` }
        else if (item.type === 'Video') { videoNo += 1; token = `<Video ${videoNo}>` }
        if (token && item.name) nameToToken.set(item.name, token)
      }
      const fixes: Array<{ from: string; to: string; name: string }> = []
      const aligned = text.replace(/<(Subject|Picture|Audio|Video)\s+(\d+)>\s*[（(]([^）)]{1,40})[）)]/g, (whole, kind, num, inner) => {
        const written = String(inner)
        let matchedName = ''
        let matchedToken = ''
        for (const [name, token] of nameToToken.entries()) {
          if (!name || !written.includes(name)) continue
          if (!token.startsWith(`<${kind} `)) continue
          matchedName = name
          matchedToken = token
          break
        }
        if (!matchedToken) return whole
        const current = `<${kind} ${num}>`
        if (current === matchedToken) return whole
        fixes.push({ from: current, to: matchedToken, name: matchedName })
        return whole.replace(current, matchedToken)
      })
      return { text: aligned, fixes }
    }

    /** 提示词结构校验：返回问题列表（空=通过） */
    const auditPrompt = (segmentIndex: number, prompt: string, fragmentMode = false) => {
      const ids = boundIdsForSegment(segmentIndex)
      const pool = readResources(projectKey) as ProjectResource[]
      const expanded: ProjectResource[] = []
      for (const id of ids) {
        const item = pool.find((entry) => entry.id === id)
        if (!item) continue
        if (!expanded.includes(item)) expanded.push(item)
        if (item.type === 'Subject') {
          for (const childId of item.childResourceIds ?? []) {
            const child = pool.find((entry) => entry.id === childId)
            if (child && !expanded.includes(child)) expanded.push(child)
          }
        }
      }
      const topLevel = ids.map((id) => pool.find((entry) => entry.id === id)).filter((item): item is ProjectResource => Boolean(item))
      const pictures = topLevel.filter((item) => item.type === 'Picture').length
      const subjects = topLevel.filter((item) => item.type === 'Subject').length
      const audios = expanded.filter((item) => item.type === 'Audio').length
      const videos = expanded.filter((item) => item.type === 'Video').length
      const problems: Array<Record<string, unknown>> = []
      const maxOf = (kind: string) => Math.max(0, ...Array.from(prompt.matchAll(new RegExp(`<${kind} \\d+>`, 'g'))).map((m) => Number(String(m[0]).replace(/\\D/g, ''))))
      const countOf = (kind: string) => (prompt.match(new RegExp(`<${kind} \\d+>`, 'g')) ?? []).length
      const checkKind = (kind: string, bound: number) => {
        const max = maxOf(kind)
        const count = countOf(kind)
        if (max > bound) problems.push({ level: 'error', kind, message: `${kind} 编号到 ${max}，但本段只绑了 ${bound} 个` })
        if (bound > 0 && count > bound * 3) problems.push({ level: 'warn', kind, message: `${kind} 重复引用 ${count} 次 / ${bound} 个资源（建议声明处引一次、关键镜次再点一次）` })
      }
      checkKind('Picture', pictures)
      checkKind('Subject', subjects)
      checkKind('Audio', audios)
      checkKind('Video', videos)
      if (/(^|[^A-Za-z])(None|N\/A|undefined)([^A-Za-z]|$)/.test(prompt)) problems.push({ level: 'error', message: '含 None / N/A / undefined 占位' })
      if (!fragmentMode) {
      // 身份必须用 <Subject n>：用 <Picture> 定义人物/四视图/面部特征，无论本段有没绑主体都是硬错误
      const identityAsPicture = /<Picture\s+\d+>[^\n]{0,80}(四视图|三视图|正脸|侧脸|正面照|全身照|面部特征|发型|五官|人物|角色|主角|男主|女主|技师|司机|店主|工人|老赵|小赵)/.test(prompt)
        || /(人物|角色|主角|技师|司机|店主|老赵|小赵)[^\n]{0,40}<Picture\s+\d+>/.test(prompt)
      if (identityAsPicture) {
        problems.push({
          level: 'error',
          message: '用 <Picture> 定义人物身份/四视图；人物必须用 <Subject n> 承载（先升格为主体再引用），这是 H3 结构错误，不是可选项',
        })
      }
      // 令牌与紧随其后的括号内名称必须一致（防止 <Picture 2>（工作台） 但工作台其实是 Picture 1）
      const tokenToName = new Map<string, string>()
      let subjectIdx = 0
      let pictureIdx = 0
      let audioIdx = 0
      let videoIdx = 0
      for (const item of topLevel) {
        if (item.type === 'Subject') { subjectIdx += 1; tokenToName.set(`<Subject ${subjectIdx}>`, item.name) }
        else if (item.type === 'Picture') { pictureIdx += 1; tokenToName.set(`<Picture ${pictureIdx}>`, item.name) }
        else if (item.type === 'Audio') { audioIdx += 1; tokenToName.set(`<Audio ${audioIdx}>`, item.name) }
        else if (item.type === 'Video') { videoIdx += 1; tokenToName.set(`<Video ${videoIdx}>`, item.name) }
      }
      for (const match of prompt.matchAll(/<(Subject|Picture|Audio|Video)\s+(\d+)>\s*[（(]([^）)]{1,30})[）)]/g)) {
        const token = `<${match[1]} ${match[2]}>`
        const written = String(match[3]).trim()
        const expected = tokenToName.get(token)
        if (!expected) continue
        const ownerToken = Array.from(tokenToName.entries()).find(([, name]) => name && written.includes(name))?.[0]
        if (ownerToken && ownerToken !== token && expected && !written.includes(expected)) {
          problems.push({
            level: 'warn',
            message: `${token} 后面写的是「${written}」，但 ${token} 对应「${expected}」，「${written}」其实是 ${ownerToken}：请照绑定表抄编号，不要推断`,
          })
        }
      }
      // 建议：该用主体却用了图片（允许「仅借构图」例外，不拦写入）
      const subjectNameSet = new Set(pool.filter((item) => item.type === 'Subject').map((item) => item.name))
      const childToSubject = new Map<string, string>()
      for (const item of pool) {
        if (item.type !== 'Subject') continue
        for (const childId of item.childResourceIds ?? []) childToSubject.set(childId, item.name)
      }
      const pictureTokenToResource = new Map<string, ProjectResource>()
      let pictureSeq = 0
      for (const item of topLevel) {
        if (item.type !== 'Picture') continue
        pictureSeq += 1
        pictureTokenToResource.set(`<Picture ${pictureSeq}>`, item)
      }
      for (const match of prompt.matchAll(/<Picture\s+(\d+)>\s*[（(]([^）)]{1,40})[）)]/g)) {
        const token = `<Picture ${match[1]}>`
        const inner = String(match[2])
        if (/仅借|只借|仅参考构图|只参考构图/.test(inner)) continue
        const resource = pictureTokenToResource.get(token)
        const ownerSubject = resource ? childToSubject.get(resource.id) : undefined
        const namedSubject = Array.from(subjectNameSet).find((name) => name && inner.includes(name))
        if (namedSubject || ownerSubject) {
          problems.push({
            level: 'advice',
            message: `${token}（${inner.slice(0, 16)}）指向的内容已建成主体${namedSubject ? `「${namedSubject}」` : `「${ownerSubject}」`}，优先改用 <Subject n>；若这段只想借这张图的构图，请加「仅借构图」`,
          })
        }
      }
      }
      const identityTokensInRetention = (prompt.match(/<Picture\s+\d+>[^\n]{0,40}(完全沿用|面部|发型|服装|体型|容貌)/g) ?? []).length
      if (identityTokensInRetention >= 2) {
        problems.push({ level: 'warn', message: `retention_analysis 有 ${identityTokensInRetention} 处用 <Picture> 声明人物保留项，应为 <Subject n>` })
      }
      if (!/(^|\n)\s*(?:#+\s*)?\*{0,2}subject_definitions\*{0,2}\s*[:：]/.test(prompt)) {
        problems.push({ level: 'error', message: '缺 subject_definitions 段（六段式第一段）' })
      }
      // 官方 Ref2VA：<Picture N> 只在"本身作为首帧/关键帧/尾帧/构图锚点"时单列；
      // 若只是用来定义人物/场景/服装/风格，必须内嵌进 <Subject N> 定义里引用，不能单列。
      const standalonePictureLines = (prompt.split(/\nsummary\s*[:：]/)[0] ?? '')
        .split('\n')
        .filter((line) => /^\s*<Picture\s+\d+>/.test(line))
      for (const line of standalonePictureLines) {
        const isFrameAnchor = /(首帧|第一帧|起始帧|尾帧|末帧|结束帧|关键帧|构图锚点|分镜参考|storyboard)/.test(line)
        if (isFrameAnchor) continue
        const isCharacter = /(四视图|三视图|正脸|侧脸|全身照|面部|发型|五官|人物|角色|主角|技师|司机|店主|工人|老赵|小赵)/.test(line)
        problems.push({
          level: isCharacter ? 'error' : 'warn',
          message: `subject_definitions 单列了「${line.trim().slice(0, 28)}…」：图片只用来定义人物/场景/风格时应写进 <Subject n> 定义并内嵌引用，单列 <Picture n> 仅限作首帧/关键帧/构图锚点`,
        })
      }
      if (!/(禁止|不得|不要)[^\n]{0,24}(文字|字幕|logo|水印)/.test(prompt)) problems.push({ level: 'warn', message: '缺「不得出现文字/字幕/水印」约束（可自动补）' })
      const head = prompt.split(/\nsummary\s*[:：]/)[0] ?? ''
      if (subjects > 0 && /<Picture\s+\d+>[^\n]{0,20}(老赵|小赵|人物|技师|司机|女人|男人|角色)/.test(head)) {
        problems.push({ level: 'warn', message: 'subject_definitions 用 <Picture> 定义人物，但本段已绑 Subject，应改用 <Subject n>' })
      }
      return { segment: segmentIndex + 1, pictures, subjects, audios, videos, problems }
    }

    /** 段绑定 id 并集：A 版优先，再补 B 版（避免"绑在 B 版却同步不到"） */
    const boundIdsForSegment = (segmentIndex: number) => {
      const merged: string[] = []
      for (const variant of ['a', 'b'] as const) {
        for (const id of readBindings(projectKey, `script-${segmentIndex}:${variant}`)) {
          const key = String(id)
          if (!merged.includes(key)) merged.push(key)
        }
      }
      return merged
    }

    /** 绑定清单 → 任务轨 images（主体展开其子图；仅图片，带实际根目录） */
    const imagesFromBoundIds = (ids: string[]) => {
      const pool = readResources(projectKey) as ProjectResource[]
      const pictures: Array<{ name: string; subfolder?: string; sourceType: 'input' | 'output' | 'temp'; filePath: string }> = []
      const push = (resource: ProjectResource) => {
        if (resource.type !== 'Picture') return
        const fileName = String(resource.imageFile ?? '').trim()
        if (!fileName) return
        const subfolder = String(resource.subfolder ?? '')
        pictures.push({
          name: fileName,
          subfolder,
          sourceType: resource.sharedRoot === 'output' ? 'output' : resource.sharedRoot === 'temp' ? 'temp' : 'input',
          filePath: subfolder ? `${subfolder}/${fileName}` : fileName,
        })
      }
      for (const id of ids) {
        const resource = pool.find((item) => item.id === id)
        if (!resource) continue
        if (resource.type === 'Subject') {
          for (const childId of resource.childResourceIds ?? []) {
            const child = pool.find((item) => item.id === childId)
            if (child) push(child)
          }
        } else {
          push(resource)
        }
      }
      return pictures
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

      // 按该段任务类型校验素材数量（依据节点真实规则）
      const planForBind = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const bindSegment = planForBind?.segments?.[index1 - 1] as Record<string, unknown> | undefined
      const bindMode = String(((bindSegment?.settings ?? {}) as Record<string, unknown>).taskType ?? '').trim().toLowerCase()
      const modeKey = bindMode.includes('l2v') ? 'l2v' : bindMode.includes('r2v') || bindMode.includes('ref') ? 'ref' : bindMode.includes('vi2v') || bindMode.includes('edit') ? 'edit' : 'default'
      const pictureCount = ids.reduce((total, id) => {
        const item = pool.find((resource) => resource.id === id)
        if (!item) return total
        if (item.type === 'Picture') return total + 1
        if (item.type === 'Subject') return total + (item.childResourceIds ?? []).filter((childId) => pool.find((child) => child.id === childId)?.type === 'Picture').length
        return total
      }, 0)
      const maxImages = maxImagesForTaskMode(modeKey)
      if (pictureCount > maxImages) {
        return {
          error: `该段任务类型 ${modeKey} 最多只能绑 ${maxImages} 张图片，本次会绑 ${pictureCount} 张。请先改任务类型（set_task_modes）或减少资源。`,
          task_mode: modeKey,
          max_images: maxImages,
          requested_images: pictureCount,
        }
      }
      const key = `script-${index1 - 1}:${variant}`
      writeBindings(projectKey, key, ids)

      // 关键：把绑定清单里的图片同步到已落地的任务轨片段（否则任务轨 images 永远为空）
      const images = imagesFromBoundIds(ids)
      let syncedTaskIndex = 0
      let syncedImages = 0
      try {
        const summary = (globalThis as unknown as {
          __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
        }).__easyMediaTimelineSummary
        const plan = readPlan() as { segments?: Array<Record<string, unknown>> } | null
        const planSegment = plan?.segments?.[index1 - 1] as Record<string, unknown> | undefined
        const stableKey = String(planSegment?.stable_key ?? '')
        const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
        const matchedTask = tasks.find((task) => stableKey && String(task.stable_key ?? '') === stableKey)
          ?? tasks.find((task) => Number(task.index ?? 0) === index1)
        const updateSegment = (globalThis as unknown as {
          __easyMediaUpdateSegment?: (segmentId: string, payload: Record<string, unknown>) => boolean
        }).__easyMediaUpdateSegment
        if (matchedTask?.id && updateSegment && images.length) {
          const done = updateSegment(String(matchedTask.id), { images })
          if (done) {
            syncedTaskIndex = Number(matchedTask.index ?? index1)
            syncedImages = images.length
          }
        }
      } catch {
        /* 同步失败不影响绑定结果，下面如实汇报 */
      }
      const flush = syncedImages > 0 ? await flushProjectToDisk() : { saved: false }
      return {
        ok: true,
        saved: Boolean((flush as { saved?: boolean }).saved),
        bound: ids.length,
        names: names.filter((resourceName) => pool.some((item) => item.name === resourceName)),
        images: images.map((item) => item.name),
        synced_to_task_track: syncedImages > 0,
        synced_task_index: syncedTaskIndex || undefined,
        synced_images: syncedImages || undefined,
        note: syncedImages > 0
          ? `已同时把 ${syncedImages} 张图片写入任务轨第 ${syncedTaskIndex} 段`
          : '该段尚未落地任务轨或没有带文件的图片；先 apply_storyboard 落轨后再绑定，或确认资源已挂文件',
      }
    }
    if (name === 'delete_task_segments') {
      const raw = Array.isArray(args.indexes) ? args.indexes.map((item) => Number(item)) : []
      const nonInteger = raw.filter((item) => !Number.isInteger(item))
      if (nonInteger.length) return { error: `段号必须是整数：${nonInteger.join('、')}` }
      const indexes = Array.from(new Set(raw.filter((item) => item >= 1))).sort((a, b) => a - b)
      if (!indexes.length) return { error: 'indexes 不能为空（段号从 1 开始）' }
      const summary = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
      const invalid = indexes.filter((index) => index > tasks.length)
      if (invalid.length) return { error: `任务轨只有 ${tasks.length} 段，段号超出：${invalid.join('、')}` }
      const detail = indexes.map((index) => ({
        index,
        stable_key: tasks[index - 1]?.stable_key ?? '',
        images: tasks[index - 1]?.images_count ?? 0,
      }))
      const dryRun = args.dry_run === true
      if (!dryRun && args.confirm !== true) return { error: '删除需要 confirm=true（可先 dry_run=true 预览）' }
      if (dryRun) return { ok: true, dry_run: true, would_delete: detail, remaining: tasks.length - indexes.length }
      const registry = (globalThis as unknown as {
        __easyMediaDeleteTaskSegments?: (list: number[]) => { deleted: string[] }
      }).__easyMediaDeleteTaskSegments
      if (!registry) return { error: '任务轨编辑器未就绪（请从多轨编辑器节点打开弹窗）' }
      // 删除前快照整份任务轨，供撤销
      const trackDataNow = (globalThis as unknown as {
        __easyMediaGetTrackData?: () => Record<string, unknown> | null
      }).__easyMediaGetTrackData?.()
      const taskTrackNow = ((trackDataNow?.tracks ?? []) as Array<Record<string, unknown>>)
        .find((track) => track.type === 'task')
      saveDeleteSnapshot({
        kind: 'task_segments',
        taskSegments: (taskTrackNow?.segments ?? []) as Array<Record<string, unknown>>,
        removedIndexes: indexes,
      })

      const result = registry(indexes)
      const flush = await flushProjectToDisk()
      return {
        ok: result.deleted.length > 0,
        deleted: detail,
        saved: flush.saved,
        save_error: flush.saved ? undefined : flush.reason,
        undo_available: true,
        note: '分镜脚本未改动；撤销用 undo_last_delete，或重新 apply_storyboard。',
      }
    }

    if (name === 'delete_segments') {
      const raw = Array.isArray(args.indexes) ? args.indexes.map((item) => Number(item)) : []
      const nonInteger = raw.filter((item) => !Number.isInteger(item))
      if (nonInteger.length) return { error: `段号必须是整数：${nonInteger.join('、')}` }
      const indexes = Array.from(new Set(raw.filter((item) => item >= 1))).sort((a, b) => a - b)
      if (!indexes.length) return { error: 'indexes 不能为空（段号从 1 开始）' }
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!planSegments.length) return { error: '当前项目没有分镜脚本' }
      const invalid = indexes.filter((index) => index > planSegments.length)
      if (invalid.length) return { error: `段号超出范围：${invalid.join('、')}（共 ${planSegments.length} 段）` }
      const removed = indexes.map((index) => ({
        index,
        name: String(planSegments[index - 1]?.name ?? ''),
        seconds: Number(planSegments[index - 1]?.duration_seconds ?? 0),
      }))
      const remaining = planSegments.filter((_, i) => !indexes.includes(i + 1))
      if (!remaining.length) return { error: '不能删空所有段；至少保留 1 段' }
      const dryRun = args.dry_run === true
      if (!dryRun && args.confirm !== true) return { error: '删除需要 confirm=true（可先 dry_run=true 预览）' }
      if (dryRun) {
        return {
          ok: true,
          dry_run: true,
          would_delete: removed,
          remaining: remaining.length,
          total_seconds_after: remaining.reduce((sum, segment) => sum + Number(segment.duration_seconds ?? 0), 0),
          note: '任务轨不受影响；如需同步请在删后 apply_storyboard。',
        }
      }

      // 重排绑定键：旧索引 → 新索引
      const oldIndexes = planSegments.map((_, i) => i + 1)
      const keptOld = oldIndexes.filter((index) => !indexes.includes(index))
      const remap = new Map<number, number>()
      keptOld.forEach((oldIndex, newIndex) => remap.set(oldIndex, newIndex))
      const bindings = (readWorkspace(projectKey).bindings ?? {}) as Record<string, string[]>
      for (const variant of ['a', 'b'] as const) {
        // 先清空所有旧键，再按新顺序写回
        for (const oldIndex of oldIndexes) {
          writeBindings(projectKey, `script-${oldIndex - 1}:${variant}`, [])
        }
        for (const [oldIndex, newIndex] of remap.entries()) {
          const ids = bindings[`script-${oldIndex - 1}:${variant}`] ?? []
          if (ids.length) writeBindings(projectKey, `script-${newIndex}:${variant}`, ids)
        }
      }

      saveDeleteSnapshot({
        kind: 'segments',
        plan: planNow,
        bindings: Object.fromEntries(
          oldIndexes.flatMap((oldIndex) => [
            [`script-${oldIndex - 1}:a`, bindings[`script-${oldIndex - 1}:a`] ?? []],
            [`script-${oldIndex - 1}:b`, bindings[`script-${oldIndex - 1}:b`] ?? []],
          ]),
        ),
        removedIndexes: indexes,
      })

      writeWorkspace(projectKey, {
        plan: {
          ...(planNow as Record<string, unknown>),
          segments: remaining,
          total_seconds: remaining.reduce((sum, segment) => sum + Number(segment.duration_seconds ?? 0), 0),
        } as never,
      })
      const flush = await flushProjectToDisk()
      return {
        ok: true,
        deleted: removed,
        remaining: remaining.length,
        saved: flush.saved,
        save_error: flush.saved ? undefined : flush.reason,
        undo_available: true,
        note: '绑定已重排；任务轨段若也需要删，请在编辑器里手动处理，或删后 apply_storyboard 覆盖。撤销用 undo_last_delete。',
      }
    }

    if (name === 'plan_assets') {
      const pool = readResources(projectKey) as ProjectResource[]
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!planSegments.length) return { error: '还没有分镜脚本，无法推导资产需求' }
      const only = Array.isArray(args.segments) ? args.segments.map((item) => Number(item)) : []
      const byId = new Map(pool.map((item) => [item.id, item]))

      const rows: Array<Record<string, unknown>> = []
      const referenced = new Map<string, number[]>()
      const missingMaterial: Array<Record<string, unknown>> = []

      for (let i = 0; i < planSegments.length; i += 1) {
        if (only.length && !only.includes(i + 1)) continue
        const segment = planSegments[i] as Record<string, unknown>
        const prompt = String(segment.promptA ?? segment.user_prompt ?? '')
        const boundIds = boundIdsForSegment(i)
        const expanded: string[] = []
        for (const id of boundIds) {
          const item = byId.get(id)
          if (!item) continue
          if (!expanded.includes(id)) expanded.push(id)
          if (item.type === 'Subject') {
            for (const childId of item.childResourceIds ?? []) {
              if (!expanded.includes(childId)) expanded.push(childId)
            }
          }
        }
        for (const id of expanded) {
          const list = referenced.get(id) ?? []
          if (!list.includes(i + 1)) list.push(i + 1)
          referenced.set(id, list)
        }
        const boundOf = (type: string): ProjectResource[] => expanded
          .map((id) => byId.get(id))
          .filter((item): item is ProjectResource => item !== undefined && item.type === type)
        const count = (kind: string) => (prompt.match(new RegExp(`<${kind} \\d+>`, 'g')) ?? []).length
        const gaps: string[] = []
        const need: string[] = []
        const check = (token: string, boundList: ProjectResource[]) => {
          const want = count(token)
          if (!want) return
          if (boundList.length < want) gaps.push(`${token} ${want} 个令牌，只绑了 ${boundList.length} 个`)
          for (const item of boundList) {
            const file = item.imageFile || item.audioFile || item.videoFile
            if (!file) need.push(`${item.type}:${item.name}（缺文件）`)
          }
        }
        check('Subject', boundOf('Subject'))
        check('Picture', boundOf('Picture'))
        check('Audio', boundOf('Audio'))
        check('Video', boundOf('Video'))
        for (const item of boundOf('Picture')) {
          const file = item.imageFile
          if (!file) missingMaterial.push({ name: item.name, type: 'Picture', segments: [i + 1], reason: '无图片文件' })
        }
        rows.push({
          segment: i + 1,
          name: String(segment.name ?? ''),
          seconds: Number(segment.duration_seconds ?? 0),
          task_type: String(((segment.settings ?? {}) as Record<string, unknown>).taskType ?? ''),
          context_mode: String(((segment.settings ?? {}) as Record<string, unknown>).contextMode ?? ''),
          tokens: {
            subject: count('Subject'),
            picture: count('Picture'),
            audio: count('Audio'),
            video: count('Video'),
          },
          bound: expanded.map((id) => {
            const item = byId.get(id)
            return item ? `${item.type}:${item.name}` : id
          }),
          gaps,
          need_material: Array.from(new Set(need)),
        })
      }

      // 汇总：需生成（被引用但没文件）/ 建议降级 / 建议合并
      const needGenerate: Array<Record<string, unknown>> = []
      for (const [id, segments] of referenced.entries()) {
        const item = byId.get(id)
        if (!item) continue
        const file = item.imageFile || item.audioFile || item.videoFile
        if (!file) {
          needGenerate.push({
            name: item.name,
            type: item.type,
            segments,
            suggestion: item.type === 'Picture' ? '生成一张基础图（空景/单体/四视图），不要按某一镜生成' : '补素材或改用其它资源',
          })
        }
      }
      const singleSegmentSubjects = Array.from(referenced.entries())
        .map(([id, segments]) => ({ item: byId.get(id), segments }))
        .filter((row) => row.item?.type === 'Subject' && row.segments.length === 1)
        .map((row) => ({ name: row.item!.name, only_segment: row.segments[0] }))
      const zeroReference = pool
        .filter((item) => !referenced.has(item.id))
        .map((item) => ({ name: item.name, type: item.type }))

      return {
        ok: true,
        read_only: true,
        rows,
        summary: {
          segments: rows.length,
          assets_referenced: referenced.size,
          need_generate: needGenerate,
          zero_reference: zeroReference,
          single_segment_subjects: singleSegmentSubjects,
          missing_material: missingMaterial,
        },
        next_actions: [
          needGenerate.length ? `需生成 ${needGenerate.length} 项：先用 generate_resource 出基础板，生成后跑 sync_task_images` : '不用生成新素材',
          singleSegmentSubjects.length ? `建议把 ${singleSegmentSubjects.length} 个单段主体降为资源（可用 delete_resources + 重新 upsert 资源）` : '主体分布正常',
          zeroReference.length ? `有 ${zeroReference.length} 个零引用资产，可删除或补绑定` : '无零引用资产',
        ],
        note: '此工具只出表，不建不删。用户确认后再执行生成/删除。',
      }
    }

    if (name === 'get_prompt_context') {
      const index = Number(args.index ?? 0)
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      const segment = planSegments[index - 1]
      if (!segment) return { error: `段 ${index} 不存在（共 ${planSegments.length} 段）` }
      const ids = boundIdsForSegment(index - 1)
      const pool = readResources(projectKey) as ProjectResource[]
      // 令牌解析走共享实现（与前端派单同一套编号，顺序 = 提交给工作流的 images 顺序）
      const resolved = resolveBoundTokens(ids, pool)
      const subjectNo = resolved.filter((entry) => entry.type === 'Subject').length
      const pictureNo = resolved.filter((entry) => entry.type === 'Picture').length
      const audioNo = resolved.filter((entry) => entry.type === 'Audio').length
      const videoNo = resolved.filter((entry) => entry.type === 'Video').length
      const childNamesOf = (subjectId: string) => resolved
        .filter((entry) => entry.via && entry.resource.type === 'Picture'
          && pool.find((item) => item.id === subjectId)?.childResourceIds?.includes(entry.id))
        .map((entry) => entry.name)
      const table: Array<Record<string, unknown>> = resolved.map((entry) => ({
        token: entry.token,
        type: entry.type,
        name: entry.name,
        status: entry.resource.status,
        file: entry.resource.imageFile ?? entry.resource.audioFile ?? entry.resource.videoFile ?? null,
        via: entry.via ?? 'direct',
        retention: entry.resource.retention ?? [],
        relationship: entry.resource.relationship ?? '',
        description: entry.resource.description ?? '',
        ...(entry.type === 'Subject' && childNamesOf(entry.id).length
          ? { source_images: childNamesOf(entry.id) }
          : {}),
      }))
      const settings = (segment.settings ?? {}) as Record<string, unknown>
      return {
        segment: index,
        name: String(segment.name ?? ''),
        duration_seconds: Number(segment.duration_seconds ?? 0),
        beat: String(segment.beat ?? ''),
        summary: String(segment.summary ?? ''),
        task_type: String(settings.taskType ?? ''),
        context_mode: String(settings.contextMode ?? ''),
        shots: Array.isArray(segment.shots) ? (segment.shots as Array<Record<string, unknown>>).map((shot) => ({
          framing: String(shot.framing ?? ''),
          action: String(shot.action ?? ''),
        })) : [],
        tokens: table,
        limits: { subject: subjectNo, picture: pictureNo, audio: audioNo, video: videoNo },
        existing: {
          prompt_a_len: String(segment.promptA ?? '').length,
          prompt_b_len: String(segment.promptB ?? '').length,
          final_a_len: String(segment.finalA ?? '').length,
          final_b_len: String(segment.finalB ?? '').length,
        },
        checklist: [
          '六段式键名：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music',
          '人物与招牌物用 <Subject n> 定义身份；场景/道具用 <Picture n>',
          `编号不得越界：Subject ≤ ${subjectNo}，Picture ≤ ${pictureNo}，Audio ≤ ${audioNo}，Video ≤ ${videoNo}`,
          '每个令牌在声明处写一次，detailed_description 只在真正要对齐的镜头点一次（总引用 ≤ 绑定数×2）',
          '每段结尾必须有：全片画面不得出现任何文字、字幕、logo 或水印叠加。',
          '台词用 <d>[Chinese] …</d>；禁止 None / N/A / undefined',
        ],
        enhancer_settings: (readWorkspace(projectKey) as { enhancerSettings?: unknown }).enhancerSettings ?? null,
        note: '这是上下文包，不是模板。按你的判断自由写，写完用 write_prompt 落库（会自动校验）。',
      }
    }

    if (name === 'write_prompt') {
      const index = Number(args.index ?? 0)
      const rawText = String(args.text ?? '')
      if (!rawText.trim()) return { error: 'text 不能为空' }
      const autoAlign = args.auto_align === true
      const alignedResult = alignTokenNumbers(index - 1, rawText)
      if (!autoAlign && alignedResult.fixes.length) {
        return {
          ok: false,
          needs_revision: true,
          problems: alignedResult.fixes.map((fix) => `${fix.from} 应为 ${fix.to}（${fix.name}）`),
          instruction: '令牌编号与本段绑定不一致。请只改编号（文字不要动），改完再调用 write_prompt 写一次；确实想按原样写入可传 auto_align=true。',
        }
      }
      const text = autoAlign ? alignedResult.text : rawText
      const variant = String(args.variant ?? 'a') === 'b' ? 'b' : 'a'
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      const segment = planSegments[index - 1]
      if (!segment) return { error: `段 ${index} 不存在` }
      const audit = auditPrompt(index - 1, text)
      const isFragmentWrite = String(args.target ?? 'final') === 'fragment'
      const errors = audit.problems.filter((item) => (
        !isFragmentWrite || /编号到|None|undefined/.test(String(item.message ?? ''))
      )).filter((item) => item.level === 'error')
      if (errors.length && args.force !== true) {
        return {
          ok: false,
          needs_revision: true,
          problems: errors.map((item) => String(item.message ?? '')),
          audit,
          instruction: '上面这些是事实性错误（编号越界/占位符/缺收尾句等）。请按提示改一次，再调用 write_prompt；确实要按原样写入可传 force=true。',
        }
      }
      const nextSegments = planSegments.map((item, i) => (
        i === index - 1
          ? {
                ...item,
                ...(String(args.target ?? 'final') === 'fragment'
                  ? (variant === 'b' ? { promptB: text } : { promptA: text })
                  : (variant === 'b' ? { finalB: text } : { finalA: text })),
              }
          : item
      ))
      writeWorkspace(projectKey, { plan: { ...(planNow as Record<string, unknown>), segments: nextSegments } as never })

      let taskWrite: Record<string, unknown> | null = null
      if (args.to_task_track === true) {
        const summary = (globalThis as unknown as {
          __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
        }).__easyMediaTimelineSummary
        const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
        const stableKey = String(segment.stable_key ?? '')
        const matched = tasks.find((task) => stableKey && String(task.stable_key ?? '') === stableKey)
          ?? tasks.find((task) => Number(task.index ?? 0) === index)
        const applyAll = (globalThis as unknown as {
          __easyMediaApplyAll?: (segmentId: string, payload: Record<string, unknown>) => boolean
        }).__easyMediaApplyAll
        if (matched?.id && applyAll) {
          const ok = applyAll(String(matched.id), { prompt: text, variant })
          taskWrite = { ok, task_index: Number(matched.index ?? index) }
        } else {
          taskWrite = { ok: false, reason: '任务轨未就绪或该段尚未落轨' }
        }
      }
      const flush = await flushProjectToDisk()
      return {
        ok: true,
        segment: index,
        variant,
        length: text.length,
        audit,
        advice: audit.problems.filter((item) => item.level === 'advice').map((item) => String(item.message ?? '')),
        aligned_tokens: alignedResult.fixes.length ? alignedResult.fixes : undefined,
        aligned_note: autoAlign && alignedResult.fixes.length
          ? `已按绑定表把 ${alignedResult.fixes.length} 处令牌编号对齐（文字未改）：` +
            alignedResult.fixes.map((f) => `${f.from}→${f.to}（${f.name}）`).join('、')
          : undefined,
        task_track: taskWrite,
        saved: flush.saved,
        note: errors.length ? '已按 force 强写，注意仍有 error。' : '已写入并通过校验。',
      }
    }

    if (name === 'retoken_prompts') {
      const only = Array.isArray(args.indexes) ? args.indexes.map(Number) : []
      const dryRun = args.dry_run !== false
      if (!dryRun && args.confirm !== true) return { error: '写回需要 confirm=true（先 dry_run 看 diff）' }
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!planSegments.length) return { error: '没有分镜脚本' }
      const pool = readResources(projectKey) as ProjectResource[]

      const report: Array<Record<string, unknown>> = []
      const nextSegments = planSegments.map((segment, i) => {
        if (only.length && !only.includes(i + 1)) return segment
        const raw = String(segment.promptA ?? segment.finalA ?? segment.user_prompt ?? '')
        if (!raw.trim()) return segment

        // 1) 当前绑定 → 新令牌表：主体按顺序 <Subject k>，图片（含主体子图）按顺序 <Picture m>
        const ids = boundIdsForSegment(i)
        const bound: ProjectResource[] = []
        for (const id of ids) {
          const item = pool.find((entry) => entry.id === id)
          if (!item) continue
          if (!bound.includes(item)) bound.push(item)
          if (item.type === 'Subject') {
            for (const childId of item.childResourceIds ?? []) {
              const child = pool.find((entry) => entry.id === childId)
              if (child && !bound.includes(child)) bound.push(child)
            }
          }
        }
        const topLevelBound: ProjectResource[] = ids
          .map((id) => pool.find((entry) => entry.id === id))
          .filter((item): item is ProjectResource => Boolean(item))
        const tokenOf = new Map<string, string>()   // resource id → <Subject k>/<Picture m>
        let subjectNo = 0
        let pictureNo = 0
        for (const item of topLevelBound) {
          if (item.type === 'Subject') { subjectNo += 1; tokenOf.set(item.id, `<Subject ${subjectNo}>`) }
          else if (item.type === 'Picture') { pictureNo += 1; tokenOf.set(item.id, `<Picture ${pictureNo}>`) }
        }

        // 2) 旧令牌 → 名称（来自 subject_definitions 的 "令牌 名称：..." 行）
        const defsBlock = raw.split(/\nsummary\s*[:：]/)[0] ?? ''
        const oldTokenToName = new Map<string, string>()
        for (const line of defsBlock.split('\n')) {
          const match = line.match(/^\s*<(?<kind>Subject|Picture|Audio|Video)\s+(?<num>\d+)>\s*(?<name>[^：:\n]{1,40}?)\s*[：:]/)
          if (!match || !match.groups) continue
          oldTokenToName.set(`<${match.groups.kind} ${match.groups.num}>`, match.groups.name.trim())
        }
        if (!oldTokenToName.size) {
          report.push({ segment: i + 1, skipped: true, reason: 'subject_definitions 里没有可解析的「令牌 名称：」行' })
          return segment
        }

        // 3) 名称 → 新令牌（按名称精确匹配绑定资源，主体优先；也允许名称是主体名+后缀）
        const nameToToken = new Map<string, string>()
        for (const item of bound) {
          const token = tokenOf.get(item.id)
          if (token) nameToToken.set(item.name, token)
        }
        const resolveNew = (name: string): string | null => {
          if (nameToToken.has(name)) return nameToToken.get(name) ?? null
          // 名称包含关系：如 "老赵四视图" → 主体/图片名 "老赵四视图"
          for (const [resourceName, token] of nameToToken.entries()) {
            if (name.includes(resourceName) || resourceName.includes(name)) return token
          }
          return null
        }

        const tokenMap = new Map<string, string | null>()  // 旧令牌 → 新令牌 / null=幽灵
        for (const [oldToken, name] of oldTokenToName.entries()) {
          tokenMap.set(oldToken, resolveNew(name))
        }

        // 4) 逐行改写 + diff
        const changes: Array<Record<string, string>> = []
        const lines = raw.split('\n').map((line) => {
          if (!line.includes('<')) return line
          let next = line
          for (const [oldToken, replacement] of tokenMap.entries()) {
            if (!next.includes(oldToken)) continue
            if (replacement) {
              next = next.split(oldToken).join(replacement)
            } else {
              // 幽灵：删掉引用括注或整条定义/保留行
              next = next.replace(new RegExp(`[（(][^）)]*${oldToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^）)]*[）)]`, 'g'), '')
              if (/^\s*[-*]?\s*$/.test(next)) next = ''
              else next = next.split(oldToken).join('')
            }
          }
          if (next !== line && next.trim()) changes.push({ before: line.slice(0, 120), after: next.slice(0, 120) })
          return next
        })
        const text = lines.filter((line, index) => line !== '' || raw.split('\n')[index] === '').join('\n')
        if (!changes.length) return segment
        report.push({ segment: i + 1, changes: changes.slice(0, 20), total_changes: changes.length })
        return dryRun ? segment : { ...segment, promptA: text }
      })

      if (!dryRun) {
        const changedCount = report.filter((row) => !row.skipped).length
        if (changedCount) {
          writeWorkspace(projectKey, { plan: { ...(planNow as Record<string, unknown>), segments: nextSegments } as never })
        }
      }
      return {
        ok: true,
        dry_run: dryRun,
        segments: report,
        note: dryRun ? '这是预览。确认后传 dry_run=false & confirm=true 写回，再跑 validate_prompts 复查。' : '已写回。请跑 validate_prompts 复查。',
      }
    }

    if (name === 'validate_prompts') {
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!planSegments.length) return { error: '没有分镜脚本' }
      const rows = planSegments.map((segment, i) => {
        const finalText = String(segment.finalA ?? segment.finalB ?? '')
        const fragmentText = String(segment.promptA ?? segment.promptB ?? segment.user_prompt ?? '')
        const isFragmentOnly = !finalText.trim()
        const prompt = isFragmentOnly ? fragmentText : finalText
        const result = auditPrompt(i, prompt, isFragmentOnly)
        return { ...result, name: String(segment.name ?? ''), length: prompt.length, mode: isFragmentOnly ? 'fragment' : 'final' }
      })
      const errors = rows.reduce((sum, row) => sum + row.problems.filter((item) => item.level === 'error').length, 0)
      const warns = rows.reduce((sum, row) => sum + row.problems.filter((item) => item.level === 'warn').length, 0)
      return { ok: errors === 0, errors, warns, rows, note: 'error 必须修，warn 建议修；修完再 validate_prompts 复查。' }
    }

    if (name === 'fix_prompts') {
      const only = Array.isArray(args.indexes) ? args.indexes.map(Number) : []
      const dryRun = args.dry_run === true
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!planSegments.length) return { error: '没有分镜脚本' }
      const changed: Array<Record<string, unknown>> = []
      const next = planSegments.map((segment, i) => {
        if (only.length && !only.includes(i + 1)) return segment
        const raw = String(segment.promptA ?? segment.finalA ?? segment.user_prompt ?? '')
        if (!raw.trim()) return segment
        let text = raw
        const actions: string[] = []
        const before = text
        text = text.replace(/(^|[^A-Za-z])(None|N\/A|undefined)([^A-Za-z]|$)/g, (_m, a, _w, b) => { actions.push('None→无'); return `${a}无${b}` })
        if (!/(禁止|不得|不要)[^\n]{0,24}(文字|字幕|logo|水印)/.test(text)) {
          text = `${text.trimEnd()}\n全片画面不得出现任何文字、字幕、logo 或水印叠加。`
          actions.push('补禁字幕句')
        }
        if (text !== before) {
          changed.push({ segment: i + 1, actions })
          return { ...segment, promptA: text }
        }
        return segment
      })
      if (!dryRun && changed.length) {
        writeWorkspace(projectKey, { plan: { ...(planNow as Record<string, unknown>), segments: next } as never })
      }
      return { ok: true, dry_run: dryRun, changed, note: '越界令牌未自动改（可能需重写对应段）。' }
    }

    if (name === 'promote_pictures_to_subject') {
      const subjectName = String(args.name ?? '').trim()
      const children = Array.isArray(args.children) ? args.children.map(String).filter(Boolean) : []
      if (!subjectName || !children.length) return { error: 'name 与 children 必填' }
      const pool = readResources(projectKey) as ProjectResource[]
      const childResources = children
        .map((childName) => pool.find((item) => item.name === childName))
        .filter((item): item is ProjectResource => Boolean(item))
      if (!childResources.length) return { error: `没找到这些图片：${children.join('、')}` }
      const existing = pool.find((item) => item.type === 'Subject' && item.name === subjectName)
      const subjectId = existing?.id ?? `res-${Date.now().toString(36)}-subj`
      const subject: ProjectResource = {
        ...(existing ?? {
          id: subjectId,
          type: 'Subject',
          name: subjectName,
          relationship: 'manual',
          description: '',
          retention: [],
          status: 'ready',
          childResourceIds: [],
          source: 'manual',
        }),
        type: 'Subject',
        name: subjectName,
        description: String(args.description ?? existing?.description ?? ''),
        retention: Array.isArray(args.retention) ? args.retention.map(String) : (existing?.retention ?? []),
        childResourceIds: Array.from(new Set([...(existing?.childResourceIds ?? []), ...childResources.map((item) => item.id)])),
        status: 'ready',
      } as unknown as ProjectResource
      // dry_run：只报告影响面
      if (args.dry_run === true) {
        const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
        const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
        const childIdsForDry = childResources.map((item) => item.id)
        const affected: Array<Record<string, unknown>> = []
        for (let i = 0; i < planSegments.length; i += 1) {
          const boundIds = boundIdsForSegment(i)
          const hit = boundIds.filter((id) => childIdsForDry.includes(id))
          if (!hit.length) continue
          const prompt = String(planSegments[i].promptA ?? planSegments[i].finalA ?? '')
          affected.push({
            segment: i + 1,
            name: String(planSegments[i].name ?? ''),
            pictures_replaced: hit.length,
            prompt_picture_tokens: (prompt.match(/<Picture \d+>/g) ?? []).length,
          })
        }
        return {
          ok: true,
          dry_run: true,
          would_create: { name: subjectName, children: childResources.map((item) => item.name) },
          affected_segments: affected,
          note: '确认后去掉 dry_run 再调用即执行；升格后建议 retoken_prompts 重排编号并重写 subject_definitions。',
        }
      }
      upsertResource(projectKey, subject)
      // 把绑定里的图片替换成主体
      const childIds = new Set(childResources.map((item) => item.id))
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const count = planNow?.segments?.length ?? 0
      const touched: number[] = []
      for (let i = 0; i < count; i += 1) {
        for (const variant of ['a', 'b'] as const) {
          const ids = readBindings(projectKey, `script-${i}:${variant}`)
          if (!ids.some((id) => childIds.has(id))) continue
          const rest = ids.filter((id) => !childIds.has(id))
          const nextIds = [subjectId, ...rest.filter((id) => id !== subjectId)]
          writeBindings(projectKey, `script-${i}:${variant}`, nextIds)
          if (!touched.includes(i + 1)) touched.push(i + 1)
        }
      }
      if (args.drop_pictures === true) {
        for (const item of childResources) removeResource(projectKey, item.id)
      }
      return {
        ok: true,
        subject: { id: subjectId, name: subjectName, children: childResources.map((item) => item.name), dropped: args.drop_pictures === true },
        rebound_segments: touched.sort((a, b) => a - b),
        note: '建议随后让助手重写这些段的 subject_definitions，把 <Picture n> 人物定义改成 <Subject n>。',
      }
    }

    if (name === 'audit_assets') {
      const pool = readResources(projectKey) as ProjectResource[]
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!pool.length) return { error: '资源池为空，没有可审计的内容' }

      // 1) 段 → 绑定资源（A+B 并集，主体展开子图）
      const byId = new Map(pool.map((item) => [item.id, item]))
      const segmentRefs: Array<{ segment: number; name: string; ids: string[] }> = []
      for (let i = 0; i < Math.max(planSegments.length, 1); i += 1) {
        const ids = boundIdsForSegment(i)
        const expanded: string[] = []
        for (const id of ids) {
          const item = byId.get(id)
          if (!item) continue
          if (!expanded.includes(id)) expanded.push(id)
          if (item.type === 'Subject') {
            for (const childId of item.childResourceIds ?? []) {
              if (!expanded.includes(childId)) expanded.push(childId)
            }
          }
        }
        segmentRefs.push({
          segment: i + 1,
          name: String(planSegments[i]?.name ?? ''),
          ids: expanded,
        })
      }

      // 2) 资源 → 引用段
      const refsOf = new Map<string, number[]>()
      for (const row of segmentRefs) {
        for (const id of row.ids) {
          const list = refsOf.get(id) ?? []
          if (!list.includes(row.segment)) list.push(row.segment)
          refsOf.set(id, list)
        }
      }

      // 3) 分类统计
      const zeroReference: Array<Record<string, unknown>> = []
      const singleSegmentSubjects: Array<Record<string, unknown>> = []
      const matrix: Array<Record<string, unknown>> = []
      for (const item of pool) {
        const segments = refsOf.get(item.id) ?? []
        matrix.push({
          name: item.name,
          type: item.type,
          status: item.status,
          segments,
          has_file: Boolean(item.imageFile || item.audioFile || item.videoFile),
        })
        if (!segments.length) {
          zeroReference.push({ name: item.name, type: item.type, status: item.status, file: item.imageFile ?? item.audioFile ?? item.videoFile ?? null })
        } else if (item.type === 'Subject' && segments.length === 1) {
          singleSegmentSubjects.push({ name: item.name, segments })
        }
      }

      // 4) 稿内令牌缺口（按类型粗算：令牌数 > 已绑定数即视为缺口）
      const tokenGaps: Array<Record<string, unknown>> = []
      for (let i = 0; i < planSegments.length; i += 1) {
        const prompt = String(planSegments[i]?.promptA ?? planSegments[i]?.user_prompt ?? '')
        const count = (kind: string) => (prompt.match(new RegExp(`<${kind} \\d+>`, 'g')) ?? []).length
        const bound = segmentRefs[i]?.ids ?? []
        const boundOf = (type: string) => bound.filter((id) => byId.get(id)?.type === type).length
        const gaps: string[] = []
        if (count('Picture') > boundOf('Picture')) gaps.push(`Picture 令牌 ${count('Picture')} > 绑定图片 ${boundOf('Picture')}`)
        if (count('Subject') > boundOf('Subject')) gaps.push(`Subject 令牌 ${count('Subject')} > 绑定主体 ${boundOf('Subject')}`)
        if (count('Audio') > boundOf('Audio')) gaps.push(`Audio 令牌 ${count('Audio')} > 绑定音频 ${boundOf('Audio')}`)
        if (count('Video') > boundOf('Video')) gaps.push(`Video 令牌 ${count('Video')} > 绑定视频 ${boundOf('Video')}`)
        if (gaps.length) tokenGaps.push({ segment: i + 1, name: String(planSegments[i]?.name ?? ''), gaps })
      }

      // 5) 疑似重复命名（去掉常见后缀/型号词后比较）
      const stem = (name: string) => String(name)
        .replace(/\.(png|jpe?g|webp|mp4|wav|mp3)$/i, '')
        .replace(/[_\-\s]?\d{6,}.*$/, '')
        .replace(/(四视图|三视图|空景|参考图|参考|单体图|白底图|特写|全景图)/g, '')
        .replace(/[（(].*?[)）]/g, '')
        .trim()
      const groups = new Map<string, string[]>()
      for (const item of pool) {
        const key = stem(item.name)
        if (!key) continue
        groups.set(key, [...(groups.get(key) ?? []), item.name])
      }
      const duplicates = Array.from(groups.entries())
        .filter(([, names]) => names.length > 1)
        .map(([key, names]) => ({ stem: key, names }))

      const subjects = pool.filter((item) => item.type === 'Subject')
      const pictures = pool.filter((item) => item.type === 'Picture')
      return {
        ok: true,
        totals: {
          subjects: subjects.length,
          pictures: pictures.length,
          audio: pool.filter((item) => item.type === 'Audio').length,
          video: pool.filter((item) => item.type === 'Video').length,
          segments: planSegments.length,
        },
        zero_reference: zeroReference,
        single_segment_subjects: singleSegmentSubjects,
        token_gaps: tokenGaps,
        duplicate_names: duplicates,
        matrix,
        suggestions: {
          demote_to_resource: singleSegmentSubjects.map((row) => row.name),
          delete_or_bind: zeroReference.map((row) => row.name),
          merge_candidates: duplicates.map((row) => row.names),
        },
        note: '只读审计。零引用资产是"泛滥"的主要来源；只在 1 段出现的主体建议降为资源。改完再跑一次对比。',
      }
    }

    if (name === 'inspect_images') {
      const pool = readResources(projectKey) as ProjectResource[]
      const explicit = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : []
      const names = Array.isArray(args.names) ? args.names.map(String).filter(Boolean) : []
      const files: Array<{ name: string; subfolder?: string; root?: string }> = []
      for (const item of explicit) {
        const fileName = String(item.name ?? '').trim()
        if (!fileName) continue
        files.push({
          name: fileName,
          subfolder: String(item.subfolder ?? ''),
          root: String(item.root ?? 'output'),
        })
      }
      if (!files.length && names.length) {
        for (const resourceName of names) {
          const resource = pool.find((entry) => entry.name === resourceName && entry.type === 'Picture')
            ?? pool.find((entry) => entry.name === resourceName)
          const fileName = String(resource?.imageFile ?? resourceName).trim()
          if (!fileName) continue
          files.push({
            name: fileName,
            subfolder: String(resource?.subfolder ?? ''),
            root: resource?.sharedRoot === 'input' ? 'input' : resource?.sharedRoot === 'temp' ? 'temp' : 'output',
          })
        }
      }
      if (!files.length) return { error: '请给 names（资源名/文件名）或 files' }
      const response = await fetch('/easy-media/agent/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: files.slice(0, 6),
          question: String(args.question ?? ''),
          prompt_hint: String(args.prompt_hint ?? ''),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) {
        return { error: String(data?.error || `读图失败（HTTP ${response.status}）`), missing: data?.missing }
      }
      return {
        ok: true,
        model: `${data.label || data.provider} / ${data.model}`,
        read: data.read,
        description: String(data.text ?? ''),
        missing: data.missing?.length ? data.missing : undefined,
      }
    }

    if (name === 'undo_last_delete') {
      const workspaceNow = readWorkspace(projectKey) as {
        deleteHistory?: Array<Record<string, unknown>>
        lastDelete?: Record<string, unknown>
      }
      const stack = [...(workspaceNow.deleteHistory ?? [])]
      const snapshot = stack.length ? stack[stack.length - 1] : workspaceNow.lastDelete
      if (!snapshot) return { error: '没有可撤销的删除记录' }
      const popSnapshot = () => {
        stack.pop()
        writeWorkspace(projectKey, {
          deleteHistory: stack,
          lastDelete: stack.length ? stack[stack.length - 1] : undefined,
        } as never)
      }
      const kind = String(snapshot.kind ?? '')
      if (kind === 'resources') {
        const resources = (snapshot.resources ?? []) as ProjectResource[]
        for (const item of resources) upsertResource(projectKey, item)
        const bindings = (snapshot.bindings ?? {}) as Record<string, string[]>
        for (const [key, ids] of Object.entries(bindings)) writeBindings(projectKey, key, ids ?? [])
        const links = (snapshot.subjectLinks ?? []) as Array<{ id: string; childResourceIds: string[] }>
        for (const link of links) patchResource(projectKey, link.id, { childResourceIds: link.childResourceIds } as never)
        popSnapshot()
        return {
          ok: true,
          restored: resources.map((item) => ({ name: item.name, type: item.type })),
          rebound_segments: Object.keys(bindings),
          relinked_subjects: links.map((link) => link.id),
          remaining_undo: stack.length,
          note: '任务轨里被清掉的 images 需要 sync_task_images 重新写入。',
        }
      }
      if (kind === 'segments') {
        const plan = snapshot.plan as Record<string, unknown> | null
        if (!plan) return { error: '快照缺少分镜数据，无法撤销' }
        writeWorkspace(projectKey, { plan: plan as never })
        const bindings = (snapshot.bindings ?? {}) as Record<string, string[]>
        for (const [key, ids] of Object.entries(bindings)) writeBindings(projectKey, key, ids ?? [])
        popSnapshot()
        const segments = (plan.segments ?? []) as unknown[]
        return { ok: true, restored_segments: segments.length, rebound: Object.keys(bindings), remaining_undo: stack.length }
      }
      if (kind === 'task_segments') {
        const segments = (snapshot.taskSegments ?? []) as unknown[]
        const registry = (globalThis as unknown as {
          __easyMediaSetTaskTrackSegments?: (list: never[]) => boolean
        }).__easyMediaSetTaskTrackSegments
        if (!registry) return { error: '任务轨编辑器未就绪，无法恢复' }
        const done = registry(segments as never[])
        if (!done) return { error: '恢复失败：任务轨不存在' }
        popSnapshot()
        const flush = await flushProjectToDisk()
        return { ok: true, restored_segments: segments.length, saved: flush.saved, remaining_undo: stack.length }
      }
      return { error: `不支持撤销删除类型：${kind || '未知'}` }
    }

    if (name === 'delete_resources') {
      const names = Array.isArray(args.names) ? args.names.map(String).filter(Boolean) : []
      if (!names.length) return { error: 'names 不能为空' }
      const dryRun = args.dry_run === true
      if (!dryRun && args.confirm !== true) return { error: '删除需要 confirm=true（可先 dry_run=true 预览）' }
      const pool = readResources(projectKey) as ProjectResource[]
      // 同名跨类型（Subject / Picture 等）拒绝，避免误删
      const ambiguous = names
        .map((name) => ({ name, types: Array.from(new Set(pool.filter((item) => item.name === name).map((item) => item.type))) }))
        .filter((entry) => entry.types.length > 1)
      if (ambiguous.length) {
        return {
          error: '存在同名但不同类型的条目，请先说清删哪一种（本工具按名称删除，无法区分）',
          ambiguous: ambiguous.map((entry) => ({ name: entry.name, types: entry.types })),
        }
      }
      const targets = pool.filter((item) => names.includes(item.name))
      const missing = names.filter((name) => !pool.some((item) => item.name === name))
      if (!targets.length) return { error: `没有找到：${names.join('、')}`, missing }

      const targetIds = new Set(targets.map((item) => item.id))
      // 会被解绑的段
      const bindings = (readWorkspace(projectKey).bindings ?? {}) as Record<string, string[]>
      const affectedBindings: Array<Record<string, unknown>> = []
      for (const [key, ids] of Object.entries(bindings)) {
        const kept = (ids ?? []).filter((id) => !targetIds.has(String(id)))
        if (kept.length !== (ids ?? []).length) affectedBindings.push({ binding: key, removed: (ids ?? []).length - kept.length })
      }
      // 会被摘掉子图的主体
      const affectedSubjects = pool
        .filter((item) => item.type === 'Subject' && (item.childResourceIds ?? []).some((id) => targetIds.has(id)))
        .map((item) => item.name)
      // 令牌错位警告：解绑后段内 <Picture n>/<Subject n> 编号会重排
      const planForTokens = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const tokenWarnings: Array<Record<string, unknown>> = []
      for (const row of affectedBindings) {
        const key = String(row.binding)
        const match = key.match(/^script-(\d+):/)
        const index = match ? Number(match[1]) : -1
        if (index < 0) continue
        const segment = planForTokens?.segments?.[index] as Record<string, unknown> | undefined
        const prompt = String(segment?.promptA ?? segment?.user_prompt ?? '')
        const tokens = Array.from(new Set(prompt.match(/<(?:Subject|Picture|Audio|Video) \d+>/g) ?? []))
        if (tokens.length) {
          tokenWarnings.push({
            segment: index + 1,
            binding: key,
            tokens,
            warning: '解绑后该段令牌编号会重排，稿内旧编号可能指向别的资源，需要重新生成或校对提示词',
          })
        }
      }

      if (dryRun) {
        return {
          ok: true,
          dry_run: true,
          would_delete: targets.map((item) => ({ name: item.name, type: item.type, status: item.status, file: item.imageFile ?? item.audioFile ?? item.videoFile ?? null })),
          would_unbind_from: affectedBindings,
          would_remove_from_subjects: affectedSubjects,
          token_warnings: tokenWarnings,
          persisted_in: '浏览器 localStorage（与资源池一致；刷新不丢，换浏览器/清缓存会丢）',
          missing,
        }
      }

      // 0) 删除前快照（供撤销）
      saveDeleteSnapshot({
        kind: 'resources',
        resources: targets.map((item) => ({ ...item })),
        bindings: Object.fromEntries(affectedBindings.map((row) => [String(row.binding), bindings[String(row.binding)] ?? []])),
        subjectLinks: pool
          .filter((item) => item.type === 'Subject' && (item.childResourceIds ?? []).some((id) => targetIds.has(id)))
          .map((item) => ({ id: item.id, childResourceIds: [...(item.childResourceIds ?? [])] })),
      })

      // 1) 从主体子图关联里摘除
      for (const subject of pool.filter((item) => item.type === 'Subject')) {
        const next = (subject.childResourceIds ?? []).filter((id) => !targetIds.has(id))
        if (next.length !== (subject.childResourceIds ?? []).length) {
          patchResource(projectKey, subject.id, { childResourceIds: next } as never)
        }
      }
      // 2) 解绑所有段的 A/B 清单
      for (const [key, ids] of Object.entries(bindings)) {
        const kept = (ids ?? []).filter((id) => !targetIds.has(String(id)))
        if (kept.length !== (ids ?? []).length) writeBindings(projectKey, key, kept)
      }
      // 3) 删除资源本身
      for (const item of targets) removeResource(projectKey, item.id)

      const flush = await flushProjectToDisk()
      return {
        ok: true,
        deleted: targets.map((item) => ({ name: item.name, type: item.type })),
        unbound_from: affectedBindings,
        removed_from_subjects: affectedSubjects,
        token_warnings: tokenWarnings,
        missing,
        timeline_saved: flush.saved,
        persisted_in: '浏览器 localStorage（资源池不在 timeline.json 里）',
        undo_available: true,
        note: '任务轨已写入的 images 不会自动清除；如需同步请再执行 sync_task_images。撤销用 undo_last_delete。',
      }
    }

    if (name === 'explain_task_modes') {
      return {
        modes: Object.values(TASK_MODE_SPECS).map((spec) => ({
          task_mode: spec.key,
          label: spec.label,
          resolves_to: spec.resolvesTo,
          images: `${spec.images.min}–${spec.images.max}`,
          video: `${spec.video.min}–${spec.video.max}`,
          audio: `${spec.audio.min}–${spec.audio.max}`,
          hint: spec.hint,
        })),
        note: '绑定超过上限会被拒绝；任务类型选错会导致素材被忽略（例如 T2V 只用首帧甚至不用图）。',
      }
    }

    if (name === 'set_task_modes') {
      const items = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : []
      if (!items.length) return { error: 'items 不能为空' }
      const validModes = new Set(['default', 'ref', 'l2v', 'edit', 'passthrough'])
      const planNow = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (planNow?.segments ?? []) as Array<Record<string, unknown>>
      if (!planSegments.length) return { error: '当前项目没有分镜脚本' }
      const summary = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
      const updateSegment = (globalThis as unknown as {
        __easyMediaUpdateSegment?: (segmentId: string, payload: Record<string, unknown>) => boolean
      }).__easyMediaUpdateSegment

      const applied: Array<Record<string, unknown>> = []
      const rejected: Array<Record<string, unknown>> = []
      const modePatches: Array<{ segmentId: string; taskMode?: string; continuityMode?: string }> = []
      const nextSegments = planSegments.map((segment, i) => {
        const hit = items.find((item) => Number(item.index ?? 0) === i + 1)
        if (!hit) return segment
        const mode = String(hit.task_mode ?? '').toLowerCase()
        if (!validModes.has(mode)) {
          rejected.push({ index: i + 1, task_mode: mode, reason: '非法模式' })
          return segment
        }
        const taskTypeByMode: Record<string, string> = { ref: 'r2v', l2v: 'l2v', edit: 'vi2v', default: 't2v', passthrough: 'passthrough' }
        const taskType = taskTypeByMode[mode] ?? ''
        const contextMode = String(hit.context_mode ?? '').toLowerCase()
        const validContext = ['shot', 'context', 'context_drift'].includes(contextMode) ? contextMode : ''
        const existingImages = imagesFromBoundIds(boundIdsForSegment(i)).length
        const compat = checkTaskModeAssets(mode, { images: existingImages, video: 0, audio: 0 })
        applied.push({
          index: i + 1,
          task_mode: mode,
          task_type: taskType,
          context_mode: validContext || undefined,
          reason: String(hit.reason ?? ''),
          images_bound: existingImages,
          asset_ok: compat.ok,
          asset_problems: compat.problems.length ? compat.problems : undefined,
        })
        // 同步写任务轨（若已落轨）
        const stableKey = String(segment.stable_key ?? '')
        const matched = tasks.find((task) => stableKey && String(task.stable_key ?? '') === stableKey)
          ?? tasks.find((task) => Number(task.index ?? 0) === i + 1)
        if (matched?.id) {
          modePatches.push({
            segmentId: String(matched.id),
            taskMode: mode,
            ...(validContext ? { continuityMode: validContext } : {}),
          })
        }
        const nextSettings: Record<string, unknown> = { ...((segment.settings ?? {}) as Record<string, unknown>), taskType }
        if (validContext) nextSettings.contextMode = validContext
        return { ...segment, settings: nextSettings }
      })
      // 一次性批量写任务轨（逐段单次提交会互相覆盖，只剩最后一段）
      if (modePatches.length) {
        const bulk = (globalThis as unknown as {
          __easyMediaUpdateSegmentModes?: (items: typeof modePatches) => boolean
        }).__easyMediaUpdateSegmentModes
        if (bulk) bulk(modePatches)
        else if (updateSegment) for (const patch of modePatches) {
          updateSegment(patch.segmentId, {
            taskMode: patch.taskMode,
            ...(patch.continuityMode ? { continuityMode: patch.continuityMode } : {}),
          })
        }
      }
      writeWorkspace(projectKey, { plan: { ...(planNow as Record<string, unknown>), segments: nextSegments } as never })
      const flush = await flushProjectToDisk()
      return { ok: applied.length > 0, applied, rejected, task_track_updated: modePatches.length, saved: flush.saved, save_error: flush.saved ? undefined : flush.reason }
    }

    if (name === 'dump_state') {
      const plan = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (plan?.segments ?? []) as Array<Record<string, unknown>>
      const pool = readResources(projectKey) as ProjectResource[]
      const summary = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
      const bindings: Array<Record<string, unknown>> = []
      for (let i = 0; i < planSegments.length; i += 1) {
        bindings.push({
          index: i + 1,
          name: String(planSegments[i].name ?? ''),
          stable_key: String(planSegments[i].stable_key ?? ''),
          a: readBindings(projectKey, `script-${i}:a`),
          b: readBindings(projectKey, `script-${i}:b`),
        })
      }
      const dump = {
        project: projectKey,
        saved_at: new Date().toISOString(),
        bindings,
        resources: pool.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          status: item.status,
          imageFile: item.imageFile,
          subfolder: item.subfolder,
          sharedRoot: item.sharedRoot,
          children: item.childResourceIds ?? [],
        })),
        tasks,
      }
      const response = await fetch('/easy-media/debug/dump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dump),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) return { error: String(data?.error || `导出失败（HTTP ${response.status}）`) }
      return {
        ok: true,
        path: data.path,
        segments: bindings.length,
        bound_a: bindings.filter((row) => (row.a as string[]).length).length,
        bound_b: bindings.filter((row) => (row.b as string[]).length).length,
        resources: pool.length,
        tasks: tasks.length,
      }
    }

    if (name === 'list_bindings') {
      const plan = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = (plan?.segments ?? []) as Array<Record<string, unknown>>
      const pool = readResources(projectKey) as ProjectResource[]
      const summary = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
      const rows = planSegments.map((segment, i) => {
        const stableKey = String(segment.stable_key ?? '')
        const ids = boundIdsForSegment(i)
        const names = ids.map((id) => pool.find((item) => item.id === id)?.name ?? id)
        const images = imagesFromBoundIds(ids)
        const prompt = String(segment.promptA ?? segment.user_prompt ?? '')
        const tokens = Array.from(new Set((prompt.match(/<(?:Subject|Picture|Audio|Video) \d+>/g) ?? [])))
        const task = tasks.find((entry) => stableKey && String(entry.stable_key ?? '') === stableKey)
          ?? tasks.find((entry) => Number(entry.index ?? 0) === i + 1)
        const imagesAll = imagesFromBoundIds(ids)
        const modeNow = String(((segment.settings ?? {}) as Record<string, unknown>).taskType ?? '').trim().toLowerCase()
        const modeKey2 = modeNow.includes('l2v') ? 'l2v' : modeNow.includes('r2v') || modeNow.includes('ref') ? 'ref' : modeNow.includes('vi2v') || modeNow.includes('edit') ? 'edit' : 'default'
        const check = checkTaskModeAssets(modeKey2, { images: imagesAll.length, video: 0, audio: 0 })
        return {
          index: i + 1,
          name: String(segment.name ?? ''),
          task_mode: modeKey2,
          asset_check: { ok: check.ok, problems: check.problems, hint: check.spec.hint },
          bound: names,
          bound_images: images.map((item) => item.name),
          tokens_in_prompt: tokens,
          landed_on_task_track: Boolean(task?.id),
          task_images_count: Number(task?.images_count ?? 0),
        }
      })
      return {
        total: rows.length,
        rows,
        note: '如果 bound_images 为空而 tokens_in_prompt 里有 <Picture n>，说明该段只写了令牌但没绑定资源，需要 bind_resources 绑定后才能出图。',
      }
    }

    if (name === 'repair_task_images') {
      const onlyIndex = Number(args.index ?? 0)
      const plan = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = plan?.segments ?? []
      const pool = readResources(projectKey) as ProjectResource[]
      const summary = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
      const updateSegment = (globalThis as unknown as {
        __easyMediaUpdateSegment?: (segmentId: string, payload: Record<string, unknown>) => boolean
      }).__easyMediaUpdateSegment

      // 1) 收集所有被绑定的图片资源
      const usedIds = new Set<string>()
      for (let i = 0; i < planSegments.length; i += 1) {
        if (onlyIndex && onlyIndex !== i + 1) continue
        for (const id of boundIdsForSegment(i)) usedIds.add(String(id))
      }
      const pictures = pool.filter((item) => item.type === 'Picture' && usedIds.has(item.id) && String(item.imageFile ?? '').trim())
      if (!pictures.length) return { error: '没有带文件的已绑定图片资源' }

      // 2) 批量校验存在性
      const verifyResponse = await fetch('/easy-media/media/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: pictures.map((item) => ({
            root: item.sharedRoot === 'input' ? 'input' : item.sharedRoot === 'temp' ? 'temp' : 'output',
            subfolder: item.subfolder ?? '',
            name: String(item.imageFile ?? ''),
          })),
        }),
      })
      const verifyData = await verifyResponse.json().catch(() => ({}))
      const results = Array.isArray(verifyData?.results) ? verifyData.results : []
      const fixed: Array<Record<string, unknown>> = []
      const missing: Array<Record<string, unknown>> = []
      results.forEach((row: Record<string, unknown>, i: number) => {
        const resource = pictures[i]
        const requested = (row.requested ?? {}) as Record<string, unknown>
        const resolved = row.resolved as Record<string, unknown> | null
        if (!resource) return
        if (!resolved) {
          missing.push({ name: resource.name, file: String(resource.imageFile ?? ''), search_root: requested.root })
          return
        }
        const nextName = String(resolved.name ?? '')
        const nextSub = String(resolved.subfolder ?? '')
        const nextRoot = String(resolved.root ?? 'output')
        if (row.exists && nextSub === String(resource.subfolder ?? '') && nextRoot === String(resource.sharedRoot ?? 'output')) return
        patchResource(projectKey, resource.id, {
          imageFile: nextName,
          subfolder: nextSub,
          sharedRoot: nextRoot === 'input' ? 'input' : nextRoot === 'temp' ? 'temp' : 'output',
          status: 'ready',
        } as never)
        fixed.push({ resource: resource.name, from: String(resource.imageFile ?? ''), to: nextName })
      })

      // 3) 修复后重新同步任务轨（批量单次提交）
      let synced = 0
      if (updateSegment) {
        const patches: Array<{ segmentId: string; images: Array<{ name: string; subfolder?: string; sourceType?: 'input' | 'output' | 'temp' }> }> = []
        for (let i = 0; i < planSegments.length; i += 1) {
          if (onlyIndex && onlyIndex !== i + 1) continue
          const stableKey = String((planSegments[i] as Record<string, unknown>).stable_key ?? '')
          const matched = tasks.find((task) => stableKey && String(task.stable_key ?? '') === stableKey)
            ?? tasks.find((task) => Number(task.index ?? 0) === i + 1)
          if (!matched?.id) continue
          const images = imagesFromBoundIds(boundIdsForSegment(i))
          if (!images.length) continue
          patches.push({ segmentId: String(matched.id), images })
        }
        if (patches.length) {
          const bulkUpdate = (globalThis as unknown as {
            __easyMediaUpdateSegments?: (items: typeof patches) => boolean
          }).__easyMediaUpdateSegments
          const done = bulkUpdate ? bulkUpdate(patches) : patches.every((patch) => updateSegment(patch.segmentId, { images: patch.images }))
          if (done) synced = patches.length
        }
      }

      const perSegment = planSegments.map((_, i) => {
        if (onlyIndex && onlyIndex !== i + 1) return null
        const ids = boundIdsForSegment(i)
        const imgs = imagesFromBoundIds(ids)
        return {
          index: i + 1,
          bound_count: ids.length,
          images: imgs.map((item) => item.name),
        }
      }).filter(Boolean)
      const flush = await flushProjectToDisk()
      return {
        ok: fixed.length > 0 || synced > 0,
        saved: flush.saved,
        saved_updated_at: flush.saved ? flush.updated_at : undefined,
        save_error: flush.saved ? undefined : flush.reason,
        checked: pictures.length,
        fixed,
        missing,
        per_segment: perSegment,
        synced_segments: synced,
        note: missing.length
          ? '有文件确实不存在（可能已被清理），需要重新生成或手动指定'
          : '全部图片文件均存在且已与任务轨同步',
      }
    }

    if (name === 'sync_task_images') {
      const onlyIndex = Number(args.index ?? 0)
      const plan = readPlan() as { segments?: Array<Record<string, unknown>> } | null
      const planSegments = plan?.segments ?? []
      const summary = (globalThis as unknown as {
        __easyMediaTimelineSummary?: () => { tasks?: Array<Record<string, unknown>> }
      }).__easyMediaTimelineSummary
      const tasks = (summary?.().tasks ?? []) as Array<Record<string, unknown>>
      const updateSegment = (globalThis as unknown as {
        __easyMediaUpdateSegment?: (segmentId: string, payload: Record<string, unknown>) => boolean
      }).__easyMediaUpdateSegment
      if (!updateSegment) return { error: '任务轨编辑器未就绪，无法同步' }
      const bulkUpdate = (globalThis as unknown as {
        __easyMediaUpdateSegments?: (items: Array<{ segmentId: string; images: Array<{ name: string; subfolder?: string; sourceType?: 'input' | 'output' | 'temp' }> }>) => boolean
      }).__easyMediaUpdateSegments
      const results: Array<Record<string, unknown>> = []
      const patches: Array<{ segmentId: string; images: Array<{ name: string; subfolder?: string; sourceType?: 'input' | 'output' | 'temp' }> }> = []
      for (let i = 0; i < planSegments.length; i += 1) {
        if (onlyIndex && onlyIndex !== i + 1) continue
        const stableKey = String((planSegments[i] as Record<string, unknown>).stable_key ?? '')
        const matched = tasks.find((task) => stableKey && String(task.stable_key ?? '') === stableKey)
          ?? tasks.find((task) => Number(task.index ?? 0) === i + 1)
        if (!matched?.id) {
          results.push({ index: i + 1, ok: false, reason: '该段未落地任务轨' })
          continue
        }
        const images = imagesFromBoundIds(boundIdsForSegment(i))
        if (!images.length) {
          results.push({ index: i + 1, ok: false, reason: '无已绑定且带文件的图片' })
          continue
        }
        patches.push({ segmentId: String(matched.id), images })
        results.push({ index: i + 1, ok: true, images: images.map((item) => item.name) })
      }
      // 所有段一次性提交：多次单段提交会互相覆盖（只留最后一段）
      if (patches.length) {
        if (bulkUpdate) bulkUpdate(patches)
        else for (const patch of patches) updateSegment(patch.segmentId, { images: patch.images })
      }
      const synced = results.filter((item) => item.ok).length
      const flush = synced > 0 ? await flushProjectToDisk() : { saved: false, reason: '没有可写入的段' }
      return {
        ok: synced > 0,
        synced_segments: synced,
        saved: flush.saved,
        save_error: flush.saved ? undefined : (flush as { reason?: string }).reason,
        detail: results,
      }
    }

    if (name === 'generate_prompt') {
      const index1 = Number(args.index ?? 0)
      const segment = segments[index1 - 1]
      if (!segment) return { error: `段 ${index1} 不存在` }
      const variant = String(args.variant ?? 'a') === 'b' ? 'b' : 'a'
      // 分镜脚本才是 A/B 稿的真源；任务轨只是落地结果
      const planForPrompt = readPlan() as (StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) | null
      const scriptSegment = (planForPrompt?.segments?.[index1 - 1] ?? {}) as Record<string, unknown>
      const scriptText = (key: string) => String(scriptSegment[key] ?? '').trim()
      const shotLines = Array.isArray(scriptSegment.shots)
        ? (scriptSegment.shots as Array<Record<string, unknown>>).map((shot, i) =>
            `镜头${i + 1} ${String(shot.framing ?? '')}：${String(shot.action ?? '')}`.trim())
        : []
      const compositeBrief = [
        String(scriptSegment.summary ?? '').trim(),
        String(scriptSegment.beat ?? '').trim(),
        ...shotLines,
        String(scriptSegment.director_note ?? '').trim(),
      ].filter(Boolean).join('\n')
      const sourcePrompt = (
        (variant === 'b' ? scriptText('promptB') : scriptText('promptA'))
        || scriptText('promptA')
        || scriptText('promptB')
        || String(scriptSegment.user_prompt ?? '').trim()
        || String((segment as Record<string, unknown>).user_prompt ?? '').trim()
        || compositeBrief
      ).trim()
      if (!sourcePrompt) return { error: `段 ${index1} 没有可用的 A/B 稿，也没有 summary/beat/镜头表，无法生成提示词` }
      const settings = { ...((segment.settings ?? {}) as Record<string, unknown>), ...((scriptSegment.settings ?? {}) as Record<string, unknown>) }
      const planSettings = ((readPlan() as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
      let rawTaskLabel = String(settings.taskType ?? planSettings.taskType ?? '').trim()
      let mapped = taskTemplate(rawTaskLabel)
      const duration = Number(scriptSegment.duration_seconds ?? segment.duration_seconds ?? 0) || 6
      // 令牌契约与④界面同源：按本段绑定顺序编号（主体展开子图，图片/音频/视频各自从 1 编号）
      const pool = readResources(projectKey) as ProjectResource[]
      const boundIds = readBindings(projectKey, `script-${index1}:${variant}`)
      const subjectList: Array<Record<string, unknown>> = []
      const pictures: Array<{ token: string; name: string }> = []
      const audios: Array<{ token: string; name: string }> = []
      const videos: Array<{ token: string; name: string }> = []
      const images: string[] = []
      let subjectNo = 0
      let pictureNo = 0
      let audioNo = 0
      let videoNo = 0
      for (const id of boundIds) {
        const resource = pool.find((item) => item.id === id)
        if (!resource) continue
        const type = String(resource.type || '').toLowerCase()
        if (type === 'subject') {
          subjectNo += 1
          subjectList.push({
            token: `<Subject ${subjectNo}>`,
            name: resource.name,
            description: resource.description ?? '',
            retention: resource.retention ?? [],
          })
          for (const childId of resource.childResourceIds ?? []) {
            const child = pool.find((item) => item.id === childId)
            if (!child) continue
            // 主体子图只作为上传素材（身份来源），不再单独占用 <Picture n> 编号
            const file = child.imageFile || child.sharedPath || ''
            if (file) images.push(file)
          }
        } else if (type === 'picture' || type === 'image') {
          pictureNo += 1
          pictures.push({ token: `<Picture ${pictureNo}>`, name: resource.name })
          const file = resource.imageFile || resource.sharedPath || ''
          if (file) images.push(file)
        } else if (type === 'audio') {
          audioNo += 1
          audios.push({ token: `<Audio ${audioNo}>`, name: resource.name })
        } else if (type === 'video') {
          videoNo += 1
          videos.push({ token: `<Video ${videoNo}>`, name: resource.name })
        }
      }
      // 名称 → 令牌：A 稿里写「老赵」也能落成 <Subject 1>
      const nameToToken = new Map<string, string>()
      for (const entry of subjectList) {
        nameToToken.set(String(entry.name ?? ''), String(entry.token ?? ''))
      }
      for (const entry of [...pictures, ...audios, ...videos]) {
        nameToToken.set(entry.name, entry.token)
      }
      let materializedBrief = sourcePrompt
      for (const [name, token] of [...nameToToken.entries()].sort((a, b) => b[0].length - a[0].length)) {
        if (!name.trim() || !token) continue
        materializedBrief = materializedBrief.split(`〔${name}〕`).join(token)
        materializedBrief = materializedBrief.split(name).join(token)
      }
      if (!rawTaskLabel) {
        // 有参考素材 → 默认参考生视频（六段式），否则才走纯文生视频
        rawTaskLabel = subjectList.length || pictures.length || audios.length || videos.length ? 'R2V' : ''
        mapped = taskTemplate(rawTaskLabel)
      }
      const response = await fetch('/easy-media/prompt-studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: materializedBrief,
          options: { ...mapped, duration_seconds: duration, output_language: String(args.language ?? '中文'), task_label: String(settings.taskType ?? '') },
          task_type: mapped.task_type,
          task_mode: mapped.task_mode,
          duration_seconds: duration,
          language: String(args.language ?? '中文'),
          subjects: subjectList,
          bindings: { pictures, audio: audios, video: videos },
          images,
          picture_count: pictureNo || null,
          audio_count: audioNo || null,
          video_count: videoNo || null,
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
      // 落轨前置校验：令牌越界/占位符直接拦下，避免脏提示词进任务轨
      {
        const planForGate = readPlan() as { segments?: Array<Record<string, unknown>> } | null
        const gateSegments = (planForGate?.segments ?? []) as Array<Record<string, unknown>>
        const gateErrors: Array<Record<string, unknown>> = []
        for (let i = 0; i < gateSegments.length; i += 1) {
          const prompt = String(gateSegments[i].promptA ?? gateSegments[i].finalA ?? gateSegments[i].user_prompt ?? '')
          if (!prompt.trim()) continue
          const result = auditPrompt(i, prompt)
          const errors = result.problems.filter((item) => item.level === 'error')
          if (errors.length) gateErrors.push({ segment: i + 1, errors })
        }
        if (gateErrors.length && args.force !== true) {
          return {
            error: '提示词未通过校验，已拒绝落轨（修好后重试，或传 force=true 强制）',
            segments: gateErrors,
            hint: '先跑 validate_prompts 看全部问题；fix_prompts 可自动修 None/缺禁字幕句；越界令牌需要重写对应段。',
          }
        }
      }
      const planCurrent = readWorkspace(projectKey).plan as (StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) | null
      if (!planCurrent || !(planCurrent.segments ?? []).length) return { error: '当前没有可应用的分镜脚本' }
      const applyTracks = (globalThis as unknown as { __easyMediaApplyStoryboard?: (items: unknown) => boolean }).__easyMediaApplyStoryboard
      const fps = frameRate || 24
      // 注册表需要的是映射后的数组（name / durationFrames / brief / prompt / taskMode…）
      const mappedItems = (planCurrent.segments ?? []).map((segment, i) => {
        const settings = (segment.settings ?? {}) as Record<string, unknown>
        const duration = Number(segment.duration_seconds ?? 0) || 4
        return {
          name: String(segment.name ?? `段 ${i + 1}`),
          durationFrames: Number(segment.duration_frames ?? Math.round(duration * fps)) || Math.round(duration * fps),
          brief: formatPlanSegmentBrief(segment as never),
          prompt: String(segment.finalA ?? segment.promptA ?? (segment as Record<string, unknown>).user_prompt ?? ''),
          taskMode: (settings.taskType as string | undefined) || undefined,
          continuityMode: (settings.contextMode as string | undefined) || undefined,
          refImageSize: (settings.refImageSize as string | undefined) || undefined,
          stableKey: String((segment as Record<string, unknown>).stable_key ?? `sk-${i + 1}`),
          images: imagesFromBoundIds(boundIdsForSegment(i)),
        }
      })
      if (!mappedItems.length) return { error: '分镜脚本没有段可应用' }
      // 优先走注册表（编辑器层，真正写任务轨）
      if (applyTracks) {
        try {
          if (applyTracks(mappedItems)) {
            return { ok: true, applied: true, segments: mappedItems.length, via: 'registry' }
          }
        } catch (error) {
          return { error: `应用失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      // 兜底：走组件传入的 onApplyPlan（④ 页签不传，跳过）
      if (onApplyPlan) {
        try {
          if (onApplyPlan(planCurrent)) return { ok: true, applied: true, segments: mappedItems.length, via: 'plan' }
        } catch {
          /* 继续尝试数组形状 */
        }
        try {
          if (onApplyPlan(mappedItems as never)) return { ok: true, applied: true, segments: mappedItems.length, via: 'items' }
        } catch {
          /* 落到错误分支 */
        }
      }
      return {
        error: '应用失败：任务轨编辑器未就绪（请确认导演台弹窗是从多轨编辑器节点打开、且未处于只读预览）',
      }
    }
    if (name === 'ask_user') {
      const answer = await askUser(String(args.question ?? ''), Array.isArray(args.options) ? args.options.map(String) : ['好的', '算了'])
      return { answer }
    }
    return { error: `未知工具：${name}` }
  }

  const askResolveRef = useRef<((answer: string) => void) | null>(null)
  function askUser(question: string, options: string[]): Promise<string> {
    const qid = `q-${Date.now()}`
    return new Promise((resolve) => {
      askResolveRef.current = resolve
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === activeReplyRef.current
          ? { ...message, question: { id: qid, text: question, options } }
          : message
      )))
      // 答案可能由别的实例写入 workspace（组件重挂载后仍能取到）
      const poll = window.setInterval(() => {
        const stored = (readWorkspace(projectKey) as { agentAnswer?: { id: string; answer: string } }).agentAnswer
        if (!stored || stored.id !== qid) return
        window.clearInterval(poll)
        askResolveRef.current = null
        writeWorkspace(projectKey, { agentAnswer: undefined } as never)
        resolve(String(stored.answer || ''))
      }, 400)
      const originalResolve = resolve
      askResolveRef.current = (answer: string) => {
        window.clearInterval(poll)
        originalResolve(answer)
      }
    })
  }
  useEffect(() => {
    const registry = globalThis as unknown as { __easyMediaAnswerQuestion?: (answer: string) => boolean }
    registry.__easyMediaAnswerQuestion = (answer: string) => {
      if (!askResolveRef.current) return false
      answerQuestion(answer)
      return true
    }
    return () => {
      if (registry.__easyMediaAnswerQuestion) delete registry.__easyMediaAnswerQuestion
    }
  })

  function answerQuestion(answer: string) {
    const currentQuestion = (readWorkspace(projectKey).messages ?? [])
      .find((message) => message.id === activeReplyRef.current)?.question as { id?: string; answer?: string } | undefined
    if (currentQuestion?.answer) return  // 已答过，忽略重复点击
    if (currentQuestion?.id) {
      writeWorkspace(projectKey, { agentAnswer: { id: String(currentQuestion.id), answer } } as never)
    }
    const resolve = askResolveRef.current
    askResolveRef.current = null
    if (!resolve) {
      // 没有等待者：提问的那一轮已经结束（中断/重挂载丢引用/自然收尾后点历史选项）。
      // 空闲 → 直接以该选择为新指令发起一轮（历史选项点击不再死等"下一步"）；
      // 仍在运行 → 记为排队指令，由下一步消费；绝不当成"插话"文本乱发。
      const stillBusy = busy || Boolean((readWorkspace(projectKey) as { agentBusy?: boolean }).agentBusy)
      if (stillBusy) {
        writeWorkspace(projectKey, { pendingInject: `（我已选择）${answer}` } as never)
      } else {
        void sendStepLoop(`（我已选择）${answer}`)
      }
      patchWorkspaceMessages(projectKey, (current) => [
        ...current,
        { id: `u-choice-${Date.now()}`, role: 'user', text: `（选择）${answer}` },
      ])
    }
    patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
      message.id === activeReplyRef.current && message.question
        ? { ...message, question: { ...message.question, answer } }
        : message
    )))
    resolve?.(answer)
  }
  const activeReplyRef = useRef<string>('')

  /** 往当前正在生成的助手回复里追加一行（工具执行过程中用，不等本轮结束） */
  function pushChatLine(line: string) {
    const replyId = activeReplyRef.current
    if (!replyId) return
    patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
      message.id === replyId ? { ...message, text: `${message.text}${line}` } : message
    )))
  }

  /** D-P1：前端驱动的工具循环（最多 40 步） */
  /** 直接执行工具：输入框里只写一个工具名时，跳过模型直接运行（排障/脚本化用） */
  async function runToolDirectly(toolName: string, toolArgs: Record<string, unknown> = {}) {
    const stamp = Date.now()
    const replyId = `a-${stamp}`
    const controller = new AbortController()
    abortRef.current = controller
    writeWorkspace(projectKey, { agentBusy: true })
    setBusy(true)
    setInput('')
    patchWorkspaceMessages(projectKey, (current) => [
      ...current,
      { id: `u-${stamp}`, role: 'user', text: toolName },
      { id: replyId, role: 'assistant', text: '', status: 'running', steps: [{ label: toolName, status: 'running' }] },
    ])
    activeReplyRef.current = replyId
    setRailTab('chat')
    try {
      const result = await executeAgentTool(toolName, toolArgs)
      const pretty = JSON.stringify(result, null, 2)
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === replyId
          ? ({
              ...message,
              status: 'done',
              text: `${toolName} 结果：\n\`\`\`json\n${pretty.slice(0, 8000)}\n\`\`\``,
              steps: [{ label: toolName, status: 'done' }],
              toolCalls: [{ id: `tc-${stamp}`, name: toolName, args: toolArgs, status: 'done', result: pretty.slice(0, 4000) }],
            } as never)
          : message
      )))
    } catch (error) {
      patchWorkspaceMessages(projectKey, (current) => current.map((message) => (
        message.id === replyId
          ? { ...message, status: 'failed', text: `执行失败：${String(error)}` }
          : message
      )))
    } finally {
      abortRef.current = null
      writeWorkspace(projectKey, { agentBusy: false })
      setBusy(false)
    }
  }

  async function sendStepLoop(textOverride?: string, asTask = false) {
    const text = String(textOverride ?? input).trim()
    if (!text) return
    // 纯工具名（如 dump_state / list_bindings）→ 直接执行，不经过模型
    const toolNames = new Set((AGENT_TOOLS as unknown as Array<{ function?: { name?: string } }>)
      .map((item) => String(item?.function?.name ?? ''))
      .filter(Boolean))
    if (!busy && toolNames.has(text)) {
      void runToolDirectly(text)
      return
    }
    if (busy) {
      if (asTask) {
        // 按钮派单是「新任务」，不是中途插话：排到本轮结束后执行，避免模型只回一句收到
        writeWorkspace(projectKey, { pendingTask: text } as never)
        setInput('')
        patchWorkspaceMessages(projectKey, (current) => [
          ...current,
          { id: `u-task-${Date.now()}`, role: 'user', text: `（排队任务：本轮结束后执行）${text}` },
        ])
        return
      }
      // Toonflow 式 steer：运行中允许插话，循环会在下一步之间插入
      writeWorkspace(projectKey, { pendingInject: text } as never)
      setInput('')
      patchWorkspaceMessages(projectKey, (current) => [
        ...current,
        { id: `u-inject-${Date.now()}`, role: 'user', text: `（排队插话）${text}` },
      ])
      return
    }
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
    progressRef.current = (line: string) => appendText(`\n${line}\n`)
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
      const workspaceNow = readWorkspace(projectKey)
      const todos = (workspaceNow.todos ?? []) as Array<{ text?: string; status?: string }>
      const notes = (workspaceNow.notes ?? {}) as Record<string, string>
      const agent = readDirectorSettings(projectKey).agent
      const context: Record<string, unknown> = { project: projectKey, tab }
      if (agent.includeNodeSettings) {
        context.frame_rate = frameRate
        context.ratio = ratio
      }
      if (agent.includePlan && plan) {
        const planLike = plan as unknown as { title?: string; total_seconds?: number; segments?: Array<Record<string, unknown>> }
        context.plan = {
          title: planLike.title ?? '',
          total_seconds: planLike.total_seconds ?? 0,
          segments: (planLike.segments ?? []).slice(0, 40).map((segment, i) => ({
            index: i + 1,
            name: String(segment.name ?? ''),
            duration_seconds: Number(segment.duration_seconds ?? 0),
            beat: String(segment.beat ?? '').slice(0, 40),
            shots: Array.isArray(segment.shots) ? segment.shots.length : 0,
            has_prompt_a: Boolean(String(segment.promptA ?? '').trim()),
            final_a_len: String(segment.finalA ?? '').length,
            task_mode: String((segment.settings as Record<string, unknown> | undefined)?.taskType ?? ''),
          })),
        }
      }
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
      if (todos.length) {
        context.todos = todos.slice(0, 24).map((item) => ({ text: String(item.text ?? ''), status: String(item.status ?? 'pending') }))
      }
      const memoryList = ((workspaceNow.memories ?? []) as Array<Record<string, unknown>>)
        .slice()
        .sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0))
        .slice(0, 15)
        .map((item) => ({
          type: item.type,
          title: String(item.title ?? '').slice(0, 60),
          content: String(item.content ?? '').slice(0, 220),
          importance: item.importance,
        }))
      if (memoryList.length) {
        context.memories = memoryList
      }
      const noteEntries = Object.entries(notes)
        .sort((a, b) => (a[0] === 'agent_memo' ? -1 : b[0] === 'agent_memo' ? 1 : 0))
        .slice(0, 20)
      if (noteEntries.length) {
        context.notes = Object.fromEntries(noteEntries)
      }
      const mentionNames = Array.from(new Set(Array.from(text.matchAll(/〔([^〔〕]{1,40})〕/g)).map((match) => match[1])))
      if (mentionNames.length) {
        const pool = readResources(projectKey) as ProjectResource[]
        context.mentions = mentionNames.map((name) => {
          const found = pool.find((item) => item.name === name)
          return { name, type: found?.type ?? '', found: Boolean(found), status: found?.status ?? '' }
        })
      }
      return context
    }

    const previousRun = (readWorkspace(projectKey).agentRun ?? []) as Array<Record<string, unknown>>
    const resumedRun = previousRun.slice(-16).filter((entry) => entry && typeof entry === 'object')
    while (resumedRun.length && String(resumedRun[0]?.role ?? '') === 'tool') {
      resumedRun.shift()
    }
    const fallbackHistory = (readWorkspace(projectKey).messages ?? [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, text: message.text }))
    const chatMessages: Array<Record<string, unknown>> = resumedRun.length
      ? [...resumedRun, { role: 'user', text }]
      : [...fallbackHistory]
    let stepCount = 0
    let producedText = false
    let endedByNoCalls = false
    let haltRequested = false
    // 步数策略（对标 dsh/hermes）：软上限每 40 步询问模型「继续还是收尾」，硬上限 200 才强制总结
    const HARD_STEP_LIMIT = 200
    const SOFT_STEP_INTERVAL = 40
    // 上下文预算（字符数近似 token）：达到触发压缩，压缩后保留近期原文，更早的转备忘并入项目记忆
    const AUTO_COMPACT_CHARS = 600000
    const KEEP_TAIL_CHARS = 120000
    const KEEP_MIN_MESSAGES = 12
    let idleReadOnlySteps = 0
    try {
      for (let step = 0; step < HARD_STEP_LIMIT; step += 1) {
        if (controller.signal.aborted) break
        stepCount = step + 1
        update({ steps: [{ label: `第 ${stepCount} 步`, status: 'running' }] })
        // 插话注入：把排队中的用户消息塞进本轮对话
        const pendingInject = String((readWorkspace(projectKey) as { pendingInject?: string }).pendingInject ?? '').trim()
        if (pendingInject) {
          chatMessages.push({ role: 'user', text: pendingInject })
          appendText(`\n[收到插话] ${pendingInject}\n`)
          writeWorkspace(projectKey, { pendingInject: '' } as never)
        }
        // 软上限询问：每 40 步把「继续还是收尾」的决定权交给模型，而不是硬断
        if ((step + 1) % SOFT_STEP_INTERVAL === 0 && step + 1 < HARD_STEP_LIMIT) {
          chatMessages.push({ role: 'user', text: `[系统] 已连续执行 ${step + 1} 步。若任务尚未完成，请继续调用工具（执行环境会持续提供）；若已完成，请不要再调用工具，直接输出面向用户的总结。` })
          appendText(`
[进度] 已执行 ${step + 1} 步，继续中…`)
        }
        // 上下文压缩（预算制，对标 dsh/hermes）：按字符预算触发，保留足够长的近期原文，
        // 更早部分压成结构化备忘并写入项目记忆（每轮 system 都带上，刷新/重挂载不丢）
        const msgChars = (m: Record<string, unknown>) => String(m.text ?? m.content ?? '').length
        const totalChars = chatMessages.reduce((n, m) => n + msgChars(m), 0)
        if (totalChars > AUTO_COMPACT_CHARS && chatMessages.length > KEEP_MIN_MESSAGES + 4) {
          try {
            let keep = 0
            let acc = 0
            for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
              acc += msgChars(chatMessages[i])
              keep += 1
              if (keep >= KEEP_MIN_MESSAGES && acc >= KEEP_TAIL_CHARS) break
            }
            const cutoff = Math.max(0, chatMessages.length - keep)
            const older = chatMessages.slice(0, cutoff)
            if (older.length >= 4) {
              const compactResponse = await fetch('/easy-media/agent/compact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: older }),
              })
              const compactData = await compactResponse.json().catch(() => ({}))
              const memo = String(compactData?.text || '').trim()
              const extracted = Array.isArray(compactData?.memories) ? (compactData.memories as Array<Record<string, unknown>>) : []
              if (compactResponse.ok && memo) {
                const tail = chatMessages.slice(cutoff)
                chatMessages.length = 0
                chatMessages.push({ role: 'assistant', text: `【前情提要】${memo}` }, ...tail)
                try {
                  const notesNow = { ...((readWorkspace(projectKey).notes ?? {}) as Record<string, string>) }
                  notesNow.agent_memo = memo
                  writeWorkspace(projectKey, { notes: notesNow } as never)
                } catch {
                  /* 记忆写入失败不阻塞 */
                }
                if (extracted.length) {
                  try {
                    const list = ((readWorkspace(projectKey).memories ?? []) as Array<Record<string, unknown>>).slice()
                    for (const raw of extracted.slice(0, 5)) {
                      const title = String(raw?.title ?? '').trim().slice(0, 80)
                      const content = String(raw?.content ?? '').trim().slice(0, 500)
                      if (!title || !content) continue
                      const record = {
                        type: String(raw?.type ?? 'project'),
                        title,
                        content,
                        importance: Math.max(1, Math.min(5, Number(raw?.importance ?? 3) || 3)),
                        updatedAt: Date.now(),
                      }
                      const hit = list.findIndex((item) => String(item.title ?? '') === title)
                      if (hit >= 0) list[hit] = { ...list[hit], ...record }
                      else list.push({ id: `mem-${Date.now().toString(36)}-${list.length}`, createdAt: Date.now(), ...record })
                    }
                    list.sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0))
                    writeWorkspace(projectKey, { memories: list.slice(0, 60) } as never)
                  } catch {
                    /* 记忆写入失败不阻塞 */
                  }
                }
                appendText(`\n[记忆] 已把前 ${older.length} 条对话压成备忘并存入项目记忆${extracted.length ? `，并提炼 ${extracted.length} 条长期记忆` : ''}\n`)
              }
            }
          } catch {
            /* 压缩失败不影响主流程 */
          }
        }
        const stepBody = JSON.stringify({
          messages: chatMessages,
          context: buildContext(),
          tools: AGENT_TOOLS,
          system_extra: readDirectorSettings(projectKey).agent.promptRules || DEFAULT_PROMPT_RULES,
        })
        // 优先流式（逐字出现）：失败自动回退非流式；回退时只补未显示的后缀，避免重复
        let data: { ok?: boolean; text?: string; tool_calls?: unknown[]; error?: string } | null = null
        let stepStreamed = ''
        try {
          data = await (async () => {
            const streamResponse = await fetch('/easy-media/agent/step/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: stepBody,
            })
            if (!streamResponse.ok || !streamResponse.body) throw new Error(`流式不可用（HTTP ${streamResponse.status}）`)
            const reader = streamResponse.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let finalText = ''
            let finalCalls: unknown[] = []
            let gotFinal = false
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let boundary = buffer.indexOf('\n\n')
              while (boundary >= 0) {
                const raw = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                for (const line of raw.split('\n')) {
                  if (!line.startsWith('data:')) continue
                  const payload = line.slice(5).trim()
                  if (!payload) continue
                  let event: Record<string, unknown>
                  try {
                    event = JSON.parse(payload)
                  } catch {
                    continue
                  }
                  if (event.type === 'text' && typeof event.delta === 'string') {
                    producedText = true
                    stepStreamed += event.delta
                    appendText(event.delta)
                  } else if (event.type === 'final') {
                    gotFinal = true
                    finalText = String(event.text ?? '')
                    finalCalls = Array.isArray(event.tool_calls) ? event.tool_calls : []
                  } else if (event.type === 'error') {
                    throw new Error(String(event.error ?? '流式错误'))
                  }
                }
                boundary = buffer.indexOf('\n\n')
              }
            }
            if (!gotFinal) throw new Error('流式未返回最终结果')
            return { ok: true, text: finalText, tool_calls: finalCalls }
          })()
        } catch {
          if (controller.signal.aborted) break
          const postStep = () => fetch('/easy-media/agent/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: stepBody,
          })
          // 网络级失败（Failed to fetch / 服务重启）先等 1.2s 重试一次，再判失败
          let response = await postStep().catch(() => null as unknown as Response)
          if (!response) {
            await new Promise((resolve) => window.setTimeout(resolve, 1200))
            if (controller.signal.aborted) break
            response = await postStep().catch(() => null as unknown as Response)
          }
          if (!response || response.status === 429 || response.status >= 500) {
            await new Promise((resolve) => window.setTimeout(resolve, 1200))
            if (controller.signal.aborted) break
            response = await fetch('/easy-media/agent/step', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: stepBody,
            })
          }
          const fallback = await response.json().catch(() => ({}))
          if (!response.ok || !fallback?.ok) {
            const detail = String(fallback?.error || `HTTP ${response.status}`)
            throw new Error(detail)
          }
          data = fallback
        }
        if (!data) break
        const replyText = String(data.text || '')
        if (replyText) {
          producedText = true
          if (stepStreamed && replyText.startsWith(stepStreamed)) {
            const suffix = replyText.slice(stepStreamed.length)
            if (suffix) appendText(suffix)
          } else if (!stepStreamed) {
            appendText(replyText)
          }
        }
        const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
        if (!calls.length) {
          endedByNoCalls = true
          break
        }
        chatMessages.push({
          role: 'assistant',
          text: replyText,
          tool_calls: (calls as Array<{ id: string; name: string; arguments: string }>).map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        })
        writeWorkspace(projectKey, { agentRun: chatMessages.slice(-40) } as never)
        for (const call of calls as Array<{ id: string; name: string; arguments: string }>) {
          upsertToolCall({ id: call.id, name: call.name, args: call.arguments, status: 'running' })
          let parsedArgs: Record<string, unknown> = {}
          try {
            parsedArgs = JSON.parse(call.arguments || '{}')
          } catch {
            parsedArgs = {}
          }
          const startedAt = Date.now()
          const heartbeat = window.setInterval(() => {
            patchWorkspaceMessages(projectKey, (current) => current.map((item) => {
              if (item.id !== replyId) return item
              return {
                ...item,
                toolCalls: (item.toolCalls ?? []).map((entry) => (
                  entry.id === call.id ? { ...entry, elapsedMs: Date.now() - startedAt } : entry
                )),
              }
            }))
          }, 1000)
          try {
            const result = await executeAgentTool(call.name, parsedArgs)
            window.clearInterval(heartbeat)
            upsertToolCall({
              id: call.id,
              name: call.name,
              args: parsedArgs,
              status: result.error ? 'error' : 'success',
              result: JSON.stringify(result).slice(0, 2000),
            })
            chatMessages.push({ role: 'tool', tool_call_id: call.id, text: JSON.stringify(result).slice(0, 6000) })
            writeWorkspace(projectKey, { agentRun: chatMessages.slice(-40) } as never)
            // 空转检测：以"是否真的产生修改"为准，而不是工具名前缀（fix_/retoken_/promote_ 都是写操作）
            const READ_ONLY_TOOL = /^(list_|get_|validate_|audit_|explain_|read_|inspect_|dump_|resolve_|search_)/.test(call.name)
            const payload = (result ?? {}) as Record<string, unknown>
            const producedChange = Boolean(
              payload.changed || payload.updated || payload.applied
              || payload.task_track_updated || payload.fixed || payload.synced
              || payload.deleted || payload.restored || payload.bound
              || (payload.saved === true) || Array.isArray(payload.applied),
            )
            const isNeutral = call.name === 'ask_user' || call.name === 'get_prompt_context'
            if (!result?.error && (!READ_ONLY_TOOL || producedChange)) {
              idleReadOnlySteps = 0
            } else if (isNeutral) {
              // 读上下文/提问不算空转，也不清零，避免把正常交互当打转
            } else {
              idleReadOnlySteps += 1
              if (idleReadOnlySteps === 10) {
                chatMessages.push({
                  role: 'user',
                  text: '[系统] 已连续 10 次只读、没有产生任何修改。不要再查同类信息；立即执行写操作（写提示词/修收尾句/重排编号/落轨），或直接用已有信息收尾回答。',
                })
              } else if (idleReadOnlySteps >= 24) {
                haltRequested = true
                endedByNoCalls = true
                appendText('\n[系统] 连续多次只读且无写入，已中止本轮。可换成更具体的指令，例如“直接重写第 1 段并写入”。')
                break
              }
            }
          } catch (toolError) {
            window.clearInterval(heartbeat)
            const message = toolError instanceof Error ? toolError.message : String(toolError)
            upsertToolCall({ id: call.id, name: call.name, args: parsedArgs, status: 'error', result: message })
            chatMessages.push({ role: 'tool', tool_call_id: call.id, text: JSON.stringify({ error: message }) })
          }
        }
        if (haltRequested) break
      }
      // 收尾兜底：跑满步数上限、或模型收尾没有输出文本时，自动补一次总结
      if (!controller.signal.aborted && (!endedByNoCalls || !producedText)) {
        update({ steps: [{ label: '生成总结', status: 'running' }] })
        appendText('')
        try {
          const sumResp = await fetch('/easy-media/agent/step/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ messages: chatMessages, summarize: true }),
          })
          if (sumResp.ok && sumResp.body) {
            const reader2 = sumResp.body.getReader()
            const dec2 = new TextDecoder()
            let buf2 = ''
            let summary = ''
            for (;;) {
              const r2 = await reader2.read()
              if (r2.done) break
              buf2 += dec2.decode(r2.value, { stream: true })
              let b2 = buf2.indexOf('\n\n')
              while (b2 >= 0) {
                const raw2 = buf2.slice(0, b2)
                buf2 = buf2.slice(b2 + 2)
                for (const line of raw2.split('\n')) {
                  if (!line.startsWith('data:')) continue
                  let ev: Record<string, unknown>
                  try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
                  if (ev.type === 'text' && typeof ev.delta === 'string') { summary += ev.delta; appendText(ev.delta) }
                  if (ev.type === 'error') throw new Error(String(ev.error ?? '总结失败'))
                }
                b2 = buf2.indexOf('\n\n')
              }
            }
            if (summary.trim()) {
              chatMessages.push({ role: 'assistant', text: summary })
              writeWorkspace(projectKey, { agentRun: chatMessages.slice(-40) } as never)
            }
          }
        } catch { /* 总结失败不阻塞收尾 */ }
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
      progressRef.current = null
      const queuedTask = String((readWorkspace(projectKey) as { pendingTask?: string }).pendingTask ?? '').trim()
      writeWorkspace(projectKey, {
        agentBusy: false,
        pendingInject: '',
        ...(queuedTask ? { pendingTask: '' } : {}),
      } as never)
      setBusy(false)
      if (queuedTask) window.setTimeout(() => { void sendStepLoop(queuedTask, true) }, 0)
    }
  }



  const chatListRef = useRef<HTMLDivElement | null>(null)
  const scrollToBottom = () => {
    const element = chatListRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }
  // 进入对话页 / 从别的页签切回来 → 回到底部
  useEffect(() => {
    if (!active || railTab !== 'chat') return
    const timer = window.setTimeout(scrollToBottom, 30)
    return () => window.clearTimeout(timer)
  }, [active, railTab, tab])
  // 新消息 / 流式追加 → 跟随最新（仅当用户本来就在底部附近）
  useEffect(() => {
    if (!active || railTab !== 'chat') return
    const element = chatListRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120
    if (nearBottom) scrollToBottom()
  }, [active, railTab, messages.length, messages[messages.length - 1]?.text])

  return (
    <div className="easy-agent-rail flex h-full min-h-0 shrink-0 flex-col gap-2 overflow-hidden py-2 pl-2 pr-2" data-easy-rail="v2" style={{ width: width === 'fill' ? '100%' : (width ?? 460), minWidth: width === 'fill' ? 0 : (width ?? 460), maxWidth: width === 'fill' ? '100%' : (width ?? 460), borderLeft: `1px solid ${BORDER}`, background: PANEL_BG }}>
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium">AI 助手</span>
        <span className="text-[9px] text-muted-foreground" title="界面版本标记">v2</span>
        {apiProfiles.length > 0 ? (
          <select
            className="max-w-[200px] truncate rounded-full px-1.5 text-[10px]"
            style={{ border: `1px solid ${BORDER}`, background: 'transparent', color: '#cfcfcf' }}
            value={activeProfileId || apiProfiles[0]?.id || ''}
            title="切换 API 配置（立即生效）"
            onChange={async (event) => {
              const id = event.target.value
              setActiveProfileId(id)
              try {
                const response = await fetch('/easy-media/prompt-studio/active', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id }),
                })
                const data = await response.json().catch(() => ({}))
                if (data?.ok) {
                  setModel(String(data.model || ''))
                  globalThis.dispatchEvent(new CustomEvent('easy-media-api-changed'))
                }
              } catch {
                /* ignore */
              }
            }}
          >
            {apiProfiles.map((item) => (
              <option key={item.id} value={item.id}>{item.name} · {item.model}</option>
            ))}
          </select>
        ) : model ? (
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

      <div
              ref={chatListRef}
              className="easy-agent-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden"
              style={{ paddingRight: 4 }}
            >
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
                          {(call as { elapsedMs?: number }).elapsedMs ? (
                            <span className="ml-1 text-muted-foreground">
                              {Math.round(((call as { elapsedMs?: number }).elapsedMs ?? 0) / 1000)}s
                            </span>
                          ) : null}
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
                {message.text ? (
                  <div className={message.toolCalls?.length ? 'mt-1' : ''}>
                    {message.role === 'assistant'
                      ? <AgentMarkdown text={message.text} />
                      : <div className="whitespace-pre-wrap">{message.text}</div>}
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
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            // 统一走"回答"：写 workspace（提问方轮询）+ 本地 resolve + 全局注册器
                            answerQuestion(option)
                            const registry = globalThis as unknown as {
                              __easyMediaAnswerQuestion?: (answer: string) => boolean
                            }
                            registry.__easyMediaAnswerQuestion?.(option)
                          }}
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
            const value = event.target.value
            setInput(value)
            const match = /@([^\s@〔〕]*)$/.exec(value)
            setMentionQuery(match ? match[1] : null)
            const el = event.currentTarget
            if (!expanded) {
              el.style.height = 'auto'
              setInputHeight(Math.max(64, Math.min(240, el.scrollHeight)))
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void sendStepLoop()
            }
          }}
        />
        {mentionQuery !== null && mentionOptions.length > 0 && (
          <div
            style={{
              position: 'absolute',
              left: 8,
              right: 8,
              bottom: inputHeight + 12,
              zIndex: 40,
              maxHeight: 180,
              overflowY: 'auto',
              border: '1px solid hsl(var(--border, 240 6% 25%))',
              borderRadius: 6,
              background: 'hsl(var(--background, 240 10% 8%))',
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            }}
          >
            {mentionOptions.map((option) => (
              <button
                key={`${option.type}-${option.name}`}
                type="button"
                style={{
                  display: 'flex',
                  width: '100%',
                  gap: 8,
                  alignItems: 'center',
                  padding: '5px 8px',
                  background: 'transparent',
                  border: 'none',
                  color: 'hsl(var(--foreground, 240 10% 92%))',
                  fontSize: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setInput((current) => current.replace(/@([^\s@〔〕]*)$/, `〔${option.name}〕`))
                  setMentionQuery(null)
                }}
              >
                <span style={{ opacity: 0.6 }}>{option.type === 'Subject' ? '主体' : '资源'}</span>
                <span>{option.name}</span>
              </button>
            ))}
          </div>
        )}
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
          disabled={!input.trim()}
          onClick={() => { void sendStepLoop() }}
          title={busy ? '插话：会在助手下一步开始前插入，不打断当前步骤' : '发送'}
        >
          {busy ? '插话' : '发送'}
        </Button>
        {busy ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              abortRef.current?.abort()
              writeWorkspace(projectKey, { agentBusy: false })
              setBusy(false)
            }}
            title="中止本轮执行"
          >
            停止
          </Button>
        ) : null}
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
