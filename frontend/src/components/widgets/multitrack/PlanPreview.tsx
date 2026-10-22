import { useState } from 'react'
import { Button } from '@/components/ui/button'

export interface PlanShot {
  shot: number
  framing: string
  camera: string
  action: string
  dialogue: Array<{ speaker: string; line: string }>
  micro_expression: string
  sound: string
  transition: string
}

export interface PlanSegment {
  index: number
  name: string
  beat: string
  duration_seconds: number
  duration_frames: number
  start_frame: number
  end_frame: number
  summary: string
  director_note: string
  shots: PlanShot[]
  subjects: Array<{ name: string; type: string; description: string; retention: string[] }>
  resources: Array<{ kind: string; name: string; note: string; for: string }>
}

export interface StoryboardPlan {
  title: string
  logline: string
  genre: string
  tone: string
  rhythm: string
  total_seconds: number
  total_frames: number
  frame_rate: number
  segments: PlanSegment[]
}


/** 把一段分镜脚本渲染成可读文本（写入任务的 user_brief，供提示词增强使用）。 */
export function formatPlanSegmentBrief(segment: PlanSegment): string {
  const lines: string[] = []
  if (segment.beat) lines.push(`beat：${segment.beat}`)
  if (segment.duration_seconds) lines.push(`时长：${segment.duration_seconds}s（${segment.duration_frames}帧）`)
  if (segment.summary) lines.push(`本段：${segment.summary}`)
  for (const shot of segment.shots) {
    lines.push(`[${shot.framing}]${shot.camera ? ` ${shot.camera}` : ''}${shot.action ? `：${shot.action}` : ''}`)
    for (const line of shot.dialogue) {
      lines.push(`${line.speaker ? `${line.speaker}：` : ''}「${line.line}」`)
    }
    if (shot.micro_expression) lines.push(`微表情：${shot.micro_expression}`)
    if (shot.sound) lines.push(`声音：${shot.sound}`)
    if (shot.transition) lines.push(`衔接：${shot.transition}`)
  }
  if (segment.director_note) lines.push(`导演说明：${segment.director_note}`)
  if (segment.subjects.length) {
    lines.push(`主体：${segment.subjects.map((item) => `${item.name}(${item.type})`).join('、')}`)
  }
  if (segment.resources.length) {
    lines.push(`资源：${segment.resources.map((item) => `${item.kind}:${item.name}`).join('、')}`)
  }
  return lines.join('\n')
}

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'

