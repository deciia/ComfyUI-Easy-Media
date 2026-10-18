import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * 主体库卡片面板（对齐 Ref 主体节点的信息层级）。
 *
 * 数据：`{ global_prompt, subjects: [{ id, name, kind, retention, resource, resources, description, retention_text }] }`
 * 主体只保存资源身份（input 相对路径），不保存编号；编号在段内使用时由图内顺序决定。
 */

export interface SubjectResource {
  kind?: string
  path?: string
  sha256?: string
}

export interface SubjectEntry {
  id?: string
  name?: string
  kind?: string
  retention?: string
  resource?: SubjectResource
  resources?: SubjectResource[]
  description?: string
  retention_text?: string
  auto_append?: boolean
}

export interface SubjectData {
  global_prompt?: string
  subjects?: SubjectEntry[]
}

interface SubjectLibraryWidgetProps {
  value: SubjectData
  onChange: (value: SubjectData) => void
}

const KINDS = [
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'video', label: '视频' },
  { value: 'subject', label: '主体' },
]

const RETENTIONS = [
  { value: 'fully_preserved', label: '完全保留' },
  { value: 'partially_preserved', label: '部分保留' },
  { value: 'transferred', label: '迁移' },
  { value: 'reused', label: '复用' },
  { value: 'reference', label: '仅参考' },
]

function emptySubject(index: number): SubjectEntry {
  return {
    id: `subj-${Date.now()}-${index}`,
    name: '',
    kind: 'image',
    retention: 'fully_preserved',
    resource: { path: '' },
    resources: [],
    description: '',
    retention_text: '',
    auto_append: true,
  }
}

const inputClass = 'h-7 w-full rounded border border-neutral-600 bg-neutral-800 px-2 text-xs text-neutral-200'
const areaClass = 'min-h-[52px] w-full resize-y rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200'
const labelClass = 'text-[11px] text-neutral-400'

export function SubjectLibraryWidget({ value, onChange }: SubjectLibraryWidgetProps) {
  const t = useT()
  const data = useMemo<SubjectData>(() => (value && typeof value === 'object' ? value : {}), [value])
  const subjects = useMemo<SubjectEntry[]>(() => (Array.isArray(data.subjects) ? data.subjects : []), [data])

  function patch(next: Partial<SubjectData>) {
    onChange({ ...data, ...next })
  }

  function patchSubject(index: number, next: Partial<SubjectEntry>) {
    const list = subjects.map((subject, current) => (current === index ? { ...subject, ...next } : subject))
    patch({ subjects: list })
  }

  function removeSubject(index: number) {
    patch({ subjects: subjects.filter((_, current) => current !== index) })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2 text-xs">
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t('multitrack.subjectGlobalPrompt')}</span>
        <textarea
          className={areaClass}
          value={data.global_prompt ?? ''}
          placeholder={t('multitrack.subjectGlobalPromptPlaceholder')}
          onChange={(event) => patch({ global_prompt: event.target.value })}
        />
      </label>

      <div className="flex items-center justify-between">
        <span className={labelClass}>{t('multitrack.subjectCount', { count: String(subjects.length) })}</span>
      </div>

      {subjects.map((subject, index) => (
        <div key={subject.id ?? index} className="rounded-md border border-neutral-700 bg-neutral-900/60 p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-neutral-300">
              {t('multitrack.subjectCard', { index: String(index + 1) })}
            </span>
            <button
              type="button"
              className="flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              onClick={() => removeSubject(index)}
            >
              <Trash2 className="h-3 w-3" />
              {t('common.delete')}
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.subjectName')}</span>
              <input
                className={inputClass}
                value={subject.name ?? ''}
                placeholder={t('multitrack.subjectNamePlaceholder')}
                onChange={(event) => patchSubject(index, { name: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.subjectKind')}</span>
              <select
                className={inputClass}
                value={subject.kind ?? 'image'}
                onChange={(event) => patchSubject(index, { kind: event.target.value })}
              >
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('multitrack.subjectRetention')}</span>
              <select
                className={inputClass}
                value={subject.retention ?? 'fully_preserved'}
                onChange={(event) => patchSubject(index, { retention: event.target.value })}
              >
                {RETENTIONS.map((retention) => (
                  <option key={retention.value} value={retention.value}>{retention.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-1 flex flex-col gap-1">
            <span className={labelClass}>{t('multitrack.subjectResource')}</span>
            <input
              className={inputClass}
              value={subject.resource?.path ?? ''}
              placeholder="input 相对路径，如 yusheng/ep2/工作台.jpg"
              onChange={(event) => patchSubject(index, { resource: { ...(subject.resource ?? {}), path: event.target.value } })}
            />
          </label>

          <label className="mt-1 flex flex-col gap-1">
            <span className={labelClass}>{t('multitrack.subjectDescription')}</span>
            <textarea
              className={areaClass}
              value={subject.description ?? ''}
              placeholder="只写可见事实；可用 <@其他主体> 交叉引用"
              onChange={(event) => patchSubject(index, { description: event.target.value })}
            />
          </label>

          <label className="mt-1 flex flex-col gap-1">
            <span className={labelClass}>{t('multitrack.subjectRetentionText')}</span>
            <textarea
              className={areaClass}
              value={subject.retention_text ?? ''}
              placeholder="要保留的：面部/发色/身材比例/服装/颜色…"
              onChange={(event) => patchSubject(index, { retention_text: event.target.value })}
            />
          </label>

          <label className="mt-1 flex items-center gap-2 text-[11px] text-neutral-400">
            <input
              type="checkbox"
              checked={subject.auto_append !== false}
              onChange={(event) => patchSubject(index, { auto_append: event.target.checked })}
            />
            {t('multitrack.subjectAutoAppend')}
          </label>
        </div>
      ))}

      <button
        type="button"
        className={cn(
          'flex items-center justify-center gap-1 rounded border border-neutral-600 bg-neutral-800 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700',
        )}
        onClick={() => patch({ subjects: [...subjects, emptySubject(subjects.length)] })}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('multitrack.subjectAdd')}
      </button>
    </div>
  )
}
