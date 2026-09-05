#!/usr/bin/env python3
"""
Voice Analysis Sidecar Script

Analyzes voice consistency across audio files using speaker embeddings.
Supports resemblyzer or SpeechBrain ECAPA-TDNN.

Usage:
  python voice_analysis.py --check        # Check if dependencies are available
  python voice_analysis.py --analyze      # Analyze (reads JSON from stdin)

Input JSON format:
{
  "audio_paths": ["path1.wav", "path2.wav", ...],
  "threshold": 0.75
}

Output JSON format:
{
  "referenceFileId": "0",
  "threshold": 0.75,
  "scores": [
    {"fileId": "0", "similarity": 1.0, "isOutlier": false},
    {"fileId": "1", "similarity": 0.85, "isOutlier": false},
    ...
  ]
}
"""

import sys
import json
import argparse
import numpy as np
from pathlib import Path

# Try to import audio processing libraries
RESEMBLYZER_AVAILABLE = False
SPEECHBRAIN_AVAILABLE = False

try:
    from resemblyzer import VoiceEncoder, preprocess_wav
    RESEMBLYZER_AVAILABLE = True
except ImportError:
    pass

try:
    from speechbrain.inference.speaker import EncoderClassifier
    SPEECHBRAIN_AVAILABLE = True
except ImportError:
    pass


def check_dependencies():
    """Check if required dependencies are available."""
    if RESEMBLYZER_AVAILABLE:
        print("ok:resemblyzer")
        return True
    elif SPEECHBRAIN_AVAILABLE:
        print("ok:speechbrain")
        return True
    else:
        print("error:no_backend")
        sys.stderr.write(
            "Neither resemblyzer nor speechbrain is installed.\n"
            "Install with: pip install resemblyzer\n"
            "Or: pip install speechbrain\n"
        )
        return False


def load_audio(path: str):
    """Load audio file and return waveform."""
    import librosa
    wav, sr = librosa.load(path, sr=16000, mono=True)
    return wav


def get_embedding_resemblyzer(wav):
    """Get voice embedding using resemblyzer."""
    encoder = VoiceEncoder()
    processed = preprocess_wav(wav)
    embedding = encoder.embed_utterance(processed)
    return embedding


def get_embedding_speechbrain(wav):
    """Get voice embedding using SpeechBrain."""
    import torch
    import torchaudio
    
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="pretrained_models/spkrec-ecapa-voxceleb"
    )
    
    # Convert numpy array to tensor
    signal = torch.tensor(wav).unsqueeze(0)
    
    # Get embedding
    with torch.no_grad():
        embedding = classifier.encode_batch(signal)
    
    return embedding.squeeze().numpy()


def get_embedding(wav):
    """Get voice embedding using the best available backend."""
    if RESEMBLYZER_AVAILABLE:
        return get_embedding_resemblyzer(wav)
    elif SPEECHBRAIN_AVAILABLE:
        return get_embedding_speechbrain(wav)
    else:
        raise RuntimeError("No embedding backend available")


def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))


def analyze_voices(audio_paths: list, threshold: float):
    """
    Analyze voice consistency across audio files.
    
    Returns similarity scores and outlier flags.
    """
    if len(audio_paths) < 2:
        return {
            "referenceFileId": "0" if audio_paths else None,
            "threshold": threshold,
            "scores": [
                {"fileId": "0", "similarity": 1.0, "isOutlier": False}
            ] if audio_paths else []
        }
    
    # Extract embeddings for all files
    embeddings = []
    valid_indices = []
    
    for i, path in enumerate(audio_paths):
        try:
            wav = load_audio(path)
            
            # Check if audio is too short (less than 1 second)
            if len(wav) < 16000:
                sys.stderr.write(f"Warning: {path} is very short, embedding may be unreliable\n")
            
            embedding = get_embedding(wav)
            embeddings.append(embedding)
            valid_indices.append(i)
        except Exception as e:
            sys.stderr.write(f"Error processing {path}: {e}\n")
            embeddings.append(None)
    
    # Use the first valid embedding as reference
    reference_idx = valid_indices[0] if valid_indices else 0
    reference_embedding = embeddings[reference_idx] if valid_indices else None
    
    # Compute similarities
    scores = []
    for i, embedding in enumerate(embeddings):
        if embedding is None:
            scores.append({
                "fileId": str(i),
                "similarity": 0.0,
                "isOutlier": True
            })
        elif reference_embedding is None:
            scores.append({
                "fileId": str(i),
                "similarity": 1.0,
                "isOutlier": False
            })
        else:
            similarity = cosine_similarity(embedding, reference_embedding)
            scores.append({
                "fileId": str(i),
                "similarity": float(similarity),
                "isOutlier": similarity < threshold
            })
    
    return {
        "referenceFileId": str(reference_idx),
        "threshold": threshold,
        "scores": scores
    }


def main():
    parser = argparse.ArgumentParser(description="Voice consistency analysis")
    parser.add_argument("--check", action="store_true", help="Check dependencies")
    parser.add_argument("--analyze", action="store_true", help="Run analysis")
    
    args = parser.parse_args()
    
    if args.check:
        success = check_dependencies()
        sys.exit(0 if success else 1)
    
    elif args.analyze:
        if not (RESEMBLYZER_AVAILABLE or SPEECHBRAIN_AVAILABLE):
            sys.stderr.write("No embedding backend available\n")
            sys.exit(1)
        
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())
        audio_paths = input_data.get("audio_paths", [])
        threshold = input_data.get("threshold", 0.75)
        
        try:
            result = analyze_voices(audio_paths, threshold)
            print(json.dumps(result))
        except Exception as e:
            sys.stderr.write(f"Analysis failed: {e}\n")
            sys.exit(1)
    
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
