"""
Stage A — Candidate panel detection (classical CV, no training required)

Detects candidate panel boundaries on the stitched vertical strip using
horizontal projection profiles: rows that are near-uniform (low cross-width
variance) are treated as gutters/whitespace; the textured spans between them
are candidate panels. Works on day one with zero training data.

Pages are read at reduced width but native height, so row indices map 1:1 to
virtual-canvas Y coordinates from the manifest.
"""

import os
import numpy as np

try:
    import cv2
    HAVE_CV2 = True
except ImportError:
    HAVE_CV2 = False

from features import image_features


# Detection constants (native canvas pixels unless noted).
TARGET_WIDTH = 400        # width pages are downscaled to for profiling
STD_THRESHOLD = 12.0      # row std (0-255) below this = uniform/gutter row
MIN_GUTTER_PX = 10        # min run of uniform rows to count as a separator
MIN_PANEL_PX = 32         # candidate panels shorter than this are dropped
CONTEXT_EXPAND = 0.5      # context region extends 50% above/below the panel

# Subdivision: a span is split into equal slices when it is meaningfully taller
# than the user's typical crop height (target). Stops the gutter detector from
# emitting one giant candidate where the user makes several finer cuts — the main
# cause of low recall. Only applied when a target_height_ratio is supplied.
SUBDIVIDE_TRIGGER = 1.4   # split spans taller than this * target height
SUBDIVIDE_MIN_SLICE = 24  # never produce slices shorter than this (px)


def _load_gray_pages(image_dir, manifest):
    """Load each page as a width-normalized grayscale array (native height)."""
    pages = []
    for img in manifest["images"]:
        path = os.path.join(image_dir, img["filename"])
        im = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if im is None:
            continue
        h0, w0 = im.shape
        if w0 != TARGET_WIDTH:
            im = cv2.resize(im, (TARGET_WIDTH, h0), interpolation=cv2.INTER_AREA)
        pages.append({"canvasY": int(img["canvasY"]), "gray": im})
    return pages


def _build_strip(pages, canvas_height):
    """Assemble the full-canvas grayscale strip (canvas_height x TARGET_WIDTH)."""
    strip = np.full((canvas_height, TARGET_WIDTH), 255, dtype=np.uint8)
    for p in pages:
        y0 = p["canvasY"]
        g = p["gray"]
        h = min(g.shape[0], canvas_height - y0)
        if h > 0:
            strip[y0:y0 + h, :] = g[:h, :]
    return strip


def _find_runs(mask):
    """Yield (start, end_exclusive) runs of True values in a 1-D boolean array."""
    runs = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def build_canvas_strip(image_dir, manifest):
    """
    Build the full-canvas grayscale strip (canvas_h x TARGET_WIDTH) for a chapter.
    Shared by inference (detect_candidates) and the cut-detector trainer so both
    see identical pixels. Returns (strip, canvas_w, canvas_h) or (None, w, h).
    """
    if not HAVE_CV2:
        raise RuntimeError("opencv is required for panel detection")
    canvas_w = int(manifest["canvasWidth"])
    canvas_h = int(manifest["canvasHeight"])
    pages = _load_gray_pages(image_dir, manifest)
    if not pages or canvas_h <= 0:
        return None, canvas_w, canvas_h
    return _build_strip(pages, canvas_h), canvas_w, canvas_h


