"""主体库节点（EasyMedia 本地新增节点 / Deciia）。

用途
----
定义可复用的「命名主体」：每个主体绑定一个参考资源（input 相对路径），并附带
描述、职责、保留策略与是否随引用自动追加。输出 ``SUBJECT_CONFIG``，接到
「多轨编辑器」的可选输入 ``subject_config`` 上即可在提示词里用 ``@名字`` 引用。

设计要点
--------
* 主体**不保存编号**：``<Picture n>`` 由任务段内 ``content.images`` 的顺序决定。
* 不接本节点、不引用主体时，编辑器行为与原来完全一致（零侵入）。
* 兼容 RefDirector 的 ``{"subject_data": {"subjects": [...]}}`` 结构（只取主体字段）。

参考设计文档：D:\\workspace\\docs\\easymedia-subject-prompt-compose-spec.md
"""

from __future__ import annotations

import json

from comfy_api.latest import io

from ..utils.h3_subjects import (
    SUBJECT_CONFIG_TYPE,
    dump_subject_config,
    parse_subject_config_document,
    validate_subject_name,
)

SubjectConfig = io.Custom(SUBJECT_CONFIG_TYPE)
# 卡片面板用的自定义 widget（前端在 getCustomWidgets 里注册 SUBJECT_DATA）
SubjectData = io.Custom("SUBJECT_DATA")

try:  # 与多轨编辑器同分类；导入失败时退回文本分类名
    from .basic import CATEGORY_MULTITRACK as _CATEGORY
except Exception:  # pragma: no cover
    _CATEGORY = "EasyUse/MultiTrackEditor"

DEFAULT_SUBJECT_DATA = json.dumps({"subjects": []}, ensure_ascii=False)


class SubjectLibrary(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy subjectLibrary",
            display_name="主体库 / Subject Library",
            category=_CATEGORY,
            description=(
                "定义命名主体（名字 / 绑定资源 / 描述 / 职责 / 保留策略），输出 SUBJECT_CONFIG。"
                "接到多轨编辑器的 subject_config 输入后，段提示词里写 @名字 即可引用；"
                "不接则编辑器行为完全不变。主体不保存编号，编号由任务段内资源顺序决定。"
            ),
            inputs=[
                SubjectData.Input(
                    "subject_data",
                    tooltip=(
                        "主体数据（卡片面板自动管理）。每个主体绑定 input 相对路径，"
                        "可写描述、职责、保留策略与是否随引用自动追加。"
                    ),
                ),
            ],
            outputs=[
                SubjectConfig.Output(
                    display_name="主体配置 / Subject config",
                    tooltip="接到「多轨编辑器」的 subject_config 输入。",
                ),
            ],
        )

    @classmethod
    def execute(cls, subject_data: object = DEFAULT_SUBJECT_DATA) -> io.NodeOutput:
        document = parse_subject_config_document(subject_data)
        subjects = document["subjects"]
        problems: list[str] = []
        for subject in subjects:
            error = validate_subject_name(subject["name"])
            if error:
                problems.append(f"{subject['name']}: {error}")
            if not subject["resource"]["path"]:
                problems.append(f"{subject['name']}: 未绑定资源")
        config = dump_subject_config(subjects)
        config["global_prompt"] = document["global_prompt"]
        config["problems"] = problems
        config["count"] = len(subjects)
        if problems:
            print(f"[EasyMedia] subjectLibrary 校验提示: {problems}", flush=True)
        return io.NodeOutput(config)
