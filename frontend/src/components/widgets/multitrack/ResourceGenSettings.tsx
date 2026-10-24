import { useEffect, useMemo, useRef, useState } from 'react'
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
  timeout_seconds?: number
  default_duration?: number
}

type Config = { types: Record<string, Entry> }

const KNOWN_TYPES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'image', label: '图片', hint: '生成参考图/主体图，实测约 1 分钟' },
  { key: 'refvideo', label: '参考视频', hint: '生成参考片段；5 秒约 5–10 分钟' },
  { key: 'voice', label: '配音', hint: 'TTS / 音色克隆，约 1–10 分钟' },
  { key: 'music', label: '音乐', hint: 'BGM 生成，约 1–10 分钟' },
]

const SAMPLE: Record<string, Record<string, unknown>> = {
  image: {
    name: '试跑_图片',
    prompt: '竖屏，一间汽修车间空镜，卷帘门半开，午后阳光斜射，地面有油污与工具箱，写实摄影',
    ratio: '9:16',
    reference_images_json: '[]',
  },
  refvideo: {
    name: '试跑_参考视频',
    prompt_override:
      'subject_definitions:\n<Subject 1> is a 50-year-old Chinese mechanic in a dark blue work shirt.\n\nsummary:\nA short five-second test clip of the mechanic wiping his hands in the workshop.\n\ndetailed_description:\n[Shot 1] Medium shot: <Subject 1> stands beside a diesel engine, wipes his hands on a rag, and looks toward the camera.\n\noverall_soundscape:\nWorkshop room tone with faint metal clinks.\n\nnon_diegetic_music:\nNone.',
    duration: 5,
  },
  voice: { name: '试跑_配音', text: '这是一段测试配音，用来确认工作流是否可用。', duration: 5 },
  music: { name: '试跑_音乐', prompt: '轻快的口播背景音乐，木吉他，节奏稳定', duration: 15 },
}

function etaOf(type: string, duration?: number): string {
  const seconds = Number(duration ?? 5) || 5
  if (type === 'refvideo') {
    if (seconds <= 5) return '约 5–10 分钟'
    if (seconds <= 10) return '约 10–20 分钟'
    return '约 15–30 分钟'
  }
  if (type === 'voice' || type === 'music') return '约 1–10 分钟'
  return '约 1 分钟'
}

type TestState = {
  type: string
  stage: 'confirm' | 'running' | 'done' | 'error'
  jobId?: string
  elapsed?: number
  result?: Record<string, unknown>
  error?: string
}

