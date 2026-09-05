"""
Image embedder — Module 3 AI: Auto-Crop (Phase 1 visual embeddings)

Wraps the locally-exported MobileNetV3-Small backbone (models/backbone.onnx) and
turns a grayscale region into a fixed 576-d embedding via onnxruntime. Used both
at training time (on dataset WebP crops) and at inference (on live page regions)
so the two paths produce identical features.

Degrades gracefully: if onnxruntime or backbone.onnx is unavailable, available()
returns False and embed() returns None — callers then skip embedding features.
"""

import os
import numpy as np

EMBEDDING_OUTPUT_DIM = 576
_INPUT_SIZE = 224
# ImageNet normalization (matches the pretrained backbone).
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)

_session = None
_session_tried = False

try:
    import cv2
    _HAVE_CV2 = True
except ImportError:  # pragma: no cover
    _HAVE_CV2 = False


def backbone_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "backbone.onnx")


def _get_session():
    """Lazily create and cache the onnxruntime session, or None if unavailable."""
    global _session, _session_tried
    if _session is not None or _session_tried:
        return _session
    _session_tried = True
    path = backbone_path()
    if not os.path.exists(path):
        return None
    try:
        import onnxruntime as ort
        _session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    except Exception:  # pragma: no cover - missing onnxruntime / bad model
        _session = None
    return _session


def available():
    """True iff the backbone can actually produce embeddings."""
    return _HAVE_CV2 and _get_session() is not None


def _preprocess(gray):
    """Grayscale HxW uint8 -> normalized NCHW float32 [1,3,224,224]."""
    img = cv2.resize(gray, (_INPUT_SIZE, _INPUT_SIZE), interpolation=cv2.INTER_AREA)
    x = img.astype(np.float32) / 255.0
    x = np.stack([x, x, x], axis=0)  # replicate to 3 channels
    x = (x - _MEAN) / _STD
    return x[np.newaxis, :, :, :]  # [1,3,224,224]


def embed(gray):
    """
    Return a 576-d embedding for a grayscale region, or None if the backbone is
    unavailable or the region is empty/too small.
    """
    if gray is None or getattr(gray, "size", 0) == 0:
        return None
    sess = _get_session()
    if sess is None or not _HAVE_CV2:
        return None
    h, w = gray.shape[:2]
    if h < 4 or w < 4:
        return None
    try:
        inp = _preprocess(gray)
        out = sess.run(None, {sess.get_inputs()[0].name: inp})[0]
        return np.asarray(out, dtype=np.float32).reshape(-1)
    except Exception:  # pragma: no cover - defensive
        return None
