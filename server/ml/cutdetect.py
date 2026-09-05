"""
Learned cut detector — Module 3 AI: Auto-Crop (Phase B)

Stage A's gutter detector only cuts at whitespace, so it badly under-segments
users who cut finely / mid-panel (low recall). This module learns *where the
user cuts* from their finalized crops: it scores every strip row with the
probability of being a cut boundary, then peak-picks boundaries subject to a
minimum spacing (the user's typical crop height). Candidate panels are the spans
between consecutive boundaries.

Design: a small, small-data-friendly GradientBoosting row classifier over
per-row appearance features + a context window + normalized position. No torch.
Trained on downscaled strips rebuilt with panel_detect.build_canvas_strip (same
pixels as inference). Persisted as a dict in the model version dir (cut_clf.joblib).

The trainer reads dataset/cuts_index.json (written by cropDatasetService):
  { "chapters": [ { "chapterId", "imageDir", "manifest", "cutYs": [...] }, ... ] }
"""

import os
import json
import numpy as np

try:
    import cv2
    _HAVE_CV2 = True
except ImportError:  # pragma: no cover
    _HAVE_CV2 = False

# Downscaled strip height the detector operates on (rows). Keeps training/inference
# cheap and resolution-independent; cut Ys are mapped to/from canvas height.
STRIP_ROWS = 1024
STRIP_WIDTH = 200          # columns used for per-row stats
WINDOW_K = 6               # context rows on each side fed to the classifier
LABEL_TOL = 3              # a row within this many rows of a real cut is positive
NEG_PER_POS = 12           # negative:positive sampling ratio during training
CUT_PROB_THRESHOLD = 0.30  # minimum probability to consider a row a boundary
MIN_SPACING_FRAC = 0.55    # min boundary spacing as a fraction of target height


def _row_features(strip):
    """Per-row appearance features on a strip → [STRIP_ROWS, 5]."""
    s = cv2.resize(strip, (STRIP_WIDTH, STRIP_ROWS), interpolation=cv2.INTER_AREA).astype(np.float32)
    intensity = s.mean(axis=1) / 255.0
    std = s.std(axis=1) / 255.0
    dark = (s < 32).mean(axis=1)
    bright = (s > 223).mean(axis=1)
    grad = np.zeros_like(intensity)
    grad[1:] = np.abs(intensity[1:] - intensity[:-1])
    return np.stack([intensity, std, grad, dark, bright], axis=1)  # [R,5]


def _windowize(feats):
    """Per-row context window + normalized position → [STRIP_ROWS, 5*(2K+1)+1]."""
    r, c = feats.shape
    padded = np.pad(feats, ((WINDOW_K, WINDOW_K), (0, 0)), mode="edge")
    cols = [padded[k:k + r] for k in range(2 * WINDOW_K + 1)]  # each [r,c]
    win = np.concatenate(cols, axis=1)                          # [r, c*(2K+1)]
    pos = (np.arange(r, dtype=np.float32) / max(1, r)).reshape(-1, 1)
    return np.concatenate([win, pos], axis=1)


def _labels(cut_ys, canvas_h):
    """Binary boundary labels on the STRIP_ROWS grid for one chapter."""
    y = np.zeros(STRIP_ROWS, dtype=np.int8)
    if canvas_h <= 0:
        return y
    for cy in cut_ys:
        r = int(round(float(cy) / float(canvas_h) * (STRIP_ROWS - 1)))
        lo, hi = max(0, r - LABEL_TOL), min(STRIP_ROWS, r + LABEL_TOL + 1)
        y[lo:hi] = 1
    return y


def _build_strip_features(image_dir, manifest):
    """Rebuild the strip (same code as inference) and return windowed row features."""
    from panel_detect import build_canvas_strip
    strip, canvas_w, canvas_h = build_canvas_strip(image_dir, manifest)
    if strip is None:
        return None, canvas_w, canvas_h
    return _windowize(_row_features(strip)), canvas_w, canvas_h


