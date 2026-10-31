"""Run with .venv-whisperx/bin/python -m unittest discover -s scripts -p 'test_*alignment.py'."""

import contextlib
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import torch
from whisperx.alignment import backtrack, get_trellis

from long_alignment import align_long, chunked_emissions, token_spans
from alignment_progress import progress_reporter


class LongAlignmentTests(unittest.TestCase):
    def test_checkpoint_backtracking_matches_whisperx(self):
        # Include repeated tokens, blank-heavy frames and paths crossing many
        # checkpoints; compare to the installed backend's full-memory result.
        for seed in range(8):
            generator = torch.Generator().manual_seed(seed)
            emission = torch.log_softmax(torch.randn(307, 8, generator=generator), dim=-1)
            tokens = torch.randint(1, 8, (79,), generator=generator).tolist()
            path = backtrack(get_trellis(emission, tokens), emission, tokens)
            expected = [[None, None] for _ in tokens]
            for point in path:
                span = expected[point.token_index]
                if span[0] is None:
                    span[0] = point.time_index
                span[1] = point.time_index + 1
            for block in (1, 17, 64, 500):
                with self.subTest(seed=seed, block=block):
                    self.assertEqual(token_spans(emission.numpy(), tokens, block_size=block), expected)

    def test_overlapping_windows_preserve_frame_grid_and_bound_model_input(self):
        for samples in (16000 * 41, 16000 * 40 + 100, 16000 * 40 + 399):
            audio = np.arange(samples, dtype=np.float32) / samples
            for backend in ("torchaudio", "huggingface"):
                sizes = []

                def model(waveform):
                    sizes.append(waveform.shape[-1])
                    frames = (waveform.shape[-1] - 400) // 320 + 1
                    values = waveform[:, :frames * 320:320]
                    logits = torch.stack((values, -values), dim=-1)
                    return (logits, None) if backend == "torchaudio" else SimpleNamespace(logits=logits)

                with contextlib.redirect_stderr(io.StringIO()):
                    actual = chunked_emissions(audio, model, backend)
                frames = (samples - 400) // 320 + 1
                values = torch.from_numpy(audio[:frames * 320:320])
                expected = torch.log_softmax(torch.stack((values, -values), dim=-1), dim=-1).numpy()
                np.testing.assert_allclose(actual, expected)
                self.assertLessEqual(max(sizes), 24 * 16000)
                self.assertGreater(len(sizes), 1)

    def test_preserves_hindi_words_punctuation_and_full_audio_offsets(self):
        text = "यह 42 है।\nयह सही है।"
        dictionary = {"<pad>": 0, "|": 1, "य": 2, "ह": 3, "ै": 4, "स": 5, "ी": 6}
        audio = np.zeros(41 * 16000, dtype=np.float32)

        frames = (len(audio) - 400) // 320 + 1
        emission = np.full((frames, len(dictionary)), -12, dtype=np.float32)
        emission[:, 0] = -0.01
        chars = " ".join(text.split()).replace(" ", "|")
        for char, frame in zip(chars, np.linspace(5, frames - 5, len(chars), dtype=int)):
            emission[frame, dictionary.get(char, 1)] = 0
        with contextlib.redirect_stderr(io.StringIO()), patch("long_alignment.chunked_emissions", return_value=emission):
            words = align_long(audio, text, None, {"dictionary": dictionary, "type": "huggingface"})
        self.assertEqual([word["word"] for word in words], text.split())
        for previous, current in zip(words, words[1:]):
            self.assertLessEqual(previous["end"], current["start"])
        self.assertGreater(words[-1]["end"], 40)
        self.assertLessEqual(words[-1]["end"], 41)

    def test_rejects_impossible_alignment(self):
        with self.assertRaisesRegex(ValueError, "Not enough audio frames"):
            token_spans(np.zeros((2, 3), dtype=np.float32), [1, 2, 1])

    @unittest.skipUnless(os.name == "posix", "POSIX parent reparenting")
    def test_worker_exits_when_its_server_parent_disappears(self):
        # A lightweight fake backend lets us test a real parent/child lifecycle
        # without loading another model or depending on the development server.
        sidecar = str(Path(__file__).with_name("align.py"))
        child_code = (
            "import os,runpy,sys,time,types;"
            f"sys.path.insert(0,{str(Path(sidecar).parent)!r});"
            "sys.modules['whisperx']=types.ModuleType('whisperx');"
            f"worker=runpy.run_path({sidecar!r});"
            "worker['watch_parent']();"
            "print(f'ready:{os.getpid()}',flush=True);time.sleep(30)"
        )
        parent_code = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child_code!r}]);time.sleep(30)"
        parent = subprocess.Popen([sys.executable, "-c", parent_code], stdout=subprocess.PIPE, text=True)
        child_pid = None
        try:
            line = parent.stdout.readline().strip()
            self.assertTrue(line.startswith("ready:"), line)
            child_pid = int(line.split(":")[1])
            parent.terminate()
            # The child inherits this pipe, so EOF waits for the child to exit.
            parent.communicate(timeout=6)
            child_pid = None
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
            if child_pid:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_progress_protocol_is_monotonic_and_reserves_completion_for_server(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            report = progress_reporter()
            for value, phase in [(0, "loading"), (43.7, "audio"), (43.8, "audio"), (20, "audio"), (100, "saving")]:
                report(value, phase)
        import json
        events = [json.loads(line.removeprefix("ALIGNMENT_PROGRESS ")) for line in output.getvalue().splitlines()]
        self.assertEqual([e["percent"] for e in events], [0, 43, 99])

    def test_matching_progress_reaches_end_without_changing_alignment(self):
        emission = torch.log_softmax(torch.randn(307, 8), dim=-1).numpy()
        tokens = [1, 2, 3, 3] * 10
        events = []
        actual = token_spans(emission, tokens, progress=lambda percent, phase: events.append((percent, phase)))
        self.assertEqual(actual, token_spans(emission, tokens))
        self.assertGreaterEqual(events[-1][0], 98)
        self.assertTrue(all(a[0] <= b[0] for a, b in zip(events, events[1:])))


if __name__ == "__main__":
    unittest.main()