/** 导演台设置 → 资源生成：按类型指定 API 工作流、输出节点与输入映射，并可试跑一次 */
export function ResourceGenSettings() {
  const [config, setConfig] = useState<Config>({ types: {} })
  const [candidates, setCandidates] = useState<Array<{ root: string; name: string; display: string }>>([])
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [inspecting, setInspecting] = useState('')
  const [newType, setNewType] = useState('')
  const [test, setTest] = useState<TestState | null>(null)
  const pollRef = useRef<number | null>(null)

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

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
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

  function stopPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  async function startTest(type: string) {
    stopPolling()
    const params = { ...(SAMPLE[type] ?? { name: `试跑_${type}`, prompt: '测试' }) }
    setTest({ type, stage: 'running', elapsed: 0 })
    try {
      const response = await fetch('/easy-media/resource-workflows/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ async: true, type, params }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok || !data.job_id) {
        setTest({ type, stage: 'error', error: String(data?.error ?? `提交失败（HTTP ${response.status}）`) })
        return
      }
      const jobId = String(data.job_id)
      setTest({ type, stage: 'running', jobId, elapsed: 0 })
      pollRef.current = window.setInterval(async () => {
        try {
          const statusResponse = await fetch(`/easy-media/resource-workflows/jobs/${jobId}`)
          const statusData = await statusResponse.json().catch(() => ({}))
          if (!statusResponse.ok || !statusData?.ok) {
            stopPolling()
            setTest({ type, stage: 'error', jobId, error: String(statusData?.error ?? '查询任务失败') })
            return
          }
          if (statusData.status === 'done') {
            stopPolling()
            setTest({ type, stage: 'done', jobId, elapsed: Number(statusData.elapsed ?? 0), result: statusData.result })
          } else if (statusData.status === 'error') {
            stopPolling()
            setTest({ type, stage: 'error', jobId, elapsed: Number(statusData.elapsed ?? 0), error: String(statusData.error ?? '生成失败') })
          } else {
            setTest({ type, stage: 'running', jobId, elapsed: Number(statusData.elapsed ?? 0) })
          }
        } catch (error) {
          stopPolling()
          setTest({ type, stage: 'error', jobId, error: error instanceof Error ? error.message : String(error) })
        }
      }, 5000)
    } catch (error) {
      setTest({ type, stage: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  const previewUrl = (() => {
    const result = test?.result
    if (!result || test?.stage !== 'done') return ''
    const fileName = String(result.file_name ?? '')
    if (!fileName) return ''
    const subfolder = String(result.subfolder ?? '')
    const root = String(result.root ?? 'output')
    const kind = String(result.kind ?? '')
    if (kind !== 'images') return ''
    return `/view?filename=${encodeURIComponent(fileName)}&type=${root}&subfolder=${encodeURIComponent(subfolder)}`
  })()

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-muted-foreground">
        按类型指定「API 格式」工作流。文件放 <code>user/DeciiaEasyMedia/workflows/</code> 或用户工作流目录均可；换工作流只需改这里。
      </div>

      {test ? (
        <div style={{ border: `1px solid ${test.stage === 'error' ? '#b45309' : PRIMARY}`, borderRadius: 6, padding: 8 }} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span>试跑 {test.type}</span>
            <span className="text-muted-foreground">
              {test.stage === 'running' ? `进行中 ${Math.round(test.elapsed ?? 0)}s（${etaOf(test.type)}）` : null}
              {test.stage === 'done' ? `完成，用时 ${Math.round(test.elapsed ?? 0)}s` : null}
              {test.stage === 'error' ? '失败' : null}
            </span>
            <span className="ml-auto flex gap-1">
              {test.stage === 'running' ? (
                <Button size="sm" variant="secondary" className="h-5 px-2 text-[10px]" onClick={stopPolling}>停止等待</Button>
              ) : null}
              <Button size="sm" variant="secondary" className="h-5 px-2 text-[10px]" onClick={() => { stopPolling(); setTest(null) }}>关闭</Button>
            </span>
          </div>
          {test.error ? <div className="text-[10px]" style={{ color: '#f59e0b' }}>{test.error}</div> : null}
          {test.result ? (
            <div className="text-[10px] text-muted-foreground break-all">
              产物：{String(test.result.path ?? test.result.file_name ?? '')}
            </div>
          ) : null}
          {previewUrl ? <img src={previewUrl} alt="试跑产物" style={{ maxWidth: '100%', borderRadius: 4 }} /> : null}
        </div>
      ) : null}

      {typeKeys.map((type) => {
        const entry = config.types?.[type] ?? {}
        const label = KNOWN_TYPES.find((item) => item.key === type)?.label ?? type
        const hint = KNOWN_TYPES.find((item) => item.key === type)?.hint ?? '自定义类型'
        const outputsText = Array.isArray(entry.outputs) ? entry.outputs.join(', ') : String(entry.output ?? '')
        const confirming = test?.type === type && test.stage === 'confirm'
        return (
          <div key={type} style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8 }} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium">{label}</span>
              <span className="text-[10px] text-muted-foreground">{type}</span>
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="secondary" className="h-5 px-2 text-[10px]"
                  disabled={inspecting === type}
                  onClick={() => void inspect(type)}>
                  {inspecting === type ? '检查中…' : '检查并建议'}
                </Button>
                <Button size="sm" variant="secondary" className="h-5 px-2 text-[10px]"
                  disabled={!entry.workflow || (test?.stage === 'running' && test.type === type)}
                  onClick={() => {
                    if (confirming) {
                      void startTest(type)
                      return
                    }
                    setTest({ type, stage: 'confirm' })
                  }}>
                  {confirming ? '确认试跑' : '试跑一次'}
                </Button>
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">{hint}</div>
            {confirming ? (
              <div className="text-[10px]" style={{ color: PRIMARY }}>
                将用示例参数试跑一次（{etaOf(type)}），会占用 GPU；再点一次「确认试跑」开始。
              </div>
            ) : null}
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
