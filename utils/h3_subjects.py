"""主体库（subject library）与提示词确定性组装。

设计文档：D:\\workspace\\docs\\easymedia-subject-prompt-compose-spec.md

核心约定
--------
* 主体只保存**资源身份**（input 相对路径 + 可选 sha256），不保存编号；
  ``<Picture n>`` 的 n 由任务段内 ``content.images`` 中非静音项的顺序决定
  （契约见 PATCHES.md）。
* 组装是纯函数：不读盘、不发请求、不依赖 ComfyUI 运行环境，便于单元测试。
* 组装只**追加到资源列表末尾**，绝不重排既有编号。
* 任何解析不出来令牌都保留原文并给出 warning，绝不伪造编号。

本模块只处理图片/音频的引用；视频参考默认不自动追加（见设计文档）。
"""

from __future__ import annotations

import json
import re

SUBJECT_CONFIG_VERSION = 1

#: 与 RefDirector 使用同一个类型名，便于两边互连（输入侧做结构嗅探）。
SUBJECT_CONFIG_TYPE = "SUBJECT_CONFIG"

#: 图片数量上限与编辑器一致，追加时不得越界。
MAX_TASK_IMAGES = 9

RETENTION_VALUES = (
    "fully_preserved",
    "partially_preserved",
    "transferred",
    "reused",
    "reference",
)

#: 这些名字已被既有别名占用（@图片1 / <Picture 1> 等），主体不能叫这些。
RESERVED_NAME_RE = re.compile(
    r"^(图片|音频|视频|subject|picture|audio|video|shot)\s*\d+$",
    re.IGNORECASE,
)

#: @名字 / <@名字> / <#名字:台词>
_TOKEN_RE = re.compile(r"<#(?P<voice>[^:>]+):(?P<line>[^>]*)>|<@(?P<subj>[^>]+)>|@(?P<bare>[^\s@<>，,。.;；:：!?！？、()（）\[\]【】]+)")

_SHOT_RE = re.compile(r"\[Shot\s+(\d+)\]", re.IGNORECASE)


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize_name(name: object) -> str:
    """主体名规范化：去首尾空白、压缩内部空白。"""
    return re.sub(r"\s+", " ", _text(name))


def subject_name_key(name: object) -> str:
    return normalize_name(name).casefold()


def validate_subject_name(name: object) -> str | None:
    """返回错误码；None 表示合法。"""
    value = normalize_name(name)
    if not value:
        return "empty"
    if RESERVED_NAME_RE.match(value):
        return "reserved"
    if any(ch in value for ch in "<>@"):
        return "invalid_char"
    if len(value) > 32:
        return "too_long"
    return None


def normalize_subject(raw: object, *, index: int = 0) -> dict:
    """把单个主体条目规范化为内部结构（保留未知字段）。"""
    source = raw if isinstance(raw, dict) else {}
    kind = _text(source.get("kind") or source.get("type")).lower()
    if kind in {"picture", "image", "img"}:
        kind = "image"
    elif kind in {"movie"}:
        kind = "video"
    elif not kind:
        kind = "image"

    resource = source.get("resource") if isinstance(source.get("resource"), dict) else {}
    path = _text(resource.get("path") or source.get("path") or source.get("imageFile")
                 or source.get("audioFile") or source.get("videoFile"))
    sha = _text(resource.get("sha256") or source.get("sha256"))

    # 多资源：图片/音频/视频各自可挂一个（对齐 Ref 主体节点的「引用资源」区）
    resources: list[dict] = []
    raw_resources = source.get("resources")
    if isinstance(raw_resources, list):
        for item in raw_resources:
            if not isinstance(item, dict):
                continue
            item_kind = _text(item.get("kind") or item.get("type")).lower() or kind
            item_path = _text(item.get("path") or item.get("file") or item.get("file_path"))
            if not item_path:
                continue
            resources.append({
                "kind": item_kind,
                "path": item_path,
                "sha256": _text(item.get("sha256")),
            })

    name = normalize_name(source.get("name")) or f"subject{index + 1}"
    retention = _text(source.get("retention")).lower()
    if retention not in RETENTION_VALUES:
        retention = "fully_preserved"

    return {
        "id": _text(source.get("id")) or f"subj-{index + 1}",
        "name": name,
        "kind": kind,
        "resource": {"path": path, "sha256": sha},
        "resources": resources,
        "description": _text(source.get("description")),
        # Ref 节点的「保留描述」是独立字段（描述外观要保持什么），与定义描述分开存
        "retention_text": _text(source.get("retention_text") or source.get("keep_description")),
        "role": _text(source.get("role")),
        "relationship": _text(source.get("relationship")),
        "retention": retention,
        # 视频默认不自动追加（会改变 <Video n> 的时间结构语义）
        "auto_append": bool(source.get("auto_append", kind != "video")),
    }