def train_cut_detector(dataset_dir, holdout_ratio=0.15):
    """
    Train the row-boundary classifier from dataset/cuts_index.json.
    Returns (model_dict | None, metrics_dict). model_dict is None when there is
    no usable data or cv2/sklearn is unavailable.
    """
    if not _HAVE_CV2:
        return None, {"note": "opencv unavailable"}
    index_path = os.path.join(dataset_dir, "cuts_index.json")
    if not os.path.exists(index_path):
        return None, {"note": "no cuts_index.json"}

    try:
        chapters = json.load(open(index_path)).get("chapters", [])
    except Exception as e:  # pragma: no cover
        return None, {"note": "failed to read cuts_index.json: %s" % e}
    if len(chapters) < 2:
        return None, {"note": "need >=2 chapters to train the cut detector"}

    # Chapter-level holdout (deterministic; no per-row leakage).
    n_val = max(1, int(round(len(chapters) * holdout_ratio)))
    n_val = min(n_val, len(chapters) - 1)
    val_ids = set(c["chapterId"] for c in chapters[-n_val:])

    rng = np.random.RandomState(0)
    Xtr, ytr = [], []
    val_chapters = []  # (windowed_feats, cut_rows, canvas_h)
    for ch in chapters:
        feats, _cw, canvas_h = _build_strip_features(ch["imageDir"], ch["manifest"])
        if feats is None:
            continue
        labels = _labels(ch.get("cutYs", []), canvas_h)
        if ch["chapterId"] in val_ids:
            # Compare against distinct cut CENTERS (not the smeared label band),
            # so boundary recall reflects how many real cuts were recovered.
            centers = set(
                int(round(float(cy) / float(canvas_h) * (STRIP_ROWS - 1)))
                for cy in ch.get("cutYs", []) if canvas_h > 0 and 0 < cy < canvas_h
            )
            val_chapters.append((feats, centers, canvas_h))
            continue
        pos_idx = np.where(labels == 1)[0]
        neg_idx = np.where(labels == 0)[0]
        if len(pos_idx) == 0:
            continue
        keep_neg = min(len(neg_idx), NEG_PER_POS * len(pos_idx))
        neg_sample = rng.choice(neg_idx, size=keep_neg, replace=False) if keep_neg < len(neg_idx) else neg_idx
        sel = np.concatenate([pos_idx, neg_sample])
        Xtr.append(feats[sel])
        ytr.append(labels[sel])

    if not Xtr:
        return None, {"note": "no positive training rows"}

    X = np.vstack(Xtr).astype(np.float32)
    y = np.concatenate(ytr)
    if len(set(y.tolist())) < 2:
        return None, {"note": "labels not separable"}

    from sklearn.ensemble import GradientBoostingClassifier
    clf = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.1)
    clf.fit(X, y)

    model = {
        "clf": clf,
        "stripRows": STRIP_ROWS,
        "windowK": WINDOW_K,
        "probThreshold": CUT_PROB_THRESHOLD,
        "minSpacingFrac": MIN_SPACING_FRAC,
    }

    metrics = _validate_cuts(model, val_chapters)
    metrics["trainChapters"] = len(chapters) - len(val_chapters)
    metrics["valChapters"] = len(val_chapters)
    return model, metrics


def _peak_pick(prob, min_spacing, threshold):
    """Greedy non-max suppression: pick highest-prob rows >= threshold, spaced apart."""
    rows = [r for r in np.argsort(-prob) if prob[r] >= threshold]
    chosen = []
    for r in rows:
        if all(abs(r - c) >= min_spacing for c in chosen):
            chosen.append(int(r))
    return sorted(chosen)


def predict_cut_rows(model, feats, canvas_h, target_px, canvas_w):
    """
    Return sorted cut Y-positions (canvas space) for one chapter, given windowed
    row features. Spacing is tied to the user's target crop height.
    """
    clf = model["clf"]
    prob = clf.predict_proba(feats)[:, list(clf.classes_).index(1)] if 1 in clf.classes_ else np.zeros(len(feats))
    # Minimum spacing in strip rows, from the target crop height.
    target_rows = (target_px / float(canvas_h)) * STRIP_ROWS if (target_px and canvas_h > 0) else STRIP_ROWS / 12.0
    min_spacing = max(2, int(round(model.get("minSpacingFrac", MIN_SPACING_FRAC) * target_rows)))
    rows = _peak_pick(prob, min_spacing, model.get("probThreshold", CUT_PROB_THRESHOLD))
    # Map rows → canvas Y.
    return [int(round(r / float(STRIP_ROWS - 1) * canvas_h)) for r in rows]


def _validate_cuts(model, val_chapters):
    """Boundary recall/precision on holdout chapters (tolerance = LABEL_TOL rows)."""
    if not val_chapters:
        return {"boundaryRecall": None, "boundaryPrecision": None}
    tp = fp = fn = 0
    for feats, true_rows, canvas_h in val_chapters:
        clf = model["clf"]
        prob = clf.predict_proba(feats)[:, list(clf.classes_).index(1)] if 1 in clf.classes_ else np.zeros(len(feats))
        # Use a representative spacing of STRIP_ROWS/40 for the metric.
        pred = _peak_pick(prob, max(2, STRIP_ROWS // 40), model.get("probThreshold", CUT_PROB_THRESHOLD))
        true_list = sorted(true_rows)
        matched_true = set()
        for p in pred:
            hit = next((t for t in true_list if abs(t - p) <= LABEL_TOL * 2 and t not in matched_true), None)
            if hit is not None:
                tp += 1
                matched_true.add(hit)
            else:
                fp += 1
        fn += len(true_list) - len(matched_true)
    recall = tp / (tp + fn) if (tp + fn) else None
    precision = tp / (tp + fp) if (tp + fp) else None
    return {"boundaryRecall": recall, "boundaryPrecision": precision}