def _subdivide_span(top, bottom, target_px):
    """Split a [top, bottom) span into ~equal slices of ~target_px tall.

    Returns a list of (top, bottom) tuples. A span only splits when it is
    >SUBDIVIDE_TRIGGER * target_px; otherwise it is returned unchanged.
    """
    height = bottom - top
    if target_px <= 0 or height <= SUBDIVIDE_TRIGGER * target_px:
        return [(top, bottom)]
    n = max(2, int(round(height / target_px)))
    # Don't create slices below the minimum useful height.
    n = min(n, max(1, int(height // SUBDIVIDE_MIN_SLICE)))
    if n <= 1:
        return [(top, bottom)]
    edges = [int(round(top + i * height / n)) for i in range(n + 1)]
    edges[0], edges[-1] = top, bottom
    return [(edges[i], edges[i + 1]) for i in range(n) if edges[i + 1] > edges[i]]


def _learned_spans(strip, canvas_w, canvas_h, cut_model, target_px):
    """Spans between learned cut boundaries (Phase B). Empty list on failure."""
    try:
        import cutdetect
        feats = cutdetect._windowize(cutdetect._row_features(strip))
        cut_ys = cutdetect.predict_cut_rows(cut_model, feats, canvas_h, target_px, canvas_w)
        bounds = sorted(set([0] + [y for y in cut_ys if 0 < y < canvas_h] + [canvas_h]))
        return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)
                if bounds[i + 1] - bounds[i] >= MIN_PANEL_PX]
    except Exception as e:  # pragma: no cover - fall back to gutters
        import sys
        sys.stderr.write("Learned cut detection failed, using gutters: %s\n" % e)
        return []


def detect_candidates(image_dir, manifest, with_text=True, with_embeddings=False,
                      target_height_ratio=None, cut_model=None):
    """
    Returns a list of candidate panels (top-to-bottom):
      { canvasX, canvasY, canvasW, canvasH, img_feats, ctx_feats, gutter_strength }

    with_text is forwarded to image_features; pass False to skip the expensive
    text-density pass when the consuming model doesn't use that feature.

    with_embeddings attaches the raw grayscale region array ("img_region") to each
    candidate so the caller can compute a visual embedding. The array stays
    in-process (never serialized), so the only cost is not discarding the slice.

    target_height_ratio (crop height as a fraction of canvas WIDTH, learned from
    the user's own crops) makes tall gutter-spans subdivide to match how finely
    the user actually cuts — the main lever for recall. None disables splitting.
    """
    if not HAVE_CV2:
        raise RuntimeError("opencv is required for panel detection")

    canvas_w = int(manifest["canvasWidth"])
    canvas_h = int(manifest["canvasHeight"])

    pages = _load_gray_pages(image_dir, manifest)
    if not pages or canvas_h <= 0:
        return []

    strip = _build_strip(pages, canvas_h)

    # Per-row uniformity profile over the whole canvas.
    row_std = strip.std(axis=1)
    uniform = row_std < STD_THRESHOLD

    # Separators = long runs of uniform rows.
    separators = [(s, e) for (s, e) in _find_runs(uniform) if (e - s) >= MIN_GUTTER_PX]

    # Content spans = gaps between separators.
    spans = []
    prev_end = 0
    for (s, e) in separators:
        if s - prev_end >= MIN_PANEL_PX:
            spans.append((prev_end, s))
        prev_end = e
    if canvas_h - prev_end >= MIN_PANEL_PX:
        spans.append((prev_end, canvas_h))

    target_px = (target_height_ratio * canvas_w) if (target_height_ratio and target_height_ratio > 0) else 0

    if cut_model is not None:
        # Phase B: use boundaries the model learned from the user's own cuts.
        learned = _learned_spans(strip, canvas_w, canvas_h, cut_model, target_px)
        if learned:
            spans = learned
        elif target_px:  # fall back to gutters + density subdivision
            spans = [piece for (top, bottom) in spans for piece in _subdivide_span(top, bottom, target_px)]
    elif target_px:
        # Subdivide tall gutter-spans toward the user's typical crop height so
        # candidate density matches how finely they cut (raises recall).
        spans = [piece for (top, bottom) in spans for piece in _subdivide_span(top, bottom, target_px)]

    # Fallback: no clear gutters → coarse fixed-height tiling so Stage A still
    # produces something usable (clearly weaker, but never empty).
    if not spans:
        tile = max(MIN_PANEL_PX, int(canvas_w * 1.4))
        spans = [(y, min(y + tile, canvas_h)) for y in range(0, canvas_h, tile)]

    candidates = []
    n = len(spans)
    for top, bottom in spans:
        height = bottom - top
        region = strip[top:bottom, :]
        img_feats = image_features(region, with_text=with_text)

        ctx_top = max(0, int(top - height * CONTEXT_EXPAND))
        ctx_bottom = min(canvas_h, int(bottom + height * CONTEXT_EXPAND))
        ctx_feats = image_features(strip[ctx_top:ctx_bottom, :], with_text=with_text)

        # gutter_strength: how clean the bounding gutters are (0-1).
        border = 4
        above = uniform[max(0, top - border):top]
        below = uniform[bottom:min(canvas_h, bottom + border)]
        gutter_strength = float(np.mean(np.concatenate([above, below]))) if (above.size + below.size) else 0.0

        cand = {
            "canvasX": 0.0,
            "canvasY": float(top),
            "canvasW": float(canvas_w),
            "canvasH": float(height),
            "img_feats": img_feats,
            "ctx_feats": ctx_feats,
            "gutter_strength": gutter_strength,
        }
        if with_embeddings:
            cand["img_region"] = region  # grayscale slice, for embedding
        candidates.append(cand)

    return candidates
