"""Simulated Modulino wheel for local development (QKART_SIM_BOARD=1).

Behaves like sketch.ino seen from Python: a 62.5 Hz "imu" stream (g, deg/s),
"hw" heartbeats every 2 s, "ml" class probabilities 4x per second and "btn"
edges. With no input the wheel sways gently; the debug API (/api/debug/sim)
or `command()` sets the tilt, plays a gesture or presses a button.

Env: QKART_SIM_MODEL=0 simulates a board without an Edge Impulse model.
"""
import math
import os
import random
import threading
import time

LABELS = ["idle", "accelerate", "brake", "use_item", "change_camera"]
INTERVAL_MS = 16.0
GESTURE_MS = 900

# accelerometer / gyro "signatures" so recorded sim gestures look different
SHAPES = {
    "accelerate": lambda p: ((0.9 * math.sin(p * math.pi * 2), 0, 0), (0, 40 * math.cos(p * math.pi * 2), 0)),
    "brake": lambda p: ((-0.9 * math.sin(p * math.pi * 2), 0, 0), (0, -40 * math.cos(p * math.pi * 2), 0)),
    "use_item": lambda p: ((0, 0, 1.4 * math.sin(p * math.pi * 6)), (180 * math.sin(p * math.pi * 6), 0, 0)),
    "change_camera": lambda p: ((0.5 * math.sin(p * math.pi * 4), 0.5 * math.cos(p * math.pi * 4), 0),
                                (0, 0, 240 * math.sin(p * math.pi * 2))),
}


class SimBoard:
    def __init__(self, bridge):
        self.bridge = bridge
        self.lock = threading.Lock()
        self.model = os.environ.get("QKART_SIM_MODEL", "1") != "0"
        self.tilt = None            # radians, None = automatic sway
        self.tilt_now = 0.0
        self.gesture = None         # (label, started)
        self.presses = []           # [(button, release_at)]
        self.started = time.time()

    # ---------------------------------------------------------------- control

    def command(self, tilt=None, gesture=None, button=None, auto=False):
        with self.lock:
            if auto:
                self.tilt = None
            if tilt is not None:
                self.tilt = max(-1.2, min(1.2, float(tilt)))   # radians, + = left
            if gesture:
                self.gesture = (gesture, time.time())
            if button is not None and 0 <= int(button) <= 2:
                self.presses.append((int(button), time.time() + 0.12))
                self._emit("btn", int(button), True)
        return self.state()

    def state(self):
        return {"tilt": self.tilt, "tiltNow": round(self.tilt_now, 3),
                "gesture": self.gesture[0] if self.gesture else None, "model": self.model}

    # ---------------------------------------------------------------- engine

    def start(self):
        threading.Thread(target=self._run, daemon=True, name="sim-board").start()

    def _emit(self, name, *args):
        fn = self.bridge.providers.get(name)
        if fn:
            try:
                fn(*args)
            except Exception as e:  # mirror the router: a failing handler does not stop the MCU
                print(f"[sim-board] {name} handler failed: {e}")

    def _hw(self):
        s = f"v=2;sim=1;mv=1;bt=1;px=1;interval={INTERVAL_MS:.2f}"
        if self.model:
            s += (";model=1;name=Q-Kart wheel (simulated);project=1;deploy=1;window=1000;"
                  "axes=accX + accY + accZ + gyrX + gyrY + gyrZ;labels=" + "|".join(LABELS))
        else:
            s += ";model=0"
        self._emit("hw", s)

    def _run(self):
        time.sleep(0.5)              # let main.py finish wiring
        next_t = time.monotonic()
        n = 0
        prev_tilt = 0.0
        while True:
            t = time.time()
            with self.lock:
                target = self.tilt if self.tilt is not None else 0.35 * math.sin((t - self.started) * 0.6)
                gesture = self.gesture
                if gesture and (t - gesture[1]) * 1000 > GESTURE_MS:
                    self.gesture = gesture = None
                releases = [b for b, at in self.presses if at <= t]
                self.presses = [(b, at) for b, at in self.presses if at > t]
            for b in releases:
                self._emit("btn", b, False)

            # the wheel is held upright facing the driver (+z towards them, +y up) and
            # turned about z: positive tilt = counter-clockwise = steering left
            self.tilt_now += (target - self.tilt_now) * 0.25
            angle = self.tilt_now
            gz = math.degrees(angle - prev_tilt) / (INTERVAL_MS / 1000.0)
            prev_tilt = angle
            acc = [math.sin(angle) + random.gauss(0, 0.01), math.cos(angle) + random.gauss(0, 0.01), random.gauss(0, 0.01)]
            gyr = [random.gauss(0, 0.4) + 0.8, random.gauss(0, 0.4) - 0.5, gz + random.gauss(0, 0.4) + 1.2]  # with a little gyro bias
            if gesture and gesture[0] in SHAPES:
                p = min(1.0, (t - gesture[1]) * 1000 / GESTURE_MS)
                (da, dg) = SHAPES[gesture[0]](p)
                acc = [a + d for a, d in zip(acc, da)]
                gyr = [g + d for g, d in zip(gyr, dg)]
            self._emit("imu", *acc, *gyr)

            if n % 125 == 0:
                self._hw()
            if self.model and n % 16 == 8:
                self._ml(gesture, t)
            n += 1
            next_t += INTERVAL_MS / 1000.0
            delay = next_t - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                next_t = time.monotonic()

    def _ml(self, gesture, t):
        probs = [random.uniform(0, 0.04) for _ in LABELS]
        top = 0
        if gesture and gesture[0] in LABELS:
            age = (t - gesture[1]) * 1000
            if 150 < age < GESTURE_MS:
                top = LABELS.index(gesture[0])
        probs[top] = random.uniform(0.88, 0.97)
        s = sum(probs)
        self._emit("ml", ",".join(f"{p / s:.3f}" for p in probs), 2, 1)
