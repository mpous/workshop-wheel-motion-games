"""End-to-end test of ardu-kart/python/main.py against the real WebUI brick.

Starts the server as a subprocess (stub arduino package, debug LED endpoint),
drives it with python-socketio clients and checks the protocol.

Run:  devtools/.venv/bin/python devtools/test_server.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import base64
import io
import zipfile

import socketio

from fake_ei import FakeEI, LIB

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "ardu-kart")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = int(os.environ.get("ARDUKART_TEST_PORT", free_port()))
BASE = f"http://127.0.0.1:{PORT}"
PASSED = []


def check(cond, label):
    if not cond:
        raise AssertionError(label)
    PASSED.append(label)
    print(f"  ok  {label}")


class Client:
    def __init__(self, label):
        self.label = label
        self.sio = socketio.Client(reconnection=False)
        self.events = []
        self.cv = threading.Condition()
        self.sio.on("*", self._on_any)

    def _on_any(self, event, data=None):
        with self.cv:
            self.events.append((event, data))
            self.cv.notify_all()

    def connect(self):
        self.sio.connect(BASE, transports=["websocket"], wait_timeout=10)
        return self

    @property
    def sid(self):
        return self.sio.get_sid()

    def wait(self, event, pred=lambda d: True, timeout=5.0, consume=True):
        deadline = time.time() + timeout
        with self.cv:
            while True:
                for i, (ev, data) in enumerate(self.events):
                    if ev == event and pred(data):
                        if consume:
                            del self.events[: i + 1]
                        return data
                left = deadline - time.time()
                if left <= 0:
                    raise AssertionError(f"[{self.label}] timeout waiting for '{event}'")
                self.cv.wait(left)

    def count(self, event):
        with self.cv:
            return sum(1 for ev, _ in self.events if ev == event)

    def flush(self):
        with self.cv:
            self.events.clear()

    def call(self, event, data=None, timeout=5.0):
        self.sio.emit(event, data if data is not None else {})
        return self.wait(event + "_response", timeout=timeout)

    def close(self):
        try:
            self.sio.disconnect()
        except Exception:
            pass


def http_json(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return json.loads(r.read())


def led():
    return http_json("/api/debug/led")["led"]


def wait_led(expected, timeout=8.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = led()
        if (expected(last) if callable(expected) else last == expected):
            return last
        time.sleep(0.05)
    raise AssertionError(f"LED state never matched, last={last!r}")


def start_server(env):
    proc = subprocess.Popen([os.path.join(HERE, "run_server.sh")], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    threading.Thread(target=lambda: [lines.append(l) for l in proc.stdout], daemon=True).start()
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            http_json("/api/status")
            return proc, lines
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError("server failed to start:\n" + "".join(lines))


def stop_server(proc):
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


def mcu():
    return http_json("/api/debug/mcu")


def sim(**q):
    return http_json("/api/debug/sim?" + "&".join(f"{k}={v}" for k, v in q.items()))


def motion_tests(env, tmp):
    """Modulino wheel + Motion Lab: simulated board, fake Edge Impulse, temp app dir."""
    print("== motion controller (simulated board)")
    app_dir = os.path.join(tmp, "app")
    shutil.copytree(os.path.join(APP, "sketch"), os.path.join(app_dir, "sketch"),
                    ignore=shutil.ignore_patterns("libraries", "build"))
    key = "ei_" + "f00d" * 12
    ei = FakeEI(key).start()
    env = dict(env, ARDUKART_SIM_BOARD="1", ARDUKART_APP_DIR=app_dir,
               ARDUKART_EI_STUDIO_URL=ei.url + "/v1/api", ARDUKART_EI_INGEST_URL=ei.url)
    proc, logs = start_server(env)
    clients = []
    try:
        M1, M2 = Client("M1").connect(), Client("M2").connect()
        clients += [M1, M2]
        for c in (M1, M2):
            c.sio.emit("enter_room", "motion")
        imu = M1.wait("imu", timeout=5)
        check(len(imu["s"]) >= 1 and all(len(r) == 6 for r in imu["s"]) and imu["i"] == 16.0, "imu batches of 6-axis readings")
        st = M1.wait("hw", lambda d: d["online"], timeout=5)
        check(st["hw"]["movement"] and st["hw"]["buttons"] and st["hw"]["pixels"] and st["hw"]["sim"], "hw heartbeat: Modulinos detected")
        check(st["hw"]["model"] and st["hw"]["labels"] == ["idle", "accelerate", "brake", "use_item", "change_camera"], "hw heartbeat: model labels")
        st = M1.call("motion_status")
        check(st["online"] and st["owner"] is None and st["installed"] is None and not st["restartNeeded"], "motion_status")

        print("== wheel ownership")
        check(M1.call("motion_claim", {"force": False, "visible": True})["owner"] == M1.sid, "first claim takes the free wheel")
        M2.wait("motion_owner", lambda d: d["id"] == M1.sid)
        check(True, "motion_owner broadcast to the room")
        check(M2.call("motion_claim", {"force": False})["owner"] == M1.sid, "second claim does not steal it")
        M2.sio.emit("rev", {"speed": 33, "flags": 1})
        M1.sio.emit("rev", {"speed": 80, "flags": 3})
        time.sleep(0.4)
        check(mcu().get("rev") == [80, 3], "rev from the owner reaches the Pixels")
        M2.sio.emit("rev", {"speed": 10, "flags": 1})
        time.sleep(0.3)
        check(mcu().get("rev") == [80, 3], "rev from a non-owner is ignored")
        M1.sio.emit("ctl_leds", {"mask": 5})
        time.sleep(0.3)
        check(mcu().get("btn_leds") == [5], "ctl_leds from the owner")
        check(M2.call("motion_claim", {"force": False, "focused": True, "visible": True})["owner"] == M1.sid, "a focused game does not take the wheel from a game on screen")
        M1.sio.emit("motion_visible", {"visible": False})
        M2.wait("motion_owner", lambda d: d["id"] == M1.sid and d["visible"] is False)
        check(True, "the owner tab reports it is hidden")
        check(M2.call("motion_claim", {"force": False, "visible": True})["owner"] == M1.sid, "an unfocused tab does not take it")
        r = M2.call("motion_claim", {"force": False, "focused": True, "visible": True})
        check(r["owner"] == M2.sid and r["visible"] is True, "a focused game takes the wheel from a hidden game tab")
        M2.sio.emit("motion_visible", {"visible": True})
        check(M1.call("motion_claim", {"force": True, "visible": True})["owner"] == M1.sid, "USE THE WHEEL HERE (force) takes it from a game on screen")
        M1.sio.emit("motion_visible", {"visible": False, "x": 1})
        M1.sio.emit("motion_visible", {"visible": True})
        time.sleep(0.2)
        M2.sio.emit("motion_visible", {"visible": False})
        time.sleep(0.2)
        check(M1.call("motion_status")["ownerVisible"] is True, "only the owner can report visibility")
        r = M2.call("motion_claim", {"force": True, "kind": "lab"})
        check(r["owner"] == M2.sid and r["kind"] == "lab", "forced claim (Motion Lab) takes over")
        check(M1.call("motion_status")["ownerKind"] == "lab", "status reports the owner kind")
        check(M1.call("motion_claim", {"force": False})["owner"] == M2.sid, "a plain claim does not take it from the lab")
        r = M1.call("motion_claim", {"force": False, "fromLab": True})
        check(r["owner"] == M1.sid and r["kind"] == "game", "the focused game takes the wheel back from the lab")
        M2.call("motion_claim", {"force": True, "kind": "lab"})
        M2.close()
        M1.wait("motion_owner", lambda d: d["id"] is None)
        check(M1.call("motion_status")["owner"] is None, "owner released on disconnect")

        print("== gestures and buttons")
        M1.flush()
        sim(gesture="use_item")
        ml = M1.wait("ml", lambda d: max(d["p"]) == d["p"][3], timeout=3)
        check(ml["labels"][3] == "use_item" and ml["p"][3] > 0.8 and "dsp" in ml and "nn" in ml, "ml probabilities for a gesture")
        sim(button=1)
        b = M1.wait("btn", lambda d: d["i"] == 1 and d["p"])
        b = M1.wait("btn", lambda d: d["i"] == 1 and not d["p"])
        check(True, "button press and release edges")

        print("== recording")
        bad = M1.call("motion_record", {"label": "no/slash", "ms": 1000})
        check(not bad["ok"], "invalid label refused")
        bad = M1.call("motion_record", {"label": "idle", "ms": 999999})
        check(not bad["ok"], "too long recording refused")
        r = M1.call("motion_record", {"label": "idle", "ms": 1000})
        check(r["ok"] and r["samples"] == 62 and r["interval"] == 16.0, "recording started")
        done = M1.wait("motion_record_done", timeout=5)
        check(done["label"] == "idle" and len(done["values"]) == 62 and done["durationMs"] == 992, "recording delivered")
        values = done["values"]
        r = M1.call("motion_record", {"label": "brake", "ms": 2000})
        check(M1.call("motion_record_cancel")["ok"], "recording cancelled")
        time.sleep(2.3)
        check(M1.count("motion_record_done") == 0, "no result after cancel")

        print("== Edge Impulse (fake API)")
        r = M1.call("ei_project", {"apiKey": "nope"})
        check(not r["ok"] and "ei_" in r["error"], "malformed API key refused locally")
        r = M1.call("ei_project", {"apiKey": "ei_" + "0" * 48})
        check(not r["ok"] and "rejected" in r["error"], "wrong API key reported")
        r = M1.call("ei_project", {"apiKey": key})
        check(r["ok"] and r["project"]["id"] == 4242 and r["project"]["name"] == "Ardu Kart wheel", "project info")
        check(r["impulse"] == {"windowMs": 1000, "strideMs": 250, "hz": 62.5, "dsp": ["Spectral Analysis"], "learn": ["Classifier"]}, "impulse summary")
        r = M1.call("ei_upload", {"apiKey": key, "label": "idle", "category": "training", "interval": 16.0, "values": values})
        check(r["ok"] and r["samples"] == 62 and r["category"] == "training", "sample uploaded")
        up = ei.uploads[-1]
        pl = up["doc"]["payload"]
        check(up["category"] == "training" and up["label"] == "idle" and pl["interval_ms"] == 16.0
              and [s["name"] for s in pl["sensors"]] == ["accX", "accY", "accZ", "gyrX", "gyrY", "gyrZ"], "ingestion document")
        check(abs(pl["values"][0][1] - values[0][1] * 9.80665) < 0.01 and pl["values"][0][3] == values[0][3], "acceleration sent in m/s2, gyro in dps")
        r = M1.call("ei_upload", {"apiKey": key, "label": "use_item", "category": "testing", "interval": 16.0, "values": values[:20]})
        check(r["ok"] and ei.uploads[-1]["category"] == "testing", "testing sample uploaded")
        r = M1.call("ei_upload", {"apiKey": key, "label": "idle", "interval": 16.0, "values": [[1, 2, 3]] * 5})
        check(not r["ok"], "malformed readings refused")
        r = M1.call("ei_project", {"apiKey": key})
        check(r["summary"]["training"]["count"] == 1 and r["summary"]["testing"]["count"] == 1 and r["labels"] == ["idle", "use_item"], "data summary")

        print("== train + build + install")
        M1.flush()
        check(M1.call("ei_job", {"apiKey": key, "kind": "train_build"})["ok"], "job started")
        check(not M1.call("ei_job", {"apiKey": key, "kind": "retrain"})["ok"], "second job refused while one runs")
        stages = []
        while True:
            p = M1.wait("ei_job_progress", timeout=20)
            stages.append(p["stage"])
            if p["stage"] in ("done", "error"):
                break
        check(p["stage"] == "done" and p["installed"]["folder"] == LIB, f"job finished and installed ({p.get('line')})")
        order = [s for i, s in enumerate(stages) if i == 0 or stages[i - 1] != s]
        check(order == ["training", "trained", "building", "downloading", "installing", "done"], f"job stages in order ({order})")
        build = [j for j in ei.jobs.values() if j["kind"] == "build-ondevice-model"][0]
        check(build["body"] == {"engine": "tflite-eon"} and "type=arduino" in build["query"], "build requested as Arduino library (EON)")
        sk = os.path.join(app_dir, "sketch")
        with open(os.path.join(sk, "model_config.h")) as f:
            cfg = f.read()
        with open(os.path.join(sk, "sketch.yaml")) as f:
            yml = f.read()
        check("ARDUKART_HAS_MODEL 1" in cfg and f"<{LIB}.h>" in cfg, "model_config.h points at the library")
        check(f"- dir: libraries/{LIB}" in yml and "Arduino_Modulino" in yml, "sketch.yaml lists the library")
        check(os.path.isfile(os.path.join(sk, "libraries", LIB, "src", LIB + ".h")), "library unpacked into the sketch")
        st = M1.call("motion_status")
        check(st["installed"]["folder"] == LIB and st["restartNeeded"], "status: installed, restart needed")

        print("== manual model files")
        check(M1.call("model_remove")["ok"], "model removed")
        with open(os.path.join(sk, "model_config.h")) as f:
            check("ARDUKART_HAS_MODEL 0" in f.read() and not os.path.exists(os.path.join(sk, "libraries", LIB)), "sketch back to no model")
        zip_b64 = "data:application/zip;base64," + base64.b64encode(ei.route("GET", "/v1/api/4242/deployment/download", {}, b"")[1]).decode()
        r = M1.call("model_upload", {"data": zip_b64})
        check(r["ok"] and r["installed"]["name"] == "Ardu Kart wheel" and r["installed"]["version"] == "1.0.3", "zip uploaded from the browser")
        r = M1.call("model_upload", {"data": base64.b64encode(b"not a zip").decode()})
        check(not r["ok"] and "zip" in r["error"], "non-zip refused")
        evil = io.BytesIO()
        with zipfile.ZipFile(evil, "w") as z:
            z.writestr("x_inferencing/src/x_inferencing.h", "")
            z.writestr("x_inferencing/../../../escape.txt", "boom")
        r = M1.call("model_upload", {"data": base64.b64encode(evil.getvalue()).decode()})
        check(not r["ok"] and "unsafe" in r["error"] and not os.path.exists(os.path.join(tmp, "escape.txt"))
              and not os.path.exists(os.path.join(sk, "libraries", ".staging")), "zip-slip refused, nothing left behind")
        check(M1.call("motion_status")["installed"]["folder"] == LIB, "previous model kept after a bad upload")
        M1.close()
    finally:
        for c in clients:
            c.close()
        stop_server(proc)
        ei.stop()
    return logs


def brick_tests(env, tmp):
    """App Lab Motion detection brick (stub) as the gesture engine, engine selection + persistence."""
    print("== Motion detection brick (simulated)")
    app_dir = os.path.join(tmp, "app-brick")
    shutil.copytree(os.path.join(APP, "sketch"), os.path.join(app_dir, "sketch"),
                    ignore=shutil.ignore_patterns("libraries", "build"))
    data_dir = os.path.join(tmp, "brick-data")
    base = dict(env, ARDUKART_SIM_BOARD="1", ARDUKART_SIM_BRICK="1", ARDUKART_APP_DIR=app_dir, ARDUKART_DATA_DIR=data_dir)
    labels = ["idle", "accelerate", "brake", "use_item", "change_camera"]

    # 1) sketch without a model: "auto" picks the brick
    proc, logs = start_server(dict(base, ARDUKART_SIM_MODEL="0"))
    M = None
    try:
        M = Client("MB").connect()
        M.sio.emit("enter_room", "motion")
        st = M.wait("hw", lambda d: d["online"] and d["engine"]["active"] == "brick", timeout=8)
        eng = st["engine"]
        check(eng["pref"] == "auto" and eng["labels"] == labels and eng["brick"]["state"] == "ready"
              and eng["brick"]["axes"] == 6 and eng["brick"]["windowMs"] == 992, "auto engine: brick when the sketch has no model")
        M.flush()
        time.sleep(1.2)               # the window refills after the engine switch
        sim(gesture="brake")
        ml = M.wait("ml", lambda d: d["src"] == "brick" and max(d["p"]) == d["p"][2], timeout=4)
        check(ml["labels"] == labels and ml["p"][2] > 0.8, "brick classifies the rolling window (brake)")
        n = M.count("ml")
        time.sleep(1.0)
        check(3 <= M.count("ml") - n <= 6, f"brick results ~4x per second ({M.count('ml') - n}/s)")
        m = mcu()
        check(m.get("gesture", [None])[0] == 2 and m["gesture"][1] == "brake" and m.get("ml_engine") == [0],
              "brick gesture sent to the MCU matrix, MCU model display off")
        r = M.call("motion_engine", {"engine": "turbo"})
        check(not r["ok"], "unknown engine refused")
        r = M.call("motion_engine", {"engine": "mcu"})
        check(r["ok"] and r["engine"]["active"] is None, "engine 'mcu' without an MCU model: no engine")
        M.flush()
        time.sleep(0.8)
        check(M.count("ml") == 0, "no brick results while the MCU engine is selected")
        r = M.call("motion_engine", {"engine": "brick"})
        check(r["ok"] and r["engine"]["active"] == "brick", "engine 'brick' selected")
        with open(os.path.join(data_dir, "motion.json")) as f:
            check(json.load(f) == {"engine": "brick"}, "engine preference saved to the data folder")
        M.close()
    finally:
        if M:
            M.close()
        stop_server(proc)

    # 2) sketch with a model, preference "brick" kept across restarts
    proc, logs2 = start_server(dict(base, ARDUKART_SIM_MODEL="1"))
    M = None
    try:
        M = Client("MB2").connect()
        M.sio.emit("enter_room", "motion")
        st = M.wait("hw", lambda d: d["online"] and d["engine"]["active"] == "brick", timeout=8)
        check(st["engine"]["pref"] == "brick", "preference restored after restart: brick over the MCU model")
        M.flush()
        time.sleep(1.8)
        check(M.count("ml") > 0 and all(d["src"] == "brick" for e, d in M.events if e == "ml"), "MCU results dropped while the brick is active")
        r = M.call("motion_engine", {"engine": "auto"})
        check(r["ok"] and r["engine"]["active"] == "mcu" and r["engine"]["labels"] == labels, "auto engine: MCU model preferred when installed")
        M.flush()
        M.wait("ml", lambda d: d["src"] == "mcu", timeout=3)
        time.sleep(0.3)
        check(mcu().get("ml_engine") == [1], "MCU model display back on")
        M.close()
    finally:
        if M:
            M.close()
        stop_server(proc)
    return logs + logs2


def big_lobby_tests():
    print("== 20-player lobby")
    players = [Client(f"P{i}").connect() for i in range(21)]
    try:
        joined = [p.call("lobby_join", {"name": f"Racer {i}", "character": i % 8}) for i, p in enumerate(players[:20])]
        check(all(r == {"ok": True} for r in joined), "20 players join the lobby")
        r = players[20].call("lobby_join", {"name": "Late", "character": 0})
        check(r == {"ok": False, "reason": "lobby_full"}, "21st player rejected (lobby_full)")
        check(led() == "lobby:20", "LED lobby:20")
        players[0].call("lobby_settings", {"track": "test-track", "cc": 100, "laps": 1, "bots": True})
        for p in players[1:20]:
            p.call("lobby_update", {"ready": True})
        players[20].flush()
        check(players[0].call("lobby_start")["ok"], "20-player race starts")
        rs = players[20].wait("race_start")
        check(len(rs["grid"]) == 20 and not any(k["isBot"] for k in rs["grid"]), "grid of 20 humans, no CPU fill")
        check(rs["netHz"] == 10, "big field: snapshots at 10 Hz")
        for p in players[:20]:
            p.sio.emit("enter_room", "race")
        time.sleep(0.3)
        players[5].flush()
        t0 = time.time()
        while time.time() - t0 < 2.0:
            for i, p in enumerate(players[:20]):
                p.sio.emit("state", {"karts": [{"id": p.sid, "lap": 1, "prog": i * 0.01, "x": float(i)}]})
            time.sleep(0.1)
        n = players[5].count("snapshot")
        last = [d for e, d in players[5].events if e == "snapshot"][-1]
        check(14 <= n <= 24 and len(last["karts"]) == 20, f"10 Hz snapshots with all 20 karts ({n} in 2 s)")
        wait_led(lambda s: s.startswith("race:1:1:20") or s.startswith("count:"), timeout=3)
        check(True, "LED shows 20 racers")
    finally:
        for p in players:
            p.close()


def main():
    tmp = tempfile.mkdtemp(prefix="ardukart-test-")
    data_dir = os.path.join(tmp, "data")
    assets = os.path.join(APP, "assets")
    if not os.path.exists(os.path.join(assets, "index.html")):
        # browser game not written yet: serve a temporary placeholder (outside ardu-kart)
        assets = os.path.join(tmp, "assets")
        os.makedirs(assets)
        with open(os.path.join(assets, "index.html"), "w") as f:
            f.write("<!doctype html><title>Ardu Kart placeholder</title>")
    env = dict(os.environ, ARDUKART_ASSETS=assets, ARDUKART_DATA_DIR=data_dir,
               ARDUKART_PORT=str(PORT), ARDUKART_DEBUG="1")
    proc, logs = start_server(env)
    clients = []
    try:
        print("== basics")
        st = http_json("/api/status")
        check(st["version"] == "1.1.0" and st["racing"] is False, "REST /api/status")
        with urllib.request.urlopen(BASE + "/", timeout=5) as r:
            check(r.status == 200, "static index served")
        A, B, C = (Client(n).connect() for n in "ABC")
        clients += [A, B, C]
        h = A.call("hello", {"name": "Alice"})
        check(h["id"] == A.sid and "records" in h and "lobby" in h and isinstance(h["serverTime"], float), "hello_response")
        B.call("hello", {"name": "Bob"}); C.call("hello", {"name": "Carol"})
        c = A.call("clock", {"t": 123.5})
        check(c["t"] == 123.5 and abs(c["serverTime"] - time.time() * 1000) < 2000, "clock sync")
        check(led() == "idle", "LED idle")

        print("== solo LED")
        C.sio.emit("solo_status", {"state": "countdown", "count": 2, "lap": 0, "laps": 3, "pos": 1, "total": 8})
        wait_led("count:2"); check(True, "LED solo countdown -> count:2")
        C.sio.emit("solo_status", {"state": "race", "count": 0, "lap": 2, "laps": 3, "pos": 4, "total": 8})
        wait_led("race:2:3:4"); check(True, "LED solo race -> race:2:3:4")
        C.sio.emit("solo_status", {"state": "finished", "count": 0, "lap": 3, "laps": 3, "pos": 3, "total": 8})
        wait_led("finish:3"); check(True, "LED solo finished -> finish:3")
        C.sio.emit("solo_status", {"state": "menu"})
        wait_led("idle"); check(True, "LED solo menu -> idle")

        print("== lobby")
        r = A.call("lobby_join", {"name": "Alice", "character": 2})
        check(r == {"ok": True}, "A joins lobby")
        r = B.call("lobby_join", {"name": "Bob", "character": 5})
        check(r == {"ok": True}, "B joins lobby")
        lob = C.wait("lobby", lambda d: len(d["members"]) == 2)
        check(lob["max"] == 20, "lobby advertises 20 player slots")
        check(lob["hostId"] == A.sid and lob["members"][0]["isHost"] and not lob["members"][1]["isHost"],
              "non-member C sees lobby broadcast, A is host")
        check(led() == "lobby:2", "LED lobby:2")
        r = B.call("lobby_settings", {"track": "x", "cc": 50, "laps": 1, "bots": False})
        check(r["ok"] is False and r["reason"] == "not_host", "settings rejected for non-host")
        r = A.call("lobby_settings", {"track": "test-track", "cc": 150, "laps": 2, "bots": True})
        check(r["ok"] and r["settings"] == {"track": "test-track", "cc": 150, "laps": 2, "bots": True}, "host settings applied")
        r = A.call("lobby_start")
        check(r == {"ok": False, "reason": "not_ready"}, "start rejected while B not ready")
        r = B.call("lobby_start")
        check(r["ok"] is False and r["reason"] == "not_host", "start rejected for non-host")
        B.call("lobby_update", {"ready": True, "character": 6})
        lob = A.wait("lobby", lambda d: any(m["ready"] and m["character"] == 6 for m in d["members"]))
        check(True, "lobby_update ready/character broadcast")

        print("== race 1")
        A.flush(); B.flush(); C.flush()
        r = A.call("lobby_start")
        check(r["ok"] is True, "host starts race")
        rs = C.wait("race_start")
        grid = rs["grid"]
        bots = [k for k in grid if k["isBot"]]
        humans = [k for k in grid if not k["isBot"]]
        check(len(grid) == 8 and len(bots) == 6 and len(humans) == 2, "grid has 8 karts (2 humans + 6 bots)")
        check(all(b["owner"] == A.sid for b in bots) and [b["id"] for b in bots] == [f"bot{i}" for i in range(6)], "bots owned by host, ids bot0..")
        check(not ({b["character"] for b in bots} & {2, 6}) and len({b["character"] for b in bots}) == 6, "bots use untaken characters")
        check(rs["track"] == "test-track" and rs["cc"] == 150 and rs["laps"] == 2 and rs["hostId"] == A.sid
              and 4000 < rs["startAt"] - time.time() * 1000 <= 5100 and isinstance(rs["seed"], int)
              and rs["netHz"] == 20, "race_start payload (20 Hz snapshots)")
        r = C.call("lobby_join", {"name": "Carol", "character": 1})
        check(r == {"ok": False, "reason": "race_in_progress"}, "join rejected during race")
        check(led() == "count:3", "LED count:3 during countdown")
        A.sio.emit("enter_room", "race"); B.sio.emit("enter_room", "race")
        time.sleep(0.2)
        bot_prog = {f"bot{i}": 0.5 + i * 0.1 for i in range(6)}  # bot5 furthest
        def send_states(a_lap, a_prog):
            A.sio.emit("state", {"karts": [{"id": A.sid, "lap": a_lap, "prog": a_prog, "x": 1.0},
                                           {"id": B.sid, "lap": 9, "prog": 99, "forged": True}]
                                          + [{"id": k, "lap": 1, "prog": p} for k, p in bot_prog.items()]})
            B.sio.emit("state", {"karts": [{"id": B.sid, "lap": 1, "prog": 0.9, "x": 2.0}]})
        send_states(1, 0.4)
        snap = B.wait("snapshot", lambda d: len(d["karts"]) == 8, timeout=3)
        by_id = {k["id"]: k for k in snap["karts"]}
        check(by_id[B.sid].get("forged") is None and by_id[B.sid]["x"] == 2.0, "snapshot ignores states from non-owners")
        check(by_id[A.sid]["x"] == 1.0 and isinstance(snap["t"], float), "snapshot relays owner states")
        check(C.count("snapshot") == 0, "snapshot only sent to room 'race'")

        A.sio.emit("event", {"type": "item_fire", "item": "banana", "x": 3})
        ev = B.wait("event", lambda d: d["type"] == "item_fire")
        check(ev["from"] == A.sid and ev["item"] == "banana" and "t" in ev, "event relay with from/t")
        time.sleep(1.05)
        B.flush()
        for i in range(100):
            A.sio.emit("event", {"type": "spam", "i": i})
        time.sleep(1.0)
        n = sum(1 for e, d in B.events if e == "event" and d["type"] == "spam")
        check(40 <= n <= 60, f"event rate limit ({n}/100 relayed)")

        wait_led(lambda s: s == "count:0", timeout=6)
        check(True, "LED count:0 (GO) right after start")
        send_states(2, 1.5)
        wait_led("race:2:2:2", timeout=3)
        check(True, "LED race:<leaderLap>:<laps>:<humans> = race:2:2:2")

        A.flush(); B.flush(); C.flush()
        r = B.call("finish", {"id": A.sid, "time": 1000, "bestLap": 500})
        check(r == {"ok": False}, "finish rejected for non-owner")
        A.call("finish", {"id": "bot0", "time": 59000, "bestLap": 28500})
        A.call("finish", {"id": A.sid, "time": 60000, "bestLap": 29000})
        time.sleep(0.3)
        check(C.count("race_results") == 0, "no results until all humans finished")
        B.call("finish", {"id": B.sid, "time": 61000, "bestLap": 28000})
        res = C.wait("race_results")["results"]
        order = [x["id"] for x in res]
        check(order[:3] == ["bot0", A.sid, B.sid], "finished karts placed by time")
        check(order[3:] == ["bot5", "bot4", "bot3", "bot2", "bot1"], "unfinished karts placed by prog")
        check([x["place"] for x in res] == list(range(1, 9)) and res[3]["time"] is None, "places 1..8, unfinished time null")
        lob = C.wait("lobby", lambda d: d["racing"] is False)
        check(not any(m["ready"] for m in lob["members"]) and len(lob["members"]) == 2, "lobby kept, ready reset")
        recs = C.wait("records")
        laps = recs["tracks"]["test-track"]["laps"]
        check([e["time"] for e in laps] == [28000, 29000] and laps[0]["name"] == "Bob", "race best laps auto-submitted")
        check(led() == "finish:1", "LED finish:1 after results")

        print("== records")
        r = C.call("record", {"track": "test-track", "name": "<b>Carol</b> the very long name", "character": 1,
                              "lapTime": 25000, "raceTime": 80000, "mode": "tt"})
        check(r == {"ok": True, "rankLap": 1, "rankRace": 1}, "record submission ranks")
        r = C.call("record", {"track": "test-track", "name": "x", "lapTime": -5})
        check(r["ok"] is False, "negative time rejected")
        r = C.call("record", {"track": "test-track", "name": "x", "lapTime": 31 * 60 * 1000})
        check(r["ok"] is False, "absurd time rejected")
        for i in range(12):
            C.call("record", {"track": "t2", "name": f"p{i}", "raceTime": 90000 - i * 1000})
        g = C.call("get_records")
        name = g["tracks"]["test-track"]["laps"][0]["name"]
        check(len(name) <= 16 and "<" not in name, f"name sanitized ({name!r})")
        t2 = g["tracks"]["t2"]["races"]
        check(len(t2) == 10 and t2[0]["time"] == 79000 and t2 == sorted(t2, key=lambda e: e["time"]), "top-10 kept and sorted")
        time.sleep(1.5)
        path = os.path.join(data_dir, "records.json")
        with open(path) as f:
            saved = json.load(f)
        check(saved["tracks"]["test-track"]["laps"][0]["time"] == 25000 and len(saved["tracks"]["t2"]["races"]) == 10,
              "records persisted to records.json")

        print("== race 2: host leaves")
        B.call("lobby_update", {"ready": True})
        A.flush(); B.flush(); C.flush()
        check(A.call("lobby_start")["ok"], "second race starts")
        C.wait("race_start")
        B.sio.emit("enter_room", "race"); A.sio.emit("enter_room", "race")
        time.sleep(0.2)
        old_a = A.sid
        A.close()
        pl = B.wait("player_left")
        check(pl == {"id": old_a, "newHostId": B.sid, "botsOwner": B.sid}, "player_left with new host/bots owner")
        lob = C.wait("lobby", lambda d: d["hostId"] == B.sid)
        check(len(lob["members"]) == 1 and lob["members"][0]["isHost"], "host reassigned to B in lobby")
        B.sio.emit("state", {"karts": [{"id": "bot3", "lap": 1, "prog": 0.2, "mine": True}]})
        snap = B.wait("snapshot", lambda d: any(k["id"] == "bot3" for k in d["karts"]), timeout=3)
        check(True, "new host now owns bot states")
        B.close()
        res = C.wait("race_results", timeout=5)
        check(len(res["results"]) == 8, "race finalized when all humans disconnected")
        lob = C.wait("lobby", lambda d: d["racing"] is False)
        check(lob["members"] == [] and lob["hostId"] is None, "lobby empty after everyone left")
        st = http_json("/api/status")
        check(st["players"] == 1 and st["racing"] is False, "status after disconnects")
        C.close()
    finally:
        for c in clients:
            c.close()
        stop_server(proc)

    print("== persistence across restart")
    proc, logs2 = start_server(env)
    try:
        D = Client("D").connect()
        h = D.call("hello", {"name": "Dan"})
        check(h["records"]["tracks"]["test-track"]["laps"][0]["time"] == 25000, "records reloaded after restart")
        D.close()
        big_lobby_tests()
    finally:
        stop_server(proc)
    logs3 = motion_tests(env, tmp) + brick_tests(env, tmp)
    errors = [l for l in logs + logs2 + logs3 if "Traceback" in l or "ERROR" in l]
    check(not errors, "no server errors in logs" + ("" if not errors else ": " + "".join(errors)))
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nALL {len(PASSED)} CHECKS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\nFAILED: {e}")
        sys.exit(1)
