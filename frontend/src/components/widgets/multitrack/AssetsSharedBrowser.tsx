import { useEffect, useRef, useState } from 'react'
import type { WorkspaceResourceItem } from './WorkspacePanels'

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

/**
 * 悬停放大浮层：照班长媒体加载器（bvl/hover.js 的 bz-zoom）做命令式实现。
 * 直接 append 到 document.body，不受导演台容器 transform:scale 影响，
 * 也不依赖 React 渲染时机，所以不会出现“浮层不出现/位置漂移”。
 */
let fileZoomLayer: { layer: HTMLDivElement; img: HTMLImageElement } | null = null
const fileZoomPoint = { x: 0, y: 0 }

function ensureFileZoomLayer() {
  if (fileZoomLayer) return fileZoomLayer
  const layer = document.createElement('div')
  layer.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:2147483647',
    'pointer-events:none',
    'padding:4px',
    'border-radius:10px',
    'background:rgba(20,21,23,0.92)',
    'border:1px solid rgba(255,255,255,0.12)',
    'box-shadow:0 14px 36px rgba(0,0,0,0.6)',
    'opacity:0',
    'visibility:hidden',
    'transition:opacity 0.12s ease',
  ].join(';')
  const img = document.createElement('img')
  img.draggable = false
  img.style.cssText = 'display:block;border-radius:7px;background:#1e1e1e'
  img.addEventListener('load', () => placeFileZoom())
  layer.appendChild(img)
  document.body.appendChild(layer)
  window.addEventListener('scroll', () => hideFileZoom(), true)
  fileZoomLayer = { layer, img }
  return fileZoomLayer
}

function placeFileZoom() {
  if (!fileZoomLayer) return
  const { layer, img } = fileZoomLayer
  // 超高/超宽图先按视口收一下，保证浮层整体能显示在屏幕内
  img.style.maxWidth = `${Math.min(520, window.innerWidth - 40)}px`
  img.style.maxHeight = `${Math.min(520, window.innerHeight - 44)}px`
  const width = layer.offsetWidth || 280
  const height = layer.offsetHeight || 280
  let x = fileZoomPoint.x + 18
  let y = fileZoomPoint.y + 18
  if (x + width > window.innerWidth - 8) x = fileZoomPoint.x - width - 18
  if (y + height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - height - 8)
  layer.style.left = `${Math.max(8, x)}px`
  layer.style.top = `${Math.max(8, y)}px`
}

function showFileZoom(url: string, point: { clientX: number; clientY: number }) {
  const { layer, img } = ensureFileZoomLayer()
  fileZoomPoint.x = point.clientX
  fileZoomPoint.y = point.clientY
  if (img.getAttribute('src') !== url) img.src = url
  layer.style.visibility = 'visible'
  layer.style.opacity = '1'
  placeFileZoom()
  window.requestAnimationFrame(placeFileZoom)
  window.setTimeout(placeFileZoom, 60)
  window.setTimeout(placeFileZoom, 220)
}

function moveFileZoom(point: { clientX: number; clientY: number }) {
  fileZoomPoint.x = point.clientX
  fileZoomPoint.y = point.clientY
  if (fileZoomLayer) placeFileZoom()
}

function hideFileZoom() {
  if (!fileZoomLayer) return
  fileZoomLayer.layer.style.opacity = '0'
  fileZoomLayer.layer.style.visibility = 'hidden'
}

/** 共享资源浏览器（右侧栏页签）：input/output/temp 根目录、文件夹浏览、筛选、排序、网格/列表、拖拽入池 */
export function AssetsSharedBrowser({
  onAdd,
}: {
  onAdd?: (item: { name: string; subfolder: string; kind: 'image' | 'audio' | 'video'; root: 'input' | 'output' | 'temp' }) => void
}) {
  const [rootDir, setRootDir] = useState<'input' | 'output' | 'temp'>('input')
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
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ kind, limit: '400', sort, root: rootDir, mode: browseMode })
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
  }, [kind, query, sort, rootDir, browseMode, currentDir, reloadToken])

  const addItem = (item: WorkspaceResourceItem) => onAdd?.({ name: item.name, subfolder: item.subfolder, kind: item.kind, root: rootDir })

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            style={{ ...fieldStyle, width: 92, padding: '2px 4px' }}
            value={rootDir}
            onChange={(event) => {
              setRootDir(event.target.value as 'input' | 'output' | 'temp')
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
              {rootDir}
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
                      root: rootDir,
                    }))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => addItem(item)}
                  onMouseEnter={(event) => {
                    if (item.kind === 'image' && item.url) showFileZoom(item.url, event)
                  }}
                  onMouseMove={(event) => moveFileZoom(event)}
                  onMouseLeave={hideFileZoom}
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
                      root: rootDir,
                    }))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => addItem(item)}
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
  )
}
