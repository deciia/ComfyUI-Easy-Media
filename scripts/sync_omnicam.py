# -*- coding: utf-8 -*-
"""同步 OmniCam（禁用的独立插件）→ EasyMedia vendored 引擎/前端。

用法：
    python scripts/sync_omnicam.py            # 从 custom_nodes/ComfyUI-Majoor-OmniCam.disabled 同步
    python scripts/sync_omnicam.py --dry-run  # 只列出会变动的文件

流程（对应 UPDATE.md）：
1) 独立插件目录先升级到新版本（保持 .disabled，不参与加载）
2) 本脚本把 engine 子集与前端资源同步到 vendor/omnicam
3) 运行 node/接口冒烟测试，冲突文件人工合并
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
OMNICAM_DISABLED = PLUGIN.parent / "ComfyUI-Majoor-OmniCam.disabled"
VENDOR = PLUGIN / "vendor" / "omnicam"

ENGINE_DIRS = ("core", "guides")
ENGINE_FILES = (
    "adapters/h3.py",
    "adapters/h3_sections.py",
    "monitor/result.py",
    "profiles/base.py",
)
WEB_DIRS = ("web", "web-chunks")


def _copy(src: Path, dst: Path, dry_run: bool, changes: list[str]) -> None:
    if not src.exists():
        return
    if src.is_dir():
        for item in src.rglob("*"):
            if not item.is_file():
                continue
            if "__pycache__" in item.parts or item.suffix == ".pyc":
                continue
            rel = item.relative_to(src)
            target = dst / rel
            if target.exists() and filecmp.cmp(item, target, shallow=False):
                continue
            changes.append(str(rel))
            if not dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target)
    else:
        if dst.exists() and filecmp.cmp(src, dst, shallow=False):
            return
        changes.append(str(src.name))
        if not dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not OMNICAM_DISABLED.is_dir():
        print(f"找不到禁用的 OmniCam 插件：{OMNICAM_DISABLED}")
        return 1
    if not VENDOR.is_dir():
        print(f"找不到 vendored 目录：{VENDOR}")
        return 1

    changes: list[str] = []
    for name in ENGINE_DIRS:
        _copy(OMNICAM_DISABLED / "omnicam" / name, VENDOR / name, args.dry_run, changes)
    for rel in ENGINE_FILES:
        _copy(OMNICAM_DISABLED / "omnicam" / rel, VENDOR / rel, args.dry_run, changes)
    for name in WEB_DIRS:
        _copy(OMNICAM_DISABLED / name, VENDOR / name, args.dry_run, changes)
    _copy(OMNICAM_DISABLED / "LICENSE", VENDOR / "LICENSE", args.dry_run, changes)

    if not changes:
        print("已是最新，无文件变动。")
        return 0
    print(f"{'将' if args.dry_run else '已'}同步 {len(changes)} 个文件：")
    for path in changes[:200]:
        print("  -", path)
    if len(changes) > 200:
        print(f"  ... 其余 {len(changes) - 200} 个")
    if not args.dry_run:
        print("\n下一步：重启 ComfyUI，跑相机编译/预演冒烟测试；冲突文件人工合并后提交。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
