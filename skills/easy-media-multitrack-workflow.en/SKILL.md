---
name: easy-media-multitrack-workflow-en
description: "Create, edit, and optionally run ComfyUI Easy Media MultiTrack workflows from a blank bundled template or a user-provided workflow, including media upload, timeline arrangement, subject or partial video replacement continuity, audio roles, resolution, and MultiTrack Project settings."
---

# Easy Media MultiTrack Workflow

Generate a new, reviewable workflow JSON from the user's request. When the user explicitly asks to generate an actual video, you may also upload the media and submit the workflow to ComfyUI for execution.

## Choose the Baseline

There are only two paths:

1. **Blank-template generation**: use `assets/templates/v1.3.0-blank-workflow.json` when the user explicitly asks to create a new workflow or to start from the blank template, or when no editable workflow is provided. For template node replacement, read [references/template-workflow.md](references/template-workflow.md).
2. **Existing-workflow generation**: when the user provides a workflow or template, use that file as the only baseline and apply only a patch. Preserve uninvolved nodes, links, node IDs, groups, layout and configuration. Never overwrite it with the built-in template, even if its node graph differs from the built-in template.

If the user both provides a workflow and explicitly asks to "rebuild from the blank template", follow the blank-template path. Otherwise, prefer the existing-workflow path.

## Editing Procedure

1. Keep the source file. Run `scripts/patch_workflow.py inspect WORKFLOW.json` to confirm the connected `easy multiTrackEditor` / `easy multitrackProject`, resolution, format, FPS, tracks and project parameters.
2. When the timeline, resolution or audio roles are involved, read [references/multitrack-schema.md](references/multitrack-schema.md) and generate a complete new `track_data`. The blank template must have its empty TRACK_DATA replaced with the target content. For existing objects, keep their IDs and unknown fields; generate UUIDs only for new objects.
3. Only when the user explicitly asks to upload or execute: read [references/upload-api.md](references/upload-api.md) and hand local or URL media to ComfyUI. Use the user's address. If none is provided, first read `COMFYUI_URL` from the Easy Media node pack's `config.yaml`, and fall back to `http://127.0.0.1:8188` only if the file or field is missing (including an empty value). Write into TRACK_DATA only the media paths the API returns.
4. When the user explicitly asks for a supported loader or attention replacement, handle it in place as described in [references/template-workflow.md](references/template-workflow.md). Otherwise, do not change the node graph.
5. Following [references/multitrack-schema.md](references/multitrack-schema.md#patch-plan), produce a plan containing only the actual changes. Dry-run it first, then write a new file and inspect it again:

   ```bash
   python3 scripts/patch_workflow.py apply SOURCE.json --plan PLAN.json
   python3 scripts/patch_workflow.py apply SOURCE.json --plan PLAN.json --output RESULT.json --write
   python3 scripts/patch_workflow.py inspect RESULT.json
   ```

6. Verify the node count, the link count, and that non-target nodes are unchanged. If the script reports an ambiguous target, an incompatible schema, or invalid media, stop. Do not bypass validation.

## Key Decisions

- **Resolution**: when the user expresses no intent, keep the current value. Expressions such as `16:9 0.9mp` select megapixels mode and map to a full `aspect_ratio`. For exact dimensions, auto, shortest/longest side, and custom rules, see the schema reference.
- **Context drift control**: when the user provides a video as a subject or partial-replacement reference, set `content.continuity_mode` to `context_drift` on every target task segment, and set `audio_locked: true` on that video track to keep the picture timeline. If no audio lock is set otherwise, the video's original audio is used; if a separate audio track is locked, its audio takes priority. When the user does not specify a segment length, split the task range into consecutive 10-second segments, with the last segment using the remaining duration. See the schema reference for the full rules.
- **Context-segment prompts**: when writing or editing `user_prompt` for tasks with `task_mode: "ref"` and `continuity_mode: "context"`, follow the "Context-Segment Prompts" section of the schema reference. Keep the incoming state before changing it, and do not treat an ending the previous prompt imagined as fact. When a new composition must be explicit, use `shot` with keyframes instead.
- **Main audio / original video audio**: when the original audio must be kept as-is and drive the task duration or pacing, set `audio_locked: true` on the target audio or video track. Lock at most one track of each type. A video track and an audio track may each have one; when both are present, the audio track supplies the audio lock, and the video track still constrains the picture timeline.
- **Shared media**: when context segments need the same image, the same audio, or the same video as a reference, set `shared_reference: true` on that media. For task images, the field goes on the `content.images[]` item; for audio or video, it goes on the media segment's `content`. Shared images are placed before each task's private images, and each task still has at most 9 images in total. An audio or video track may contain at most one shared segment. Shared audio uses at most the first 15 seconds of the source file. Shared media is a cross-task reference and is not the same as a track-level `audio_locked`. `speaker_reference` is kept only for compatibility with older workflows; new workflows no longer write it.
- **Project scope**: before queueing, verify `segment_start_number`, `segment_count`, `project_save` and the sampling settings, especially the range covered by `override`.

## Optional: Submit a Generation

"Create or generate a workflow" authorizes only JSON generation. Explicit intent such as "run", "execute", "start generating", "submit to the queue", or "output the video directly" authorizes uploading media and executing.

When the user asks to open or execute in ComfyUI, read [references/execution-api.md](references/execution-api.md) and use `scripts/submit_workflow.py` to submit a **UI workflow JSON**. By default, open the workflow in a new workflow tab, then enqueue it through the frontend's native Run entry point. Pass `--no-queue` only when the user asks to open without running, and `--mode replace` only when the user explicitly asks to overwrite the current tab. Do not switch to an API-format prompt or POST directly to `/prompt`. If no target is specified and exactly one page is online, select it automatically. If several pages are online, list them and ask the user to choose; do not guess. Use the user's address. If none is provided, first read `COMFYUI_URL` from the Easy Media node pack's `config.yaml`, and fall back to `http://127.0.0.1:8188` only if the file or field is missing (including an empty value). All media must be uploaded to the same instance. After execution, record the `request_id` and `prompt_id`, and wait until success, failure, or the stop condition the user requested. Do not present "queued" as "generated".

## Delivery

Report the baseline path, the output file, target node IDs, resolution, a timeline summary, media paths, the context drift control continuity mode, locked media tracks and shared media, project parameters, and whether the graph structure was preserved. If you executed the workflow, also report the ComfyUI address, the `prompt_id`, the final status, and an output summary.
