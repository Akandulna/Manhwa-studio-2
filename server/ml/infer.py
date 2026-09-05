"""
Shared inference core — Module 3 AI: Auto-Crop

Produces crop suggestions for a chapter (Stage A + optional Stage B), used by
both suggest.py (interactive) and evaluate.py (held-out evaluation). Keeping it
here guarantees the two paths run identical inference.
"""

import os
import sys

import numpy as np

from panel_detect import detect_candidates
from features import build_feature_vector, nearest_preset

RULE_BASED_CONFIDENCE = 0.5

# Default cutoff: trained suggestions whose learned keep-probability is below
# this are dropped (so panels the user keeps rejecting — promo/watermark text
# banners especially — stop being suggested). Overridable per environment.
DEFAULT_MIN_KEEP_CONFIDENCE = 0.35


def min_keep_confidence():
    """Drop threshold for the learned keep-probability (env-overridable)."""
    try:
        v = float(os.environ.get("AI_CROP_MIN_CONFIDENCE", ""))
        if 0.0 <= v < 1.0:
            return v
    except ValueError:
        pass
    return DEFAULT_MIN_KEEP_CONFIDENCE


def load_model(model_dir):
    """Load a trained Stage-B model dict, or None to fall back to Stage A only."""
    if not model_dir:
        return None
    model_path = os.path.join(model_dir, "model.joblib")
    if not os.path.exists(model_path):
        return None
    try:
        import joblib
        model = joblib.load(model_path)
        # Phase B: attach the learned cut detector if this version has one.
        cut_path = os.path.join(model_dir, "cut_clf.joblib")
        if os.path.exists(cut_path):
            try:
                model["cut_model"] = joblib.load(cut_path)
            except Exception as e:  # pragma: no cover
                sys.stderr.write("Failed to load cut detector: %s\n" % e)
        return model
    except Exception as e:  # pragma: no cover - defensive
        sys.stderr.write("Failed to load model, using rule-based: %s\n" % e)
        return None


def model_version(model_dir):
    if not model_dir:
        return None
    base = os.path.basename(os.path.normpath(model_dir))
    if base.startswith("v") and base[1:].isdigit():
        return int(base[1:])
    return None


def _apply_stage_b(model, cand, canvas_w, canvas_h, idx, count, dist_prev, gap_next, embedding=None):
    """Adapt a Stage-A candidate to the user's style. Returns (rect, preset, conf, conf_is_keep)."""
    rect = {k: cand[k] for k in ("canvasX", "canvasY", "canvasW", "canvasH")}
    # Match the feature contract the model was trained with (older models predate
    # the text-density / embedding features); build_feature_vector projects accordingly.
    vec = build_feature_vector(
        rect, canvas_w, canvas_h, idx, count, dist_prev, gap_next,
        cand["img_feats"], cand["ctx_feats"],
        feature_names=model.get("feature_names"),
        embedding=embedding,
    ).reshape(1, -1)

    delta_reg = model.get("delta_reg")
    if delta_reg is not None:
        d_top, d_bottom = delta_reg.predict(vec)[0]
        new_top = max(0.0, rect["canvasY"] + float(d_top) * canvas_h)
        new_bottom = min(float(canvas_h), rect["canvasY"] + rect["canvasH"] + float(d_bottom) * canvas_h)
        if new_bottom - new_top > 4:
            rect["canvasY"] = new_top
            rect["canvasH"] = new_bottom - new_top

    preset_clf = model.get("preset_clf")
    preset_conf = RULE_BASED_CONFIDENCE
    if preset_clf is not None:
        preset = str(preset_clf.predict(vec)[0])
        if hasattr(preset_clf, "predict_proba"):
            preset_conf = float(max(preset_clf.predict_proba(vec)[0]))
    else:
        preset = nearest_preset(rect["canvasW"], rect["canvasH"])

    # Prefer the learned keep-probability (calibrated from the user's
    # accept/reject feedback) as the reported confidence — this is what lets the
    # model suppress regions it has learned the user always rejects (e.g. promo
    # text banners). Fall back to the preset probability when no calibrator.
    conf_clf = model.get("conf_clf")
    conf_is_keep = False
    confidence = preset_conf
    if conf_clf is not None and hasattr(conf_clf, "predict_proba"):
        try:
            classes = list(getattr(conf_clf, "classes_", []))
            proba = conf_clf.predict_proba(vec)[0]
            confidence = float(proba[classes.index(1)]) if 1 in classes else float(proba.max())
            conf_is_keep = True
        except Exception as e:  # pragma: no cover - defensive
            sys.stderr.write("conf_clf failed, using preset confidence: %s\n" % e)

    return rect, preset, confidence, conf_is_keep


