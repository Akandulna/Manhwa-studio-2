#!/usr/bin/env python3
"""
Forced Alignment Sidecar Script

Aligns KNOWN script text against its audio using WhisperX's wav2vec2 aligner,
producing per-word timings. Because the text is already known, nothing is
transcribed and nothing is guessed - the aligner only decides *when* each
word is spoken. English only for now.

Usage:
  python align.py --check        # Check if dependencies are available
  python align.py --align        # Align (reads JSON from stdin)

Input JSON format:
{
  "audio_path": "/abs/path/section_01.wav",
  "text": "The known script text for this section.",
  "language": "en"
}

Output JSON format:
{
  "words": [
    {"word": "The", "start": 0.11, "end": 0.24},
    ...
  ]
}

Words the aligner could not place carry null start/end; the Node side is
responsible for deciding what to do with them.
"""

import sys
import json
import argparse

WHISPERX_AVAILABLE = False
IMPORT_ERROR = ""

try:
    import whisperx
    WHISPERX_AVAILABLE = True
except ImportError as e:  # pragma: no cover - environment dependent
    IMPORT_ERROR = str(e)


def check_dependencies():
    """Check if required dependencies are available."""
    if WHISPERX_AVAILABLE:
        print("ok:whisperx")
        return True

    print("error:no_backend")
    sys.stderr.write(
        "whisperx is not installed in this interpreter.\n"
        "Install with: pip install whisperx\n"
        f"Import error: {IMPORT_ERROR}\n"
    )
    return False


def align(payload):
    """Align known text to audio, returning per-word timings."""
    audio_path = payload.get("audio_path")
    text = (payload.get("text") or "").strip()
    language = payload.get("language") or "en"

    if not audio_path:
        raise ValueError("audio_path is required")
    if not text:
        raise ValueError("text is required")

    # CPU on Apple Silicon: MPS is not reliably supported by the aligner's
    # ops, and int8 keeps the memory footprint small on an 8GB machine.
    device = "cpu"
    compute_type = "int8"

    audio = whisperx.load_audio(audio_path)
    duration = len(audio) / 16000.0

    model_a, metadata = whisperx.load_align_model(
        language_code=language,
        device=device,
    )

    # A single segment spanning the whole file: we are aligning the entire
    # known text, not transcribing into separate utterances.
    segments = [{"start": 0.0, "end": duration, "text": text}]

    result = whisperx.align(
        segments,
        model_a,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    words = []
    for segment in result.get("segments", []):
        for w in segment.get("words", []):
            token = w.get("word")
            if token is None:
                continue
            start = w.get("start")
            end = w.get("end")
            words.append({
                "word": token,
                "start": float(start) if start is not None else None,
                "end": float(end) if end is not None else None,
            })

    return {"words": words, "durationSec": duration, "computeType": compute_type}


def main():
    parser = argparse.ArgumentParser(description="Forced alignment sidecar")
    parser.add_argument("--check", action="store_true", help="Check dependencies")
    parser.add_argument("--align", action="store_true", help="Align stdin JSON")
    args = parser.parse_args()

    if args.check:
        sys.exit(0 if check_dependencies() else 1)

    if not args.align:
        parser.print_help()
        sys.exit(2)

    if not WHISPERX_AVAILABLE:
        sys.stderr.write("whisperx is not installed\n")
        sys.exit(1)

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"Invalid input JSON: {e}\n")
        sys.exit(1)

    try:
        result = align(payload)
    except Exception as e:  # surfaced verbatim to the Node caller
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)

    json.dump(result, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
