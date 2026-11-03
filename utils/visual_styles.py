"""视觉风格适配器：读取本机 T8 插件资源（只读、不复制），无则用自建风格兜底。

授权说明：T8 插件为 All rights reserved，禁止复制/再分发其资源；
本模块只在运行时读取用户本机已安装的 T8 资源，仓库内不包含其任何数据。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# 自建兜底风格（我们自己撰写，非 T8 数据）
BUILTIN_FILE = Path(__file__).resolve().parent.parent / "data" / "visual_styles" / "builtin.json"

DIMENSION_LABELS = {
    "framing": "构图",
    "camera": "机位/运镜",
    "staging": "调度",
    "rhythm": "节奏",
    "information": "信息释放",
    "editing": "剪辑",
}

MODES = {
    "off": "关闭",
    "on": "开启",
    "experimental": "开启（H3 强化）",
}

SCOPES = {
    "color_only": "仅色彩",
    "color_and_light": "色彩 + 光影",
}


def _custom_nodes_roots() -> list[Path]:
    """候选 custom_nodes 目录（当前插件所在目录的父目录优先）。"""
    roots: list[Path] = []
    here = Path(__file__).resolve()
    for parent in here.parents:
        if parent.name == "custom_nodes":
            roots.append(parent)
            break
    env_root = os.environ.get("COMFYUI_CUSTOM_NODES", "").strip()
    if env_root:
        roots.append(Path(env_root))
    return roots


def t8_style_root() -> Path | None:
    """本机 T8 插件视觉风格资源目录；不存在则返回 None。"""
    for root in _custom_nodes_roots():
        candidate = root / "comfyui-minimax-h3-prompt-enhancer-T8" / "resources" / "visual_styles"
        if (candidate / "catalog.json").is_file():
            return candidate
    return None


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def _builtin() -> dict[str, Any]:
    if not BUILTIN_FILE.is_file():
        return {"colors": [], "creators": []}
    try:
        data = _load_json(BUILTIN_FILE)
    except (OSError, json.JSONDecodeError):
        return {"colors": [], "creators": []}
    if not isinstance(data, dict):
        return {"colors": [], "creators": []}
    return {
        "colors": data.get("colors") if isinstance(data.get("colors"), list) else [],
        "creators": data.get("creators") if isinstance(data.get("creators"), list) else [],
    }


def _normalize_builtin(entries: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        style_id = str(item.get("id") or "").strip()
        if not style_id:
            continue
        out.append({
            "id": style_id,
            "label_zh": str(item.get("label_zh") or item.get("label") or style_id),
            "label_en": str(item.get("label_en") or item.get("label") or style_id),
            "category": str(item.get("category") or "自建风格"),
            "source": "builtin",
            "kind": kind,
            "summary_zh": str(item.get("summary_zh") or ""),
        })
    return out


def _t8_entries(kind: str) -> list[dict[str, Any]]:
    root = t8_style_root()
    if not root:
        return []
    try:
        catalog = _load_json(root / "catalog.json")
    except (OSError, json.JSONDecodeError):
        return []
    entries = catalog.get("entries") if isinstance(catalog, dict) else None
    if not isinstance(entries, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        style_id = str(entry.get("id") or "").strip()
        if not style_id:
            continue
        out.append({
            "id": style_id,
            "label_zh": str(entry.get("label_zh") or style_id),
            "label_en": str(entry.get("label_en") or style_id),
            "category": str(entry.get("category") or "T8 风格"),
            "source": "t8",
            "kind": kind,
            "summary_zh": "",
        })
    return out


def list_styles(kind: str, query: str = "", limit: int = 50) -> dict[str, Any]:
    """列出风格候选。kind = color | creator。"""
    if kind not in ("color", "creator"):
        return {"ok": False, "error": "kind 必须是 color 或 creator"}
    items = _t8_entries(kind)
    source = "t8" if items else "builtin"
    if not items:
        items = _normalize_builtin(_builtin().get("colors" if kind == "color" else "creators", []), kind)
    needle = query.strip().lower()
    if needle:
        items = [
            item for item in items
            if needle in item["label_zh"].lower()
            or needle in item["label_en"].lower()
            or needle in item["category"].lower()
            or needle in item["id"]
        ]
    total = len(items)
    try:
        cap = max(1, min(int(limit or 50), 200))
    except (TypeError, ValueError):
        cap = 50
    return {
        "ok": True,
        "kind": kind,
        "source": source,
        "total": total,
        "items": items[:cap],
        "truncated": total > cap,
    }


def _t8_resource(kind: str, style_id: str) -> dict[str, Any] | None:
    root = t8_style_root()
    if not root:
        return None
    folder = "colors" if kind == "color" else "creators"
    path = root / folder / f"{style_id}.json"
    if not path.is_file():
        return None
    try:
        data = _load_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _builtin_resource(kind: str, style_id: str) -> dict[str, Any] | None:
    entries = _builtin().get("colors" if kind == "color" else "creators", [])
    for item in entries:
        if isinstance(item, dict) and str(item.get("id")) == style_id:
            return item
    return None


def get_resource(kind: str, style_id: str) -> dict[str, Any] | None:
    if not style_id or style_id in ("none", "None", "未选择"):
        return None
    return _t8_resource(kind, style_id) or _builtin_resource(kind, style_id)


def _describe_color(data: dict[str, Any], scope: str) -> list[str]:
    lines: list[str] = []
    primary = data.get("primary") if isinstance(data.get("primary"), list) else []
    accents = data.get("accents") if isinstance(data.get("accents"), list) else []
    if primary:
        parts = []
        for item in primary[:6]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name_zh") or item.get("name_en") or "").strip()
            hex_value = str(item.get("hex") or "").strip()
            share = item.get("share")
            piece = f"{name} {hex_value}".strip()
            try:
                if share:
                    piece += f"（约 {int(round(float(share) * 100))}%）"
            except (TypeError, ValueError):
                pass
            if piece:
                parts.append(piece)
        if parts:
            lines.append("主色：" + "、".join(parts))
    if accents:
        parts = []
        for item in accents[:4]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name_zh") or item.get("name_en") or "").strip()
            hex_value = str(item.get("hex") or "").strip()
            piece = f"{name} {hex_value}".strip()
            if piece:
                parts.append(piece)
        if parts:
            lines.append("点缀色：" + "、".join(parts))
    notes = data.get("color_notes")
    if isinstance(notes, dict):
        note = str(notes.get("zh") or notes.get("en") or "").strip()
        if note:
            lines.append("色彩说明：" + note)
    if scope == "color_and_light":
        light = data.get("lighting_notes")
        if isinstance(light, dict):
            note = str(light.get("zh") or light.get("en") or "").strip()
            if note:
                lines.append("光影：" + note)
    return lines


def _describe_creator(data: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    methods = data.get("methods") if isinstance(data.get("methods"), list) else []
    grouped: dict[str, list[str]] = {}
    for item in methods:
        if not isinstance(item, dict):
            continue
        dimension = str(item.get("dimension") or "").strip()
        text = str(item.get("text_zh") or item.get("text_en") or "").strip()
        if not text:
            continue
        label = DIMENSION_LABELS.get(dimension, dimension or "其他")
        grouped.setdefault(label, []).append(text)
    for label, texts in grouped.items():
        lines.append(f"{label}：" + "；".join(texts[:3]))
    return lines


def _label(kind: str, style_id: str, data: dict[str, Any] | None) -> str:
    if isinstance(data, dict):
        name = str(data.get("label_zh") or data.get("label_en") or "").strip()
        if name:
            return name
    # 资源文件本身不带名称时，回 catalog / 自建清单里查
    for item in _t8_entries(kind) or _normalize_builtin(
        _builtin().get("colors" if kind == "color" else "creators", []), kind
    ):
        if item.get("id") == style_id:
            return str(item.get("label_zh") or item.get("label_en") or style_id)
    return style_id


def compile_instruction(
    color: str = "",
    creator: str = "",
    scope: str = "color_only",
    mode: str = "on",
) -> dict[str, Any]:
    """把选中的配色/导演方法编译成可直接附加到提示词的风格指令块。"""
    if mode == "off" or mode == "":
        return {"ok": True, "instruction": "", "color": None, "creator": None, "mode": mode or "off"}
    scope_key = scope if scope in SCOPES else "color_only"
    color_id = "" if color in ("", "none", "None") else str(color)
    creator_id = "" if creator in ("", "none", "None") else str(creator)
    color_data = get_resource("color", color_id) if color_id else None
    creator_data = get_resource("creator", creator_id) if creator_id else None
    if color_id and not color_data:
        return {"ok": False, "error": f"找不到配色 {color_id}"}
    if creator_id and not creator_data:
        return {"ok": False, "error": f"找不到导演方法 {creator_id}"}

    lines: list[str] = [
        "【视觉风格（可选呈现，不额外规划）】",
        "下面是用户为本次生成选定的视觉呈现参考。请在已有画面可行处落实，而不是当作背景元信息忽略；"
        "若画面已经具备对应特征，保留既有描述，不重复堆词。",
    ]
    applied: dict[str, Any] = {"color": None, "creator": None, "scope": scope_key}

    if color_data:
        name = _label("color", color_id, color_data)
        lines.append(f"配色参考《{name}》（{SCOPES[scope_key]}）：")
        for part in _describe_color(color_data, scope_key):
            lines.append(f"- {part}")
        applied["color"] = {"id": color_id, "name": name, "scope": scope_key}

    if creator_data:
        name = _label("creator", creator_id, creator_data)
        lines.append(f"导演方法参考《{name}》（拍法参考，不是编剧）：")
        for part in _describe_creator(creator_data):
            lines.append(f"- {part}")
        applied["creator"] = {"id": creator_id, "name": name}

    lines.append(
        "优先级与边界：用户给出的事实、台词原文与说话人、主体身份、素材角色、动作顺序、"
        "时长与镜头数、固定机位与结尾均为硬约束，不得为套风格而改动；"
        "分镜脚本里已明确的景别/运镜/构图以分镜为准，风格只能在其许可范围内调整色彩、光感与呈现方式。"
        "不得凭风格名新增情节、人物、地点或台词，不得改变原生输出语法与语言。"
    )
    lines.append("风格只是呈现层面的修饰：不替代表演指导，不改变声音来源与台词内容。")
    return {
        "ok": True,
        "mode": mode or "on",
        "scope": scope_key,
        "instruction": "\n".join(lines),
        "color": applied["color"],
        "creator": applied["creator"],
        "source": "t8" if t8_style_root() else "builtin",
    }
