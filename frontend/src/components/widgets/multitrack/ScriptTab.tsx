import { useState } from 'react'
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

interface ShotLine {
  speaker?: string
  line?: string
}

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

/**
 * 提示词增强 → 「分镜」页签：展示并直接编辑当前分镜脚本段。
 * 六个设置（段名/钩子/时长/衔接/参考图/任务）一行；改动即时写回分镜编排（同一份 plan.segments）。
 */
export function ScriptTab({ projectKey, segmentIndex }: { projectKey: string; segmentIndex: number }) {
  const [, setVersion] = useState(0)
  const plan = readWorkspace(projectKey).plan as { segments?: PlanSegment[]; fps?: number } | null
  const segment = plan?.segments?.[segmentIndex]
  const fps = Number((plan as { fps?: number } | null)?.fps ?? 24) || 24

  /** 改一项就写回一次（与分镜编排共用 plan.segments） */
  const patchSegment = (mutate: (draft: PlanSegment) => void) => {
    const current = readWorkspace(projectKey).plan as { segments?: PlanSegment[] } | null
    if (!current?.segments) return
    const segments = current.segments.map((item, index) => {
      if (index !== segmentIndex) return item
      const draft: PlanSegment = JSON.parse(JSON.stringify(item ?? {}))
      mutate(draft)
      return draft
    })
    writeWorkspace(projectKey, { plan: { ...(current as Record<string, unknown>), segments } as never })
    setVersion((value) => value + 1)
  }

  const patchShot = (shotIndex: number, mutate: (shot: PlanShot) => void) => {
    patchSegment((draft) => {
      const shots = Array.isArray(draft.shots) ? draft.shots : []
      shots[shotIndex] = shots[shotIndex] ?? {}
      mutate(shots[shotIndex])
      draft.shots = shots
    })
  }

  const patchSettings = (key: 'contextMode' | 'refImageSize' | 'taskType', value: string) => {
    patchSegment((draft) => {
      draft.settings = { ...(draft.settings ?? {}), [key]: value }
    })
  }

  if (!segment) {
    return <div className="p-3 text-[11px] text-muted-foreground">当前没有选中的分镜脚本段。</div>
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2">
      {/* 六个设置一行 */}
      <div
        className="grid items-center gap-1.5 text-[11px]"
        style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1.2fr) 56px 132px 100px 92px' }}
      >
        <input
          title="段名"
          style={{ ...fieldStyle, width: '100%', minWidth: 0 }}
          value={String(segment.name ?? '')}
          placeholder="段名"
          onChange={(event) => patchSegment((draft) => { draft.name = event.target.value })}
        />
        <input
          title="钩子/beat"
          style={{ ...fieldStyle, width: '100%', minWidth: 0 }}
          value={String(segment.beat ?? '')}
          placeholder="钩子/beat"
          onChange={(event) => patchSegment((draft) => { draft.beat = event.target.value })}
        />
        <input
          title="时长（秒）"
          style={{ ...fieldStyle, width: '100%', minWidth: 0 }}
          value={String(segment.duration_seconds ?? '')}
          placeholder="秒"
          onChange={(event) => patchSegment((draft) => {
            const seconds = Number(event.target.value) || 0
            draft.duration_seconds = seconds
            draft.duration_frames = Math.round(seconds * fps)
          })}
        />
        <select
          title="衔接"
          style={{ ...fieldStyle, padding: '1px 3px', width: '100%', minWidth: 0 }}
          value={String(segment.settings?.contextMode ?? 'shot')}
          onChange={(event) => patchSettings('contextMode', event.target.value)}
        >
          <option value="shot">shot 独立镜头</option>
          <option value="context">context 带上下文</option>
          <option value="context_drift">context_drift 漂移</option>
        </select>
        <select
          title="参考图"
          style={{ ...fieldStyle, padding: '1px 3px', width: '100%', minWidth: 0 }}
          value={String(segment.settings?.refImageSize ?? '')}
          onChange={(event) => patchSettings('refImageSize', event.target.value)}
        >
          <option value="">参考图跟随脚本</option>
          <option value="match">参考图 match</option>
          <option value="max">参考图 max</option>
        </select>
        <select
          title="任务"
          style={{ ...fieldStyle, padding: '1px 3px', width: '100%', minWidth: 0 }}
          value={String(segment.settings?.taskType ?? '')}
          onChange={(event) => patchSettings('taskType', event.target.value)}
        >
          <option value="">任务跟随脚本</option>
          <option value="r2v">R2V</option>
          <option value="fmlf2v">FMLF2V</option>
          <option value="vi2v">VI2V</option>
          <option value="l2v">L2V</option>
          <option value="passthrough">Pass</option>
        </select>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground">本段概要</span>
        <textarea
          style={{ ...fieldStyle, minHeight: 56, resize: 'vertical' }}
          value={String(segment.summary ?? '')}
          onChange={(event) => patchSegment((draft) => { draft.summary = event.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground">导演说明</span>
        <textarea
          style={{ ...fieldStyle, minHeight: 44, resize: 'vertical' }}
          value={String(segment.director_note ?? '')}
          onChange={(event) => patchSegment((draft) => { draft.director_note = event.target.value })}
        />
      </label>

      {(segment.shots ?? []).map((shot, index) => {
        const lines = Array.isArray(shot.dialogue) ? shot.dialogue : []
        return (
          <div key={index} className="flex flex-col gap-1 rounded p-2" style={{ border: `1px solid ${BORDER}` }}>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="rounded px-1" style={{ border: `1px solid ${BORDER}` }}>{shot.framing ?? '—'}</span>
              <span>镜 {shot.shot ?? index + 1}</span>
              <span>{shot.camera ?? ''}</span>
            </div>
            <textarea
              title="画面"
              style={{ ...fieldStyle, minHeight: 44, resize: 'vertical' }}
              placeholder="画面/动作"
              value={String(shot.action ?? '')}
              onChange={(event) => patchShot(index, (draft) => { draft.action = event.target.value })}
            />
            <textarea
              title="台词（一行一句，可写「角色：台词」）"
              style={{ ...fieldStyle, minHeight: 34, resize: 'vertical' }}
              placeholder="台词：一行一句，可写「角色：台词」"
              value={lines.map((line) => `${line.speaker ? `${line.speaker}：` : ''}${line.line ?? ''}`).join('\n')}
              onChange={(event) => patchShot(index, (draft) => {
                draft.dialogue = event.target.value
                  .split('\n')
                  .map((raw) => raw.trim())
                  .filter(Boolean)
                  .map((raw) => {
                    const match = raw.match(/^([^：:]{1,12})[：:](.*)$/)
                    return match ? { speaker: match[1].trim(), line: match[2].trim() } : { line: raw }
                  })
              })}
            />
            <div className="grid grid-cols-2 gap-1.5">
              <textarea
                title="微表情"
                style={{ ...fieldStyle, minHeight: 30, resize: 'vertical' }}
                placeholder="微表情"
                value={String(shot.micro_expression ?? '')}
                onChange={(event) => patchShot(index, (draft) => { draft.micro_expression = event.target.value })}
              />
              <textarea
                title="声音"
                style={{ ...fieldStyle, minHeight: 30, resize: 'vertical' }}
                placeholder="声音"
                value={String(shot.sound ?? '')}
                onChange={(event) => patchShot(index, (draft) => { draft.sound = event.target.value })}
              />
            </div>
          </div>
        )
      })}
      <div className="text-[10px] text-muted-foreground">改动即时写回「分镜编排」，两边共用同一份分镜脚本。</div>
    </div>
  )
}
