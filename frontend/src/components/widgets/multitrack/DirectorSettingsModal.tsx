import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DEFAULT_DIRECTOR_SETTINGS, DEFAULT_PROMPT_RULES, PROMPT_RULES_PRESETS, type DirectorSettings } from './directorSettings'
import { ResourceGenSettings } from './ResourceGenSettings'

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
  const [tab, setTab] = useState<'save' | 'audio' | 'agent' | 'api' | 'resource' | 'appearance'>('save')
  type ApiProfile = {
    id: string
    name: string
    provider: string
    model: string
    base_url: string
    api_key: string
    api_key_masked: string
    upload_images: boolean
  }
  const [profiles, setProfiles] = useState<ApiProfile[]>([])
  const [activeProfile, setActiveProfile] = useState('')
  const [apiSaving, setApiSaving] = useState(false)
  const [uiScale, setUiScale] = useState<number>(() => {
    const saved = Number(globalThis.localStorage?.getItem('easy-media-ui-scale') || 0)
    return saved >= 70 && saved <= 200 ? saved : 100
  })
  const [chatScale, setChatScale] = useState<number>(() => {
    const saved = Number(globalThis.localStorage?.getItem('easy-media-chat-scale') || 0)
    return saved >= 80 && saved <= 200 ? saved : 100
  })
  const applyAppearance = (nextUi: number, nextChat: number) => {
    setUiScale(nextUi)
    setChatScale(nextChat)
    try {
      globalThis.localStorage?.setItem('easy-media-ui-scale', String(nextUi))
      globalThis.localStorage?.setItem('easy-media-chat-scale', String(nextChat))
    } catch { /* ignore */ }
    try {
      globalThis.dispatchEvent(new CustomEvent('easy-media-appearance-change', { detail: { uiScale: nextUi, chatScale: nextChat } }))
    } catch { /* ignore */ }
  }
  useEffect(() => {
    if (!open) return
    fetch('/easy-media/prompt-studio/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data?.ok) return
        const list = Array.isArray(data.profiles) ? data.profiles : []
        setProfiles(list.map((item: Record<string, unknown>) => ({
          id: String(item.id ?? ''),
          name: String(item.name ?? item.provider ?? ''),
          provider: String(item.provider ?? ''),
          model: String(item.model ?? ''),
          base_url: String(item.base_url ?? ''),
          api_key: '',
          api_key_masked: String(item.api_key_tail ? `…${item.api_key_tail}` : (item.api_key_set ? '已保存' : '')),
          upload_images: item.upload_images !== false,
        })))
        setActiveProfile(String(data.active_profile ?? list[0]?.id ?? ''))
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
          profiles: profiles.map((item) => ({
            id: item.id,
            name: item.name || item.provider,
            provider: item.provider,
            model: item.model,
            base_url: item.base_url,
            api_key: item.api_key || undefined,
            upload_images: item.upload_images,
          })),
          active_profile: activeProfile,
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
          {([['save', '保存'], ['audio', '音频与字幕'], ['agent', 'AI 助手'], ['api', 'API'], ['resource', '资源生成'], ['appearance', '外观']] as const).map(([key, label]) => (
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
                  onChange={(event) => patch((d) => ({ ...d, agent: { ...d.agent, skillPreset: event.target.value, promptRules: event.target.value === 'custom' ? d.agent.promptRules : (PROMPT_RULES_PRESETS[event.target.value] ?? '') } }))}
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
                  value={draft.agent.promptRules}
                  placeholder={DEFAULT_PROMPT_RULES}
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

          {tab === 'resource' ? (
            <ResourceGenSettings />
          ) : null}

          {tab === 'appearance' ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">界面缩放</span>
                <div className="flex flex-wrap gap-1">
                  {[90, 100, 110, 125, 150, 175].map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={uiScale === value ? 'default' : 'secondary'}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => applyAppearance(value, chatScale)}
                    >
                      {value}%
                    </Button>
                  ))}
                </div>
                <span className="text-[10px] text-muted-foreground">缩放整个导演台（含三栏、设置、弹窗）；远程看不清时调到 125–150% 最实用</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">字体大小</span>
                <div className="flex flex-wrap gap-1">
                  {[90, 100, 110, 125, 150].map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={chatScale === value ? 'default' : 'secondary'}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => applyAppearance(uiScale, value)}
                    >
                      {value}%
                    </Button>
                  ))}
                </div>
                <span className="text-[10px] text-muted-foreground">放大导演台内所有文字（按钮/标签/对话/输入框），与界面缩放可叠加；远程看不清建议 110–125%</span>
              </div>
              <div className="rounded border p-2 text-[11px] text-muted-foreground" style={{ borderColor: BORDER }}>
                当前：界面 {uiScale}% · 对话 {chatScale}%<br />
                设置存于本机浏览器（localStorage），换设备需重设。
              </div>
            </>
          ) : null}

          {tab === 'api' ? (
            <>
              <div className="text-[11px] text-muted-foreground">
                可保存多套模型配置（如 GLM / DeepSeek / MiniMax / 火山），点「使用」切换当前生效的一套；凭据保存在 ComfyUI/user/DeciiaEasyMedia/prompt_studio.json
              </div>
              <div className="flex flex-col gap-1">
                {profiles.length === 0 ? (
                  <div className="rounded border p-2 text-[11px] text-muted-foreground" style={{ borderColor: BORDER }}>
                    还没有配置，点下方「＋ 新增配置」添加。
                  </div>
                ) : profiles.map((item) => {
                  const active = item.id === activeProfile
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 rounded border px-2 py-1 text-[11px]"
                      style={{ borderColor: active ? PRIMARY : BORDER, background: active ? 'hsl(var(--primary, 199 89% 48%) / 0.10)' : 'transparent' }}
                    >
                      <button
                        type="button"
                        className="rounded px-2 py-0.5"
                        style={{ border: `1px solid ${active ? PRIMARY : BORDER}`, color: active ? PRIMARY : undefined }}
                        onClick={() => setActiveProfile(item.id)}
                        title="切换为当前生效配置"
                      >
                        {active ? '使用中' : '使用'}
                      </button>
                      <span className="min-w-0 flex-1 truncate">
                        {item.name || item.provider}
                        <span className="ml-2 text-muted-foreground">{item.provider} · {item.model}</span>
                        {item.api_key_masked ? <span className="ml-2 text-muted-foreground">key {item.api_key_masked}</span> : null}
                      </span>
                      <button
                        type="button"
                        className="rounded px-1.5 text-[10px]"
                        style={{ border: `1px solid ${BORDER}` }}
                        onClick={() => {
                          setProfiles((current) => current.filter((entry) => entry.id !== item.id))
                          setActiveProfile((current) => (current === item.id ? (profiles.find((entry) => entry.id !== item.id)?.id ?? '') : current))
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )
                })}
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => {
                      const id = `p${Date.now().toString(36)}`
                      setProfiles((current) => [...current, {
                        id,
                        name: `配置 ${current.length + 1}`,
                        provider: 'glm',
                        model: 'glm-5.3-flash',
                        base_url: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
                        api_key: '',
                        api_key_masked: '',
                        upload_images: true,
                      }])
                      setActiveProfile(id)
                    }}
                  >
                    ＋ 新增配置
                  </Button>
                </div>
              </div>
              {(() => {
                const current = profiles.find((item) => item.id === activeProfile)
                if (!current) return null
                const patch = (next: Partial<ApiProfile>) => setProfiles((list) => list.map((item) => (item.id === current.id ? { ...item, ...next } : item)))
                return (
                  <>
                    <div className="border-t pt-1 text-[11px] text-muted-foreground" style={{ borderColor: BORDER }}>编辑当前配置：{current.name}</div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 text-muted-foreground">名称</span>
                      <input style={{ ...fieldStyle, width: 220 }} value={current.name} onChange={(e) => patch({ name: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 text-muted-foreground">Provider</span>
                      <input style={{ ...fieldStyle, width: 220 }} value={current.provider} placeholder="glm / deepseek / minimax-cn / ark" onChange={(e) => patch({ provider: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 text-muted-foreground">Model</span>
                      <input style={{ ...fieldStyle, width: 220 }} value={current.model} onChange={(e) => patch({ model: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 text-muted-foreground">Base URL</span>
                      <input style={{ ...fieldStyle, width: 420 }} value={current.base_url} onChange={(e) => patch({ base_url: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 text-muted-foreground">API key</span>
                      <input
                        style={{ ...fieldStyle, width: 300 }}
                        placeholder={current.api_key_masked ? `已保存 ${current.api_key_masked}（留空不改）` : '填写 API key'}
                        value={current.api_key}
                        onChange={(e) => patch({ api_key: e.target.value })}
                      />
                    </div>
                    <Toggle label="上传参考图给模型" checked={current.upload_images} onChange={(v) => patch({ upload_images: v })} />
                  </>
                )
              })()}
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
