"""Tests for crop_detect's geometry — the half where a mistake is silent.

Run: server/ml/venv/bin/python3 -m pytest server/ml/test_crop_detect.py -q
(or `venv/bin/python3 test_crop_detect.py` for a dependency-free run).

These cover the parts that produce wrong CROPS rather than a crash: canvas
assembly against a scaled manifest, per-page polarity, and the row/column
sectioning. The overlay filter is deliberately not asserted pixel-for-pixel —
it is a heuristic tuned against real pages, and pinning its output here would
just make it painful to retune.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

import crop_detect as cd  # noqa: E402


def _manifest(pages, canvas_w=None):
    """Build a manifest with reference-width scaling, as clipperService does."""
    w_ref = canvas_w or max(w for w, _ in pages)
    images, y = [], 0.0
    for i, (w, h) in enumerate(pages):
        scale = w_ref / w
        ch = h * scale
        images.append({
            "filename": f"page_{i + 1:03d}.png",
            "width": w, "height": h,
            "canvasY": y, "canvasHeight": ch,
        })
        y += ch
    return {"canvasWidth": w_ref, "canvasHeight": y, "images": images}


def _write_pages(tmp, specs):
    """specs: list of (w, h, fill) -> writes PNGs, returns the manifest."""
    from PIL import Image
    for i, (w, h, fill) in enumerate(specs):
        Image.new("RGB", (w, h), fill).save(tmp / f"page_{i + 1:03d}.png")
    return _manifest([(w, h) for w, h, _ in specs])


# ============ canvas assembly ============

def test_canvas_uses_scaled_manifest_geometry(tmp_path):
    """A narrow slice must occupy its SCALED height, not its own pixel height.

    This is the bug IMAGE_CLIPPER_2.md §3 documents: raw-stacking put crops
    16,000-31,000px out on a mixed-width chapter.
    """
    manifest = _write_pages(tmp_path, [(400, 1000, (10, 10, 10)), (800, 1000, (10, 10, 10))])
    # Page 1 is half-width, so it scales 2x and occupies 2000 canvas rows.
    assert manifest["canvasWidth"] == 800
    assert manifest["canvasHeight"] == 3000
    assert manifest["images"][1]["canvasY"] == 2000

    rgb, factor, rows = cd.build_canvas(str(tmp_path), manifest, cd.Config(), lambda m: None)
    detect_h, detect_w = rgb.shape[:2]
    assert detect_w == cd.Config().detect_width
    # The canvas keeps the manifest's aspect ratio, so a rect projected back by
    # `factor` lands where the manifest says it should.
    assert abs(detect_h * factor - 3000) < factor
    assert len(rows) == 2
    # The seam sits at 2/3 of the canvas, matching canvasY=2000 of 3000.
    assert abs(rows[1][0] / detect_h - 2 / 3) < 0.01


def test_unreadable_page_warns_but_does_not_abort(tmp_path):
    manifest = _write_pages(tmp_path, [(800, 500, (10, 10, 10)), (800, 500, (10, 10, 10))])
    (tmp_path / "page_002.png").write_text("not an image")
    warnings = []
    rgb, _, rows = cd.build_canvas(str(tmp_path), manifest, cd.Config(), warnings.append)
    assert len(rows) == 1
    assert len(warnings) == 1 and "page_002" in warnings[0]
    assert rgb is not None


def test_no_readable_pages_raises(tmp_path):
    manifest = _write_pages(tmp_path, [(800, 500, (10, 10, 10))])
    (tmp_path / "page_001.png").write_text("nope")
    try:
        cd.build_canvas(str(tmp_path), manifest, cd.Config(), lambda m: None)
    except ValueError as exc:
        assert "no page images" in str(exc)
    else:
        raise AssertionError("expected ValueError")


# ============ polarity ============

def test_polarity_is_decided_per_page():
    """A chapter that mixes a dark splash with white pages reports 'mixed'.

    Deciding once for the whole chapter left over half the canvas with its
    gutter as foreground; the ink mask then covered ~71% of the page and
    component labeling merged whole pages together.
    """
    cfg = cd.Config()
    rgb = np.zeros((300, 100, 3), dtype=np.uint8)
    rgb[:100] = 5      # dark page
    rgb[100:200] = 250  # light page
    rgb[200:] = 250     # light page
    rows = [(0, 100), (100, 200), (200, 300)]

    mode = cd.normalize_polarity(rgb, rows, cfg)
    assert mode == "mixed"
    # Every page now reads dark-gutter.
    for y0, y1 in rows:
        assert rgb[y0:y1].max() <= 10


def test_polarity_modes_can_be_forced():
    cfg_dark = cd.Config(gutter_mode="dark")
    rgb = np.full((100, 50, 3), 250, dtype=np.uint8)
    assert cd.normalize_polarity(rgb, [(0, 100)], cfg_dark) == "dark"
    assert rgb.max() == 250  # untouched

    cfg_light = cd.Config(gutter_mode="light")
    rgb2 = np.full((100, 50, 3), 250, dtype=np.uint8)
    assert cd.normalize_polarity(rgb2, [(0, 100)], cfg_light) == "light"
    assert rgb2.max() == 5


def test_level_page_lifts_a_grey_gutter_to_black():
    """A dark-toned page whose gutter sits above `gutter_level` is levelled."""
    cfg = cd.Config()
    rgb = np.full((200, 100, 3), 27, dtype=np.uint8)  # grey wash, like a real splash
    rgb[80:120, 20:80] = 200                          # some artwork
    cd.level_page(rgb, [(0, 200)], cfg)
    masks = cd.build_masks(rgb, cfg)
    # The wash is now gutter, and only the artwork is ink.
    assert masks["ink"].mean() < 0.2
    assert masks["ink"][100, 50]


# ============ masks ============

def test_colored_mask_matches_the_float_saturation_it_replaces():
    """The uint8 chroma comparison must be identical to (mx-mn)/mx > sat_floor."""
    rng = np.random.default_rng(0)
    rgb = rng.integers(0, 256, (200, 120, 3), dtype=np.uint8)
    cfg = cd.Config()

    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0.0)
    expected = (sat > cfg.sat_floor) & (mx > 40)

    assert np.array_equal(cd.build_masks(rgb, cfg)["colored"], expected)


# ============ sectioning ============

def _strip(bands, width=100):
    """bands: list of (height, is_artwork) -> a dark-gutter RGB strip."""
    rows = []
    for h, art in bands:
        block = np.full((h, width, 3), 200 if art else 0, dtype=np.uint8)
        rows.append(block)
    return np.vstack(rows)


def test_sections_split_on_a_generous_gutter():
    cfg = cd.Config(min_section_rows=20, merge_gutter_rows=5, min_gutter_rows=3,
                    subdivide_trigger=99.0)
    rgb = _strip([(60, True), (30, False), (60, True)])
    spans = cd.section_spans(cd.build_masks(rgb, cfg), cfg, 100)
    assert len(spans) == 2
    assert spans[0][0] == 0 and spans[0][1] <= 60
    assert spans[1][0] >= 90


def test_a_thin_gutter_does_not_end_a_section():
    """A background band inside a scene is not a boundary (the 021 failure)."""
    cfg = cd.Config(min_section_rows=20, merge_gutter_rows=40, min_gutter_rows=3,
                    subdivide_trigger=99.0)
    rgb = _strip([(60, True), (20, False), (60, True)])
    spans = cd.section_spans(cd.build_masks(rgb, cfg), cfg, 100)
    assert len(spans) == 1
    assert spans[0] == (0, 140)


def test_a_tall_gutterless_span_subdivides():
    """Continuous artwork with no gutter still has to yield usable crops."""
    cfg = cd.Config(min_section_rows=20, merge_gutter_rows=5, min_gutter_rows=3,
                    target_height_ratio=1.0, subdivide_trigger=1.8)
    rgb = _strip([(500, True)])  # 5x the 100px target
    spans = cd.section_spans(cd.build_masks(rgb, cfg), cfg, 100)
    assert len(spans) == 5
    assert spans[0][0] == 0 and spans[-1][1] == 500
    # Contiguous, no gaps or overlaps.
    for a, b in zip(spans, spans[1:]):
        assert a[1] == b[0]


def test_side_by_side_panels_split_into_separate_crops():
    """The print-comic case: two panels in a row separated by a vertical gutter."""
    cfg = cd.Config(min_panel_width=10, min_panel_height=10, min_panel_area=100,
                    breakout_margin=0, bridge_erosion=0)
    body = np.zeros((100, 200), dtype=bool)
    body[10:90, 10:80] = True    # left panel
    body[10:90, 120:190] = True  # right panel
    out = cd.split_columns(body, (0, 100), cfg)
    assert len(out) == 2
    (x0a, x1a, _, _), (x0b, x1b, _, _) = out
    assert x0a >= 10 and x1a <= 80
    assert x0b >= 120 and x1b <= 190


def test_a_full_bleed_section_stays_one_crop():
    cfg = cd.Config(min_panel_width=10, min_panel_height=10, min_panel_area=100,
                    breakout_margin=0, bridge_erosion=0)
    body = np.zeros((100, 200), dtype=bool)
    body[10:90, :] = True
    out = cd.split_columns(body, (0, 100), cfg)
    assert len(out) == 1
    x0, x1, y0, y1 = out[0]
    assert (x0, x1) == (0, 200)
    assert y0 >= 10 and y1 <= 90  # rows tightened to the artwork


# ============ SR gate ============

def test_monochrome_branding_is_skipped_and_flat_art_is_flagged():
    cfg = cd.Config()
    branding = cd.Container(0, 100, 0, 100, 5000, line_density=0.5,
                            colored_frac=0.01, mono_frac=0.99)
    keep, verdict = cd.sr_gate(branding, cfg)
    assert not keep and verdict == "skip:text_or_branding"

    flat = cd.Container(0, 100, 0, 100, 5000, line_density=0.001,
                        colored_frac=0.5, mono_frac=0.5)
    keep, verdict = cd.sr_gate(flat, cfg)
    assert keep and verdict.startswith("review")

    normal = cd.Container(0, 100, 0, 100, 5000, line_density=0.2,
                          colored_frac=0.5, mono_frac=0.5)
    assert cd.sr_gate(normal, cfg) == (True, "keep")


# ============ config scaling ============

def test_thresholds_scale_into_detect_space():
    """Lengths scale linearly, areas quadratically, ratios not at all."""
    cfg = cd.Config(min_panel_area=40_000, min_panel_width=60, breakout_margin=4)
    half = cfg.scaled(0.5)
    assert half.min_panel_area == 10_000   # 0.5^2
    assert half.min_panel_width == 30      # 0.5
    assert half.breakout_margin == 2
    assert half.sat_floor == cfg.sat_floor  # ratio, unchanged


def test_morphology_radii_never_round_to_zero():
    """A 0 radius silently turns the overlay filter into a no-op."""
    tiny = cd.Config().scaled(0.01)
    assert tiny.bubble_open_radius >= 1
    assert tiny.bubble_dilate >= 1
    assert tiny.glyph_cluster_gap >= 1


if __name__ == "__main__":
    import traceback
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    passed = failed = 0
    tmp_root = Path(__file__).parent / ".pytest-tmp"
    for name, fn in fns:
        try:
            if "tmp_path" in fn.__code__.co_varnames[:fn.__code__.co_argcount]:
                d = tmp_root / name
                d.mkdir(parents=True, exist_ok=True)
                fn(d)
            else:
                fn()
            print(f"  PASS  {name}")
            passed += 1
        except Exception:
            print(f"  FAIL  {name}")
            traceback.print_exc()
            failed += 1
    import shutil
    shutil.rmtree(tmp_root, ignore_errors=True)
    print(f"\n{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
