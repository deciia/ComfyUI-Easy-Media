# MultiTrack Data and Orchestration Rules

This reference covers creating or adjusting the TRACK_DATA of `easy multiTrackEditor`. The project's frontend type definitions are in `frontend/src/types/multitrack.ts`, and the actual execution logic is in `nodes/basic.py`.

## Dynamic Resolution

`resolution` is a DynamicCombo widget on `easy multiTrackEditor`. It is not part of TRACK_DATA. When you change it, rebuild the child widgets for the selected mode and synchronize the workflow's existing `widgets_values_named`. Write it with `editor.resolution` in `patch_workflow.py`; do not assume array indexes.

| Need | `resolution` label | Required child fields |
| --- | --- | --- |
| Fixed preset output size | e.g. `1344 x 768 (16:9)` | Optional `resize_method`, default `stretch` |
| Explicit custom width and height | `width x height (custom)` | `width`, `height`, optional `resize_method` |
| Follow the first video's aspect ratio | `width x height (auto)` | Optional `resize_method` |
| Fixed shortest or longest side | `width x height (shortest)` / `width x height (longest)` | `resize_to_pixel`, optional `resize_method` |
| Aspect ratio with a total pixel budget | `width x height (megapixels)` | `aspect_ratio`, `megapixels` |

Selection order: if the user gives exact width and height, use an existing fixed preset; if none matches, use custom. If the user gives only an orientation or aspect ratio plus a quality or pixel budget, use megapixels. If the user asks to keep the source video's aspect ratio, use auto. If the user asks for a shortest or longest side of N, use shortest or longest. If the user expresses no resolution intent, keep the current setting. The model format's default size is only a reference and must not override an explicit user request.

### MP and Aspect Ratio in Natural Language

Treat `mp`, `Mpx`, and `megapixel(s)` as the megapixels unit, case-insensitively. Expressions such as `0.9mp`, `1 MP`, or `0.8 megapixels` select megapixels mode directly, and the number is taken as written. An aspect ratio in the same sentence maps to the full DynamicCombo `aspect_ratio` value:

| User ratio | `aspect_ratio` |
| --- | --- |
| `1:1` | `1:1 (Square)` |
| `2:3` | `2:3 (Portrait Photo)` |
| `3:2` | `3:2 (Photo)` |
| `3:4` | `3:4 (Portrait Standard)` |
| `4:3` | `4:3 (Standard)` |
| `9:16` | `9:16 (Portrait Widescreen)` |
| `16:9` | `16:9 (Widescreen)` |
| `21:9` | `21:9 (Ultrawide)` |

For example, "generate a 16:9 video at 0.9mp size" needs no follow-up question. Normalize it directly to:

```json
{
  "resolution": "width x height (megapixels)",
  "aspect_ratio": "16:9 (Widescreen)",
  "megapixels": 0.9
}
```

Do not convert the MP value into width and height, and do not round it. If only MP is given: if the current setting is already megapixels mode, keep its `aspect_ratio`; otherwise choose `16:9` or `9:16` from clear landscape or portrait wording; if it still cannot be determined, ask. Also ask when exact width/height, aspect ratio and MP contradict each other.

Custom example:

```json
{
  "resolution": "width x height (custom)",
  "width": 1024,
  "height": 576,
  "resize_method": "crop"
}
```

Available `resize_method` values: `stretch`, `resize`, `pad`, `pad (white)`, `pad_edge`, `pad_edge_pixel`, `crop`, `pillarbox_blur`. Prefer pad or resize when the full frame must be kept; use crop when the canvas must be filled and trimming edges is acceptable. Do not change an existing resize method unless the user asks.

## Time Semantics

- `start_frame` is inclusive and `end_frame` is exclusive. A segment's frame count is `end_frame - start_frame`.
- Convert seconds to frames with `round(seconds * frame_rate)`. Every segment has at least 1 frame.
- Segments on the same track are sorted by `start_frame` and must not overlap. Gaps are allowed. Tracks of the same type can be arranged independently.
- When segments exist, `total_length` should be the largest `end_frame` across all tracks. When there are no segments, the editor's current default length can be kept.
- When changing the FPS, remap all segment boundaries, `origin_start_frame` values and task markers proportionally in time. Do not change only `frame_rate`.

## Top-Level Object

```json
{
  "muted": false,
  "volume_db": 0,
  "task_markers": [],
  "task_overview": false,
  "tracks": [],
  "total_length": 240,
  "frame_rate": 24
}
```

Track `type` is `task`, `video`, `audio` or `subtitle`. Keep existing unknown fields for compatibility with newer versions.

## Common Tracks and Segments

