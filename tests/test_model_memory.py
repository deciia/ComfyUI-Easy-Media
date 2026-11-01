from pathlib import Path
import importlib.util
import sys
import types

import pytest


spec = importlib.util.spec_from_file_location(
    "easy_media_model_memory_for_tests",
    Path(__file__).resolve().parents[1] / "utils" / "model_memory.py",
)
model_memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model_memory)


def test_unload_comfyui_models_releases_models_before_collecting_and_emptying_cache(monkeypatch):
    calls = []
    comfy = types.ModuleType("comfy")
    comfy.model_management = types.SimpleNamespace(
        unload_all_models=lambda: calls.append("unload_models"),
        soft_empty_cache=lambda force=False: calls.append(("empty_cache", force)),
    )
    monkeypatch.setitem(sys.modules, "comfy", comfy)
    monkeypatch.setattr(model_memory.gc, "collect", lambda: calls.append("collect"))

    model_memory.unload_comfyui_models()

    assert calls == ["unload_models", "collect", ("empty_cache", True)]


@pytest.mark.parametrize("failing_step", ["unload_models", "collect", "empty_cache"])
def test_unload_comfyui_models_reports_cleanup_failure(monkeypatch, failing_step):
    calls = []

    def run_step(step):
        calls.append(step)
        if step == failing_step:
            raise RuntimeError(f"{step} failed")

    comfy = types.ModuleType("comfy")
    comfy.model_management = types.SimpleNamespace(
        unload_all_models=lambda: run_step("unload_models"),
        soft_empty_cache=lambda force=False: run_step("empty_cache"),
    )
    monkeypatch.setitem(sys.modules, "comfy", comfy)
    monkeypatch.setattr(model_memory.gc, "collect", lambda: run_step("collect"))

    with pytest.raises(RuntimeError, match=f"Failed to release ComfyUI model memory: {failing_step} failed") as error:
        model_memory.unload_comfyui_models()

    assert calls[-1] == failing_step
    assert isinstance(error.value.__cause__, RuntimeError)


def test_cleanup_model_memory_skips_mps_cache_when_backend_is_unavailable(monkeypatch):
    calls = []

    class FakeCuda:
        @staticmethod
        def is_available():
            return False

    class FakeMpsBackend:
        @staticmethod
        def is_available():
            return False

    class FakeBackends:
        mps = FakeMpsBackend()

    class FakeMps:
        @staticmethod
        def empty_cache():
            calls.append("mps_empty_cache")

    fake_torch = types.SimpleNamespace(
        cuda=FakeCuda(),
        backends=FakeBackends(),
        mps=FakeMps(),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    model_memory.cleanup_model_memory()

    assert calls == []
