/**
 * 提示词增强器的预设选项库。
 *
 * 来源：参考 MiniMaxRefDirector 的 CAMERA_MOTIONS / EXPRESSIONS / SHOT_SIZES / FRAMINGS
 * （两者均为 GPL-3.0，可直接借鉴改造）。
 *
 * 语义与 Ref 一致：
 *  - `key` 是英文规范表达，提交给模型；
 *  - 空数组 = 「模型自由决定」（对应 Ref 的“未设置/跟随全局默认”）；
 *  - 多选，数组顺序即优先级。
 */

export interface PresetOption {
  key: string
  label: string
}

export const CAMERA_MOTIONS: PresetOption[] = [
  { key: 'Push-in', label: '推近' },
  { key: 'Pull-back', label: '拉远' },
  { key: 'Push+Pull', label: '推拉结合' },
  { key: 'Orbit', label: '环绕' },
  { key: 'Tracking', label: '跟拍' },
  { key: 'Aerial', label: '航拍' },
  { key: 'Crane', label: '升降' },
  { key: 'Pan', label: '摇镜' },
  { key: 'Close-up', label: '特写' },
]

export const EXPRESSIONS: PresetOption[] = [
  { key: 'Gaze shift', label: '视线游移' },
  { key: 'Glance away', label: '别开视线' },
  { key: 'Fixed stare', label: '凝望' },
  { key: 'Slow blink', label: '缓眨' },
  { key: 'Brow raise', label: '挑眉' },
  { key: 'Brow furrow', label: '蹙眉' },
  { key: 'One brow', label: '单眉微挑' },
  { key: 'Lip press', label: '抿唇' },
  { key: 'Lip tighten', label: '嘴角绷紧' },
  { key: 'Fleeting smile', label: '转瞬微笑' },
  { key: 'Lips part', label: '双唇微启' },
  { key: 'Lip twitch', label: '嘴角微抽' },
  { key: 'Breath hold', label: '屏息' },
  { key: 'Soft sigh', label: '轻叹' },
  { key: 'Swallow', label: '吞咽' },
  { key: 'Head tilt', label: '头微倾' },
  { key: 'Head drop', label: '低头' },
  { key: 'Look away', label: '侧首回避' },
  { key: 'Neck tense', label: '肩颈绷紧' },
  { key: 'Hand restrain', label: '手部强抑' },
]

export const SHOT_SIZES: PresetOption[] = [
  { key: 'Extreme wide', label: '大远景' },
  { key: 'Wide', label: '远景' },
  { key: 'Full shot', label: '全景' },
  { key: 'Medium long', label: '中远景' },
  { key: 'Cowboy shot', label: '牛仔镜头' },
  { key: 'Medium', label: '中景' },
  { key: 'Medium close-up', label: '中近景' },
  { key: 'Close-up', label: '特写' },
  { key: 'Extreme close-up', label: '大特写' },
]

export const FRAMINGS: PresetOption[] = [
  { key: 'Over-the-shoulder', label: '过肩' },
  { key: 'Two-shot', label: '双人同框' },
  { key: 'Insert', label: '插入镜头' },
  { key: 'Establishing', label: '建立镜头' },
]

export const PRESET_GROUPS: Array<{ id: string; label: string; options: PresetOption[] }> = [
  { id: 'camera_motion', label: '运镜', options: CAMERA_MOTIONS },
  { id: 'expression', label: '微表情', options: EXPRESSIONS },
  { id: 'shot_size', label: '景别', options: SHOT_SIZES },
  { id: 'framing', label: '构图关系', options: FRAMINGS },
]

export function togglePreset(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
}
