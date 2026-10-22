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
  onAddFromShared?: (item: { name: string; subfolder: string; kind: 'image' | 'audio' | 'video' }) => ProjectResource | void
  onPatch?: (id: string, patch: Partial<ProjectResource>) => void
  onRemove?: (id: string) => void
  onCreateEmpty?: () => void
  onBindFile?: (id: string, item: { name: string; subfolder?: string; kind: 'image' | 'audio' | 'video'; root?: 'input' | 'output' | 'temp' }) => void
  onUnbindFile?: (id: string) => void
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
  onBindFile,
  onUnbindFile,
}: AssetsTabProps) {
  const [selection, setSelection] = useState<Selection>(null)
  const [resType, setResType] = useState<'Picture' | 'Audio' | 'Video'>('Picture')
  const [leftTab, setLeftTab] = useState<'subject' | 'resource'>('subject')
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // 进入本页时默认选中「主体」页签的第一个主体，避免详情区空着
  useEffect(() => {
    if (selection) return
    if (subjects.length > 0) setSelection({ kind: 'subject', id: subjects[0].id })
  }, [selection, subjects])

  const [childTab, setChildTab] = useState<'Picture' | 'Audio' | 'Video'>('Picture')
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [childHint, setChildHint] = useState('')
  const descRef = useRef<HTMLTextAreaElement | null>(null)

  // 共享资源浏览器
  const [root, setRoot] = useState<'input' | 'output' | 'temp'>('input')
  const [browseMode, setBrowseMode] = useState<'flat' | 'folders'>('flat')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [currentDir, setCurrentDir] = useState('')
  const [folders, setFolders] = useState<Array<{ name: string; path: string }>>([])
  const [reloadToken, setReloadToken] = useState(0)
  const [kind, setKind] = useState<'all' | 'image' | 'audio' | 'video'>('image')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'name' | 'time'>('name')
  const [items, setItems] = useState<WorkspaceResourceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [thumbSize, setThumbSize] = useState(72)
  const [browserWidth, setBrowserWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem('easy-media-assets-browser-width-v2')
      return raw ? Math.max(280, Math.min(900, Number(raw) || 460)) : 460
    } catch {
      return 560
    }
  })
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  useEffect(() => {
    try {
      window.localStorage.setItem('easy-media-assets-browser-width-v2', String(browserWidth))
    } catch {
      /* ignore */
    }
  }, [browserWidth])
  useEffect(() => {
    function onMove(event: MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      setBrowserWidth(Math.max(280, Math.min(900, drag.startWidth + (drag.startX - event.clientX))))
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
    const params = new URLSearchParams({ kind, limit: '400', sort, root, mode: browseMode })
    if (query.trim()) params.set('query', query.trim())
    if (currentDir) params.set('dir', currentDir)
    fetch(`/easy-media/resources/input?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        if (!data?.ok) setError(String(data?.error || '扫描共享资源失败'))
        else {
          setItems(Array.isArray(data.items) ? data.items : [])
          setFolders(Array.isArray(data.folders) ? data.folders : [])
        }
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [kind, query, sort, root, browseMode, currentDir, reloadToken])

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

  const addShared = (item: WorkspaceResourceItem) => onAddFromShared?.({ name: item.name, subfolder: item.subfolder, kind: item.kind, root } as never)

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
    <div
      className="flex flex-col gap-2"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('text/easymedia-shared-resource')) event.preventDefault()
      }}
      onDrop={(event) => {
        // 兜底：拖到详情任意处也添加引用（按共享资源自身类型落到对应行）
        const shared = parseShared(event)
        if (!shared) return
        event.preventDefault()
        event.stopPropagation()
        const created = onAddFromShared?.(shared)
        const createdId = (created as ProjectResource | undefined)?.id
        if (createdId) {
          bindChild(subject.id, createdId)
          setChildHint(`已添加引用：${shared.name}`)
        }
      }}
    >
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

      {/* 1. 描述（支持 @ 引用） */}
      <div className="flex flex-col gap-1">
        <textarea
          ref={descRef}
          style={{ ...fieldStyle, minHeight: 88, resize: 'vertical', lineHeight: 1.6 }}
          placeholder="外观、身份、性格、与其它主体的关系…（输入 @ 可引用已定义的主体/资源）"
          value={subject.description}
          onChange={(event) => {
            const value = event.target.value
            patchSubject(subject.id, { description: value })
            const caret = event.target.selectionStart ?? value.length
            const before = value.slice(0, caret)
            const at = before.lastIndexOf('@')
            if (at >= 0 && !/\s/.test(before.slice(at + 1))) {
              setMentionQuery(before.slice(at + 1))
              setMentionOpen(true)
            } else {
              setMentionOpen(false)
            }
          }}
          onBlur={() => {
            window.setTimeout(() => setMentionOpen(false), 150)
            const mentions = Array.from(subject.description.matchAll(/<@([^>]+)>/g)).map((match) => match[1].trim())
            if (mentions.length === 0) return
            const childIds = new Set(subject.childResourceIds ?? [])
            for (const name of mentions) {
              const media = resources.find((item) => item.type !== 'Subject' && item.name === name)
              if (media) childIds.add(media.id)
            }
            if (childIds.size !== (subject.childResourceIds ?? []).length) {
              patchSubject(subject.id, { childResourceIds: Array.from(childIds) })
            }
          }}
        />
        {(() => {
          const names = Array.from(subject.description.matchAll(/<@([^>]+)>/g)).map((match) => match[1].trim())
          const unmatched = names.filter((name) => !subjects.some((item) => item.name === name) && !resources.some((item) => item.name === name))
          if (unmatched.length === 0) return null
          return <div className="text-[10px]" style={{ color: '#fbbf24' }}>未匹配引用：{unmatched.map((name) => `<@${name}>`).join('、')}</div>
        })()}
        {mentionOpen ? (
          <div className="max-h-40 overflow-auto rounded border p-1 text-[11px]" style={{ borderColor: BORDER, background: FIELD_BG }}>
            {(() => {
              const candidates = [
                ...subjects.filter((item) => item.id !== subject.id).map((item) => ({ name: item.name, kind: `主体·${item.type}` })),
                ...resources.filter((item) => item.type !== 'Subject').map((item) => ({ name: item.name, kind: item.type })),
              ].filter((item) => !mentionQuery || item.name.toLowerCase().includes(mentionQuery.toLowerCase()))
              if (candidates.length === 0) return <div className="px-1 text-muted-foreground">（没有匹配的主体/资源）</div>
              return candidates.slice(0, 30).map((item) => (
                <button
                  key={`${item.kind}-${item.name}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    const textarea = descRef.current
                    const value = subject.description
                    const caret = textarea?.selectionStart ?? value.length
                    const before = value.slice(0, caret)
                    const at = before.lastIndexOf('@')
                    const next = at >= 0
                      ? `${value.slice(0, at)}<@${item.name}> ${value.slice(caret)}`
                      : `${value}<@${item.name}> `
                    patchSubject(subject.id, { description: next })
                    setMentionOpen(false)
                    setMentionQuery('')
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{item.kind}</span>
                </button>
              ))
            })()}
          </div>
        ) : null}
      </div>

      {/* 2. 引用资源（三行类型带） */}
      <div className="flex flex-col gap-2 rounded p-2" style={{ border: `1px solid ${BORDER}` }}>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">引用资源</span>
          <span className="text-[10px] text-muted-foreground">从右侧共享资源拖到对应类型行（或本区域任意处）</span>
          {childHint ? <span className="ml-auto text-[10px]" style={{ color: PRIMARY }}>{childHint}</span> : null}
        </div>
        {(['Picture', 'Audio', 'Video'] as const).map((type) => {
          const children = (subject.childResourceIds ?? [])
            .map((id) => resources.find((item) => item.id === id))
            .filter((item): item is ProjectResource => Boolean(item) && item!.type === type)
          const label = { Picture: '图片', Audio: '音频', Video: '视频' }[type]
          const active = dropTarget === `child-${type}`
          return (
            <div
              key={type}
              className="flex flex-col gap-1 rounded p-1.5"
              style={{ border: `1px dashed ${active ? PRIMARY : BORDER}`, background: active ? `${PRIMARY} / 0.08` : 'transparent' }}
              onDragOver={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropTarget(`child-${type}`)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropTarget(null)
                const shared = parseShared(event)
                if (shared) {
                  const created = onAddFromShared?.(shared)
                  const createdId = (created as ProjectResource | undefined)?.id
                  if (createdId) {
                    bindChild(subject.id, createdId)
                    setChildHint(created?.type === type ? `已添加${label}：${shared.name}` : `已添加资源（类型：${created?.type ?? shared.kind}）`)
                  }
                  return
                }
                const id = event.dataTransfer.getData('text/easymedia-resource-id')
                const target = id ? resources.find((item) => item.id === id) : undefined
                if (!target) return
                if (target.type !== type) {
                  setChildHint(`类型不匹配：${target.type} 不能放进「${label}」`)
                  return
                }
                bindChild(subject.id, id)
                setChildHint(`已引用：${target.name}`)
              }}
            >
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5"
                  style={{ border: `1px solid ${childTab === type ? PRIMARY : BORDER}`, color: childTab === type ? PRIMARY : undefined }}
                  onClick={() => setChildTab(type)}
                >
                  {label} {children.length}
                </button>
                <span className="text-[10px] text-muted-foreground">拖到此行添加{label}</span>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {children.map((child) => {
                  const isActive = selectedChildId === child.id
                  const viewUrl = child.sharedPath
                    ? `/view?filename=${encodeURIComponent(child.imageFile ?? child.name)}&type=${child.sharedRoot ?? 'input'}${child.subfolder ? `&subfolder=${encodeURIComponent(child.subfolder)}` : ''}`
                    : ''
                  return (
                    <div key={child.id} className="relative">
                      <button
                        type="button"
                        title={`${child.name}（点击编辑保留项/引用关系）`}
                        className="flex h-16 w-16 items-center justify-center overflow-hidden rounded"
                        style={{ border: `1px solid ${isActive ? PRIMARY : BORDER}`, background: FIELD_BG }}
                        onClick={() => {
                          setChildTab(type)
                          setSelectedChildId(child.id)
                        }}
                      >
                        {type === 'Picture' && viewUrl ? (
                          <img src={viewUrl} alt={child.name} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="text-lg">{type === 'Audio' ? '♪' : type === 'Video' ? '▶' : '🖼'}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        title="解除引用"
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px]"
                        style={{ background: '#7f1d1d', color: '#fff', border: '1px solid #ef4444' }}
                        onClick={(event) => {
                          event.stopPropagation()
                          patchSubject(subject.id, {
                            childResourceIds: (subject.childResourceIds ?? []).filter((id) => id !== child.id),
                          })
                          if (selectedChildId === child.id) setSelectedChildId(null)
                          setChildHint(`已解除引用：${child.name}`)
                        }}
                      >
                        ×
                      </button>
                      <div className="w-16 truncate text-center text-[9px] text-muted-foreground">{child.name}</div>
                    </div>
                  )
                })}
                <BindingPicker
                  resources={resources.filter((item) => item.type === type)}
                  selected={subject.childResourceIds ?? []}
                  onAdd={(id) => bindChild(subject.id, id)}
                />
              </div>
            </div>
          )
        })}

        {(() => {
          const activeChild = (subject.childResourceIds ?? [])
            .map((id) => resources.find((item) => item.id === id))
            .find((item): item is ProjectResource => Boolean(item) && item!.id === selectedChildId)
          if (!activeChild) {
            return <span className="text-[10px] text-muted-foreground">点上方缩略图可编辑该资源的保留项与引用关系。</span>
          }
          return (
            <div className="flex flex-col gap-1 rounded p-1.5" style={{ border: `1px solid ${BORDER}`, background: FIELD_BG }}>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate">{activeChild.type}：{activeChild.name}</span>
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-muted-foreground"
                  style={{ border: `1px solid ${BORDER}` }}
                  onClick={() => {
                    patchSubject(subject.id, { childResourceIds: (subject.childResourceIds ?? []).filter((id) => id !== activeChild.id) })
                    setSelectedChildId(null)
                  }}
                >
                  解除引用
                </button>
              </div>
              <textarea
                style={{ ...fieldStyle, padding: '4px 6px', minHeight: 60, resize: 'vertical', lineHeight: 1.5 }}
                placeholder="保留项说明（可多行）：该资源在本片里要保持什么"
                value={(activeChild.retention ?? []).join('\n')}
                onChange={(event) => onPatch?.(activeChild.id, {
                  retention: event.target.value.split(/[\n，,]/).map((item) => item.trim()).filter(Boolean),
                })}
              />
              <select
                style={{ ...fieldStyle, padding: '2px 4px' }}
                value={activeChild.relationship}
                onChange={(event) => onPatch?.(activeChild.id, { relationship: event.target.value })}
              >
                {relationshipOptions(activeChild.type).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          )
        })()}
      </div>

      {/* 3. 主体保留项（放在引用资源下面） */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">主体保留项（可多行：身份/服装/涂装/场地…）</span>
        <textarea
          style={{ ...fieldStyle, padding: '4px 6px', minHeight: 64, resize: 'vertical', lineHeight: 1.5 }}
          placeholder="每行一条，例如：身份不变\n服装不变\n车辆涂装不变"
          value={subject.retention.join('\n')}
          onChange={(event) => patchSubject(subject.id, {
            retention: event.target.value.split(/[\n，,]/).map((item) => item.trim()).filter(Boolean),
          })}
        />
      </label>
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
      {(() => {
        const mediaKind: 'image' | 'audio' | 'video' = resource.type === 'Picture' ? 'image' : resource.type === 'Video' ? 'video' : 'audio'
        const boundFile = resource.type === 'Picture' ? resource.imageFile : resource.type === 'Video' ? resource.videoFile : resource.audioFile
        const viewUrl = boundFile
          ? `/view?filename=${encodeURIComponent(boundFile)}&type=${resource.sharedRoot ?? 'input'}${resource.subfolder ? `&subfolder=${encodeURIComponent(resource.subfolder)}` : ''}`
          : ''
        const slotActive = dropTarget === 'resource-slot'
        return (
          <div className="flex items-start gap-2">
            <textarea
              style={{ ...fieldStyle, minHeight: 96, resize: 'vertical', lineHeight: 1.6, flex: 1 }}
              placeholder="定义描述（会作为参考语义写进提示词）"
              value={resource.description}
              onChange={(event) => onPatch?.(resource.id, { description: event.target.value })}
            />
            <div
              className="relative flex shrink-0 items-center justify-center rounded p-1"
              style={{ width: 120, height: 108, border: `1px dashed ${slotActive ? PRIMARY : BORDER}`, background: slotActive ? `${PRIMARY} / 0.08` : FIELD_BG }}
              onDragOver={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropTarget('resource-slot')
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropTarget(null)
                const shared = parseShared(event)
                if (!shared) {
                  setChildHint('请从右侧共享资源拖入文件')
                  return
                }
                if (shared.kind !== mediaKind) {
                  const label = { image: '图片', audio: '音频', video: '视频' }[mediaKind]
                  setChildHint(`类型不匹配：这里是${label}槽，拖入的是${{ image: '图片', audio: '音频', video: '视频' }[shared.kind]}`)
                  return
                }
                onBindFile?.(resource.id, shared)
                setChildHint(`已绑定：${shared.name}`)
              }}
            >
              {boundFile ? (
                <>
                  {mediaKind === 'image' && viewUrl ? (
                    <img src={viewUrl} alt={boundFile} className="h-full w-full rounded object-cover" />
                  ) : (
                    <span className="text-2xl">{mediaKind === 'audio' ? '♪' : '▶'}</span>
                  )}
                  <button
                    type="button"
                    title="清除绑定（恢复缺件）"
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px]"
                    style={{ background: '#7f1d1d', color: '#fff', border: '1px solid #ef4444' }}
                    onClick={() => {
                      onUnbindFile?.(resource.id)
                      setChildHint('已清除绑定，资源恢复为「缺」')
                    }}
                  >
                    ×
                  </button>
                </>
              ) : (
                <span className="px-1 text-center text-[10px] leading-relaxed text-muted-foreground">
                  拖{{ image: '图片', audio: '音频', video: '视频' }[mediaKind]}到这里
                  <br />绑定后清除「缺」
                </span>
              )}
            </div>
          </div>
        )
      })()}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">保留项（逗号分隔）</span>
        <textarea
          style={{ ...fieldStyle, padding: '4px 6px', minHeight: 60, resize: 'vertical', lineHeight: 1.5 }}
          placeholder="每行一条保留项"
          value={(resource.retention ?? []).join('\n')}
          onChange={(event) => onPatch?.(resource.id, {
            retention: event.target.value.split(/[\n，,]/).map((item) => item.trim()).filter(Boolean),
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
      {/* 列1：主体 / 资源（两态切换） */}
      <div className="flex w-[250px] shrink-0 flex-col gap-1 overflow-hidden p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="flex gap-1">
          {([
            ['subject', `主体 ${subjects.length}`],
            ['resource', `资源 ${mediaResources.length}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="flex-1 rounded px-1 py-0.5 text-[11px]"
              style={{
                border: `1px solid ${leftTab === key ? PRIMARY : BORDER}`,
                color: leftTab === key ? PRIMARY : undefined,
                background: leftTab === key ? `${PRIMARY} / 0.12` : 'transparent',
              }}
              onClick={() => setLeftTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {leftTab === 'subject' ? (
          <>
            <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground">
              <span>人物 / 场景 / 物体 / 风格</span>
              <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={addSubject}>＋ 新增</button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
              {subjects.length === 0 ? (
                <div className="px-1 text-[10px] text-muted-foreground">还没有主体：点「＋ 新增」，或从分镜预览导入。</div>
              ) : subjects.map((item) => {
                const active = selection?.kind === 'subject' && selection.id === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelection({ kind: 'subject', id: item.id })}
                    className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left"
                    style={{ background: active ? `${PRIMARY} / 0.16` : FIELD_BG, border: `1px solid ${active ? PRIMARY : BORDER}` }}
                  >
                    <span className="truncate text-[12px] font-medium">{item.name}</span>
                    <span className="text-[10px] text-muted-foreground">{item.type} · 引用 {(item.childResourceIds ?? []).length}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground">
              <span>项目资源</span>
              {onCreateEmpty ? (
                <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={onCreateEmpty}>＋ 新建</button>
              ) : null}
            </div>
            <div className="flex gap-1">
              {(['Picture', 'Audio', 'Video'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className="flex-1 rounded px-1 py-0.5 text-[10px]"
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
              className="flex min-h-[80px] flex-1 flex-col gap-1 overflow-auto rounded p-1"
              style={{ border: `1px dashed ${dropTarget === 'pool' ? PRIMARY : 'transparent'}` }}
              {...dropProps((event) => {
                const shared = parseShared(event)
                if (shared) onAddFromShared?.(shared)
              }, true)}
            >
              {byType[resType].length === 0 ? (
                <div className="px-1 text-[10px] leading-relaxed text-muted-foreground">
                  还没有{ { Picture: '图片', Audio: '音频', Video: '视频' }[resType] }资源：从右侧点击/拖到「资源」页签，或点「＋ 新建」。
                </div>
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
          </>
        )}
      </div>

      {/* 列2：详情（弹性：宽度 = 总宽 − 左列 − 共享资源列） */}
      <div className="flex min-w-[240px] flex-1 flex-col gap-2 overflow-auto p-2" style={{ borderRight: `1px solid ${BORDER}` }}>
        <div className="text-[11px] text-muted-foreground">详情</div>
        {detail}
      </div>

      {/* 可拖拽分隔条 */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整共享资源宽度（双击复位）"
        className="group flex w-[18px] shrink-0 cursor-col-resize items-center justify-center hover:bg-white/5"
        style={{ borderLeft: `1px solid ${BORDER}` }}
        onMouseDown={(event) => { dragRef.current = { startX: event.clientX, startWidth: browserWidth } }}
        onDoubleClick={() => setBrowserWidth(460)}
      >
        <span className="h-16 w-[4px] rounded-full opacity-50 transition-opacity group-hover:opacity-100" style={{ background: PRIMARY }} />
      </div>

      {/* 列3：共享资源浏览器 */}
      <div className="flex shrink-0 flex-col gap-1.5 p-2" style={{ width: browserWidth }}>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            style={{ ...fieldStyle, width: 92, padding: '2px 4px' }}
            value={root}
            onChange={(event) => {
              setRoot(event.target.value as 'input' | 'output' | 'temp')
              setCurrentDir('')
            }}
          >
            <option value="input">input</option>
            <option value="output">output</option>
            <option value="temp">temp</option>
          </select>
          <span className="text-[12px] font-medium">共享资源</span>
          {(['all', 'image', 'audio', 'video'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ border: `1px solid ${kind === key ? PRIMARY : BORDER}`, color: kind === key ? PRIMARY : undefined }}
              onClick={() => setKind(key)}
            >
              {{ all: '全部', image: '图片', audio: '音频', video: '视频' }[key]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <input style={{ ...fieldStyle, width: 120, padding: '2px 4px' }} placeholder="按文件名过滤" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select style={{ ...fieldStyle, width: 86, padding: '2px 4px' }} value={sort} onChange={(event) => setSort(event.target.value as 'name' | 'time')}>
            <option value="name">按名称</option>
            <option value="time">最新优先</option>
          </select>
          {(['flat', 'folders'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ border: `1px solid ${browseMode === key ? PRIMARY : BORDER}`, color: browseMode === key ? PRIMARY : undefined }}
              onClick={() => {
                setBrowseMode(key)
                setCurrentDir('')
              }}
            >
              {key === 'flat' ? '全部文件' : '文件夹'}
            </button>
          ))}
          <span className="ml-auto" />
          {(['grid', 'list'] as const).map((key) => (
            <button
              key={key}
              type="button"
              title={key === 'grid' ? '网格视图' : '列表视图'}
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ border: `1px solid ${viewMode === key ? PRIMARY : BORDER}`, color: viewMode === key ? PRIMARY : undefined }}
              onClick={() => setViewMode(key)}
            >
              {key === 'grid' ? '▦' : '☰'}
            </button>
          ))}
          <button
            type="button"
            title="刷新"
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{ border: `1px solid ${BORDER}` }}
            onClick={() => setReloadToken((value) => value + 1)}
          >
            ⟳
          </button>
          {viewMode === 'grid' ? (
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
              尺寸
              <input type="range" min={48} max={160} step={4} value={thumbSize} onChange={(event) => setThumbSize(Number(event.target.value))} style={{ width: 72 }} />
            </label>
          ) : null}
        </div>

        {browseMode === 'folders' ? (
          <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={() => setCurrentDir('')}>
              {root}
            </button>
            {currentDir.split('/').filter(Boolean).map((part, index, list) => {
              const target = list.slice(0, index + 1).join('/')
              return (
                <span key={target} className="flex items-center gap-1">
                  <span>/</span>
                  <button type="button" className="rounded px-1" style={{ border: `1px solid ${BORDER}` }} onClick={() => setCurrentDir(target)}>
                    {part}
                  </button>
                </span>
              )
            })}
            {currentDir ? (
              <button
                type="button"
                className="ml-1 rounded px-1"
                style={{ border: `1px solid ${BORDER}` }}
                onClick={() => setCurrentDir(currentDir.split('/').slice(0, -1).join('/'))}
              >
                ↑ 上一级
              </button>
            ) : null}
            <span className="ml-auto">{loading ? '扫描中…' : `${items.length} 个文件 / ${folders.length} 个文件夹`}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>点击=加入资源池；拖到主体=引用；拖到资源列表=新建。</span>
            <span className="ml-auto">{loading ? '扫描中…' : `${items.length} 个`}</span>
          </div>
        )}

        {error ? <div className="rounded px-2 py-1 text-[11px]" style={{ border: '1px solid #92400e', color: '#fbbf24' }}>{error}</div> : null}

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          {browseMode === 'folders' && folders.length > 0 ? (
            viewMode === 'grid' ? (
              <div className="flex flex-wrap content-start gap-1">
                {folders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    onClick={() => setCurrentDir(folder.path)}
                    className="flex flex-col items-center justify-center gap-1 rounded-md p-1"
                    style={{ width: thumbSize, height: Math.round(thumbSize * 0.82), border: `1px solid ${BORDER}`, background: FIELD_BG }}
                    title={folder.path}
                  >
                    <span className="text-base">📁</span>
                    <span className="w-full truncate px-1 text-center text-[10px]">{folder.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {folders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    onClick={() => setCurrentDir(folder.path)}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[11px]"
                    style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}
                  >
                    <span>📁</span>
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                    <span className="text-[9px] text-muted-foreground">文件夹</span>
                  </button>
                ))}
              </div>
            )
          ) : null}

          {items.length === 0 && !loading ? (
            <div className="px-1 text-[10px] text-muted-foreground">
              {browseMode === 'folders' ? '这个文件夹里没有匹配的文件。' : '没有匹配的文件。'}
            </div>
          ) : viewMode === 'grid' ? (
            <div className="flex flex-wrap content-start gap-1">
              {items.map((item) => (
                <button
                  key={`${item.subfolder}/${item.name}`}
                  type="button"
                  draggable
                  title={`${item.subfolder ? item.subfolder + '/' : ''}${item.name}`}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/easymedia-shared-resource', JSON.stringify({
                      name: item.name,
                      subfolder: item.subfolder,
                      kind: item.kind,
                      root,
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
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {items.map((item) => (
                <button
                  key={`${item.subfolder}/${item.name}`}
                  type="button"
                  draggable
                  title={`${item.subfolder ? item.subfolder + '/' : ''}${item.name}`}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/easymedia-shared-resource', JSON.stringify({
                      name: item.name,
                      subfolder: item.subfolder,
                      kind: item.kind,
                      root,
                    }))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => addShared(item)}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-left"
                  style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}
                >
                  <span className="shrink-0 text-[10px]">{item.kind === 'image' ? '🖼' : item.kind === 'audio' ? '♪' : '▶'}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">{item.name}</span>
                  {item.subfolder ? <span className="shrink-0 text-[9px] text-muted-foreground">{item.subfolder}</span> : null}
                  <span className="shrink-0 text-[9px] text-muted-foreground">{Math.round((item.size ?? 0) / 1024)}KB</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function BindingPicker({
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
