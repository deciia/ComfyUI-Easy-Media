"""测试环境引导（仅为让 pytest 在没有运行中的 ComfyUI 时也能导入插件包）。

为什么需要：
    插件目录带有 ``__init__.py``，pytest（prepend/importlib 两种模式都一样）会把
    ``tests/test_*.py`` 当作 ``ComfyUI_Deciia_EasyMedia.tests.test_*`` 导入，
    于是必然执行插件 ``__init__.py`` → ``routes.py`` → 访问
    ``server.PromptServer.instance``。在没有启动 ComfyUI 的机器上该属性不存在，
    所有测试都会在 setup 阶段报 AttributeError。

本 conftest 做两件最小的事：
    1. 把 ComfyUI 根目录加入 sys.path（让 ``import server`` / ``comfy_api`` 等可解析）；
    2. 若 PromptServer 尚未创建实例，注入一个仅含 ``routes`` / ``sockets`` /
       ``send_sync`` 的占位实例，足以让插件完成导入期注册。

注意：只影响测试进程，不改变任何运行时行为。
"""

from __future__ import annotations

import sys
from pathlib import Path

COMFY_ROOT = Path(__file__).resolve().parents[3]  # tests -> 插件 -> custom_nodes -> ComfyUI
if (COMFY_ROOT / "server.py").is_file():
    for candidate in (str(COMFY_ROOT), str(COMFY_ROOT / "custom_nodes")):
        if candidate not in sys.path:
            sys.path.insert(0, candidate)

    try:  # 插件 __init__ 会从 server 导入 PromptServer
        from server import PromptServer  # type: ignore
    except Exception:  # noqa: BLE001 - 导入失败时交给 pytest 正常报错
        PromptServer = None  # type: ignore

    if PromptServer is not None and getattr(PromptServer, "instance", None) is None:
        from aiohttp import web  # type: ignore

        class _StubPromptServer:
            """仅满足插件导入期需要的占位实例。"""

            def __init__(self) -> None:
                self.app = web.Application()
                self.routes = web.RouteTableDef()
                self.sockets: dict = {}
                self.client_id = ""
                self.last_node_id = ""
                self.last_prompt_id = ""
                self.loop = None

            def send_sync(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
                return None

            def send(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
                return None

            async def send_sync_async(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
                return None

        PromptServer.instance = _StubPromptServer()  # type: ignore[attr-defined]
