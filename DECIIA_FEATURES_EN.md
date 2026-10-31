# Deciia fork: what we added

This repository is a fork of [yolain/ComfyUI-Easy-Media](https://github.com/yolain/ComfyUI-Easy-Media). All upstream features are kept and upstream releases are merged; the layers below are ours.

- **Director workflow** — a creation bench on top of the multitrack editor: storyboard planning, subject/resource library, prompt workbench, and an AI assistant with real tool calls plus skill packs.
- **Projects that persist** — project kinds (video / image / audio), `timeline.json` per project, autosave + `Ctrl+S`, and the timeline travelling with the workflow.
- **Rewritten output node** — `easy saveVideo` became **Save Media**: video / image sequence / audio, multi-type inputs, thumbnail grid, save-as, file details, colour deck with live preview and real baking.
- **H3 production chain** — segment-level passthrough, persistent context chain with `context_cut`, multi-rate sampling (video committed once), `audio_first` / `image_first` modes, and a T8-fork node group.

## 1. Multitrack editor (`easy multiTrackEditor`)

- **Project bar** with kinds fixed at creation: **video** (9:16 @ 1.0 MP), **image** (9:16 @ 2.0 MP, forces `image_first`), **audio** (64×64, forces `audio_first`); the backend re-checks and forces the mode for legacy workflows. New **`PROJECT_NAME`** output replaces retyping the name in three nodes.
- **Reference scope** per video/audio segment: *not a reference* / *aligned* (segments it overlaps in time) / *global*.
- **Task modes** with enforced budgets: `default` T2V (≤1 image, first frame), `ref` R2V (1–9 images + optional video/audio), `edit` VI2V, `l2v` L2V (exactly 1 image), `passthrough` Pass; a clip can carry up to 3 reference audios. **Continuity**: `shot` / `context` / `context_drift` (greyed on passthrough).
- **`@` references** insert canonical `<Picture n>` / `<Audio n>` / `<Video n>` tokens, numbered from the segment's real resource order; **A/B prompt drafts** are both editable and either can be submitted.
- **Persistence**: autosave 2.5 s after edits, `Ctrl+S` for immediate save, `<output>/easy_media/projects/<name>/timeline.json`, 409 on concurrent edits, delete removes only the timeline. `track_data` stays a widget, so one workflow = one timeline.

**Known limits**: 8 MB per timeline file, Windows-sanitised project names, renaming does not move generated artefacts.

## 2. Prompt workbench (导演工作台)

Opened from the ✨ button beside a task segment's user prompt. Tabs: **分镜编排 / 主体与资源 / 提示词增强**, plus a permanent **AI rail**.

- **Storyboard**: generate a full storyboard (beats, durations, shot tables, dialogue, micro-expression, sound, transitions), revise it, add/delete segments, then **apply to the task track** (structure only by default).
- **Subjects & resources**: `Subject` / `Picture` / `Audio` / `Video` with description, relationship, retention and child resources.
- **Enhance**: A/B drafts, a read-only mirror of the task segment, and the **binding list / token contract** — numbering follows binding order (subjects first, children immediately after) and matches the image order submitted to ComfyUI. `<Subject n>` is mandatory for identity; defining a person with `<Picture n>` alone is rejected with a fix suggestion. A **quality bar** switches between six-section (R2V) and three-section (T2V) formats, lists missing sections and inserts skeletons. Results are validated (sections, token and `[Shot n]` bounds, paired `<d>`, no subtitle/watermark wording) and **never replace your text when validation fails**. `写入任务轨（A/B）` writes one segment, `保存到任务轨` writes all with a completeness report.
- **AI assistant**: 59 tools over storyboard, subjects/resources, prompts, task track, assets and project memory (`plan_storyboard`, `apply_storyboard`, `bind_resources`, `retoken_prompts`, `plan_assets`, `audit_assets`, `write_prompt`, `generate_resource`, `inspect_images`, `run_generation`, `undo_last_delete`, …). Intent-to-tool routing forbids shortcuts (a pure resource-needs request never writes prompts). `inspect_images` sends up to 6 images to a vision endpoint for a shot-review checklist.
- **Skill packs**: plain Markdown in `<ComfyUI>/user/DeciiaEasyMedia/skills/*.md`, listed in the system prompt and loaded on demand (`list_skills` / `read_skill`); audio projects read the audiobook pack first, image projects the comic pack.

**Known limits**: settings live in `localStorage` per project; the workbench only writes prompts, task modes and reference images back — never track structure or media; AI needs a configured endpoint.

## 3. Subject library (`easy subjectLibrary`)

Named subjects (name / type / description / relationship / retention / bound resource) output `SUBJECT_CONFIG` with a `global_prompt`, validation `problems` and `count`. **Subjects never store numbers** — indices are derived from resource order, so inserting media never invalidates prompts. Without the node the editor is byte-identical to upstream; the workbench merges every library node on the canvas.

**Known limits**: definition and validation only; binding still happens on the subjects tab.

## 4. Save Media (`easy saveVideo`, 保存媒体（视频/音频/图片）)

- Inputs: `input_mode` (`images+audio` / `video`), `images`, `fps`, `video`, `audio`, and a **multi-type `media` slot** that auto-detects what to save. Outputs: image/video/audio passthrough + **file path**.
- `save_kind` = **video / images / audio** (three panel icons) with `image_format` (PNG/JPG/WEBP) and `audio_format` (WAV/MP3/FLAC); `video_format` covers AUTO, MP4 H264/H265, MOV H264/ProRes, MKV, WEBM AV1, GIF, WEBP. Plus `output_mode` (save / preview_only / hide / hide&save), `custom_save_path`, `adopt_source_video` (stream copy), `cleanup_after_save`, `notify_sound`.
- Image sequences are written frame by frame and shown as a clickable thumbnail grid; one still plus audio is padded to the audio length; a still without audio is refused; audio-only input can only save audio; mismatches between wiring and save form raise an explicit error.
- **Panel**: collapsible 视频详情 (name, size, frames, duration, fps, bytes, codec, has-audio, copy-all), path row with 打开目录, native video controls — **the in-player ⋮ menu was removed**; the colour deck (saturation / bloom / mist / halation, with 应用并导出 → `/banzhang_api/bake_video`) and the details have their own buttons. The last finished file is stored in node `properties`, so it survives tab switches and reloads; save-as appears only for image sequences after selecting one image.

**Known limits**: the colour preview is a CSS approximation — only the bake is pixel-accurate and it requires the Banzhang plugin; MP3/FLAC and non-native containers need system FFmpeg.

## 5. Segment-level passthrough

Mode **直通 / Pass** (`format=MiniMax`): the segment is not sampled — video-track material over its window is cut, encoded and written straight into the film. `easy deciiaPassthroughStage` handles staging plus the **tail 22-frame context decode**; continuity then means what the next segment inherits (`shot` writes `context_cut` + placeholder latent, `context` keeps the frames, drift disabled).

**Known limits**: prompts and references in that segment are inert; needs the MiniMax format and the project chain; coexists with upstream's project-level `sampling_mode=passthrough`.

## 6. Project generation & combine

`easy multitrackProject` modes: `single`, `dual`, `dual_t8`, `selflift`, `passthrough`, `audio_first` (placeholder picture, audio-only decode, 视频提交次数 / 仅音频分辨率), `image_first` (video-only decode, 22 frames, 图片候选帧). `easy minimaxH3MultiRateSampler` decouples video commit count from the audio ladder — audio can update 8 times while video is committed once. `easy multitrackProjectVideoCombine` outputs FILENAME_PREFIX / VIDEO / MEDIA (dedicated `EASY_MEDIA` type), previews un-merged segments, supports auto/manual combine and warns about resolution mismatches via `/easy-media/project/canvas_inspect`.

**Known limits**: only generated segments are merged; changed resolution does not re-render old segments; `auto_combine` off blocks the outputs.

## 7. Context chain

`easy h3ProjectArtifact` saves the context, `easy h3ProjectContextLatentLoad` restores it; `context_latent` is optional and a missing one writes a placeholder plus `context_cut` in the manifest, so a cut survives across runs. After the second pass only the **tail 22 frames of high-res context stay on CPU**; low-res first-pass checkpoints remain for later refinement.

**Known limits**: context is keyed by project directory and segment order; a placeholder carries no picture information.

## 8. H3 T8 fork (`easy deciiaH3*`)

Ported from [t8star/comfyui-minimax-h3-audio-T8](https://github.com/t8star/comfyui-minimax-h3-audio-T8) (GPL-3.0-or-later, see `THIRD_PARTY_NOTICES.md`), ids prefixed and grouped under `EasyUse/H3/T8fork`: dual-clock sampler (`dual_clock_euler`, `native_flow` / `beta57`), AV decode, learned latent upscale (32-divisible output, release policies), two-pass reconcile, parity plan, two-pass detail mixer (tail subdivision / model-time bias / STG / RF restart), semantic bridge config & apply, HyperVAE 2× loader.

**Known limits**: weights are not bundled; nodes are experimental and only report memory risk above the 1920×1088 reference area.

## 9. Other

`utils/h3_prompt_validate.py` (six sections, token and shot bounds, no subtitle/watermark wording); `utils/resource_gen.py` (map `image` / `voice` / `music` / `refvideo` to API workflows in `user/DeciiaEasyMedia/resource_workflows.json` with `{{prompt}}`, `{{text}}`, `{{duration}}`, `{{seed}}`, `{{reference_image}}`, `{{reference_audio}}`, `{{negative}}`); `web_panels/` for hot-editable save panel and `audio_first` widget visibility; frontend compatibility for React 19 / ComfyUI 1.53+ (`#185` blank editor, `DYNAMICCOMBO_V3` value shifting); and failure-path memory release on failed multitrack runs (`released N cache references`).

**Known limits**: guard rails only — do not pack an entire project into a single run.
