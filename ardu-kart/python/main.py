# Ardu Kart race server for the Arduino UNO Q.
#
# Serves the browser game (assets/) through the WebUI brick, runs the
# authoritative multiplayer lobby, relays kart states/events between racers,
# keeps the lap/race records and pushes a compact status string to the
# sketch so the LED matrix can show what is happening.
#
# controller.py adds the Modulino motion controller (steering, gestures from
# the on-device Edge Impulse model, buttons, shift lights) and the Motion Lab
# training page (assets/train.html).

from arduino.app_utils import *
from arduino.app_bricks.web_ui import WebUI

import json
import math
import os
import random
import re
import threading
import time

import controller

VERSION = "1.1.0"

TICK_HZ = 20
MAX_HUMANS = 20          # players in one LAN race
MAX_GRID = 20            # karts on the grid (humans + CPU rivals)
BOT_FILL = 8             # CPU rivals fill the grid up to this many karts
BIG_FIELD = 10           # above this many humans, snapshots go out at half rate
COUNTDOWN_MS = 5000
FINISH_GRACE_MS = 25000           # after the first human finishes
MAX_RACE_MS = 20 * 60 * 1000      # safety net: a race never lasts longer than this
RESULTS_LED_MS = 6000
SOLO_STALE_MS = 4000
EVENT_RATE_LIMIT = 60             # events per second per client
MAX_TIME_MS = 30 * 60 * 1000      # sane upper bound for lap/race times
RECORDS_PER_LIST = 10
MAX_TRACKS = 64
SAVE_DEBOUNCE_S = 1.0
LED_PUSH_S = 1.0                  # resend the LED state at least this often (MCU times out at 3.5 s)

CC_CLASSES = (50, 100, 150)
DEFAULT_SETTINGS = {"track": "sunset", "cc": 100, "laps": 3, "bots": True}

BOT_NAMES = [
    "Turbo Tofu", "Nitro Noodle", "Captain Drift", "Pixel Pete", "Volt Viper",
    "Sprocket", "Biscuit Blitz", "Zippy Zara", "Gizmo Gus", "Rocket Rosa",
    "Diode Dash", "Mochi Max", "Sparky Sue", "Bolt Bandit", "Comet Cleo",
    "Wobble Wes",
]


def now_ms():
    return time.time() * 1000.0


def as_dict(data):
    return data if isinstance(data, dict) else {}


def clean_name(value, fallback="Racer"):
    if not isinstance(value, str):
        return fallback
    # keep printable characters only, collapse whitespace, strip markup-ish chars
    value = "".join(ch for ch in value if ch.isprintable() and ch not in "<>&\"'`\\")
    value = re.sub(r"\s+", " ", value).strip()[:16]
    return value or fallback


def clean_track(value):
    if not isinstance(value, str):
        return None
    value = re.sub(r"[^A-Za-z0-9_\-]", "", value)[:32]
    return value or None


def clean_character(value, default=0):
    try:
        c = int(value)
    except (TypeError, ValueError):
        return default
    return c if 0 <= c <= 7 else default


def valid_time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value <= 0 or value >= MAX_TIME_MS:
        return None
    return float(value)


