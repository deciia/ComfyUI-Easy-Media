/**
 * OmniCam Director 操作协议（EasyMedia 侧实现）
 *
 * 与官方 `PLANNER_OPERATIONS` 同名对齐，字段直接映射 editor_state /
 * MotionScene 的相机结构（position / target / fov / roll ...）。
 * 这样我们的 AI 助手、分镜桥、外部脚本都能用同一套"操作列表"控制 3D 编辑器，
 * 而不必依赖 OmniCam 内置助手（它需要本地 Ollama 模型）。
 */

export type Vec3 = [number, number, number]

export interface EditorCameraState {
  position: Vec3
  target: Vec3
  fov: number
  roll: number
  camera_type?: string
  zoom?: number
  near?: number
  far?: number
}

export interface EditorKeyframe {
  frame: number
  camera: Partial<EditorCameraState>
  interpolation?: string
}

export interface EditorCamera {
  id: string
  name: string
  enabled: boolean
  camera: Partial<EditorCameraState>
  keyframes: EditorKeyframe[]
}

export interface EditorStateLike {
  schema_version?: number
  fps: number
  duration_frames: number
  cameras: EditorCamera[]
  objects?: unknown[]
  active_camera_id?: string
  playblast_camera_id?: string
}

export type CameraOp =
  | { op: 'camera.create'; name?: string; camera?: Partial<EditorCameraState> }
  | { op: 'camera.duplicate'; camera: string; name?: string }
  | { op: 'camera.delete'; camera: string }
  | { op: 'camera.rename'; camera: string; name: string }
  | { op: 'camera.set_active'; camera: string }
  | {
      op: 'camera.transform'
      camera: string
      frame?: number
      position?: Vec3
      target?: Vec3
      fov?: number
      roll?: number
    }
  | { op: 'camera.look_at'; camera: string; target: Vec3; frame?: number }
  | {
      op: 'keyframe.upsert'
      camera: string
      frame: number
      cameraState?: Partial<EditorCameraState>
      interpolation?: string
    }
  | { op: 'keyframe.remove'; camera: string; frame: number }
  | { op: 'keyframe.set_interpolation'; camera: string; frame: number; interpolation: string }
  | { op: 'timeline.set_duration'; duration_frames?: number; duration_seconds?: number }
  | { op: 'timeline.set_range'; start: number; end: number }

export interface ApplyPlanResult {
  state: EditorStateLike
  applied: string[]
  skipped: Array<{ op: string; reason: string }>
}

