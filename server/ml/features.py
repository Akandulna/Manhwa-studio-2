"""
Feature extraction — Module 3 AI: Auto-Crop (Stage B)

Centralizes the feature contract so that training (train.py, reading dataset
WebPs) and inference (suggest.py, reading live page pixels) compute identical
features. Also defines aspect-ratio preset helpers shared across the sidecar.

Outputs are deterministic and order-stable (see FEATURE_NAMES).
"""

import numpy as np

try:
    import cv2
    _HAVE_CV2 = True
except ImportError:  # pragma: no cover - exercised only when cv2 missing
    _HAVE_CV2 = False


# Aspect presets, ratio = width / height (must match the client ASPECT_RATIOS).
PRESETS = {
    "9:16": 9 / 16,
    "16:9": 16 / 9,
    "4:3": 4 / 3,
    "1:1": 1.0,
}
PRESET_ORDER = ["free", "9:16", "16:9", "4:3", "1:1"]

# Phase 1 visual embeddings: the PCA-reduced backbone embedding is appended to the
# feature vector as columns emb_00..emb_{EMBEDDING_DIM-1}. The model stores the
# fitted PCA + its feature_names, so older (pre-embedding) models simply omit
# these columns via build_feature_vector's projection.
EMBEDDING_DIM = 24


def emb_feature_names(dim=EMBEDDING_DIM):
    """Stable names for the embedding columns."""
    return ["emb_%02d" % i for i in range(dim)]


def nearest_preset(width: float, height: float, tolerance: float = 0.12) -> str:
    """Pick the closest aspect preset to a rect, or 'free' if none is close."""
    if height <= 0:
        return "free"
    ratio = width / height
    best_label, best_diff = "free", tolerance
    for label, pr in PRESETS.items():
        diff = abs(ratio - pr) / pr
        if diff < best_diff:
            best_label, best_diff = label, diff
    return best_label


def text_density(gray: "np.ndarray") -> float:
    """
    Heuristic fraction (0-1) of a grayscale region occupied by text.

    OCR-free, deterministic and scale-invariant: uses MSER (the classic text
    region detector) to find letter-like blobs in both polarities (dark-on-light
    and light-on-dark, so cream-on-black promo banners are caught too), keeps the
    ones whose size/elongation look like glyphs, then morphologically merges them
    into text lines and returns the fraction of the region those lines cover.

    Because it keys on glyph *shapes* rather than stroke pixel counts or a fixed
    line height, it handles both small speech-bubble dialogue and the huge bold
    "READ AT ..." watermark banners. Returns 0.0 when cv2 is unavailable.
    """
    if gray is None or gray.size == 0 or not _HAVE_CV2:
        return 0.0

    h, w = gray.shape[:2]
    if h < 12 or w < 12:
        return 0.0

    area = float(h * w)
    try:
        mser = cv2.MSER_create()
    except Exception:  # pragma: no cover - MSER missing in some builds
        return 0.0

    letter = np.zeros((h, w), dtype=np.uint8)
    found = False
    for src in (gray, 255 - gray):  # both text polarities
        try:
            _, bboxes = mser.detectRegions(src)
        except Exception:  # pragma: no cover
            continue
        for box in bboxes:
            x, y, bw_, bh_ = (int(box[0]), int(box[1]), int(box[2]), int(box[3]))
            if bh_ < 4 or bh_ > 0.85 * h:
                continue
            ar = bw_ / float(bh_)
            if ar < 0.08 or ar > 12.0:           # too thin / too wide to be a glyph
                continue
            if bw_ * bh_ > 0.18 * area:          # region-sized blob = art/background
                continue
            letter[y:y + bh_, x:x + bw_] = 1
            found = True

    if not found:
        return 0.0

    # Merge neighbouring glyphs into text-line regions, then measure coverage.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(5, w // 20), max(3, h // 20)))
    lines = cv2.morphologyEx(letter, cv2.MORPH_CLOSE, kernel)
    return float(lines.mean())


