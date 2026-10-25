import { useEffect, useRef, useState } from 'react'
import { readWorkspace, writeWorkspace } from './agentStore'

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'

const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: '#e5e5e5',
  padding: '2px 6px',
  fontSize: 11,
  outline: 'none',
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

/**
 * 提示词增强 → 「分镜」页签：对照 + 轻编辑。
 * 六项设置分两行（窄栏可读）；改动 0.4 秒防抖写回，离开输入框立即写回；带一次性撤销。
 * 长文本按镜头折叠，点「编辑」展开，避免和「分镜编排」抢注意力。
 */
export function ScriptTab({ projectKey, segmentIndex }: { projectKey: string; segmentIndex: number }) {
  const [draft, setDraft] = useState<PlanSegment | null>(null)
  const [editingShot, setEditingShot] = useState<number | null>(null)
  const [savedHint, setSavedHint] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoRef = useRef<PlanSegment | null>(null)

  const readPlan = () => readWorkspace(projectKey).plan as { segments?: PlanSegment[]; fps?: number } | null

  useEffect(() => {
    const plan = readPlan()
    setDraft(plan?.segments?.[segmentIndex] ? clone(plan.segments[segmentIndex] as PlanSegment) : null)
    setEditingShot(null)
    undoRef.current = null
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
    setTimeout(() => setSavedHint(''), 1200)
  }

  const change = (mutate: (value: PlanSegment) => void, immediate = false) => {
    if (!draft) return
    if (!undoRef.current) undoRef.current = clone(draft)
    const next = clone(draft)
    mutate(next)
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    if (immediate) flush(next)
    else timer.current = setTimeout(() => flush(next), 400)
  }

  const undo = () => {
    const previous = undoRef.current
    if (!previous) return
    undoRef.current = null
    setDraft(previous)
    flush(previous)
  }

  if (!draft) {
    return <div className="p-3 text-[11px] text-muted-foreground">当前没有选中的分镜脚本段。</div>
  }

  const shots = Array.isArray(draft.shots) ? draft.shots : []

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2">
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

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{savedHint || '改动 0.4 秒后写回分镜编排'}</span>
        <button
          type="button"
          className="shrink-0 rounded px-1.5"
          style={{ border: `1px solid ${BORDER}`, opacity: undoRef.current ? 1 : 0.4 }}
          disabled={!undoRef.current}
          onClick={undo}
        >
          ↶ 撤销这次修改
        </button>
      </div>

      <label className="flex flex-col gap-0.5">
        <span style={labelStyle}>本段概要</span>
        <textarea style={{ ...fieldStyle, minHeight: 54, resize: 'vertical' }} value={String(draft.summary ?? '')} onChange={(event) => change((value) => { value.summary = event.target.value })} onBlur={() => flush(draft)} />
      </label>

      <label className="flex flex-col gap-0.5">
        <span style={labelStyle}>导演说明</span>
        <textarea style={{ ...fieldStyle, minHeight: 40, resize: 'vertical' }} value={String(draft.director_note ?? '')} onChange={(event) => change((value) => { value.director_note = event.target.value })} onBlur={() => flush(draft)} />
      </label>

      {shots.map((shot, index) => {
        const lines = Array.isArray(shot.dialogue) ? shot.dialogue : []
        const open = editingShot === index
        return (
          <div key={index} className="flex flex-col gap-1 rounded p-1.5" style={{ border: `1px solid ${BORDER}` }}>
            <div className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
              <span className="truncate">
                <span className="rounded px-1" style={{ border: `1px solid ${BORDER}` }}>{shot.framing ?? '—'}</span>
                {' '}镜 {shot.shot ?? index + 1}{shot.camera ? ` · ${shot.camera}` : ''}
              </span>
              <button type="button" className="shrink-0 rounded px-1.5" style={{ border: `1px solid ${BORDER}` }} onClick={() => setEditingShot(open ? null : index)}>
                {open ? '收起' : '编辑'}
              </button>
            </div>
            {open ? (
              <>
                <textarea title="画面" style={{ ...fieldStyle, minHeight: 52, resize: 'vertical' }} placeholder="画面/动作" value={String(shot.action ?? '')} onChange={(event) => change((value) => { value.shots![index].action = event.target.value })} onBlur={() => flush(draft)} />
                <textarea
                  title="台词：一行一句，可写「角色：台词」"
                  style={{ ...fieldStyle, minHeight: 40, resize: 'vertical' }}
                  placeholder="台词：一行一句，可写「角色：台词」"
                  value={lines.map((line) => `${line.speaker ? `${line.speaker}：` : ''}${line.line ?? ''}`).join('\n')}
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
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <textarea title="微表情" style={{ ...fieldStyle, minHeight: 32, resize: 'vertical' }} placeholder="微表情" value={String(shot.micro_expression ?? '')} onChange={(event) => change((value) => { value.shots![index].micro_expression = event.target.value })} onBlur={() => flush(draft)} />
                  <textarea title="声音" style={{ ...fieldStyle, minHeight: 32, resize: 'vertical' }} placeholder="声音" value={String(shot.sound ?? '')} onChange={(event) => change((value) => { value.shots![index].sound = event.target.value })} onBlur={() => flush(draft)} />
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-0.5 text-[11px] leading-snug">
                {shot.action ? <div className="line-clamp-2">{shot.action}</div> : null}
                {lines.length ? <div className="line-clamp-2 text-muted-foreground">{lines.map((line) => `${line.speaker ? `${line.speaker}：` : ''}${line.line ?? ''}`).join(' / ')}</div> : null}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
