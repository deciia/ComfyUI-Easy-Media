"""Deciia H3 T8 fork — Semantic Bridge。

来源: comfyui-minimax-h3-audio-T8 (t8star) h3_t8/semantic_bridge.py、
semantic_bridge_trans.py、semantic_bridge_profiles.py、nodes_semantic_bridge.py
（Config/Apply 两类），2026-10-04 摘取搬运。
仅改: 四文件合一并改内部导入；节点 id 改 easy deciia* 前缀；
model_paths/resolve_model 保留原实现；算法本体未改动。
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import threading
from pathlib import Path

import torch
from torch.nn import functional as F
from comfy_api.latest import io

import folder_paths

CATEGORY = "EasyUse/H3/T8fork"
BridgeIO = io.Custom("T8_SEMANTIC_BRIDGE")


# ── semantic_bridge_trans.py ──
"""Adapter for WushuBridge Transformer safetensors (text CONDITIONING only).

The module mirrors the trainer's inference architecture; it does not train or
convert weights. Model metadata and tensor shapes are checked before use.
"""


import torch
from torch import nn
from torch.nn import functional as F


@dataclass(frozen=True)
class TransSpec:
    hidden: int
    layers: int
    heads: int
    max_tokens: int
    residual_skip: bool
    residual_scale: float
    application_contract: dict | None


def spec_from_metadata(metadata: dict) -> TransSpec:
    if metadata.get("arch") != "trans" or int(metadata.get("dim", "0")) != 5120:
        raise ValueError("Expected a 5120-dimensional WushuBridge trans model")
    hidden = int(metadata.get("hidden", "0"))
    layers = int(metadata.get("layers", "0"))
    heads = int(metadata.get("heads", "0"))
    max_tokens = int(metadata.get("max_tokens", "4096"))
    scale = float(metadata.get("residual_scale", "0.1"))
    if (hidden < 64 or hidden > 1024 or layers < 1 or layers > 4 or heads < 1
            or heads > 16 or hidden % heads or max_tokens < 1 or max_tokens > 16384
            or not math.isfinite(scale) or not 0 < scale <= 1):
        raise ValueError("Unsupported WushuBridge trans architecture")
    skip = metadata.get("residual_skip", "False").lower()
    if skip not in ("true", "false"):
        raise ValueError("Invalid WushuBridge residual_skip metadata")
    extra = json.loads(metadata.get("extra_json", "{}"))
    if not isinstance(extra, dict):
        raise ValueError("Invalid WushuBridge extra_json metadata")
    contract = extra.get("application_contract")
    if contract is not None and not isinstance(contract, dict):
        raise ValueError("Invalid WushuBridge application contract")
    return TransSpec(hidden, layers, heads, max_tokens, skip == "true", scale, contract)


def validate_contract(spec: TransSpec | dict | None, *, alpha: float, magnitude_match: str,
                      token_scope: str, chunk_tokens: int) -> None:
    contract = spec.application_contract if isinstance(spec, TransSpec) else spec
    if contract is None:
        return
    contract_settings(contract)
    expected = {
        "schema": 1, "alpha_min": alpha, "alpha_max": alpha,
        "magnitude_match": magnitude_match,
        "token_span": "all" if token_scope == "all_tokens" else token_scope,
        "tail_ratio": 1.0, "chunk_tokens": chunk_tokens,
        "auto_alpha": False, "guard": False, "allow_dim_mismatch": False,
    }
    if any(contract.get(key) != value for key, value in expected.items()):
        raise ValueError("WushuBridge application contract mismatch: required "
                         f"alpha={contract.get('alpha_min')}, "
                         f"magnitude_match={contract.get('magnitude_match')}, "
                         f"token_scope=all_tokens, chunk_tokens={contract.get('chunk_tokens')}. "
                         "Use H3 Semantic Bridge / 自动模型参数 (T8 EXP), or set these values explicitly.")


def contract_settings(contract: dict) -> dict:
    """Only the trainer's supported fixed inference formula, never guessed defaults."""
    alpha = contract.get("alpha_min")
    if (type(contract.get("schema")) is not int or contract["schema"] != 1
            or type(alpha) not in (int, float) or not math.isfinite(alpha)
            or not 0 < alpha <= 1 or type(contract.get("alpha_max")) not in (int, float)
            or contract["alpha_max"] != alpha
            or contract.get("magnitude_match") != "per_token"
            or contract.get("token_span") != "all"
            or type(contract.get("tail_ratio")) not in (int, float) or contract["tail_ratio"] != 1
            or type(contract.get("chunk_tokens")) is not int or contract["chunk_tokens"] != 0
            or any(contract.get(key) is not False for key in ("auto_alpha", "guard", "allow_dim_mismatch"))):
        raise ValueError("Unsupported or incomplete Bridge fixed application contract")
    return {"alpha": float(alpha), "magnitude_match": "per_token",
            "token_scope": "all_tokens", "chunk_tokens": 0}


