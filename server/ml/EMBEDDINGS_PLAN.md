# Phase 1 — Visual Embeddings for AI Auto-Crop

Goal: give the Stage-B model **eyes**. Today it scores candidates from geometry +
brightness/edge summary stats (`features.py`), so it can't perceive *what a panel
looks like*. We add a frozen pretrained vision backbone that turns each
candidate's pixels into a learned embedding, append a PCA-compressed version of
that embedding to the existing feature vector, and keep training the current
GradientBoosting heads on top. 100% offline at inference.

## Non-goals (deferred to Phase 2)
- Fine-tuning the backbone (we freeze it; only the small heads learn).
- Replacing the rule-based candidate generator (`panel_detect.py`) with a learned
  cut detector. Phase 1 still re-ranks/pads gutter-found candidates.

## Why this is safe with ~290 crops
The backbone is frozen and pretrained on ImageNet, so we never train millions of
parameters on our small set. We only feed a **24-d PCA-reduced** embedding into
the existing tree heads — small enough to avoid overfitting, semantic enough to
capture composition/content.

## Target architecture
```
candidate crop (+ context) pixels
  → MobileNetV3-Small backbone (frozen, local ONNX)   →  576-d embedding
  → PCA (fit on our data, stored in model.joblib)     →  ~24-d
  → concat with existing geometry/text features (features.py)
  → existing preset_clf / delta_reg / conf_clf heads (train.py)  [unchanged]
```

## Model artifact additions (`models/v{N}/model.joblib`)
- `embedding_pca`        — fitted sklearn PCA (576 → EMBEDDING_DIM)
- `embedding_dim`        — int (default 24)
- `usesEmbeddings`       — bool flag read at inference
- `feature_names`        — existing names **+** `emb_00..emb_{D-1}`
- `backbone`             — id string (e.g. `mobilenet_v3_small`) for provenance

Backward compatible: models without `usesEmbeddings`/`emb_*` names run exactly as
today via the existing `build_feature_vector(feature_names=...)` projection.

---

## Step-by-step

### Step 0 — Dependencies & offline backbone (one-time)
- `server/ml/requirements.txt`: add `onnxruntime` (small; used for BOTH train-time
  embedding extraction and inference). Add `torch` + `torchvision` as **export-only**
  deps (used once, not at runtime).
- New `server/ml/export_backbone.py`: load `torchvision.models.mobilenet_v3_small(weights=DEFAULT)`,
  drop the classifier, keep `features → avgpool → flatten` (576-d), export to
  `server/ml/models/backbone.onnx` (input `1x3x224x224`, output `1x576`).
- Wire into `npm run ml:setup` (server `package.json` / setup script): run
  `export_backbone.py` once if `models/backbone.onnx` is missing. **This is the only
  step needing internet** (to fetch pretrained weights); afterward everything is offline.
- **Acceptance**: `backbone.onnx` exists; an `onnxruntime` session loads it; a forward
  pass on a random `224×224×3` tensor returns a 576-d vector.

### Step 1 — `server/ml/embedder.py` (new)
- `_session()` — lazily create + cache an `onnxruntime.InferenceSession(backbone.onnx)`.
- `available()` — True iff onnxruntime imports AND `backbone.onnx` exists.
- `embed(gray) -> np.ndarray|None` — preprocess a grayscale region (resize 224²,
  replicate to 3 channels, ImageNet mean/std normalize, NCHW float32), run the
  session, return the 576-d vector. Return `None` if `available()` is False.
- **Acceptance**: `embed()` on a dataset webp returns length-576; two different
  images give different vectors; with the backbone removed, `embed()` returns `None`
  and `available()` is False.

### Step 2 — Feature plumbing (`server/ml/features.py`)
- Add `EMBEDDING_DIM = 24` and `emb_feature_names(dim)` → `["emb_00", ...]`.
- Extend `build_feature_vector(..., embedding=None)`: when `embedding` is provided,
  merge `{f"emb_{i:02d}": v}` into the `feature_dict` result before projecting by
  `feature_names`. When `None`, behavior is unchanged.
- **Acceptance**: with an embedding + feature_names that include `emb_*`, the vector
  contains those columns in order; without, output is byte-identical to today.

### Step 3 — Training (`server/ml/train.py`)
- In `build_dataset`: if `embedder.available()`, also embed each sample's stored
  crop webp → collect raw 576-d arrays alongside `X`. (Context embedding optional;
  start crop-only to keep dims small.)
- Fit `PCA(n_components=EMBEDDING_DIM)` on the **train-split** raw embeddings only
  (no holdout leakage); transform all rows; append to the feature vectors and extend
  the working feature-name list with `emb_*`.
