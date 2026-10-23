"""
API routes for ComfyUI-Easy-Media media browser.

Endpoints
---------
GET /easy-media/media/list
    Query params:
        source    – "inputs" | "outputs" | "local"
        type      – "all" | "image" | "audio" | "video"  (default: "all")
        path      – required when source == "local", absolute root folder path
        subfolder – optional relative subfolder to list (default: root)

Response (JSON):
    {
        "items": [
            // directory entry
            { "type": "dir",  "name": str, "path": str },
            // file entry
            { "type": "file", "name": str, "path": str,
              "url": str, "size": int, "mtime": float }
        ]
    }
"""

import asyncio
import json
import math
import os
import traceback
import uuid
from pathlib import Path

import aiohttp
from server import PromptServer
from aiohttp import web
import folder_paths

from .utils.prompt_builder import get_system_prompt_options
from .utils.llm_api import load_api_key_from_config
from .utils.h3_project import (
    delete_h3_project,
    delete_h3_project_video,
    inspect_h3_canvas,
    load_h3_project_data,
    safe_h3_project_name,
    select_h3_project_video,
)
from .utils.h3_timeline import (
    TimelineConflictError,
    create_timeline,
    delete_timeline,
    list_timelines,
    load_timeline,
    safe_timeline_project_name,
    save_timeline,
)
from .utils.h3_prompt_validate import validate_prompt
from .utils.prompt_enhancer import (
    PROVIDER_DEFAULTS,
    PromptEnhancerError,
    generate_prompt,
    load_config as load_prompt_enhancer_config,
    masked_config as mask_prompt_enhancer_config,
    save_config as save_prompt_enhancer_config,
)
from .utils.agent import run_agent, run_agent_step
from .utils.plan_segments import (
    PlanError,
    generate_plan,
    parse_storyboard_text,
    render_storyboard_text,
)
from .utils.models import (
    MissingEasyMediaModelError,
    download_model,
    model_payload,
    get_model_info,
)
from .utils.media import (
    allowed_extensions,
    extract_filename_from_content_disposition,
    is_json_error,
    list_dir_shallow,
    list_recent_media_files,
)
from .modules.asr.subtitle_recognition import (
    MissingSubtitleRecognitionDependenciesError,
    recognize_audio_subtitles,
    subtitle_recognition_options,
    validate_subtitle_recognition_method,
)
from .utils.speech import generate_voxcpm2_speech
from .utils.workflow_submission import register_workflow_routes
from .utils.video import (
    decode_multitrack_preview_frame,
    download_audio_to_temp,
    download_video_to_temp,
    extract_video_audio_to_temp,
    ffprobe_info,
    resolve_segment_audio_path,
    resolve_segment_video_path,
)


_SMART_SPLIT_LOCK = asyncio.Lock()
_SUBTITLE_SPEECH_LOCK = asyncio.Lock()
_PREVIEW_FRAME_LOCK = asyncio.Lock()
_RUNNINGHUB_ACCOUNT_ENDPOINT = "https://www.runninghub.cn/uc/openapi/accountStatus"

register_workflow_routes(
    PromptServer.instance.routes,
    lambda session_id: session_id in PromptServer.instance.sockets,
)


@PromptServer.instance.routes.get("/easy-media/project")
async def handle_h3_project(request: web.Request) -> web.Response:
    project_name = request.rel_url.query.get("project_name", "")
    try:
        return web.json_response(load_h3_project_data(project_name))
    except (FileNotFoundError, TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=404)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to load H3 project: {error}"}, status=500)


@PromptServer.instance.routes.get("/easy-media/project/canvas_inspect")
async def handle_h3_project_canvas_inspect(request: web.Request) -> web.Response:
    """Detect per-segment resolution mismatches for the combine widget warning.

    2026-10-05：供「多轨项目视频合并」前端在运行前预警——各段分辨率不一致时
    节点底部显示明细与画布方案，由用户决策后再合成。
    """
    project_name = request.rel_url.query.get("project_name", "")
    try:
        report = inspect_h3_canvas(project_name)
        return web.json_response(report or {"ok": True})
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to inspect canvas: {error}"}, status=500)


@PromptServer.instance.routes.get("/easy-media/projects")
async def handle_h3_projects(_request: web.Request) -> web.Response:
    try:
        root = (
            Path(folder_paths.get_output_directory()).resolve()
            / "easy_media"
            / "projects"
        )
        names = {
            path.name
            for path in root.iterdir()
            if path.is_dir() and not path.name.startswith(".")
        } if root.is_dir() else set()
        names.add("default")
        projects = ["default", *sorted(name for name in names if name != "default")]
        return web.json_response({"projects": projects})
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to list H3 projects: {error}"}, status=500)


@PromptServer.instance.routes.delete("/easy-media/project")
async def handle_delete_h3_project(request: web.Request) -> web.Response:
    project_name = request.rel_url.query.get("project_name", "")
    try:
        safe_name = safe_h3_project_name(project_name)
        deleted = delete_h3_project(safe_name)
        return web.json_response({"project_name": safe_name, "deleted": deleted})
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to delete H3 project: {error}"}, status=500)