def _positions(length: int, hidden: int) -> torch.Tensor:
    positions = torch.arange(length, dtype=torch.float32).unsqueeze(1)
    divisor = torch.exp(torch.arange(0, hidden, 2, dtype=torch.float32)
                        * (-math.log(10000.0) / hidden))
    values = torch.zeros(length, hidden, dtype=torch.float32)
    values[:, 0::2] = torch.sin(positions * divisor)
    values[:, 1::2] = torch.cos(positions * divisor)[:, :values[:, 1::2].shape[1]]
    return values.unsqueeze(0)


class TransBridge(nn.Module):
    def __init__(self, spec: TransSpec):
        super().__init__()
        self.spec = spec
        self.in_proj = nn.Linear(5120, spec.hidden)
        self.register_buffer("_pe", _positions(spec.max_tokens, spec.hidden), persistent=False)
        layer = nn.TransformerEncoderLayer(
            d_model=spec.hidden, nhead=spec.heads, dim_feedforward=spec.hidden * 4,
            dropout=0.0, activation="gelu", batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=spec.layers,
                                             enable_nested_tensor=False)
        self.norm = nn.LayerNorm(spec.hidden)
        self.out_proj = nn.Linear(spec.hidden, 5120)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        encoded = self.in_proj(x)
        pe = self._pe
        if encoded.shape[1] > pe.shape[1]:
            pe = F.interpolate(pe.transpose(1, 2), size=encoded.shape[1],
                               mode="linear", align_corners=False).transpose(1, 2)
        encoded = encoded + pe[:, :encoded.shape[1]].to(device=x.device, dtype=x.dtype)
        correction = self.out_proj(self.norm(self.encoder(encoded)))
        return x + self.spec.residual_scale * correction if self.spec.residual_skip else correction


def build_trans_bridge(state: dict, metadata: dict) -> TransBridge:
    spec = spec_from_metadata(metadata)
    # Module initialization is overwritten by state; it must not consume the
    # caller's CPU noise RNG, including validation before an H3 sampling stage.
    with torch.random.fork_rng(devices=[]):
        model = TransBridge(spec)
    expected = {"net." + key for key in model.state_dict()}
    if set(state) != expected:
        raise ValueError("WushuBridge trans tensor keys do not match the declared architecture")
    for key, value in state.items():
        if (tuple(value.shape) != tuple(model.state_dict()[key[4:]].shape)
                or value.dtype not in (torch.float16, torch.bfloat16, torch.float32)
                or not torch.isfinite(value).all().item()):
            raise ValueError(f"Invalid WushuBridge trans tensor: {key}")
    model.load_state_dict({key[4:]: value for key, value in state.items()}, strict=True)
    return model.eval()


# ── semantic_bridge.py ──
"""Content-bound, opt-in H3 conditioning adapters. No import-time model/GPU work.

Independent implementation of the published 5120/512/512/5120 SiLU contract.
The adapters are not LoRAs. Ref/voice quality remains experimental.
"""


from torch.nn import functional as F

SCHEMA = "t8_semantic_bridge_v1"
RECEIPT_KEY = "t8_semantic_bridge"
SHAPES = {
    "fc1.weight": (512, 5120), "fc1.bias": (512,),
    "fc2.weight": (512, 512), "fc2.bias": (512,),
    "fc3.weight": (5120, 512), "fc3.bias": (5120,),
}
KNOWN_MODELS = {
    "ac0dc8ac05f545ebdee12e2fcebe4515b049f9cfd9558eb4887a9bf3fd6d562e": {
        "name": "Semantic Bridge v1", "repo": "speach1sdef178/MiniMax-H3-Semantic-Bridge",
        "revision": "b9fe58ba6f428d990a59f20f09f719c8fbc67f7d",
    },
    "983380be6bf790544dbfa9be1bbe42e60ea841c7b6f7c5aac668de9380ab277a": {
        "name": "BUNNY ActionLogic v1", "repo": "JOKER141/BUNNY_H3_Conditioning_Bridge",
        "revision": "658bfbb0c49f6e8f79d727c7d261efa9e3853893",
    },
}
_CACHE = OrderedDict()  # CPU FP32 only; a live caller holds its own strong reference.
_CACHE_LOCK = threading.RLock()
_MAX_FILE_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class _TransWeights:
    state: dict
    metadata: dict


@dataclass(frozen=True)
class _TrainerMLPWeights:
    state: dict
    spec: object


