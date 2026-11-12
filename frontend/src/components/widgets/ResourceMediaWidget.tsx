import { useRef, useState } from 'react'
import { Film, Image as ImageIcon, Music, Plus, Trash2 } from 'lucide-react'
import type { ReactWidgetProps } from '@/lib/create-react-widget'
import { mediaPathToViewUrl } from '@/lib/media-url'

export interface ResourceMediaSlot {
  file: string
}

export interface ResourceMediaValue {
  images: ResourceMediaSlot[]
  videos: ResourceMediaSlot[]
  audio: ResourceMediaSlot[]
}

const LIMITS = { images: 9, videos: 3, audio: 3 } as const
type Kind = keyof typeof LIMITS

interface SectionSpec {
  kind: Kind
  label: string
  accept: string
  hint: string
}

const SECTIONS: SectionSpec[] = [
  { kind: 'images', label: '参考图像', accept: 'image/*', hint: '最多 9 张' },
  { kind: 'audio', label: '参考音频', accept: 'audio/*', hint: '最多 3 段' },
  { kind: 'videos', label: '参考视频', accept: 'video/*', hint: '最多 3 段' },
]

const EMPTY: ResourceMediaValue = { images: [], videos: [], audio: [] }

function normalize(value: unknown): ResourceMediaValue {
  const data = (value && typeof value === 'object' ? value : {}) as Partial<Record<Kind, unknown>>
  const pick = (kind: Kind): ResourceMediaSlot[] => {
    const list = data[kind]
    if (!Array.isArray(list)) return []
    const out: ResourceMediaSlot[] = []
    for (const item of list) {
      const file = typeof item === 'string' ? item : String((item as ResourceMediaSlot | undefined)?.file ?? '')
      if (file.trim()) out.push({ file: file.trim() })
    }
    return out.slice(0, LIMITS[kind])
  }
  return { images: pick('images'), videos: pick('videos'), audio: pick('audio') }
}

async function uploadResourceFile(file: File): Promise<string> {
  const form = new FormData()
  form.append('image', file, file.name)
  const response = await fetch('/easy-media/upload', { method: 'POST', body: form })
  if (!response.ok) throw new Error(`上传失败（HTTP ${response.status}）：${file.name}`)
  const payload = (await response.json()) as { file_name?: string; error?: string }
  const name = String(payload?.file_name ?? '').trim()
  if (!name) throw new Error(payload?.error || `上传返回为空：${file.name}`)
  return name
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 2px',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  opacity: 0.9,
}

const addButtonStyle: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(255,255,255,0.06)',
  color: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
}

const imageGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))',
  gap: 6,
}

const imageCardStyle: React.CSSProperties = {
  position: 'relative',
  aspectRatio: '1 / 1',
  borderRadius: 8,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(0,0,0,0.35)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  fontSize: 11,
}

const removeStyle: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 4,
  border: 'none',
  background: 'rgba(255,255,255,0.08)',
  color: 'inherit',
  cursor: 'pointer',
  flex: 'none',
}

const dropStyle = (active: boolean): React.CSSProperties => ({
  borderRadius: 8,
  border: `1px dashed ${active ? 'rgba(120,200,255,0.9)' : 'rgba(255,255,255,0.20)'}`,
  background: active ? 'rgba(120,200,255,0.10)' : 'transparent',
  padding: 6,
  minHeight: 44,
})

