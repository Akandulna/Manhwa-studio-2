#!/usr/bin/env python3
"""
Stage B trainer — Module 3 AI: Auto-Crop

Learns the user's personal cropping style from the exported dataset
(server/ml/dataset/) and writes a versioned model artifact to
server/ml/models/v{version}/.

Two learned components (lightweight, small-data friendly):
  - preset_clf : geometric+image features -> chosen aspect preset
  - delta_reg  : features -> normalized vertical padding adjustment [d_top, d_bottom]
  - conf_clf   : (optional, from suggestion feedback) probability the user keeps a crop

Holdout is split by CHAPTER (never by individual crop) to avoid leakage.

Usage:  python train.py --train   # reads JSON config from stdin
Stdin:
  { "datasetDir": str, "modelDir": str, "version": int,
    "minSamples": int, "holdoutRatio": float, "createdAt": str }
Stdout: line-delimited JSON envelopes (progress / result / error).
"""

import sys
import os
import json
import argparse
import numpy as np


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(phase, percent, **extra):
    emit({"event": "progress", "phase": phase, "percent": percent, **extra})


def load_jsonl(path):
    rows = []
    if os.path.exists(path):
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    return rows


def build_dataset(samples, dataset_dir):
    """Return X, y_preset, y_delta, delta_mask, chapter_ids, first_drafts, finals."""
    import cv2
    from features import build_feature_vector, image_features
    import embedder

    use_emb = embedder.available()

    X, y_preset, y_delta, delta_mask = [], [], [], []
    chapter_ids, first_drafts, finals, canvas_heights = [], [], [], []
    raw_embeddings = []  # Nx576 backbone features, or [] when no backbone

    for s in samples:
        crop_path = os.path.join(dataset_dir, s["images"]["crop"])
        ctx_path = os.path.join(dataset_dir, s["images"]["context"])
        crop_img = cv2.imread(crop_path, cv2.IMREAD_GRAYSCALE)
        ctx_img = cv2.imread(ctx_path, cv2.IMREAD_GRAYSCALE)
        imgf = image_features(crop_img)
        ctxf = image_features(ctx_img)

        vec = build_feature_vector(
            s["rect"], s["canvasWidth"], s["canvasHeight"],
            max(0, s["sequence"] - 1), s["cropCountInChapter"],
            s.get("distanceFromPrev"), s.get("gapToNext"), imgf, ctxf,
        )
        X.append(vec)
        if use_emb:
            emb = embedder.embed(crop_img)
            raw_embeddings.append(emb if emb is not None else np.zeros(embedder.EMBEDDING_OUTPUT_DIM, dtype=np.float32))
        y_preset.append(s["aspectPreset"])
        chapter_ids.append(s["chapterId"])

        ch = max(1e-6, float(s["canvasHeight"]))
        adj = s.get("adjustment", {})
        delta = adj.get("deltaFromFirstDraft")
        if delta is not None:
            y_delta.append([delta["dy"] / ch, delta["dh"] / ch])
            delta_mask.append(True)
        else:
            y_delta.append([0.0, 0.0])
            delta_mask.append(False)

        first_drafts.append(adj.get("firstDraftRect"))
        finals.append(s["rect"])
        canvas_heights.append(ch)

    return (
        np.array(X, dtype=np.float32),
        np.array(y_preset),
        np.array(y_delta, dtype=np.float32),
        np.array(delta_mask),
        np.array(chapter_ids),
        first_drafts,
        finals,
        canvas_heights,
        np.array(raw_embeddings, dtype=np.float32) if raw_embeddings else None,
    )


def chapter_holdout(chapter_ids, ratio):
    """Deterministic chapter-level split; returns set of validation chapter ids."""
    uniq = list(dict.fromkeys(chapter_ids.tolist()))
    if len(uniq) <= 1:
        return set()
    n_val = max(1, int(round(len(uniq) * ratio)))
    n_val = min(n_val, len(uniq) - 1)  # always keep >=1 chapter for training
    return set(uniq[-n_val:])