def image_features(gray: "np.ndarray", with_text: bool = True) -> dict:
    """
    Low-level appearance features for a grayscale region (uint8, HxW).
    Used identically on dataset WebP crops and on live page regions.

    text_density (MSER) is the most expensive op here; pass with_text=False to
    skip it on paths whose model doesn't consume the text features (rule-based
    and pre-text models), where the value would be computed then discarded.
    """
    if gray is None or gray.size == 0:
        return {"mean": 0.0, "std": 0.0, "edge_density": 0.0,
                "dark_frac": 0.0, "bright_frac": 0.0, "text_density": 0.0}

    g = gray.astype(np.float32)
    mean = float(g.mean()) / 255.0
    std = float(g.std()) / 255.0
    dark_frac = float((gray < 32).mean())
    bright_frac = float((gray > 223).mean())

    if _HAVE_CV2:
        edges = cv2.Canny(gray, 50, 150)
        edge_density = float((edges > 0).mean())
    else:  # pragma: no cover
        gx = np.abs(np.diff(g, axis=1)).mean() if g.shape[1] > 1 else 0.0
        edge_density = float(min(1.0, gx / 64.0))

    return {
        "mean": mean,
        "std": std,
        "edge_density": edge_density,
        "dark_frac": dark_frac,
        "bright_frac": bright_frac,
        "text_density": text_density(gray) if with_text else 0.0,
    }


# Stable feature vector layout shared by train.py and suggest.py.
# NOTE: appending here is backwards-compatible — build_feature_vector() can
# project onto an older model's stored feature_names so pre-text-feature models
# (e.g. v1) still run; they simply don't benefit from the text signal until the
# user retrains.
FEATURE_NAMES = [
    "norm_y",          # top position in the canvas (0-1)
    "norm_h",          # height as fraction of canvas height
    "norm_w",          # width as fraction of canvas width
    "aspect",          # width / height
    "seq_frac",        # crop index / count (reading position)
    "count",           # number of candidates in the chapter
    "dist_prev_norm",  # gap above (fraction of canvas height)
    "gap_next_norm",   # gap below (fraction of canvas height)
    "img_mean",
    "img_std",
    "img_edge_density",
    "img_dark_frac",
    "img_bright_frac",
    "img_text_density",  # how much of the crop looks like dialogue/lettering
    "ctx_mean",
    "ctx_std",
    "ctx_edge_density",
    "ctx_text_density",  # text presence just above/below the crop
]


def feature_dict(
    rect: dict,
    canvas_w: float,
    canvas_h: float,
    seq_index: int,
    count: int,
    dist_prev: float,
    gap_next: float,
    img_feats: dict,
    ctx_feats: dict,
) -> dict:
    """Named feature values for one candidate (single source of truth)."""
    w = max(1e-6, float(rect["canvasW"]))
    h = max(1e-6, float(rect["canvasH"]))
    cw = max(1e-6, float(canvas_w))
    ch = max(1e-6, float(canvas_h))

    return {
        "norm_y": float(rect["canvasY"]) / ch,
        "norm_h": h / ch,
        "norm_w": w / cw,
        "aspect": w / h,
        "seq_frac": (seq_index / count) if count > 0 else 0.0,
        "count": float(count),
        "dist_prev_norm": (dist_prev / ch) if dist_prev is not None else 0.0,
        "gap_next_norm": (gap_next / ch) if gap_next is not None else 0.0,
        "img_mean": img_feats.get("mean", 0.0),
        "img_std": img_feats.get("std", 0.0),
        "img_edge_density": img_feats.get("edge_density", 0.0),
        "img_dark_frac": img_feats.get("dark_frac", 0.0),
        "img_bright_frac": img_feats.get("bright_frac", 0.0),
        "img_text_density": img_feats.get("text_density", 0.0),
        "ctx_mean": ctx_feats.get("mean", 0.0),
        "ctx_std": ctx_feats.get("std", 0.0),
        "ctx_edge_density": ctx_feats.get("edge_density", 0.0),
        "ctx_text_density": ctx_feats.get("text_density", 0.0),
    }


def build_feature_vector(
    rect: dict,
    canvas_w: float,
    canvas_h: float,
    seq_index: int,
    count: int,
    dist_prev: float,
    gap_next: float,
    img_feats: dict,
    ctx_feats: dict,
    feature_names: list = None,
    embedding=None,
) -> "np.ndarray":
    """
    Assemble the feature vector for one candidate.

    Ordered by `feature_names` when given (used at inference to match the
    feature contract a model was trained with), else by the current
    FEATURE_NAMES. Unknown names resolve to 0.0.

    When `embedding` (a 1-D array of PCA-reduced backbone features) is provided,
    its values are exposed as emb_00.. columns and included if the requested
    feature_names reference them.
    """
    d = feature_dict(
        rect, canvas_w, canvas_h, seq_index, count, dist_prev, gap_next,
        img_feats, ctx_feats,
    )
    if embedding is not None:
        for i, v in enumerate(embedding):
            d["emb_%02d" % i] = float(v)
    names = feature_names if feature_names else FEATURE_NAMES
    return np.array([d.get(n, 0.0) for n in names], dtype=np.float32)