export function ResourceMediaWidget({ value, onChange, node }: Readonly<ReactWidgetProps<ResourceMediaValue>>) {
  const data = normalize(value)
  const [busy, setBusy] = useState<Kind | null>(null)
  const [dragKind, setDragKind] = useState<Kind | null>(null)
  const [error, setError] = useState<string>('')
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})

  function commit(next: ResourceMediaValue) {
    onChange(next)
    node?.setDirtyCanvas?.(true, true)
  }

  async function addFiles(kind: Kind, files: FileList | File[] | null) {
    if (!files) return
    const incoming = Array.from(files).slice(0, Math.max(0, LIMITS[kind] - data[kind].length))
    if (!incoming.length) return
    setBusy(kind)
    setError('')
    try {
      const uploaded: ResourceMediaSlot[] = []
      for (const file of incoming) {
        uploaded.push({ file: await uploadResourceFile(file) })
      }
      commit({ ...data, [kind]: [...data[kind], ...uploaded].slice(0, LIMITS[kind]) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  function removeAt(kind: Kind, index: number) {
    commit({ ...data, [kind]: data[kind].filter((_slot, i) => i !== index) })
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, padding: '2px 4px', overflowY: 'auto' }}
      onDragOver={(event) => event.preventDefault()}
    >
      {SECTIONS.map((section) => {
        const items = data[section.kind]
        const Icon = section.kind === 'images' ? ImageIcon : section.kind === 'videos' ? Film : Music
        return (
          <div
            key={section.kind}
            style={sectionStyle}
            onDragOver={(event) => {
              event.preventDefault()
              setDragKind(section.kind)
            }}
            onDragLeave={() => setDragKind(null)}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setDragKind(null)
              void addFiles(section.kind, event.dataTransfer?.files ?? null)
            }}
          >
            <div style={headerStyle}>
              <Icon size={13} />
              <span>{section.label}</span>
              <span style={{ opacity: 0.55 }}>
                {items.length}/{LIMITS[section.kind]}
              </span>
              <span style={{ opacity: 0.4, fontSize: 10 }}>{section.hint}</span>
              <button
                type="button"
                style={addButtonStyle}
                disabled={busy !== null || items.length >= LIMITS[section.kind]}
                onClick={() => inputs.current[section.kind]?.click()}
              >
                <Plus size={12} />
                {busy === section.kind ? '上传中…' : '添加'}
              </button>
              <input
                ref={(el) => {
                  inputs.current[section.kind] = el
                }}
                type="file"
                accept={section.accept}
                multiple={section.kind === 'images'}
                style={{ display: 'none' }}
                onChange={(event) => {
                  void addFiles(section.kind, event.target.files)
                  event.target.value = ''
                }}
              />
            </div>

            <div style={dropStyle(dragKind === section.kind)}>
              {section.kind === 'images' ? (
                items.length ? (
                  <div style={imageGridStyle}>
                    {items.map((slot, index) => (
                      <div key={`${slot.file}-${index}`} style={imageCardStyle} title={slot.file}>
                        <img
                          src={mediaPathToViewUrl(slot.file, 'input')}
                          alt={slot.file}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          draggable={false}
                        />
                        <button
                          type="button"
                          onClick={() => removeAt(section.kind, index)}
                          title="移除"
                          style={{ ...removeStyle, position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)' }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ opacity: 0.5, fontSize: 11 }}>点「添加」选图，或把图片拖到这里</div>
                )
              ) : items.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {items.map((slot, index) => (
                    <div key={`${slot.file}-${index}`} style={rowStyle}>
                      <Icon size={12} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={slot.file}>
                        {slot.file}
                      </span>
                      <button type="button" onClick={() => removeAt(section.kind, index)} title="移除" style={removeStyle}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ opacity: 0.5, fontSize: 11 }}>
                  {section.kind === 'videos' ? '点「添加」选视频，或直接拖入' : '点「添加」选音频，或直接拖入'}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {error ? (
        <div style={{ color: '#ff8a8a', fontSize: 11, padding: '2px 4px' }} title={error}>
          {error}
        </div>
      ) : null}
      <div style={{ opacity: 0.45, fontSize: 10, padding: '0 4px 4px' }}>
        面板素材存 input 目录；接线槽位优先于面板同编号素材。
      </div>
    </div>
  )
}

export { EMPTY as EMPTY_RESOURCE_MEDIA }
