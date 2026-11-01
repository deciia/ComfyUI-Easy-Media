# Media Upload and Path Recording

This reference explains how to place the media from the Codex context into the target ComfyUI input directory. Prefer the ComfyUI address the user provides. If none is provided, first read `COMFYUI_URL` from the Easy Media node pack's `config.yaml`, and fall back to `http://127.0.0.1:8188` only if the file or field is missing (including an empty value). Uploads, queueing and history queries for the same workflow run must use the same instance.

For address resolution and config file location, see the [submission reference](execution-api.md#address-and-preflight). In the curl examples below, replace the local address with the resolved address.

## Upload to an input Subdirectory

The project's frontend uploads images, audio and video through ComfyUI's `/upload/image` endpoint and passes the input subdirectory:

```bash
curl --fail-with-body --silent --show-error \
  -X POST http://127.0.0.1:8188/upload/image \
  -F 'image=@/absolute/path/to/clip.mp4' \
  -F 'type=input' \
  -F 'overwrite=false' \
  -F 'subfolder=codex/session-name'
```

A typical response:

```json
{"name":"clip.mp4","subfolder":"codex/session-name","type":"input"}
```

The `file_path` written into TRACK_DATA must be the relative path `subfolder/name` built from the response, with `source_type` set to `input`. Do not write the local absolute path from before the upload, and do not assume the server did not rename a file with the same name.

## Generic Root-Directory Upload

`POST /easy-media/upload` accepts any media file and writes it to the input root. The current implementation does not support subdirectories:

```bash
curl --fail-with-body --silent --show-error \
  -X POST http://127.0.0.1:8188/easy-media/upload \
  -F 'file=@/absolute/path/to/audio.wav'
```

The response is `{"file_name":"..."}`. Use this endpoint only when `/upload/image` does not apply and the user does not need a subdirectory.

## URL Media

`POST /easy-media/download-url` downloads a URL into the input root:

```bash
curl --fail-with-body --silent --show-error \
  -X POST http://127.0.0.1:8188/easy-media/download-url \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/media.mp4"}'
```

If the user wants to keep a remote reference instead of downloading, use `source_type: "url"` and a `url` field in TRACK_DATA. Do not send private media to a remote service without the user's authorization.

## Post-Upload Checks

- Choose a stable relative subdirectory for this edit that does not contain `..`, for example `codex/<project-or-date>`.
- Check the HTTP status and JSON response of each upload. On failure, stop, and do not write the failed media into the timeline.
- Upload each media file only once, and reuse the returned path.
- You can check recent files with `GET /easy-media/media/recent?source=inputs&type=all&subfolder=...`.
- Uploading is an external write. A dry-run workflow patch does not roll back uploaded files.
