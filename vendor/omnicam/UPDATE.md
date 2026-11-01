# Vendored OmniCam 更新流程

EasyMedia 内置了一份 OmniCam 引擎与前端资源（MIT，见 `LICENSE` / `NOTICE.md`）。
上游更新时**不要直接改 vendored 文件**，按下面顺序走，保证：
- EasyMedia 的生产链路随时可用
- 独立 OmniCam 插件仍可临时启用、独立正常使用

## 目录约定

```
custom_nodes/
  ComfyUI-Majoor-OmniCam.disabled/     ← 独立插件（升级目标，保持禁用）
  ComfyUI_Deciia_EasyMedia/
    vendor/omnicam/                    ← 本仓库内置副本（运行时不依赖独立插件）
    scripts/sync_omnicam.py            ← 同步脚本
```

## 标准流程

1. **升级独立插件（保持禁用）**
   ```powershell
   cd D:\ComfyUI-aki\ComfyUI-aki-v3.2\ComfyUI\custom_nodes\ComfyUI-Majoor-OmniCam.disabled
   git pull
   ```
   若目录不是 git 仓库，先删除后重新 clone 到 `.disabled` 名称。

2. **预览差异**
   ```powershell
   python scripts/sync_omnicam.py --dry-run
   ```

3. **同步到 EasyMedia**
   ```powershell
   python scripts/sync_omnicam.py
   ```
   同步范围：
   - `omnicam/core/`、`omnicam/guides/`
   - `omnicam/adapters/h3.py`、`h3_sections.py`
   - `omnicam/monitor/result.py`、`omnicam/profiles/base.py`
   - `web/`、`web-chunks/`（渲染器与编辑器 bundle）
   - `LICENSE`
   更新脚本会自动跳过 `__pycache__`。

4. **处理冲突**
   EasyMedia 对 vendored 文件的本地改动只允许集中在：
   - `vendor/omnicam/__init__.py`、`vendor/omnicam/adapters/__init__.py`（只导出 H3）
   - `vendor/omnicam/NOTICE.md`
   - 任何适配逻辑放到 `utils/camera_omnicam.py`，**不要改 vendored 源码**
   如果上游改了 `core`/`guides` 且与本地改动冲突，以**上游为准**，再把适配层改到新 API。

5. **冒烟测试**
   ```powershell
   # 相机编译接口
   curl -X POST http://127.0.0.1:8188/easy-media/camera/compile ^
        -H "Content-Type: application/json" ^
        -d "{\"camera\":{\"keyframes\":[{\"frame\":0,\"preset\":\"static\",\"easing\":\"linear\"},{\"frame\":119,\"preset\":\"push_in\",\"easing\":\"ease_in_out\"}]},\"fps\":24,\"frames\":120}"
   ```
   以及 P3a 多轨项目跑一段、确认相机提示词注入与生成正常。

6. **验证 OmniCam 独立可用（需要时）**
   把目录名改回去掉 `.disabled` 后缀，重启 ComfyUI，确认三个节点（Director / Extractor / Monitor）出现且能打开编辑器。
   **验证完再改回 `.disabled`**，避免与 EasyMedia 的相机功能重复入口、路由冲突。

## 版本记录

每次合并后在本文件底部记一行：日期 / OmniCam 版本 / 同步人 / 备注。

| 日期 | OmniCam 版本 | 备注 |
|---|---|---|
| 2026-11-02 | 0.4.1 | 初次 vendored（core/guides/adapters-h3/monitor/profiles + web/web-chunks） |