def generate_suggestions(image_dir, manifest, model, progress_cb=None):
    """
    Run Stage A (+ Stage B if `model` is provided) over a chapter.
    Returns a list of {canvasX, canvasY, canvasW, canvasH, aspectPreset, confidence}.
    """
    # A model trained with visual embeddings can't be reproduced without the
    # backbone — fall back to rule-based (rather than feeding zeros) if it's gone.
    if model is not None and model.get("usesEmbeddings"):
        import embedder
        if not embedder.available():
            sys.stderr.write("Model uses visual embeddings but backbone.onnx is unavailable; falling back to rule-based.\n")
            model = None

    # Only compute the costly text-density feature / embeddings when the active
    # model actually consumes them (skipped for rule-based and pre-text models).
    feature_names = model.get("feature_names") if model is not None else None
    uses_text = bool(feature_names) and any("text_density" in n for n in feature_names)
    uses_emb = bool(model is not None and model.get("usesEmbeddings"))
    embedding_pca = model.get("embedding_pca") if uses_emb else None

    # Candidate density: subdivide tall spans toward the user's typical crop
    # height. Prefer the value learned at training; allow an env override so a
    # pre-existing model benefits without retraining.
    target_ratio = model.get("target_height_ratio") if model is not None else None
    if not target_ratio:
        try:
            env_ratio = float(os.environ.get("AI_CROP_TARGET_HEIGHT_RATIO", ""))
            if env_ratio > 0:
                target_ratio = env_ratio
        except ValueError:
            pass

    cut_model = model.get("cut_model") if model is not None else None
    candidates = detect_candidates(image_dir, manifest, with_text=uses_text,
                                   with_embeddings=uses_emb, target_height_ratio=target_ratio,
                                   cut_model=cut_model)
    canvas_w = float(manifest["canvasWidth"])
    canvas_h = float(manifest["canvasHeight"])

    out = []
    n = len(candidates)
    min_conf = min_keep_confidence()
    dropped_lowconf = 0
    for i, cand in enumerate(candidates):
        dist_prev = (cand["canvasY"] - (candidates[i - 1]["canvasY"] + candidates[i - 1]["canvasH"])) if i > 0 else None
        gap_next = (candidates[i + 1]["canvasY"] - (cand["canvasY"] + cand["canvasH"])) if i + 1 < n else None

        conf_is_keep = False
        if model is not None:
            try:
                embedding = None
                if embedding_pca is not None:
                    import embedder
                    raw = embedder.embed(cand.get("img_region"))
                    if raw is None:
                        raw = np.zeros(embedder.EMBEDDING_OUTPUT_DIM, dtype=np.float32)
                    embedding = embedding_pca.transform([raw])[0]
                rect, preset, confidence, conf_is_keep = _apply_stage_b(
                    model, cand, canvas_w, canvas_h, i, n, dist_prev, gap_next, embedding=embedding)
            except Exception as e:
                sys.stderr.write("Stage B failed for candidate %d: %s\n" % (i, e))
                rect = {k: cand[k] for k in ("canvasX", "canvasY", "canvasW", "canvasH")}
                preset = nearest_preset(cand["canvasW"], cand["canvasH"])
                confidence = RULE_BASED_CONFIDENCE
        else:
            rect = {k: cand[k] for k in ("canvasX", "canvasY", "canvasW", "canvasH")}
            preset = nearest_preset(cand["canvasW"], cand["canvasH"])
            confidence = round(min(0.95, RULE_BASED_CONFIDENCE + 0.3 * cand.get("gutter_strength", 0.0)), 3)

        # When the model reports a learned keep-probability, suppress suggestions
        # it predicts the user would reject (the text-banner case). Only applied
        # to keep-calibrated confidences so the rule-based path is unaffected.
        if conf_is_keep and confidence < min_conf:
            dropped_lowconf += 1
            if progress_cb and n > 0 and (i % 5 == 0 or i == n - 1):
                progress_cb(i + 1, n)
            continue

        out.append({
            "canvasX": round(rect["canvasX"], 2),
            "canvasY": round(rect["canvasY"], 2),
            "canvasW": round(rect["canvasW"], 2),
            "canvasH": round(rect["canvasH"], 2),
            "aspectPreset": preset,
            "confidence": round(float(confidence), 3),
        })

        if progress_cb and n > 0 and (i % 5 == 0 or i == n - 1):
            progress_cb(i + 1, n)

    if dropped_lowconf:
        sys.stderr.write("Dropped %d low keep-confidence suggestion(s) (<%.2f)\n" % (dropped_lowconf, min_conf))

    return out