```json
{
  "id": "uuid",
  "name": "Video 0",
  "type": "video",
  "color": "var(--primary)",
  "muted": false,
  "solo": false,
  "volume_db": 0,
  "locked": false,
  "segments": [
    {
      "id": "uuid",
      "start_frame": 0,
      "end_frame": 120,
      "color": "var(--primary)",
      "content": {}
    }
  ]
}
```

When creating a track, prefer the project's existing color tokens: `var(--multitrack-task-bg)` for task tracks and `var(--primary)` for video tracks. Keep the existing color of any track you are editing.

## Task Segments

```json
{
  "media_type": "none",
  "task_mode": "ref",
  "continuity_mode": "shot",
  "ref_image_size": "match",
  "images": [],
  "user_prompt": "user prompt",
  "system_prompt": "",
  "user_prompt_variant": "a",
  "user_prompt_b": "",
  "muted": false,
  "volume_db": 0
}
```

- `task_mode`: `default`, `l2v`, `ref`, `edit`.
- `continuity_mode`: `shot` (independent shot), `context` (ordinary context continuation), or `context_drift` (context drift control); the legacy `context_swap` is still read.
- `ref_image_size`: `match` or `max`.
- `images` holds at most 9 items; their order sets the Picture reference order.
- When editing an existing task, keep the `system_prompt`, prompt variant, continuity mode and reference-image strategy unless the user asks to change them.
- If the current variant is `b`, edit `user_prompt_b`; otherwise edit `user_prompt`. Do not switch variants by accident.

Task reference image:

```json
{
  "id": "uuid",
  "source_type": "input",
  "file_path": "codex/session-123/reference.png",
  "file_name": "reference.png"
}
```

`source_type` can be `input`, `output`, `local`, `url` or `slot`. Fields must match the source: `input` and `output` use `file_path`, `local` uses `local_path`, `url` uses `url`, and `slot` uses `slot_name`. Do not label a local absolute path as `input`.

When a context segment needs to reuse the same reference image repeatedly, set `"shared_reference": true` on the image item. That image becomes a shared image and is automatically placed before each task segment's private images. Shared and private images together must still not exceed 9. Do not copy the same image by hand into every task.

## Context Drift Control Mode

`context_drift` is the context drift control continuity mode. It carries over the scene and motion context of the previous segment, while letting the model replace the subject, person, object or local region based on a reference video. When the user provides a video as a reference for subject replacement, person replacement, object replacement, or local replacement such as clothing or face, arrange the timeline as follows:

- Set `content.continuity_mode` to `context_drift` on every task segment in the range. Do not change only the second or later segments. Even the first segment, which has no preceding generated context, keeps the same mode, so project metadata and later regeneration stay consistent.
- Put the reference video on a video track, covering the time range of all target task segments. If it must also serve as a cross-task model reference, set `shared_reference: true` on the video segment's `content`.
- Set track-level `audio_locked: true` on that video track, so the source video's timing drives generation. Explicitly set `audio_locked` to `false` on any other video track. To replace the original audio, you may lock a separate audio track; it then takes priority as the audio source. When relying only on the video's own audio, confirm before locking that the video contains a usable audio track and covers all target task segments.
- If the user specifies segment length or boundaries, follow the user. Otherwise, split the task segments into consecutive 10-second chunks. Each chunk has `round(10 * frame_rate)` frames, and the last chunk uses the reference video's remaining frames. Do not pad, do not discard the remainder, and do not create an empty final segment. The reference video itself can remain one video segment covering the full range; it does not need to be copied for each task segment.
- If the user asks to remove, replace or not keep the reference video's original audio, do not lock that video track automatically. Handle the audio according to the audio plan the user specifies.

## Context-Segment Prompts

These rules apply to tasks with `task_mode: "ref"` and `continuity_mode: "context"`. They do not apply to `context_drift` (including the legacy `context_swap`). The segment starts from the **actually delivered** tail of the previous segment (22 frames, about 0.92 seconds at 24 fps). Its composition and camera motion may differ from the ending the previous prompt envisioned, and these frames are locked. Text that contradicts them is usually rendered as an overlay rather than a replacement. When writing or editing `user_prompt`:

- **Hold first, then change**: the opening should only say that the camera keeps the direction and framing it arrived with, and the subject keeps the pose, action and lighting it arrived with. Do not describe the ending the previous segment intended as fact, and do not introduce a new composition, character layout or scene at the start.
- **Keep the hold moving**: give the character a breath, a weight shift or a change of gaze, so the hold does not render as a freeze.
- **Put changes later**: until about `00:02.000`, do not cut, do not speak lines, and do not introduce new key actions. Write any required composition or scene change as an explicit cut.
- **Start mid-action**: anything already in motion at the seam should start from within the movement. Do not write it as if the first frame has already finished.
- **Be self-contained**: the model cannot see the previous segment's prompt. Fully define each `<Subject N>`, state the scene and lighting, and do not use "the same" or "as before" for identity or scene.
- **Pictures define identity only**: do not use `<Picture N>` as the first-frame or composition anchor for `[Shot 1]`. Continuation does not use `<Video N>` or `[video continuation]`.
- **When a `context` segment follows, end on motion**: do not write "ends", "arrives", "settles", "centered" or "slows down". Do not cut or start new dialogue in the final second.
- **For an explicit new composition**: use a `shot` segment with keyframes instead of `context`.
- **Timestamps**: timestamps in the prompt refer to the generated segment, which starts about 0.92 seconds before the saved segment. The node does not shift them automatically.