@PromptServer.instance.routes.delete("/easy-media/project/video")
async def handle_delete_h3_project_video(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Request must contain a JSON object")
        project_name = payload.get("project_name")
        segment_index = payload.get("segment_index")
        file_path = payload.get("file_path")
        if not isinstance(project_name, str) or not isinstance(file_path, str):
            raise ValueError("project_name and file_path must be strings")
        if type(segment_index) is not int or segment_index < 0:
            raise ValueError("segment_index must be a non-negative integer")
        return web.json_response(delete_h3_project_video(project_name, segment_index, file_path))
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to delete project video: {error}"}, status=500)


@PromptServer.instance.routes.patch("/easy-media/project/video")
async def handle_select_h3_project_video(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Request must contain a JSON object")
        project_name = payload.get("project_name")
        segment_index = payload.get("segment_index")
        file_path = payload.get("file_path")
        if not isinstance(project_name, str) or not isinstance(file_path, str):
            raise ValueError("project_name and file_path must be strings")
        if type(segment_index) is not int or segment_index < 0:
            raise ValueError("segment_index must be a non-negative integer")
        return web.json_response(
            select_h3_project_video(project_name, segment_index, file_path)
        )
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to select project video: {error}"}, status=500)


@PromptServer.instance.routes.get("/easy-media/project/timeline")
async def handle_h3_project_timeline(request: web.Request) -> web.Response:
    """读取某个项目的时间线（多轨编辑器轨道数据）。"""
    project_name = request.rel_url.query.get("project_name", "")
    try:
        return web.json_response(load_timeline(project_name))
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to load timeline: {error}"}, status=500)


@PromptServer.instance.routes.put("/easy-media/project/timeline")
async def handle_save_h3_project_timeline(request: web.Request) -> web.Response:
    """保存项目时间线；带 base_updated_at 时做乐观并发校验（冲突返回 409）。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Request must contain a JSON object")
        project_name = payload.get("project_name")
        if not isinstance(project_name, str) or not project_name.strip():
            raise ValueError("project_name must be a non-empty string")
        timeline = payload.get("timeline")
        if timeline is None:
            raise ValueError("timeline is required")
        base_raw = payload.get("base_updated_at")
        base_updated_at = None
        if base_raw is not None:
            try:
                base_updated_at = float(base_raw)
            except (TypeError, ValueError) as error:
                raise ValueError("base_updated_at must be a number") from error
        return web.json_response(
            save_timeline(project_name, timeline, base_updated_at=base_updated_at)
        )
    except TimelineConflictError as error:
        return web.json_response(
            {
                "error": str(error),
                "conflict": True,
                "project_name": error.project_name,
                "updated_at": error.updated_at,
            },
            status=409,
        )
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to save timeline: {error}"}, status=500)


@PromptServer.instance.routes.post("/easy-media/project/timeline/new")
async def handle_create_h3_project_timeline(request: web.Request) -> web.Response:
    """新建项目时间线（已存在返回 409）。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Request must contain a JSON object")
        project_name = payload.get("project_name")
        if not isinstance(project_name, str) or not project_name.strip():
            raise ValueError("project_name must be a non-empty string")
        template = payload.get("template")
        if template is not None and not isinstance(template, (dict, str)):
            raise ValueError("template must be a JSON object")
        timeline = create_timeline(project_name, template)
        return web.json_response(timeline, status=201)
    except FileExistsError as error:
        return web.json_response({"error": str(error), "exists": True}, status=409)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to create timeline: {error}"}, status=500)


@PromptServer.instance.routes.delete("/easy-media/project/timeline")
async def handle_delete_h3_project_timeline(request: web.Request) -> web.Response:
    """只删除时间线（timeline.json），视频产物与渲染清单保持不动。"""
    project_name = request.rel_url.query.get("project_name", "")
    try:
        safe_name = safe_timeline_project_name(project_name)
        deleted = delete_timeline(safe_name)
        # 2026-10-18：删除是破坏性动作，留一行服务端日志方便排查"点了删除却没生效"
        print(  # noqa: T201
            f"[EasyMedia] project timeline delete: raw={project_name!r} "
            f"safe={safe_name!r} deleted={deleted}",
            flush=True,
        )
        return web.json_response({"project_name": safe_name, "deleted": deleted})
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to delete timeline: {error}"}, status=500)


@PromptServer.instance.routes.get("/easy-media/project/timelines")
async def handle_h3_project_timelines(_request: web.Request) -> web.Response:
    """列出项目及其时间线摘要（不返回完整时间线）。"""
    try:
        return web.json_response({"projects": list_timelines()})
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to list timelines: {error}"}, status=500)


def _segment_source_audio_window(data: dict, fps: float) -> tuple[float, float]:
    start_frame = data.get("start_frame")
    end_frame = data.get("end_frame")
    if not isinstance(start_frame, (int, float)) or not isinstance(end_frame, (int, float)):
        return 0.0, 0.0
    if not math.isfinite(start_frame) or not math.isfinite(end_frame):
        return 0.0, 0.0
    origin_start_frame = data.get("origin_start_frame")
    if not isinstance(origin_start_frame, (int, float)) or not math.isfinite(origin_start_frame):
        origin_start_frame = start_frame
    source_start = max(0.0, (float(start_frame) - float(origin_start_frame)) / fps)
    duration = max(0.0, (float(end_frame) - float(start_frame)) / fps)
    return source_start, duration


@PromptServer.instance.routes.get("/easy-media/media/list")
async def handle_media_list(request: web.Request) -> web.Response:
    source = request.rel_url.query.get("source", "inputs")
    media_type = request.rel_url.query.get("type", "all")
    local_path = request.rel_url.query.get("path", "")
    subfolder = request.rel_url.query.get("subfolder", "")

    allowed = allowed_extensions(media_type)

    if source == "inputs":
        base = Path(folder_paths.get_input_directory())
        items = list_dir_shallow(base, subfolder, "inputs", allowed)
    elif source == "outputs":
        base = Path(folder_paths.get_output_directory())
        items = list_dir_shallow(base, subfolder, "outputs", allowed)
    elif source == "local":
        if not local_path:
            return web.Response(
                status=400,
                content_type="application/json",
                text=json.dumps({"error": "path parameter is required for local source"}),
            )
        abs_path = os.path.abspath(local_path)
        if not os.path.isdir(abs_path):
            return web.Response(
                status=404,
                content_type="application/json",
                text=json.dumps({"error": "directory not found"}),
            )
        items = list_dir_shallow(Path(abs_path), subfolder, "local", allowed)
    else:
        return web.Response(
            status=400,
            content_type="application/json",
            text=json.dumps({"error": f"unknown source '{source}'"}),
        )

    return web.Response(
        content_type="application/json",
        text=json.dumps({"items": items}),
    )


@PromptServer.instance.routes.get("/easy-media/media/recent")
async def handle_media_recent(request: web.Request) -> web.Response:
    source = request.rel_url.query.get("source", "outputs")
    media_type = request.rel_url.query.get("type", "all")
    subfolder = request.rel_url.query.get("subfolder", "")
    try:
        hours = max(0.0, float(request.rel_url.query.get("hours", "48")))
        limit = max(1, min(1000, int(request.rel_url.query.get("limit", "100"))))
    except (TypeError, ValueError):
        return web.Response(
            status=400,
            content_type="application/json",
            text=json.dumps({"error": "hours and limit must be valid numbers"}),
        )

    allowed = allowed_extensions(media_type)

    if source == "inputs":
        base = Path(folder_paths.get_input_directory())
    elif source == "outputs":
        base = Path(folder_paths.get_output_directory())
    elif source == "temp":
        base = Path(folder_paths.get_temp_directory())
    else:
        return web.Response(
            status=400,
            content_type="application/json",
            text=json.dumps({"error": f"unknown source '{source}'"}),
        )

    items = list_recent_media_files(base, subfolder, source, allowed, hours, limit)
    return web.Response(
        content_type="application/json",
        text=json.dumps({"items": items}),
    )


@PromptServer.instance.routes.post("/easy-media/upload")
async def handle_easy_upload(request: web.Request) -> web.Response:
    """Upload any file to the ComfyUI input directory."""
    reader = await request.multipart()
    field = await reader.next()
    if field is None:
        return web.Response(
            status=400,
            content_type="application/json",
            text=json.dumps({"error": "No file field provided"}),
        )

    original_name = field.filename or f"upload_{uuid.uuid4().hex[:8]}"
    stem = Path(original_name).stem
    ext = Path(original_name).suffix

    input_dir = Path(folder_paths.get_input_directory())
    filename = original_name
    target = input_dir / filename
    if target.exists():
        filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
        target = input_dir / filename

    with open(target, "wb") as fp:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            fp.write(chunk)

    return web.Response(
        content_type="application/json",
        text=json.dumps({"file_name": filename}),
    )


@PromptServer.instance.routes.post("/easy-media/download-url")
async def handle_download_url(request: web.Request) -> web.Response:
    """
    Download a URL and store it in the ComfyUI input directory.

    Response: { source_type: "input", file_name } | { error: "..." }
    """
    try:
        data = await request.json()
    except Exception:
        return web.Response(
            status=400,
            content_type="application/json",
            text=json.dumps({"error": "Invalid JSON body"}),
        )

    url = data.get("url", "")

    try:
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:

                content = await resp.read()

                # Detect JSON error responses (e.g., {"detail": "Not found"})
                if is_json_error(content):
                    try:
                        err_obj = json.loads(content.decode('utf-8', errors='ignore'))
                        err_msg = err_obj.get('detail') or err_obj.get('error') or err_obj.get('message') or 'Download failed'
                    except Exception:
                        err_msg = 'Download failed (not a file)'
                    return web.Response(
                        status=502,
                        content_type="application/json",
                        text=json.dumps({"error": err_msg}),
                    )

                # Derive filename from Content-Disposition or URL path
                ct = resp.headers.get("Content-Type", "").split(";")[0].strip()
                cd = resp.headers.get("Content-Disposition")
                filename = extract_filename_from_content_disposition(cd)
                if not filename:
                    url_path = url.split("?")[0].rstrip("/")
                    filename = Path(url_path).name

                # Determine extension: use URL extension, or map Content-Type to extension
                ext = Path(filename).suffix.lower()
                if not ext:
                    ext = {
                        "image/jpeg": ".jpg",
                        "image/png": ".png",
                        "image/webp": ".webp",
                        "image/gif": ".gif",
                        "video/mp4": ".mp4",
                        "video/webm": ".webm",
                        "audio/mpeg": ".mp3",
                        "audio/wav": ".wav",
                    }.get(ct, ".bin")
                    filename = f"download_{uuid.uuid4().hex[:8]}{ext}"
                elif ext == ".bin":
                    # Override .bin extension with Content-Type mapping if available
                    mapped_ext = {
                        "image/jpeg": ".jpg",
                        "image/png": ".png",
                        "image/webp": ".webp",
                        "image/gif": ".gif",
                        "video/mp4": ".mp4",
                        "video/webm": ".webm",
                    }.get(ct)
                    if mapped_ext:
                        filename = Path(filename).stem + mapped_ext

                input_dir = Path(folder_paths.get_input_directory())
                target = input_dir / filename
                if target.exists():
                    stem = Path(filename).stem
                    ext = Path(filename).suffix
                    filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
                    target = input_dir / filename

                target.write_bytes(content)
        return web.Response(
            content_type="application/json",
            text=json.dumps({"source_type": "input", "file_name": filename}),
        )

    except Exception as exc:
        return web.Response(
            status=500,
            content_type="application/json",
            text=json.dumps({"error": str(exc)}),
        )


@PromptServer.instance.routes.get("/easy-media/prompt/system-prompts")
async def handle_system_prompt_options(request: web.Request) -> web.Response:
    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "items": get_system_prompt_options(),
        }),
    )


