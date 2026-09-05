#!/usr/bin/env python3
"""
One-time backbone export — Module 3 AI: Auto-Crop (Phase 1 visual embeddings)

Exports a frozen MobileNetV3-Small feature extractor to models/backbone.onnx so
inference and training can produce image embeddings via onnxruntime alone (no
torch at runtime). This is the ONLY step that needs internet — it downloads the
pretrained ImageNet weights once; everything afterward is fully offline.

Usage:
    python export_backbone.py            # writes models/backbone.onnx if missing
    python export_backbone.py --force    # re-export even if it exists

Output ONNX contract:
    input  "input"  : float32 [N, 3, 224, 224]  (ImageNet-normalized RGB)
    output "embedding" : float32 [N, 576]
"""

import os
import sys
import argparse

EMBEDDING_OUTPUT_DIM = 576  # MobileNetV3-Small post-avgpool feature width


def models_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def backbone_path():
    return os.path.join(models_dir(), "backbone.onnx")


def export(force=False):
    out = backbone_path()
    if os.path.exists(out) and not force:
        print("backbone.onnx already exists: %s" % out)
        return 0

    try:
        import torch
        import torch.nn as nn
        from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
    except ImportError as e:
        sys.stderr.write(
            "torch/torchvision are required to export the backbone: %s\n"
            "Install them (they are in requirements.txt) or copy a prebuilt "
            "models/backbone.onnx into place.\n" % e
        )
        return 1

    os.makedirs(models_dir(), exist_ok=True)

    # Frozen feature extractor: features -> global avg pool -> flatten (576-d).
    weights = MobileNet_V3_Small_Weights.DEFAULT
    net = mobilenet_v3_small(weights=weights)

    class Backbone(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.features = m.features
            self.avgpool = m.avgpool

        def forward(self, x):
            x = self.features(x)
            x = self.avgpool(x)
            return torch.flatten(x, 1)

    model = Backbone(net).eval()
    for p in model.parameters():
        p.requires_grad_(False)

    dummy = torch.zeros(1, 3, 224, 224, dtype=torch.float32)
    with torch.no_grad():
        out_dim = model(dummy).shape[1]
    if out_dim != EMBEDDING_OUTPUT_DIM:
        sys.stderr.write(
            "Warning: backbone output dim %d != expected %d\n" % (out_dim, EMBEDDING_OUTPUT_DIM)
        )

    torch.onnx.export(
        model,
        dummy,
        out,
        input_names=["input"],
        output_names=["embedding"],
        dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=13,
    )
    print("Wrote %s (output dim %d)" % (out, out_dim))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Export the AI auto-crop vision backbone to ONNX")
    parser.add_argument("--force", action="store_true", help="re-export even if backbone.onnx exists")
    args = parser.parse_args()
    sys.exit(export(force=args.force))


if __name__ == "__main__":
    main()
