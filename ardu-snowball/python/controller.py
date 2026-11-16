# Motion controller hub: the Modulino wheel <-> browsers <-> Edge Impulse.
#
#  MCU -> Python (Bridge notifications from sketch.ino)
#    imu(ax, ay, az, gx, gy, gz)   g and deg/s, every sample (62.5 Hz by default)
#    ml(probs_csv, dsp_ms, nn_ms)  class probabilities of the on-MCU model (4 Hz)
#    btn(index, pressed)           Modulino Buttons A/B/C edges
#    hw(info)                      "k=v;k=v" heartbeat every 2 s
#  Python -> browsers (room "motion"): "imu", "ml", "btn", "hw"
#  Browsers -> MCU: "pix" (Pixels: aim, bite, line tension...), "ctl_leds" (button LEDs)
#  Python -> MCU: "ml_engine" (1 = the MCU shows its own gestures), "gesture"
#
# Gestures come from one of two Edge Impulse engines (brick_engine.py):
#  * "brick": the App Lab Motion detection brick on the Linux side. Its model
#    is chosen in Arduino App Lab, no sketch rebuild needed.
#  * "mcu": an Arduino library compiled into the sketch (Motion Lab "build").
# The preference (auto / brick / mcu) is stored in the data folder; "auto"
# uses the MCU model when the sketch has one, else the brick.
#
# There is one wheel per board: the game tab that drives with it "claims" it
# (motion_claim) so other LAN players' browsers ignore it, and only the owner
# may drive the Pixels and button LEDs.
#
# Training: samples are recorded here (sample-accurate, no browser jitter) and
# uploaded to the Edge Impulse ingestion service with the project API key the
# user typed in the Motion Lab page. Studio jobs (retrain, Arduino library
# build) are proxied too, and the resulting library is installed into the
# sketch so the next app start compiles it in.

import base64
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import model_installer
from brick_engine import BrickEngine

STUDIO_URL = os.environ.get("ARDUSNOW_EI_STUDIO_URL", "https://studio.edgeimpulse.com/v1/api").rstrip("/")
INGEST_URL = os.environ.get("ARDUSNOW_EI_INGEST_URL", "https://ingestion.edgeimpulse.com").rstrip("/")

GRAVITY = 9.80665
IMU_BATCH = 2                    # samples per "imu" message (~31 msg/s at 62.5 Hz)
BOARD_TIMEOUT_S = 5.0
PIX_MIN_INTERVAL_S = 0.04        # Pixels updates are capped at 25 Hz
MAX_RECORD_MS = 20000
MAX_UPLOAD_SAMPLES = 4000
MAX_MODEL_ZIP = 8 * 1024 * 1024
HTTP_TIMEOUT = 30
JOB_TIMEOUT_S = 30 * 60
SENSORS = [("accX", "m/s2"), ("accY", "m/s2"), ("accZ", "m/s2"),
           ("gyrX", "dps"), ("gyrY", "dps"), ("gyrZ", "dps")]
LABEL_RE = re.compile(r"^[A-Za-z0-9_\-. ]{1,64}$")
API_KEY_RE = re.compile(r"^ei_[A-Za-z0-9]{16,128}$")
ENGINES = ("auto", "brick", "mcu")
GESTURE_CONFIDENCE = 0.7         # MCU matrix / Pixels flashes for brick results (same as the sketch)
IDLE_RE = re.compile(r"idle|noise|none|rest|still|background|unknown", re.I)


def _now_ms():
    return time.time() * 1000.0


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse_hw(text):
    info = {}
    for part in str(text).split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            info[k.strip()] = v.strip()
    out = {
        "movement": info.get("mv") == "1",
        "buttons": info.get("bt") == "1",
        "pixels": info.get("px") == "1",
        "model": info.get("model") == "1",
        "sim": info.get("sim") == "1",
    }
    try:
        out["interval"] = float(info.get("interval", "16"))
    except ValueError:
        out["interval"] = 16.0
    if out["model"]:
        out["name"] = info.get("name", "")
        out["project"] = info.get("project", "")
        out["deploy"] = info.get("deploy", "")
        out["axes"] = info.get("axes", "")
        try:
            out["window"] = int(info.get("window", "0"))
        except ValueError:
            out["window"] = 0
        out["labels"] = [l for l in info.get("labels", "").split("|") if l]
    return out