def _weight_metadata(data: bytes) -> dict:
    header_size = int.from_bytes(data[:8], "little")
    if header_size <= 0 or header_size > min(len(data) - 8, 1024 * 1024):
        raise ValueError("Invalid WushuBridge safetensors metadata header")
    header = json.loads(data[8:8 + header_size])
    if not isinstance(header, dict):
        raise ValueError("Invalid Bridge safetensors header")
    metadata = header.get("__metadata__", {})
    if not isinstance(metadata, dict):
        raise ValueError("Invalid WushuBridge safetensors metadata")
    return metadata


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def file_sha(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


@dataclass(frozen=True)
class BridgeConfig:
    path: str
    sha256: str
    alpha: float = 0.10
    magnitude_match: str = "per_token"
    token_scope: str = "all_tokens"
    device: str = "auto"
    chunk_tokens: int = 256
    enabled: bool = True
    compute_profile: str = "fp32"

    def __post_init__(self):
        if not math.isfinite(self.alpha) or not 0 <= self.alpha <= 1:
            raise ValueError("Bridge alpha must be finite and between 0 and 1")
        if self.magnitude_match not in ("per_token", "global", "none"):
            raise ValueError("Unknown Bridge magnitude_match")
        if self.token_scope not in ("all_tokens", "text_only_preserve_reference"):
            raise ValueError("Unknown Bridge token_scope")
        if self.device not in ("auto", "cpu", "cuda") or self.compute_profile != "fp32":
            raise ValueError("Unknown Bridge device/compute_profile")
        if type(self.chunk_tokens) is not int or not 0 <= self.chunk_tokens <= 65536:
            raise ValueError("Bridge chunk_tokens must be zero (whole sequence) or positive")

    @property
    def active(self):
        return self.enabled and self.alpha != 0

    def identity(self):
        if not self.active:
            return None
        values = asdict(self)
        values.pop("path")  # Portable cache/receipt, no private absolute path.
        return {"schema": SCHEMA, **values}


@dataclass(frozen=True)
class BridgeStack:
    """Explicit ordered stack, never inferred from serial Apply nodes."""
    bridges: tuple
    enabled: bool = True

    def __post_init__(self):
        if not isinstance(self.bridges, tuple) or not 1 <= len(self.bridges) <= 8:
            raise ValueError("A Semantic Bridge stack requires 1 to 8 explicit configurations")
        if any(not isinstance(item, BridgeConfig) for item in self.bridges):
            raise TypeError("Bridge stack entries must be individual Bridge configurations")
        active = [item.sha256 for item in self.bridges if item.active]
        if len(active) != len(set(active)):
            raise ValueError("The same Bridge content was selected twice; do not duplicate one model in a stack")

    @property
    def active(self):
        return self.enabled and any(item.active for item in self.bridges)

    def identity(self):
        if not self.active:
            return None
        return {"schema": "t8_semantic_bridge_stack_v1", "operation": "ordered_serial",
                "bridges": [item.identity() for item in self.bridges if item.active]}


def compose_bridges(first, second, enabled=True):
    entries = []
    for item in (first, second):
        if isinstance(item, BridgeStack):
            # A disabled input stack is a bypass, not permission to reactivate it.
            if item.active:
                entries.extend(item.bridges)
        elif isinstance(item, BridgeConfig):
            entries.append(item)
        else:
            raise TypeError("Expected individual or composed T8 Semantic Bridge configurations")
    if not entries:
        return BridgeStack((BridgeConfig("", "", enabled=False),), enabled=False)
    return BridgeStack(tuple(entries), enabled=enabled)


def bridge_identity(config):
    if config is None:
        return None
    if not isinstance(config, (BridgeConfig, BridgeStack)):
        raise TypeError("Expected T8 Semantic Bridge configuration")
    return config.identity()


def preflight_bridge(config):
    """Validate all active chain configs before any stage; never switch on continuation."""
    identity = bridge_identity(config)
    if identity is not None:
        if isinstance(config, BridgeStack):
            for item in config.bridges:
                preflight_bridge(item)
        else:
            state = _weights(config)
            if isinstance(state, (_TransWeights, _TrainerMLPWeights)):
                from .semantic_bridge_trans import spec_from_metadata, validate_contract
                spec = spec_from_metadata(state.metadata) if isinstance(state, _TransWeights) else state.spec
                validate_contract(spec.application_contract, alpha=config.alpha,
                    magnitude_match=config.magnitude_match, token_scope=config.token_scope,
                    chunk_tokens=config.chunk_tokens)
    return identity


def bridge_kwargs(config):
    return {"semantic_bridge": config} if bridge_identity(config) is not None else {}


def validate_weights(weights):
    if set(weights) != set(SHAPES):
        raise ValueError("Bridge requires exactly six fc1/fc2/fc3 weight/bias tensors")
    for key, shape in SHAPES.items():
        value = weights[key]
        if tuple(value.shape) != shape or value.dtype not in (torch.float16, torch.bfloat16, torch.float32):
            raise ValueError(f"Invalid Bridge tensor {key}: {tuple(value.shape)} {value.dtype}")
        if not torch.isfinite(value).all().item():
            raise ValueError(f"Non-finite Bridge tensor: {key}")


def _read_bridge_bytes(path, expected_sha=None):
    path = Path(path)
    if path.suffix.lower() != ".safetensors" or path.stat().st_size > _MAX_FILE_BYTES:
        raise ValueError("Expected a small Semantic Bridge .safetensors file")
    # Decode exactly the bytes hashed, so path replacement cannot mix identities.
    with path.open("rb") as stream:
        data = stream.read(_MAX_FILE_BYTES + 1)
    if len(data) > _MAX_FILE_BYTES:
        raise ValueError("Bridge file exceeds supported size")
    sha = hashlib.sha256(data).hexdigest()
    if expected_sha is not None and sha != expected_sha:
        raise ValueError("Bridge model content changed; re-execute the configuration node")
    return data, sha


def read_weights(path, expected_sha=None, *, include_metadata=False):
    from safetensors.torch import load

    data, sha = _read_bridge_bytes(path, expected_sha)
    metadata = _weight_metadata(data)
    weights = load(data)
    if "net.in_proj.weight" in weights:
        from .semantic_bridge_trans import build_trans_bridge
        build_trans_bridge(weights, metadata)
    elif "net.fc1.weight" in weights:
        from .semantic_bridge_mlp import validate_trainer_mlp
        validate_trainer_mlp(weights, metadata)
    else:
        validate_weights(weights)
    return (weights, sha, metadata) if include_metadata else (weights, sha)


def _weights(config):
    # Always rehash, including same-size/same-mtime replacement. No CUDA cache.
    if file_sha(config.path) != config.sha256:
        raise ValueError("Bridge model content changed; re-execute the configuration node")
    with _CACHE_LOCK:
        cached = _CACHE.get(config.sha256)
        if cached is None:
            state, _, metadata = read_weights(config.path, config.sha256, include_metadata=True)
            if "net.in_proj.weight" in state or "net.fc1.weight" in state:
                from .semantic_bridge_trans import spec_from_metadata
                from .semantic_bridge_mlp import validate_trainer_mlp
                if "net.in_proj.weight" in state:
                    spec_from_metadata(metadata)
                    cached = _TransWeights({name: tensor.float() for name, tensor in state.items()}, metadata)
                else:
                    spec = validate_trainer_mlp(state, metadata)
                    cached = _TrainerMLPWeights(
                        {name[4:]: tensor.float() for name, tensor in state.items()}, spec)
            else:
                cached = {name: tensor.float() for name, tensor in state.items()}
            _CACHE[config.sha256] = cached
            while len(_CACHE) > 2:
                _CACHE.popitem(last=False)
        _CACHE.move_to_end(config.sha256)
        return cached


def _tensor_sha(tensor):
    data = tensor.detach().contiguous().cpu()
    sha = hashlib.sha256(str((tuple(data.shape), data.dtype)).encode())
    sha.update(data.view(torch.uint8).numpy().tobytes())
    return sha.hexdigest()


def _project(h, weights):
    with torch.autocast(device_type=h.device.type, enabled=False):
        normalized = h / (h.square().mean(dim=-1, keepdim=True) + 1e-6).sqrt()
        first = F.silu(F.linear(normalized, weights["fc1.weight"], weights["fc1.bias"]))
        second = F.silu(F.linear(first, weights["fc2.weight"], weights["fc2.bias"]))
        return F.linear(second, weights["fc3.weight"], weights["fc3.bias"])


def _predict_mlp(h, weights, trainer_spec=None):
    projected = _project(h, weights)
    if trainer_spec is not None and trainer_spec.residual_skip:
        normalized = h / (h.square().mean(dim=-1, keepdim=True) + 1e-6).sqrt()
        return normalized + trainer_spec.residual_scale * projected
    return projected


def _apply_trans_bridge(conditioning, config, model, identity, cancel, encoding_source):
    """Apply the trainer's sequence-wide Transformer without flattening tokens."""
    outputs, receipts = [], []
    for native, metadata in conditioning:
        device = native.device if config.device == "auto" else torch.device(config.device)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("Bridge CUDA explicitly selected but CUDA is unavailable")
        model = model.to(device=device, dtype=torch.float32)
        h = native.to(device=device, dtype=torch.float32)
        pred = torch.empty_like(h)
        stride = config.chunk_tokens or h.shape[1]
        with torch.autocast(device_type=device.type, enabled=False):
            for start in range(0, h.shape[1], stride):
                cancel()
                segment = h[:, start:start + stride]
                normalized = segment / (segment.square().mean(dim=-1, keepdim=True) + 1e-6).sqrt()
                pred[:, start:start + stride] = model(normalized)
        if config.magnitude_match == "per_token":
            pred = pred * ((h.square().mean(-1, keepdim=True) + 1e-8).sqrt() /
                           (pred.square().mean(-1, keepdim=True) + 1e-8).sqrt())
        elif config.magnitude_match == "global":
            pred = pred * ((h.square().mean() + 1e-8).sqrt() /
                           (pred.square().mean() + 1e-8).sqrt())
        result = h + config.alpha * (pred - h)
        if config.token_scope == "text_only_preserve_reference":
            tags = metadata["minimax_token_tags"].to(device)
            result = torch.where((tags == 1)[None, :, None], result, h)
        output = result.to(device=native.device, dtype=native.dtype)
        if not torch.isfinite(output).all().item():
            raise ValueError("Non-finite Bridge output")
        receipt = {
            **identity, "encoding_source": encoding_source,
            "input_sha256": _tensor_sha(native), "output_sha256": _tensor_sha(output),
            "shape": list(native.shape), "dtype": str(native.dtype),
            "applied_tokens_per_batch": (int((metadata["minimax_token_tags"] == 1).sum().item())
                                         if config.token_scope != "all_tokens" else native.shape[1]),
            "reference_payload_present": bool(metadata.get("minimax_refs")),
        }
        receipt["receipt_sha256"] = digest(receipt)
        outputs.append([output, {**metadata, RECEIPT_KEY: receipt}])
        receipts.append(receipt)
    cancel()
    return outputs, {"enabled": True, "applied": True, "identity": identity, "items": receipts,
                     "quality": "experimental_not_human_qualified",
                     "warning": "Reference audio/singing can degrade; video quality requires actual A/B review."}


def _check_cancel():
    # Import at execution only; standalone converter/tests don't initialize CUDA.
    from comfy.model_management import throw_exception_if_processing_interrupted
    throw_exception_if_processing_interrupted()


@torch.inference_mode()
def apply_bridge(conditioning, config, *, encoding_source="external_unknown", cancel=None):
    identity = bridge_identity(config)
    if identity is None:
        return conditioning, {"enabled": False, "applied": False}
    cancel = cancel or _check_cancel
    if isinstance(config, BridgeStack):
        return _apply_stack(conditioning, config, encoding_source, cancel)
    if not isinstance(conditioning, (list, tuple)) or not conditioning:
        raise ValueError("Bridge requires non-empty CONDITIONING")
    # Validate every item before reading weights or producing output.
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) != 2 or not isinstance(item[1], dict):
            raise ValueError("Invalid CONDITIONING item")
        native, metadata = item
        if not isinstance(native, torch.Tensor) or native.ndim != 3 or native.shape[-1] != 5120:
            raise ValueError("Bridge expects raw H3 conditioning [B,T,5120], not projected embeds")
        if native.numel() == 0 or not native.is_floating_point() or not torch.isfinite(native).all().item():
            raise ValueError("Bridge input must contain non-empty finite floating point embeddings")
        if RECEIPT_KEY in metadata or metadata.get("sensenova_h3_distilled"):
            raise ValueError("Semantic Bridge already applied; use a fresh native encoding, do not stack bridges")
        if "minimax_prompt_relay_binding" in metadata or "t8_prompt_relay_binding_hash" in metadata:
            raise ValueError("Apply Bridge through the Prompt Relay optional input, before Relay binding")
        if config.token_scope == "text_only_preserve_reference":
            tags = metadata.get("minimax_token_tags")
            if not isinstance(tags, torch.Tensor) or tags.ndim != 1 or tags.numel() != native.shape[1]:
                raise ValueError("Text-only Bridge requires exact native minimax_token_tags")
            if not torch.all((tags == 0) | (tags == 1)).item():
                raise ValueError("Unknown native H3 token tags")
    cancel()
    state = _weights(config)
    if isinstance(state, _TransWeights):
        from .semantic_bridge_trans import build_trans_bridge, validate_contract
        model = build_trans_bridge(state.state, state.metadata)
        validate_contract(model.spec, alpha=config.alpha,
                          magnitude_match=config.magnitude_match,
                          token_scope=config.token_scope, chunk_tokens=config.chunk_tokens)
        return _apply_trans_bridge(conditioning, config, model, identity, cancel, encoding_source)
    trainer_spec = None
    if isinstance(state, _TrainerMLPWeights):
        from .semantic_bridge_trans import validate_contract
        trainer_spec = state.spec
        validate_contract(trainer_spec.application_contract, alpha=config.alpha,
                          magnitude_match=config.magnitude_match,
                          token_scope=config.token_scope, chunk_tokens=config.chunk_tokens)
        state = state.state
    outputs, receipts = [], []
    for native, metadata in conditioning:
        device = native.device if config.device == "auto" else torch.device(config.device)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("Bridge CUDA explicitly selected but CUDA is unavailable")
        # Scoped per-item weights, never globally retained on GPU.
        weights = {name: tensor.to(device=device) for name, tensor in state.items()}
        rows = native.reshape(-1, 5120)
        output = torch.empty_like(rows)
        global_scale = None
        if config.magnitude_match == "global":
            # Whole item statistics (all batches/tokens), not per-chunk matching.
            source_sum = torch.zeros((), dtype=torch.float64, device=device)
            target_sum = torch.zeros_like(source_sum)
            chunk_tokens = config.chunk_tokens or rows.shape[0]
            for start in range(0, rows.shape[0], chunk_tokens):
                cancel()
                h = rows[start:start + chunk_tokens].to(device=device, dtype=torch.float32)
                projected = _predict_mlp(h, weights, trainer_spec)
                source_sum += projected.double().square().sum()
                target_sum += h.double().square().sum()
            global_scale = ((target_sum / native.numel() + 1e-8) /
                            (source_sum / native.numel() + 1e-8)).sqrt().float()
        chunk_tokens = config.chunk_tokens or rows.shape[0]
        for start in range(0, rows.shape[0], chunk_tokens):
            cancel()
            h = rows[start:start + chunk_tokens].to(device=device, dtype=torch.float32)
            projected = _predict_mlp(h, weights, trainer_spec)
            if config.magnitude_match == "per_token":
                projected = projected * ((h.square().mean(-1, keepdim=True) + 1e-8).sqrt() /
                                         (projected.square().mean(-1, keepdim=True) + 1e-8).sqrt())
            elif global_scale is not None:
                projected = projected * global_scale
            result = h + config.alpha * (projected - h)
            if not torch.isfinite(result).all().item():
                raise ValueError("Non-finite Bridge output")
            output[start:start + chunk_tokens] = result.to(device=native.device, dtype=native.dtype)
        output = output.reshape_as(native)
        if config.token_scope == "text_only_preserve_reference":
            tags = metadata["minimax_token_tags"].to(native.device)
            output = torch.where((tags == 1)[None, :, None], output, native)
        if not torch.isfinite(output).all().item():
            raise ValueError("Bridge output overflows the original conditioning dtype")
        receipt = {
            **identity, "encoding_source": encoding_source,
            "input_sha256": _tensor_sha(native), "output_sha256": _tensor_sha(output),
            "shape": list(native.shape), "dtype": str(native.dtype),
            "applied_tokens_per_batch": (int((metadata["minimax_token_tags"] == 1).sum().item())
                                         if config.token_scope != "all_tokens" else native.shape[1]),
            "reference_payload_present": bool(metadata.get("minimax_refs")),
        }
        receipt["receipt_sha256"] = digest(receipt)
        outputs.append([output, {**metadata, RECEIPT_KEY: receipt}])
        receipts.append(receipt)
        del weights
    cancel()
    return outputs, {"enabled": True, "applied": True, "identity": identity, "items": receipts,
                     "quality": "experimental_not_human_qualified",
                     "warning": "Reference audio/singing can degrade; unchanged audio inputs do not prove generated audio quality."}


