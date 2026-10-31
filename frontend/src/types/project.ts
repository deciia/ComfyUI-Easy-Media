export type ProjectContinuityMode = 'shot' | 'context' | 'context_drift' | 'context_swap'

export interface ProjectVideoFile {
  file_path: string
  file_name: string
  media_revision?: string
  source_frame_count: number
  width?: number
  height?: number
  duration?: number
  continuity_mode?: ProjectContinuityMode
}

export interface ProjectClip {
  id: string
  index: number
  file_path: string
  file_name: string
  media_revision?: string
  source_start_frame: number
  source_end_frame: number
  source_frame_count: number
  continuity_mode: ProjectContinuityMode
  enabled: boolean
  /** audio_first 工程的音频段标记 */
  media_kind?: 'video' | 'audio'
  /** 图片工程：该段选中的帧序号（0 起） */
  image_frame?: number
  duration?: number
  video_files?: ProjectVideoFile[]
  audio_files?: ProjectVideoFile[]
}

export interface ProjectGenSettings {
  base_width: number
  base_height: number
  upscale_by: number
  second_pass: boolean
  hyper_vae: boolean
}

export interface ProjectData {
  project_name: string
  width: number
  height: number
  frame_rate: number
  clips: ProjectClip[]
  auto_combine: boolean
  /** audio_first（有声剧）工程：只合成/预览音频 */
  audio_only?: boolean
  /** image_first 工程：候选帧（逗号分隔） */
  image_first?: boolean
  image_candidate_frames?: string
  gen_settings?: ProjectGenSettings | null
  updated_at?: number
}

export const DEFAULT_PROJECT_DATA: ProjectData = {
  project_name: 'default',
  width: 0,
  height: 0,
  frame_rate: 24,
  clips: [],
  auto_combine: true,
}
