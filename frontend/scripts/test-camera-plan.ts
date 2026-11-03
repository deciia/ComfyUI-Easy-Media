import { applyCameraOps, presetFromCameraText, type EditorStateLike, type CameraOp } from '../src/lib/camera-plan'

const base: EditorStateLike = {
  schema_version: 1,
  fps: 24,
  duration_frames: 120,
  cameras: [
    {
      id: 'camera_1',
      name: 'Camera 1',
      enabled: true,
      camera: { position: [0, 0, 0], target: [0, 0, -1], fov: 53, roll: 0 },
      keyframes: [{ frame: 0, camera: { position: [0, 0, 0], target: [0, 0, -1], fov: 53, roll: 0 }, interpolation: 'linear' }],
    },
  ],
  objects: [],
  active_camera_id: 'camera_1',
}

let failures = 0
function check(label: string, condition: boolean, extra?: unknown) {
  if (condition) {
    console.log('  PASS', label)
  } else {
    failures += 1
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200))
  }
}

// 1) camera.create + set_active
{
  const ops: CameraOp[] = [{ op: 'camera.create', name: 'Shot 2' }, { op: 'camera.set_active', camera: 'Shot 2' }]
  const { state, applied, skipped } = applyCameraOps(base, ops)
  check('create adds camera', state.cameras.length === 2, state.cameras)
  check('create applied both', applied.length === 2 && skipped.length === 0, skipped)
  check('set_active by name', state.active_camera_id === state.cameras[1].id, state.active_camera_id)
  check('source untouched (pure)', base.cameras.length === 1)
}

// 2) keyframe.upsert 排序 + 合并
{
  const ops: CameraOp[] = [
    { op: 'keyframe.upsert', camera: 'Camera 1', frame: 60, cameraState: { position: [0, 0, -2] }, interpolation: 'ease_in_out' },
    { op: 'keyframe.upsert', camera: 'Camera 1', frame: 30, cameraState: { position: [0, 0, -1] } },
  ]
  const { state } = applyCameraOps(base, ops)
  const frames = state.cameras[0].keyframes.map((key) => key.frame)
  check('keyframes sorted', JSON.stringify(frames) === '[0,30,60]', frames)
  const kf60 = state.cameras[0].keyframes.find((key) => key.frame === 60)!
  check('camera merged with defaults', kf60.camera.fov === 53 && kf60.camera.target![2] === -1, kf60.camera)
  check('interpolation set', kf60.interpolation === 'ease_in_out')
}

// 3) camera.transform with frame → upsert keyframe
{
  const { state } = applyCameraOps(base, [
    { op: 'camera.transform', camera: 'Camera 1', frame: 119, position: [1, 2, 3] },
  ])
  const kf = state.cameras[0].keyframes.find((key) => key.frame === 119)
  check('transform at frame upserts keyframe', !!kf && kf.camera.position![1] === 2, kf)
}

// 4) camera.transform without frame → base camera
{
  const { state } = applyCameraOps(base, [{ op: 'camera.transform', camera: 'Camera 1', fov: 35 }])
  check('transform without frame edits base', state.cameras[0].camera.fov === 35)
}

// 5) look_at
{
  const { state } = applyCameraOps(base, [{ op: 'camera.look_at', camera: 'Camera 1', target: [5, 1, 0], frame: 10 }])
  const kf = state.cameras[0].keyframes.find((key) => key.frame === 10)!
  check('look_at sets target', JSON.stringify(kf.camera.target) === '[5,1,0]', kf.camera.target)
}

// 6) 删除最后一台相机 → 跳过而不是崩溃
{
  const { applied, skipped } = applyCameraOps(base, [{ op: 'camera.delete', camera: 'Camera 1' }])
  check('delete last camera skipped', applied.length === 0 && skipped.length === 1, skipped)
}

// 7) 未知操作 → skipped
{
  const { skipped } = applyCameraOps(base, [{ op: 'character.set_pose' } as unknown as CameraOp])
  check('unknown op skipped', skipped.length === 1 && skipped[0].reason.includes('unsupported'), skipped)
}

// 8) timeline.set_duration / set_range
{
  const { state } = applyCameraOps(base, [
    { op: 'timeline.set_duration', duration_seconds: 5 },
    { op: 'timeline.set_range', start: 0, end: 200 },
  ])
  check('duration from seconds', state.duration_frames === 200, state.duration_frames)
}

// 9) presetFromCameraText
{
  const cases: Array<[string, string]> = [
    ['缓慢推近，最后微停', 'push_in'],
    ['环绕主体半圈', 'orbit'],
    ['固定机位', 'static'],
    ['手持轻微晃动', 'handheld'],
    ['slow push-in toward subject', 'push_in'],
  ]
  for (const [text, expected] of cases) {
    const got = presetFromCameraText(text)
    check(`preset "${text}" -> ${expected}`, got === expected, got)
  }
  check('preset empty -> null', presetFromCameraText('') === null)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