def _apply_stack(conditioning, config, encoding_source, cancel):
    if not isinstance(conditioning, (list, tuple)) or not conditioning:
        raise ValueError("Bridge requires non-empty CONDITIONING")
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) != 2 or not isinstance(item[1], dict):
            raise ValueError("Invalid CONDITIONING item")
        native, metadata = item
        if (not isinstance(native, torch.Tensor) or native.ndim != 3 or native.shape[-1] != 5120
                or not native.is_floating_point() or not native.numel() or not torch.isfinite(native).all().item()):
            raise ValueError("Bridge stack requires finite raw H3 conditioning [B,T,5120]")
        if RECEIPT_KEY in metadata or metadata.get("sensenova_h3_distilled"):
            raise ValueError("Semantic Bridge already applied; supply fresh native conditioning to the explicit stack")
        if "minimax_prompt_relay_binding" in metadata or "t8_prompt_relay_binding_hash" in metadata:
            raise ValueError("Apply the Bridge stack through the Prompt Relay optional input, before Relay binding")
        if any(stage.active and stage.token_scope == "text_only_preserve_reference" for stage in config.bridges):
            tags = metadata.get("minimax_token_tags")
            if (not isinstance(tags, torch.Tensor) or tags.ndim != 1 or tags.numel() != native.shape[1]
                    or not torch.all((tags == 0) | (tags == 1)).item()):
                raise ValueError("Text-only Bridge stack requires exact native minimax_token_tags")
    cancel()
    preflight_bridge(config)  # Every model/contract before applying the first stage.
    current, reports = conditioning, []
    for ordinal, stage in enumerate(item for item in config.bridges if item.active):
        # Strip only receipts created inside this explicit invocation; incoming
        # bridged/Relay-bound input above remains forbidden. Original metadata
        # and tensors are never mutated.
        fresh = [[native, {key: value for key, value in metadata.items() if key != RECEIPT_KEY}]
                 for native, metadata in current]
        current, report = apply_bridge(fresh, stage, encoding_source=f"{encoding_source}:stack={ordinal}", cancel=cancel)
        reports.append(report)
    outputs, receipts = [], []
    for index, ((original, metadata), (output, _)) in enumerate(zip(conditioning, current)):
        receipt = {**config.identity(), "encoding_source": encoding_source,
                   "input_sha256": _tensor_sha(original), "output_sha256": _tensor_sha(output),
                   "shape": list(original.shape), "dtype": str(original.dtype),
                   "stages": [report["items"][index] for report in reports]}
        receipt["receipt_sha256"] = digest(receipt)
        outputs.append([output, {**metadata, RECEIPT_KEY: receipt}])
        receipts.append(receipt)
    cancel()
    return outputs, {"enabled": True, "applied": True, "identity": config.identity(), "items": receipts,
                     "operation": "ordered_serial", "quality": "experimental_not_human_qualified",
                     "warning": "Bridge order is significant; this is not additive LoRA merging. "
                                "Multiple bridges can worsen picture/voice quality. Review a same-seed control."}


