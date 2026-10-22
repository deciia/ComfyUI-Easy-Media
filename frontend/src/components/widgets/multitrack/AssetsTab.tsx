import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { relationshipOptions, type ProjectResource } from './agentStore'
import type { WorkspaceSubject, WorkspaceResourceItem } from './WorkspacePanels'

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

type Selection = { kind: 'subject'; id: string } | { kind: 'resource'; id: string } | null

export interface AssetsTabProps {
  subjects: WorkspaceSubject[]
  onSubjectsChange?: (next: WorkspaceSubject[]) => void
  resources: ProjectResource[]
  onAddFromShared?: (item: { name: string; subfolder: string; kind: 'image' | 'audio' | 'video' }) => void
  onPatch?: (id: string, patch: Partial<ProjectResource>) => void
  onRemove?: (id: string) => void
  onCreateEmpty?: () => void
}

/** 主体与资源：左=主体/资源列表，中=详情（定义+引用资源），右=共享资源浏览器；AI 助手在弹窗右栏。 */
export function AssetsTab({
  subjects,
  onSubjectsChange,
  resources,
  onAddFromShared,
  onPatch,
  onRemove,
  onCreateEmpty,
}: AssetsTabProps) {
  const [selection, setSelection] = useState<Selection>(null)
  const [resType, setResType] = useState<'Picture' | 'Audio' | 'Video'>('Picture')
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // 共享资源浏览器
  const [kind, setKind] = useState<'all' | 'image' | 'audio' | 'video'>('image')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'name' | 'time'>('name')
  const [items, setItems] = useState<WorkspaceResourceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [thumbSize, setThumbSize] = useState(72)
  const [browserWidth, setBrowserWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem('easy-media-assets-browser-width')
      return raw ? Math.max(320, Math.min(900, Number(raw) || 560)) : 560
    } catch {
      return 560
    }
  })
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  useEffect(() => {
    try {
      window.localStorage.setItem('easy-media-assets-browser-width', String(browserWidth))
    } catch {
      /* ignore */
    }
  }, [browserWidth])
  useEffect(() => {
    function onMove(event: MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      setBrowserWidth(Math.max(320, Math.min(900, drag.startWidth + (drag.startX - event.clientX))))
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

  const mediaResources = useMemo(() => resources.filter((item) => item.type !== 'Subject'), [resources])
  const byType = useMemo(() => ({
    Picture: mediaResources.filter((item) => item.type === 'Picture'),
    Audio: mediaResources.filter((item) => item.type === 'Audio'),
    Video: mediaResources.filter((item) => item.type === 'Video'),
  }), [mediaResources])

  const subject = selection?.kind === 'subject' ? subjects.find((item) => item.id === selection.id) : undefined
  const resource = selection?.kind === 'resource' ? resources.find((item) => item.id === selection.id) : undefined

  const patchSubject = (id: string, patch: Partial<WorkspaceSubject>) => {
    if (!onSubjectsChange) return
    onSubjectsChange(subjects.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const addSubject = () => {
    if (!onSubjectsChange) return
    const id = `subject-local-${Date.now()}`
    onSubjectsChange([...subjects, { id, name: '新主体', type: '人物', description: '', retention: [], childResourceIds: [] }])
    setSelection({ kind: 'subject', id })
  }

  const bindChild = (subjectId: string, resourceId: string) => {
    const target = subjects.find((item) => item.id === subjectId)
    if (!target) return
    const current = target.childResourceIds ?? []
    if (current.includes(resourceId)) return
    patchSubject(subjectId, { childResourceIds: [...current, resourceId] })
  }

  const addShared = (item: WorkspaceResourceItem) => onAddFromShared?.({ name: item.name, subfolder: item.subfolder, kind: item.kind })

  const dropProps = (onDrop: (event: React.DragEvent) => void, active: boolean) => ({
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      setDropTarget(active ? 'active' : null)
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (event: React.DragEvent) => {
      setDropTarget(null)
      event.preventDefault()
      onDrop(event)
    },
  })

  const parseShared = (event: React.DragEvent) => {
    const raw = event.dataTransfer.getData('text/easymedia-shared-resource')
    if (!raw) return null
    try {
      return JSON.parse(raw) as { name: string; subfolder: string; kind: 'image' | 'audio' | 'video' }
    } catch {
      return null
    }
  }

  const detail = subject ? (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          style={{ ...fieldStyle, width: 180, fontWeight: 600 }}
          value={subject.name}
          onChange={(event) => patchSubject(subject.id, { name: event.target.value })}
        />
        <select style={{ ...fieldStyle, width: 96 }} value={subject.type} onChange={(event) => patchSubject(subject.id, { type: event.target.value })}>
          {['人物', '场景', '物体', '风格'].map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <span className="ml-auto" />
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          onClick={() => {
            if (!onSubjectsChange) return
            onSubjectsChange(subjects.filter((item) => item.id !== subject.id))
            setSelection(null)
          }}
        >
          删除主体
        </Button>
      </div>
      <textarea
        style={{ ...fieldStyle, minHeight: 96, resize: 'vertical', lineHeight: 1.6 }}
        placeholder="外观、身份、性格、与其它主体的关系…"
        value={subject.description}
        onChange={(event) => patchSubject(subject.id, { description: event.target.value })}
      />
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">保留项（逗号分隔）</span>
        <input
          style={fieldStyle}
          value={subject.retention.join('，')}
          onChange={(event) => patchSubject(subject.id, {
            retention: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
          })}
        />
      </label>
      <div
        className="flex flex-col gap-1 rounded p-2"
        style={{ border: `1px dashed ${dropTarget === 'subject' ? PRIMARY : BORDER}` }}
        {...dropProps((event) => {
          const shared = parseShared(event)
          if (shared) {
            onAddFromShared?.(shared)
            return
          }
          const id = event.dataTransfer.getData('text/easymedia-resource-id')
          if (id) bindChild(subject.id, id)
        }, true)}
      >
        <span className="text-[11px] text-muted-foreground">引用资源（可把左侧资源或右侧共享资源拖到这里）</span>
        <div className="flex flex-wrap items-center gap-1">
          {(subject.childResourceIds ?? []).length === 0 ? (
            <span className="text-[10px] text-muted-foreground">（未引用）</span>
          ) : (subject.childResourceIds ?? []).map((childId) => {
            const child = resources.find((item) => item.id === childId)
            return (
              <span key={childId} className="flex items-center gap-1 rounded-full px-1.5 text-[10px]" style={{ border: `1px solid ${BORDER}` }} title={child ? `${child.type} · ${child.relationship}` : childId}>
                {child ? `${child.type}：${child.name}` : childId}
                <button type="button" className="text-muted-foreground" onClick={() => patchSubject(subject.id, { childResourceIds: (subject.childResourceIds ?? []).filter((id) => id !== childId) })}>×</button>
              </span>
            )
          })}
        </div>
        <BindingPicker resources={resources} selected={subject.childResourceIds ?? []} onAdd={(id) => bindChild(subject.id, id)} />
      </div>
    </div>
  ) : resource ? (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          style={{ ...fieldStyle, width: 200, fontWeight: 600 }}
          value={resource.name}
          onChange={(event) => onPatch?.(resource.id, { name: event.target.value })}
        />
        <span className="rounded px-1 text-[10px]" style={{ border: `1px solid ${BORDER}` }}>
          {resource.type} · {resource.status === 'ready' ? '已就绪' : resource.status === 'need' ? '缺' : resource.status}
        </span>
        <span className="ml-auto" />
        {onRemove ? (
          <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => { onRemove(resource.id); setSelection(null) }}>
            删除资源
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">引用关系</span>
        <select
          style={{ ...fieldStyle, width: 240 }}
          value={resource.relationship}
          onChange={(event) => onPatch?.(resource.id, { relationship: event.target.value })}
        >
          {relationshipOptions(resource.type).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <textarea
        style={{ ...fieldStyle, minHeight: 96, resize: 'vertical', lineHeight: 1.6 }}
        placeholder="定义描述（会作为参考语义写进提示词）"
        value={resource.description}
        onChange={(event) => onPatch?.(resource.id, { description: event.target.value })}
      />
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">保留项（逗号分隔）</span>
        <input
          style={fieldStyle}
          value={(resource.retention ?? []).join('，')}
          onChange={(event) => onPatch?.(resource.id, {
            retention: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
          })}
        />
      </label>
      {resource.status !== 'ready' ? (
        <>
          <textarea
            style={{ ...fieldStyle, minHeight: 60, resize: 'vertical' }}
            placeholder="生成 brief：这张图/这段音要什么（P3 接用户工作流）"
            value={resource.generator?.brief ?? ''}
            onChange={(event) => onPatch?.(resource.id, { generator: { ...(resource.generator ?? {}), brief: event.target.value } })}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" disabled title="P3 接入生成通道">生成此资源（下一步）</Button>
            <span className="text-[10px] text-muted-foreground">生成通道在 P3 接入</span>
          </div>
        </>
      ) : null}
      {resource.sharedPath ? <div className="truncate text-[10px] text-muted-foreground">{resource.sharedPath}</div> : null}
    </div>
  ) : (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-[11px] leading-relaxed text-muted-foreground">
      左侧选择主体或资源开始编辑。
      <br />主体可引用项目资源；资源可定义关系/保留项/生成 brief。
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1">
      {/* 列1：主体 + 资源 */}
      <div className="flex w-[250px] shrink-0 flex-col gap-1 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-muted-foreground">
          <span>主体（{subjects.length}）</span>
          <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={addSubject}>＋ 新增</button>
        </div>
        {subjects.map((item) => {
          const active = selection?.kind === 'subject' && selection.id === item.id
          return (
            <button
              key={item.id}
              type="button"
              draggable={false}
              onClick={() => setSelection({ kind: 'subject', id: item.id })}
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left"
              style={{ background: active ? `${PRIMARY} / 0.16` : FIELD_BG, border: `1px solid ${active ? PRIMARY : BORDER}` }}
            >
              <span className="truncate text-[12px] font-medium">{item.name}</span>
              <span className="text-[10px] text-muted-foreground">{item.type} · 引用 {(item.childResourceIds ?? []).length}</span>
            </button>
          )
        })}

        <div className="mt-1 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
          <span>资源（{mediaResources.length}）</span>
          <span className="ml-auto" />
          {onCreateEmpty ? (
            <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={onCreateEmpty}>＋ 新建</button>
          ) : null}
        </div>
        <div className="flex gap-1 px-1">
          {(['Picture', 'Audio', 'Video'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={{
                border: `1px solid ${resType === key ? PRIMARY : BORDER}`,
                color: resType === key ? PRIMARY : undefined,
              }}
              onClick={() => setResType(key)}
            >
              {{ Picture: '图片', Audio: '音频', Video: '视频' }[key]} {byType[key].length}
            </button>
          ))}
        </div>
        <div
          className="flex min-h-[80px] flex-col gap-1 rounded p-1"
          style={{ border: `1px dashed ${dropTarget === 'pool' ? PRIMARY : 'transparent'}` }}
          {...dropProps((event) => {
            const shared = parseShared(event)
            if (shared) onAddFromShared?.(shared)
          }, true)}
        >
          {byType[resType].length === 0 ? (
            <div className="px-1 text-[10px] leading-relaxed text-muted-foreground">还没有{ { Picture: '图片', Audio: '音频', Video: '视频' }[resType] }资源：从右侧点击/拖入，或点「＋ 新建」。</div>
          ) : byType[resType].map((item) => {
            const active = selection?.kind === 'resource' && selection.id === item.id
            return (
              <button
                key={item.id}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/easymedia-resource-id', item.id)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => setSelection({ kind: 'resource', id: item.id })}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-left"
                style={{ background: active ? `${PRIMARY} / 0.16` : FIELD_BG, border: `1px solid ${active ? PRIMARY : BORDER}` }}
              >
                <span
                  className="shrink-0 rounded px-1 text-[9px]"
                  style={{
                    border: `1px solid ${item.status === 'ready' ? PRIMARY : '#fbbf24'}`,
                    color: item.status === 'ready' ? PRIMARY : '#fbbf24',
                  }}
                >
                  {item.status === 'ready' ? '✓' : item.status === 'need' ? '缺' : item.status === 'generating' ? '…' : '!'}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px]">{item.name}</span>
                <span className="shrink-0 text-[9px] text-muted-foreground">{item.relationship.replace(/_/g, ' ')}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 列2：详情 */}
      <div className="flex w-[340px] shrink-0 flex-col gap-2 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="text-[11px] text-muted-foreground">详情</div>
        {detail}
      </div>

      {/* 可拖拽分隔条 */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整共享资源宽度（双击复位）"
        className="w-[6px] shrink-0 cursor-col-resize"
        style={{ borderLeft: `1px solid ${BORDER}` }}
        onMouseDown={(event) => { dragRef.current = { startX: event.clientX, startWidth: browserWidth } }}
        onDoubleClick={() => setBrowserWidth(560)}
      />

      {/* 列3：共享资源 */}
      <div className="flex shrink-0 flex-col gap-2 p-2" style={{ width: browserWidth }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium">共享资源（input）</span>
          {(['all', 'image', 'audio', 'video'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded px-2 py-0.5 text-[11px]"
              style={{ border: `1px solid ${kind === key ? PRIMARY : BORDER}`, color: kind === key ? PRIMARY : undefined }}
              onClick={() => setKind(key)}
            >
              {{ all: '全部', image: '图片', audio: '音频', video: '视频' }[key]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input style={{ ...fieldStyle, width: 140 }} placeholder="按文件名过滤" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select style={{ ...fieldStyle, width: 96 }} value={sort} onChange={(event) => setSort(event.target.value as 'name' | 'time')}>
            <option value="name">按名称</option>
            <option value="time">最新优先</option>
          </select>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            尺寸
            <input type="range" min={48} max={160} step={4} value={thumbSize} onChange={(event) => setThumbSize(Number(event.target.value))} style={{ width: 80 }} />
            <span className="tabular-nums">{thumbSize}</span>
          </label>
          <span className="text-[10px] text-muted-foreground">{loading ? '扫描中…' : `${items.length} 个`}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">点击=加入资源池；拖到主体=引用；拖到资源列表=新建。</div>
        {error ? <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>{error}</div> : null}
        <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-auto">
          {items.map((item) => (
            <button
              key={`${item.subfolder}/${item.name}`}
              type="button"
              draggable
              title={`${item.subfolder}/${item.name}`}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/easymedia-shared-resource', JSON.stringify({ name: item.name, subfolder: item.subfolder, kind: item.kind }))
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
          ))}
        </div>
      </div>
    </div>
  )
}

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
    return <span className="text-[10px] text-muted-foreground">（项目资源里还没有可引用的图片/视频/音频）</span>
  }
  return (
    <select
      style={{ ...fieldStyle, width: 260 }}
      value=""
      onChange={(event) => {
        if (event.target.value) onAdd(event.target.value)
      }}
    >
      <option value="">＋ 引用一个项目资源…</option>
      {candidates.map((item) => (
        <option key={item.id} value={item.id}>
          {item.type}：{item.name}{item.status === 'need' ? '（未生成）' : ''}
        </option>
      ))}
    </select>
  )
}