def train(config):
    from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
    from sklearn.multioutput import MultiOutputRegressor
    from sklearn.dummy import DummyClassifier
    from sklearn.decomposition import PCA
    import joblib
    from features import FEATURE_NAMES, PRESET_ORDER, EMBEDDING_DIM, emb_feature_names
    from metrics import iou
    import embedder

    dataset_dir = config["datasetDir"]
    model_dir = config["modelDir"]
    version = config["version"]
    min_samples = config.get("minSamples", 30)
    holdout_ratio = config.get("holdoutRatio", 0.15)

    progress("loading", 5)
    samples = load_jsonl(os.path.join(dataset_dir, "samples.jsonl"))
    feedback = load_jsonl(os.path.join(dataset_dir, "feedback.jsonl"))

    if len(samples) < min_samples:
        emit({"event": "error",
              "message": "Not enough training data: %d crops, need at least %d." % (len(samples), min_samples)})
        return

    progress("features", 25, sampleCount=len(samples))
    X, y_preset, y_delta, delta_mask, chapter_ids, first_drafts, finals, canvas_heights, raw_embeddings = build_dataset(samples, dataset_dir)

    val_chapters = chapter_holdout(chapter_ids, holdout_ratio)
    is_val = np.array([c in val_chapters for c in chapter_ids])
    is_train = ~is_val
    if is_train.sum() == 0:  # tiny dataset edge case
        is_train = np.ones(len(chapter_ids), dtype=bool)
        is_val = np.zeros(len(chapter_ids), dtype=bool)

    # --- Visual embeddings (Phase 1): fit PCA on the train split only (no leakage),
    # reduce 576-d backbone features to EMBEDDING_DIM, and append to every row. ---
    embedding_pca = None
    feature_names = list(FEATURE_NAMES)
    if raw_embeddings is not None and len(raw_embeddings) == len(X):
        n_comp = min(EMBEDDING_DIM, raw_embeddings.shape[1], max(1, int(is_train.sum()) - 1))
        if n_comp >= 1:
            embedding_pca = PCA(n_components=n_comp, random_state=0)
            embedding_pca.fit(raw_embeddings[is_train])
            emb_reduced = embedding_pca.transform(raw_embeddings).astype(np.float32)
            X = np.hstack([X, emb_reduced]).astype(np.float32)
            feature_names = list(FEATURE_NAMES) + emb_feature_names(n_comp)
            progress("features", 35, embeddingDim=n_comp)

    uses_embeddings = embedding_pca is not None

    # Typical crop height as a fraction of canvas WIDTH (resolution-independent),
    # learned from the user's own crops. Stage A uses this to subdivide tall
    # gutter-spans so candidate density matches how finely the user cuts.
    height_ratios = [
        float(s["rect"]["canvasH"]) / float(s["rect"]["canvasW"])
        for s in samples
        if s.get("rect", {}).get("canvasW")
    ]
    target_height_ratio = float(np.median(height_ratios)) if height_ratios else None

    progress("training", 45)

    # --- Preset classifier ---
    classes = np.unique(y_preset[is_train])
    if len(classes) < 2:
        preset_clf = DummyClassifier(strategy="most_frequent")
    else:
        preset_clf = GradientBoostingClassifier(n_estimators=120, max_depth=3, learning_rate=0.1)
    preset_clf.fit(X[is_train], y_preset[is_train])

    # --- Delta (padding) regressor ---
    delta_train_mask = is_train & delta_mask
    delta_reg = None
    if delta_train_mask.sum() >= 5:
        delta_reg = MultiOutputRegressor(
            GradientBoostingRegressor(n_estimators=120, max_depth=3, learning_rate=0.1))
        delta_reg.fit(X[delta_train_mask], y_delta[delta_train_mask])

    # --- Confidence calibrator from feedback (optional) ---
    progress("training", 65)
    conf_clf = _train_confidence(feedback, dataset_dir, embedding_pca, feature_names)

    # --- Validation metrics ---
    progress("validating", 80)
    metrics = _validate(
        preset_clf, delta_reg, X, y_preset, is_val, delta_mask,
        first_drafts, finals, canvas_heights, val_chapters, iou)

    # --- Persist ---
    progress("saving", 92)
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump({
        "feature_names": feature_names,
        "preset_clf": preset_clf,
        "delta_reg": delta_reg,
        "conf_clf": conf_clf,
        "presets": PRESET_ORDER,
        "embedding_pca": embedding_pca,
        "embedding_dim": (embedding_pca.n_components_ if embedding_pca is not None else 0),
        "usesEmbeddings": uses_embeddings,
        "backbone": "mobilenet_v3_small" if uses_embeddings else None,
        "target_height_ratio": target_height_ratio,
    }, os.path.join(model_dir, "model.joblib"))

    # --- Phase B: learned cut detector (where the user actually cuts) ---
    progress("training", 96)
    cut_metrics = None
    has_cut_model = False
    try:
        import cutdetect
        cut_model, cut_metrics = cutdetect.train_cut_detector(dataset_dir, holdout_ratio)
        if cut_model is not None:
            joblib.dump(cut_model, os.path.join(model_dir, "cut_clf.joblib"))
            has_cut_model = True
    except Exception as e:  # pragma: no cover - cut detector is best-effort
        sys.stderr.write("Cut detector training skipped: %s\n" % e)
        cut_metrics = {"note": str(e)}

    hyperparams = {"n_estimators": 120, "max_depth": 3, "learning_rate": 0.1, "holdoutRatio": holdout_ratio}
    metadata = {
        "version": version,
        "createdAt": config.get("createdAt"),
        "trainingSampleCount": len(samples),
        "feedbackCount": len(feedback),
        "hyperparams": hyperparams,
        "metrics": metrics,
        "validationChapters": sorted(val_chapters),
        "hasDeltaModel": delta_reg is not None,
        "hasConfidenceModel": conf_clf is not None,
        "usesEmbeddings": uses_embeddings,
        "backbone": "mobilenet_v3_small" if uses_embeddings else None,
        "embeddingDim": (embedding_pca.n_components_ if embedding_pca is not None else 0),
        "targetHeightRatio": target_height_ratio,
        "hasCutModel": has_cut_model,
        "cutMetrics": cut_metrics,
    }
    with open(os.path.join(model_dir, "metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    emit({
        "event": "result",
        "status": "ready",
        "trainingSampleCount": len(samples),
        "metrics": metrics,
        "hyperparams": hyperparams,
        "validationChapters": sorted(val_chapters),
        "usesEmbeddings": uses_embeddings,
        "hasCutModel": has_cut_model,
        "cutMetrics": cut_metrics,
    })