/** 导演级分镜规划结果的预览面板。 */
export function PlanPreview({
  plan,
  onBack,
  onSaveDraft,
  saved,
  onApply,
  appliedNote,
  onImportSubjects,
  onImportResources,
  importedNote,
}: {
  plan: StoryboardPlan
  onBack: () => void
  onSaveDraft: () => void
  saved: boolean
  onApply?: () => boolean
  appliedNote?: string
  onImportSubjects?: () => void
  onImportResources?: () => void
  importedNote?: string
}) {
  const [confirmApply, setConfirmApply] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{plan.title || '分镜脚本'}</span>
        <span className="text-[11px] text-muted-foreground">
          {plan.segments.length} 段 · {plan.total_seconds}s · {plan.frame_rate}fps
        </span>
        {plan.genre ? <span className="rounded border px-1 text-[10px]" style={{ borderColor: BORDER }}>{plan.genre}</span> : null}
        <span className="ml-auto" />
        <Button size="sm" variant="secondary" onClick={onBack}>返回编辑</Button>
        {onImportSubjects ? (
          <Button size="sm" variant="secondary" onClick={onImportSubjects}>导入主体到 ②</Button>
        ) : null}
        {onImportResources ? (
          <Button size="sm" variant="secondary" onClick={onImportResources}>导入资源需求到 ③</Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onSaveDraft} disabled={saved}>
          {saved ? '已保存为草稿' : '保存为草稿'}
        </Button>
        {onApply ? (
        <Button
          size="sm"
          variant={confirmApply ? 'default' : 'secondary'}
          onClick={() => {
            if (!onApply) return
            if (!confirmApply) {
              setConfirmApply(true)
              return
            }
            setConfirmApply(false)
            onApply()
          }}
          disabled={!onApply}
        >
          {confirmApply ? '确认替换任务轨？' : '应用到任务轨'}
        </Button>
        ) : null}
      </div>

      {importedNote ? (
        <div className="rounded px-2 py-1 text-[11px] text-muted-foreground" style={{ border: `1px solid ${BORDER}` }}>{importedNote}</div>
      ) : null}

      {appliedNote ? (
        <div className="rounded px-2 py-1 text-[11px]" style={{ border: `1px solid ${BORDER}`, color: 'hsl(var(--primary, 199 89% 48%))' }}>
          {appliedNote}
        </div>
      ) : null}

      {plan.logline || plan.tone || plan.rhythm ? (
        <div className="flex flex-col gap-1 rounded-md p-2 text-[11px] leading-relaxed" style={{ border: `1px solid ${BORDER}`, background: FIELD_BG }}>
          {plan.logline ? <div><span className="text-muted-foreground">一句话：</span>{plan.logline}</div> : null}
          {plan.tone ? <div><span className="text-muted-foreground">调性：</span>{plan.tone}</div> : null}
          {plan.rhythm ? <div><span className="text-muted-foreground">节奏：</span>{plan.rhythm}</div> : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {plan.segments.map((segment) => (
          <div key={`${segment.index}-${segment.name}`} className="flex flex-col gap-1.5 rounded-md p-2" style={{ border: `1px solid ${BORDER}` }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium">{segment.index}. {segment.name}</span>
              {segment.beat ? <span className="rounded-full px-1.5 text-[10px]" style={{ border: `1px solid ${BORDER}` }}>{segment.beat}</span> : null}
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {segment.duration_seconds}s · {segment.duration_frames}f · {segment.shots.length} 镜
              </span>
            </div>
            {segment.summary ? <div className="text-[11px] leading-relaxed">{segment.summary}</div> : null}
            {segment.director_note ? (
              <div className="text-[10px] leading-relaxed text-muted-foreground">导演说明：{segment.director_note}</div>
            ) : null}

            <div className="flex flex-col gap-1">
              {segment.shots.map((shot) => (
                <div key={shot.shot} className="rounded px-2 py-1 text-[11px] leading-relaxed" style={{ background: FIELD_BG }}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded px-1 text-[10px]" style={{ border: `1px solid ${BORDER}` }}>{shot.framing}</span>
                    <span className="text-[10px] text-muted-foreground">镜 {shot.shot}</span>
                    {shot.camera ? <span className="text-[10px] text-muted-foreground">{shot.camera}</span> : null}
                  </div>
                  {shot.action ? <div>{shot.action}</div> : null}
                  {shot.dialogue.length > 0 ? (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {shot.dialogue.map((line, index) => (
                        <div key={index}>
                          {line.speaker ? <span className="text-muted-foreground">{line.speaker}：</span> : null}
                          「{line.line}」
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {shot.micro_expression ? <div className="text-[10px] text-muted-foreground">微表情：{shot.micro_expression}</div> : null}
                  {shot.sound ? <div className="text-[10px] text-muted-foreground">声音：{shot.sound}</div> : null}
                  {shot.transition ? <div className="text-[10px] text-muted-foreground">衔接：{shot.transition}</div> : null}
                </div>
              ))}
            </div>

            {segment.subjects.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1 text-[10px]">
                <span className="text-muted-foreground">主体：</span>
                {segment.subjects.map((subject) => (
                  <span key={subject.name} className="rounded-full px-1.5" style={{ border: `1px solid ${BORDER}`, color: 'hsl(var(--highlight, 45 90% 55%))' }}>
                    {subject.name}·{subject.type}
                  </span>
                ))}
              </div>
            ) : null}
            {segment.resources.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1 text-[10px]">
                <span className="text-muted-foreground">资源：</span>
                {segment.resources.map((resource) => (
                  <span key={`${resource.kind}-${resource.name}`} className="rounded-full px-1.5" style={{ border: `1px solid ${BORDER}` }}>
                    {resource.kind}:{resource.name}{resource.for ? `（${resource.for}）` : ''}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