@PromptServer.instance.routes.post("/easy-media/prompt-enhancer/runninghub-balance")
async def handle_runninghub_balance(request: web.Request) -> web.Response:
    """Proxy RunningHub balance lookup so the widget is not blocked by browser CORS."""
    try:
        try:
            data = await request.json()
        except Exception as error:
            raise ValueError("Invalid JSON body") from error
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")

        explicit_api_key = data.get("api_key", "")
        if explicit_api_key is not None and not isinstance(explicit_api_key, str):
            raise ValueError("api_key must be a string")
        api_key = str(explicit_api_key or "").strip()
        if not api_key:
            api_key = load_api_key_from_config("RUNNINGHUB_API_KEY")
        if not api_key:
            api_key = os.getenv("RUNNINGHUB_API_KEY", "").strip()
        if not api_key:
            raise ValueError(
                "RunningHub API key is required in the node, config.yaml, or RUNNINGHUB_API_KEY."
            )

        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                _RUNNINGHUB_ACCOUNT_ENDPOINT,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={"apikey": api_key},
            ) as response:
                try:
                    payload = await response.json(content_type=None)
                except (aiohttp.ContentTypeError, json.JSONDecodeError) as error:
                    raise RuntimeError("RunningHub returned an invalid account response.") from error
                if response.status >= 400:
                    message = payload.get("msg") if isinstance(payload, dict) else None
                    raise RuntimeError(message or f"RunningHub account request failed ({response.status}).")

        if not isinstance(payload, dict) or payload.get("code") != 0:
            message = payload.get("msg") if isinstance(payload, dict) else None
            raise RuntimeError(message or "RunningHub account request failed.")
        account = payload.get("data")
        if not isinstance(account, dict):
            raise RuntimeError("RunningHub account response did not contain account data.")
        try:
            amount = float(account.get("remainMoney"))
        except (TypeError, ValueError) as error:
            raise RuntimeError("RunningHub account response did not contain a valid balance.") from error
        if not math.isfinite(amount):
            raise RuntimeError("RunningHub account response did not contain a finite balance.")
        currency = account.get("currency")
        return web.json_response({
            "amount": amount,
            "currency": currency if isinstance(currency, str) else "CNY",
        })
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError) as error:
        return web.json_response({"error": str(error)}, status=502)