def _train_confidence(feedback, dataset_dir, embedding_pca=None, feature_names=None):
    if len(feedback) < 10:
        return None
    try:
        import cv2
        from sklearn.ensemble import GradientBoostingClassifier
        from features import build_feature_vector, image_features
        import embedder

        Xf, yf = [], []
        for fb in feedback:
            crop_img = cv2.imread(os.path.join(dataset_dir, fb["images"]["crop"]), cv2.IMREAD_GRAYSCALE)
            ctx_img = cv2.imread(os.path.join(dataset_dir, fb["images"]["context"]), cv2.IMREAD_GRAYSCALE)
            # Match the training feature space: same PCA-reduced embedding when used.
            emb = None
            if embedding_pca is not None:
                raw = embedder.embed(crop_img)
                if raw is None:
                    raw = np.zeros(embedder.EMBEDDING_OUTPUT_DIM, dtype=np.float32)
                emb = embedding_pca.transform([raw])[0]
            vec = build_feature_vector(
                fb["rect"], fb["canvasWidth"], fb["canvasHeight"],
                fb.get("sequence", 0), fb.get("count", 1),
                None, None, image_features(crop_img), image_features(ctx_img),
                feature_names=feature_names, embedding=emb)
            Xf.append(vec)
            yf.append(1 if fb["kept"] else 0)
        if len(set(yf)) < 2:
            return None
        clf = GradientBoostingClassifier(n_estimators=80, max_depth=2, learning_rate=0.1)
        clf.fit(np.array(Xf, dtype=np.float32), np.array(yf))
        return clf
    except Exception as e:  # pragma: no cover - defensive
        sys.stderr.write("Confidence calibrator skipped: %s\n" % e)
        return None


def _validate(preset_clf, delta_reg, X, y_preset, is_val, delta_mask,
              first_drafts, finals, canvas_heights, val_chapters, iou_fn):
    if is_val.sum() == 0:
        return {"presetAccuracy": None, "meanIoU": None, "deltaMae": None,
                "valSamples": 0, "valChapters": 0, "note": "dataset too small for a holdout split"}

    val_idx = np.where(is_val)[0]
    preset_pred = preset_clf.predict(X[is_val])
    preset_acc = float(np.mean(preset_pred == y_preset[is_val]))

    # Reconstruction IoU: apply predicted padding delta to the user's first draft
    # and compare against their final crop (a padding-fit proxy).
    ious, abs_errs = [], []
    if delta_reg is not None:
        deltas = delta_reg.predict(X[is_val])
        for k, i in enumerate(val_idx):
            fd = first_drafts[i]
            fin = finals[i]
            if fd is None:
                continue
            d_top, d_bottom = deltas[k]
            # deltas were normalized by the full canvas height during training, so
            # denormalize with the same scale to recover pixels.
            scale = max(1.0, canvas_heights[i])
            new_top = fd["canvasY"] + d_top * scale
            new_bottom = fd["canvasY"] + fd["canvasH"] + d_bottom * scale
            recon = {"canvasX": fin["canvasX"], "canvasY": new_top,
                     "canvasW": fin["canvasW"], "canvasH": max(1.0, new_bottom - new_top)}
            ious.append(iou_fn(recon, fin))
            abs_errs.append(abs(d_top) + abs(d_bottom))

    mean_iou = float(np.mean(ious)) if ious else None
    delta_mae = float(np.mean(abs_errs)) if abs_errs else None

    return {
        "presetAccuracy": preset_acc,
        "meanIoU": mean_iou,
        "deltaMae": delta_mae,
        "valSamples": int(is_val.sum()),
        "valChapters": len(val_chapters),
    }


def main():
    parser = argparse.ArgumentParser(description="AI auto-crop trainer")
    parser.add_argument("--train", action="store_true")
    args = parser.parse_args()

    if not args.train:
        parser.print_help()
        sys.exit(1)

    try:
        config = json.loads(sys.stdin.read())
        train(config)
    except Exception as e:
        emit({"event": "error", "message": str(e)})
        sys.stderr.write("train failed: %s\n" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