def parse_subject_config(value: object) -> list[dict]:
    """解析主体配置，兼容多种来源。

    支持：None / JSON 字符串 / ``{"subjects": [...]}`` /
    ``{"subject_data": {"subjects": [...]}}``（RefDirector 的结构）/ 纯列表。
    """
    data = value
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
    if isinstance(data, list):
        raw_list = data
    elif isinstance(data, dict):
        nested = data.get("subject_data")
        if isinstance(nested, dict) and isinstance(nested.get("subjects"), list):
            raw_list = nested["subjects"]
        elif isinstance(data.get("subjects"), list):
            raw_list = data["subjects"]
        else:
            raw_list = []
    else:
        return []

    subjects: list[dict] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_list):
        subject = normalize_subject(raw, index=index)
        key = subject_name_key(subject["name"])
        if not key or key in seen:
            continue
        seen.add(key)
        subjects.append(subject)
    return subjects


def dump_subject_config(subjects: list[dict]) -> dict:
    return {"version": SUBJECT_CONFIG_VERSION, "subjects": subjects}


def parse_subject_config_document(value: object) -> dict:
    """解析完整文档：主体列表 + 全局提示词（对齐 Ref 主体节点）。"""
    data = value
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return {"subjects": [], "global_prompt": ""}
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return {"subjects": [], "global_prompt": ""}
    global_prompt = ""
    if isinstance(data, dict):
        global_prompt = _text(data.get("global_prompt"))
        nested = data.get("subject_data")
        if isinstance(nested, dict) and not global_prompt:
            global_prompt = _text(nested.get("global_prompt"))
    return {"subjects": parse_subject_config(data), "global_prompt": global_prompt}


# --------------------------------------------------------------------------- #
# 令牌解析
# --------------------------------------------------------------------------- #
def parse_tokens(prompt: str) -> list[dict]:
    """按出现顺序解析提示词中的主体令牌（去重，保留首次位置）。"""
    tokens: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for match in _TOKEN_RE.finditer(prompt or ""):
        if match.group("voice") is not None:
            name = normalize_name(match.group("voice"))
            key = ("voice", subject_name_key(name))
            entry = {"kind": "voice", "name": name, "line": _text(match.group("line")), "raw": match.group(0)}
        else:
            name = normalize_name(match.group("subj") or match.group("bare"))
            key = ("subject", subject_name_key(name))
            entry = {"kind": "subject", "name": name, "line": "", "raw": match.group(0)}
        if not name or key in seen:
            continue
        seen.add(key)
        tokens.append(entry)
    return tokens


def _image_path_candidates(image: dict) -> list[str]:
    if not isinstance(image, dict):
        return []
    values = []
    for key in ("file_path", "local_path", "file_name", "url", "slot_name"):
        value = _text(image.get(key))
        if value:
            values.append(value.replace("\\", "/"))
    content = image.get("content")
    if isinstance(content, dict):
        for key in ("file_path", "local_path", "file_name", "url"):
            value = _text(content.get(key))
            if value:
                values.append(value.replace("\\", "/"))
    return values


def image_matches(image: dict, path: str) -> bool:
    target = (path or "").replace("\\", "/").strip().lower()
    if not target:
        return False
    basename = target.rsplit("/", 1)[-1]
    for candidate in _image_path_candidates(image):
        normalized = candidate.strip().lower()
        if not normalized:
            continue
        if normalized == target or normalized.endswith("/" + target) or target.endswith("/" + normalized):
            return True
        if normalized.rsplit("/", 1)[-1] == basename:
            return True
    return False


def is_muted_image(image: dict) -> bool:
    return isinstance(image, dict) and image.get("muted") is True


def picture_number_map(images: list) -> list[tuple[int, dict]]:
    """返回 [(编号从 1 开始, image)]，只统计非静音项（与编号契约一致）。"""
    numbered: list[tuple[int, dict]] = []
    for image in images if isinstance(images, list) else []:
        if not isinstance(image, dict) or is_muted_image(image):
            continue
        numbered.append((len(numbered) + 1, image))
    return numbered


# --------------------------------------------------------------------------- #
# 组装
# --------------------------------------------------------------------------- #
def _subject_block(subject: dict, label: str) -> str:
    role = subject.get("role") or subject.get("description") or ""
    description = subject.get("description") or ""
    if role and description and role not in description:
        body = f"{role}: {description}"
    else:
        body = description or role
    return f"{label} is {body}" if body else f"{label}"


def _retention_block(subject: dict, label: str, shots: list[int]) -> str:
    shot_text = ", ".join(f"[Shot {shot}]" for shot in shots) if shots else ""
    prefix = f"{label} (appears in {shot_text})" if shot_text else label
    detail = subject.get("role") or subject.get("description") or ""
    suffix = f" - {detail}" if detail else ""
    return f"{prefix}: {subject.get('retention', 'fully_preserved')}{suffix}"