When `system_prompt` is empty, the task output node automatically appends the same rules to the default MiniMax reference system prompt: the incoming rule applies when the segment is not the first and uses `context`; the outgoing rule applies when the next segment uses `context`. The rules reach the LLM doing the rewriting only through the `api` and `llm` prompt formats; `default` and `promptRelay` do not output a system prompt. If a custom `system_prompt` is filled in, nothing is appended, so you must write the rules yourself.

## Video and Audio Segments

```json
{
  "media_type": "video",
  "source_type": "input",
  "file_path": "codex/session-123/clip.mp4",
  "file_name": "clip.mp4",
  "duration": 5.0,
  "muted": false,
  "volume_db": 0,
  "speed": 1
}
```

Change `media_type` to `audio` for audio segments. You can get a source file's original duration with `ffprobe`; the timeline duration depends on the user's target, trimming and speed. If the user wants media aligned with a task segment, reuse the same `[start_frame, end_frame)` rather than relying on similar seconds.

## Audio Lock Decisions

`audio_locked` is a track-level field on audio and video tracks. Locking an audio track carries over its audio. Locking a video track makes the generated picture follow the video track's timeline and, when no audio track is locked, carries over the video's original audio. The two locks can coexist; in that case the audio track is the audio source for `audio_lock`, and the video track still controls the picture timeline. This is different from a track's `locked`: `locked` only prevents timeline edits and cannot replace `audio_locked`.

```json
{
  "id": "music-track",
  "name": "Master Song",
  "type": "audio",
  "audio_locked": true,
  "muted": false,
  "segments": [
    {
      "id": "song-segment",
      "start_frame": 0,
      "end_frame": 240,
      "content": {
        "media_type": "audio",
        "source_type": "input",
        "file_path": "codex/mv/song.wav",
        "file_name": "song.wav"
      }
    }
  ]
}
```

A single TrackData can have at most one audio track with `audio_locked: true` and one video track with `audio_locked: true`. When switching the lock source for a type, explicitly set the other tracks of that type to `false`. Do not clear the lock of the other type. Do not write `audio_locked` into a media segment's `content`; the legacy segment-level field is kept only to migrate old workflows.

Determine the lock from context in this order:

1. The user provides a video for subject or partial replacement and does not ask to remove or replace its original audio: lock that video track.
2. The user explicitly says "lock", "main track", "keep the original audio", or "do not regenerate audio": use the audio or video track they specify.
3. Generating the picture for an MV, music video, lyric video, beat-synced video, dance video, or a full song's duration: lock the main song or soundtrack track.
4. A narration, podcast or dialogue is the only basis for video duration and shot pacing: the main narration track may be locked.
5. Ordinary background music, ambient sound, sound effects, character reference audio, or temporary placeholder audio is not automatically the main locked track, unless the user's meaning shows it drives generation.
6. If a locked media track already exists and the user has not asked to replace it, keep it. Still check whether it intersects the task segments to be generated.

When there are several audio tracks, first disambiguate using names, file names, source durations, track content and the user's description. For example, `Master Song` or a track named `Full Song` usually takes priority over `SFX` or `Ambient Sound`. If two or more reasonable candidates remain, stop generating the patch and ask the user. List at least each candidate's track ID, name, file name and time range. Do not decide by track order, by the first audio track, or by the longest duration.

Before locking, also check:

- The locked track contains at least one media segment matching the track type: an audio track needs `media_type: "audio"`, and a video track needs `media_type: "video"`. When locking the video's original audio, also confirm that the source video actually has an audio track.
- The locked media segment should intersect each target task segment's `[start_frame, end_frame)`. If it does not, adjust the timeline or ask the user.
- When used as the main audio, keep `muted: false` as a rule. Do not change unrelated solo, volume or track edit-lock states to make a lock work.
- If the context clearly requires that no original audio be kept, make sure `audio_locked` is `false` on all audio and video tracks.

## Shared Media

`shared_reference` is a boolean field on task image items and on the `content` of audio and video segments. When several context task segments need the same image, audio or video as a reference, mark that media as shared. It does not need to overlap each task segment on the timeline.

