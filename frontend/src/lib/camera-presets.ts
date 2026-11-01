import type { CameraData, CameraEasing, CameraKeyframe, CameraPreset } from '@/types/multitrack'

export const CAMERA_PRESETS: Array<{ value: CameraPreset; label: string; phrase: string }> = [
  { value: 'static', label: '固定', phrase: 'a locked-off static camera' },
  { value: 'push_in', label: '推近', phrase: 'a slow push-in toward the subject' },
  { value: 'pull_out', label: '拉远', phrase: 'a slow pull-out away from the subject' },
  { value: 'pan_left', label: '左摇', phrase: 'a smooth pan to the left' },
  { value: 'pan_right', label: '右摇', phrase: 'a smooth pan to the right' },
  { value: 'tilt_up', label: '上摇', phrase: 'a smooth tilt upward' },
  { value: 'tilt_down', label: '下摇', phrase: 'a smooth tilt downward' },
  { value: 'truck_left', label: '左移', phrase: 'a lateral truck to the left' },
  { value: 'truck_right', label: '右移', phrase: 'a lateral truck to the right' },
  { value: 'follow', label: '跟随', phrase: 'a tracking follow with the subject' },
  { value: 'orbit', label: '环绕', phrase: 'an orbiting move around the subject' },
  { value: 'crane_up', label: '升镜', phrase: 'a crane rise upward' },
  { value: 'crane_down', label: '降镜', phrase: 'a crane descend downward' },
  { value: 'handheld', label: '手持', phrase: 'a subtle handheld camera' },
  { value: 'zoom_in', label: '变焦推', phrase: 'a zoom in' },
  { value: 'zoom_out', label: '变焦拉', phrase: 'a zoom out' },
]

export const CAMERA_EASINGS: Array<{ value: CameraEasing; label: string; phrase: string }> = [
  { value: 'linear', label: '匀速', phrase: 'linear' },
  { value: 'ease_in', label: '缓入', phrase: 'ease-in' },
  { value: 'ease_out', label: '缓出', phrase: 'ease-out' },
  { value: 'ease_in_out', label: '缓入缓出', phrase: 'ease-in-out' },
]

export function cameraPresetLabel(preset: CameraPreset | undefined): string {
  return CAMERA_PRESETS.find((item) => item.value === preset)?.label ?? '固定'
}

export function compileCameraPrompt(camera: CameraData | undefined): string {
  if (!camera) return ''
  const keyframes = Array.isArray(camera.keyframes) ? camera.keyframes : []
  if (keyframes.length === 0) {
    const preset = camera.preset ?? 'static'
    const phrase = CAMERA_PRESETS.find((item) => item.value === preset)?.phrase ?? preset
    const easing = CAMERA_EASINGS.find((item) => item.value === (camera.easing ?? 'ease_in_out'))?.phrase ?? 'ease-in-out'
    return `Camera: ${phrase} (${easing} easing).`
  }
  const ordered = [...keyframes].sort((left, right) => left.frame - right.frame)
  const parts = ordered.map((key, index) => {
    const phrase = CAMERA_PRESETS.find((item) => item.value === key.preset)?.phrase ?? key.preset
    const easing = CAMERA_EASINGS.find((item) => item.value === key.easing)?.phrase ?? 'ease-in-out'
    return index === 0
      ? `the shot opens with ${phrase} (${easing} easing)`
      : `then transitions to ${phrase} (${easing} easing)`
  })
  return `Camera: ${parts.join(', ')}.`
}

export function normalizeCamera(camera: CameraData | undefined): CameraData {
  const keyframes: CameraKeyframe[] = (camera?.keyframes ?? []).map((key) => ({
    frame: Math.max(0, Math.round(Number(key.frame) || 0)),
    preset: key.preset ?? camera?.preset ?? 'static',
    easing: key.easing ?? camera?.easing ?? 'ease_in_out',
    ...(typeof key.strength === 'number' ? { strength: key.strength } : {}),
  })).sort((left, right) => left.frame - right.frame)
  return {
    preset: camera?.preset ?? 'static',
    easing: camera?.easing ?? 'ease_in_out',
    target: camera?.target ?? 'subject',
    ...(typeof camera?.strength === 'number' ? { strength: camera.strength } : {}),
    keyframes,
    ...(camera?.compiled_prompt ? { compiled_prompt: camera.compiled_prompt } : {}),
    ...(camera?.motion_scene ? { motion_scene: camera.motion_scene } : {}),
    ...(camera?.playblast ? { playblast: camera.playblast } : {}),
    ...(camera?.camera_embedding ? { camera_embedding: camera.camera_embedding } : {}),
    ...(camera?.native_tracks ? { native_tracks: camera.native_tracks } : {}),
    ...(camera?.omnicam_state ? { omnicam_state: camera.omnicam_state } : {}),
  }
}
