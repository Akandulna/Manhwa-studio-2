#!/usr/bin/env python3
"""
Hold-out evaluation — Module 3 AI: Auto-Crop

Crops a set of chapters "from scratch" with the AI and compares against the
user's own finalized crops on those chapters. Computes objective metrics so the
user can see how well the AI has learned their style.

Usage:  python evaluate.py --evaluate   # reads JSON config from stdin
Stdin:
  { "modelDir": str|null,
    "chapters": [ { "chapterId": str, "imageDir": str, "manifest": {...},
                    "userCrops": [ { canvasX, canvasY, canvasW, canvasH, aspectPreset } ] } ] }
Stdout: line-delimited JSON envelopes (progress / result / error).
"""

import sys
import json
import argparse
import numpy as np


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def evaluate_chapter(image_dir, manifest, user_crops, model):
    from infer import generate_suggestions
    from metrics import match_crops, mean_matched_iou, precision_recall_f1

    ai_crops = generate_suggestions(image_dir, manifest, model)

    prf = precision_recall_f1(ai_crops, user_crops, iou_threshold=0.5)
    mean_iou = mean_matched_iou(ai_crops, user_crops, iou_threshold=0.5)

    # Count accuracy: 1 - |ai - user| / max(user, 1), floored at 0.
    n_user, n_ai = len(user_crops), len(ai_crops)
    count_acc = max(0.0, 1.0 - abs(n_ai - n_user) / max(1, n_user))

    # Aspect-preset accuracy over matched pairs.
    matches, _, _ = match_crops(ai_crops, user_crops, iou_threshold=0.5)
    preset_hits = 0
    for pi, gi, _ in matches:
        if ai_crops[pi].get("aspectPreset") == user_crops[gi].get("aspectPreset"):
            preset_hits += 1
    preset_acc = (preset_hits / len(matches)) if matches else None

    return {
        "metrics": {
            "meanIoU": mean_iou,
            "precision": prf["precision"],
            "recall": prf["recall"],
            "f1": prf["f1"],
            "countAccuracy": count_acc,
            "presetAccuracy": preset_acc,
            "userCount": n_user,
            "aiCount": n_ai,
            "matched": len(matches),
        },
        "aiCrops": ai_crops,
    }


def _agg(values):
    vals = [v for v in values if v is not None]
    return float(np.mean(vals)) if vals else None


def evaluate(config):
    from infer import load_model, model_version

    model_dir = config.get("modelDir")
    chapters = config["chapters"]
    model = load_model(model_dir)

    per_chapter = []
    n = len(chapters)
    for i, ch in enumerate(chapters):
        emit({"event": "progress", "phase": "evaluating", "percent": int(90 * i / max(1, n)),
              "chapterId": ch["chapterId"]})
        result = evaluate_chapter(ch["imageDir"], ch["manifest"], ch["userCrops"], model)
        per_chapter.append({"chapterId": ch["chapterId"], **result})

    metrics_list = [c["metrics"] for c in per_chapter]
    aggregate = {
        "meanIoU": _agg([m["meanIoU"] for m in metrics_list]),
        "precision": _agg([m["precision"] for m in metrics_list]),
        "recall": _agg([m["recall"] for m in metrics_list]),
        "f1": _agg([m["f1"] for m in metrics_list]),
        "countAccuracy": _agg([m["countAccuracy"] for m in metrics_list]),
        "presetAccuracy": _agg([m["presetAccuracy"] for m in metrics_list]),
        "chapterCount": n,
    }

    emit({
        "event": "result",
        "modelVersion": model_version(model_dir) if model is not None else None,
        "aggregate": aggregate,
        "perChapter": per_chapter,
    })


def main():
    parser = argparse.ArgumentParser(description="AI auto-crop evaluation")
    parser.add_argument("--evaluate", action="store_true")
    args = parser.parse_args()

    if not args.evaluate:
        parser.print_help()
        sys.exit(1)

    try:
        config = json.loads(sys.stdin.read())
        evaluate(config)
    except Exception as e:
        emit({"event": "error", "message": str(e)})
        sys.stderr.write("evaluate failed: %s\n" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
