#!/usr/bin/env python3
"""
AI Auto-Crop inference sidecar — Module 3 AI

Usage:
  python suggest.py --check       # report dependency availability (exit 0/1)
  python suggest.py --suggest     # read JSON from stdin, stream results to stdout

Input JSON (stdin):
  {
    "imageDir": "/abs/path/to/chapter/folder",
    "manifest": { "canvasWidth": int, "canvasHeight": int,
                  "images": [{ "filename": str, "width": int, "height": int, "canvasY": int }] },
    "modelDir": "/abs/path/to/ml/models/v3" | null   # null => Stage A only (rule-based)
  }

Output (stdout): one JSON object per line, each an envelope:
  {"event": "progress", "phase": str, "percent": number}
  {"event": "result", "mode": "trained"|"rule-based", "modelVersion": int|null,
   "suggestions": [{canvasX, canvasY, canvasW, canvasH, aspectPreset, confidence}, ...]}
  {"event": "error", "message": str}
"""

import sys
import json
import argparse


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


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
    try:
        import sklearn  # noqa: F401
    except ImportError:
        missing.append("scikit-learn")

    if missing:
        print("error:" + ",".join(missing))
        sys.stderr.write("Missing ML dependencies: %s\n" % ", ".join(missing))
        return False
    print("ok")
    return True


def suggest():
    from infer import load_model, model_version, generate_suggestions

    payload = json.loads(sys.stdin.read())
    image_dir = payload["imageDir"]
    manifest = payload["manifest"]
    model_dir = payload.get("modelDir")

    emit({"event": "progress", "phase": "detecting", "percent": 10})
    model = load_model(model_dir)
    mode = "trained" if model is not None else "rule-based"
    version = model_version(model_dir) if model is not None else None

    emit({"event": "progress", "phase": "scoring", "percent": 40})
    suggestions = generate_suggestions(
        image_dir, manifest, model,
        progress_cb=lambda done, total: emit({
            "event": "progress", "phase": "scoring", "percent": 40 + int(55 * done / total)
        })
    )

    emit({
        "event": "result",
        "mode": mode,
        "modelVersion": version,
        "suggestions": suggestions,
    })


def main():
    parser = argparse.ArgumentParser(description="AI auto-crop inference")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--suggest", action="store_true")
    args = parser.parse_args()

    if args.check:
        sys.exit(0 if check() else 1)
    elif args.suggest:
        try:
            suggest()
        except Exception as e:
            emit({"event": "error", "message": str(e)})
            sys.stderr.write("suggest failed: %s\n" % e)
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
