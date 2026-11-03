import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  applyStyle,
  EMPTY_STYLE,
  fetchStyleList,
  fetchStylePreview,
  isStyleActive,
  readStyle,
  styleSummary,
  type StyleKind,
  type StyleOption,
  type StyleScope,
  type StyleState,
} from '@/lib/style-library'

const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const BORDER = 'hsl(var(--border, 240 6% 25%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'
const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: 'hsl(var(--foreground, 0 0% 90%))',
  fontSize: 12,
  padding: '4px 8px',
  outline: 'none',
}

export function StylePickerDialog({
  open,
  projectKey,
  onClose,
  onChanged,
}: {
  open: boolean
  projectKey: string
  onClose: () => void
  onChanged?: (state: StyleState) => void
}) {
  const [draft, setDraft] = useState<StyleState>(() => readStyle(projectKey))
  const [tab, setTab] = useState<StyleKind>('color')
  const [query, setQuery] = useState('')
  const [colors, setColors] = useState<StyleOption[]>([])
  const [creators, setCreators] = useState<StyleOption[]>([])
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(readStyle(projectKey))
    setError('')
    setPreview('')
  }, [open, projectKey])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const [colorData, creatorData] = await Promise.all([
          fetchStyleList('color', query, 200),
          fetchStyleList('creator', query, 200),
        ])
        if (cancelled) return
        setColors(colorData.items)
        setCreators(creatorData.items)
        setSource(colorData.source || creatorData.source)
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message ?? err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, query])

  // 选择变化时编译预览
  useEffect(() => {
    if (!open) return
    if (!draft.color && !draft.creator) {
      setPreview('')
      setPreviewError('')
      return
    }
    let cancelled = false
    setPreviewing(true)
    setPreviewError('')
    void (async () => {
      try {
        const result = await fetchStylePreview({ ...draft, mode: draft.mode === 'off' ? 'on' : draft.mode })
        if (!cancelled) setPreview(result.instruction)
      } catch (err) {
        if (!cancelled) setPreviewError(String((err as Error)?.message ?? err))
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, draft.color, draft.creator, draft.scope, draft.mode])

  const list = tab === 'color' ? colors : creators
  const selectedId = tab === 'color' ? draft.color : draft.creator
  const grouped = useMemo(() => {
    const map = new Map<string, StyleOption[]>()
    for (const item of list) {
      const key = item.category || '未分类'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }
    return Array.from(map.entries())
  }, [list])

  if (!open) return null

  const pick = (id: string) => {
    setDraft((current) => (
      tab === 'color' ? { ...current, color: current.color === id ? '' : id } : { ...current, creator: current.creator === id ? '' : id }
    ))
  }

  const apply = async () => {
    try {
      const next = await applyStyle(projectKey, { ...draft, mode: draft.mode === 'off' ? 'on' : draft.mode })
      onChanged?.(next)
      onClose()
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }

  const clear = async () => {
    const cleared = await applyStyle(projectKey, { ...EMPTY_STYLE })
    onChanged?.(cleared)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[2147483000] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="flex max-h-[82vh] w-[860px] flex-col gap-2 overflow-hidden rounded-lg p-3"
        style={{ background: 'hsl(var(--card, 240 10% 10%))', border: `1px solid ${BORDER}` }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">视觉风格</span>
            <span className="text-[10px] text-muted-foreground">
              {source === 't8' ? '来源：本机 T8 资源（只读）' : source === 'builtin' ? '来源：内置风格' : ''}
            </span>
          </div>
          <button type="button" className="rounded px-2 py-0.5 text-[11px]" style={{ border: `1px solid ${BORDER}` }} onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="flex items-center gap-2">
          {([['color', '配色'], ['creator', '导演方法']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="rounded px-2 py-0.5 text-[11px]"
              style={{
                border: `1px solid ${tab === key ? PRIMARY : BORDER}`,
                color: tab === key ? PRIMARY : undefined,
              }}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          <input
            style={{ ...fieldStyle, flex: 1 }}
            placeholder="搜索名称 / 分类 / 编号"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="flex min-h-0 flex-1 gap-2">
          {/* 列表 */}
          <div className="min-h-0 w-[380px] overflow-auto rounded p-1" style={{ border: `1px solid ${BORDER}` }}>
            {loading ? <div className="p-2 text-[11px] text-muted-foreground">读取中…</div> : null}
            {error ? <div className="p-2 text-[11px]" style={{ color: '#f87171' }}>{error}</div> : null}
            {!loading && !error && !list.length ? (
              <div className="p-2 text-[11px] text-muted-foreground">没有匹配项</div>
            ) : null}
            {grouped.map(([category, items]) => (
              <div key={category} className="mb-1">
                <div className="px-1 py-0.5 text-[10px] text-muted-foreground">{category}</div>
                {items.map((item) => {
                  const active = selectedId === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-secondary"
                      style={{
                        border: `1px solid ${active ? PRIMARY : 'transparent'}`,
                        color: active ? PRIMARY : undefined,
                      }}
                      title={item.summary_zh || item.label_en}
                      onClick={() => pick(item.id)}
                    >
                      {item.label_zh}
                      <span className="ml-1 text-[9px] opacity-60">{item.id}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* 预览 */}
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div className="text-[11px] text-muted-foreground">将写入提示词的风格指令</div>
            <div
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded p-2 text-[11px] leading-relaxed"
              style={{ background: FIELD_BG, border: `1px solid ${BORDER}` }}
            >
              {previewing ? '编译中…' : previewError ? <span style={{ color: '#f87171' }}>{previewError}</span> : (preview || '还没选风格：选一个配色或导演方法后这里会显示将要附加的指令。')}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px]">
            范围
            <select
              style={fieldStyle}
              value={draft.scope}
              onChange={(event) => setDraft({ ...draft, scope: event.target.value as StyleScope })}
            >
              <option value="color_only">仅色彩</option>
              <option value="color_and_light">色彩 + 光影</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-[11px]">
            强度
            <select
              style={fieldStyle}
              value={draft.mode}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as StyleState['mode'] })}
            >
              <option value="off">关闭</option>
              <option value="on">开启</option>
              <option value="experimental">开启（强化）</option>
            </select>
          </label>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            当前：{styleSummary({ ...draft, colorName: colors.find((item) => item.id === draft.color)?.label_zh, creatorName: creators.find((item) => item.id === draft.creator)?.label_zh })}
          </span>
          <Button variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => { void clear() }}>
            清除
          </Button>
          <Button
            variant="secondary"
            className="h-6 px-2 text-[11px]"
            disabled={!isStyleActive({ ...draft, mode: 'on' })}
            onClick={() => { void apply() }}
          >
            应用
          </Button>
        </div>
      </div>
    </div>
  )
}

export default StylePickerDialog
