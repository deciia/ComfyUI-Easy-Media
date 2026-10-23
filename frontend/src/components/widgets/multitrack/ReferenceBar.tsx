import { useMemo, useState } from 'react'
import type { ProjectResource } from './agentStore'

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'

/** ④ 引用与绑定面板：选主体/资源 → 绑定到本段+变体，并可插入 H3 标签。 */
export function ReferenceBar({
  resources,
  boundIds,
  onChange,
  prompt,
  onInsertTokens,
}: {
  resources: ProjectResource[]
  boundIds: string[]
  onChange: (ids: string[]) => void
  prompt: string
  onInsertTokens: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const bound = useMemo(
    () => boundIds.map((id) => resources.find((item) => item.id === id)).filter((item): item is ProjectResource => Boolean(item)),
    [boundIds, resources],
  )
  const candidates = useMemo(
    () => resources.filter((item) => !boundIds.includes(item.id)),
    [resources, boundIds],
  )

  const nextIndex = (type: string) => {
    const used = Array.from(prompt.matchAll(new RegExp(`<${type}\\s+(\\d+)>`, 'g'))).map((match) => Number(match[1]))
    return (used.length ? Math.max(...used) : 0) + 1
  }

  const insertTokens = () => {
    const lines: string[] = []
    for (const item of bound) {
      if (item.type === 'Subject') {
        lines.push(`<Subject ${nextIndex('Subject')}> ${item.name}：${item.description || '（补充定义）'}`)
        for (const childId of item.childResourceIds ?? []) {
          const child = resources.find((entry) => entry.id === childId)
          if (!child) continue
          if (child.type === 'Picture') lines.push(`<Picture ${nextIndex('Picture')}> ${child.name}`)
          else if (child.type === 'Audio') lines.push(`<Audio ${nextIndex('Audio')}> ${child.name}（仅引用音色）`)
          else if (child.type === 'Video') lines.push(`<Video ${nextIndex('Video')}> ${child.name}`)
        }
      } else if (item.type === 'Picture') {
        lines.push(`<Picture ${nextIndex('Picture')}> ${item.name}：${item.description || '（补充定义）'}`)
      } else if (item.type === 'Audio') {
        lines.push(`<Audio ${nextIndex('Audio')}> ${item.name}（仅引用音色，不复制台词）`)
      } else {
        lines.push(`<Video ${nextIndex('Video')}> ${item.name}`)
      }
    }
    if (lines.length === 0) return
    const next = prompt.trimEnd() ? `${prompt.trimEnd()}\n${lines.join('\n')}` : lines.join('\n')
    onInsertTokens(next)
  }

  return (
    <div className="flex flex-col gap-1 rounded p-1.5" style={{ border: `1px solid ${BORDER}` }}>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="text-muted-foreground">引用（本段）</span>
        {bound.length === 0 ? <span className="text-[10px] text-muted-foreground">还没绑定主体/资源</span> : null}
        {bound.map((item) => (
          <span
            key={item.id}
            className="flex items-center gap-1 rounded-full px-1.5 text-[10px]"
            style={{ border: `1px solid ${item.status === 'ready' || item.type === 'Subject' ? PRIMARY : '#fbbf24'}` }}
            title={`${item.type} · ${item.relationship}`}
          >
            {item.type === 'Picture' && item.sharedPath ? (
              <img
                src={`/view?filename=${encodeURIComponent(item.imageFile ?? item.name)}&type=${item.sharedRoot ?? 'input'}${item.subfolder ? `&subfolder=${encodeURIComponent(item.subfolder)}` : ''}`}
                alt=""
                style={{ width: 14, height: 14, objectFit: 'cover', borderRadius: 2 }}
              />
            ) : null}
            <span>{item.name}</span>
            {item.type === 'Subject' ? (
              <span className="text-muted-foreground">带出 {(item.childResourceIds ?? []).length}</span>
            ) : item.status !== 'ready' ? (
              <span style={{ color: '#fbbf24' }}>缺</span>
            ) : null}
            <button
              type="button"
              className="text-muted-foreground"
              onClick={() => onChange(boundIds.filter((id) => id !== item.id))}
            >
              ×
            </button>
          </span>
        ))}
        <span className="ml-auto" />
        {bound.length > 0 ? (
          <button
            type="button"
            className="rounded px-1.5 py-0.5"
            style={{ border: `1px solid ${BORDER}` }}
            onClick={insertTokens}
            title="把已绑定的主体/资源按编号插入提示词"
          >
            插入标签
          </button>
        ) : null}
        <button
          type="button"
          className="rounded px-1.5 py-0.5"
          style={{ border: `1px solid ${BORDER}` }}
          onClick={() => setOpen((value) => !value)}
        >
          ＋ 引用
        </button>
      </div>
      {open ? (
        <div className="max-h-40 overflow-auto rounded" style={{ border: `1px solid ${BORDER}`, background: FIELD_BG }}>
          {candidates.length === 0 ? (
            <div className="px-1 py-0.5 text-[10px] text-muted-foreground">项目里没有可引用的主体/资源</div>
          ) : candidates.map((item) => (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-[11px] hover:bg-white/10"
              onClick={() => {
                onChange([...boundIds, item.id])
                setOpen(false)
              }}
            >
              <span className="w-12 shrink-0 text-[9px] text-muted-foreground">{item.type}</span>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="shrink-0 text-[9px]" style={{ color: item.type === 'Subject' ? PRIMARY : item.status === 'ready' ? PRIMARY : '#fbbf24' }}>
                {item.type === 'Subject' ? `带出 ${(item.childResourceIds ?? []).length}` : item.status === 'ready' ? '已就绪' : '缺'}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