@PromptServer.instance.routes.post("/easy-media/models/download")
async def handle_model_download(request: web.Request) -> web.Response:
    try:
        try:
            data = await request.json()
        except Exception as error:
            raise ValueError("Invalid JSON body") from error
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        model_name = data.get("model_name")
        if not isinstance(model_name, str) or not model_name:
            raise ValueError("model_name is required")

        model = get_model_info(model_name)
        path = await download_model(model.name)
        return web.json_response({
            "ok": True,
            "model": model_payload(model),
            "path": str(path),
        })
    except TimeoutError as error:
        return web.json_response({"error": str(error)}, status=504)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except aiohttp.ClientError as error:
        return web.json_response({"error": f"Automatic download failed: {error}"}, status=502)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Automatic download failed: {error}"}, status=500)


@PromptServer.instance.routes.post("/easy-media/video/source-fps")
async def handle_video_source_fps(request: web.Request) -> web.Response:
    """Read a source video's frame rate for the native preview fast path."""
    temp_path: Path | None = None
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        if data.get("source_type") == "url":
            url = data.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("url is required for URL video segments")
            temp_path = await download_video_to_temp(url)
            video_path = temp_path
        else:
            video_path = resolve_segment_video_path(data)
        async with _PREVIEW_FRAME_LOCK:
            info = await asyncio.to_thread(ffprobe_info, str(video_path))
        fps = info.get("fps")
        if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
            raise ValueError("Unable to read source video frame rate")
        return web.json_response({"fps": fps})
    except (ValueError, FileNotFoundError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Video frame rate probe failed: {error}"}, status=500)
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError as error:
                print(f"[Easy Media] Failed to remove frame rate probe temporary video: {error}")


@PromptServer.instance.routes.post("/easy-media/video/preview-frame")
async def handle_video_preview_frame(request: web.Request) -> web.Response:
    """Serve a paused timeline frame with the same sampling as task output."""
    temp_path: Path | None = None
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        frame = data.get("frame")
        fps = data.get("fps")
        if not isinstance(frame, int) or isinstance(frame, bool) or frame < 0:
            raise ValueError("frame must be a nonnegative integer")
        if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
            raise ValueError("fps must be a positive finite number")
        if data.get("source_type") == "url":
            url = data.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("url is required for URL video segments")
            temp_path = await download_video_to_temp(url)
            video_path = temp_path
        else:
            video_path = resolve_segment_video_path(data)
        async with _PREVIEW_FRAME_LOCK:
            image = await asyncio.to_thread(decode_multitrack_preview_frame, video_path, frame, float(fps))
        return web.Response(body=image, content_type="image/jpeg")
    except (ValueError, FileNotFoundError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Video preview failed: {error}"}, status=500)
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError as error:
                print(f"[Easy Media] Failed to remove preview temporary video: {error}")


@PromptServer.instance.routes.post("/easy-media/video/smart-split")
async def handle_video_smart_split(request: web.Request) -> web.Response:
    """Run OmniShotCut for one video and return its detected frame ranges."""
    temp_path: Path | None = None
    try:
        try:
            data = await request.json()
        except Exception as error:
            raise ValueError("Invalid JSON body") from error
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        fps = data.get("fps")
        if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
            raise ValueError("fps must be a positive finite number")
        if data.get("source_type") == "url":
            url = data.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("url is required for URL video segments")
            temp_path = await download_video_to_temp(url)
            video_path = temp_path
        else:
            video_path = resolve_segment_video_path(data)

        from .modules.omnishotcut import detect_shots

        async with _SMART_SPLIT_LOCK:
            ranges = await asyncio.to_thread(detect_shots, video_path, float(fps), mode="clean_shot")
        return web.json_response({"ranges": ranges})
    except MissingEasyMediaModelError as error:
        return web.json_response({
            "error": str(error),
            "model_missing": model_payload(error.model),
        }, status=428)
    except (ValueError, FileNotFoundError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"OmniShotCut detection failed: {error}"}, status=500)
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError as error:
                print(f"[Easy Media] Failed to remove OmniShotCut temporary video: {error}")


@PromptServer.instance.routes.post("/easy-media/subtitles/recognize")
async def handle_subtitle_recognition(request: web.Request) -> web.Response:
    """Run ASR for one video/audio segment and return subtitle segments."""
    source_temp_path: Path | None = None
    extracted_audio_path: Path | None = None
    try:
        try:
            data = await request.json()
        except Exception as error:
            raise ValueError("Invalid JSON body") from error
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        fps = data.get("fps")
        if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
            raise ValueError("fps must be a positive finite number")

        method = validate_subtitle_recognition_method(
            str(data.get("method", "qwen3-asr"))
        )
        max_sentence_length, unload_model = subtitle_recognition_options(data)
        media_type = data.get("media_type")
        source_type = data.get("source_type")
        if source_type == "url":
            url = data.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("url is required for URL media segments")
            if media_type == "video":
                source_temp_path = await download_video_to_temp(url)
                media_path = source_temp_path
            elif media_type == "audio":
                source_temp_path = await download_audio_to_temp(url)
                media_path = source_temp_path
            else:
                raise ValueError("media_type must be video or audio")
        elif media_type == "video":
            media_path = resolve_segment_video_path(data)
        elif media_type == "audio":
            media_path = resolve_segment_audio_path(data)
        else:
            raise ValueError("media_type must be video or audio")

        source_start, source_duration = _segment_source_audio_window(data, float(fps))
        if media_type == "video" or source_start > 0 or source_duration > 0:
            extracted_audio_path = extract_video_audio_to_temp(
                media_path,
                start_time=source_start,
                duration=source_duration,
            )
            audio_path = extracted_audio_path
        else:
            audio_path = media_path

        segments = await asyncio.to_thread(
            recognize_audio_subtitles,
            audio_path,
            method,
            max_sentence_length,
            unload_model,
        )
        return web.json_response({"segments": segments})
    except MissingSubtitleRecognitionDependenciesError as error:
        return web.json_response({
            "error": str(error),
            "missing_dependencies": error.dependencies,
        }, status=424)
    except MissingEasyMediaModelError as error:
        return web.json_response({
            "error": str(error),
            "model_missing": model_payload(error.model),
        }, status=428)
    except (ValueError, FileNotFoundError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Subtitle recognition failed: {error}"}, status=500)
    finally:
        for path in (source_temp_path, extracted_audio_path):
            if path is None:
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError as error:
                print(f"[Easy Media] Failed to remove subtitle recognition temporary file: {error}")


@PromptServer.instance.routes.post("/easy-media/subtitles/speech")
async def handle_subtitle_speech(request: web.Request) -> web.Response:
    """Generate speech audio for a subtitle segment."""
    try:
        try:
            data = await request.json()
        except Exception as error:
            raise ValueError("Invalid JSON body") from error
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")

        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text is required")
        model = data.get("model", "VoxCPM2")
        if model != "VoxCPM2":
            raise ValueError(f"unsupported speech model: {model}")
        prompt = data.get("prompt", "")
        if not isinstance(prompt, str):
            raise ValueError("prompt must be a string")
        cfg = data.get("cfg", 2.0)
        if not isinstance(cfg, (int, float)) or not math.isfinite(cfg):
            raise ValueError("cfg must be a finite number")
        steps = data.get("steps", 10)
        if not isinstance(steps, (int, float)) or not math.isfinite(steps):
            raise ValueError("steps must be a finite number")

        reference_audio_path = None
        raw_reference_audio_path = data.get("reference_audio_path")
        if isinstance(raw_reference_audio_path, str) and raw_reference_audio_path:
            reference_audio_path = resolve_segment_audio_path({
                "source_type": data.get("reference_audio_source_type", "input"),
                "file_path": raw_reference_audio_path,
                "local_path": raw_reference_audio_path,
            })

        async with _SUBTITLE_SPEECH_LOCK:
            result = await asyncio.to_thread(
                generate_voxcpm2_speech,
                text=text.strip(),
                prompt=prompt,
                cfg=float(cfg),
                steps=int(steps),
                reference_audio_path=reference_audio_path,
            )

        return web.json_response({
            "file_path": result.file_path,
            "absolute_path": result.absolute_path,
            "source_type": result.source_type,
            "duration": result.duration,
            "message": f"Audio generated and saved to {result.absolute_path}",
        })
    except MissingEasyMediaModelError as error:
        return web.json_response({
            "error": str(error),
            "model_missing": model_payload(error.model),
        }, status=428)
    except RuntimeError as error:
        message = str(error)
        status = 424 if "Missing Python dependencies" in message else 500
        return web.json_response({"error": message}, status=status)
    except (ValueError, FileNotFoundError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Subtitle speech generation failed: {error}"}, status=500)


# --------------------------------------------------------------------------- #
# 提示词增强器（模态窗）：配置 + 生成
# 设计见 D:\workspace\docs\easymedia-subject-prompt-compose-spec.md §6
# --------------------------------------------------------------------------- #
def _resolve_enhancer_images(items) -> list[str]:
    """把 input 相对路径解析成绝对路径；非绝对且不存在则丢弃。"""
    from pathlib import Path

    import folder_paths as _fp

    resolved: list[str] = []
    for item in items if isinstance(items, list) else []:
        text = str(item or "").strip()
        if not text:
            continue
        path = Path(text)
        if not path.is_absolute():
            path = Path(_fp.get_input_directory()) / text
        if path.is_file():
            resolved.append(str(path))
    return resolved


@PromptServer.instance.routes.get("/easy-media/prompt-studio/config")
async def handle_prompt_studio_config_get(_request: web.Request) -> web.Response:
    """读取提示词增强器配置（api_key 脱敏）。"""
    try:
        config = load_prompt_enhancer_config()
        return web.json_response({
            "config": mask_prompt_enhancer_config(config),
            "providers": PROVIDER_DEFAULTS,
        })
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to read config: {error}"}, status=500)


@PromptServer.instance.routes.put("/easy-media/prompt-studio/config")
async def handle_prompt_studio_config_put(request: web.Request) -> web.Response:
    """保存提示词增强器配置到 ComfyUI/user/DeciiaEasyMedia/prompt_studio.json。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return web.json_response({"error": "config must be an object"}, status=400)
        current = load_prompt_enhancer_config()
        merged = dict(current)
        for key, value in payload.items():
            if key == "api_key":
                continue
            merged[key] = value
        api_key = str(payload.get("api_key") or "").strip()
        if api_key:
            merged["api_key"] = api_key
        path = save_prompt_enhancer_config(merged)
        return web.json_response({
            "ok": True,
            "path": str(path),
            "config": mask_prompt_enhancer_config(merged),
        })
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to save config: {error}"}, status=500)


@PromptServer.instance.routes.post("/easy-media/prompt-studio/generate")
async def handle_prompt_studio_generate(request: web.Request) -> web.Response:
    """生成规范提示词；失败不覆盖原文，校验不过也原样返回失败项。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be an object"}, status=400)
        brief = str(payload.get("brief") or "").strip()
        if not brief:
            return web.json_response({"error": "片段提示词为空"}, status=400)
        payload = dict(payload)
        payload["images"] = _resolve_enhancer_images(payload.get("images"))
        result = await generate_prompt(payload)
        options = payload.get("options") or {}
        task_type = str(payload.get("task_type") or options.get("task_type") or "")
        task_mode = str(payload.get("task_mode") or options.get("task_mode") or "")
        require_sections = task_mode == "ref" or task_type.lower() in {"r2v", "ref2va", "vi2v"}

        def _validate(text: str) -> list:
            return validate_prompt(
                text,
                require_sections=require_sections,
                picture_count=payload.get("picture_count"),
                audio_count=payload.get("audio_count"),
                video_count=payload.get("video_count"),
                max_shots=payload.get("max_shots"),
            )

        failures = _validate(result.get("prompt", ""))
        # 结构校验未过：带失败项自动重试一次，仍失败则原样返回失败清单
        if failures:
            retry_payload = dict(payload)
            retry_options = dict(options)
            retry_options["constraints"] = (
                str(options.get("constraints") or "")
                + "\n上次输出未通过结构校验，必须全部修复：" + "；".join(str(item) for item in failures[:6])
            ).strip()
            retry_payload["options"] = retry_options
            try:
                retry_result = await generate_prompt(retry_payload)
                retry_failures = _validate(retry_result.get("prompt", ""))
                if len(retry_failures) < len(failures):
                    result, failures = retry_result, retry_failures
            except PromptEnhancerError:
                pass
        return web.json_response({**result, "failures": failures})
    except PromptEnhancerError as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response({"error": f"Failed to generate prompt: {error}"}, status=500)

@PromptServer.instance.routes.post("/easy-media/prompt-studio/plan")
async def handle_prompt_studio_plan(request: web.Request) -> web.Response:
    """导演级分镜规划；失败返回可展示错误，不写入任何数据。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "payload must be an object"}, status=400)
        plan = await generate_plan(payload)
        return web.json_response({"ok": True, "plan": plan})
    except PlanError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response(
            {"ok": False, "error": f"Failed to plan storyboard: {error}"}, status=500
        )


@PromptServer.instance.routes.get("/easy-media/agent/info")
async def handle_agent_info(request: web.Request) -> web.Response:
    """返回智能体使用的 provider / 模型与可用工具。"""
    try:
        from .utils.prompt_enhancer import resolve_settings

        settings = resolve_settings(None)
        return web.json_response(
            {
                "ok": True,
                "provider": getattr(settings, "provider", ""),
                "model": settings.model,
                "tools": [
                    {"name": "plan_storyboard", "label": "规划分镜"},
                    {"name": "revise_storyboard", "label": "修改分镜"},
                    {"name": "apply_storyboard", "label": "应用到任务轨"},
                    {"name": "answer", "label": "回答"},
                ],
            }
        )
    except Exception as error:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(error)}, status=500)


@PromptServer.instance.routes.get("/easy-media/assets/input")
async def handle_list_input_assets(request: web.Request) -> web.Response:
    """列出 input 目录下的素材（可按 subdir 过滤），供智能体挑选参考图/音频。"""
    try:
        subdir = str(request.rel_url.query.get("subdir") or "").strip().strip("/\\")
        limit = max(1, min(500, int(request.rel_url.query.get("limit") or 200)))
        import folder_paths as _fp

        root = Path(_fp.get_input_directory())
        base = (root / subdir) if subdir else root
        if not base.exists():
            return web.json_response({"ok": False, "error": f"目录不存在：{subdir or 'input'}"}, status=404)
        items = []
        for file in sorted(base.rglob("*")):
            if not file.is_file():
                continue
            if file.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".wav", ".mp3", ".m4a", ".flac", ".mp4", ".mov", ".webm", ".mkv"}:
                continue
            rel = file.relative_to(root).as_posix()
            items.append({
                "path": rel,
                "file_name": file.name,
                "subfolder": str(Path(rel).parent).replace("\\", "/") if "/" in rel else "",
                "size": file.stat().st_size,
                "kind": "image" if file.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"} else ("audio" if file.suffix.lower() in {".wav", ".mp3", ".m4a", ".flac"} else "video"),
            })
            if len(items) >= limit:
                break
        return web.json_response({"ok": True, "root": str(root), "items": items})
    except Exception as error:  # noqa: BLE001
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(error)}, status=500)


@PromptServer.instance.routes.get("/easy-media/assets/outputs")
async def handle_list_project_outputs(request: web.Request) -> web.Response:
    """列出某项目最近的生成产物（视频/图片），供智能体在生成后自查。"""
    try:
        project = str(request.rel_url.query.get("project") or "").strip()
        limit = max(1, min(100, int(request.rel_url.query.get("limit") or 12)))
        import folder_paths as _fp

        out_root = Path(_fp.get_output_directory())
        candidates = []
        if project:
            candidates.append(out_root / "easy_media" / "projects" / project)
        candidates.append(out_root / "easy_media")
        candidates.append(out_root)
        found = []
        for base in candidates:
            if not base.exists():
                continue
            for file in base.rglob("*"):
                if not file.is_file():
                    continue
                if file.suffix.lower() not in {".mp4", ".webm", ".mov", ".mkv", ".png", ".jpg"}:
                    continue
                if "easy_media" not in file.as_posix() and project and project not in file.as_posix():
                    continue
                found.append(file)
            if len(found) >= limit * 4:
                break
        found.sort(key=lambda item: item.stat().st_mtime, reverse=True)
        items = [{
            "path": str(file),
            "file_name": file.name,
            "size": file.stat().st_size,
            "mtime": file.stat().st_mtime,
            "kind": "video" if file.suffix.lower() in {".mp4", ".webm", ".mov", ".mkv"} else "image",
        } for file in found[:limit]]
        return web.json_response({"ok": True, "items": items})
    except Exception as error:  # noqa: BLE001
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(error)}, status=500)


@PromptServer.instance.routes.post("/easy-media/agent/step")
async def handle_agent_step(request: web.Request) -> web.Response:
    """单步工具调用：返回 {text, tool_calls}；工具在前端执行。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "payload must be an object"}, status=400)
        result = await run_agent_step(
            payload.get("messages") if isinstance(payload.get("messages"), list) else [],
            payload.get("context") if isinstance(payload.get("context"), dict) else {},
            payload.get("tools") if isinstance(payload.get("tools"), list) else None,
            None,
            str(payload.get("system_extra") or ""),
        )
        return web.json_response({"ok": True, **result})
    except Exception as error:  # noqa: BLE001
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.post("/easy-media/agent/chat")
async def handle_agent_chat(request: web.Request) -> web.StreamResponse:
    """项目智能体：SSE 推送决策、工具执行过程与产物（plan / action / text）。"""
    try:
        payload = await request.json()
    except Exception as error:  # noqa: BLE001
        return web.json_response({"ok": False, "error": f"invalid json: {error}"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"ok": False, "error": "payload must be an object"}, status=400)
    messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}

    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
    await response.prepare(request)
    try:
        async for chunk in run_agent(messages, context, None, str(payload.get("system_extra") or "")):
            await response.write(chunk.encode("utf-8"))
    except Exception as error:  # noqa: BLE001
        traceback.print_exc()
        try:
            import json as _json

            await response.write(
                ("data: " + _json.dumps({"type": "error", "message": str(error)}, ensure_ascii=False) + "\n\n").encode("utf-8")
            )
        except Exception:  # noqa: BLE001
            pass
    await response.write_eof()
    return response


