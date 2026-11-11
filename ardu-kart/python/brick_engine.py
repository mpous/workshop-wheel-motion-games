# Gesture recognition with the App Lab "Motion detection" brick
# (arduino:motion_detection, listed in app.yaml).
#
# The brick runs an Edge Impulse model (.eim) in its own container on the
# Linux side. Which model is picked in Arduino App Lab: open the app, click the
# Motion detection brick and choose an AI model, e.g. the one trained in your
# Edge Impulse project with the Motion Lab. App Lab stores the choice in
# app.yaml and restarts the app.
#
# The brick's own detection loop classifies back-to-back windows and only
# reports classes through per-label callbacks. A kart needs every class
# probability several times per second, so the hub keeps its own rolling window
# (resampled to the model's rate, in the model's units: m/s^2 and deg/s) and
# asks the brick's runner to classify it every STRIDE_MS through
# MotionDetection.infer_from_features().

import queue
import threading
import time

GRAVITY = 9.80665
STRIDE_MS = 250
RETRY_S = 10.0


class BrickEngine:
    def __init__(self, on_result, on_state):
        self.on_result = on_result          # (labels, probs, dsp_ms, nn_ms)
        self.on_state = on_state            # () -> None, state changed
        self.cls = None
        self.state = "off"                  # off | starting | ready | error
        self.error = ""
        self.info = None                    # {"name","project","labels","axes","intervalMs","windowMs"}
        self.lock = threading.Lock()
        self._jobs = queue.Queue(maxsize=1)
        self._reset_window()

    def _reset_window(self):
        self._win = []
        self._need = 0
        self._stride = 1
        self._since = 0
        self._prev = None                   # last input sample (model units)
        self._t_in = 0.0                    # time of the last input sample, ms
        self._t_out = 0.0                   # time of the next resampled sample, ms

    # ------------------------------------------------------------- lifecycle

    def start(self):
        try:
            from arduino.app_bricks.motion_detection import MotionDetection
        except Exception as e:              # brick not installed / not in this runtime
            self._set("off", f"Motion detection brick not available ({e})")
            return
        self.cls = MotionDetection
        self._set("starting", "")
        threading.Thread(target=self._connect, daemon=True, name="brick-info").start()
        threading.Thread(target=self._worker, daemon=True, name="brick-infer").start()

    def _set(self, state, error):
        with self.lock:
            changed = (state, error) != (self.state, self.error)
            self.state, self.error = state, error
        if changed:
            self.on_state()

    def _connect(self):
        # the runner container may still be loading the model: keep asking
        while True:
            try:
                mi = self.cls.get_model_info()
            except Exception as e:
                mi, err = None, str(e)
            else:
                err = "the model runner did not answer"
            if mi is not None:
                try:
                    self._configure(mi)
                    return
                except (ValueError, TypeError, AttributeError) as e:
                    err = f"unsupported model: {e}"
            self._set("error", f"Motion detection brick: {err}. Retrying...")
            time.sleep(RETRY_S)

    def _configure(self, mi):
        axes = int(getattr(mi, "axis_count", 0) or 0)
        count = int(getattr(mi, "input_features_count", 0) or 0)
        interval = float(getattr(mi, "interval_ms", 0) or 0)
        if interval <= 0 and float(getattr(mi, "frequency", 0) or 0) > 0:
            interval = 1000.0 / float(mi.frequency)
        labels = [str(l) for l in (getattr(mi, "labels", None) or [])]
        if not 1 <= axes <= 6:
            raise ValueError(f"{axes} axes (the Modulino Movement gives 3 accelerometer + 3 gyroscope axes)")
        if count < axes or count % axes or interval <= 0 or not labels:
            raise ValueError("missing window / frequency / labels in the model information")
        with self.lock:
            self.info = {"name": getattr(mi, "name", "Edge Impulse model"), "project": getattr(mi, "project_id", None),
                         "labels": labels, "axes": axes, "intervalMs": round(interval, 3),
                         "windowMs": round(count // axes * interval)}
            self._reset_window()
            self._need = count // axes
            self._stride = max(1, round(STRIDE_MS / interval))
        self._set("ready", "")

    def status(self):
        with self.lock:
            return {"state": self.state, "error": self.error, **(dict(self.info) if self.info else {})}

    @property
    def ready(self):
        return self.state == "ready"

    @property
    def labels(self):
        return list(self.info["labels"]) if self.info else []

    # ------------------------------------------------------------- samples

    def push(self, sample, interval_ms):
        """sample: ax, ay, az (g), gx, gy, gz (deg/s), as streamed by the sketch."""
        if self.state != "ready":
            return
        with self.lock:
            axes, step = self.info["axes"], self.info["intervalMs"]
            cur = [sample[0] * GRAVITY, sample[1] * GRAVITY, sample[2] * GRAVITY,
                   sample[3], sample[4], sample[5]][:axes]
            if self._prev is None:
                self._prev, self._t_in, self._t_out = cur, 0.0, 0.0
            t0, self._t_in = self._t_in, self._t_in + interval_ms
            prev, self._prev = self._prev, cur
            job = None
            # linear resampling from the board's rate to the model's
            while self._t_out <= self._t_in:
                f = (self._t_out - t0) / interval_ms if interval_ms > 0 else 1.0
                f = min(1.0, max(0.0, f))
                self._win.append([a + (b - a) * f for a, b in zip(prev, cur)])
                self._t_out += step
                if len(self._win) > self._need:
                    del self._win[0]
                self._since += 1
                if len(self._win) == self._need and self._since >= self._stride:
                    self._since = 0
                    job = [v for row in self._win for v in row]
            if self._t_in > 1e9:                # keep the clocks small
                self._t_in -= 1e9
                self._t_out -= 1e9
        if job is not None:
            try:
                self._jobs.put_nowait(job)
            except queue.Full:                  # the runner is behind: skip this window
                pass

    def flush(self):
        with self.lock:
            need, stride = self._need, self._stride
            self._reset_window()
            self._need, self._stride = need, stride

    def _worker(self):
        while True:
            features = self._jobs.get()
            t = time.monotonic()
            try:
                res = self.cls.infer_from_features(features)
            except Exception as e:
                res = None
                print(f"[Ardu Kart] brick inference failed: {e}")
            if not isinstance(res, dict):
                continue
            result = res.get("result") if isinstance(res.get("result"), dict) else res
            cls = result.get("classification")
            if not isinstance(cls, dict):
                continue
            labels = self.labels
            try:
                probs = [round(float(cls.get(l, 0.0)), 3) for l in labels]
            except (TypeError, ValueError):
                continue
            timing = res.get("timing") if isinstance(res.get("timing"), dict) else {}
            dsp = int(timing.get("dsp", 0) or 0)
            nn = int(timing.get("classification", 0) or 0) or int((time.monotonic() - t) * 1000)
            self.on_result(labels, probs, dsp, nn)
