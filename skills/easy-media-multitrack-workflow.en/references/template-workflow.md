# v1.3.0 Workflow Template and Node Replacement

The template asset is at `assets/templates/v1.3.0-blank-workflow.json`. It preserves the complete v1.3.0 nodes, links, groups and layout. It is used when the user explicitly asks for a "new workflow" or when no editable workflow is provided.

Template verification info: ComfyUI workflow version `0.4`, 21 nodes, 26 links, SHA-256 `6ac8498b5a60689f1919387cec960550bdadb4d9bc9459f4be264cfc3c52a470`.

## Generating from the Blank Template

The template's task and video tracks are both empty. Use this only when SKILL.md selects the "blank-template generation" path. Write the complete target TRACK_DATA through `patch_workflow.py`; do not modify the template asset directly. The existing-workflow path must never use this template to overwrite the user's file.

If no model node needs to be replaced, apply the multitrack plan directly to the template:

```bash
python3 scripts/patch_workflow.py apply \
  assets/templates/v1.3.0-blank-workflow.json \
  --plan PLAN.json \
  --output NEW-WORKFLOW.json \
  --write
```

If the loader or attention backend must be replaced for the user's environment, first generate a customized template, then apply the multitrack plan.

## Model Loader Replacement

The template's main model chain is:

```text
MiniMaxH3HybridLoader (11)
→ ModelAttentionBackend (13)
→ LoraLoaderModelOnly (6)
→ ModelPreviewOverrideKJ (21)
→ easy modelLoaderPack (16)
→ easy multitrackProject.model_loader (15)
```

When the user does not have `MiniMaxH3HybridLoader`, explicitly does not want it, or asks for ComfyUI's default loader, node 11 can be replaced in place with `UNETLoader`. The node ID, position and existing MODEL output links stay the same. The model file name must come from the user's explicit request or from the current ComfyUI model list. Do not blindly reuse the model file from the template's second-stage node 19.

```bash
python3 scripts/customize_template.py SOURCE.json \
  --output CUSTOMIZED.json \
  --replace-loader \
  --loader-node-id 11 \
  --unet-name minimax_h3_fl2va_pruned_int8_convrot.safetensors \
  --weight-dtype default
```

`UNETLoader` still needs the subsequent VAE and CLIP nodes and `easy modelLoaderPack` to form a `FAST_MODEL_LOADER`. Do not connect MODEL directly to the MultiTrack Project's `model_loader`.

## Attention Backend Replacement

`PathchSageAttentionKJ` and `MiniMaxH3MemoryEfficientSageAttentionPatch` both accept and output MODEL, so either one can replace node 13 in place, keeping input link 51 and output link 56.

Generic Sage Attention:

```bash
python3 scripts/customize_template.py SOURCE.json \
  --output CUSTOMIZED.json \
  --attention-backend pathch-sage \
  --attention-node-id 13 \
  --sage-attention auto
```

MiniMax H3 memory-saving patch:

```bash
python3 scripts/customize_template.py SOURCE.json \
  --output CUSTOMIZED.json \
  --attention-backend minimax-memory-efficient \
  --attention-node-id 13
```

The two replacements can be combined in a single command. `customize_template.py` changes only the specified node, refuses to overwrite the source file, and checks that top-level links, the node count and the other nodes' content remain unchanged.

## Selection Principles

- When the user explicitly names a node type, follow the user's choice.
- If the target custom node is missing, choose an installed, compatible substitute from the user's environment. If you cannot confirm an available node, ask first.
- Do not assume the user's environment has a model, precision or attention backend just because the template provides one.
- After a replacement, check that the MODEL chain is complete and that `easy modelLoaderPack` still receives model, clip, video VAE and audio VAE.
- Simply deleting a node leaves a broken link. If the user asks to remove rather than replace a node, you must reconnect the producer and consumer and update the node input/output links to match. Prefer an in-place replacement with the same semantics.