@PromptServer.instance.routes.post("/easy-media/prompt-studio/plan/parse")
async def handle_prompt_studio_plan_parse(request: web.Request) -> web.Response:
    """文本分镜（曜石格式）→ 结构化分镜。"""
    try:
        payload = await request.json()
        source = str((payload or {}).get("text") or "")
        frame_rate = float((payload or {}).get("frame_rate") or 30)
        plan = parse_storyboard_text(source, frame_rate=frame_rate)
        return web.json_response({"ok": True, "plan": plan})
    except PlanError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except Exception as error:
        traceback.print_exc()
        return web.json_response(
            {"ok": False, "error": f"Failed to parse storyboard: {error}"}, status=500
        )


@PromptServer.instance.routes.post("/easy-media/prompt-studio/plan/export")
async def handle_prompt_studio_plan_export(request: web.Request) -> web.Response:
    """结构化分镜 → 文本分镜（曜石格式）。"""
    try:
        payload = await request.json()
        plan = (payload or {}).get("plan") or {}
        return web.json_response({"ok": True, "text": render_storyboard_text(plan)})
    except Exception as error:
        traceback.print_exc()
        return web.json_response(
            {"ok": False, "error": f"Failed to export storyboard: {error}"}, status=500
        )

_INPUT_KIND_EXT = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"},
    "audio": {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"},
    "video": {".mp4", ".webm", ".mov", ".mkv", ".avi"},
}