```json
{
  "id": "shared-audio-segment",
  "start_frame": 0,
  "end_frame": 120,
  "content": {
    "media_type": "audio",
    "source_type": "input",
    "file_path": "codex/voice/reference.wav",
    "file_name": "reference.wav",
    "shared_reference": true
  }
}
```

Decision rules:

- When the user says "set as shared media", "every context segment should reference this image/audio/video", or expresses the same meaning, mark the specified media. Do not share media just because the file names match.
- The task-image marker goes on the `content.images[]` item. Several shared images are allowed. They are placed before each task's private images, and shared plus private images total at most 9.
- The audio and video marker goes on the `content` of the matching media segment. Each audio or video track can have at most one. When switching, explicitly set the other segments on that track to `false`.
- Shared audio is taken from the beginning of the source file, at most 15 seconds. Shared video uses that source video as the reference video for each task.
- Shared media is a cross-task reference, not timeline audio reuse. Do not set `audio_locked` just because audio is shared. Evaluate `audio_locked` separately, and only if the user also wants that audio kept and used to drive the timeline.
- If the user wants a piece of audio or video both as shared reference and as normal timeline output, express the two roles with separate tracks or segments, and explain this in the delivery summary.
- `speaker_reference` is the legacy audio reference field. It is used only to read and migrate old workflows. New or updated workflows always write `shared_reference`.
- If several candidates cannot be disambiguated, list the media or segment IDs, track names, file names, durations or frame ranges, and ask the user to choose. Do not pick the first item or the longest segment.

## Automatic Arrangement Decisions

- When the user gives an explicit shot or segment length, use it. Otherwise, derive it from the source duration or the timing in the prompt, and state how it was derived.
- In subject or partial-video replacement mode, when the user does not specify a segment length, split task segments into fixed consecutive 10-second chunks. The last chunk uses the remaining duration.
- "N seconds per segment" means consecutive segments `[0, N*fps)`, `[N*fps, 2N*fps)`, and so on. Do not add an extra frame at the boundaries.
- Put each prompt in its task segment, each reference image in that task segment's `images`, and the main video and audio in their own media tracks.
- For subject-replacement videos, MVs, or other projects driven by main audio, lock the single audio or video track after the timeline is arranged, and verify that it covers the target task range.
- By default, keep the gaps between tracks. Remove gaps and shift later segments forward only when the user asks for a compact arrangement.
- When adjusting existing segments, keep their segment IDs where possible. Generate new UUIDs only for new segments, tracks and image items.

## MultiTrack Project Parameters

- `segment_start_number` is the 1-based task segment number. The execution logic converts it to an internal index with `segment_start_number - 1`.
- `segment_count = -1` means process from the starting index to the end. A non-negative value limits how many task segments are processed in this run.
- `project_save`: `new` or `override`. With `override` and count `-1`, the execution logic deletes the saved segments after the starting index before regenerating. Explain this clearly to the user before changing it.
- `sampling_mode`: `single` or `dual`. `sampling_plan` must be a preset available on the current node. Do not assume the current environment supports a value just because another workflow uses it.
- The editor resolution is the first-pass size. `dual` does not back-calculate a reduced first pass. The second-pass width and height are `round(editor size * upscale_by / 32) * 32`, using Python's `round` (nearest, with ties going to the even value), not fixed round-up alignment.
- `upscale_by` is a separate Project parameter. The default is `1.250`, with three decimal places and a step of `0.001`. Older workflows keep their saved value. Both upscale paths and the merged export use the upscaled and aligned size. For example, with an editor size of `1344 × 768` and a scale of `1.250`, the second pass is `1664 × 960`. If the user specifies a final output size, check both the editor size and the scale. Do not treat the editor size as the final size of dual sampling.
- Single sampling and first-pass-only preview keep the editor size. `upscale_by = 1.000` does not upscale but can still be dual-sampled. Audio-only projects (`32 × 32`) are not upscaled. First-pass checkpoints and context latents that were computed by back-calculating a reduced size must be regenerated before resuming under the new rules.
- `1st_pass_only` applies only to an explicit single-pass checkpoint workflow. Do not enable it automatically.

## Patch Plan

A plan contains only actual changes. `node_id` can be omitted and located through the topology. `editor.resolution` is the complete DynamicCombo setting; `editor.track_data` is the complete TRACK_DATA. Do not put a whole node or workflow into a plan.

```json
{
  "editor": {
    "resolution": {
      "resolution": "width x height (megapixels)",
      "aspect_ratio": "16:9 (Widescreen)",
      "megapixels": 0.9
    },
    "track_data": { "tracks": [], "total_length": 120, "frame_rate": 24 },
    "format": "MiniMax"
  },
  "project": {
    "project_save": "override",
    "segment_start_number": 1,
    "segment_count": -1,
    "sampling_plan": "medium",
    "sampling_mode": "single"
  }
}
```
