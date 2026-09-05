"""
Crop evaluation metrics — Module 3 AI: Auto-Crop

Pure-numpy geometry metrics used by evaluate.py and unit-tested by test_metrics.py.
Rectangles are dicts/objects with keys: canvasX, canvasY, canvasW, canvasH.
"""

from typing import List, Dict, Tuple


def _xywh(rect) -> Tuple[float, float, float, float]:
    return (
        float(rect["canvasX"]),
        float(rect["canvasY"]),
        float(rect["canvasW"]),
        float(rect["canvasH"]),
    )


def iou(a, b) -> float:
    """Intersection-over-union of two axis-aligned rectangles."""
    ax, ay, aw, ah = _xywh(a)
    bx, by, bw, bh = _xywh(b)

    if aw <= 0 or ah <= 0 or bw <= 0 or bh <= 0:
        return 0.0

    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    ix = max(0.0, min(ax2, bx2) - max(ax, bx))
    iy = max(0.0, min(ay2, by2) - max(ay, by))
    inter = ix * iy
    if inter <= 0:
        return 0.0

    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def match_crops(preds: List[Dict], gts: List[Dict], iou_threshold: float = 0.5):
    """
    Greedy one-to-one matching between predicted and ground-truth crops,
    highest-IoU pairs first.

    Returns:
      matches: list of (pred_idx, gt_idx, iou)
      unmatched_preds: list of pred indices (false positives)
      unmatched_gts: list of gt indices (false negatives)
    """
    pairs = []
    for pi, p in enumerate(preds):
        for gi, g in enumerate(gts):
            score = iou(p, g)
            if score >= iou_threshold:
                pairs.append((score, pi, gi))

    pairs.sort(reverse=True)  # highest IoU first

    matched_pred = set()
    matched_gt = set()
    matches = []
    for score, pi, gi in pairs:
        if pi in matched_pred or gi in matched_gt:
            continue
        matched_pred.add(pi)
        matched_gt.add(gi)
        matches.append((pi, gi, score))

    unmatched_preds = [i for i in range(len(preds)) if i not in matched_pred]
    unmatched_gts = [i for i in range(len(gts)) if i not in matched_gt]
    return matches, unmatched_preds, unmatched_gts


def precision_recall_f1(preds: List[Dict], gts: List[Dict], iou_threshold: float = 0.5):
    """Detection precision / recall / F1 at the given IoU threshold."""
    matches, fp, fn = match_crops(preds, gts, iou_threshold)
    tp = len(matches)
    precision = tp / (tp + len(fp)) if (tp + len(fp)) > 0 else 0.0
    recall = tp / (tp + len(fn)) if (tp + len(fn)) > 0 else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "tp": tp,
        "fp": len(fp),
        "fn": len(fn),
    }


def mean_matched_iou(preds: List[Dict], gts: List[Dict], iou_threshold: float = 0.5) -> float:
    """Mean IoU over matched pairs (0.0 if there are no matches)."""
    matches, _, _ = match_crops(preds, gts, iou_threshold)
    if not matches:
        return 0.0
    return sum(m[2] for m in matches) / len(matches)
