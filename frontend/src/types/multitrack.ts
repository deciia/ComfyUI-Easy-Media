export type MultiTrackReferenceMode = 'off' | 'aligned' | 'global'

export type MultiTrackType = 'task' | 'video' | 'audio' | 'subtitle' | 'camera'

export type MultiTrackTaskMode = 'default' | 'l2v' | 'ref' | 'edit' | 'passthrough'

export type MultiTrackContinuityMode = 'shot' | 'context' | 'context_drift' | 'context_swap'

export type MultiTrackRefImageSize = 'match' | 'max'

export type MultiTrackUserPromptVariant = 'a' | 'b'

export type MultiTrackMediaType = 'image' | 'audio' | 'video' | 'subtitle' | 'none'

export type MultiTrackSourceType = 'preset' | 'input' | 'output' | 'local' | 'url' | 'slot'

export interface MultiTrackPanoramaView {
  version: 1
  projection: 'equirectangular'
  yaw: number
  pitch: number
  hfov: number
  aspect_ratio: number
}

export interface MultiTrackTaskImage {
  id: string
  source_type?: MultiTrackSourceType
  file_path?: string
  local_path?: string
  url?: string
  slot_name?: string
  file_name?: string
  panorama_view?: MultiTrackPanoramaView
  shared_reference?: boolean
  shared_reference_copy?: boolean
  muted?: boolean
}

export type CameraPreset =
  | 'static'
  | 'push_in'
  | 'pull_out'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'truck_left'
  | 'truck_right'
  | 'follow'
  | 'orbit'
  | 'crane_up'
  | 'crane_down'
  | 'handheld'
  | 'zoom_in'
  | 'zoom_out'

export type CameraEasing = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out'

export interface CameraKeyframe {
  /** 相对段起点的帧偏移 */
  frame: number
  preset: CameraPreset
  easing: CameraEasing
  strength?: number
}

export interface CameraData {
  preset?: CameraPreset
  easing?: CameraEasing
  strength?: number
  target?: 'subject' | 'scene' | 'custom'
  keyframes?: CameraKeyframe[]
  /** 编译后的英文运镜描述；为空时由 keyframes 生成 */
  compiled_prompt?: string
  motion_scene?: string
  playblast?: string
  camera_embedding?: string
  native_tracks?: string
}

export interface MultiTrackSegmentContent {
  media_type: MultiTrackMediaType
  source_type?: MultiTrackSourceType
  file_path?: string
  local_path?: string
  url?: string
  slot_name?: string
  file_name?: string
  text?: string
  user_prompt?: string
  /** 手写草稿（资产）：模态窗/手写输入的原始片段，永不覆盖 */
  user_brief?: string
  /** 规范版元信息（生成时间/语言/来源），用于「规范版已过期」检测 */
  prompt_meta?: { generated_at?: number; language?: string; source?: string; brief_hash?: string; generated_prompt?: string }
  user_prompt_b?: string
  user_prompt_variant?: MultiTrackUserPromptVariant
  system_prompt?: string
  task_mode?: MultiTrackTaskMode
  continuity_mode?: MultiTrackContinuityMode
  ref_image_size?: MultiTrackRefImageSize
  images?: MultiTrackTaskImage[]
  duration?: number
  volume_db?: number
  muted?: boolean
  speed?: number
  media_index?: number
  shared_reference?: boolean
  shared_media_index?: number
  /** Deciia P1: segment-level audio lock (参考/静音/锁定三标志). Track-level audio_locked still overrides when explicitly set on this segment's window. */
  audio_locked?: boolean
  /** Deciia P2: reference audio scope — 'window' (task window part only, default) or 'full' (whole file). */
  reference_scope?: 'window' | 'full'
  /** off / aligned(仅重叠任务可用) / global(全片可用) */
  reference_mode?: MultiTrackReferenceMode
  /** @deprecated Migrated to shared_reference when legacy workflows are loaded. */
  speaker_reference?: boolean
  subtitle_style?: MultiTrackSubtitleStyle
  subtitle_speech?: MultiTrackSubtitleSpeechSettings
  /** 相机轨段的运镜数据 */
  camera?: CameraData
}

export interface MultiTrackSubtitleSpeechSettings {
  model: 'VoxCPM2'
  prompt: string
  cfg: number
  steps: number
  referenceAudio: string
  referenceAudioSourceType?: Extract<MultiTrackSourceType, 'input' | 'output' | 'local'>
}

export interface MultiTrackSubtitleStyle {
  font_size: number
  color: string
  outline_color?: string
  background_color: string
  background_opacity: number
  x: number
  y: number
  width: number
}

export interface MultiTrackSegment {
  id: string
  start_frame: number
  end_frame: number
  origin_start_frame?: number
  content: MultiTrackSegmentContent
  color: string
}

export interface MultiTrackTaskMarker {
  id: string
  frame: number
}

export interface MultiTrack {
  id: string
  name: string
  type: MultiTrackType
  task_mode?: MultiTrackTaskMode
  color: string
  muted: boolean
  solo?: boolean
  visible?: boolean
  volume_db?: number
  locked: boolean
  audio_locked?: boolean
  media_index?: number
  segments: MultiTrackSegment[]
}

export type ProjectKind = 'video' | 'audio' | 'image'

export interface TrackData {
  tracks: MultiTrack[]
  total_length: number
  frame_rate: number
  task_markers?: MultiTrackTaskMarker[]
  task_overview?: boolean
  muted?: boolean
  volume_db?: number
  /** 当前时间线挂载的项目（timeline.json）；缺省表示只保存在工作流里。 */
  project?: {
    name: string
    updated_at?: number
    kind?: ProjectKind
  }
}

export interface TracksInfoMediaItem {
  index: number
  track_id: string
  segment_id: string
  source_type?: MultiTrackSourceType
  file_path?: string
  local_path?: string
  url?: string
  slot_name?: string
  file_name?: string
  duration?: number
  panorama_view?: MultiTrackPanoramaView
}

export interface TracksInfo {
  total_length: number
  frame_rate: number
  task_markers?: MultiTrackTaskMarker[]
  muted?: boolean
  volume_db?: number
  width: number
  height: number
  tracks: MultiTrack[]
  media: {
    images: TracksInfoMediaItem[]
    audio: TracksInfoMediaItem[]
    video: TracksInfoMediaItem[]
  }
}
