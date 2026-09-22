# 上游基线

- 来源: https://github.com/yolain/ComfyUI-Easy-Media
- 基线 commit: 1191d43 (2026-09-21, feat: add max_limit to easy multiImagesLoader)
- 本目录为其本地 fork，仅本地使用，不发布。
- 上游更新时由用户手动发起，按 PATCHES.md 重放自定义改动。

## 跟进官方流程(固化为标准动作)

remote 布局:
- origin = deciia/ComfyUI-Easy-Media (我们的独立版本, push 到这)
- upstream = yolain/ComfyUI-Easy-Media (官方, 只 fetch 不 push)

跟进步骤(上游有新提交时):
1. git fetch upstream main
2. git merge upstream/main  (dist/ 构建产物冲突时: checkout --theirs 后重跑 bun run build:release)
3. py_compile 全量 + /object_info 节点数 + 直通回归(API 提交 Stage(shot)→Artifact, 验 manifest context_cut=True + staging 规格)
4. git push origin main
5. PATCHES.md 若有新增挂点, 同步登记

## 本地目录与 git 关系
- 本目录 ComfyUI_Deciia_EasyMedia = git 工作区(直接改直接生效, ComfyUI 读的是工作区文件)
- 备份快照在 D:\workspace\_node_backups\ (不走 git)
