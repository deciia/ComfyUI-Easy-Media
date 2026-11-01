# Easy Media MultiTrack Workflow Skill

This is the Codex Skill bundled with the ComfyUI Easy Media node pack. It generates MultiTrack workflow JSON either from the built-in blank template or from a workflow the user provides, and it can submit the workflow to ComfyUI for execution when the user explicitly asks.

## What It Does

- Uploads local images, videos and audio into ComfyUI's `input` directory or a specified subdirectory.
- Creates and arranges task, video and audio timeline segments automatically.
- Places user prompts, system prompts and reference images into the matching task segments.
- Based on context such as an MV, lyric video, music-driven edit or narration-driven project, automatically locks the main audio track, and can independently lock the video picture timeline.
- Generates a new workflow from the built-in v1.3.0 template when the user asks to create one.
- When the user provides an existing workflow or template, uses that file as the only baseline and does not overwrite its node graph.
- When the user explicitly asks for an actual generation, uploads the media and submits it to the specified ComfyUI. If no address is provided, it first reads `COMFYUI_URL` from the Easy Media node pack's `config.yaml`, and falls back to `http://127.0.0.1:8188` only if the file or field is missing (including an empty value).
- Opens the workflow in a new ComfyUI tab, or replaces the current tab, through the UI workflow interface, then enqueues it natively. It does not submit API prompts directly. When several pages are online, the target must be specified. For the interface and script usage, see [Submission and Execution](references/execution-api.md).
- When the user explicitly asks, safely replaces `MiniMaxH3HybridLoader` with `UNETLoader`, or replaces a compatible attention backend.
- Adjusts frame rate, segment start and end positions, duration, continuity mode and reference-image strategy.
- When a video is used as a subject or partial-replacement reference, uses context drift control continuity, locks the video's original audio, and splits tasks into 10-second segments if no segment length is given.
- Adjusts the `easy multitrackProject` sampling plan, single or dual-pass mode, starting segment index, and the number of segments processed in this run.
- When several MultiTrack editors exist, identifies the one actually connected to the project node through node links.
- Preserves the nodes, links, node IDs, layout and other settings of the user's current workflow, replacing only the target MultiTrack editor and the MultiTrack project parameters.

The skill performs a dry run by default and writes a new workflow file. It does not overwrite the user's original JSON.

When more than one track could serve as the main audio, the skill uses track names, file names, durations and the user's description to decide. If it still cannot identify a single track, it asks the user to choose. It does not default to the first or the longest audio track.

## Installation

### Option 1: Copy into the Codex Skills directory

From the Easy Media node pack root, run:

```bash
mkdir -p ~/.codex/skills
cp -R skills/easy-media-multitrack-workflow ~/.codex/skills/
```

If an older version is already installed in the target directory, back it up or move it aside before copying the new one. Do not nest the new directory like this:

```text
~/.codex/skills/easy-media-multitrack-workflow/easy-media-multitrack-workflow
```

The correct entry point is:

```text
~/.codex/skills/easy-media-multitrack-workflow/SKILL.md
```

### Option 2: Symbolic link for development

To use the latest skill immediately after the node pack updates, run this from the node pack root:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/easy-media-multitrack-workflow" \
  ~/.codex/skills/easy-media-multitrack-workflow
```

If a file or directory with the same name already exists at the target, `ln` stops with an error and does not overwrite it. After installation, start a new Codex task to refresh the list of available skills.

## Usage

Explicit invocation:

```text
Use $easy-media-multitrack-workflow to upload these images and videos to input/project-a,
arrange them into the current workflow in 5-second segments, and place each prompt in its matching task segment.
This is an MV project. Lock the full song as the main audio track so the picture follows the song's timing.
```

You can also describe the task directly. When a request involves an Easy Media MultiTrack workflow, Codex can select the skill automatically. For example:

```text
Based on my current workflow, edit only the MultiTrack editor: start from the 2nd task segment and run 3 segments,
use the medium sampling plan, and do not replace or delete any existing nodes.
```

Example of creating a new workflow:

```text
Use $easy-media-multitrack-workflow to create a new MV workflow from the built-in v1.3.0 template.
Set the main model to the default UNETLoader, use the MiniMax H3 memory-saving attention patch,
upload the song and lock the main audio track, then generate the task segments and prompts from the context.
```

Please provide the following where possible:

- The workflow JSON you want to edit.
- The media files, or accessible absolute paths.
- The prompt and expected duration for each segment.
- The target frame rate, how segments are arranged, and which reference images belong to which segments.
- The target resolution, orientation or aspect ratio, whether to keep the source media's aspect ratio, and the preferred scaling or cropping method.
- For an MV, lyric-video or narration-driven project, which audio track should be kept as-is and drive the picture.
- For context segments, whether the same image, audio clip or video should be shared media for all tasks.
- Whether you want an actual upload or execution, and the ComfyUI address. If no address is provided, the skill first reads `COMFYUI_URL` from the Easy Media node pack's `config.yaml`, and falls back to `http://127.0.0.1:8188` only if the file or field is missing (including an empty value).
- When creating a new workflow, whether the model loader or attention backend should be replaced, and which model files and nodes are actually available in your environment.

## Safety Behavior

The skill has only two baseline paths. It uses the built-in v1.3.0 template when there is no existing workflow or the user explicitly asks to start from the blank template. When a workflow or template is provided, that file is the only baseline and is never overridden by the built-in template. The blank template's timeline is empty, so complete target track and segment data must be written before delivery.

The patch script checks:

- Whether the target editor is actually connected to `easy multitrackProject`.
- Whether timeline segments are sorted, do not overlap, and have valid frame ranges.
- Whether track and segment IDs are unique.
- Whether media types and the number of task reference images are valid.
- Whether at most one audio track and one video track have `audio_locked: true`. When both exist, the audio track supplies the locked audio and the video track keeps the picture timeline.
- Whether the DynamicCombo resolution label matches its child widgets, and whether the named widget values are synchronized.
- Whether `shared_reference` appears only on task image items or on audio/video segments of the matching type, with at most one per audio or video track. The legacy `speaker_reference` is used only for compatibility migration.
- Whether the node count, links and the content of non-target nodes are unchanged after modification.

Uploading media and submitting to the ComfyUI queue change external state. "Generate a workflow" produces JSON only. Execution happens only when the user explicitly asks to run, execute, start generating, or submit to the queue. If no address is provided, the skill first reads `COMFYUI_URL` from the Easy Media node pack's `config.yaml`, and falls back to `http://127.0.0.1:8188` only if the file or field is missing (including an empty value).

## Directory Layout

```text
easy-media-multitrack-workflow/
├── SKILL.md
├── README.md
├── agents/openai.yaml
├── assets/templates/v1.3.0-blank-workflow.json
├── references/
│   ├── multitrack-schema.md
│   ├── execution-api.md
│   ├── template-workflow.md
│   └── upload-api.md
└── scripts/
    ├── customize_template.py
    └── patch_workflow.py
```

This copy contains only `SKILL.md`, `README.md` and `references/`. The tree above describes the full skill folder, `skills/easy-media-multitrack-workflow/`, which also holds `agents/`, `assets/` and `scripts/`. Run the install commands from the node pack root and the script commands from that full folder. The tree also omits `scripts/submit_workflow.py`, which is documented in `references/execution-api.md`.

`SKILL.md` is the Codex entry point; `README.md` is for installers and users; the template asset is used to create new workflows; `references` holds the data structures and node-replacement rules; and the scripts safely customize the template, locate nodes, validate patches and generate new workflow files.
