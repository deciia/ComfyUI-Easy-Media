# -*- coding: utf-8 -*-
"""资源生成通道。

配置文件：<ComfyUI>/user/DeciiaEasyMedia/resource_workflows.json
结构：
{
  "image":    {"workflow": "路径/api.json", "output": "9", "inputs": {"6.text": "{{prompt}}", "5.width": 1024}},
  "voice":    {"workflow": "...", "output": "12", "inputs": {"3.text": "{{text}}", "4.audio": "{{reference_audio}}"}},
  "music":    {"workflow": "...", "output": "20", "inputs": {"7.prompt": "{{prompt}}", "8.duration": "{{duration}}"}},
  "refvideo": {"workflow": "...", "output": "30", "inputs": {"11.prompt": "{{prompt}}", "12.image": "{{reference_image}}"}}
}
inputs 的 key 是 "节点id.字段名"（API 格式里的 inputs 键），value 支持模板：
{{prompt}} {{text}} {{duration}} {{seed}} {{reference_image}} {{reference_audio}} {{negative}}，其余按字面量写入。
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

import folder_paths

try:
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None  # type: ignore


class ResourceGenError(ValueError):
    """资源生成失败。"""


_TYPES = ("image", "voice", "music", "refvideo")


def config_path() -> Path:
    base = Path(folder_paths.get_user_directory()) / "DeciiaEasyMedia"
    base.mkdir(parents=True, exist_ok=True)
    return base / "resource_workflows.json"


def load_config() -> dict:
    path = config_path()
    if not path.exists():
        return {"types": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as error:  # noqa: BLE001
        raise ResourceGenError(f"resource_workflows.json 解析失败：{error}") from error
    if not isinstance(data, dict):
        raise ResourceGenError("resource_workflows.json 必须是对象")
    data.setdefault("types", {})
    return data


def save_config(data: dict) -> None:
    if not isinstance(data, dict):
        raise ResourceGenError("配置必须是对象")
    config_path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _resolve_workflow_path(raw: str) -> Path:
    path = Path(str(raw)).expanduser()
    if not path.is_absolute():
        # 相对路径按 ComfyUI 工作流目录解析
        from folder_paths import get_user_directory

        path = Path(get_user_directory()) / "default" / "workflows" / path
    if not path.exists():
        raise ResourceGenError(f"工作流文件不存在：{path}")
    return path


def _apply_template(value: Any, params: dict) -> Any:
    if not isinstance(value, str):
        return value
    text = value
    for key, replacement in params.items():
        if replacement is None:
            continue
        text = text.replace("{{" + key + "}}", str(replacement))
    return text


def resolve_entry(entry: dict, params: dict) -> dict:
    """按 params.profile 选择档位；无档位则用顶层配置。"""
    profiles = entry.get("profiles")
    if isinstance(profiles, dict) and profiles:
        name = str(params.get("profile") or entry.get("default_profile") or "").strip()
        if not name:
            name = next(iter(profiles))
        profile = profiles.get(name)
        if not isinstance(profile, dict):
            raise ResourceGenError(f"没有该档位：{name}（可选：{', '.join(profiles)}）")
        merged = {**entry, **profile}
        merged.pop("profiles", None)
        return merged
    return entry


def build_prompt_payload(entry: dict, params: dict) -> dict:
    workflow_raw = entry.get("workflow")
    if not workflow_raw:
        raise ResourceGenError("该类型未配置 workflow")
    workflow = json.loads(_resolve_workflow_path(workflow_raw).read_text(encoding="utf-8"))
    if not isinstance(workflow, dict):
        raise ResourceGenError("工作流必须是 API 格式 JSON（导出时选 Export (API)）")
    inputs_map = dict(entry.get("inputs") or {})
    # 按次覆盖：params["inputs"] = {"246.prompt": "..."} 等
    runtime_inputs = params.get("inputs")
    if isinstance(runtime_inputs, dict):
        inputs_map.update(runtime_inputs)
    if not isinstance(inputs_map, dict):
        raise ResourceGenError("inputs 必须是对象")

    for dotted, value in inputs_map.items():
        node_id, _, field = str(dotted).partition(".")
        if not node_id or not field:
            raise ResourceGenError(f"inputs 键格式应为 节点id.字段名：{dotted}")
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            raise ResourceGenError(f"工作流里没有节点 {node_id}")
        node_inputs = node.setdefault("inputs", {})
        if isinstance(node_inputs, dict):
            resolved = _apply_template(value, params)
            # 空值（未传的参考图/参考音频等）不覆盖原工作流默认，避免把空串塞进 LoadImage
            if isinstance(resolved, str) and resolved.strip() == "" and isinstance(value, str) and "{{" in value:
                continue
            node_inputs[field] = resolved
    return workflow


async def generate_resource(resource_type: str, params: dict, timeout: float = 900.0) -> dict:
    if resource_type not in _TYPES:
        raise ResourceGenError(f"不支持的资源类型：{resource_type}（可选 {', '.join(_TYPES)}）")
    config = load_config()
    entry = (config.get("types") or {}).get(resource_type)
    if not isinstance(entry, dict):
        raise ResourceGenError(f"未配置 {resource_type} 的生成工作流，请先写 resource_workflows.json")
    entry = resolve_entry(entry, params or {})

    workflow = build_prompt_payload(entry, params or {})
    client_id = uuid.uuid4().hex

    import aiohttp

    server = PromptServer.instance if PromptServer is not None else None
    if server is None:
        raise ResourceGenError("PromptServer 未就绪")

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"http://127.0.0.1:{server.port}/prompt",
            json={"prompt": workflow, "client_id": client_id},
        ) as response:
            raw = await response.text()
            if response.status >= 400:
                raise ResourceGenError(f"提交失败（{response.status}）：{raw[:400]}")
            submitted = json.loads(raw)
        prompt_id = str(submitted.get("prompt_id") or "")
        if not prompt_id:
            raise ResourceGenError(f"提交未返回 prompt_id：{raw[:300]}")

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(2.0)
            async with session.get(f"http://127.0.0.1:{server.port}/history/{prompt_id}") as response:
                if response.status >= 400:
                    continue
                history = await response.json()
            entry_data = history.get(prompt_id)
            if not entry_data:
                continue
            status = entry_data.get("status") or {}
            if status.get("status_str") == "error":
                messages = json.dumps(status.get("messages") or [], ensure_ascii=False)[:400]
                raise ResourceGenError(f"生成失败：{messages}")
            outputs = entry_data.get("outputs") or {}
            submit_ts = time.time() - 5.0
            preferred_nodes = entry.get("outputs")
            if not isinstance(preferred_nodes, list):
                single = str(entry.get("output") or "").strip()
                preferred_nodes = [single] if single else []
            ordered = [str(node_id) for node_id in preferred_nodes if str(node_id) in outputs]
            ordered += [key for key in outputs if key not in ordered]
            def _root_dir(kind: str) -> Path:
                if kind == "input":
                    return Path(folder_paths.get_input_directory())
                if kind == "temp":
                    return Path(folder_paths.get_temp_directory())
                return Path(folder_paths.get_output_directory())

            def _scan_saved_files(kind_filter: set[str]) -> Path | None:
                """有些保存节点只把 temp 预览写进 history，正式文件落在 output 子目录：
                按 mtime 扫描一次，优先选文件名含本次 name 的最新文件。"""
                root = Path(folder_paths.get_output_directory())
                wanted = str(params.get("name") or "").strip()
                best: tuple[float, Path] | None = None
                try:
                    for candidate in root.rglob("*"):
                        if not candidate.is_file():
                            continue
                        if candidate.suffix.lower() not in kind_filter:
                            continue
                        try:
                            mtime = candidate.stat().st_mtime
                        except OSError:
                            continue
                        if mtime < submit_ts:
                            continue
                        score = mtime + (10.0 if wanted and wanted in candidate.name else 0.0)
                        if best is None or score > best[0]:
                            best = (score, candidate)
                except OSError:
                    return None
                return best[1] if best else None

            extension_sets = {
                "videos": {".mp4", ".webm", ".mov", ".mkv"},
                "gifs": {".gif", ".webp"},
                "images": {".png", ".jpg", ".jpeg", ".webp", ".bmp"},
                "audio": {".wav", ".mp3", ".m4a", ".flac"},
            }

            for node_id in ordered:
                node_output = outputs.get(node_id) or {}
                for key in ("videos", "gifs", "images", "audio"):
                    for item in node_output.get(key) or []:
                        filename = item.get("filename") or item.get("file_name")
                        if not filename:
                            continue
                        subfolder = str(item.get("subfolder") or "").replace("\\", "/")
                        kind = str(item.get("type") or "output")
                        if kind not in ("input", "temp", "output"):
                            kind = "output"
                        abs_path = _root_dir(kind) / subfolder / filename
                        saved = _scan_saved_files(extension_sets.get(key, set()))
                        if saved is None and kind == "temp":
                            # 保存型节点：temp 预览先入 history，正式文件约 1 秒后才落盘
                            for _attempt in range(4):
                                await asyncio.sleep(1.0)
                                saved = _scan_saved_files(extension_sets.get(key, set()))
                                if saved is not None:
                                    break
                        if saved is not None:
                            try:
                                rel = saved.relative_to(Path(folder_paths.get_output_directory()))
                                return {
                                    "ok": True,
                                    "prompt_id": prompt_id,
                                    "file_name": saved.name,
                                    "subfolder": str(rel.parent).replace("\\", "/").lstrip("."),
                                    "root": "output",
                                    "path": str(saved),
                                    "kind": key,
                                    "history_preview": filename,
                                }
                            except ValueError:
                                pass
                        return {
                            "ok": True,
                            "prompt_id": prompt_id,
                            "file_name": filename,
                            "subfolder": subfolder,
                            "root": kind,
                            "path": str(abs_path),
                            "kind": key,
                        }
        raise ResourceGenError(f"生成超时（{int(timeout)}s 未完成）")
