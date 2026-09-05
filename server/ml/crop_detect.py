"""
Image Clipper 2.0 — offline four-point crop detection (classical CV).

Implements the geometry half of the Manhwa Crop Detection Guidelines v2.4:
container detection (CB), four-side edge resolution (ED), angled edges (AN),
overlay exclusion (OV), whitespace (WS) and per-crop coordinate independence
(IX). It is a third way to get pointers, alongside the manual loop and Gemini:
no network, no API key, no quota.

WHAT THIS SCRIPT DOES NOT DO
----------------------------
It does not emit the `four-point-crop` artifact. It returns CANVAS RECTS and the
TypeScript side turns them into P1..P4 via `entryFromCanvasRect`, then normalizes,
validates and serializes through `fourPointSchema`. That module already owns every
OUT-* rule and the canonical serializer (`OUT-15`), and having two implementations
of the emission format — one here, one there — is how they drift apart.

Nor does it stitch. Stitching geometry comes from the caller's manifest, because
the canvas is *scaled*, not raw-stacked: every slice is scaled up to the widest
page (W_ref), so a page's own height is not the height it occupies on the canvas.
Re-deriving that here from the image files is the bug documented in
IMAGE_CLIPPER_2.md §3, which put crops 16,000-31,000px out on mixed-width chapters.

The Section Relevance gate (SR) is only PARTIALLY automatable. Everything that is a
measurement is done here; everything that is a judgement about meaning is routed
through `sr_gate` and flagged for review, so a human (or a vision model) only has
to answer a yes/no question about a handful of sections instead of measuring pages.

Protocol
--------
Reads one JSON request on stdin, writes line-delimited JSON envelopes on stdout:
    {"event": "progress", "phase": ..., "percent": ..., "message": ...}
    {"event": "result",   "crops": [...], "skipped": [...], "warnings": [...]}
    {"event": "error",    "message": ...}

`--check` probes imports and exits 0 with "ok" — same contract as suggest.py.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any

import numpy as np

try:
    from PIL import Image
    from scipy import ndimage
    HAVE_DEPS = True
    DEP_ERROR = ""
except ImportError as exc:  # pragma: no cover - probed by --check
    HAVE_DEPS = False
    DEP_ERROR = str(exc)

# Pillow ships a decompression-bomb guard at ~89M pixels. A stitched webtoon
# chapter legitimately exceeds that (968 x 137,159 is real), and these are local
# files the user downloaded, not untrusted uploads.
if HAVE_DEPS:
    Image.MAX_IMAGE_PIXELS = None


# ───────────────────────────── configuration ─────────────────────────────

@dataclass
class Config:
    """Every tunable in one place. Defaults suit dark-background webtoons."""

    # --- resampling -------------------------------------------------------
    # Detection runs on a downscaled canvas and the rects are projected back up.
    # A full chapter is ~240M px at native size and the morphology over it takes
    # over a minute; at 600 the same chapter takes ~17s and scores identically
    # against the hand-cut ground truth (measured: 62% recall either way).
    # Edge placement is accurate to (canvas_w / detect_width) px — ~1.6px on a
    # 968px chapter, below the breakout margin that gets added anyway.
    detect_width: int = 600

    # --- gutter / ink separation -----------------------------------------
    gutter_level: int = 10        # max(RGB) <= this is page gutter, not artwork
    max_gutter_lift: int = 60     # ceiling on the per-page gutter levelling
    white_level: int = 205        # min(RGB) >  this is "paper white" (bubble fill)
    sat_floor: float = 0.10       # below this a pixel is greyscale

    # --- what can be a container (SR-01 lower bound) ----------------------
    # Areas/lengths are in SOURCE canvas px and scaled to detect space internally,
    # so a tuning value means the same thing regardless of detect_width.
    min_panel_area: int = 40_000
    min_panel_width: int = 60
    min_panel_height: int = 60

    # --- overlay detection (OV) ------------------------------------------
    bubble_min_area: int = 5_000        # solid white blob big enough to be a bubble
    bubble_fill_ratio: float = 0.50     # solidity once its tail is opened away
    bubble_open_radius: int = 8         # opening that removes bubble tails/spikes
    bubble_ring_dark: float = 0.50      # fraction of surrounding ring in gutter
    bubble_color_max: float = 0.20      # a real bubble has NO artwork inside it
    bubble_dilate: int = 8              # grow to swallow the bubble's black outline
    glyph_max_area: int = 5_000         # white components this small may be text
    glyph_cluster_gap: int = 40         # dilation that groups glyphs into a block
    text_block_color_max: float = 0.25  # coloured fraction allowed in a text bbox
    text_block_gutter_min: float = 0.55 # text sits on bare page, not on artwork

    # --- container assembly ----------------------------------------------
    bridge_erosion: int = 2       # severs thin overlay-to-panel contacts
    breakout_margin: int = 4      # NC-05 breathing room so artwork is never clipped

    # A container enclosing at least this many others, which together cover this
    # much of its area, is a merged background rather than a section of its own.
    nest_min_children: int = 2
    nest_cover_ratio: float = 0.55

    # --- row profile (vertical-scroll sectioning) -------------------------
    # A row with no more than this fraction of ink across its width is gutter.
    row_ink_max: float = 0.02
    # A column lit in at least this fraction of a section's rows is artwork.
    col_ink_min: float = 0.02
    min_gutter_rows: int = 10     # shortest run of gutter that separates beats
    # Gutter shorter than this does not end a section: a background band inside a
    # scene is not a boundary. Sections in the hand-cut chapters here span several.
    merge_gutter_rows: int = 120
    min_section_rows: int = 200   # shorter than this is a seam, not a section
    # Typical beat height as a multiple of canvas width. Measured at ~1.3 across
    # the hand-checked chapters in this library.
    target_height_ratio: float = 1.3
    # Split only a span comfortably past one beat. Tuned against the hand-cut
    # chapters in this library: 1.6 cut real sections in half, and disabling
    # subdivision entirely dropped recall from 62% to 38%, because gutter-free
    # continuous artwork is common and one 40,000px span matches nothing.
    subdivide_trigger: float = 1.8

    # --- SR heuristics ----------------------------------------------------
    line_density_floor: float = 0.012  # below this, likely background-only (SR-05)
    mono_frac_ceiling: float = 0.93    # above this, pure B/W => text/branding

    # --- gutter polarity --------------------------------------------------
    # 'auto' samples the canvas border; 'dark' and 'light' force it. A light-gutter
    # page is inverted before masking so one set of rules covers both.
    gutter_mode: str = "auto"

    # Turning this off keeps bubbles and watermarks as ordinary artwork, which is
    # the right call on a chapter whose panels are pale enough to be mistaken for
    # bubble fill and get eaten by the filter.
    filter_overlays: bool = True

    def scaled(self, factor: float) -> "Config":
        """This config expressed in detect-space pixels.

        Lengths scale by `factor`, areas by `factor**2`, ratios not at all. Doing
        this once here is what lets every threshold above be quoted in canvas px.
        """
        def length(v: int, floor: int = 1) -> int:
            return max(floor, int(round(v * factor)))

        def area(v: int, floor: int = 1) -> int:
            return max(floor, int(round(v * factor * factor)))

        return Config(
            detect_width=self.detect_width,
            gutter_level=self.gutter_level,
            max_gutter_lift=self.max_gutter_lift,
            white_level=self.white_level,
            sat_floor=self.sat_floor,
            min_panel_area=area(self.min_panel_area),
            min_panel_width=length(self.min_panel_width),
            min_panel_height=length(self.min_panel_height),
            bubble_min_area=area(self.bubble_min_area),
            bubble_fill_ratio=self.bubble_fill_ratio,
            # Morphological radii have a floor of 1: rounding them to 0 would turn
            # the opening and the dilation into no-ops and silently disable the
            # whole overlay filter on a heavily downscaled canvas.
            bubble_open_radius=length(self.bubble_open_radius),
            bubble_ring_dark=self.bubble_ring_dark,
            bubble_color_max=self.bubble_color_max,
            bubble_dilate=length(self.bubble_dilate),
            glyph_max_area=area(self.glyph_max_area),
            glyph_cluster_gap=length(self.glyph_cluster_gap),
            text_block_color_max=self.text_block_color_max,
            text_block_gutter_min=self.text_block_gutter_min,
            bridge_erosion=length(self.bridge_erosion) if self.bridge_erosion else 0,
            breakout_margin=length(self.breakout_margin) if self.breakout_margin else 0,
            nest_min_children=self.nest_min_children,
            nest_cover_ratio=self.nest_cover_ratio,
            row_ink_max=self.row_ink_max,
            col_ink_min=self.col_ink_min,
            min_gutter_rows=length(self.min_gutter_rows),
            merge_gutter_rows=length(self.merge_gutter_rows),
            min_section_rows=length(self.min_section_rows),
            target_height_ratio=self.target_height_ratio,
            subdivide_trigger=self.subdivide_trigger,
            line_density_floor=self.line_density_floor,
            mono_frac_ceiling=self.mono_frac_ceiling,
            gutter_mode=self.gutter_mode,
            filter_overlays=self.filter_overlays,
        )


# ───────────────────────────── ST: the canvas ────────────────────────────

def build_canvas(
    image_dir: str, manifest: dict, cfg: Config, warn
) -> tuple[np.ndarray, float, list[tuple[int, int]]]:
    """Assemble the chapter's combined logical page as an RGB array.

    Geometry comes from the manifest, never from the files: `canvasY` and
    `canvasHeight` already encode reference-width scaling (W_ref = widest page),
    so a 713px slice on a 968px canvas occupies more rows than it has pixels.

    Returns (rgb, factor, page_rows) where `factor` converts detect px -> canvas
    px and `page_rows` is each placed page's [y0, y1) span in detect space, which
    is what lets polarity be resolved per page.
    """
    import os

    canvas_w = int(manifest["canvasWidth"])
    canvas_h = int(manifest["canvasHeight"])
    if canvas_w <= 0 or canvas_h <= 0:
        raise ValueError("manifest has a zero-sized canvas")

    detect_w = max(1, min(int(cfg.detect_width), canvas_w))
    scale = detect_w / canvas_w          # canvas px -> detect px
    factor = canvas_w / detect_w         # detect px -> canvas px
    detect_h = max(1, int(round(canvas_h * scale)))

    # Gutter-coloured ground, so a gap between segments reads as background
    # rather than as a bright band that would anchor a container.
    strip = np.zeros((detect_h, detect_w, 3), dtype=np.uint8)

    page_rows: list[tuple[int, int]] = []
    for img in manifest["images"]:
        path = os.path.join(image_dir, img["filename"])
        try:
            with Image.open(path) as im:
                im = im.convert("RGB")
                # Resize to the slice's extent ON THE CANVAS (its scaled height),
                # not its own pixel height.
                target_h = max(1, int(round(float(img["canvasHeight"]) * scale)))
                im = im.resize((detect_w, target_h), Image.LANCZOS)
                arr = np.asarray(im, dtype=np.uint8)
        except Exception as exc:
            warn(f"Could not read {img['filename']}: {exc}")
            continue

        y0 = int(round(float(img["canvasY"]) * scale))
        if y0 >= detect_h:
            continue
        h = min(arr.shape[0], detect_h - y0)
        if h > 0:
            strip[y0:y0 + h, :, :] = arr[:h, :, :]
            page_rows.append((y0, y0 + h))

    if not page_rows:
        raise ValueError("no page images could be read")

    return strip, factor, page_rows


# ───────────────────────────── pixel masks ───────────────────────────────

def _margin_luma(rgb: np.ndarray) -> float:
    """Median luma of the left+right margins of a band of canvas.

    Vertical edges are gutter far more reliably than horizontal ones, where a
    full-bleed panel routinely touches both the top and the bottom. The median,
    not the mean: a bright inset touching one edge skews a mean but barely moves
    a median.
    """
    w = rgb.shape[1]
    band = max(1, w // 20)
    margins = np.concatenate([
        rgb[:, :band, :].reshape(-1, 3),
        rgb[:, w - band:, :].reshape(-1, 3),
    ])
    return float(np.median(margins.max(axis=1)))


def level_page(rgb: np.ndarray, rows: list[tuple[int, int]], cfg: Config) -> None:
    """Lift each page's own gutter to true black, in place.

    `gutter_level` is a single constant, but a chapter's gutter is not: in one
    real chapter here the opening splash is a dark grey wash sitting at luma ~27
    while the following pages are pure white (luma 0 once inverted). A fixed
    threshold cannot serve both — at 10 the splash's gutter reads as artwork and
    47% of that page becomes one container; at 30 the white pages start eating
    genuine dark line art.

    So instead of widening the threshold, each page is levelled to it: measure the
    gutter the page actually has from its margins, subtract it, and let the shared
    constant mean the same thing everywhere. Subtracting (rather than thresholding
    here) keeps this a contrast adjustment — the masks still make every real
    decision.
    """
    for y0, y1 in rows:
        if y1 <= y0:
            continue
        page = rgb[y0:y1]
        w = page.shape[1]
        band = max(1, w // 20)
        margins = np.concatenate([
            page[:, :band, :].reshape(-1, 3),
            page[:, w - band:, :].reshape(-1, 3),
        ]).max(axis=1)
        # The 65th percentile, not the median: margins carry some real artwork
        # where a panel runs to the edge, and under-estimating the gutter is the
        # safer error — it leaves a faint wash as artwork rather than clipping
        # genuine dark line art away.
        floor = float(np.percentile(margins, 65))
        if floor <= cfg.gutter_level:
            continue
        # Cap the lift so a page that is genuinely bright everywhere (a white-hot
        # flashback panel) cannot have its whole content subtracted away.
        lift = int(min(floor, cfg.max_gutter_lift))
        np.subtract(page, np.uint8(lift), out=page, where=page > lift)
        page[page <= lift] = 0


def normalize_polarity(rgb: np.ndarray, rows: list[tuple[int, int]], cfg: Config) -> str:
    """Flip light-gutter regions in place so the whole canvas reads dark-gutter.

    Polarity is decided PER PAGE, not once for the chapter. A real chapter here
    opens on a dark splash (margin luma 27) and continues on white pages (209,
    255): inverting globally leaves more than half the canvas with its gutter as
    foreground, the ink mask covers ~71% of the page, and connected-component
    labeling then merges whole pages into one blob with every real panel nested
    inside it.

    Normalizing each page separately means one dark-gutter rule set covers a
    mixed chapter, which is the common case rather than the exotic one.

    Returns the mode label for the sidecar: 'dark', 'light', or 'mixed'.
    """
    if cfg.gutter_mode == "dark":
        return "dark"
    if cfg.gutter_mode == "light":
        np.subtract(255, rgb, out=rgb)
        return "light"

    inverted = 0
    for y0, y1 in rows:
        if y1 <= y0:
            continue
        page = rgb[y0:y1]
        if _margin_luma(page) > 127.0:
            # In-place: a full-canvas copy of a 297k x 800 x 3 array is ~700MB.
            np.subtract(255, page, out=page)
            inverted += 1

    if inverted == 0:
        return "dark"
    if inverted == len(rows):
        return "light"
    return "mixed"


def build_masks(rgb: np.ndarray, cfg: Config) -> dict[str, np.ndarray]:
    """Split the page into gutter / ink / paper-white / coloured artwork."""
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)

    ink = mx > cfg.gutter_level                     # anything that is not gutter
    white = mn > cfg.white_level                    # bubble / narration fill

    # saturation = (mx - mn) / mx, but compared rather than computed: the float
    # division over a 240M-pixel canvas costs seconds and allocates twice the
    # canvas in float64. (mx - mn) > sat_floor * mx is the same test in uint8.
    chroma = mx - mn
    colored = (chroma > (mx.astype(np.uint16) * cfg.sat_floor).astype(np.uint16)) & (mx > 40)

    # `luma` is consumed by the Sobel pass, which needs signed headroom.
    return {"ink": ink, "white": white, "colored": colored, "luma": mx.astype(np.int16)}


def line_density(luma: np.ndarray, box: tuple[int, int, int, int]) -> float:
    """Fraction of pixels sitting on a strong edge — a proxy for line art.

    Flat sky, gradients and bokeh score near zero; drawn characters and panel
    detail score high. Used only as an SR-05 *hint*, never a verdict.
    """
    y0, y1, x0, x1 = box
    patch = luma[y0:y1, x0:x1].astype(np.float32)
    if patch.size < 400:
        return 0.0
    gy = ndimage.sobel(patch, axis=0)
    gx = ndimage.sobel(patch, axis=1)
    mag = np.hypot(gx, gy)
    return float((mag > 120).mean())


# ───────────────────────────── OV: overlays ──────────────────────────────

def _blob_fill(comp: np.ndarray, radius: int) -> float:
    """Solidity of a component after its tails are opened away.

    A speech bubble is a solid blob with a thin pointer tail. Measuring fill over
    the raw bounding box lets the tail halve the score and the bubble escapes
    detection, so open the shape first and measure only the body.
    """
    disk = np.ones((2 * radius + 1, 2 * radius + 1), bool)
    opened = ndimage.binary_opening(comp, disk)
    total = int(opened.sum())
    # Scale the "did anything survive" floor with the opening radius; a fixed 500
    # px floor is meaningless once the canvas is downscaled.
    if total < max(16, radius * radius):
        return 0.0
    rows = np.nonzero(opened.any(axis=1))[0]
    cols = np.nonzero(opened.any(axis=0))[0]
    bbox = (rows[-1] - rows[0] + 1) * (cols[-1] - cols[0] + 1)
    return float(total) / max(int(bbox), 1)


def _ring_darkness(ink: np.ndarray, box, pad: int = 14) -> float:
    """Fraction of the band just outside `box` that is page gutter."""
    y0, y1, x0, x1 = box
    H, W = ink.shape
    oy0, oy1 = max(0, y0 - pad), min(H, y1 + pad)
    ox0, ox1 = max(0, x0 - pad), min(W, x1 + pad)
    outer = ink[oy0:oy1, ox0:ox1]
    total = outer.size - (y1 - y0) * (x1 - x0)
    if total <= 0:
        return 0.0
    lit = int(outer.sum()) - int(ink[y0:y1, x0:x1].sum())
    return 1.0 - float(lit) / total


def detect_overlays(masks: dict, cfg: Config) -> np.ndarray:
    """OV-01..OV-09: speech bubbles, narration boxes, watermark text.

    Overlays are removed from the page BEFORE containers are assembled, so they
    can never anchor or enlarge a crop.
    """
    ink, white, colored = masks["ink"], masks["white"], masks["colored"]
    overlay = np.zeros_like(ink)

    lbl, n = ndimage.label(white)
    if n == 0:
        return overlay
    objects = ndimage.find_objects(lbl)
    # np.bincount, not ndimage.sum_labels: identical result for a count of set
    # pixels per label, and ~9s faster on a chapter with ~42,000 components.
    areas = np.bincount(lbl.ravel(), minlength=n + 1)[1:]

    glyphs = np.zeros_like(ink)
    ring_pad = max(2, cfg.bubble_dilate * 2)

    for i, sl in enumerate(objects, start=1):
        if sl is None:
            continue
        area = float(areas[i - 1])
        ys, xs = sl
        box = (ys.start, ys.stop, xs.start, xs.stop)
        comp = lbl[sl] == i

        # --- speech / narration bubble: a solid blob floating in the gutter with
        # nothing drawn inside it. The interior test is what separates a bubble
        # from a pale panel background (both are big, white and solid).
        #
        # Test order is load-bearing, not stylistic. `_blob_fill` runs a
        # morphological opening over the component's bounding box and dominates
        # the whole pass; on a full chapter, running it on every white component
        # costs ~60s. Every cheaper test is a filter in front of it, and the
        # bbox-solidity prefilter below discards the shapes it would reject
        # anyway — a component whose raw fill is already hopeless cannot pass
        # once erosion has taken more away.
        if area >= cfg.bubble_min_area:
            bbox_area = max(1, (box[1] - box[0]) * (box[3] - box[2]))
            raw_fill = area / bbox_area
            if (
                raw_fill >= cfg.bubble_fill_ratio * 0.75
                and colored[ys, xs][comp].mean() <= cfg.bubble_color_max
                and _ring_darkness(ink, box, ring_pad) >= cfg.bubble_ring_dark
                and _blob_fill(comp, cfg.bubble_open_radius) >= cfg.bubble_fill_ratio
            ):
                overlay[sl] |= comp
                continue

        # --- candidate text glyph (narration line, watermark, credit)
        if area <= cfg.glyph_max_area:
            glyphs[sl] |= comp

    # Group glyphs into text blocks. A block only counts as narration or branding
    # if it sits on BARE PAGE — mostly gutter between the letters, and no artwork
    # under it. Without the gutter test the pale background of a bright panel
    # fragments into thousands of "glyphs" and the panel eats itself.
    if glyphs.any():
        # A wide rectangular dilation is separable, and `maximum_filter1d` over
        # each axis is the same operation an order of magnitude faster: dilating
        # with a 3 x 40 element in one call costs ~31s on a full chapter, this
        # costs under 2s.
        grouped = ndimage.maximum_filter1d(glyphs, size=cfg.glyph_cluster_gap, axis=1)
        grouped = ndimage.maximum_filter1d(grouped, size=3, axis=0)
        gl, _ = ndimage.label(grouped)
        for sl in ndimage.find_objects(gl):
            if sl is None:
                continue
            ys, xs = sl
            on_bare_page = (~ink[ys, xs]).mean() >= cfg.text_block_gutter_min
            no_artwork = colored[ys, xs].mean() <= cfg.text_block_color_max
            if on_bare_page and no_artwork:
                overlay[ys, xs] |= glyphs[ys, xs]

    # Grow overlays to swallow their own black outlines and drop shadows.
    # N iterations of an 8-connected dilation is a (2N+1) square, which separates
    # into two 1-D maximum filters.
    if overlay.any() and cfg.bubble_dilate > 0:
        size = 2 * cfg.bubble_dilate + 1
        overlay = ndimage.maximum_filter1d(overlay, size=size, axis=1)
        overlay = ndimage.maximum_filter1d(overlay, size=size, axis=0)
    return overlay


# ────────────────────── CB / ED / AN: containers ─────────────────────────

@dataclass
class Container:
    y0: int
    y1: int
    x0: int
    x1: int
    area: int
    line_density: float
    colored_frac: float
    mono_frac: float
    verdict: str = "keep"
    reason: str = ""


# ─────────────────────── row profile: reading beats ──────────────────────

def gutter_rows(masks: dict, cfg: Config) -> np.ndarray:
    """Boolean per canvas row: True where the row is bare gutter across its width.

    This is the vertical-scroll equivalent of a panel border. A webtoon has no
    panel grid to trace — artwork runs edge to edge and the only reliable
    structure is the horizontal band of background between one beat and the next.
    """
    ink = masks["ink"]
    return ink.mean(axis=1) <= cfg.row_ink_max


def section_spans(masks: dict, cfg: Config, canvas_w_detect: int) -> list[tuple[int, int]]:
    """Cut the strip into reading beats between gutter bands (ST/CB for scroll).

    Ground truth across five hand-checked chapters here: 70-85% of sections are
    full width, 19-54% overlap their predecessor, and the median section is about
    1.3x the canvas width tall. That is not a panel grid — connected components
    cannot produce overlapping full-width sections at all — so the primary
    structure has to come from the row profile, with components used only to
    tighten horizontal bounds afterwards.
    """
    gut = gutter_rows(masks, cfg)
    h = gut.shape[0]

    runs = _find_runs(gut)
    separators = [(s, e) for (s, e) in runs if (e - s) >= cfg.min_gutter_rows]

    spans: list[tuple[int, int]] = []
    prev = 0
    for s, e in separators:
        if s > prev:
            spans.append((prev, s))
        prev = e
    if h > prev:
        spans.append((prev, h))

    if not spans:
        return [(0, h)]

    # Merge across a thin gutter before anything else. A band of background
    # inside a scene — sky between two rooftops, a gap between two speech
    # bubbles — is not a section boundary, and the hand-cut chapters here bear
    # that out: their sections routinely swallow several such bands. Only a
    # generous run of gutter genuinely ends a beat.
    merged: list[list[int]] = [list(spans[0])]
    for top, bottom in spans[1:]:
        if top - merged[-1][1] <= cfg.merge_gutter_rows:
            merged[-1][1] = bottom
        else:
            merged.append([top, bottom])

    # Now drop what is too short to be a section on its own — after merging, so a
    # sliver adjacent to real artwork is absorbed rather than discarded.
    kept = [(a, b) for a, b in merged if b - a >= cfg.min_section_rows]
    if not kept:
        return [(0, h)]

    # Split a span that is much taller than a typical beat. Continuous artwork
    # with no gutter at all is common in a scroll webtoon, and one 40,000px
    # "section" is not a crop anyone can use.
    target = cfg.target_height_ratio * canvas_w_detect
    out: list[tuple[int, int]] = []
    for top, bottom in kept:
        out.extend(_subdivide(top, bottom, target, cfg))
    return out


def _find_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """(start, end_exclusive) runs of True in a 1-D boolean array."""
    if not mask.any():
        return []
    padded = np.concatenate([[False], mask, [False]])
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return list(zip(edges[0::2].tolist(), edges[1::2].tolist()))


def _subdivide(top: int, bottom: int, target: float, cfg: Config) -> list[tuple[int, int]]:
    """Split an over-tall span into equal beats of roughly `target` rows."""
    height = bottom - top
    if target <= 0 or height <= cfg.subdivide_trigger * target:
        return [(top, bottom)]
    n = max(2, int(round(height / target)))
    n = min(n, max(1, height // max(1, cfg.min_section_rows)))
    if n <= 1:
        return [(top, bottom)]
    edges = [int(round(top + i * height / n)) for i in range(n + 1)]
    edges[0], edges[-1] = top, bottom
    return [(edges[i], edges[i + 1]) for i in range(n) if edges[i + 1] > edges[i]]


def find_containers(masks: dict, overlay: np.ndarray, cfg: Config) -> list[Container]:
    """CB-01/CB-07 + ED-01..ED-08 + AN-01..AN-07.

    Sections come from the row profile; horizontal bounds come from the columns
    lit inside each section. Taking the axis-aligned extent satisfies AN-02 (the
    crop stays rectangular) and AN-03 (the outer extent of an angled edge is that
    extent) with no special-casing, and measuring each section's columns on its
    own is what gives IX-01..IX-07 for free — no crop can inherit a neighbour's
    left or right edge.

    A section that splits cleanly into side-by-side panels is emitted as those
    panels instead, which is the print-comic case; see `split_columns`.
    """
    ink, colored, luma = masks["ink"], masks["colored"], masks["luma"]
    H, W = ink.shape
    body = ink & ~overlay

    out: list[Container] = []
    for span in section_spans(masks, cfg, W):
        for x0, x1, y0, y1 in split_columns(body, span, cfg):
            # NC-05 breathing room so artwork is never clipped.
            pad = cfg.breakout_margin
            y0, y1 = max(0, y0 - pad), min(H, y1 + pad)
            x0, x1 = max(0, x0 - pad), min(W, x1 + pad)

            if (y1 - y0) < cfg.min_panel_height or (x1 - x0) < cfg.min_panel_width:
                continue
            area = int(body[y0:y1, x0:x1].sum())
            if area < cfg.min_panel_area:
                continue

            box = (y0, y1, x0, x1)
            lit = max(int(ink[y0:y1, x0:x1].sum()), 1)
            col = float(colored[y0:y1, x0:x1].sum()) / lit
            out.append(Container(
                y0=y0, y1=y1, x0=x0, x1=x1,
                area=area,
                line_density=line_density(luma, box),
                colored_frac=col,
                mono_frac=1.0 - col,
            ))

    out.sort(key=lambda c: (c.y0, c.x0))  # OUT-07
    return out


def split_columns(body: np.ndarray, span: tuple[int, int], cfg: Config) -> list[tuple[int, int, int, int]]:
    """Side-by-side panels within one section, or the section itself.

    A print-style page puts two or three panels in a row separated by a vertical
    gutter; a scroll webtoon almost never does. Rather than assume either, look
    for full-height vertical gutters inside the section and split on them only
    when they are actually there — so `framed_*` insets get real bounds and a
    full-bleed scroll beat stays one crop.

    Returns (x0, x1, y0, y1) tuples, with y tightened to each column's own rows.
    """
    y0, y1 = span
    band = body[y0:y1]
    if band.size == 0:
        return []

    col = band.mean(axis=0)
    lit_cols = col > cfg.col_ink_min
    runs = [(s, e) for (s, e) in _find_runs(lit_cols) if (e - s) >= cfg.min_panel_width]

    # One run (or none usable) means there is nothing to split on.
    if len(runs) <= 1:
        x0, x1 = (runs[0] if runs else (0, band.shape[1]))
        rows = np.flatnonzero(band[:, x0:x1].mean(axis=1) > cfg.row_ink_max)
        if rows.size == 0:
            return [(x0, x1, y0, y1)]
        return [(x0, x1, y0 + int(rows[0]), y0 + int(rows[-1]) + 1)]

    out = []
    for x0, x1 in runs:
        rows = np.flatnonzero(band[:, x0:x1].mean(axis=1) > cfg.row_ink_max)
        if rows.size == 0:
            continue
        out.append((x0, x1, y0 + int(rows[0]), y0 + int(rows[-1]) + 1))
    return out


# ───────────────────────────── SR: relevance ─────────────────────────────

def sr_gate(c: Container, cfg: Config) -> tuple[bool, str]:
    """Stage 1 gate. Returns (keep, verdict).

    Automatable rules are enforced. SR-05 (background-only) is genuinely a
    judgement call — flat sky and a moody establishing shot are pixel-wise
    similar — so low-detail sections are kept but marked for review rather than
    dropped, because a missing crop is worse than one the user deletes.
    """
    if c.mono_frac >= cfg.mono_frac_ceiling:
        return False, "skip:text_or_branding"          # SR-04 / SR-06
    if c.line_density < cfg.line_density_floor:
        return True, "review:possible_background_only"  # SR-05
    return True, "keep"


def describe(c: Container, page_w: int) -> str:
    """OUT-09: short factual snake_case label.

    `toSnakeCaseReason` on the TypeScript side is the authority on the final
    form; this only has to be factual and already close.
    """
    full = c.x0 <= 2 and c.x1 >= page_w - 2
    tall = (c.y1 - c.y0) > 1.4 * (c.x1 - c.x0)
    return f"{'full_width' if full else 'inset'}_{'tall' if tall else 'wide'}_scene"


# ───────────────────────────── orchestration ─────────────────────────────

def detect(image_dir: str, manifest: dict, cfg: Config, emit) -> dict[str, Any]:
    """Run the pipeline and return canvas-space rects for the caller to emit."""
    warnings: list[str] = []

    def warn(msg: str) -> None:
        warnings.append(msg)

    emit("progress", phase="canvas", percent=5, message="Building the combined page…")
    rgb, factor, page_rows = build_canvas(image_dir, manifest, cfg, warn)
    detect_h, detect_w = rgb.shape[:2]

    # One rule set covers both polarities: a light-gutter page inverted has a dark
    # gutter, and "paper white" bubble fill becomes dark-on-light, which the white
    # mask still finds because it is measured after inversion.
    resolved_mode = normalize_polarity(rgb, page_rows, cfg)
    # After polarity, every page reads dark-gutter — but "dark" differs per page,
    # so level each one onto the shared threshold before masking.
    level_page(rgb, page_rows, cfg)

    # Thresholds are quoted in canvas px; convert them once into detect space.
    dcfg = cfg.scaled(1.0 / factor)

    emit("progress", phase="masks", percent=20, message=f"Separating {resolved_mode} gutter from artwork…")
    masks = build_masks(rgb, dcfg)

    emit("progress", phase="overlays", percent=40, message="Filtering speech bubbles and watermarks…")
    overlay = detect_overlays(masks, dcfg) if cfg.filter_overlays else np.zeros_like(masks["ink"])

    emit("progress", phase="containers", percent=65, message="Assembling panel containers…")
    containers = find_containers(masks, overlay, dcfg)

    emit("progress", phase="relevance", percent=85, message="Scoring section relevance…")
    canvas_w = int(manifest["canvasWidth"])
    canvas_h = int(manifest["canvasHeight"])

    kept: list[dict] = []
    skipped: list[dict] = []
    for c in containers:
        keep, verdict = sr_gate(c, dcfg)
        # Project detect-space back to canvas px, clamped to the canvas so a
        # padded edge can never ask for a row past the last page.
        rect = {
            "canvasX": max(0.0, min(float(canvas_w), c.x0 * factor)),
            "canvasY": max(0.0, min(float(canvas_h), c.y0 * factor)),
        }
        rect["canvasW"] = max(0.0, min(float(canvas_w) - rect["canvasX"], (c.x1 - c.x0) * factor))
        rect["canvasH"] = max(0.0, min(float(canvas_h) - rect["canvasY"], (c.y1 - c.y0) * factor))

        entry = {
            **rect,
            "reason": describe(c, detect_w),
            "verdict": verdict,
            "lineDensity": round(c.line_density, 5),
            "monoFrac": round(c.mono_frac, 4),
        }
        (kept if keep else skipped).append(entry)

    return {
        "crops": kept,
        "skipped": skipped,
        "warnings": warnings,
        "gutterMode": resolved_mode,
        "detectWidth": detect_w,
        "detectHeight": detect_h,
    }


# ───────────────────────────────── main ──────────────────────────────────

def _emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv

    if "--check" in argv:
        if not HAVE_DEPS:
            sys.stderr.write(
                f"crop_detect dependencies missing ({DEP_ERROR}). Run `npm run ml:setup`.\n"
            )
            return 1
        sys.stdout.write("ok\n")
        return 0

    if not HAVE_DEPS:
        _emit("error", message=f"crop_detect dependencies missing: {DEP_ERROR}")
        return 1

    try:
        request = json.loads(sys.stdin.read())
    except Exception as exc:
        _emit("error", message=f"could not parse the request: {exc}")
        return 1

    try:
        image_dir = request["imageDir"]
        manifest = request["manifest"]
    except KeyError as exc:
        _emit("error", message=f"request is missing {exc}")
        return 1

    cfg = Config()
    for key, value in (request.get("config") or {}).items():
        if hasattr(cfg, key) and value is not None:
            setattr(cfg, key, value)

    try:
        result = detect(image_dir, manifest, cfg, _emit)
    except Exception as exc:
        _emit("error", message=str(exc))
        return 1

    _emit("result", **result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
