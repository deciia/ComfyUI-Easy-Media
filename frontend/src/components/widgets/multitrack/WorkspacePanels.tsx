import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

export interface WorkspaceSubject {
  id: string
  name: string
  type: string
  description: string
  retention: string[]
}

export interface WorkspaceResourceItem {
  name: string
  subfolder: string
  kind: 'image' | 'audio' | 'video'
  url: string
  size?: number
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

/** ② 主体定义骨架：卡片 + 表单（本轮先本地编辑，下一步写回主体库节点）。 */
export function SubjectsTab({
  subjects,
  onChange,
}: {
  subjects: WorkspaceSubject[]
  onChange?: (next: WorkspaceSubject[]) => void
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(subjects[0]?.id)
  const list = subjects
  const selected = list.find((item) => item.id === selectedId) ?? list[0]

  const patch = (id: string, changes: Partial<WorkspaceSubject>) => {
    if (!onChange) return
    onChange(subjects.map((item) => (item.id === id ? { ...item, ...changes } : item)))
  }

  if (list.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground">
        <div>主体库还是空的。</div>
        <div>下一步：从分镜规划结果一键导入主体，或直接在这里新增后同步到画布「主体库」节点。</div>
        <Button size="sm" variant="secondary" disabled>新增主体（下一步）</Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[220px] shrink-0 flex-col gap-1 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-muted-foreground">
          <span>{list.length} 个主体</span>
          <button
            type="button"
            className="rounded px-1"
            style={{ border: `1px solid ${BORDER}` }}
            onClick={() => {
              if (!onChange) return
              const id = `subject-local-${Date.now()}`
              onChange([...subjects, { id, name: '新主体', type: '人物', description: '', retention: [] }])
              setSelectedId(id)
            }}
          >
            + 新增
          </button>
          <button
            type="button"
            className="rounded px-1"
            style={{ border: `1px solid ${BORDER}` }}
            onClick={() => {
              if (!onChange) return
              onChange([])
              setSelectedId(undefined)
            }}
          >
            清空
          </button>
        </div>
        {list.map((subject) => {
          const active = subject.id === selected?.id
          return (
            <button
              key={subject.id}
              type="button"
              onClick={() => setSelectedId(subject.id)}
              className="rounded-md px-2 py-1.5 text-left"
              style={{
                background: active ? 'hsl(var(--primary, 199 89% 48%) / 0.16)' : FIELD_BG,
                border: `1px solid ${active ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
              }}
            >
              <div className="truncate text-[12px] font-medium">{subject.name}</div>
              <div className="text-[10px] text-muted-foreground">{subject.type || '未分类'}{subject.retention.length ? ` · 保留 ${subject.retention.length} 项` : ''}</div>
            </button>
          )
        })}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {selected ? (
          <>
            <div className="flex items-center gap-2">
              <input
                style={{ ...fieldStyle, width: 200 }}
                value={selected.name}
                onChange={(event) => patch(selected.id, { name: event.target.value })}
              />
              <select
                style={{ ...fieldStyle, width: 110 }}
                value={selected.type}
                onChange={(event) => patch(selected.id, { type: event.target.value })}
              >
                {['人物', '场景', '物体', '风格'].map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <span className="text-[10px] text-muted-foreground">来源：主体库节点 / 分镜规划</span>
            </div>
            <textarea
              style={{ ...fieldStyle, minHeight: 120, resize: 'vertical', lineHeight: 1.6 }}
              placeholder="外观、身份、性格、与其它主体的关系…"
              value={selected.description}
              onChange={(event) => patch(selected.id, { description: event.target.value })}
            />
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">保留项（retention，生成时要求不变的外观/空间要素，逗号分隔）</span>
              <input
                style={fieldStyle}
                value={selected.retention.join('，')}
                onChange={(event) => patch(selected.id, {
                  retention: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
                })}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled title="下一步：写回画布主体库节点">同步到主体库（下一步）</Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (!onChange) return
                  onChange(subjects.filter((item) => item.id !== selected.id))
                  setSelectedId(undefined)
                }}
              >
                删除主体
              </Button>
              <span className="text-[10px] text-muted-foreground">本轮先支持查看与本地编辑，写回在下一版接入。</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** ③ 资源与生成：三段式（Input 浏览 / 按分镜规划 / 生成）。 */
export function ResourcesTab({
  projectResources,
  segments = [],
  onAttach,
  plannedResources = [],
}: {
  projectResources: Array<{ kind: string; name: string; scope?: string }>
  segments?: Array<{ id: string; label: string }>
  onAttach?: (segmentId: string, items: WorkspaceResourceItem[]) => boolean
  plannedResources?: Array<{ kind: string; name: string; purpose?: string }>
}) {
  const [kind, setKind] = useState<'all' | 'image' | 'audio' | 'video'>('all')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<WorkspaceResourceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Record<string, WorkspaceResourceItem>>({})
  const [targetSegmentId, setTargetSegmentId] = useState<string>(segments[0]?.id ?? '')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ kind, limit: '300' })
    if (query.trim()) params.set('query', query.trim())
    fetch(`/easy-media/resources/input?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        if (!data?.ok) setError(String(data?.error || '扫描 input 失败'))
        else setItems(Array.isArray(data.items) ? data.items : [])
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [kind, query])

  const pickedList = useMemo(() => Object.values(picked), [picked])
  const findByName = (name: string) => items.find((item) => item.name === name)

  const section = (title: string, hint: string) => (
    <div className="flex shrink-0 items-center gap-2 px-1">
      <span className="text-[12px] font-medium">{title}</span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {/* ① 共享资源浏览 */}
      <div className="flex min-h-0 flex-col gap-1" style={{ flex: '1 1 46%' }}>
        {section('共享资源（ComfyUI/input）', '点选加入下方清单；音频/视频暂不支持挂载')}
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'image', 'audio', 'video'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setKind(key)}
              className="rounded px-2 py-0.5 text-[11px]"
              style={{
                border: `1px solid ${kind === key ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
                color: kind === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
              }}
            >
              {{ all: '全部', image: '图片', audio: '音频', video: '视频' }[key]}
            </button>
          ))}
          <input
            style={{ ...fieldStyle, width: 200 }}
            placeholder="按文件名过滤"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="text-[10px] text-muted-foreground">
            {loading ? '扫描中…' : `${items.length} 个 · 本片已用 ${projectResources.length} 项`}
          </span>
        </div>
        {error ? (
          <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>{error}</div>
        ) : null}
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 overflow-auto">
          {items.map((item) => {
            const key = `${item.subfolder}/${item.name}`
            const active = Boolean(picked[key])
            return (
              <button
                key={key}
                type="button"
                title={`${key}${item.size ? ` · ${(item.size / 1024).toFixed(0)}KB` : ''}`}
                onClick={() => setPicked((current) => {
                  const next = { ...current }
                  if (next[key]) delete next[key]
                  else next[key] = item
                  return next
                })}
                className="flex flex-col overflow-hidden rounded-md text-left"
                style={{
                  border: `1px solid ${active ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
                  background: FIELD_BG,
                }}
              >
                <div className="flex h-[58px] items-center justify-center overflow-hidden bg-black/40">
                  {item.kind === 'image'
                    ? <img src={item.url} alt={item.name} className="h-full w-full object-cover" loading="lazy" />
                    : <span className="text-base">{item.kind === 'audio' ? '♪' : '▶'}</span>}
                </div>
                <div className="truncate px-1 py-0.5 text-[10px]">{item.name}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ② 按分镜规划的资源 */}
      <div className="flex min-h-0 flex-col gap-1" style={{ flex: '1 1 34%', borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}>
        {section('按分镜规划的资源', plannedResources.length ? `${plannedResources.length} 项（✓已有 / 缺=待生成）` : '先在①分镜预览里「导入资源需求」')}
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          {plannedResources.length === 0 ? (
            <div className="px-1 text-[11px] text-muted-foreground">（暂无规划需求）</div>
          ) : plannedResources.map((resource) => {
            const found = findByName(resource.name)
            return (
              <div key={`${resource.kind}:${resource.name}`} className="flex items-center gap-2 rounded px-2 py-1 text-[11px]" style={{ background: FIELD_BG }}>
                <span
                  className="rounded-full px-1.5"
                  style={{ border: `1px solid ${found ? 'hsl(var(--primary, 199 89% 48%))' : '#92400e'}`, color: found ? undefined : '#fbbf24' }}
                >
                  {found ? '✓' : '缺'}
                </span>
                <span className="shrink-0 text-muted-foreground">{resource.kind}</span>
                <span className="min-w-0 truncate">{resource.name}</span>
                {resource.purpose ? <span className="shrink-0 text-[10px] text-muted-foreground">（{resource.purpose}）</span> : null}
                <span className="ml-auto shrink-0">
                  {found
                    ? (
                      <button
                        type="button"
                        className="rounded px-1.5"
                        style={{ border: `1px solid ${BORDER}` }}
                        onClick={() => setPicked((current) => ({ ...current, [`${found.subfolder}/${found.name}`]: found }))}
                      >
                        加入清单
                      </button>
                    )
                    : <span className="text-[10px] text-muted-foreground">待生成</span>}
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            style={{ ...fieldStyle, width: 160 }}
            value={targetSegmentId}
            onChange={(event) => setTargetSegmentId(event.target.value)}
          >
            {segments.length === 0 ? <option value="">（无任务片段）</option> : null}
            {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.label}</option>)}
          </select>
          <Button
            size="sm"
            disabled={!onAttach || !targetSegmentId || pickedList.filter((item) => item.kind === 'image').length === 0}
            onClick={() => {
              if (!onAttach || !targetSegmentId) return
              const ok = onAttach(targetSegmentId, pickedList.filter((item) => item.kind === 'image'))
              if (ok) setPicked({})
            }}
          >
            把选中图片挂到该片段
          </Button>
          <span className="text-[10px] text-muted-foreground">音频/视频挂载下一步接入</span>
        </div>
      </div>

      {/* ③ 生成 */}
      <div className="flex shrink-0 flex-col gap-1" style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}>
        {section('生成', '用用户工作流补齐缺失资源（下一步接入）')}
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">当前清单：</span>
          {pickedList.length === 0
            ? <span className="text-muted-foreground">（空）</span>
            : pickedList.map((item) => (
              <span key={`${item.subfolder}/${item.name}`} className="rounded-full px-1.5" style={{ border: `1px solid ${BORDER}` }}>
                {item.kind}:{item.name}
              </span>
            ))}
          <span className="ml-auto" />
          <Button size="sm" variant="secondary" disabled title="下一步：选择用户工作流并提交生成任务">生成缺失资源</Button>
        </div>
      </div>
    </div>
  )
}
