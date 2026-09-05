#!/usr/bin/env python3
"""
Watermark detection sidecar — Module 3: Image Clipper

Finds site-watermark occurrences in chapter pages via multi-scale OpenCV template
matching, so the export pipeline can white-fill them. Fully offline.

Usage:
  python watermark.py --check       # report dependency availability (exit 0/1)
  python watermark.py --detect      # read JSON from stdin, write JSON result to stdout

Input JSON (stdin) for --detect:
  {
    "pages": [{ "filename": str, "path": "/abs/path/to/page.webp" }, ...],
    "templates": [{ "id": str, "path": "/abs/path/template.png", "threshold": float }, ...],
    "scales": [0.5, 0.75, 1.0, 1.25, 1.5]   # optional; template scales to try
  }

Output JSON (stdout):
  {
    "ok": true,
    "matches": [
      { "filename": str, "templateId": str, "x": int, "y": int,
        "w": int, "h": int, "score": float }
    ]
  }
  On failure: {"ok": false, "error": str}

Coordinates (x, y, w, h) are in the page image's own pixel space.
"""

import sys
import json
import argparse


def check():
    missing = []
    try:
        import cv2  # noqa: F401
    except ImportError:
        missing.append("opencv-python-headless")
    try:
        import numpy  # noqa: F401
    except ImportError:
        missing.append("numpy")
    if missing:
        sys.stderr.write("missing: " + ", ".join(missing) + "\n")
        sys.stdout.write("missing\n")
        return 1
    sys.stdout.write("ok\n")
    return 0


def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix1, iy1 = max(ax, bx), max(ay, by)
    ix2, iy2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes, iou_thresh=0.3):
    """Greedy non-max suppression; boxes = list of dicts with x,y,w,h,score."""
    kept = []
    for box in sorted(boxes, key=lambda b: b["score"], reverse=True):
        rect = (box["x"], box["y"], box["w"], box["h"])
        if all(_iou(rect, (k["x"], k["y"], k["w"], k["h"])) < iou_thresh for k in kept):
            kept.append(box)
    return kept


def detect():
    import cv2
    import numpy as np

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": f"bad input json: {e}"}))
        return 1

    pages = payload.get("pages", [])
    templates = payload.get("templates", [])
    scales = payload.get("scales") or [0.5, 0.65, 0.8, 1.0, 1.25, 1.5]

    if not templates:
        sys.stdout.write(json.dumps({"ok": True, "matches": []}))
        return 0

    # Pre-load templates as grayscale.
    loaded = []
    for t in templates:
        img = cv2.imread(t["path"], cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        loaded.append({
            "id": t.get("id", "tpl"),
            "gray": img,
            "threshold": float(t.get("threshold", 0.8)),
        })

    matches = []

    for page in pages:
        page_gray = cv2.imread(page["path"], cv2.IMREAD_GRAYSCALE)
        if page_gray is None:
            continue
        ph, pw = page_gray.shape[:2]

        page_boxes = []
        for tpl in loaded:
            th0, tw0 = tpl["gray"].shape[:2]
            for scale in scales:
                tw, th = int(round(tw0 * scale)), int(round(th0 * scale))
                if tw < 8 or th < 8 or tw > pw or th > ph:
                    continue
                resized = cv2.resize(tpl["gray"], (tw, th), interpolation=cv2.INTER_AREA)
                res = cv2.matchTemplate(page_gray, resized, cv2.TM_CCOEFF_NORMED)
                ys, xs = np.where(res >= tpl["threshold"])
                for (x, y) in zip(xs.tolist(), ys.tolist()):
                    page_boxes.append({
                        "templateId": tpl["id"],
                        "x": int(x), "y": int(y), "w": int(tw), "h": int(th),
                        "score": float(res[y, x]),
                    })

        # Suppress overlapping detections (same watermark hit at multiple scales).
        for box in _nms(page_boxes, iou_thresh=0.3):
            box["filename"] = page["filename"]
            matches.append(box)

    sys.stdout.write(json.dumps({"ok": True, "matches": matches}))
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--detect", action="store_true")
    args = parser.parse_args()

    if args.check:
        sys.exit(check())
    if args.detect:
        try:
            sys.exit(detect())
        except Exception as e:  # noqa: BLE001
            sys.stdout.write(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)
    parser.print_help()
    sys.exit(2)


if __name__ == "__main__":
    main()