def _classify_input_file(suffix: str) -> str | None:
    lowered = suffix.lower()
    for kind, extensions in _INPUT_KIND_EXT.items():
        if lowered in extensions:
            return kind
    return None


@PromptServer.instance.routes.get("/easy-media/resources/input")
async def handle_resources_input(request: web.Request) -> web.Response:
    """列出 ComfyUI 共享资源（input/output/temp，只读）。

    查询参数：
      root   = input | output | temp（白名单，默认 input）
      dir    = 子目录（相对 root，浏览模式用）
      mode   = flat（递归全部文件，默认）| browse（只看当前目录，返回 folders）
      kind   = all | image | audio | video
      query / sort / limit / offset
    """
    try:
        from urllib.parse import quote

        root = str(request.query.get("root") or "input").lower()
        if root not in ("input", "output", "temp"):
            root = "input"
        mode = str(request.query.get("mode") or "flat").lower()
        if mode in ("folders", "browse", "dir"):
            mode = "browse"
        sub_dir = str(request.query.get("dir") or "").strip().strip("/\\")
        kind = str(request.query.get("kind") or "all").lower()
        query = str(request.query.get("query") or "").strip().lower()
        sort = str(request.query.get("sort") or "name").lower()
        try:
            limit = min(2000, max(1, int(request.query.get("limit") or 600)))
        except (TypeError, ValueError):
            limit = 600
        try:
            offset = max(0, int(request.query.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0

        if root == "input":
            base = Path(folder_paths.get_input_directory())
        elif root == "output":
            base = Path(folder_paths.get_output_directory())
        else:
            base = Path(folder_paths.get_temp_directory())
        base = base.resolve()

        current = (base / sub_dir).resolve() if sub_dir else base
        if not str(current).startswith(str(base)) or not current.is_dir():
            current = base
            sub_dir = ""

        def _url(name: str, subfolder: str) -> str:
            url = f"/view?filename={quote(name)}&type={root}"
            if subfolder:
                url += f"&subfolder={quote(subfolder)}"
            return url

        def _rel_subfolder(path: Path) -> str:
            relative = path.relative_to(base)
            return "" if len(relative.parts) == 1 else "/".join(relative.parts[:-1])

        items: list[dict] = []
        folders: list[dict] = []

        if mode == "browse":
            for child in sorted(current.iterdir(), key=lambda entry: entry.name.lower()):
                if child.is_dir():
                    folders.append({
                        "name": child.name,
                        "path": (f"{sub_dir}/{child.name}" if sub_dir else child.name),
                    })
            files: list[tuple[float, str, Path]] = []
            for child in current.iterdir():
                if not child.is_file():
                    continue
                file_kind = _classify_input_file(child.suffix)
                if file_kind is None:
                    continue
                if kind != "all" and file_kind != kind:
                    continue
                if query and query not in child.name.lower():
                    continue
                files.append((child.stat().st_mtime, child.name.lower(), child))
            if sort in ("time", "time_desc", "latest"):
                files.sort(key=lambda entry: entry[0], reverse=True)
            else:
                files.sort(key=lambda entry: entry[1])
            for mtime, _key, child in files[offset:offset + limit]:
                items.append({
                    "name": child.name,
                    "subfolder": _rel_subfolder(child),
                    "kind": _classify_input_file(child.suffix) or "image",
                    "size": child.stat().st_size,
                    "mtime": int(mtime),
                    "url": _url(child.name, _rel_subfolder(child)),
                    "root": root,
                })
            return web.json_response({
                "ok": True,
                "items": items,
                "folders": folders,
                "root": root,
                "dir": sub_dir,
                "mode": mode,
                "total": len(items),
                "offset": offset,
                "limit": limit,
            })

        collected: list[tuple[float, str, Path, Path]] = []
        if current.is_dir():
            for path in sorted(current.rglob("*")):
                if not path.is_file():
                    continue
                relative = path.relative_to(base)
                if len(relative.parts) > 5:
                    continue
                file_kind = _classify_input_file(path.suffix)
                if file_kind is None:
                    continue
                if kind != "all" and file_kind != kind:
                    continue
                if query and query not in path.name.lower():
                    continue
                collected.append((path.stat().st_mtime, path.name.lower(), path, relative))

        if sort in ("time", "time_desc", "latest"):
            collected.sort(key=lambda entry: entry[0], reverse=True)
        else:
            collected.sort(key=lambda entry: entry[1])

        for mtime, _name_key, path, relative in collected[offset:offset + limit]:
            subfolder = "" if len(relative.parts) == 1 else "/".join(relative.parts[:-1])
            items.append({
                "name": path.name,
                "subfolder": subfolder,
                "kind": _classify_input_file(path.suffix) or "image",
                "size": path.stat().st_size,
                "mtime": int(mtime),
                "url": _url(path.name, subfolder),
                "root": root,
            })
        return web.json_response({
            "ok": True,
            "items": items,
            "folders": [],
            "root": root,
            "dir": sub_dir,
            "mode": mode,
            "total": len(collected),
            "offset": offset,
            "limit": limit,
        })
    except Exception as error:
        traceback.print_exc()
        return web.json_response(
            {"ok": False, "error": f"Failed to scan shared resources: {error}"}, status=500
        )


