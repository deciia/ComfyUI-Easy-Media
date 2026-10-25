/**
 * 任务类型 ↔ 可用素材的约束（依据节点真实实现）：
 * nodes/basic.py::_multitrack_task_type
 *   default → i2v(有图，仅首帧) / t2v(无图)
 *   ref     → rv2v(有参考视频) / r2v(参考图+参考音)
 *   edit    → vi2v(有图) / v2v
 *   l2v     → 尾帧
 * nodes/minimax.py::MAX_REF_IMAGES = 9
 */
export type TaskModeKey = 'default' | 'ref' | 'edit' | 'l2v' | 'passthrough'

export interface TaskModeSpec {
  key: TaskModeKey
  label: string
  /** 实际映射到的 H3 生成类型（用于解释） */
  resolvesTo: string
  images: { min: number; max: number }
  video: { min: number; max: number }
  audio: { min: number; max: number }
  hint: string
}

export const TASK_MODE_SPECS: Record<TaskModeKey, TaskModeSpec> = {
  default: {
    key: 'default',
    label: 'T2V',
    resolvesTo: '无图→t2v / 1图→i2v(首帧)',
    images: { min: 0, max: 1 },
    video: { min: 0, max: 0 },
    audio: { min: 0, max: 0 },
    hint: '纯文本；最多 1 张图且只当首帧，多传的图会被忽略',
  },
  ref: {
    key: 'ref',
    label: 'R2V',
    resolvesTo: '参考图→r2v / 带参考视频→rv2v',
    images: { min: 1, max: 9 },
    video: { min: 0, max: 1 },
    audio: { min: 0, max: 1 },
    hint: '1–9 张参考图，可加 1 段参考视频 / 1 段参考音频',
  },
  edit: {
    key: 'edit',
    label: 'VI2V',
    resolvesTo: '有图→vi2v / 无图→v2v',
    images: { min: 1, max: 9 },
    video: { min: 0, max: 1 },
    audio: { min: 0, max: 1 },
    hint: '在现有视频上改：至少 1 张图，最多 9 张',
  },
  l2v: {
    key: 'l2v',
    label: 'L2V',
    resolvesTo: 'l2v(尾帧)',
    images: { min: 1, max: 1 },
    video: { min: 0, max: 0 },
    audio: { min: 0, max: 0 },
    hint: '只用尾帧：恰好 1 张',
  },
  passthrough: {
    key: 'passthrough',
    label: 'Pass',
    resolvesTo: '不生成',
    images: { min: 0, max: 0 },
    video: { min: 0, max: 0 },
    audio: { min: 0, max: 0 },
    hint: '直通不生成，不需要任何素材',
  },
}

export interface AssetCounts {
  images: number
  video: number
  audio: number
}

/** 返回该模式下素材是否合规；problems 为空即合规 */
export function checkTaskModeAssets(taskMode: string, counts: AssetCounts): {
  spec: TaskModeSpec
  ok: boolean
  problems: string[]
} {
  const key = (String(taskMode || 'default').toLowerCase() as TaskModeKey)
  const spec = TASK_MODE_SPECS[key] ?? TASK_MODE_SPECS.default
  const problems: string[] = []
  if (counts.images < spec.images.min || counts.images > spec.images.max) {
    problems.push(`图片 ${counts.images} 张，${spec.label} 要求 ${spec.images.min}–${spec.images.max} 张`)
  }
  if (counts.video < spec.video.min || counts.video > spec.video.max) {
    problems.push(`参考视频 ${counts.video} 段，${spec.label} 要求 ${spec.video.min}–${spec.video.max} 段`)
  }
  if (counts.audio < spec.audio.min || counts.audio > spec.audio.max) {
    problems.push(`参考音频 ${counts.audio} 段，${spec.label} 要求 ${spec.audio.min}–${spec.audio.max} 段`)
  }
  return { spec, ok: problems.length === 0, problems }
}

/** 该模式最多能绑定多少张图片（供 UI 限制） */
export function maxImagesForTaskMode(taskMode: string): number {
  const key = (String(taskMode || 'default').toLowerCase() as TaskModeKey)
  return (TASK_MODE_SPECS[key] ?? TASK_MODE_SPECS.default).images.max
}