# ── semantic_bridge_profiles.py ──
"""Content/metadata-bound user presets. Filenames and architecture alone never select alpha."""


WUSHU_V1_SHA = "4b7a459aac43e066b9cd8d3f84f52b7d6c2777e7de05f35a3cb042abab889ebd"
COMIC_SHA = "d4303d77e1ff96b678484d891308eeeb261b919d9e6498610a2bb89f7aeaa9a9"
LEGACY_SETTINGS = {"alpha": .10, "magnitude_match": "per_token",
                   "token_scope": "all_tokens", "chunk_tokens": 256}


def inspect_bridge_profile(path, expected_sha=None):
    data, sha = _read_bridge_bytes(path, expected_sha)
    metadata = _weight_metadata(data)
    header_size = int.from_bytes(data[:8], "little")
    header = json.loads(data[8:8 + header_size])
    keys = set(header) - {"__metadata__"}
    settings = None
    contract = None
    name = "Unidentified trainer Bridge"
    source = "manual_required"
    if keys == set(SHAPES):
        for key, shape in SHAPES.items():
            if header[key].get("shape") != list(shape) or header[key].get("dtype") not in ("F16", "BF16", "F32"):
                raise ValueError("Invalid six-tensor Bridge header")
        settings, name, source = dict(LEGACY_SETTINGS), "Original/BUNNY six-tensor MLP", "legacy_defaults"
        arch = "legacy_mlp"
    elif "net.in_proj.weight" in keys:
        spec = spec_from_metadata(metadata)
        contract, arch = spec.application_contract, "trans"
    elif "net.fc1.weight" in keys and metadata.get("arch") == "mlp":
        extra = json.loads(metadata.get("extra_json", "{}"))
        if not isinstance(extra, dict):
            raise ValueError("Invalid trainer Bridge extra_json")
        contract, arch = extra.get("application_contract"), "trainer_mlp"
    else:
        raise ValueError("Unsupported Semantic Bridge weight format; do not select a LoRA, JEV or H3 checkpoint")
    if contract is not None:
        if not isinstance(contract, dict):
            raise ValueError("Invalid Bridge application contract")
        settings = contract_settings(contract)
        source, name = "fixed_model_metadata", "Trainer Bridge (fixed application contract)"
    if sha == COMIC_SHA:
        name = "T8 comic-combat"
        if contract is None:
            raise ValueError("Known comic-combat content is missing its fixed contract")
    elif sha == WUSHU_V1_SHA:
        name, source = "Wushu v1", "sha_pinned_author_recommendation"
        settings = {"alpha": .12, "magnitude_match": "per_token",
                    "token_scope": "all_tokens", "chunk_tokens": 0}
    return {"name": name, "architecture": arch, "sha256": sha, "settings": settings,
            "settings_source": source, "fixed_contract": contract,
            "note": "Presets are inference settings, not video/voice quality acceptance; no JEV guard or auto-alpha."}