const DEFAULT_CAMERA: EditorCameraState = {
  position: [0, 0, 0],
  target: [0, 0, -1],
  fov: 53,
  roll: 0,
  camera_type: 'perspective',
  zoom: 1,
  near: 0.01,
  far: 10000,
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function findCamera(state: EditorStateLike, ref: string): EditorCamera | null {
  if (!ref) return null
  return (
    state.cameras.find((camera) => camera.id === ref) ??
    state.cameras.find((camera) => camera.name === ref) ??
    null
  )
}

function nextCameraId(state: EditorStateLike): string {
  let index = state.cameras.length + 1
  let id = `camera_${index}`
  const taken = new Set(state.cameras.map((camera) => camera.id))
  while (taken.has(id)) {
    index += 1
    id = `camera_${index}`
  }
  return id
}

function mergeCamera(base: Partial<EditorCameraState> | undefined, patch: Partial<EditorCameraState>): Partial<EditorCameraState> {
  return { ...DEFAULT_CAMERA, ...(base ?? {}), ...patch }
}

function upsertKeyframe(camera: EditorCamera, frame: number, patch: Partial<EditorCameraState>, interpolation?: string): void {
  const index = camera.keyframes.findIndex((key) => key.frame === frame)
  const next: EditorKeyframe = {
    frame,
    camera: mergeCamera(index >= 0 ? camera.keyframes[index].camera : camera.camera, patch),
    interpolation: interpolation ?? (index >= 0 ? camera.keyframes[index].interpolation : 'linear'),
  }
  if (index >= 0) camera.keyframes[index] = next
  else camera.keyframes.push(next)
  camera.keyframes.sort((left, right) => left.frame - right.frame)
}

/**
 * 把一组操作应用到 editor_state 上，返回新状态。
 * 不支持的操作会被跳过并给出原因（不抛异常），与官方"计划→校验→应用"语义一致。
 */
export function applyCameraOps(source: EditorStateLike, ops: CameraOp[]): ApplyPlanResult {
  const state = clone(source)
  state.cameras = Array.isArray(state.cameras) ? state.cameras : []
  state.duration_frames = Math.max(1, Math.round(state.duration_frames || 1))
  const applied: string[] = []
  const skipped: Array<{ op: string; reason: string }> = []

  for (const raw of ops) {
    const op = String((raw as { op?: string }).op ?? '')
    try {
      switch (raw.op) {
        case 'camera.create': {
          const id = nextCameraId(state)
          state.cameras.push({
            id,
            name: raw.name || `Camera ${state.cameras.length + 1}`,
            enabled: true,
            camera: mergeCamera(undefined, raw.camera ?? {}),
            keyframes: [],
          })
          state.active_camera_id = state.active_camera_id || id
          applied.push(op)
          break
        }
        case 'camera.duplicate': {
          const sourceCamera = findCamera(state, raw.camera)
          if (!sourceCamera) throw new Error(`camera not found: ${raw.camera}`)
          const copy = clone(sourceCamera)
          copy.id = nextCameraId(state)
          copy.name = raw.name || `${sourceCamera.name} copy`
          state.cameras.push(copy)
          applied.push(op)
          break
        }
        case 'camera.delete': {
          const index = state.cameras.findIndex(
            (camera) => camera.id === raw.camera || camera.name === raw.camera,
          )
          if (index < 0) throw new Error(`camera not found: ${raw.camera}`)
          if (state.cameras.length <= 1) throw new Error('cannot delete the last camera')
          state.cameras.splice(index, 1)
          if (state.active_camera_id === raw.camera) state.active_camera_id = state.cameras[0].id
          applied.push(op)
          break
        }
        case 'camera.rename': {
          const camera = findCamera(state, raw.camera)
          if (!camera) throw new Error(`camera not found: ${raw.camera}`)
          camera.name = String(raw.name || camera.name)
          applied.push(op)
          break
        }
        case 'camera.set_active': {
          const camera = findCamera(state, raw.camera)
          if (!camera) throw new Error(`camera not found: ${raw.camera}`)
          state.active_camera_id = camera.id
          applied.push(op)
          break
        }
        case 'camera.transform':
        case 'camera.look_at': {
          const camera = findCamera(state, raw.camera)
          if (!camera) throw new Error(`camera not found: ${raw.camera}`)
          const patch: Partial<EditorCameraState> = {}
          if (raw.op === 'camera.transform') {
            if (raw.position) patch.position = raw.position
            if (raw.target) patch.target = raw.target
            if (typeof raw.fov === 'number') patch.fov = raw.fov
            if (typeof raw.roll === 'number') patch.roll = raw.roll
          } else {
            patch.target = raw.target
          }
          const frame = raw.frame
          if (typeof frame === 'number') {
            upsertKeyframe(camera, Math.round(frame), patch, 'ease_in_out')
          } else {
            camera.camera = mergeCamera(camera.camera, patch)
          }
          applied.push(op)
          break
        }
        case 'keyframe.upsert': {
          const camera = findCamera(state, raw.camera)
          if (!camera) throw new Error(`camera not found: ${raw.camera}`)
          const frame = Math.max(0, Math.min(state.duration_frames - 1, Math.round(raw.frame)))
          upsertKeyframe(camera, frame, raw.cameraState ?? {}, raw.interpolation)
          applied.push(op)
          break
        }
        case 'keyframe.remove': {
          const camera = findCamera(state, raw.camera)
          if (!camera) throw new Error(`camera not found: ${raw.camera}`)
          camera.keyframes = camera.keyframes.filter((key) => key.frame !== Math.round(raw.frame))
          applied.push(op)
          break
        }
        case 'keyframe.set_interpolation': {
          const camera = findCamera(state, raw.camera)
          if (!camera) throw new Error(`camera not found: ${raw.camera}`)
          const key = camera.keyframes.find((item) => item.frame === Math.round(raw.frame))
          if (!key) throw new Error(`keyframe not found at frame ${raw.frame}`)
          key.interpolation = raw.interpolation
          applied.push(op)
          break
        }
        case 'timeline.set_duration': {
          const frames =
            typeof raw.duration_frames === 'number'
              ? raw.duration_frames
              : Math.round((raw.duration_seconds ?? 0) * (state.fps || 24))
          if (frames > 0) state.duration_frames = Math.max(1, Math.round(frames))
          applied.push(op)
          break
        }
        case 'timeline.set_range': {
          const start = Math.max(0, Math.round(raw.start))
          const end = Math.max(start + 1, Math.round(raw.end))
          state.duration_frames = Math.max(state.duration_frames, end)
          applied.push(op)
          break
        }
        default:
          skipped.push({ op, reason: 'unsupported operation' })
      }
    } catch (error) {
      skipped.push({ op, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return { state, applied, skipped }
}

/** 把"推近/环绕/跟随"这类中文运镜描述映射到相机预设（未命中返回 null）。 */
export function presetFromCameraText(text: string): string | null {
  const value = String(text || '').toLowerCase()
  if (!value.trim()) return null
  const table: Array<[RegExp, string]> = [
    [/推近|推进|push.?in|dolly.?in/, 'push_in'],
    [/拉远|后拉|pull.?out|dolly.?out/, 'pull_out'],
    [/左摇|pan.?left|向左转/, 'pan_left'],
    [/右摇|pan.?right|向右转/, 'pan_right'],
    [/上摇|仰|tilt.?up|向上/, 'tilt_up'],
    [/下摇|俯|tilt.?down|向下/, 'tilt_down'],
    [/左移|truck.?left|向左移动/, 'truck_left'],
    [/右移|truck.?right|向右移动/, 'truck_right'],
    [/跟随|跟拍|follow|tracking/, 'follow'],
    [/环绕|围绕|orbit|arc/, 'orbit'],
    [/升|起|吊臂|crane.?up|上升/, 'crane_up'],
    [/降|crane.?down|下降/, 'crane_down'],
    [/手持|晃动|handheld|shaky/, 'handheld'],
    [/变焦.?推|zoom.?in|放大/, 'zoom_in'],
    [/变焦.?拉|zoom.?out|缩小/, 'zoom_out'],
    [/固定|静止|锁定|static|fixed|locked/, 'static'],
  ]
  for (const [pattern, preset] of table) {
    if (pattern.test(value)) return preset
  }
  return null
}