- Train `preset_clf` / `delta_reg` / `conf_clf` on the augmented vectors (unchanged
  estimators).
- Persist `embedding_pca`, `embedding_dim`, `usesEmbeddings=True`, `backbone`, and the
  extended `feature_names` into `model.joblib`; record `usesEmbeddings` + backbone id
  in `metadata.json`.
- **Guard**: if `embedder.available()` is False, skip all of the above and train
  exactly as today (log a one-line notice). 
- **Acceptance**: with the backbone present, the new model has `usesEmbeddings=True`
  + a PCA and reports holdout metrics; with it absent, the produced model is
  identical in shape to the current one.

### Step 4 — Inference (`server/ml/infer.py` + `server/ml/panel_detect.py`)
- `detect_candidates(..., with_embeddings=False)`: when True, attach the raw grayscale
  region slices (`img_region`, and `ctx_region` if used) to each candidate dict. These
  arrays stay in-process (never serialized to stdout), so the only cost is not
  discarding the slice we already cut.
- `generate_suggestions`: compute
  `uses_emb = model is not None and model.get("usesEmbeddings") and embedder.available()`;
  pass `with_embeddings=uses_emb` to `detect_candidates`. For each candidate when
  `uses_emb`: `embedder.embed(region)` → `model["embedding_pca"].transform(...)` → pass
  the reduced vector as `embedding=` into `_apply_stage_b`/`build_feature_vector`.
- `_apply_stage_b`: forward the `embedding` into `build_feature_vector(feature_names=model["feature_names"])`.
- **Fallback**: if a model has `usesEmbeddings=True` but the backbone is missing at
  inference time, the head's expected `emb_*` columns can't be reproduced — detect this
  at `load_model`/first use, log a clear notice, and fall back to the rule-based path
  for that run (rather than feeding zeros, which would silently degrade quality).
- **Acceptance**: a model trained with embeddings produces suggestions end-to-end;
  renaming `backbone.onnx` makes the same model fall back to rule-based gracefully (no
  crash); pre-embedding models (v1/v2) are unaffected.

### Step 5 — Dataset (no change expected)
- `cropDatasetService.ts` already renders + stores `*_crop.webp` / `*_ctx.webp` per
  crop, which is all Step 3 needs. Confirm `renderRegionToWebp` output is readable by
  `cv2.imread(..., GRAYSCALE)` (it is today) — the embedder replicates to 3 channels.
- **No exporter or schema change.** Existing dataset is reusable as-is.

### Step 6 — Status surfacing (optional, light)
- `aiCropService.ts getStatus()` → add `backboneAvailable` (check `backbone.onnx`
  exists); `listModels()` → surface `usesEmbeddings` per version. Lets the AI Crop Lab
  show "Vision model: ready / not installed" and mark which model versions are
  embedding-powered. Purely informational.

### Step 7 — Evaluate & roll out
- Train a new version with embeddings; keep the current model **active** until verified.
- Compare via existing `evaluate.py` / `listModels` metrics: holdout **meanIoU**,
  **presetAccuracy**, and `conf_clf` keep-accuracy — before vs after.
- Promote with `setActiveModelVersion(N)` only if no regression (ideally a lift).

---

## Offline & rollback guarantees
- After Step 0, no network calls ever — `onnxruntime` runs the local `backbone.onnx`.
- Rollback = delete `backbone.onnx` (or revert active model to a pre-embedding
  version). Old models keep working; new code degrades to today's behavior.

## Risks & mitigations
| Risk | Mitigation |
|------|-----------|
| 290 crops too few for embeddings to help | Frozen backbone + 24-d PCA + keep current model as fallback; A/B via holdout before promoting. |
| Heavier `ml:setup` (one download + export) | One-time, gated on `backbone.onnx` missing; documented. |
| ImageNet semantics ≠ manhwa art | Acceptable for Phase 1; Phase 2 fine-tunes if embeddings plateau. |
| Inference latency (embed per candidate) | onnxruntime CPU on ~50 small regions is fast; embed only when model uses it. |

## Effort (rough)
- Step 0–1: backbone export + embedder — ~half day.
- Step 2–3: feature plumbing + training — ~half day.
- Step 4: inference + fallback — ~half day.
- Step 6–7: status + eval/rollout — ~quarter day.

## Files touched
- New: `server/ml/export_backbone.py`, `server/ml/embedder.py`, `server/ml/models/backbone.onnx` (generated)
- Edit: `server/ml/requirements.txt`, `server/ml/features.py`, `server/ml/train.py`,
  `server/ml/infer.py`, `server/ml/panel_detect.py`, `npm run ml:setup` script
- Optional: `server/src/services/ai/aiCropService.ts` (status surfacing)
- Unchanged: dataset exporter, Prisma schema, client (except optional status chip)