def _append_images(content: dict, subjects: list[dict], warnings: list[str]) -> list[dict]:
    """把被引用主体的图片追加到段内 images 末尾，返回追加报告。"""
    images = content.get("images")
    if not isinstance(images, list):
        images = []
        content["images"] = images

    appended: list[dict] = []
    for subject in subjects:
        resource_path = subject["resource"]["path"]
        if subject["kind"] != "image":
            warnings.append(f"主体「{subject['name']}」不是图片，本版不自动追加")
            continue
        if not subject.get("auto_append", True):
            continue
        if not resource_path:
            warnings.append(f"主体「{subject['name']}」没有绑定资源")
            continue
        if any(image_matches(image, resource_path) for image in images if isinstance(image, dict)):
            continue
        if len(picture_number_map(images)) >= MAX_TASK_IMAGES:
            warnings.append(f"主体「{subject['name']}」未追加：图片已达上限 {MAX_TASK_IMAGES}")
            continue
        entry = {
            "source_type": "input",
            "file_path": resource_path,
            "subject_ref": subject["id"],
        }
        if subject["resource"].get("sha256"):
            entry["sha256"] = subject["resource"]["sha256"]
        images.append(entry)
        appended.append({"name": subject["name"], "path": resource_path})
    return appended


def _expand_tokens(prompt: str, labels: dict[str, str], warnings: list[str]) -> str:
    def replace(match: re.Match) -> str:
        if match.group("voice") is not None:
            name = normalize_name(match.group("voice"))
            line = _text(match.group("line"))
            label = labels.get(subject_name_key(name))
            if not label:
                warnings.append(f"未解析令牌「{match.group(0)}」：主体不存在或未引用")
                return match.group(0)
            return f"{label} <d>[Chinese] {line}</d>" if line else label
        name = normalize_name(match.group("subj") or match.group("bare"))
        label = labels.get(subject_name_key(name))
        if not label:
            warnings.append(f"未解析令牌「{match.group(0)}」：主体不存在或未引用")
            return match.group(0)
        return label

    return _TOKEN_RE.sub(replace, prompt)


def compose_segment(
    content: dict,
    subjects: list[dict],
    *,
    apply_append: bool = True,
) -> tuple[dict, dict]:
    """对单个任务段执行：令牌解析 + 自动追加 + 生成定义/保留段落。

    ``content`` 会被就地修改（仅限 ``images`` 与 ``user_prompt``），并返回报告。
    """
    warnings: list[str] = []
    prompt = _text(content.get("user_prompt")) or _text(content.get("user_brief"))
    tokens = parse_tokens(prompt)

    by_key = {subject_name_key(subject["name"]): subject for subject in subjects}
    referenced: list[dict] = []
    for token in tokens:
        subject = by_key.get(subject_name_key(token["name"]))
        if subject is None:
            warnings.append(f"未解析令牌「{token['raw']}」：主体库中没有「{token['name']}」")
            continue
        if subject not in referenced:
            referenced.append(subject)

    appended = _append_images(content, referenced, warnings) if apply_append else []

    # 用「追加后」的真实顺序计算编号
    labels: dict[str, str] = {}
    labels_for_report: dict[str, str] = {}
    for number, image in picture_number_map(content.get("images", [])):
        for subject in referenced:
            if image_matches(image, subject["resource"]["path"]):
                label = f"<Picture {number}>"
                labels.setdefault(subject_name_key(subject["name"]), label)
                labels_for_report[subject["name"]] = label

    expanded = _expand_tokens(prompt, labels, warnings)

    shots = sorted({int(match.group(1)) for match in _SHOT_RE.finditer(expanded)})
    definitions: list[str] = []
    retentions: list[str] = []
    for subject in referenced:
        label = labels.get(subject_name_key(subject["name"]))
        if not label:
            continue
        definitions.append(_subject_block(subject, label))
        retentions.append(_retention_block(subject, label, shots))

    composed = expanded
    if definitions:
        lower = expanded.lower()
        blocks: list[str] = []
        if "subject_definitions" not in lower:
            blocks.append("subject_definitions:\n" + "\n".join(definitions))
        if "retention_analysis" not in lower:
            blocks.append("retention_analysis:\n" + "\n".join(retentions))
        if blocks:
            composed = "\n\n".join(blocks) + "\n\n" + expanded

    if composed != prompt:
        content["user_prompt"] = composed

    report = {
        "tokens": [
            {
                "name": token["name"],
                "kind": token["kind"],
                "resolved": labels.get(subject_name_key(token["name"]), ""),
            }
            for token in tokens
        ],
        "numbers": labels_for_report,
        "appended": appended,
        "unused_subjects": [
            subject["name"] for subject in subjects if subject not in referenced
        ],
        "warnings": warnings,
    }
    return content, report


def compose_timeline(data: dict, subjects: list[dict], *, apply_append: bool = True) -> tuple[dict, list[dict]]:
    """对整个 track_data 的所有任务段执行组装，返回 (data, 报告列表)。"""
    reports: list[dict] = []
    if not isinstance(data, dict) or not subjects:
        return data, reports
    tracks = data.get("tracks")
    if not isinstance(tracks, list):
        return data, reports
    for track in tracks:
        if not isinstance(track, dict) or track.get("type") != "task":
            continue
        for segment in track.get("segments", []) or []:
            if not isinstance(segment, dict):
                continue
            content = segment.get("content")
            if not isinstance(content, dict):
                continue
            _, report = compose_segment(content, subjects, apply_append=apply_append)
            if report["tokens"] or report["appended"]:
                report["segment_id"] = segment.get("id")
                reports.append(report)
    return data, reports
