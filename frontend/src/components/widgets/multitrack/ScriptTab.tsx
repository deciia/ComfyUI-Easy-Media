import { useEffect, useRef, useState } from 'react'
import { readWorkspace, writeWorkspace } from './agentStore'

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'

const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: '#e5e5e5',
  padding: '3px 6px',
  fontSize: 11,
  outline: 'none',
  lineHeight: 1.5,
}

const labelStyle: React.CSSProperties = { fontSize: 10, color: 'hsl(var(--muted-foreground, 240 5% 65%))' }

interface ShotLine { speaker?: string; line?: string }
interface PlanShot {
  shot?: number
  framing?: string
  camera?: string
  action?: string
  dialogue?: ShotLine[]
  micro_expression?: string
  sound?: string
  transition?: string
}
interface PlanSegment {
  name?: string
  beat?: string
  duration_seconds?: number
  duration_frames?: number
  summary?: string
  director_note?: string
  settings?: { contextMode?: string; refImageSize?: string; taskType?: string }
  shots?: PlanShot[]
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? {})) as T

/** 自动长高的 textarea：内容多高就多高，不用在窄栏里滚动 */
function AutoTextarea({
  value,
  onChange,
  onBlur,
  onKeyDown,
  placeholder,
  minHeight = 28,
  style,
}: {
  value: string
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onBlur?: () => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  minHeight?: number
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.max(minHeight, node.scrollHeight)}px`
  }, [value, minHeight])
  return (
    <textarea
      ref={ref}
      style={{ ...fieldStyle, resize: 'none', overflow: 'hidden', minHeight, ...style }}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  )
}

function lineText(line: ShotLine) {
  return `${line.speaker ? `${line.speaker}：` : ''}${line.line ?? ''}`
}

/**
 * 提示词增强 → 「分镜」页签：全字段可直接编辑。
 * 体验要点：设置区吸顶常驻；输入框随内容长高；折叠态显示带字段名的摘要；
 * 0.4s 防抖写回 + 失焦立即写回 + 单步撤销；Ctrl+Enter 收起，Esc 撤销。
 */
export function ScriptTab({ projectKey, segmentIndex }: { projectKey: string; segmentIndex: number }) {
  const [draft, setDraft] = useState<PlanSegment | null>(null)
  const [openShots, setOpenShots] = useState<number[]>([])
  const [savedHint, setSavedHint] = useState('')
  const [dirty, setDirty] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoRef = useRef<PlanSegment | null>(null)

  const readPlan = () => readWorkspace(projectKey).plan as { segments?: PlanSegment[]; fps?: number } | null

  useEffect(() => {
    const plan = readPlan()
    setDraft(plan?.segments?.[segmentIndex] ? clone(plan.segments[segmentIndex] as PlanSegment) : null)
    setOpenShots([])
    undoRef.current = null
    setDirty(false)
    setSavedHint('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, segmentIndex])

  const fps = Number(readPlan()?.fps ?? 24) || 24

  const flush = (next: PlanSegment) => {
    const plan = readPlan()
    if (!plan?.segments) return
    const segments = plan.segments.map((item, index) => (index === segmentIndex ? next : item))
    writeWorkspace(projectKey, { plan: { ...(plan as Record<string, unknown>), segments } as never })
    setSavedHint('已写回分镜编排')
    setDirty(false)
    setTimeout(() => setSavedHint(''), 1200)
  }

  const change = (mutate: (value: PlanSegment) => void, immediate = false) => {
    if (!draft) return
    if (!undoRef.current) undoRef.current = clone(draft)
    const next = clone(draft)
    mutate(next)
    setDraft(next)
    setDirty(true)
    if (timer.current) clearTimeout(timer.current)
    if (immediate) flush(next)
    else timer.current = setTimeout(() => flush(next), 400)
  }

  const undo = () => {
    const previous = undoRef.current
    if (!previous) return
    undoRef.current = null
    setDraft(previous)
    setDirty(false)
    flush(previous)
  }

  const keyHandler = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      if (draft) flush(draft)
      setOpenShots([])
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      undo()
      setOpenShots([])
    }
  }

  if (!draft) {
    return <div className="p-3 text-[11px] text-muted-foreground">当前没有选中的分镜脚本段。</div>
  }

  const shots = Array.isArray(draft.shots) ? draft.shots : []
  const allOpen = openShots.length === shots.length && shots.length > 0

  const toggleShot = (index: number) => {
    setOpenShots((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]))
  }

  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-auto p-2">
      {/* 段标题 + 状态 + 操作 */}
      <div className="flex items-center justify-between gap-1 text-[10px]">
        <span className="truncate text-muted-foreground">
          第 {segmentIndex + 1} 段 · {shots.length} 镜 · {draft.duration_seconds ?? '?'}s
          {dirty ? <span style={{ color: 'hsl(var(--highlight, 45 90% 55%))' }}> · 未写回</span> : null}
          {savedHint ? <span style={{ color: 'hsl(var(--primary, 199 89% 48%))' }}> · {savedHint}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" className="rounded px-1.5" style={{ border: `1px solid ${BORDER}` }} onClick={() => setOpenShots(allOpen ? [] : shots.map((_, index) => index))}>
            {allOpen ? '全部收起' : '全部展开'}
          </button>
          <button type="button" className="rounded px-1.5" style={{ border: `1px solid ${BORDER}`, opacity: undoRef.current ? 1 : 0.4 }} disabled={!undoRef.current} onClick={undo}>
            ↶ 撤销
          </button>
        </span>
      </div>

      {/* 设置区吸顶 */}
      <div className="sticky top-0 z-10 flex flex-col gap-1.5 pb-1" style={{ background: 'hsl(var(--card, 240 10% 10%))' }}>
        <div className="grid items-end gap-1.5" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1.3fr) 60px' }}>
          <label className="flex flex-col gap-0.5">
            <span style={labelStyle}>段名</span>
            <input style={{ ...fieldStyle, width: '100%', minWidth: 0 }} value={String(draft.name ?? '')} onChange={(event) => change((value) => { value.name = event.target.value })} onBlur={() => flush(draft)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span style={labelStyle}>钩子 / beat</span>
            <input style={{ ...fieldStyle, width: '100%', minWidth: 0 }} value={String(draft.beat ?? '')} onChange={(event) => change((value) => { value.beat = event.target.value })} onBlur={() => flush(draft)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span style={labelStyle}>时长</span>
            <input style={{ ...fieldStyle, width: '100%', minWidth: 0 }} value={String(draft.duration_seconds ?? '')} onChange={(event) => change((value) => {
              const seconds = Number(event.target.value) || 0
              value.duration_seconds = seconds
              value.duration_frames = Math.round(seconds * fps)
            })} onBlur={() => flush(draft)} />
          </label>
        </div>
        <div className="grid items-end gap-1.5" style={{ gridTemplateColumns: '1.2fr 1fr 1fr' }}>
          <label className="flex flex-col gap-0.5">
            <span style={labelStyle}>衔接</span>
            <select style={{ ...fieldStyle, padding: '1px 3px', width: '100%', minWidth: 0 }} value={String(draft.settings?.contextMode ?? 'shot')} onChange={(event) => change((value) => { value.settings = { ...(value.settings ?? {}), contextMode: event.target.value } }, true)}>
              <option value="shot">shot 独立镜头</option>
              <option value="context">context 带上文</option>
              <option value="context_drift">context_drift 漂移</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span style={labelStyle}>参考图</span>
            <select style={{ ...fieldStyle, padding: '1px 3px', width: '100%', minWidth: 0 }} value={String(draft.settings?.refImageSize ?? '')} onChange={(event) => change((value) => { value.settings = { ...(value.settings ?? {}), refImageSize: event.target.value } }, true)}>
              <option value="">跟随脚本</option>
              <option value="match">match</option>
              <option value="max">max</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span style={labelStyle}>任务</span>
            <select style={{ ...fieldStyle, padding: '1px 3px', width: '100%', minWidth: 0 }} value={String(draft.settings?.taskType ?? '')} onChange={(event) => change((value) => { value.settings = { ...(value.settings ?? {}), taskType: event.target.value } }, true)}>
              <option value="">跟随脚本</option>
              <option value="r2v">R2V</option>
              <option value="fmlf2v">FMLF2V</option>
              <option value="vi2v">VI2V</option>
              <option value="l2v">L2V</option>
              <option value="passthrough">Pass</option>
            </select>
          </label>
        </div>
      </div>

      <label className="flex flex-col gap-0.5">
        <span style={labelStyle}>本段概要</span>
        <AutoTextarea value={String(draft.summary ?? '')} minHeight={48} placeholder="本段概要" onChange={(event) => change((value) => { value.summary = event.target.value })} onBlur={() => flush(draft)} onKeyDown={keyHandler} />
      </label>

      <label className="flex flex-col gap-0.5">
        <span style={labelStyle}>导演说明</span>
        <AutoTextarea value={String(draft.director_note ?? '')} minHeight={36} placeholder="导演说明" onChange={(event) => change((value) => { value.director_note = event.target.value })} onBlur={() => flush(draft)} onKeyDown={keyHandler} />
      </label>

      {shots.map((shot, index) => {
        const lines = Array.isArray(shot.dialogue) ? shot.dialogue : []
        const open = openShots.includes(index)
        return (
          <div
            key={index}
            className="flex flex-col gap-1 rounded p-1.5"
            style={{ border: `1px solid ${open ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}` }}
          >
            <div className="flex items-center justify-between gap-1 text-[10px]">
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                <span className="shrink-0 rounded px-1" style={{ border: `1px solid ${BORDER}` }}>{shot.framing ?? '—'}</span>
                <span className="shrink-0">镜 {shot.shot ?? index + 1}</span>
                <span className="truncate">{shot.camera ?? ''}</span>
              </span>
              <button type="button" className="shrink-0 rounded px-1.5" style={{ border: `1px solid ${BORDER}`, color: open ? 'hsl(var(--primary, 199 89% 48%))' : undefined }} onClick={() => toggleShot(index)}>
                {open ? '收起' : '编辑'}
              </button>
            </div>

            {open ? (
              <>
                <label className="flex flex-col gap-0.5">
                  <span style={labelStyle}>画面</span>
                  <AutoTextarea value={String(shot.action ?? '')} minHeight={44} placeholder="画面 / 动作" onChange={(event) => change((value) => { value.shots![index].action = event.target.value })} onBlur={() => flush(draft)} onKeyDown={keyHandler} />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span style={labelStyle}>台词（一行一句，可写「角色：台词」）</span>
                  <AutoTextarea
                    value={lines.map(lineText).join('\n')}
                    minHeight={34}
                    placeholder="老赵：修油嘴这行，我是最不建议大家乱花钱的。"
                    onChange={(event) => change((value) => {
                      value.shots![index].dialogue = event.target.value
                        .split('\n')
                        .map((raw) => raw.trim())
                        .filter(Boolean)
                        .map((raw) => {
                          const match = raw.match(/^([^：:]{1,12})[：:](.*)$/)
                          return match ? { speaker: match[1].trim(), line: match[2].trim() } : { line: raw }
                        })
                    })}
                    onBlur={() => flush(draft)}
                    onKeyDown={keyHandler}
                  />
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="flex flex-col gap-0.5">
                    <span style={labelStyle}>微表情</span>
                    <AutoTextarea value={String(shot.micro_expression ?? '')} minHeight={28} placeholder="微表情" onChange={(event) => change((value) => { value.shots![index].micro_expression = event.target.value })} onBlur={() => flush(draft)} onKeyDown={keyHandler} />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span style={labelStyle}>声音</span>
                    <AutoTextarea value={String(shot.sound ?? '')} minHeight={28} placeholder="声音" onChange={(event) => change((value) => { value.shots![index].sound = event.target.value })} onBlur={() => flush(draft)} onKeyDown={keyHandler} />
                  </label>
                </div>
                <div className="text-[9px] text-muted-foreground">Ctrl+Enter 收起并写回 · Esc 撤销本次修改</div>
              </>
            ) : (
              <div className="flex flex-col gap-0.5 text-[11px] leading-snug">
                {shot.action ? (
                  <div>
                    <span style={labelStyle}>画面　</span>
                    <span className="line-clamp-2">{shot.action}</span>
                  </div>
                ) : null}
                {lines.length ? (
                  <div className="text-muted-foreground">
                    <span style={labelStyle}>台词　</span>
                    {lines.map((line, lineIndex) => (
                      <span key={lineIndex}>{lineIndex ? ' / ' : ''}{lineText(line)}</span>
                    ))}
                  </div>
                ) : null}
                {shot.micro_expression || shot.sound ? (
                  <div className="text-muted-foreground">
                    {shot.micro_expression ? <span>微表情：{shot.micro_expression}　</span> : null}
                    {shot.sound ? <span>声音：{shot.sound}</span> : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
