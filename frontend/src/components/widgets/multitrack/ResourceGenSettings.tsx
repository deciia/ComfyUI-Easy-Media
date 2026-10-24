import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'
const fieldStyle: React.CSSProperties = {
  background: FIELD_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: '#e5e5e5',
  padding: '3px 6px',
  fontSize: 12,
  outline: 'none',
}

type Entry = {
  workflow?: string
  output?: string
  outputs?: string[]
  inputs?: Record<string, unknown>
  save_node?: Record<string, unknown>
  profiles?: Record<string, unknown>
  default_profile?: string
}

type Config = { types: Record<string, Entry> }

const KNOWN_TYPES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'image', label: '图片', hint: '生成参考图/主体图，建议用 P2 合并台' },
  { key: 'refvideo', label: '参考视频', hint: '生成参考片段，建议用 beta3' },
  { key: 'voice', label: '配音', hint: 'TTS / 音色克隆工作流' },
  { key: 'music', label: '音乐', hint: 'BGM 生成工作流' },
]

/** 导演台设置 → 资源生成：按类型指定 API 工作流、输出节点与输入映射 */
export function ResourceGenSettings() {
  const [config, setConfig] = useState<Config>({ types: {} })
  const [candidates, setCandidates] = useState<Array<{ root: string; name: string; display: string }>>([])
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [inspecting, setInspecting] = useState('')
  const [newType, setNewType] = useState('')

  useEffect(() => {
    fetch('/easy-media/resource-workflows')
      .then((response) => response.json())
      .then((data) => {
        if (data?.ok && data.config) setConfig({ types: data.config.types ?? {} })
      })
      .catch(() => { /* ignore */ })
    fetch('/easy-media/resource-workflows/candidates')
      .then((response) => response.json())
      .then((data) => {
        if (data?.ok) setCandidates(data.items ?? [])
      })
      .catch(() => { /* ignore */ })
  }, [])

  const typeKeys = useMemo(() => {
    const keys = new Set<string>(KNOWN_TYPES.map((item) => item.key))
    for (const key of Object.keys(config.types ?? {})) keys.add(key)
    return Array.from(keys)
  }, [config])

  const patchEntry = (type: string, patch: Partial<Entry>) => {
    setConfig((current) => ({
      types: { ...(current.types ?? {}), [type]: { ...(current.types?.[type] ?? {}), ...patch } },
    }))
    setDirty(true)
    setStatus('')
  }

  const removeType = (type: string) => {
    setConfig((current) => {
      const next = { ...(current.types ?? {}) }
      delete next[type]
      return { types: next }
    })
    setDirty(true)
    setStatus(`已移除 ${type}（记得保存）`)
  }

  const addType = () => {
    const key = newType.trim()
    if (!key) return
    patchEntry(key, { workflow: '', inputs: {} })
    setNewType('')
  }

  async function inspect(type: string) {
    const entry = config.types?.[type]
    const workflow = String(entry?.workflow ?? '').trim()
    if (!workflow) {
      setStatus(`${type}：请先选择或填写工作流文件`)
      return
    }
    setInspecting(type)
    setStatus('')
    try {
      const response = await fetch('/easy-media/resource-workflows/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) {
        setStatus(`${type}：${String(data?.error ?? '检查失败')}`)
        return
      }
      const suggestion = (data.suggestion ?? {}) as { output?: string; inputs?: Record<string, unknown> }
      const current = config.types?.[type] ?? {}
      patchEntry(type, {
        outputs: suggestion.output ? [suggestion.output] : current.outputs,
        output: suggestion.output ?? current.output,
        inputs: Object.keys(current.inputs ?? {}).length ? current.inputs : (suggestion.inputs ?? {}),
      })
      setStatus(
        `${type}：识别到 ${data.nodes} 个节点；提示词口 ${
          (data.prompt_candidates ?? []).length
        } 个，输出节点 ${(data.outputs ?? []).length} 个（已填入建议）`,
      )
    } catch (error) {
      setStatus(`${type}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setInspecting('')
    }
  }

  async function saveConfig() {
    setStatus('保存中…')
    try {
      const response = await fetch('/easy-media/resource-workflows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) {
        setStatus(`保存失败：${String(data?.error ?? response.status)}`)
        return
      }
      setDirty(false)
      setStatus('已保存，助手下一次调用即生效')
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-muted-foreground">
        按类型指定「API 格式」工作流。文件放 <code>user/DeciiaEasyMedia/workflows/</code> 或用户工作流目录均可；换工作流只需改这里。
      </div>

      {typeKeys.map((type) => {
        const entry = config.types?.[type] ?? {}
        const label = KNOWN_TYPES.find((item) => item.key === type)?.label ?? type
        const hint = KNOWN_TYPES.find((item) => item.key === type)?.hint ?? '自定义类型'
        const outputsText = Array.isArray(entry.outputs)
          ? entry.outputs.join(', ')
          : String(entry.output ?? '')
        return (
          <div key={type} style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8 }} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium">{label}</span>
              <span className="text-[10px] text-muted-foreground">{type}</span>
              <span className="ml-auto">
                <Button size="sm" variant="secondary" className="h-5 px-2 text-[10px]"
                  disabled={inspecting === type}
                  onClick={() => void inspect(type)}>
                  {inspecting === type ? '检查中…' : '检查并建议'}
                </Button>
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">{hint}</div>
            <div className="flex items-center gap-2 text-[11px]">
              <select
                style={{ ...fieldStyle, width: '100%' }}
                value={candidates.some((item) => item.name === entry.workflow) ? String(entry.workflow) : ''}
                onChange={(event) => patchEntry(type, { workflow: event.target.value })}
              >
                <option value="">— 从列表选（{candidates.length} 个可用） —</option>
                {candidates.map((item) => (
                  <option key={`${item.root}:${item.name}`} value={item.name}>{item.display}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <input
                style={{ ...fieldStyle, width: '100%' }}
                placeholder="或手填路径/文件名，如 xxx_api.json"
                value={String(entry.workflow ?? '')}
                onChange={(event) => patchEntry(type, { workflow: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-16 text-muted-foreground">输出节点</span>
              <input
                style={{ ...fieldStyle, width: 160 }}
                placeholder="如 733 或 25"
                value={outputsText}
                onChange={(event) => {
                  const raw = event.target.value.trim()
                  const ids = raw.split(',').map((item) => item.trim()).filter(Boolean)
                  patchEntry(type, { outputs: ids, output: ids[0] })
                }}
              />
              <span className="text-muted-foreground">逗号分隔可多选（按顺序回退）</span>
            </div>
            <details>
              <summary className="cursor-pointer text-[10px] text-muted-foreground">输入映射（高级 JSON，键为「节点id.字段」）</summary>
              <textarea
                style={{ ...fieldStyle, width: '100%', minHeight: 76, fontSize: 11, fontFamily: 'monospace' }}
                value={JSON.stringify(entry.inputs ?? {}, null, 2)}
                onChange={(event) => {
                  try {
                    patchEntry(type, { inputs: JSON.parse(event.target.value) as Record<string, unknown> })
                  } catch {
                    /* 输入过程中的非法 JSON 先不动 */
                  }
                }}
              />
              <div className="text-[10px] text-muted-foreground">
                可用变量：{'{{prompt}} {{text}} {{duration}} {{duration_frames}} {{seed}} {{ratio}} {{reference_image}} {{reference_audio}} {{reference_images_json}} {{name}}'}
              </div>
            </details>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" className="h-5 px-2 text-[10px]" onClick={() => removeType(type)}>
                移除该类型
              </Button>
            </div>
          </div>
        )
      })}

      <div className="flex items-center gap-2 text-[11px]">
        <input
          style={{ ...fieldStyle, width: 160 }}
          placeholder="新增类型，如 sfx"
          value={newType}
          onChange={(event) => setNewType(event.target.value)}
        />
        <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={addType}>＋ 新增类型</Button>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => void saveConfig()}>保存资源生成配置</Button>
        {dirty ? <span className="text-[10px]" style={{ color: PRIMARY }}>有未保存改动</span> : null}
        <span className="text-[10px] text-muted-foreground">{status}</span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        配置文件：ComfyUI/user/DeciiaEasyMedia/resource_workflows.json（相对文件名优先在 DeciiaEasyMedia/workflows 下解析）
      </div>
    </div>
  )
}
