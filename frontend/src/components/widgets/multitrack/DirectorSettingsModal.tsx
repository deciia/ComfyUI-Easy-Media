import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DEFAULT_DIRECTOR_SETTINGS, DEFAULT_PROMPT_RULES, type DirectorSettings } from './directorSettings'

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'
const fieldStyle: React.CSSProperties = {
  background: FIELD_BG, border: `1px solid ${BORDER}`, borderRadius: 6,
  color: '#e5e5e5', padding: '3px 6px', fontSize: 12, outline: 'none',
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** 统一的导演台设置面板：保存 / 音频与字幕 / AI 助手 / API */
export function DirectorSettingsModal({
  open,
  settings,
  onClose,
  onSave,
}: {
  open: boolean
  settings: DirectorSettings
  onClose: () => void
  onSave: (next: DirectorSettings) => void
}) {
  const [draft, setDraft] = useState<DirectorSettings>(settings)
  const [tab, setTab] = useState<'save' | 'audio' | 'agent' | 'api'>('save')
  const [api, setApi] = useState({ provider: '', model: '', base_url: '', api_key: '', api_key_masked: '', upload_images: true })
  const [apiSaving, setApiSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    fetch('/easy-media/prompt-studio/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data?.ok) return
        setApi({
          provider: String(data.provider ?? ''),
          model: String(data.model ?? ''),
          base_url: String(data.base_url ?? ''),
          api_key: '',
          api_key_masked: String(data.api_key_masked ?? (data.api_key ? '已保存' : '')),
          upload_images: data.upload_images !== false,
        })
      })
      .catch(() => { /* ignore */ })
  }, [open])

  async function persistApi() {
    setApiSaving(true)
    try {
      await fetch('/easy-media/prompt-studio/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: api.provider,
          model: api.model,
          base_url: api.base_url,
          api_key: api.api_key || undefined,
          upload_images: api.upload_images,
        }),
      })
    } catch {
      /* ignore */
    } finally {
      setApiSaving(false)
    }
  }

  if (!open) return null

  const patch = (fn: (value: DirectorSettings) => DirectorSettings) => setDraft((value) => fn(value))

  return (
    <div
      style={{ position: 'fixed', top: 88, right: 0, bottom: 0, width: 560, maxWidth: '92vw', zIndex: 2147483002, background: 'hsl(var(--card, 240 10% 10%))', borderLeft: '1px solid hsl(var(--border, 240 6% 25%))', boxShadow: '-8px 0 24px rgba(0,0,0,0.35)', display: 'flex', alignItems: 'stretch' }}
      onClick={onClose}
    >
      <div
        style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'transparent', border: 'none', borderRadius: 0, padding: 14, gap: 10, minHeight: 0 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">导演台设置</span>
          <span className="ml-auto text-[10px] text-muted-foreground">按项目保存于本机</span>
        </div>

        <div className="flex gap-1">
          {([['save', '保存'], ['audio', '音频与字幕'], ['agent', 'AI 助手'], ['api', 'API']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="rounded px-2 py-0.5 text-[11px]"
              style={{ border: `1px solid ${tab === key ? PRIMARY : BORDER}`, color: tab === key ? PRIMARY : undefined }}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
          {tab === 'save' ? (
            <>
              <div className="text-[11px] text-muted-foreground">保存默认目标</div>
              <div className="flex flex-wrap gap-3">
                {(['task', 'video', 'audio', 'subtitle'] as const).map((key) => (
                  <Toggle
                    key={key}
                    label={{ task: '任务轨', video: '视频轨', audio: '音频轨', subtitle: '字幕轨' }[key]}
                    checked={draft.save.targets[key]}
                    onChange={(v) => patch((d) => ({ ...d, save: { ...d.save, targets: { ...d.save.targets, [key]: v } } }))}
                  />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">默认变体</span>
                <select style={fieldStyle} value={draft.save.defaultVariant}
                  onChange={(e) => patch((d) => ({ ...d, save: { ...d.save, defaultVariant: e.target.value as 'a' | 'b' } }))}>
                  <option value="a">A</option>
                  <option value="b">B</option>
                </select>
                <span className="text-muted-foreground">覆盖策略</span>
                <select style={fieldStyle} value={draft.save.overwrite}
                  onChange={(e) => patch((d) => ({ ...d, save: { ...d.save, overwrite: e.target.value as DirectorSettings['save']['overwrite'] } }))}>
                  <option value="merge">合并（保留手改）</option>
                  <option value="fill-missing">仅补缺</option>
                  <option value="replace">全部替换</option>
                </select>
              </div>
              <Toggle label="同时写入参考图" checked={draft.save.writeImages}
                onChange={(v) => patch((d) => ({ ...d, save: { ...d.save, writeImages: v } }))} />
              <Toggle label="同时写入段级生成设置（任务/衔接/参考图）" checked={draft.save.writeSegmentSettings}
                onChange={(v) => patch((d) => ({ ...d, save: { ...d.save, writeSegmentSettings: v } }))} />
            </>
          ) : null}

          {tab === 'audio' ? (
            <>
              <div className="text-[11px] text-muted-foreground">音频轨角色命名（保存时按角色归轨，同名轨复用）</div>
              {(['voice', 'lipsync', 'sfx', 'bgm', 'reference'] as const).map((role) => (
                <div key={role} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 text-muted-foreground">{role}</span>
                  <input style={{ ...fieldStyle, width: 180 }} value={draft.audio.roleTracks[role] ?? ''}
                    onChange={(e) => patch((d) => ({ ...d, audio: { ...d.audio, roleTracks: { ...d.audio.roleTracks, [role]: e.target.value } } }))} />
                  <span className="text-muted-foreground">默认音量 dB</span>
                  <input style={{ ...fieldStyle, width: 60 }} type="number" value={draft.audio.defaultDb[role] ?? 0}
                    onChange={(e) => patch((d) => ({ ...d, audio: { ...d.audio, defaultDb: { ...d.audio.defaultDb, [role]: Number(e.target.value) } } }))} />
                </div>
              ))}
              <Toggle label="参考音轨默认静音（不进成片）" checked={draft.audio.referenceMuted}
                onChange={(v) => patch((d) => ({ ...d, audio: { ...d.audio, referenceMuted: v } }))} />

              <div className="mt-2 text-[11px] text-muted-foreground">字幕</div>
              <Toggle label="保存时同步台词到字幕轨" checked={draft.subtitle.enabled}
                onChange={(v) => patch((d) => ({ ...d, subtitle: { ...d.subtitle, enabled: v } }))} />
              <Toggle label="从分镜台词取字幕" checked={draft.subtitle.fromDialogue}
                onChange={(v) => patch((d) => ({ ...d, subtitle: { ...d.subtitle, fromDialogue: v } }))} />
              <Toggle label="从主体描述 <#名:台词> 取字幕" checked={draft.subtitle.fromTaggedDescription}
                onChange={(v) => patch((d) => ({ ...d, subtitle: { ...d.subtitle, fromTaggedDescription: v } }))} />
              <Toggle label="保留说话人前缀" checked={draft.subtitle.keepSpeaker}
                onChange={(v) => patch((d) => ({ ...d, subtitle: { ...d.subtitle, keepSpeaker: v } }))} />
              <Toggle label="中英双语两行" checked={draft.subtitle.bilingual}
                onChange={(v) => patch((d) => ({ ...d, subtitle: { ...d.subtitle, bilingual: v } }))} />
              <Toggle label="同时生成配音（VoxCPM2）" checked={draft.subtitle.generateSpeech}
                onChange={(v) => patch((d) => ({ ...d, subtitle: { ...d.subtitle, generateSpeech: v } }))} />
            </>
          ) : null}

          {tab === 'agent' ? (
            <>
              <div className="text-[11px] text-muted-foreground">AI 助手上下文：关闭的项不会发送给模型</div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">技能预设（写分镜/提示词的风格）</span>
                <select
                  style={{ ...fieldStyle, width: '100%' }}
                  value={draft.agent.skillPreset}
                  onChange={(event) => patch((d) => ({ ...d, agent: { ...d.agent, skillPreset: event.target.value, promptRules: event.target.value === 'custom' ? d.agent.promptRules : '' } }))}
                >
                  <option value="h3">H3 通用（官方结构简化版）</option>
                  <option value="action">动作片（快节奏/强运镜）</option>
                  <option value="arthouse">文艺片（长镜头/氛围）</option>
                  <option value="animation">动画（表演夸张/风格化）</option>
                  <option value="custom">自定义</option>
                </select>
                <span className="text-[11px] text-muted-foreground">提示词写作规则（随每次对话发送给助手）</span>
                <textarea
                  style={{ ...fieldStyle, width: '100%', minHeight: 96, resize: 'vertical', fontSize: 11 }}
                  value={draft.agent.promptRules || DEFAULT_PROMPT_RULES}
                  onChange={(event) => patch((d) => ({ ...d, agent: { ...d.agent, promptRules: event.target.value } }))}
                />
              </div>
              <Toggle label="节点设置（分辨率/比例/像素/格式）" checked={draft.agent.includeNodeSettings}
                onChange={(v) => patch((d) => ({ ...d, agent: { ...d.agent, includeNodeSettings: v } }))} />
              <Toggle label="轨道与片段时间线数据" checked={draft.agent.includeTrackData}
                onChange={(v) => patch((d) => ({ ...d, agent: { ...d.agent, includeTrackData: v } }))} />
              <Toggle label="分镜脚本" checked={draft.agent.includePlan}
                onChange={(v) => patch((d) => ({ ...d, agent: { ...d.agent, includePlan: v } }))} />
              <Toggle label="手动添加的主体定义" checked={draft.agent.includeManualSubjects}
                onChange={(v) => patch((d) => ({ ...d, agent: { ...d.agent, includeManualSubjects: v } }))} />
              <Toggle label="手动添加的资源定义" checked={draft.agent.includeManualResources}
                onChange={(v) => patch((d) => ({ ...d, agent: { ...d.agent, includeManualResources: v } }))} />
              <Toggle label="④ 的引用绑定关系" checked={draft.agent.includeBindings}
                onChange={(v) => patch((d) => ({ ...d, agent: { ...d.agent, includeBindings: v } }))} />
            </>
          ) : null}

          {tab === 'api' ? (
            <>
              <div className="text-[11px] text-muted-foreground">
                提示词增强与 AI 助手使用的模型配置；凭据保存在 ComfyUI/user/DeciiaEasyMedia/prompt_studio.json
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-20 text-muted-foreground">Provider</span>
                <input style={{ ...fieldStyle, width: 220 }} value={api.provider}
                  onChange={(e) => setApi({ ...api, provider: e.target.value })} />
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-20 text-muted-foreground">Model</span>
                <input style={{ ...fieldStyle, width: 220 }} value={api.model}
                  onChange={(e) => setApi({ ...api, model: e.target.value })} />
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-20 text-muted-foreground">Base URL</span>
                <input style={{ ...fieldStyle, width: 420 }} value={api.base_url}
                  onChange={(e) => setApi({ ...api, base_url: e.target.value })} />
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-20 text-muted-foreground">API key</span>
                <input
                  style={{ ...fieldStyle, width: 300 }}
                  placeholder={api.api_key_masked ? `已保存 ${api.api_key_masked}（留空不改）` : '填写 API key'}
                  value={api.api_key}
                  onChange={(e) => setApi({ ...api, api_key: e.target.value })}
                />
              </div>
              <Toggle label="上传参考图给模型" checked={api.upload_images}
                onChange={(v) => setApi({ ...api, upload_images: v })} />
              <div className="text-[10px] text-muted-foreground">配置路径：ComfyUI/user/DeciiaEasyMedia/prompt_studio.json</div>
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t pt-2" style={{ borderColor: BORDER }}>
          <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]"
            onClick={() => setDraft({ ...DEFAULT_DIRECTOR_SETTINGS })}>恢复默认</Button>
          <span className="ml-auto" />
          <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={onClose}>取消</Button>
          <Button size="sm" className="h-6 px-2 text-[11px]" disabled={apiSaving} onClick={async () => { await persistApi(); onSave(draft); onClose() }}>{apiSaving ? "保存中…" : "保存设置"}</Button>
        </div>
      </div>
    </div>
  )
}
