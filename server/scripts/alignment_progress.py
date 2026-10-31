"""Line-based progress protocol on stderr; stdout remains the result JSON."""

import json
import sys


def progress_reporter():
    last = (-1, None)

    def report(percent, phase):
        nonlocal last
        current = (max(last[0], min(99, int(percent))), phase)
        if current == last:
            return
        last = current
        sys.stderr.write("ALIGNMENT_PROGRESS " + json.dumps({"percent": current[0], "phase": phase}) + "\n")
        sys.stderr.flush()

    return report
