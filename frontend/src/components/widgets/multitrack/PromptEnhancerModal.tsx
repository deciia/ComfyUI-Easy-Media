import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * 提示词增强器（模态窗）。
 *
 * 只做一件事：把用户手写的、不规范的片段提示词，交给云模型改写成
 * MiniMax-H3 官方规范的六段提示词，然后替换段落的 user_prompt。
 *
 * 零侵入：不打开本弹窗就完全不发请求；生成失败不会改动原文。
 * 后端：/easy-media/prompt-studio/generate、/easy-media/prompt-studio/config
 */

export interface PromptEnhancerModalProps {
  initialBrief: string
  onApply: (prompt: string) => void
  onClose: () => void
  /** 可选：已知的参考图数量，用于后端校验编号 */
  pictureCount?: number
}

interface EnhancerOptions {
  task_type: string
  shot_count: string
  rewrite_mode: string
  output_language: string
  prompt_mode: string
  creative_preset: string
  duration_seconds: number
  constraints: string
}

interface ProviderConfig {
  provider: string
  base_url: string
  model: string
  api_key: string
  api_key_tail?: string
  api_key_set?: boolean
  upload_images: boolean
}

const PROVIDERS = ['deepseek', 'glm', 'minimax-cn', 'ark'] as const
const TASK_TYPES = ['Ref2VA', 'T2VA', 'I2VA', 'FL2VA', 'L2VA'] as const
const REWRITE_MODES = ['strict', 'balanced', 'creative'] as const
const LANGUAGES = ['中文', 'English'] as const
const CREATIVE_PRESETS = ['无（仅核心规则）', 'AUTO（根据意图判断）', '极简产品广告', '品牌宣传短片', '3D 动画短片', '音乐 MV 动态字幕（官方）'] as const

const QUICK_INSERTS: Array<{ label: string; text: string }> = [
  { label: '运镜', text: '运镜：镜头缓慢推进，轻微手持晃动' },
  { label: '微表情', text: '微表情：眉头轻皱，嘴角下压，眼神专注' },
  { label: '景别', text: '景别：中近景，人物占画面三分之二' },
  { label: '构图', text: '构图：人物位于左侧三分线，工位区在右后方' },
]

const DEFAULT_OPTIONS: EnhancerOptions = {
  task_type: 'Ref2VA',
  shot_count: 'AUTO',
  rewrite_mode: 'balanced',
  output_language: '中文',
  prompt_mode: '官方增强',
  creative_preset: CREATIVE_PRESETS[0],
  duration_seconds: 5,
  constraints: '',
}

const DEFAULT_CONFIG: ProviderConfig = {
  provider: 'deepseek',
  base_url: '',
  model: '',
  api_key: '',
  upload_images: true,
}

