import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ProjectResource } from './agentStore'

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'
const AMBER = '#fbbf24'

const SECTIONS_REF = [
  ['subject_definitions', '主体定义'],
  ['summary', '总览'],
  ['retention_analysis', '保留分析'],
  ['detailed_description', '详细描述'],
  ['overall_soundscape', '整体声场'],
  ['non_diegetic_music', '非叙事音乐'],
] as const
const SECTIONS_BASE = [
  ['integrated_multimodal_description', '综合描述'],
  ['overall_soundscape', '整体声场'],
  ['non_diegetic_music', '非叙事音乐'],
] as const

export interface PromptIssue {
  level: 'ok' | 'warn' | 'error'
  text: string
}

/** 解析提示词：结构段、标签、台词位置 */
export function analyzePrompt(prompt: string, referenceMode: boolean) {
  const text = prompt ?? ''
  const sections = referenceMode ? SECTIONS_REF : SECTIONS_BASE
  // 段名识别：行首 + 可选的 markdown 标记（#、**）+ 可选冒号（渲染成独立标题行时冒号会被拆掉）
  const headerPattern = (key: string) =>
    new RegExp(`(^|\\n)[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?[ \\t]*${key}[ \\t]*(?:\\*\\*)?[ \\t]*[:：]?`, 'i')
  const present = sections.filter(([key]) => headerPattern(key).test(text))
  const missing = sections.filter(([key]) => !present.includes(sections.find((s) => s[0] === key)!))
  const tagCounts: Record<string, number> = { Subject: 0, Picture: 0, Audio: 0, Video: 0 }
  for (const match of text.matchAll(/<(Subject|Picture|Audio|Video)\s+(\d+)>/g)) tagCounts[match[1]] += 1
  // 台词必须在 <d>…</d> 内：动作描述里出现引号台词 = 会被模型念出来
  const quotes = Array.from(text.matchAll(/[“"]([^”"\n]{2,})[”"]/g)).map((m) => m[1])
  const inDialogue = new Set(
    Array.from(text.matchAll(/<d>([\s\S]*?)<\/d>/g)).flatMap((m) =>
      Array.from(m[1].matchAll(/[“"]([^”"\n]{2,})[”"]/g)).map((q) => q[1]),
    ),
  )
  const strayQuotes = quotes.filter((line) => !inDialogue.has(line))
  const issues: PromptIssue[] = []
  if (!text.trim()) issues.push({ level: 'warn', text: '本段还没有提示词' })
  if (missing.length) issues.push({ level: 'warn', text: `结构缺 ${missing.length} 段：${missing.map((m) => m[1]).join('、')}` })
  if (strayQuotes.length) issues.push({ level: 'error', text: `有 ${strayQuotes.length} 处引号台词不在 <d> 内（会被模型念出来）` })
  if (tagCounts.Subject || tagCounts.Picture || tagCounts.Audio) {
    issues.push({
      level: 'ok',
      text: `标签：Subject ${tagCounts.Subject} · Picture ${tagCounts.Picture} · Audio ${tagCounts.Audio}`,
    })
  }
  return { sections, missing, present, tagCounts, strayQuotes, issues }
}

/** ④ 中栏上方：提示词质量检查 + 引用插入 */
const SIX_SECTION_TASKS = new Set(['R2V', 'VI2V'])

export function PromptQualityBar({
  prompt,
  resources,
  referenceMode,
  taskType,
  onChangePrompt,
}: {
  prompt: string
  resources: ProjectResource[]
  referenceMode: boolean
  /** 段任务类型（R2V/FMLF2V/VI2V/L2V/Pass），决定六段式还是三段式 */
  taskType?: string
  onChangePrompt: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const normalizedTask = String(taskType ?? '').trim().toUpperCase()
  const useReferenceSections = normalizedTask ? SIX_SECTION_TASKS.has(normalizedTask) : referenceMode
  const modeLabel = useReferenceSections ? `六段式(${normalizedTask || 'R2V'})` : `三段式(${normalizedTask || 'T2V'})`
  const analysis = useMemo(() => analyzePrompt(prompt, useReferenceSections), [prompt, useReferenceSections])

  const nextIndex = (type: string) => {
    const used = Array.from(prompt.matchAll(new RegExp(`<${type}\\s+(\\d+)>`, 'g'))).map((m) => Number(m[1]))
    return (used.length ? Math.max(...used) : 0) + 1
  }

  const insert = (block: string) => {
    const next = prompt.trimEnd() ? `${prompt.trimEnd()}\n${block}` : block
    onChangePrompt(next)
  }

  const insertSkeleton = () => {
    const blocks = (useReferenceSections ? SECTIONS_REF : SECTIONS_BASE)
      .filter(([key]) => analysis.missing.some(([missingKey]) => missingKey === key))
      .map(([key, label]) => `${key}: ${label}…`)
    insert(blocks.join('\n'))
    setOpen(false)
  }

  const addReference = (resource: ProjectResource) => {
    const type = resource.type
    const lines: string[] = []
    if (type === 'Subject') {
      const n = nextIndex('Subject')
      lines.push(`<Subject ${n}> ${resource.name}：${resource.description || '（补充定义）'}`)
      const children = resources.filter((item) => (resource.childResourceIds ?? []).includes(item.id))
      for (const child of children) {
        if (child.type === 'Picture') lines.push(`<Picture ${nextIndex('Picture') + 0}> ${child.name}`)
        else if (child.type === 'Audio') lines.push(`<Audio ${nextIndex('Audio') + 0}> ${child.name}（仅引用音色）`)
        else if (child.type === 'Video') lines.push(`<Video ${nextIndex('Video') + 0}> ${child.name}`)
      }
      if (children.length === 0) lines.push(`（提示：该主体还没有引用资源，只会按文字描述生成）`)
    } else if (type === 'Picture') {
      lines.push(`<Picture ${nextIndex('Picture')}> ${resource.name}：${resource.description || '（补充定义）'}`)
    } else if (type === 'Audio') {
      lines.push(`<Audio ${nextIndex('Audio')}> ${resource.name}（${resource.relationship === 'reference' ? '仅引用音色，不复制台词' : resource.relationship}）`)
    } else {
      lines.push(`<Video ${nextIndex('Video')}> ${resource.name}`)
    }
    insert(lines.join('\n'))
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-1 rounded p-1.5" style={{ border: `1px solid ${BORDER}` }}>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="text-muted-foreground">{modeLabel}</span>
        {analysis.missing.length ? (
          <Button size="sm" variant="secondary" className="h-5 px-1.5 text-[10px]" onClick={insertSkeleton}>
            插入缺失骨架
          </Button>
        ) : null}
        <span className="ml-auto" />
        <Button size="sm" variant="secondary" className="h-5 px-1.5 text-[10px]" onClick={() => setOpen((value) => !value)}>
          ＋ 引用主体/资源
        </Button>
      </div>

      {open ? (
        <div className="max-h-44 overflow-auto rounded p-1" style={{ border: `1px solid ${BORDER}` }}>
          {resources.length === 0 ? (
            <div className="px-1 text-[10px] text-muted-foreground">项目里还没有主体/资源，去「主体与资源」添加。</div>
          ) : resources.map((resource) => {
            const children = (resource.childResourceIds ?? []).length
            return (
              <button
                key={resource.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-white/10"
                onClick={() => addReference(resource)}
              >
                <span className="w-12 shrink-0 text-[9px] text-muted-foreground">{resource.type}</span>
                <span className="min-w-0 flex-1 truncate">{resource.name}</span>
                {resource.type === 'Subject' ? (
                  <span className="shrink-0 text-[9px]" style={{ color: children ? PRIMARY : AMBER }}>
                    {children ? `带出 ${children} 个子资源` : '无参考图'}
                  </span>
                ) : (
                  <span className="shrink-0 text-[9px]" style={{ color: resource.status === 'ready' ? PRIMARY : AMBER }}>
                    {resource.status === 'ready' ? '已就绪' : '缺'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ) : null}

      {analysis.issues.map((issue, index) => (
        <div
          key={index}
          className="text-[10px]"
          style={{ color: issue.level === 'error' ? '#f87171' : issue.level === 'warn' ? AMBER : PRIMARY }}
        >
          {issue.level === 'error' ? '✕ ' : issue.level === 'warn' ? '⚠ ' : '· '}{issue.text}
        </div>
      ))}
    </div>
  )
}
