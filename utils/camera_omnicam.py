"""EasyMedia 相机数据 ↔ Vendored OmniCam 引擎。

把编辑器里的预设/关键帧编译成 OmniCamTrack，再取运镜描述块（层A 提示词注入），
motion_scene 可落盘供层B/C 复用。
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

PRESET_MAP = {
    "push_in": "dolly_in",
    "pull_out": "dolly_out",
    "pan_left": "pan_left",
    "pan_right": "pan_right",
    "tilt_up": "tilt_up",
    "tilt_down": "tilt_down",
    "truck_left": "truck_left",
    "truck_right": "truck_right",
    "crane_up": "crane_up",
    "crane_down": "crane_down",
    "orbit": "orbit_right",
    "handheld": None,
    "zoom_in": None,
    "zoom_out": None,
    "follow": "truck_right",
    "static": None,
}


def _base_track_dict(fps: float, frames: int, width: int, height: int) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "fps": float(fps),
        "duration_frames": max(2, int(frames)),
        "width": int(width),
        "height": int(height),
        "render_mode": "omni_ref",
        "keyframes": [
            {
                "frame": 0,
                "camera": {
                    "position": [0.0, 1.5, 6.0],
                    "target": [0.0, 1.5, 0.0],
                    "fov": 35.0,
                    "roll": 0.0,
                },
                "interpolation": "ease",
            },
            {
                "frame": max(1, int(frames) - 1),
                "camera": {
                    "position": [0.0, 1.5, 6.0],
                    "target": [0.0, 1.5, 0.0],
                    "fov": 35.0,
                    "roll": 0.0,
                },
                "interpolation": "ease",
            },
        ],
        "objects": [
            {
                "id": "subject",
                "type": "card",
                "name": "Subject",
                "position": [0.0, 1.5, 0.0],
                "size": [2.0, 3.0],
                "enabled": True,
            }
        ],
        "metadata": {"source": "easy_media"},
    }


def _keyframes_of(camera: dict[str, Any], frames: int) -> list[dict[str, Any]]:
    keyframes = camera.get("keyframes")
    if not isinstance(keyframes, list) or not keyframes:
        preset = str(camera.get("preset") or "static")
        return [
            {"frame": 0, "preset": preset, "easing": str(camera.get("easing") or "ease_in_out")},
            {"frame": max(1, int(frames) - 1), "preset": preset, "easing": str(camera.get("easing") or "ease_in_out")},
        ]
    cleaned = []
    for key in keyframes:
        if not isinstance(key, dict):
            continue
        cleaned.append({
            "frame": max(0, int(key.get("frame") or 0)),
            "preset": str(key.get("preset") or "static"),
            "easing": str(key.get("easing") or "ease_in_out"),
        })
    cleaned.sort(key=lambda item: item["frame"])
    if not cleaned or cleaned[0]["frame"] != 0:
        cleaned.insert(0, {"frame": 0, "preset": cleaned[0]["preset"] if cleaned else "static", "easing": "linear"})
    if cleaned[-1]["frame"] < frames - 1:
        cleaned.append({"frame": frames - 1, "preset": cleaned[-1]["preset"], "easing": "linear"})
    return cleaned


def build_omnicam_track(camera: dict[str, Any] | None, *, fps: float, frames: int,
                        width: int = 1280, height: int = 720):
    """把 EasyMedia 相机数据编译成 OmniCamTrack（多关键帧按区间应用预设）。"""
    from ..vendor.omnicam.core.camera_tools import add_camera_shake, apply_camera_preset
    from ..vendor.omnicam.core.track import CameraKeyframe, CameraState, OmniCamTrack

    camera = camera if isinstance(camera, dict) else {}
    total = max(2, int(frames))
    track = OmniCamTrack.from_dict(_base_track_dict(fps, total, width, height))
    keyframes = _keyframes_of(camera, total)

    state = track.sample(0)
    result_keys: list[CameraKeyframe] = [CameraKeyframe(0, CameraState.from_dict(asdict(state)), "linear")]
    for index in range(1, len(keyframes)):
        start = keyframes[index - 1]
        end = keyframes[index]
        span = max(1, end["frame"] - start["frame"])
        preset = PRESET_MAP.get(end["preset"], None)
        amount = float(camera.get("strength") or 1.0)
        next_state = CameraState.from_dict(asdict(state))
        if preset:
            span_track = OmniCamTrack.from_dict({
                **_base_track_dict(fps, span + 1, width, height),
                "keyframes": [
                    {"frame": 0, "camera": asdict(state), "interpolation": "linear"},
                    {"frame": span, "camera": asdict(state), "interpolation": "linear"},
                ],
            })
            moved = apply_camera_preset(span_track, preset, amount=amount)
            next_state = moved.sample(span)
        elif end["preset"] in {"zoom_in", "zoom_out"}:
            next_state = CameraState.from_dict(asdict(state))
            factor = 0.75 if end["preset"] == "zoom_in" else 1.35
            next_state.fov = max(5.0, min(120.0, float(next_state.fov) * factor))
        elif end["preset"] == "handheld":
            span_track = OmniCamTrack.from_dict({
                **_base_track_dict(fps, span + 1, width, height),
                "keyframes": [
                    {"frame": 0, "camera": asdict(state), "interpolation": "linear"},
                    {"frame": span, "camera": asdict(state), "interpolation": "linear"},
                ],
            })
            moved = add_camera_shake(span_track, amplitude=0.03, frequency=3)
            next_state = moved.sample(span)
        easing = "linear" if end["easing"] == "linear" else "ease"
        result_keys.append(CameraKeyframe(end["frame"], CameraState.from_dict(asdict(next_state)), easing))
        state = next_state

    from ..vendor.omnicam.core.track import OmniCamTrack as _Track
    final = _Track.from_dict({
        **_base_track_dict(fps, total, width, height),
        "keyframes": [
            {"frame": key.frame, "camera": asdict(key.camera), "interpolation": key.interpolation}
            for key in result_keys
        ],
    })
    return final


def compile_camera_prompt(camera: dict[str, Any] | None, *, fps: float, frames: int,
                          width: int = 1280, height: int = 720) -> str:
    """编译成 H3 运镜描述块（英文、可带时间码）。"""
    try:
        from ..vendor.omnicam.guides.analysis import build_camera_motion_block

        track = build_omnicam_track(camera, fps=fps, frames=frames, width=width, height=height)
        return build_camera_motion_block(track)
    except Exception:
        return ""


def compile_camera_motion_scene(camera: dict[str, Any] | None, *, fps: float, frames: int,
                                width: int = 1280, height: int = 720) -> dict[str, Any]:
    """返回 OmniCam motion_scene 字典，供落盘或层B/C 复用。"""
    try:
        track = build_omnicam_track(camera, fps=fps, frames=frames, width=width, height=height)
        return track.to_dict()
    except Exception:
        return {}


def build_editor_state(camera: dict[str, Any] | None, *, fps: float, frames: int,
                       width: int = 1280, height: int = 720) -> dict[str, Any]:
    """EasyMedia 相机数据 → OmniCam 编辑器 state_json（供 Director 节点直接使用）。"""
    from dataclasses import asdict

    try:
        track = build_omnicam_track(camera, fps=fps, frames=frames, width=width, height=height)
    except Exception:
        return {}
    keyframes = [
        {"frame": key.frame, "camera": asdict(key.camera), "interpolation": key.interpolation}
        for key in track.keyframes
    ]
    objects = [obj.to_dict() if hasattr(obj, "to_dict") else obj for obj in (track.objects or [])]
    return {
        "schema_version": 1,
        "fps": float(fps),
        "duration_frames": int(frames),
        "cameras": [{
            "id": "camera_1",
            "name": "Camera 1",
            "enabled": True,
            "camera": keyframes[0]["camera"],
            "keyframes": keyframes,
        }],
        "objects": objects,
        "active_camera_id": "camera_1",
        "playblast_camera_id": "camera_1",
    }


def compile_from_editor_state(state: dict[str, Any], *, fps: float | None = None) -> dict[str, Any]:
    """OmniCam 编辑器 state_json → 运镜描述 + motion_scene。"""
    if not isinstance(state, dict) or not state.get("cameras"):
        return {"prompt": "", "motion_scene": {}}
    try:
        from ..vendor.omnicam.core.compiler import compile_editor_scene
        from ..vendor.omnicam.guides.analysis import build_camera_motion_block

        scene = compile_editor_scene(state)
        track = None
        for camera in scene.cameras:
            if camera.id == scene.playblast_camera_id:
                track = camera.track
                break
        prompt = build_camera_motion_block(track) if track is not None else ""
        return {"prompt": prompt, "motion_scene": scene.to_dict()}
    except Exception:
        return {"prompt": "", "motion_scene": {}}
