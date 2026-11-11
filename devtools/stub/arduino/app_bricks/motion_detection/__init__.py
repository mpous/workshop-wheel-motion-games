"""Local stand-in for the App Lab Motion detection brick (arduino:motion_detection).

Only enabled with ARDUKART_SIM_BRICK=1; otherwise importing it fails like on a
runtime without the brick. Implements the two classmethods Ardu Kart uses:
get_model_info() and infer_from_features(). The "model" recognises the
gesture currently played by the simulated board (Bridge.sim), so the lab and
the game can be tested without an .eim model.

Env: ARDUKART_SIM_BRICK_LABELS="idle,updown,wave,snake" (default: the sim board's labels)
"""
import os
import random
import time
from types import SimpleNamespace

if os.environ.get("ARDUKART_SIM_BRICK") != "1":
    raise ImportError("Motion detection brick not enabled (set ARDUKART_SIM_BRICK=1)")

from arduino.app_utils import Bridge
from arduino.app_utils import sim_board

AXES = 6
INTERVAL_MS = 16.0
WINDOW = 62                          # ~1 s at 62.5 Hz
LABELS = [l.strip() for l in os.environ.get("ARDUKART_SIM_BRICK_LABELS", ",".join(sim_board.LABELS)).split(",") if l.strip()]

__all__ = ["MotionDetection"]


class MotionDetection:
    @classmethod
    def get_model_info(cls):
        return SimpleNamespace(name="Simulated motion model", project_id=4242, axis_count=AXES,
                               frequency=int(1000 / INTERVAL_MS), input_features_count=AXES * WINDOW,
                               labels=list(LABELS), interval_ms=INTERVAL_MS)

    @classmethod
    def infer_from_features(cls, features):
        if len(features) != AXES * WINDOW:
            raise ValueError(f"expected {AXES * WINDOW} features, got {len(features)}")
        time.sleep(0.004)
        probs = {l: random.uniform(0, 0.04) for l in LABELS}
        sim = getattr(Bridge, "sim", None)
        g = sim.gesture if sim else None
        top = LABELS[0]
        if g and g[0] in probs and 0.15 < time.time() - g[1] < sim_board.GESTURE_MS / 1000:
            top = g[0]
        probs[top] = random.uniform(0.88, 0.97)
        s = sum(probs.values())
        return {"result": {"classification": {k: round(v / s, 4) for k, v in probs.items()}},
                "timing": {"dsp": 1, "classification": 2}}