def as_number(value, default=0.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return float(value)


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------

def resolve_data_dir():
    env = os.environ.get("ARDUKART_DATA_DIR")
    candidates = [env] if env else []
    candidates.append("/app/data")
    candidates.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
    for d in candidates:
        try:
            os.makedirs(d, exist_ok=True)
            if os.access(d, os.W_OK):
                return d
        except OSError:
            continue
    return os.getcwd()


class RecordStore:
    def __init__(self, path):
        self.path = path
        self.tracks = {}
        self.dirty_since = None
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            tracks = data.get("tracks", {}) if isinstance(data, dict) else {}
            for track, cats in tracks.items():
                if not isinstance(cats, dict):
                    continue
                self.tracks[track] = {
                    "laps": [e for e in cats.get("laps", []) if isinstance(e, dict) and valid_time(e.get("time"))][:RECORDS_PER_LIST],
                    "races": [e for e in cats.get("races", []) if isinstance(e, dict) and valid_time(e.get("time"))][:RECORDS_PER_LIST],
                }
        except FileNotFoundError:
            pass
        except Exception as e:  # corrupted file: start fresh but keep a copy
            print(f"[Ardu Kart] could not read records ({e}), starting empty")
            try:
                os.replace(self.path, self.path + ".bad")
            except OSError:
                pass

    def snapshot(self):
        return {"tracks": {t: {"laps": [dict(e) for e in c["laps"]], "races": [dict(e) for e in c["races"]]}
                           for t, c in self.tracks.items()}}

    def submit(self, track, category, name, character, time_ms, mode):
        """Insert an entry; returns 1-based rank or None if it did not make the top list."""
        if track not in self.tracks:
            if len(self.tracks) >= MAX_TRACKS:
                return None
            self.tracks[track] = {"laps": [], "races": []}
        lst = self.tracks[track][category]
        entry = {"name": name, "character": character, "time": round(time_ms, 1),
                 "date": int(time.time() * 1000), "mode": mode}
        lst.append(entry)
        lst.sort(key=lambda e: e["time"])
        del lst[RECORDS_PER_LIST:]
        if entry in lst:
            self.dirty_since = self.dirty_since or time.time()
            return lst.index(entry) + 1
        return None

    def save_if_due(self, force=False):
        if self.dirty_since is None:
            return
        if not force and time.time() - self.dirty_since < SAVE_DEBOUNCE_S:
            return
        data = self.snapshot()
        self.dirty_since = None
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except OSError as e:
            print(f"[Ardu Kart] failed to save records: {e}")
            self.dirty_since = time.time()


# --------------------------------------------------------------------------
# Server state (all access guarded by `lock`)
# --------------------------------------------------------------------------

lock = threading.RLock()
started_at = time.time()
records = RecordStore(os.path.join(resolve_data_dir(), "records.json"))

clients = {}        # sid -> {"name": str, "since": ms}
solo = {}           # sid -> (status dict, ms timestamp)
members = []        # ordered lobby members: {"id","name","character","ready"}
settings = dict(DEFAULT_SETTINGS)
race = None         # active race dict or None
last_results_at = 0.0
event_times = {}    # sid -> [window_start_ms, count]

_ui_kwargs = {}
if os.environ.get("ARDUKART_ASSETS"):
    _ui_kwargs["assets_dir_path"] = os.environ["ARDUKART_ASSETS"]
if os.environ.get("ARDUKART_PORT"):
    _ui_kwargs["port"] = int(os.environ["ARDUKART_PORT"])
ui = WebUI(**_ui_kwargs)
motion = controller.MotionHub(ui, Bridge, resolve_data_dir())


def host_id():
    return members[0]["id"] if members else None


def find_member(sid):
    for m in members:
        if m["id"] == sid:
            return m
    return None


def lobby_payload():
    hid = host_id()
    return {
        "members": [{"id": m["id"], "name": m["name"], "character": m["character"],
                     "ready": m["ready"], "isHost": m["id"] == hid} for m in members],
        "settings": dict(settings),
        "hostId": hid,
        "racing": race is not None,
        "max": MAX_HUMANS,
    }


def broadcast_lobby():
    ui.send_message("lobby", lobby_payload())


def broadcast_records():
    ui.send_message("records", records.snapshot())


# --------------------------------------------------------------------------
# Race lifecycle
# --------------------------------------------------------------------------

def build_race():
    seed = random.randint(1, 2**31 - 1)
    rng = random.Random(seed)
    humans = list(members)
    rng.shuffle(humans)
    hid = host_id()
    grid = [{"id": m["id"], "name": m["name"], "character": m["character"],
             "isBot": False, "owner": m["id"]} for m in humans]
    if settings["bots"]:
        taken = {m["character"] for m in humans}
        chars = [c for c in range(8) if c not in taken] + [c for c in range(8) if c in taken]
        names = list(BOT_NAMES)
        rng.shuffle(names)
        for i in range(BOT_FILL - len(grid)):
            grid.append({"id": f"bot{i}", "name": names[i % len(names)],
                         "character": chars[i % len(chars)], "isBot": True, "owner": hid})
    start_at = now_ms() + COUNTDOWN_MS
    return {
        "raceId": f"r{int(time.time())}-{seed % 10000}",
        "seed": seed,
        "track": settings["track"],
        "cc": settings["cc"],
        "laps": settings["laps"],
        "startAt": start_at,
        "grid": grid,
        "hostId": hid,
        # 20 karts x 20 players at 20 Hz is ~1 MB/s of snapshots; halve it for big fields
        "netHz": TICK_HZ if len(humans) <= BIG_FIELD else TICK_HZ // 2,
        "kart": {k["id"]: k for k in grid},
        "humans": {k["id"] for k in grid if not k["isBot"]},
        "left": set(),
        "states": {},
        "finished": {},          # kart id -> {"time","bestLap","order"}
        "firstHumanFinish": None,
        "created": now_ms(),
    }


def race_public(r):
    return {k: r[k] for k in ("raceId", "seed", "track", "cc", "laps", "startAt", "grid", "hostId", "netHz")}


def finalize_race_locked():
    """Compute results, reset race. Must hold lock. Returns payload to broadcast."""
    global race, last_results_at
    r = race
    finished = sorted(r["finished"].items(), key=lambda kv: (kv[1]["time"], kv[1]["order"]))
    unfinished = [k for k in r["grid"] if k["id"] not in r["finished"]]
    unfinished.sort(key=lambda k: -as_number(r["states"].get(k["id"], {}).get("prog"), -1e9))
    results = []
    place = 1
    for kid, f in finished:
        k = r["kart"][kid]
        results.append({"id": kid, "name": k["name"], "character": k["character"], "isBot": k["isBot"],
                        "time": f["time"], "bestLap": f["bestLap"], "place": place})
        place += 1
    for k in unfinished:
        results.append({"id": k["id"], "name": k["name"], "character": k["character"], "isBot": k["isBot"],
                        "time": None, "bestLap": None, "place": place})
        place += 1
    new_record = False
    for res in results:
        if not res["isBot"] and res["bestLap"] is not None:
            if records.submit(r["track"], "laps", res["name"], res["character"], res["bestLap"], "race"):
                new_record = True
    race = None
    last_results_at = now_ms()
    for m in members:
        m["ready"] = False
    return {"raceId": r["raceId"], "results": results}, new_record


def finalize_and_broadcast():
    with lock:
        if race is None:
            return
        payload, new_record = finalize_race_locked()
    ui.send_message("race_results", payload)
    broadcast_lobby()
    if new_record:
        broadcast_records()


def race_should_end_locked(t):
    r = race
    active_humans = r["humans"] - r["left"]
    if not active_humans:
        return True
    if all(h in r["finished"] for h in active_humans):
        return True
    if r["firstHumanFinish"] is not None and t - r["firstHumanFinish"] >= FINISH_GRACE_MS:
        return True
    if t - r["startAt"] > MAX_RACE_MS:
        return True
    return False


def remove_player(sid, disconnected):
    """Remove sid from the lobby (and the running race). Broadcasts as needed."""
    left_payload = None
    end_race = False
    with lock:
        was_member = find_member(sid) is not None
        members[:] = [m for m in members if m["id"] != sid]
        if disconnected:
            clients.pop(sid, None)
            solo.pop(sid, None)
            event_times.pop(sid, None)
        if race is not None and sid in race["humans"] and sid not in race["left"]:
            race["left"].add(sid)
            new_host = host_id()
            if race["hostId"] == sid or race["hostId"] not in {m["id"] for m in members}:
                race["hostId"] = new_host
            for k in race["grid"]:
                if k["isBot"]:
                    k["owner"] = race["hostId"]
            left_payload = {"id": sid, "newHostId": race["hostId"], "botsOwner": race["hostId"]}
            end_race = race_should_end_locked(now_ms())
    if left_payload:
        ui.send_message("player_left", left_payload, room="race")
    if end_race:
        finalize_and_broadcast()
    elif was_member:
        broadcast_lobby()


# --------------------------------------------------------------------------
# Socket.IO handlers
# --------------------------------------------------------------------------

def on_connect(sid):
    with lock:
        clients[sid] = {"name": "Racer", "since": now_ms()}


def on_disconnect(sid):
    motion.forget(sid)
    remove_player(sid, disconnected=True)


def on_hello(sid, data):
    data = as_dict(data)
    with lock:
        clients.setdefault(sid, {"since": now_ms()})["name"] = clean_name(data.get("name"))
        resp = {"id": sid, "serverTime": now_ms(), "records": records.snapshot(),
                "lobby": lobby_payload(), "version": VERSION}
        if race is not None:
            resp["race"] = race_public(race)
    return resp


def on_clock(sid, data):
    data = as_dict(data)
    return {"t": data.get("t"), "serverTime": now_ms()}


def on_solo_status(sid, data):
    data = as_dict(data)
    state = data.get("state")
    if state not in ("menu", "countdown", "race", "finished"):
        return None
    status = {"state": state}
    for key in ("count", "lap", "laps", "pos", "total"):
        try:
            status[key] = int(data.get(key, 0))
        except (TypeError, ValueError):
            status[key] = 0
    with lock:
        solo[sid] = (status, now_ms())
    return None


def on_lobby_join(sid, data):
    data = as_dict(data)
    with lock:
        if race is not None:
            return {"ok": False, "reason": "race_in_progress"}
        m = find_member(sid)
        name = clean_name(data.get("name"), clients.get(sid, {}).get("name", "Racer"))
        character = clean_character(data.get("character"))
        if m is None:
            if len(members) >= MAX_HUMANS:
                return {"ok": False, "reason": "lobby_full"}
            members.append({"id": sid, "name": name, "character": character, "ready": False})
        else:
            m["name"], m["character"] = name, character
        if sid in clients:
            clients[sid]["name"] = name
    broadcast_lobby()
    return {"ok": True}


def on_lobby_leave(sid, data):
    remove_player(sid, disconnected=False)
    return {"ok": True}


def on_lobby_update(sid, data):
    data = as_dict(data)
    with lock:
        m = find_member(sid)
        if m is None:
            return {"ok": False, "reason": "not_in_lobby"}
        if race is not None:
            return {"ok": False, "reason": "race_in_progress"}
        if "character" in data:
            m["character"] = clean_character(data["character"], m["character"])
        if "name" in data:
            m["name"] = clean_name(data["name"], m["name"])
        if "ready" in data:
            m["ready"] = bool(data["ready"])
    broadcast_lobby()
    return {"ok": True}


def on_lobby_settings(sid, data):
    data = as_dict(data)
    with lock:
        if sid != host_id():
            return {"ok": False, "reason": "not_host"}
        if race is not None:
            return {"ok": False, "reason": "race_in_progress"}
        track = clean_track(data.get("track"))
        if track:
            settings["track"] = track
        try:
            cc = int(data.get("cc", settings["cc"]))
            if cc in CC_CLASSES:
                settings["cc"] = cc
        except (TypeError, ValueError):
            pass
        try:
            laps = int(data.get("laps", settings["laps"]))
            settings["laps"] = max(1, min(9, laps))
        except (TypeError, ValueError):
            pass
        if "bots" in data:
            settings["bots"] = bool(data["bots"])
    broadcast_lobby()
    return {"ok": True, "settings": dict(settings)}


def on_lobby_start(sid, data):
    global race
    with lock:
        if race is not None:
            return {"ok": False, "reason": "race_in_progress"}
        if not members or sid != host_id():
            return {"ok": False, "reason": "not_host"}
        if any(not m["ready"] for m in members[1:]):
            return {"ok": False, "reason": "not_ready"}
        race = build_race()
        payload = race_public(race)
    ui.send_message("race_start", payload)
    broadcast_lobby()
    return {"ok": True, "raceId": payload["raceId"]}


def on_state(sid, data):
    data = as_dict(data)
    karts = data.get("karts")
    if not isinstance(karts, list):
        return None
    with lock:
        if race is None:
            return None
        for k in karts[:MAX_GRID]:
            if not isinstance(k, dict):
                continue
            kid = k.get("id")
            info = race["kart"].get(kid) if isinstance(kid, str) else None
            if info is not None and info["owner"] == sid:
                race["states"][kid] = k
    return None


def on_event(sid, data):
    data = as_dict(data)
    if not isinstance(data.get("type"), str):
        return None
    t = now_ms()
    with lock:
        if race is None:
            return None
        win = event_times.setdefault(sid, [t, 0])
        if t - win[0] >= 1000:
            win[0], win[1] = t, 0
        win[1] += 1
        if win[1] > EVENT_RATE_LIMIT:
            return None
    payload = dict(data)
    payload["from"] = sid
    payload["t"] = t
    ui.send_message("event", payload, room="race")
    return None


def on_finish(sid, data):
    data = as_dict(data)
    kid = data.get("id")
    t = valid_time(data.get("time"))
    best = valid_time(data.get("bestLap"))
    end = False
    with lock:
        if race is None or not isinstance(kid, str):
            return {"ok": False}
        info = race["kart"].get(kid)
        if info is None or info["owner"] != sid or kid in race["finished"] or t is None:
            return {"ok": False}
        race["finished"][kid] = {"time": t, "bestLap": best, "order": len(race["finished"])}
        if not info["isBot"] and race["firstHumanFinish"] is None:
            race["firstHumanFinish"] = now_ms()
        end = race_should_end_locked(now_ms())
    if end:
        finalize_and_broadcast()
    return {"ok": True}


def on_record(sid, data):
    data = as_dict(data)
    track = clean_track(data.get("track"))
    if not track:
        return {"ok": False, "reason": "bad_track"}
    mode = data.get("mode") if data.get("mode") in ("tt", "race", "gp") else "tt"
    name = clean_name(data.get("name"))
    character = clean_character(data.get("character"))
    lap = valid_time(data.get("lapTime"))
    rtime = valid_time(data.get("raceTime"))
    if lap is None and rtime is None:
        return {"ok": False, "reason": "bad_time"}
    with lock:
        rank_lap = records.submit(track, "laps", name, character, lap, mode) if lap is not None else None
        rank_race = records.submit(track, "races", name, character, rtime, mode) if rtime is not None else None
    if rank_lap or rank_race:
        broadcast_records()
    return {"ok": True, "rankLap": rank_lap, "rankRace": rank_race}


def on_get_records(sid, data):
    with lock:
        return records.snapshot()


# --------------------------------------------------------------------------
# LED matrix state for the sketch
# --------------------------------------------------------------------------

def get_led_state():
    t = now_ms()
    with lock:
        r = race
        if r is not None:
            dt = r["startAt"] - t
            if dt > 0:
                return f"count:{max(0, min(3, math.ceil(dt / 1000.0)))}"
            if dt > -1000:
                return "count:0"
            best_prog, leader_lap = None, 1
            for st in r["states"].values():
                p = as_number(st.get("prog"), -1e9)
                if best_prog is None or p > best_prog:
                    best_prog = p
                    leader_lap = int(as_number(st.get("lap"), 1))
            leader_lap = max(1, min(r["laps"], leader_lap))
            humans = len(r["humans"] - r["left"])
            return f"race:{leader_lap}:{r['laps']}:{humans}"
        if last_results_at and t - last_results_at < RESULTS_LED_MS:
            return "finish:1"
        newest = None
        for status, ts in solo.values():
            if t - ts < SOLO_STALE_MS and status["state"] != "menu":
                if newest is None or ts > newest[1]:
                    newest = (status, ts)
        if newest:
            s = newest[0]
            if s["state"] == "countdown":
                return f"count:{max(0, min(3, s['count']))}"
            if s["state"] == "race":
                laps = max(1, s["laps"])
                return f"race:{max(1, min(laps, s['lap']))}:{laps}:{max(1, min(MAX_GRID, s['pos']))}"
            return f"finish:{max(1, min(MAX_GRID, s['pos']))}"
        if members:
            return f"lobby:{len(members)}"
    return "idle"


# --------------------------------------------------------------------------
# REST
# --------------------------------------------------------------------------

def api_status():
    with lock:
        return {"players": len(clients), "lobby": lobby_payload(), "racing": race is not None,
                "uptime": round(time.time() - started_at, 1), "version": VERSION}


def api_debug_led():
    return {"led": get_led_state()}


def api_debug_mcu():
    # stub Bridge only: last call of every Python -> MCU notification
    return {k: list(v) for k, v in getattr(Bridge, "sent", {}).items()}


# --------------------------------------------------------------------------
# Wiring
# --------------------------------------------------------------------------

ui.on_connect(on_connect)
ui.on_disconnect(on_disconnect)
ui.on_message("hello", on_hello)
ui.on_message("clock", on_clock)
ui.on_message("solo_status", on_solo_status)
ui.on_message("lobby_join", on_lobby_join)
ui.on_message("lobby_leave", on_lobby_leave)
ui.on_message("lobby_update", on_lobby_update)
ui.on_message("lobby_settings", on_lobby_settings)
ui.on_message("lobby_start", on_lobby_start)
ui.on_message("state", on_state)
ui.on_message("event", on_event)
ui.on_message("finish", on_finish)
ui.on_message("record", on_record)
ui.on_message("get_records", on_get_records)
ui.expose_api("GET", "/api/status", api_status)
if os.environ.get("ARDUKART_DEBUG") == "1":
    ui.expose_api("GET", "/api/debug/led", api_debug_led)
    ui.expose_api("GET", "/api/debug/mcu", api_debug_mcu)

    def api_debug_sim(tilt: float = None, gesture: str = None, button: int = None, auto: bool = False):
        sim = getattr(Bridge, "sim", None)
        if sim is None:
            return {"ok": False, "error": "start with ARDUKART_SIM_BOARD=1"}
        return {"ok": True, **sim.command(tilt=tilt, gesture=gesture, button=button, auto=auto)}
    ui.expose_api("GET", "/api/debug/sim", api_debug_sim)
motion.register()


_next_tick = time.monotonic()
_tick_n = 0
_led_sent = (None, 0.0)


def push_led_state():
    global _led_sent
    state = get_led_state()
    t = time.monotonic()
    if state == _led_sent[0] and t - _led_sent[1] < LED_PUSH_S:
        return
    _led_sent = (state, t)
    try:
        Bridge.notify("led_state", state)
    except Exception:
        pass  # router not up yet; retried next tick


def tick():
    """20 Hz server tick: snapshots, race timeouts, debounced record saving."""
    global _next_tick, _tick_n
    _tick_n += 1
    snapshot = None
    end = False
    with lock:
        if race is not None:
            t = now_ms()
            if race["states"] and _tick_n % (TICK_HZ // race["netHz"]) == 0:
                snapshot = {"t": t, "karts": list(race["states"].values())}
            end = race_should_end_locked(t) if t > race["startAt"] else not (race["humans"] - race["left"])
        records.save_if_due()
    if snapshot:
        ui.send_message("snapshot", snapshot, room="race")
    if end:
        finalize_and_broadcast()
    push_led_state()
    motion.tick()
    _next_tick += 1.0 / TICK_HZ
    delay = _next_tick - time.monotonic()
    if delay > 0:
        time.sleep(delay)
    else:
        _next_tick = time.monotonic()


try:
    App.run(user_loop=tick)
finally:
    with lock:
        records.save_if_due(force=True)
