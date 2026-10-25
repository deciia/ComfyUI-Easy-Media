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
const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: '#e5e5e5',
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
}

/** 导演级分镜规划结果的预览面板。 */
export function PlanPreview({
  plan,
  onBack,
  onSaveDraft,
  onOpenEnhance,
  onPatchPlan,
  saved,
  onApply,
  editable = false,
  onMutateSegments,
  appliedNote,
  onImportSubjects,
  onImportResources,
  importedNote,
}: {
  plan: StoryboardPlan
  onBack?: () => void
  onSaveDraft: () => void
  onOpenEnhance?: (scriptIndex?: number) => void
  onPatchPlan?: (settings: Record<string, string>) => void
  saved: boolean
  onApply?: () => boolean
  /** 手动编辑：传入后段支持增删改/排序 */
  editable?: boolean
  onMutateSegments?: (fn: (segments: any[]) => any[]) => void
  appliedNote?: string
  onImportSubjects?: () => void
  onImportResources?: () => void
  importedNote?: string
}) {
  const [confirmApply, setConfirmApply] = useState(false)

  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<{ name: string; beat: string; duration: string; summary: string; directorNote: string; contextMode: string; refImageSize: string; taskType: string }>({ name: '', beat: '', duration: '', summary: '', directorNote: '', contextMode: 'shot', refImageSize: '', taskType: '' })

  const startEdit = (index: number, segment: { name?: string; beat?: string; duration_seconds?: number; summary?: string; director_note?: string }) => {
    setEditingIndex(index)
    setEditDraft({
      name: String(segment.name ?? ''),
      beat: String(segment.beat ?? ''),
      duration: String(segment.duration_seconds ?? 4),
      summary: String(segment.summary ?? ''),
      directorNote: String(segment.director_note ?? ''),
      contextMode: String((segment as unknown as { settings?: { contextMode?: string } }).settings?.contextMode ?? 'shot'),
      refImageSize: String((segment as unknown as { settings?: { refImageSize?: string } }).settings?.refImageSize ?? ''),
      taskType: String((segment as unknown as { settings?: { taskType?: string } }).settings?.taskType ?? ''),
    })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{plan.title || '分镜脚本'}</span>
        <span className="text-[11px] text-muted-foreground">
          {plan.segments.length} 段 · {plan.total_seconds}s · {plan.frame_rate}fps
        </span>
        {plan.genre ? <span className="rounded border px-1 text-[10px]" style={{ borderColor: BORDER }}>{plan.genre}</span> : null}
        {onPatchPlan ? (() => {
          const settings = ((plan as unknown as { settings?: Record<string, string> }).settings) ?? {}
          const field = (key: string, label: string, options: Array<[string, string]>) => (
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {label}
              <select
                style={{ background: FIELD_BG, border: '1px solid ' + BORDER, borderRadius: 4, color: '#e5e5e5', fontSize: 10, padding: '1px 3px' }}
                value={settings[key] ?? (key === 'taskType' ? '' : options[0][0])}
                onChange={(event) => onPatchPlan({ ...settings, [key]: event.target.value })}
              >
                {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
          )
          return (
            <div className="flex flex-wrap items-center gap-2">
              {field('ratio', '比例', [['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1'], ['4:3', '4:3']])}
              {field('refImageSize', '参考图', [['match', 'match'], ['max', 'max']])}
              {field('taskType', '任务', [['', '未设置（按素材推断）'], ['r2v', 'R2V'], ['fmlf2v', 'FMLF2V'], ['vi2v', 'VI2V'], ['l2v', 'L2V'], ['passthrough', 'Pass']])}
              {field('contextMode', '衔接', [['shot', 'shot'], ['context', 'context'], ['context_drift', 'context_drift']])}
            </div>
          )
        })() : null}
        <span className="ml-auto" />
        {onImportSubjects || onImportResources ? (
          <Button size="sm" variant="secondary" onClick={() => { onImportSubjects?.(); onImportResources?.() }}>
            同步到主体与资源
          </Button>
        ) : null}
        {onOpenEnhance ? (
          <Button size="sm" variant="secondary" onClick={() => onOpenEnhance?.(0)}>→ 提示词增强</Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onSaveDraft} disabled={saved}>
          {saved ? '已保存' : '保存草稿'}
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
        {editable && onMutateSegments ? (
          <Button size="sm" variant="secondary" className="h-6 self-start px-2 text-[11px]"
            onClick={() => onMutateSegments((segs) => [...segs, { index: segs.length + 1, name: `镜头 ${segs.length + 1}`, beat: '', duration_seconds: 4, duration_frames: 0, summary: '', shots: [], subjects: [], resources: [] }])}>
            ＋ 手动添加一段
          </Button>
        ) : null}
        {plan.segments.map((segment, segmentIndex) => (
          <div key={segmentIndex} className="flex flex-col gap-1.5 rounded-md p-2" style={{ border: `1px solid ${BORDER}` }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium">{segment.index}. {segment.name}</span>
              {segment.beat ? <span className="rounded-full px-1.5 text-[10px]" style={{ border: `1px solid ${BORDER}` }}>{segment.beat}</span> : null}
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {segment.duration_seconds}s · {segment.duration_frames}f · {segment.shots.length} 镜
              </span>
            </div>
            {editable && onMutateSegments ? (
              <div className="flex items-center gap-1 text-[10px]">
                <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={() => startEdit(segmentIndex, segment)}>✎ 编辑</button>
                <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} disabled={segmentIndex === 0} onClick={() => onMutateSegments((segs) => { const next = [...segs]; [next[segmentIndex - 1], next[segmentIndex]] = [next[segmentIndex], next[segmentIndex - 1]]; return next })}>↑</button>
                <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} disabled={segmentIndex === plan.segments.length - 1} onClick={() => onMutateSegments((segs) => { const next = [...segs]; [next[segmentIndex + 1], next[segmentIndex]] = [next[segmentIndex], next[segmentIndex + 1]]; return next })}>↓</button>
                <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={() => onMutateSegments((segs) => segs.filter((_, i) => i !== segmentIndex))}>✕ 删除</button>
              </div>
            ) : null}
            {editingIndex === segmentIndex ? (
              <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: FIELD_BG, border: `1px dashed ${BORDER}` }}>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <input style={{ ...fieldStyle, width: 140 }} value={editDraft.name} placeholder="镜头名" onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
                  <input style={{ ...fieldStyle, width: 90 }} value={editDraft.beat} placeholder="beat（钩子/铺垫…）" onChange={(e) => setEditDraft({ ...editDraft, beat: e.target.value })} />
                  <input style={{ ...fieldStyle, width: 64 }} value={editDraft.duration} placeholder="秒" onChange={(e) => setEditDraft({ ...editDraft, duration: e.target.value })} />
                </div>
                <textarea style={{ ...fieldStyle, minHeight: 60, resize: 'vertical' }} value={editDraft.summary} placeholder="本段概要" onChange={(e) => setEditDraft({ ...editDraft, summary: e.target.value })} />
                <textarea style={{ ...fieldStyle, minHeight: 44, resize: 'vertical' }} value={editDraft.directorNote} placeholder="导演说明（可选）" onChange={(e) => setEditDraft({ ...editDraft, directorNote: e.target.value })} />
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    <label className="flex items-center gap-1">衔接
                      <select style={{ ...fieldStyle, padding: '1px 3px' }} value={editDraft.contextMode} onChange={(event) => setEditDraft({ ...editDraft, contextMode: event.target.value })}>
                        <option value="shot">shot 独立镜头</option>
                        <option value="context">context 带上一段上下文</option>
                        <option value="context_drift">context_drift 上下文漂移</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1">参考图
                      <select style={{ ...fieldStyle, padding: '1px 3px' }} value={editDraft.refImageSize} onChange={(event) => setEditDraft({ ...editDraft, refImageSize: event.target.value })}>
                        <option value="">跟随脚本</option>
                        <option value="match">match</option>
                        <option value="max">max</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1">任务
                      <select style={{ ...fieldStyle, padding: '1px 3px' }} value={editDraft.taskType} onChange={(event) => setEditDraft({ ...editDraft, taskType: event.target.value })}>
                        <option value="">跟随脚本</option>
                        <option value="r2v">R2V</option>
                        <option value="fmlf2v">FMLF2V</option>
                        <option value="vi2v">VI2V</option>
                        <option value="l2v">L2V</option>
                        <option value="passthrough">Pass</option>
                      </select>
                    </label>
                  </div>
                <div className="flex gap-2">
                  <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => {
                    onMutateSegments?.((segs) => segs.map((seg, i) => (
                      i === segmentIndex
                        ? {
                            ...seg,
                            name: editDraft.name.trim() || seg.name,
                            beat: editDraft.beat.trim(),
                            duration_seconds: Math.min(15, Math.max(0.5, Number(editDraft.duration) || 4)),
                            summary: editDraft.summary,
                            director_note: editDraft.directorNote,
                            settings: { contextMode: editDraft.contextMode, refImageSize: editDraft.refImageSize, taskType: editDraft.taskType },
                          }
                        : seg
                    )))
                    setEditingIndex(null)
                  }}>保存</Button>
                  <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => setEditingIndex(null)}>取消</Button>
                </div>
              </div>
            ) : null}
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