export function PromptEnhancerModal({ initialBrief, onApply, onClose, pictureCount }: PromptEnhancerModalProps) {
  const t = useT()
  const [brief, setBrief] = useState(initialBrief)
  const [options, setOptions] = useState<EnhancerOptions>(DEFAULT_OPTIONS)
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_CONFIG)
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [busy, setBusy] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [result, setResult] = useState('')
  const [configPath, setConfigPath] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/easy-media/prompt-studio/config')
        if (!response.ok) return
        const data = await response.json()
        if (cancelled) return
        const loaded = data?.config
        if (loaded && typeof loaded === 'object') {
          setConfig((current) => ({
            ...current,
            provider: typeof loaded.provider === 'string' ? loaded.provider : current.provider,
            base_url: typeof loaded.base_url === 'string' ? loaded.base_url : current.base_url,
            model: typeof loaded.model === 'string' ? loaded.model : current.model,
            api_key_set: Boolean(loaded.api_key_set),
            api_key_tail: typeof loaded.api_key_tail === 'string' ? loaded.api_key_tail : '',
            upload_images: loaded.upload_images !== false,
          }))
        }
      } catch {
        // 打不开配置不影响手动输入
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const canGenerate = useMemo(() => brief.trim().length > 0 && !busy, [brief, busy])

  function insertQuick(text: string) {
    setBrief((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text))
  }

  async function handleGenerate() {
    setBusy(true)
    setError('')
    setFailures([])
    setResult('')
    try {
      const response = await fetch('/easy-media/prompt-studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief,
          options,
          images: [],
          picture_count: pictureCount ?? null,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(String(data?.error || t('multitrack.enhancerFailed')))
        return
      }
      setResult(String(data?.prompt || ''))
      setFailures(Array.isArray(data?.failures) ? data.failures : [])
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('multitrack.enhancerFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveConfig() {
    setSavingConfig(true)
    setError('')
    try {
      const response = await fetch('/easy-media/prompt-studio/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: config.provider,
          base_url: config.base_url,
          model: config.model,
          api_key: config.api_key,
          upload_images: config.upload_images,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(String(data?.error || t('multitrack.enhancerFailed')))
        return
      }
      setConfig((current) => ({
        ...current,
        api_key: '',
        api_key_set: Boolean(data?.config?.api_key_set),
        api_key_tail: String(data?.config?.api_key_tail || ''),
      }))
      setConfigPath(String(data?.path || ''))
      setView('main')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('multitrack.enhancerFailed'))
    } finally {
      setSavingConfig(false)
    }
  }

  const fieldClass = 'h-7 rounded border border-neutral-600 bg-neutral-800 px-2 text-xs text-neutral-200'
  const labelClass = 'text-[11px] text-neutral-400'

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
    >
      <div
        className="flex max-h-[86vh] w-[720px] max-w-full flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-100">
            <Sparkles className="h-4 w-4 text-sky-400" />
            {t('multitrack.enhancerTitle')}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={t('multitrack.enhancerSettings')}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t('multitrack.enhancerClose')}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {view === 'settings' ? (
          <div className="flex flex-col gap-2 overflow-auto p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerProvider')}</span>
                <select
                  className={fieldClass}
                  value={config.provider}
                  onChange={(event) => setConfig({ ...config, provider: event.target.value })}
                >
                  {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerModel')}</span>
                <input
                  className={fieldClass}
                  value={config.model}
                  placeholder="留空使用默认"
                  onChange={(event) => setConfig({ ...config, model: event.target.value })}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.enhancerBaseUrl')}</span>
              <input
                className={fieldClass}
                value={config.base_url}
                placeholder="留空使用默认"
                onChange={(event) => setConfig({ ...config, base_url: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>
                {t('multitrack.enhancerApiKey')}
                {config.api_key_set ? `（已保存 …${config.api_key_tail || ''}）` : ''}
              </span>
              <input
                className={fieldClass}
                type="password"
                value={config.api_key}
                placeholder={config.api_key_set ? '已保存，留空则不修改' : 'sk-...'}
                onChange={(event) => setConfig({ ...config, api_key: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={config.upload_images}
                onChange={(event) => setConfig({ ...config, upload_images: event.target.checked })}
              />
              {t('multitrack.enhancerUploadImages')}
            </label>
            <div className="text-[11px] text-neutral-500">
              {t('multitrack.enhancerConfigPath')}: ComfyUI/user/DeciiaEasyMedia/prompt_studio.json
              {configPath ? `（已保存）` : ''}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setView('main')}>{t('common.cancel')}</Button>
              <Button onClick={() => void handleSaveConfig()} disabled={savingConfig}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-2 overflow-auto p-3">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.enhancerBrief')}</span>
              <textarea
                className="min-h-[96px] w-full resize-y rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-xs text-neutral-200"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder={t('multitrack.enhancerBriefPlaceholder')}
              />
            </label>

            <div className="flex flex-wrap items-center gap-1">
              <span className={labelClass}>{t('multitrack.enhancerQuickInsert')}</span>
              {QUICK_INSERTS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="rounded border border-neutral-600 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700"
                  onClick={() => insertQuick(item.text)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerTaskType')}</span>
                <select
                  className={fieldClass}
                  value={options.task_type}
                  onChange={(event) => setOptions({ ...options, task_type: event.target.value })}
                >
                  {TASK_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerShotCount')}</span>
                <select
                  className={fieldClass}
                  value={options.shot_count}
                  onChange={(event) => setOptions({ ...options, shot_count: event.target.value })}
                >
                  {['AUTO', '1', '2', '3', '4', '5', '6'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerRewriteMode')}</span>
                <select
                  className={fieldClass}
                  value={options.rewrite_mode}
                  onChange={(event) => setOptions({ ...options, rewrite_mode: event.target.value })}
                >
                  {REWRITE_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerLanguage')}</span>
                <select
                  className={fieldClass}
                  value={options.output_language}
                  onChange={(event) => setOptions({ ...options, output_language: event.target.value })}
                >
                  {LANGUAGES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerPreset')}</span>
                <select
                  className={fieldClass}
                  value={options.creative_preset}
                  onChange={(event) => setOptions({ ...options, creative_preset: event.target.value })}
                >
                  {CREATIVE_PRESETS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerDuration')}</span>
                <input
                  className={fieldClass}
                  type="number"
                  min={1}
                  value={options.duration_seconds}
                  onChange={(event) => setOptions({ ...options, duration_seconds: Number(event.target.value) || 1 })}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.enhancerConstraints')}</span>
              <input
                className={fieldClass}
                value={options.constraints}
                onChange={(event) => setOptions({ ...options, constraints: event.target.value })}
                placeholder={t('multitrack.enhancerConstraintsPlaceholder')}
              />
            </label>

            {error ? (
              <div className="rounded border border-amber-700/60 bg-amber-900/20 px-2 py-1 text-[11px] text-amber-300">
                {error}
              </div>
            ) : null}

            {failures.length > 0 ? (
              <div className="rounded border border-amber-700/60 bg-amber-900/20 px-2 py-1 text-[11px] text-amber-300">
                <div>{t('multitrack.enhancerValidationFailed')}</div>
                <ul className="ml-4 list-disc">
                  {failures.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ) : null}

            {result ? (
              <div className="flex flex-col gap-1">
                <span className={labelClass}>{t('multitrack.enhancerPreview')}</span>
                <textarea
                  readOnly
                  className={cn(
                    'min-h-[120px] w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-300',
                  )}
                  value={result}
                />
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-neutral-500">
                {t('multitrack.enhancerHint')}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose}>{t('multitrack.enhancerClose')}</Button>
                <Button onClick={() => void handleGenerate()} disabled={!canGenerate}>
                  {busy ? t('multitrack.enhancerGenerating') : t('multitrack.enhancerGenerate')}
                </Button>
                <Button
                  onClick={() => {
                    if (result) onApply(result)
                  }}
                  disabled={!result || failures.length > 0}
                >
                  {t('multitrack.enhancerApply')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
