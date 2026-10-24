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
        description: '生成缺失资源（图片/配音/音乐/参考视频）：调用配置好的 ComfyUI 工作流并自动挂到资源上',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['image', 'voice', 'music', 'refvideo'] },
            name: { type: 'string', description: '资源名称（已存在则更新，不存在则新建）' },
            prompt: { type: 'string', description: '画面/音乐描述（image/music/refvideo 用）' },
            text: { type: 'string', description: '配音文本（voice 用）' },
            duration: { type: 'number', description: '目标时长秒（music/refvideo 用）' },
            reference_file: { type: 'string', description: '参考素材 input 路径（音色/首帧/风格）' },
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
      const response = await fetch('/easy-media/resource-workflows/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: resourceType,
          params: {
            name: String(args.name ?? 'res'),
            prompt: String(args.prompt ?? ''),
            text: String(args.text ?? ''),
            duration: Number(args.duration ?? 5) || 5,
            negative: String(args.negative ?? ''),
            reference_file: String(args.reference_file ?? ''),
            reference_image: String(args.reference_file ?? ''),
            reference_audio: String(args.reference_file ?? ''),
            prompt_override: args.prompt_override ?? String(args.prompt ?? '') + (args.duration ? ` [0-${args.duration}s]` : ''),
            profile: typeof args.profile === 'string' ? args.profile : undefined,
            inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : undefined,
            seed: Math.floor(Math.random() * 1_000_000),
          },
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) {
        return {
          error: String(data?.error || `生成失败（HTTP ${response.status}）`),
          hint: '请检查 ComfyUI 的 user/DeciiaEasyMedia/resource_workflows.json 是否为该类型配置了 API 格式工作流',
        }
      }
      const fileName = String(data.file_name || '')
      const subfolder = String(data.subfolder || '')
      const root = String(data.root || 'output') === 'input' ? 'input' : 'output'
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
            pictureNo += 1
            pictures.push({ token: `<Picture ${pictureNo}>`, name: child.name })
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
      const planCurrent = readWorkspace(projectKey).plan as (StoryboardPlanLike & { segments: Array<Record<string, unknown>> }) | null
      if (!planCurrent || !onApplyPlan) return { error: '当前没有可应用的分镜脚本' }
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
      // 兜底：走组件传入的 onApplyPlan（部分页签直接接收 plan 或 items）
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

  /** D-P1：前端驱动的工具循环（最多 40 步） */
  async function sendStepLoop() {
    const text = input.trim()
    if (!text) return
    if (busy) {
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
      const noteEntries = Object.entries(notes).slice(0, 20)
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
    try {
      for (let step = 0; step < 40; step += 1) {
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
        // 上下文压缩：过长时把旧段压成备忘
        if (chatMessages.length > 34) {
          try {
            const compactResponse = await fetch('/easy-media/agent/compact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: chatMessages.slice(0, chatMessages.length - 8) }),
            })
            const compactData = await compactResponse.json().catch(() => ({}))
            const memo = String(compactData?.text || '').trim()
            if (compactResponse.ok && memo) {
              const tail = chatMessages.slice(-8)
              chatMessages.length = 0
              chatMessages.push({ role: 'assistant', text: `【前情提要】${memo}` }, ...tail)
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
          let response = await fetch('/easy-media/agent/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: stepBody,
          }).catch(() => null as unknown as Response)
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
          if (!response.ok || !fallback?.ok) throw new Error(String(fallback?.error || `请求失败（HTTP ${response.status}）`))
          data = fallback
        }
        if (!data) break
        const replyText = String(data.text || '')
        if (replyText) {
          if (stepStreamed && replyText.startsWith(stepStreamed)) {
            const suffix = replyText.slice(stepStreamed.length)
            if (suffix) appendText(suffix)
          } else if (!stepStreamed) {
            appendText(replyText)
          }
        }
        const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
        if (!calls.length) break
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
          try {
            const result = await executeAgentTool(call.name, parsedArgs)
            upsertToolCall({
              id: call.id,
              name: call.name,
              args: parsedArgs,
              status: result.error ? 'error' : 'success',
              result: JSON.stringify(result).slice(0, 2000),
            })
            chatMessages.push({ role: 'tool', tool_call_id: call.id, text: JSON.stringify(result).slice(0, 6000) })
            writeWorkspace(projectKey, { agentRun: chatMessages.slice(-40) } as never)
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
      writeWorkspace(projectKey, { agentBusy: false, pendingInject: '' } as never)
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
              void send()
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