class EIError(Exception):
    pass


def _ei_request(method, url, api_key, body=None, raw=False, headers=None):
    data = None
    hdrs = {"x-api-key": api_key, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            payload = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        try:
            detail = json.loads(detail).get("error") or detail
        except (ValueError, AttributeError):
            pass
        if e.code in (401, 403):
            raise EIError("Edge Impulse rejected the API key (check it in Dashboard > Keys)")
        raise EIError(f"Edge Impulse HTTP {e.code}: {detail}")
    except (urllib.error.URLError, OSError) as e:
        raise EIError(f"cannot reach Edge Impulse ({getattr(e, 'reason', e)}). Is the board online?")
    if raw:
        return payload
    try:
        res = json.loads(payload or b"{}")
    except ValueError:
        return {"success": True, "text": payload.decode("utf-8", "replace")}
    if isinstance(res, dict) and res.get("success") is False:
        raise EIError(res.get("error") or "Edge Impulse request failed")
    return res


class MotionHub:
    def __init__(self, ui, bridge, data_dir=None):
        self.ui = ui
        self.bridge = bridge
        self.prefs_path = os.path.join(data_dir, "motion.json") if data_dir else None
        self.engine_pref = self._load_pref()
        self.brick = BrickEngine(self._on_brick_ml, self._on_brick_state)
        self._active = None           # engine whose results are published
        self._ml_engine_sent = None
        self._gesture_at = {}         # class -> monotonic time of the last MCU flash
        self.lock = threading.Lock()
        self.hw = None
        self.hw_at = 0.0
        self.batch = []
        self.recordings = {}          # sid -> {"label", "need", "values", "started"}
        self.last_ml = None
        self.pix_last = (None, 0.0)   # (args, monotonic time sent)
        self.pix_pending = None
        self.leds = None
        self.job = None               # {"sid", "kind", "id", "stage"}
        self.changed_model = False    # installed/removed since the app started
        self.owner = None             # sid of the game tab driving with the wheel
        self.owner_kind = None        # "game" or "lab": a game tab takes the wheel back from the Motion Lab
        self.owner_visible = False    # the owner tab is on screen; a hidden or old tab loses the wheel to a focused game

    # ------------------------------------------------------------- MCU -> Python

    def on_imu(self, ax, ay, az, gx, gy, gz):
        s = [round(float(ax), 4), round(float(ay), 4), round(float(az), 4),
             round(float(gx), 2), round(float(gy), 2), round(float(gz), 2)]
        done = []
        with self.lock:
            self.batch.append(s)
            send = self.batch if len(self.batch) >= IMU_BATCH else None
            if send:
                self.batch = []
            for sid, rec in list(self.recordings.items()):
                rec["values"].append(s)
                if len(rec["values"]) >= rec["need"]:
                    done.append((sid, self.recordings.pop(sid)))
            interval = self.hw["interval"] if self.hw else 16.0
            use_brick = self._active == "brick"
        if use_brick:
            self.brick.push(s, interval)
        if send:
            self.ui.send_message("imu", {"s": send, "i": interval}, room="motion")
        for sid, rec in done:
            self.ui.send_message("motion_record_done", {
                "label": rec["label"], "interval": interval, "values": rec["values"],
                "durationMs": round(len(rec["values"]) * interval)}, room=sid)

    def on_ml(self, probs, dsp_ms=0, nn_ms=0):
        try:
            p = [round(float(x), 3) for x in str(probs).split(",") if x.strip()]
        except ValueError:
            return
        with self.lock:
            if self._active != "mcu":
                return                # the MCU model is installed but the brick is in use
            labels = (self.hw or {}).get("labels") or [f"class {i}" for i in range(len(p))]
        self._publish_ml(labels, p, dsp_ms, nn_ms, "mcu")

    def _publish_ml(self, labels, p, dsp_ms, nn_ms, src):
        with self.lock:
            self.last_ml = {"labels": labels, "p": p, "dsp": int(dsp_ms), "nn": int(nn_ms), "t": _now_ms(), "src": src}
            msg = dict(self.last_ml)
        self.ui.send_message("ml", msg, room="motion")

    # ------------------------------------------------------------- engines

    def _load_pref(self):
        try:
            with open(self.prefs_path, encoding="utf-8") as f:
                v = json.load(f).get("engine")
            return v if v in ENGINES else "auto"
        except (OSError, ValueError, TypeError, AttributeError):
            return "auto"

    def _save_pref(self):
        if not self.prefs_path:
            return
        try:
            os.makedirs(os.path.dirname(self.prefs_path), exist_ok=True)
            tmp = self.prefs_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"engine": self.engine_pref}, f)
            os.replace(tmp, self.prefs_path)
        except OSError as e:
            print(f"[Ardu Snowball] cannot save {self.prefs_path}: {e}")

    def _pick_engine(self):
        """Engine whose results drive the game. Call with the lock held."""
        mcu = bool(self.hw and self.hw.get("model") and self.board_online())
        brick = self.brick.ready
        pref = self.engine_pref
        if pref == "mcu":
            return "mcu" if mcu else None
        if pref == "brick":
            return "brick" if brick else None
        return "mcu" if mcu else "brick" if brick else None

    def _refresh_engine(self):
        """Re-evaluate the active engine; tells browsers and the MCU when it changes."""
        with self.lock:
            active = self._pick_engine()
            changed = active != self._active
            self._active = active
            if changed:
                self.last_ml = None
        if changed:
            if active == "brick":
                self.brick.flush()
            self._send_ml_engine(force=True)
            self.ui.send_message("hw", self.status_payload(), room="motion")
        return changed

    def _send_ml_engine(self, force=False):
        v = 1 if self._active == "mcu" else 0
        if force or v != self._ml_engine_sent:
            self._ml_engine_sent = v
            self._notify("ml_engine", v)

    def _on_brick_state(self):
        if not self._refresh_engine():
            self.ui.send_message("hw", self.status_payload(), room="motion")

    def _on_brick_ml(self, labels, probs, dsp_ms, nn_ms):
        with self.lock:
            if self._active != "brick":
                return
        self._publish_ml(labels, probs, dsp_ms, nn_ms, "brick")
        # same local effects as the on-MCU model: icon on the matrix, colour flash on the Pixels
        if not probs:
            return
        best = max(range(len(probs)), key=lambda i: probs[i])
        label = labels[best]
        if probs[best] < GESTURE_CONFIDENCE or IDLE_RE.search(label):
            return
        t = time.monotonic()
        if t - self._gesture_at.get(best, 0) < 0.9:
            return
        self._gesture_at[best] = t
        self._notify("gesture", best, label[:24], int(probs[best] * 100))

    def engine_status(self):
        with self.lock:
            active = self._active
            hw = self.hw or {}
        b = self.brick.status()
        if active == "brick":
            labels, name = b.get("labels") or [], b.get("name", "")
        elif active == "mcu":
            labels, name = hw.get("labels") or [], hw.get("name", "")
        else:
            labels, name = [], ""
        return {"pref": self.engine_pref, "active": active, "labels": labels, "name": name, "brick": b}

    def on_engine(self, sid, data):
        data = data if isinstance(data, dict) else {}
        pref = data.get("engine")
        if pref not in ENGINES:
            return {"ok": False, "error": "engine must be auto, brick or mcu"}
        with self.lock:
            self.engine_pref = pref
        self._save_pref()
        if not self._refresh_engine():
            self.ui.send_message("hw", self.status_payload(), room="motion")
        return {"ok": True, "engine": self.engine_status()}

    def on_btn(self, index, pressed):
        try:
            i = int(index)
        except (TypeError, ValueError):
            return
        if 0 <= i <= 2:
            self.ui.send_message("btn", {"i": i, "p": bool(pressed)}, room="motion")

    def on_hw(self, text):
        info = parse_hw(text)
        with self.lock:
            first = self.hw is None
            self.hw, self.hw_at = info, time.time()
            if first:
                self.leds = None      # MCU (re)started: resend the button LEDs
        if not self._refresh_engine():
            self.ui.send_message("hw", self.status_payload(), room="motion")
        self._send_ml_engine(force=True)   # heartbeat: survives an MCU reset

    # ------------------------------------------------------------- status

    def board_online(self):
        return self.hw is not None and time.time() - self.hw_at < BOARD_TIMEOUT_S

    def status_payload(self):
        with self.lock:
            online = self.board_online()
            hw = dict(self.hw) if self.hw else None
            changed = self.changed_model
            job = dict(self.job) if self.job else None
        installed = model_installer.installed_model()
        running = bool(hw and hw.get("model"))
        # the board runs another model than the one on disk: a restart is pending or the compile failed
        mismatch = online and not hw.get("sim") and bool(installed) != running
        return {"online": online, "hw": hw, "installed": installed, "restartNeeded": changed or mismatch,
                "job": job, "owner": self.owner, "ownerKind": self.owner_kind,
                "ownerVisible": self.owner_visible, "engine": self.engine_status()}

    def on_status(self, sid, data):
        st = self.status_payload()
        with self.lock:
            st["ml"] = self.last_ml
        return st

    # ------------------------------------------------------------- browser -> MCU

    def _owner_msg(self):
        return {"id": self.owner, "kind": self.owner_kind, "visible": self.owner_visible}

    def on_claim(self, sid, data):
        # force: "use the wheel here" / Motion Lab. focused: a game tab with the
        # focus takes it from the Motion Lab or from a game tab nobody can see,
        # never from another LAN player's game on screen.
        data = data if isinstance(data, dict) else {}
        with self.lock:
            kind = "lab" if data.get("kind") == "lab" else "game"
            focused = data.get("focused") or data.get("fromLab")
            if data.get("release"):
                if self.owner == sid:
                    self.owner = self.owner_kind = None
                    self.owner_visible = False
            elif (data.get("force") or self.owner is None or self.owner == sid
                  or (focused and (self.owner_kind == "lab" or not self.owner_visible))):
                self.owner, self.owner_kind = sid, kind
                # clients that do not report it (an old tab) count as hidden
                self.owner_visible = data.get("visible") is True
            msg = self._owner_msg()
        self.ui.send_message("motion_owner", msg, room="motion")
        return {"owner": msg["id"], "kind": msg["kind"], "visible": msg["visible"]}

    def on_visible(self, sid, data):
        # the owner tab went to the background or came back
        data = data if isinstance(data, dict) else {}
        with self.lock:
            if self.owner != sid:
                return {"ok": False}
            self.owner_visible = bool(data.get("visible"))
            msg = self._owner_msg()
        self.ui.send_message("motion_owner", msg, room="motion")
        return {"ok": True}

    def _may_drive(self, sid):
        return self.owner is None or self.owner == sid

    def on_pix(self, sid, data):
        # Pixels state of the snowball HUD: mode 0..7 (see sketch.ino), value -100..100
        if not self._may_drive(sid):
            return None
        data = data if isinstance(data, dict) else {}
        mode = data.get("mode")
        value = data.get("value", 0)
        if not _finite(mode) or not _finite(value):
            return None
        args = (max(0, min(7, int(mode))), max(-100, min(100, int(value))))
        with self.lock:
            self.pix_pending = args
        self.flush_pix()
        return None

    def flush_pix(self):
        with self.lock:
            args = self.pix_pending
            last, at = self.pix_last
            t = time.monotonic()
            if args is None or (args == last and t - at < 0.5) or t - at < PIX_MIN_INTERVAL_S:
                return
            self.pix_pending = None
            self.pix_last = (args, t)
        self._notify("pix", *args)

    def on_leds(self, sid, data):
        if not self._may_drive(sid):
            return None
        data = data if isinstance(data, dict) else {}
        mask = data.get("mask")
        if not _finite(mask):
            return None
        mask = int(mask) & 7
        with self.lock:
            if mask == self.leds:
                return None
            self.leds = mask
        self._notify("btn_leds", mask)
        return None

    def _notify(self, name, *args):
        try:
            self.bridge.notify(name, *args)
        except Exception as e:
            print(f"[Ardu Snowball] Bridge notify {name} failed: {e}")

    def tick(self):
        """Called from the main 20 Hz loop."""
        self.flush_pix()
        with self.lock:
            stale = self._active == "mcu" and not self.board_online()
        if stale:
            self._refresh_engine()

    # ------------------------------------------------------------- recording

    def on_record(self, sid, data):
        data = data if isinstance(data, dict) else {}
        label = str(data.get("label", "")).strip()
        ms = data.get("ms")
        if not LABEL_RE.match(label):
            return {"ok": False, "error": "labels may use letters, digits, space, _ - . (max 64)"}
        if not _finite(ms) or not 200 <= ms <= MAX_RECORD_MS:
            return {"ok": False, "error": f"length must be 0.2 .. {MAX_RECORD_MS // 1000} s"}
        with self.lock:
            if not self.board_online() or not self.hw.get("movement"):
                return {"ok": False, "error": "no Modulino Movement detected on the board"}
            interval = self.hw["interval"]
            need = max(1, int(round(ms / interval)))
            self.recordings[sid] = {"label": label, "need": need, "values": [], "started": time.time()}
        return {"ok": True, "samples": need, "interval": interval}

    def on_record_cancel(self, sid, data):
        with self.lock:
            self.recordings.pop(sid, None)
        return {"ok": True}

    def forget(self, sid):
        with self.lock:
            self.recordings.pop(sid, None)
            released = self.owner == sid
            if released:
                self.owner = self.owner_kind = None
                self.owner_visible = False
                msg = self._owner_msg()
        if released:
            self.ui.send_message("motion_owner", msg, room="motion")

    # ------------------------------------------------------------- Edge Impulse

    @staticmethod
    def _key(data):
        key = str((data or {}).get("apiKey", "")).strip()
        if not API_KEY_RE.match(key):
            raise EIError("that does not look like an Edge Impulse API key (it starts with ei_)")
        return key

    def _project_id(self, key):
        res = _ei_request("GET", f"{STUDIO_URL}/projects", key)
        projects = res.get("projects") or []
        if not projects:
            raise EIError("no project is linked to this API key")
        return projects[0]

    def on_ei_project(self, sid, data):
        try:
            key = self._key(data)
            proj = self._project_id(key)
            pid = proj["id"]
            info = _ei_request("GET", f"{STUDIO_URL}/{pid}", key)
            per = info.get("dataSummaryPerCategory") or {}
            summary = {}
            for cat in ("training", "testing"):
                c = per.get(cat) or {}
                summary[cat] = {"count": c.get("dataCount", 0), "ms": c.get("totalLengthMs", 0),
                                "labels": c.get("labels") or []}
            labels = sorted(set(summary["training"]["labels"]) | set(summary["testing"]["labels"]))
            impulse = None
            try:
                imp = _ei_request("GET", f"{STUDIO_URL}/{pid}/impulse", key).get("impulse") or {}
                inp = (imp.get("inputBlocks") or [{}])[0]
                if imp.get("learnBlocks"):
                    impulse = {"windowMs": inp.get("windowSizeMs"), "strideMs": inp.get("windowIncreaseMs"),
                               "hz": inp.get("frequencyHz"),
                               "dsp": [b.get("title") or b.get("type") for b in imp.get("dspBlocks") or []],
                               "learn": [b.get("title") or b.get("type") for b in imp.get("learnBlocks") or []]}
            except EIError:
                pass
            p = info.get("project") or proj
            return {"ok": True, "project": {"id": pid, "name": p.get("name", proj.get("name")),
                                            "owner": p.get("owner", "")},
                    "summary": summary, "labels": labels, "impulse": impulse,
                    "studio": f"https://studio.edgeimpulse.com/studio/{pid}"}
        except EIError as e:
            return {"ok": False, "error": str(e)}

    def on_ei_upload(self, sid, data):
        data = data if isinstance(data, dict) else {}
        try:
            key = self._key(data)
            label = str(data.get("label", "")).strip()
            if not LABEL_RE.match(label):
                raise EIError("invalid label")
            category = "testing" if data.get("category") == "testing" else "training"
            interval = data.get("interval")
            values = data.get("values")
            if not _finite(interval) or not 1 <= interval <= 1000:
                raise EIError("invalid sample interval")
            if not isinstance(values, list) or not 2 <= len(values) <= MAX_UPLOAD_SAMPLES:
                raise EIError("a sample needs 2 .. 4000 readings")
            rows = []
            for row in values:
                if not isinstance(row, list) or len(row) != 6 or not all(_finite(v) for v in row):
                    raise EIError("readings must be 6 finite numbers")
                rows.append([round(row[0] * GRAVITY, 4), round(row[1] * GRAVITY, 4), round(row[2] * GRAVITY, 4),
                             round(row[3], 3), round(row[4], 3), round(row[5], 3)])
            device = re.sub(r"[^A-Za-z0-9_\-]", "", str(data.get("device") or "uno-q-rod"))[:40] or "uno-q-rod"
            doc = {
                "protected": {"ver": "v1", "alg": "none", "iat": int(time.time())},
                "signature": "0" * 64,
                "payload": {"device_name": device, "device_type": "ARDUINO_UNO_Q",
                            "interval_ms": float(interval),
                            "sensors": [{"name": n, "units": u} for n, u in SENSORS],
                            "values": rows},
            }
            safe = re.sub(r"[^A-Za-z0-9_\-.]", "_", label)
            res = _ei_request("POST", f"{INGEST_URL}/api/{category}/data", key, body=doc,
                              headers={"x-label": label, "x-file-name": f"{safe}.json", "x-add-date-id": "1"})
            return {"ok": True, "label": label, "category": category, "samples": len(rows),
                    "file": res.get("text", "") if isinstance(res, dict) else ""}
        except EIError as e:
            return {"ok": False, "error": str(e)}

    def on_ei_job(self, sid, data):
        data = data if isinstance(data, dict) else {}
        kind = data.get("kind")
        if kind not in ("retrain", "build", "train_build"):
            return {"ok": False, "error": "unknown job"}
        try:
            key = self._key(data)
        except EIError as e:
            return {"ok": False, "error": str(e)}
        with self.lock:
            if self.job:
                return {"ok": False, "error": f"a {self.job['kind']} job is already running"}
            self.job = {"sid": sid, "kind": kind, "stage": "starting", "started": _now_ms()}
        threading.Thread(target=self._run_job, args=(sid, kind, key), daemon=True, name="ei-job").start()
        return {"ok": True}

    def _progress(self, sid, stage, line=None, **extra):
        with self.lock:
            if self.job:
                self.job["stage"] = stage
        msg = {"stage": stage, **extra}
        if line is not None:
            msg["line"] = line
        self.ui.send_message("ei_job_progress", msg, room=sid)

    def _wait_job(self, sid, key, pid, job_id, stage):
        seen = set()
        deadline = time.time() + JOB_TIMEOUT_S
        while time.time() < deadline:
            try:
                out = _ei_request("GET", f"{STUDIO_URL}/{pid}/jobs/{job_id}/stdout", key)
                lines = out.get("stdout") or []
                lines = sorted(lines, key=lambda l: str(l.get("created", "")))
                for l in lines:
                    k = (l.get("created"), l.get("data"))
                    if k in seen:
                        continue
                    seen.add(k)
                    text = str(l.get("data", "")).rstrip()
                    if text:
                        self._progress(sid, stage, line=text[-400:])
            except EIError:
                pass
            st = _ei_request("GET", f"{STUDIO_URL}/{pid}/jobs/{job_id}/status", key).get("job") or {}
            if st.get("finished"):
                if not st.get("finishedSuccessful"):
                    raise EIError(f"the {stage} job failed in Edge Impulse (see the log above)")
                return
            time.sleep(2)
        raise EIError(f"the {stage} job timed out")

    def _run_job(self, sid, kind, key):
        try:
            pid = self._project_id(key)["id"]
            if kind in ("retrain", "train_build"):
                self._progress(sid, "training", line="Starting training (DSP + learning blocks)...")
                res = _ei_request("POST", f"{STUDIO_URL}/{pid}/jobs/retrain", key, body={})
                self._wait_job(sid, key, pid, res["id"], "training")
                self._progress(sid, "trained", line="Training finished.")
            if kind in ("build", "train_build"):
                self._progress(sid, "building", line="Building the Arduino library (EON compiler)...")
                res = _ei_request("POST", f"{STUDIO_URL}/{pid}/jobs/build-ondevice-model?type=arduino", key,
                                  body={"engine": "tflite-eon"})
                self._wait_job(sid, key, pid, res["id"], "building")
                self._progress(sid, "downloading", line="Downloading the library...")
                blob = _ei_request("GET", f"{STUDIO_URL}/{pid}/deployment/download?type=arduino&engine=tflite-eon",
                                   key, raw=True, headers={"Accept": "application/zip"})
                self._progress(sid, "installing", line=f"Installing into the sketch ({len(blob) // 1024} KB)...")
                info = self.install(blob)
                self._progress(sid, "done", line=f"Installed {info['name']}. Restart the app to flash it.",
                               installed=info)
            else:
                self._progress(sid, "done", line="Done.")
        except (EIError, model_installer.InstallError, KeyError) as e:
            self._progress(sid, "error", line=str(e), error=str(e))
        except Exception as e:  # never kill the thread silently
            self._progress(sid, "error", line=f"unexpected error: {e}", error=str(e))
        finally:
            with self.lock:
                self.job = None
            self.ui.send_message("hw", self.status_payload(), room="motion")

    # ------------------------------------------------------------- model files

    def install(self, blob):
        info = model_installer.install_zip(blob)
        with self.lock:
            self.changed_model = True
        return info

    def on_model_upload(self, sid, data):
        data = data if isinstance(data, dict) else {}
        b64 = data.get("data")
        if not isinstance(b64, str) or len(b64) > MAX_MODEL_ZIP * 4 // 3 + 8:
            return {"ok": False, "error": "send the Edge Impulse Arduino library .zip (max 8 MB)"}
        try:
            blob = base64.b64decode(b64.split(",", 1)[-1], validate=False)
            info = self.install(blob)
        except (ValueError, model_installer.InstallError) as e:
            return {"ok": False, "error": str(e)}
        self.ui.send_message("hw", self.status_payload(), room="motion")
        return {"ok": True, "installed": info}

    def on_model_remove(self, sid, data):
        model_installer.remove_model()
        with self.lock:
            self.changed_model = True
        self.ui.send_message("hw", self.status_payload(), room="motion")
        return {"ok": True}

    # ------------------------------------------------------------- wiring

    def register(self):
        ui = self.ui
        ui.on_message("motion_status", self.on_status)
        ui.on_message("motion_claim", self.on_claim)
        ui.on_message("motion_visible", self.on_visible)
        ui.on_message("pix", self.on_pix)
        ui.on_message("ctl_leds", self.on_leds)
        ui.on_message("motion_record", self.on_record)
        ui.on_message("motion_record_cancel", self.on_record_cancel)
        ui.on_message("ei_project", self.on_ei_project)
        ui.on_message("ei_upload", self.on_ei_upload)
        ui.on_message("ei_job", self.on_ei_job)
        ui.on_message("model_upload", self.on_model_upload)
        ui.on_message("model_remove", self.on_model_remove)
        ui.on_message("motion_engine", self.on_engine)
        self.brick.start()
        try:
            self.bridge.provide("imu", self.on_imu)
            self.bridge.provide("ml", self.on_ml)
            self.bridge.provide("btn", self.on_btn)
            self.bridge.provide("hw", self.on_hw)
        except Exception as e:  # running without the router (local development)
            print(f"[Ardu Snowball] Bridge unavailable, motion controller disabled: {e}")
