# ComfyUI UI Workflow Submission and Execution

Creating or modifying JSON alone does not trigger submission. When the user asks for the workflow to be opened in the interface, only load it. Queue it automatically only when the user explicitly asks to run, execute or generate media.

## Address and Preflight

- Address priority: the address the user explicitly provides (`--url`), then `COMFYUI_URL` in the Easy Media node pack's `config.yaml`, then `http://127.0.0.1:8188`. Fall back only when the file or field does not exist or the value is empty. If only `host:port` is given, prepend `http://`. If the config is invalid or the connection fails, report the error; do not switch instances.
- When the script runs inside the repository or is installed by symbolic link, it locates the node pack's config automatically. For a copied installation, run it from the node pack root or one of its subdirectories, or pass `--config /path/to/ComfyUI-Easy-Media/config.yaml`. From other directories, it checks `config.yaml` in the current directory by default; it does not scan other instances on the machine.
- When a config file exists, PyYAML is required; you can use ComfyUI's Python environment. Read only `COMFYUI_URL`, and do not print the whole config file, which may contain API keys. Uploads, opening or queueing, and status queries share the resolved address. When the user has not specified an address, do not pass a default `--url` that would override the config.
- After installing an Easy Media version that includes this interface, restart ComfyUI and refresh the browser page. At least one ComfyUI page with a loaded workflow must stay online.
- Send `GET /object_info` to check the target nodes. Media must be uploaded to the same instance; see [upload-api.md](upload-api.md).
- The interface inherits ComfyUI's access permissions and provides no separate authentication. Do not expose an unauthenticated ComfyUI to the public internet. For proxy authentication, use existing authorized credentials; the script does not take over browser login.

## Open and Run from the UI

From the skill directory, run:

```bash
python3 scripts/submit_workflow.py RESULT.json
```

The script submits only **UI workflow JSON**, containing `nodes`, `links`, layout and widget values. The frontend first loads it onto the visible canvas, then calls the same native enqueue entry point as the "Run" button, which preserves the submission hooks for custom widgets and seeds. Do not hand-write an API prompt, and do not request `/prompt` directly.

- The default is `--mode new_tab`, which creates a new workflow tab. `--mode replace` replaces the current tab's canvas and does not auto-save or overwrite files on disk.
- `--no-queue` only opens the workflow without running it. By default the script runs it, so an open-only intent must include this flag.
- `--name NAME` sets the tab name prefix. A new tab appends the request ID to avoid a name clash with a workflow that is already open.
- `--clients` lists online pages. With one page, `--client-id` can be omitted. With several pages, a target must be specified; the script must not pick the first one or broadcast.
- `client_id` is the ID this interface generates for each page; `session_id` is the corresponding ComfyUI WebSocket ID. Several workflow tabs in the same page do not count as several clients.
- `--request-id ID` provides a retry identifier; the script prints it to stderr before the POST. The same ID with the same arguments returns the existing request and does not run again. The same ID with different arguments raises an error.
- `--status ID` queries an existing request without resubmitting it. `--timeout` only controls how many seconds to wait for the browser acknowledgement. It is not a generation time limit and does not cancel a submitted job.

After submission starts and before `queued` or `loaded` is returned, do not manually switch workflows or click Run repeatedly on the target page. A conflict stops automatic submission and reports an error.

## HTTP Interface

`GET /easy-media/workflow/clients` returns `{"clients": [{"client_id": "...", "session_id": "...", "title": "...", "last_seen": 0}]}`.

`POST /easy-media/workflow/submit`, requiring `Content-Type: application/json`:

```json
{
  "workflow": { "nodes": [], "links": [], "version": 0.4 },
  "mode": "new_tab",
  "auto_queue": true,
  "name": "My workflow",
  "request_id": "unique-request-id",
  "client_id": "client-id-from-clients-endpoint"
}
```

The empty graph here only shows the format; at runtime it must be replaced with a complete workflow. `workflow` is required and the other fields are optional. `mode` defaults to `new_tab`, and `auto_queue` defaults to `true`. `client_id` can be omitted when only one page is online.

The response returns `request_id`, the target `client_id`, and an initial `status`. Query it with `GET /easy-media/workflow/submissions/{request_id}`:

| status | Meaning |
|---|---|
| `pending` | Waiting for the frontend to claim it; not yet opened |
| `loading` | Claimed; loading or queueing in progress |
| `loaded` | Opened; queueing was not requested |
| `queued` | Native enqueue succeeded, with `prompt_id`; does not mean generation has finished |
| `failed` | Loading failed, or stopped before queueing; includes `error` |
| `unknown` | Execution result unconfirmed; it may have been queued. Check queue and history first; do not rerun automatically |

HTTP 400 means invalid parameters. 409 means several pages without a specified target, a busy target, or a request ID conflict. 503 means no frontend is available or service capacity is full. The frontend polls to claim work and reports results back; it does not broadcast to all WebSockets. If no acknowledgement arrives, a claimed workflow is not dispatched again.

Request state is kept only in the current ComfyUI process. Completed records are kept for one hour. An unclaimed request fails after 60 seconds. After being claimed, a request with no acknowledgement for more than 120 seconds becomes `unknown`. `unknown` blocks further automatic submission to the same page. Check the queue and history first; after confirming, refresh the page to re-register. After a restart, or after records expire, do not rely on the original ID for deduplication.

## Determining Generation Completion

1. Save the `request_id`, wait until `queued`, and record the `prompt_id`. `loaded`, `pending` and `loading` do not mean the workflow is running.
2. Use `GET /queue` to check pending and running items. Use `GET /history/{prompt_id}` to wait for a terminal state.
3. Only when the corresponding record's `status.completed` is `true` and `status.status_str` is `success` does it count as success. Errors or interruptions are reported as failures.
4. Collect the files from the history's `outputs`. If the user has not asked for long-term monitoring and the job is still running, return the ID and current status, and do not cancel the job. Cancelling or clearing the queue requires an explicit request.

## Pre-Execution Review

- The workflow has passed dry-run, post-write inspection and invariant checks.
- Resolution is consistent with the DynamicCombo child fields. The target task range, `project_save` and sampling match the user's request.
- `audio_locked` is unique and covers the target tasks. `shared_reference` points to the intended shared image, audio or video. The legacy `speaker_reference` is used only for compatibility migration.
- Media paths exist on the current ComfyUI instance. Overwriting the current tab happens only when the user has requested replacement.
