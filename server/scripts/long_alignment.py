"""Bounded-memory forced alignment for long, known narration scripts.

Run wav2vec2 on overlapping audio windows, then align the complete script to
the resulting emissions. Text is never split using estimated speaking speed.
Checkpointing the dynamic program avoids retaining a frames x characters
trellis for the whole recording. No transcription model is required.
"""

import math
import re
import sys

import numpy as np
import torch

SAMPLE_RATE = 16000
FRAME_STRIDE = 320
RECEPTIVE_FIELD = 400
WINDOW_SAMPLES = 20 * SAMPLE_RATE
CONTEXT_SAMPLES = 2 * SAMPLE_RATE


def chunked_emissions(audio, model, model_type, device="cpu", progress=None):
    """Keep the model's attention bounded; stitch frames on its 20ms grid."""
    frame_count = (len(audio) - RECEPTIVE_FIELD) // FRAME_STRIDE + 1
    if frame_count <= 0:
        raise ValueError("Audio is too short to align")
    emissions = []
    for core_start in range(0, len(audio), WINDOW_SAMPLES):
        core_end = min(core_start + WINDOW_SAMPLES, len(audio))
        first_frame = core_start // FRAME_STRIDE
        last_frame = min(core_end // FRAME_STRIDE, frame_count)
        if first_frame >= last_frame:
            break
        start = max(0, core_start - CONTEXT_SAMPLES)
        end = min(len(audio), core_end + CONTEXT_SAMPLES)
        waveform = torch.from_numpy(audio[start:end]).unsqueeze(0).to(device)
        with torch.inference_mode():
            if model_type == "torchaudio":
                logits, _ = model(waveform)
            elif model_type == "huggingface":
                logits = model(waveform).logits
            else:
                raise ValueError(f"Unsupported alignment model type: {model_type}")
            offset = first_frame - start // FRAME_STRIDE
            part = torch.log_softmax(logits[0, offset:offset + last_frame - first_frame], dim=-1)
            # Copy so a retained slice cannot retain the entire window's logits.
            emissions.append(part.cpu().numpy().copy())
        del waveform, logits, part
        sys.stderr.write(f"[alignment] Audio features {core_end / SAMPLE_RATE:.0f}/{len(audio) / SAMPLE_RATE:.0f}s\n")
        sys.stderr.flush()
        if progress:
            progress(5 + 75 * core_end / len(audio), "audio")
    result = np.concatenate(emissions)
    if len(result) != frame_count:
        raise ValueError("Alignment model returned an unexpected number of audio frames")
    return result


def token_spans(emission, tokens, blank_id=0, block_size=None, progress=None):
    """Exact stay/advance alignment with checkpointed, recomputed backtracking.

    Only checkpoint rows and one backtracking block are resident at once:
    O(characters * sqrt(frames)) memory instead of O(characters * frames).
    """
    frames, count = len(emission), len(tokens)
    if not count or frames < count:
        raise ValueError("Not enough audio frames to align the script")
    block_size = block_size or max(1, math.isqrt(frames))
    tokens = np.asarray(tokens, dtype=np.int64)
    row = np.full(count + 1, -np.inf, dtype=np.float32)
    row[0] = 0
    checkpoints = {0: row.copy()}
    best_score, best_end = -np.inf, 0

    def advance(previous, frame):
        current = np.empty_like(previous)
        current[0] = previous[0] + frame[blank_id]
        current[1:] = np.maximum(previous[1:] + frame[blank_id], previous[:-1] + frame[tokens])
        return current

    for t, frame in enumerate(emission, 1):
        row = advance(row, frame)
        if row[-1] > best_score:
            best_score, best_end = row[-1], t
        if t % block_size == 0:
            checkpoints[t] = row.copy()
            if progress:
                progress(80 + 10 * t / frames, "matching")
    if not np.isfinite(best_score):
        raise ValueError("Could not find a complete alignment for this script")

    spans = [[None, None] for _ in tokens]
    t, j = best_end, count
    while t > 0 and j > 0:
        block_start = ((t - 1) // block_size) * block_size
        rows = [checkpoints[block_start]]
        for frame in emission[block_start:t]:
            rows.append(advance(rows[-1], frame))
        while t > block_start and j > 0:
            previous, frame = rows[t - block_start - 1], emission[t - 1]
            changed = previous[j - 1] + frame[tokens[j - 1]]
            stayed = previous[j] + frame[blank_id]
            spans[j - 1][0] = t - 1
            if spans[j - 1][1] is None:
                spans[j - 1][1] = t
            if changed > stayed:
                j -= 1
            t -= 1
        del rows
        if progress:
            progress(90 + 8 * (best_end - t) / best_end, "matching")
    if j:
        raise ValueError("Could not backtrack a complete alignment for this script")
    return spans


def align_long(audio, text, model, metadata, device="cpu", progress=None):
    """Return original script words with timings relative to the full audio."""
    text = re.sub(r"\s+", " ", text).strip()
    dictionary = metadata["dictionary"]
    blank_id = dictionary.get("[pad]", dictionary.get("<pad>", 0))
    emission = chunked_emissions(audio, model, metadata["type"], device, progress=progress)
    # Match WhisperX's wildcard treatment of punctuation, digits and characters
    # absent from the language model's vocabulary.
    chars, positions = [], []
    for i, char in enumerate(text):
        char = char.lower().replace(" ", "|")
        if char in dictionary or char != "|":
            chars.append(char)
            positions.append(i)
    wildcard_id = emission.shape[1]
    if any(char not in dictionary for char in chars):
        non_blank = np.arange(emission.shape[1]) != blank_id
        wildcard = emission[:, non_blank].max(axis=1, keepdims=True)
        emission = np.concatenate([emission, wildcard], axis=1)
    tokens = [dictionary.get(char, wildcard_id) for char in chars]
    sys.stderr.write(f"[alignment] Matching {len(tokens)} script characters to {len(emission)} audio frames\n")
    sys.stderr.flush()
    spans = token_spans(emission, tokens, blank_id, progress=progress)
    by_position = dict(zip(positions, spans))
    seconds_per_frame = len(audio) / SAMPLE_RATE / len(emission)
    words = []
    for match in re.finditer(r"\S+", text):
        word_spans = [by_position[i] for i in range(match.start(), match.end()) if i in by_position]
        words.append({
            "word": match.group(),
            "start": round(word_spans[0][0] * seconds_per_frame, 3) if word_spans else None,
            "end": round(word_spans[-1][1] * seconds_per_frame, 3) if word_spans else None,
        })
    return words