def validate_profile_settings(profile, *, alpha, magnitude_match, token_scope, chunk_tokens):
    validate_contract(profile["fixed_contract"], alpha=alpha, magnitude_match=magnitude_match,
                      token_scope=token_scope, chunk_tokens=chunk_tokens)
    actual = {"alpha": alpha, "magnitude_match": magnitude_match,
              "token_scope": token_scope, "chunk_tokens": chunk_tokens}
    settings = profile["settings"]
    return (["Manual settings differ from this weight's recommended preset; use the automatic config "
             "for the preset. Transformer chunking changes cross-token context."]
            if settings is not None and settings != actual else [])


# ── nodes_semantic_bridge.py（节点壳）──
def model_paths():
    """Keep extra_model_paths entries and disambiguate duplicate relative names."""
    default = Path(folder_paths.models_dir) / "semantic_bridge"
    roots = [Path(path) for path in folder_paths.folder_names_and_paths.get("semantic_bridge", ([], set()))[0]]
    if default not in roots:
        roots.append(default)
    grouped = {}
    for root in roots:
        if root.is_dir():
            for path in sorted(root.rglob("*.safetensors")):
                if ".cache" not in path.relative_to(root).parts:
                    grouped.setdefault(path.relative_to(root).as_posix(), set()).add(str(path.resolve()))
    result = {}
    for name, paths in sorted(grouped.items()):
        for path in sorted(paths):
            label = name if len(paths) == 1 else f"{name} [{path}]"
            result[label] = path
    return result

