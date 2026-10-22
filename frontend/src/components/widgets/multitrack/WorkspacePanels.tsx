import { relationshipOptions, type ProjectResource } from './agentStore'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

export interface WorkspaceSubject {
  id: string
  name: string
  type: string
  description: string
  retention: string[]
  /** 关联的项目资源（图片/视频/音频）id */
  childResourceIds?: string[]
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
  resources,
}: {
  subjects: WorkspaceSubject[]
  onChange?: (next: WorkspaceSubject[]) => void
  resources?: ProjectResource[]
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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-xs text-muted-foreground">
        <div>主体库还是空的。</div>
        <div>可以直接新增主体；也可以在「分镜编排」生成后一键导入主体。</div>
        <Button
          size="sm"
          onClick={() => {
            if (!onChange) return
            const id = `subject-local-${Date.now()}`
            onChange([...subjects, { id, name: '新主体', type: '人物', description: '', retention: [], childResourceIds: [] }])
            setSelectedId(id)
          }}
        >
          ＋ 新增主体
        </Button>
      </div>
    )  }

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
              onChange([...subjects, { id, name: '新主体', type: '人物', description: '', retention: [], childResourceIds: [] }])
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
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">关联资源（生成时作为该主体的参考图片/视频/音频）</span>
              <div className="flex flex-wrap items-center gap-1">
                {(selected.childResourceIds ?? []).length === 0 ? (
                  <span className="text-[10px] text-muted-foreground">（未关联）</span>
                ) : (selected.childResourceIds ?? []).map((childId) => {
                  const child = (resources ?? []).find((item) => item.id === childId)
                  return (
                    <span
                      key={childId}
                      className="flex items-center gap-1 rounded-full px-1.5 text-[10px]"
                      style={{ border: `1px solid ${BORDER}` }}
                      title={child ? `${child.type} · ${child.relationship}` : childId}
                    >
                      {child ? `${child.type}:${child.name}` : childId}
                      <button
                        type="button"
                        className="text-muted-foreground"
                        onClick={() => patch(selected.id, {
                          childResourceIds: (selected.childResourceIds ?? []).filter((id) => id !== childId),
                        })}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
              <BindingPicker
                resources={resources ?? []}
                selected={selected.childResourceIds ?? []}
                onAdd={(id) => patch(selected.id, { childResourceIds: [...(selected.childResourceIds ?? []), id] })}
              />
            </div>
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

/** ③ 项目资源：左=资源池（定义/编辑/生成），中=共享资源浏览器（可拖宽），右=AI 助手（弹窗层常驻）。 */
export function ResourcesTab({
  resources = [],
  onAddFromShared,
  onPatch,
  onRemove,
  onCreateEmpty,
}: {
  resources?: ProjectResource[]
  onAddFromShared?: (item: { name: string; subfolder: string; kind: 'image' | 'audio' | 'video' }) => void
  onPatch?: (id: string, patch: Partial<ProjectResource>) => void
  onRemove?: (id: string) => void
  onCreateEmpty?: () => void
}) {
  const [group, setGroup] = useState<'Picture' | 'Audio' | 'Video' | 'Subject'>('Picture')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)

  const [kind, setKind] = useState<'all' | 'image' | 'audio' | 'video'>('image')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'name' | 'time'>('name')
  const [items, setItems] = useState<WorkspaceResourceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [thumbSize, setThumbSize] = useState(72)

  // 中栏宽度（可拖拽，记忆）
  const [middleWidth, setMiddleWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem('easy-media-resources-middle-width')
      return raw ? Math.max(320, Math.min(900, Number(raw) || 560)) : 560
    } catch {
      return 560
    }
  })
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  useEffect(() => {
    try {
      window.localStorage.setItem('easy-media-resources-middle-width', String(middleWidth))
    } catch {
      /* ignore */
    }
  }, [middleWidth])
  useEffect(() => {
    function onMove(event: MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      const next = Math.max(320, Math.min(900, drag.startWidth + (drag.startX - event.clientX)))
      setMiddleWidth(next)
    }
    function onUp() {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ kind, limit: '300', sort })
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
  }, [kind, query, sort])

  const byType = useMemo(() => ({
    Picture: resources.filter((item) => item.type === 'Picture'),
    Audio: resources.filter((item) => item.type === 'Audio'),
    Video: resources.filter((item) => item.type === 'Video'),
    Subject: resources.filter((item) => item.type === 'Subject'),
  }), [resources])

  const addShared = (item: WorkspaceResourceItem) => {
    onAddFromShared?.({ name: item.name, subfolder: item.subfolder, kind: item.kind })
  }

  const statusBadge = (resource: ProjectResource) => {
    if (resource.type === 'Subject') return { text: '主体', color: '#fbbf24' }
    if (resource.status === 'ready') return { text: '已就绪', color: 'hsl(var(--primary, 199 89% 48%))' }
    if (resource.status === 'generating') return { text: '生成中', color: 'hsl(var(--primary, 199 89% 48%))' }
    if (resource.status === 'failed') return { text: '失败', color: '#f87171' }
    return { text: '缺', color: '#fbbf24' }
  }

  const poolList = byType[group]

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：项目资源池 */}
      <div
        className="flex min-w-0 flex-1 flex-col gap-2 p-2"
        onDragOver={(event) => {
          if (!onAddFromShared) return
          event.preventDefault()
          setDropActive(true)
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          setDropActive(false)
          const raw = event.dataTransfer.getData('text/easymedia-shared-resource')
          if (!raw || !onAddFromShared) return
          event.preventDefault()
          try {
            const parsed = JSON.parse(raw) as { name: string; subfolder: string; kind: 'image' | 'audio' | 'video' }
            onAddFromShared(parsed)
          } catch {
            /* ignore */
          }
        }}
        style={dropActive ? { outline: '1px dashed hsl(var(--primary, 199 89% 48%))', outlineOffset: -4 } : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium">项目资源（{resources.filter((item) => item.type !== 'Subject').length}）</span>
          {(['Picture', 'Audio', 'Video', 'Subject'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded px-2 py-0.5 text-[11px]"
              style={{
                border: `1px solid ${group === key ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
                color: group === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
              }}
              onClick={() => setGroup(key)}
            >
              {{ Picture: '图片', Audio: '音频', Video: '视频', Subject: '主体' }[key]} {byType[key].length}
            </button>
          ))}
          <span className="ml-auto" />
          {onCreateEmpty ? (
            <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={onCreateEmpty}>
              ＋ 新建资源
            </Button>
          ) : null}
        </div>

        {group === 'Subject' ? (
          <div className="rounded px-2 py-1 text-[10px] text-muted-foreground" style={{ border: `1px dashed ${BORDER}` }}>
            主体的定义与关联资源在「主体」页编辑；这里只读汇总。
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto">
          {poolList.length === 0 ? (
            <div className="px-1 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {group === 'Subject'
                ? '还没有主体，去「主体」页新增或从分镜导入。'
                : '还没有资源。可以从右侧共享资源拖进来，或点缩略图直接添加。'}
            </div>
          ) : poolList.map((resource) => {
            const badge = statusBadge(resource)
            const expanded = expandedId === resource.id
            return (
              <div key={resource.id} className="flex flex-col gap-1 rounded-md p-2" style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded px-1 text-[10px]" style={{ border: `1px solid ${badge.color}`, color: badge.color }}>{badge.text}</span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[12px] font-medium"
                    onClick={() => {
                      setExpandedId(expanded ? null : resource.id)
                    }}
                  >
                    {resource.name || '未命名资源'}
                  </button>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{resource.relationship}</span>
                  {resource.childResourceIds?.length ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">子资源 {resource.childResourceIds.length}</span>
                  ) : null}
                  <button type="button" className="shrink-0 rounded px-1 text-[10px]" style={{ border: `1px solid ${BORDER}` }} onClick={() => setExpandedId(expanded ? null : resource.id)}>
                    {expanded ? '收起' : '编辑'}
                  </button>
                </div>

                {expanded ? (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground">名称</span>
                      <input
                        style={{ ...fieldStyle, width: 200 }}
                        value={resource.name}
                        onChange={(event) => onPatch?.(resource.id, { name: event.target.value })}
                      />
                      <span className="text-muted-foreground">引用关系</span>
                      <select
                        style={{ ...fieldStyle, width: 210 }}
                        value={resource.relationship}
                        onChange={(event) => onPatch?.(resource.id, { relationship: event.target.value })}
                        disabled={resource.type === 'Subject'}
                      >
                        {relationshipOptions(resource.type).map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      style={{ ...fieldStyle, minHeight: 56, resize: 'vertical', lineHeight: 1.6 }}
                      placeholder="定义描述（会作为参考语义写进提示词）"
                      value={resource.description}
                      onChange={(event) => onPatch?.(resource.id, { description: event.target.value })}
                    />
                    <input
                      style={fieldStyle}
                      placeholder="保留项（逗号分隔：身份/服装/涂装/场地…）"
                      value={(resource.retention ?? []).join('，')}
                      onChange={(event) => onPatch?.(resource.id, {
                        retention: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
                      })}
                    />
                    {resource.type !== 'Subject' && resource.status !== 'ready' ? (
                      <>
                        <textarea
                          style={{ ...fieldStyle, minHeight: 44, resize: 'vertical' }}
                          placeholder="生成 brief：这张图/这段音要什么（后续接用户工作流）"
                          value={resource.generator?.brief ?? ''}
                          onChange={(event) => onPatch?.(resource.id, {
                            generator: { ...(resource.generator ?? {}), brief: event.target.value },
                          })}
                        />
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" disabled title="下一步：选择用户工作流生成">
                            生成此资源（下一步）
                          </Button>
                          <span className="text-[10px] text-muted-foreground">生成通道在 P3 接入</span>
                        </div>
                      </>
                    ) : null}
                    <div className="flex items-center gap-2">
                      {resource.sharedPath ? (
                        <span className="min-w-0 truncate text-[10px] text-muted-foreground">{resource.sharedPath}</span>
                      ) : null}
                      <span className="ml-auto" />
                      {onRemove ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => onRemove(resource.id)}
                        >
                          删除
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {/* 可拖拽分隔条 */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整共享资源栏宽度（双击复位）"
        className="w-[6px] shrink-0 cursor-col-resize"
        style={{ borderLeft: `1px solid ${BORDER}`, background: 'transparent' }}
        onMouseDown={(event) => {
          dragRef.current = { startX: event.clientX, startWidth: middleWidth }
        }}
        onDoubleClick={() => setMiddleWidth(560)}
      />

      {/* 中：共享资源浏览器 */}
      <div className="flex shrink-0 flex-col gap-2 p-2" style={{ width: middleWidth }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium">共享资源（ComfyUI/input）</span>
          {(['all', 'image', 'audio', 'video'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded px-2 py-0.5 text-[11px]"
              style={{
                border: `1px solid ${kind === key ? 'hsl(var(--primary, 199 89% 48%))' : BORDER}`,
                color: kind === key ? 'hsl(var(--primary, 199 89% 48%))' : undefined,
              }}
              onClick={() => setKind(key)}
            >
              {{ all: '全部', image: '图片', audio: '音频', video: '视频' }[key]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            style={{ ...fieldStyle, width: 150 }}
            placeholder="按文件名过滤"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select style={{ ...fieldStyle, width: 100 }} value={sort} onChange={(event) => setSort(event.target.value as 'name' | 'time')}>
            <option value="name">按名称</option>
            <option value="time">最新优先</option>
          </select>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            尺寸
            <input
              type="range"
              min={48}
              max={160}
              step={4}
              value={thumbSize}
              onChange={(event) => setThumbSize(Number(event.target.value))}
              style={{ width: 90 }}
            />
            <span className="tabular-nums">{thumbSize}</span>
          </label>
          <span className="text-[10px] text-muted-foreground">{loading ? '扫描中…' : `${items.length} 个`}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">拖到左侧空白处新建资源；点缩略图直接添加。</div>
        {error ? (
          <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>{error}</div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-auto">
          {items.map((item) => {
            const key = `${item.subfolder}/${item.name}`
            return (
              <button
                key={key}
                type="button"
                draggable
                title={`${key}（点击添加 / 拖到左侧）`}
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/easymedia-shared-resource', JSON.stringify({
                    name: item.name,
                    subfolder: item.subfolder,
                    kind: item.kind,
                  }))
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => addShared(item)}
                className="flex flex-col overflow-hidden rounded-md text-left"
                style={{ width: thumbSize, border: `1px solid ${BORDER}`, background: FIELD_BG }}
              >
                <div className="flex items-center justify-center overflow-hidden bg-black/40" style={{ height: Math.round(thumbSize * 0.72) }}>
                  {item.kind === 'image'
                    ? <img src={item.url} alt={item.name} className="h-full w-full object-cover" loading="lazy" draggable={false} />
                    : <span className="text-base">{item.kind === 'audio' ? '♪' : '▶'}</span>}
                </div>
                <div className="truncate px-1 py-0.5 text-[10px]">{item.name}</div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}


/** 主体关联资源选择器：从项目资源中挑图片/视频/音频 */
function BindingPicker({
  resources,
  selected,
  onAdd,
}: {
  resources: ProjectResource[]
  selected: string[]
  onAdd: (id: string) => void
}) {
  const candidates = resources.filter((item) => item.type !== 'Subject' && !selected.includes(item.id))
  if (candidates.length === 0) {
    return <span className="text-[10px] text-muted-foreground">（项目资源里还没有可关联的图片/视频/音频）</span>
  }
  return (
    <select
      style={{ ...fieldStyle, width: 260 }}
      value=""
      onChange={(event) => {
        if (event.target.value) onAdd(event.target.value)
      }}
    >
      <option value="">＋ 关联一个项目资源…</option>
      {candidates.map((item) => (
        <option key={item.id} value={item.id}>
          {item.type}：{item.name}{item.status === 'need' ? '（未生成）' : ''}
        </option>
      ))}
    </select>
  )
}