def resolve_model(name):
    path = model_paths().get(name)
    if path is None:
        raise FileNotFoundError("Semantic Bridge model not found. Install an author .safetensors in models/semantic_bridge and refresh the list.")
    return path


class MiniMaxH3SemanticBridgeConfigT8(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy deciiaH3SemanticBridgeConfig",
            display_name="Deciia H3 Semantic Bridge / 模型与设置 (T8 EXP)",
            category=CATEGORY, is_experimental=True,
            description="手动参数，旧默认0.10不变。新手请用‘自动模型参数’节点按文件内容读取推荐值。动漫战斗固定1.0/per_token/all_tokens/chunk=0；武术v1不是1.0。固定契约不匹配会在预检报错。多桥用显式‘组合’，不要串多个Apply。",
            inputs=[
                io.Combo.Input("model_name", options=list(model_paths()) or ["No Semantic Bridge models installed"],
                    tooltip="原版/BUNNY：https://huggingface.co/t8star/Semantic-Bridge-Comfy ；T8动漫战斗：https://huggingface.co/t8star/semantic_bridge_T8-comic-combat 。放在 models/semantic_bridge/t8_compat；不是LoRA或H3主模型。"),
                io.Boolean.Input("enabled", default=True),
                io.Float.Input("alpha", default=0.10, min=0.0, max=1.0, step=0.01),
                io.Combo.Input("magnitude_match", options=["per_token", "global", "none"], default="per_token"),
                io.Combo.Input("token_scope", options=["all_tokens", "text_only_preserve_reference"], default="all_tokens",
                               tooltip="all_tokens复现原作者；text_only仅修改原生tag=1行，仍不能保证歌声。"),
                io.Combo.Input("device", options=["auto", "cpu", "cuda"], default="auto", advanced=True),
                io.Int.Input("chunk_tokens", default=256, min=0, max=65536, advanced=True,
                             tooltip="0 = whole sequence; required by some trained Transformer bridges."),
            ], outputs=[BridgeIO.Output("semantic_bridge"), io.String.Output("report_json")],
        )

    @classmethod
    def validate_inputs(cls, model_name, enabled=True, alpha=0.10, magnitude_match="per_token",
                        token_scope="all_tokens", device="auto", chunk_tokens=256):
        # Naming these fields opts them out of Core's combo/range checks.
        # Preserve all range/enum checks when opting fields into custom validation.
        # Linked inputs are None during validation and are checked
        # again by execute once their producers have actually run.
        if alpha is not None:
            try:
                if not math.isfinite(alpha) or not 0 <= alpha <= 1:
                    return "Bridge alpha must be finite and between 0 and 1"
            except TypeError:
                return "Bridge alpha must be numeric"
        for value, choices, name in ((magnitude_match, ("per_token", "global", "none"), "magnitude_match"),
                                     (token_scope, ("all_tokens", "text_only_preserve_reference"), "token_scope"),
                                     (device, ("auto", "cpu", "cuda"), "device")):
            if value is not None and value not in choices:
                return f"Unknown Bridge {name}"
        if chunk_tokens is not None and (type(chunk_tokens) is not int or not 0 <= chunk_tokens <= 65536):
            return "Bridge chunk_tokens must be an integer between 0 and 65536"
        if enabled is False or alpha == 0:
            return True
        if enabled is None or alpha is None or model_name is None:
            return True
        try:
            path = resolve_model(model_name)
            if all(value is not None for value in (magnitude_match, token_scope, chunk_tokens)):
                validate_profile_settings(inspect_bridge_profile(path), alpha=alpha,
                    magnitude_match=magnitude_match, token_scope=token_scope, chunk_tokens=chunk_tokens)
        except (ValueError, TypeError, FileNotFoundError, OSError) as error:
            return str(error)
        return True

    @classmethod
    def fingerprint_inputs(cls, model_name, enabled=True, alpha=0.10, **kwargs):
        if not enabled or alpha == 0:
            return "disabled"
        return file_sha(resolve_model(model_name))

    @classmethod
    def execute(cls, model_name, enabled=True, alpha=0.10, magnitude_match="per_token",
                token_scope="all_tokens", device="auto", chunk_tokens=256):
        active = enabled and alpha != 0
        path = resolve_model(model_name) if active else ""
        profile = inspect_bridge_profile(path) if active else None
        config = BridgeConfig(path, profile["sha256"] if active else "", alpha,
                              magnitude_match, token_scope, device, chunk_tokens, enabled)
        warnings = (validate_profile_settings(profile, alpha=alpha, magnitude_match=magnitude_match,
                    token_scope=token_scope, chunk_tokens=chunk_tokens) if active else [])
        return io.NodeOutput(config, canonical({"identity": config.identity(), "model_name": model_name,
                                               "model_profile": profile, "warnings": warnings,
                                               "loaded": False, "warning": "EXP; no universal quality guarantee"}))


class MiniMaxH3SemanticBridgeApplyT8(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy deciiaH3SemanticBridgeApply",
            display_name="Deciia H3 Semantic Bridge / 应用条件 (T8 EXP)",
            category=CATEGORY, is_experimental=True,
            description="接在原生条件编码之后、采样之前。Relay请使用内部Bridge入口；不要重复增强。",
            inputs=[io.Conditioning.Input("conditioning"), BridgeIO.Input("semantic_bridge")],
            outputs=[io.Conditioning.Output("conditioning"), io.String.Output("report_json")],
        )

    @classmethod
    def execute(cls, conditioning, semantic_bridge):
        result, report = apply_bridge(conditioning, semantic_bridge)
        return io.NodeOutput(result, canonical(report))


SEMANTIC_BRIDGE_NODE_CLASSES = [MiniMaxH3SemanticBridgeConfigT8, MiniMaxH3SemanticBridgeApplyT8]

