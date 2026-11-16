# Ardu Fishing server for the Arduino UNO Q.
#
# Serves the browser game (assets/) through the WebUI brick, keeps the local
# leaderboard and pushes a compact status string to the sketch so the LED
# matrix can show what is happening.
#
# Tournament between boards: every UNO Q runs this same app, one of them is
# the host. Players' browsers keep their own board for the Modulino rod and
# open a second Socket.IO connection to the host board, which runs the
# tournament lobby, starts the 3 minute match at the same moment for everyone
# (server clock, synced by the browsers) and streams the live scoreboard.
#
# controller.py adds the Modulino motion controller (aim with the gyroscope,
# cast / reel / unhook gestures from Edge Impulse, buttons, Pixels) and the
# Motion Lab training page (assets/train.html).

from arduino.app_utils import *
from arduino.app_bricks.web_ui import WebUI

import json
import math
import os
import random
import re
import socket
import threading
import time

import controller

VERSION = "1.0.0"

TICK_HZ = 20
MATCH_MS = int(os.environ.get("ARDUFISH_MATCH_MS", 3 * 60 * 1000))  # override for local tests only
COUNTDOWN_MS = 6000
END_GRACE_MS = 2500               # late score updates still count
MAX_PLAYERS = 20
SCORE_RATE_HZ = 4                 # scoreboard broadcasts per second (when something changed)
FEED_LEN = 12                     # catches kept for the live ticker
RESULTS_LED_MS = 8000
SOLO_STALE_MS = 4000
EVENT_RATE_LIMIT = 20             # score / catch messages per second per client
MAX_FISH = 500
MAX_WEIGHT_KG = 5000.0
MAX_FISH_KG = 200.0
RECORDS_PER_LIST = 10
SAVE_DEBOUNCE_S = 1.0
LED_PUSH_S = 1.0                  # resend the LED state at least this often (MCU times out at 3.5 s)
PHASES = ("aim", "wait", "bite", "fight", "unhook", "caught")
RARITIES = ("common", "uncommon", "rare", "epic", "legendary")


def now_ms():
    return time.time() * 1000.0


def as_dict(data):
    return data if isinstance(data, dict) else {}


def clean_name(value, fallback="Angler"):
    if not isinstance(value, str):
        return fallback
    # keep printable characters only, collapse whitespace, strip markup-ish chars
    value = "".join(ch for ch in value if ch.isprintable() and ch not in "<>&\"'`\\")
    value = re.sub(r"\s+", " ", value).strip()[:16]
    return value or fallback


def clean_word(value, maxlen=24, extra=""):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^A-Za-z0-9 _\-" + re.escape(extra) + "]", "", value)[:maxlen].strip()


def as_number(value, default=0.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return float(value)


def as_int(value, lo, hi, default=0):
    v = as_number(value, None)
    if v is None:
        return default
    return max(lo, min(hi, int(v)))


def clean_catch(data):
    """A single fish: {"species", "kg", "rarity"} or None."""
    data = as_dict(data)
    species = clean_word(data.get("species"))
    kg = as_number(data.get("kg"), -1)
    if not species or not 0 < kg <= MAX_FISH_KG:
        return None
    rarity = data.get("rarity") if data.get("rarity") in RARITIES else "common"
    return {"species": species, "kg": round(kg, 2), "rarity": rarity}


def lan_ip():
    """Best guess of this board's address on the LAN (shown so others can join)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return "127.0.0.1"


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------

def resolve_data_dir():
    env = os.environ.get("ARDUFISH_DATA_DIR")
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
    """Local leaderboard: best 3 minute matches and the biggest fish ever landed."""

    def __init__(self, path):
        self.path = path
        self.matches = []     # {"name","fish","kg","date","mode"}
        self.fish = []        # {"name","species","kg","rarity","date"}
        self.dirty_since = None
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            data = as_dict(data)
            self.matches = [e for e in data.get("matches", []) if isinstance(e, dict)
                            and isinstance(e.get("fish"), int)][:RECORDS_PER_LIST]
            self.fish = [e for e in data.get("fish", []) if isinstance(e, dict)
                         and as_number(e.get("kg"), 0) > 0][:RECORDS_PER_LIST]
        except FileNotFoundError:
            pass
        except Exception as e:  # corrupted file: start fresh but keep a copy
            print(f"[Ardu Fishing] could not read records ({e}), starting empty")
            try:
                os.replace(self.path, self.path + ".bad")
            except OSError:
                pass

    def snapshot(self):
        return {"matches": [dict(e) for e in self.matches], "fish": [dict(e) for e in self.fish]}

    def _insert(self, lst, entry, key):
        lst.append(entry)
        lst.sort(key=key)
        del lst[RECORDS_PER_LIST:]
        if entry in lst:
            self.dirty_since = self.dirty_since or time.time()
            return lst.index(entry) + 1
        return None

    def submit_match(self, name, fish, kg, mode):
        entry = {"name": name, "fish": fish, "kg": round(kg, 2), "date": int(time.time() * 1000), "mode": mode}
        return self._insert(self.matches, entry, lambda e: (-e["fish"], -e["kg"], e["date"]))

    def submit_fish(self, name, catch):
        entry = dict(catch, name=name, date=int(time.time() * 1000))
        return self._insert(self.fish, entry, lambda e: (-e["kg"], e["date"]))

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
            print(f"[Ardu Fishing] failed to save records: {e}")
            self.dirty_since = time.time()


# --------------------------------------------------------------------------
# Server state (all access guarded by `lock`)
# --------------------------------------------------------------------------

lock = threading.RLock()
started_at = time.time()
records = RecordStore(os.path.join(resolve_data_dir(), "records.json"))

clients = {}        # sid -> {"name": str, "since": ms}
solo = {}           # sid -> (status dict, ms timestamp): this board's own player, for the LED matrix
members = []        # tournament lobby (this board as host): {"id","name","board","ready"}
match = None        # running tournament match or None
last_results = None
last_results_at = 0.0
event_times = {}    # sid -> [window_start_ms, count]
scores_dirty = False
last_scores_at = 0.0

_ui_kwargs = {}
if os.environ.get("ARDUFISH_ASSETS"):
    _ui_kwargs["assets_dir_path"] = os.environ["ARDUFISH_ASSETS"]
if os.environ.get("ARDUFISH_PORT"):
    _ui_kwargs["port"] = int(os.environ["ARDUFISH_PORT"])
ui = WebUI(**_ui_kwargs)
motion = controller.MotionHub(ui, Bridge, resolve_data_dir())
BOARD_IP = lan_ip()


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
        "members": [{"id": m["id"], "name": m["name"], "board": m["board"], "ready": m["ready"],
                     "isHost": m["id"] == hid} for m in members],
        "hostId": hid,
        "playing": match is not None,
        "max": MAX_PLAYERS,
        "durationMs": MATCH_MS,
    }


def broadcast_lobby():
    ui.send_message("tourney_lobby", lobby_payload(), room="tourney")


def broadcast_records():
    ui.send_message("records", records.snapshot())


def rate_limited(sid, t):
    win = event_times.setdefault(sid, [t, 0])
    if t - win[0] >= 1000:
        win[0], win[1] = t, 0
    win[1] += 1
    return win[1] > EVENT_RATE_LIMIT


# --------------------------------------------------------------------------
# Tournament match
# --------------------------------------------------------------------------

def match_public(m):
    return {k: m[k] for k in ("matchId", "seed", "startAt", "durationMs", "players")}


def ranking_locked():
    """Scoreboard rows sorted by fish, then total weight. Must hold lock."""
    rows = []
    for p in match["players"]:
        s = match["scores"].get(p["id"], {})
        rows.append({"id": p["id"], "name": p["name"], "board": p["board"],
                     "fish": s.get("fish", 0), "kg": s.get("kg", 0.0), "biggest": s.get("biggest"),
                     "phase": s.get("phase", "aim"), "left": p["id"] in match["left"]})
    rows.sort(key=lambda r: (-r["fish"], -r["kg"], r["name"]))
    for i, r in enumerate(rows):
        r["place"] = i + 1
    return rows


def scores_payload_locked():
    return {"matchId": match["matchId"], "t": now_ms(), "rows": ranking_locked(), "feed": list(match["feed"])}


def finalize_locked():
    """Compute results, reset the match. Must hold lock. Returns (payload, new_record)."""
    global match, last_results, last_results_at
    rows = ranking_locked()
    new_record = False
    for r in rows:
        if r["fish"] > 0 or r["kg"] > 0:
            if records.submit_match(r["name"], r["fish"], r["kg"], "tourney"):
                new_record = True
    for c in match["catches"]:
        if records.submit_fish(c["name"], c["catch"]):
            new_record = True
    payload = {"matchId": match["matchId"], "rows": rows}
    match = None
    last_results, last_results_at = payload, now_ms()
    for m in members:
        m["ready"] = False
    return payload, new_record


def finalize_and_broadcast():
    with lock:
        if match is None:
            return
        payload, new_record = finalize_locked()
    ui.send_message("tourney_results", payload, room="tourney")
    broadcast_lobby()
    if new_record:
        broadcast_records()


def match_should_end_locked(t):
    if not (set(p["id"] for p in match["players"]) - match["left"]):
        return True
    return t >= match["startAt"] + match["durationMs"] + END_GRACE_MS


def remove_member(sid, disconnected):
    global scores_dirty
    end = False
    with lock:
        was_member = find_member(sid) is not None
        members[:] = [m for m in members if m["id"] != sid]
        if disconnected:
            clients.pop(sid, None)
            solo.pop(sid, None)
            event_times.pop(sid, None)
        if match is not None and any(p["id"] == sid for p in match["players"]):
            match["left"].add(sid)
            scores_dirty = True
            end = match_should_end_locked(now_ms())
    if end:
        finalize_and_broadcast()
    elif was_member:
        broadcast_lobby()


# --------------------------------------------------------------------------
# Socket.IO handlers
# --------------------------------------------------------------------------

def on_connect(sid):
    with lock:
        clients[sid] = {"name": "Angler", "since": now_ms()}


def on_disconnect(sid):
    motion.forget(sid)
    remove_member(sid, disconnected=True)


def on_hello(sid, data):
    data = as_dict(data)
    with lock:
        clients.setdefault(sid, {"since": now_ms()})["name"] = clean_name(data.get("name"))
        resp = {"id": sid, "serverTime": now_ms(), "records": records.snapshot(), "version": VERSION,
                "board": BOARD_IP, "lobby": lobby_payload()}
        if match is not None:
            resp["match"] = match_public(match)
    return resp


def on_clock(sid, data):
    data = as_dict(data)
    return {"t": data.get("t"), "serverTime": now_ms()}


def on_solo_status(sid, data):
    # this board's player (solo or in a tournament hosted anywhere): drives the LED matrix
    data = as_dict(data)
    state = data.get("state")
    if state not in ("menu", "countdown", "fishing", "finished"):
        return None
    status = {"state": state,
              "count": as_int(data.get("count"), 0, 9),
              "secs": as_int(data.get("secs"), 0, MATCH_MS // 1000, MATCH_MS // 1000),
              "fish": as_int(data.get("fish"), 0, 99),
              "phase": PHASES.index(data["phase"]) if data.get("phase") in PHASES else 0,
              "place": as_int(data.get("place"), 0, MAX_PLAYERS)}
    with lock:
        solo[sid] = (status, now_ms())
    return None


def on_tourney_join(sid, data):
    data = as_dict(data)
    with lock:
        if match is not None:
            return {"ok": False, "reason": "match_in_progress"}
        m = find_member(sid)
        name = clean_name(data.get("name"), clients.get(sid, {}).get("name", "Angler"))
        board = clean_word(data.get("board"), 40, ".:") or "?"
        if m is None:
            if len(members) >= MAX_PLAYERS:
                return {"ok": False, "reason": "lobby_full"}
            members.append({"id": sid, "name": name, "board": board, "ready": False})
        else:
            m["name"], m["board"] = name, board
        if sid in clients:
            clients[sid]["name"] = name
    broadcast_lobby()
    return {"ok": True, "lobby": lobby_payload()}


def on_tourney_leave(sid, data):
    remove_member(sid, disconnected=False)
    return {"ok": True}


def on_tourney_ready(sid, data):
    data = as_dict(data)
    with lock:
        m = find_member(sid)
        if m is None:
            return {"ok": False, "reason": "not_in_lobby"}
        if match is not None:
            return {"ok": False, "reason": "match_in_progress"}
        m["ready"] = bool(data.get("ready"))
    broadcast_lobby()
    return {"ok": True}


def on_tourney_start(sid, data):
    global match, scores_dirty
    with lock:
        if match is not None:
            return {"ok": False, "reason": "match_in_progress"}
        if not members or sid != host_id():
            return {"ok": False, "reason": "not_host"}
        if any(not m["ready"] for m in members[1:]):
            return {"ok": False, "reason": "not_ready"}
        seed = random.randint(1, 2**31 - 1)
        match = {
            "matchId": f"m{int(time.time())}-{seed % 10000}",
            "seed": seed,                         # same fish spawn pattern on every board
            "startAt": now_ms() + COUNTDOWN_MS,
            "durationMs": MATCH_MS,
            "players": [{"id": m["id"], "name": m["name"], "board": m["board"]} for m in members],
            "scores": {},
            "left": set(),
            "feed": [],
            "catches": [],
        }
        scores_dirty = True
        payload = match_public(match)
    ui.send_message("tourney_start", payload, room="tourney")
    broadcast_lobby()
    return {"ok": True, "matchId": payload["matchId"]}


def _player_in_match(sid):
    return match is not None and any(p["id"] == sid for p in match["players"]) and sid not in match["left"]


def on_tourney_score(sid, data):
    # live progress of one player: fish count, total weight, phase
    global scores_dirty
    data = as_dict(data)
    t = now_ms()
    with lock:
        if not _player_in_match(sid) or rate_limited(sid, t):
            return None
        if t < match["startAt"] or t > match["startAt"] + match["durationMs"] + END_GRACE_MS:
            return None
        s = match["scores"].setdefault(sid, {"fish": 0, "kg": 0.0, "biggest": None, "phase": "aim"})
        # counts only go up (a reconnecting browser cannot wipe its score)
        s["fish"] = max(s["fish"], as_int(data.get("fish"), 0, MAX_FISH))
        s["kg"] = max(s["kg"], round(max(0.0, min(MAX_WEIGHT_KG, as_number(data.get("kg")))), 2))
        if data.get("phase") in PHASES:
            s["phase"] = data["phase"]
        scores_dirty = True
    return None


def on_tourney_catch(sid, data):
    # one fish landed: goes to the live ticker and the biggest-fish records
    global scores_dirty
    t = now_ms()
    catch = clean_catch(data)
    with lock:
        if catch is None or not _player_in_match(sid) or rate_limited(sid, t):
            return None
        name = next(p["name"] for p in match["players"] if p["id"] == sid)
        s = match["scores"].setdefault(sid, {"fish": 0, "kg": 0.0, "biggest": None, "phase": "aim"})
        if s["biggest"] is None or catch["kg"] > s["biggest"]["kg"]:
            s["biggest"] = catch
        match["feed"].insert(0, dict(catch, name=name, t=t))
        del match["feed"][FEED_LEN:]
        if len(match["catches"]) < MAX_FISH * 4:
            match["catches"].append({"name": name, "catch": catch})
        scores_dirty = True
    return None


def on_tourney_state(sid, data):
    with lock:
        resp = {"lobby": lobby_payload(), "serverTime": now_ms()}
        if match is not None:
            resp["match"] = match_public(match)
            resp["scores"] = scores_payload_locked()
        elif last_results is not None:
            resp["results"] = last_results
    return resp


def on_record(sid, data):
    # end of a solo match on this board: best matches + every fish for the biggest-fish list
    data = as_dict(data)
    name = clean_name(data.get("name"))
    fish = as_int(data.get("fish"), 0, MAX_FISH)
    kg = max(0.0, min(MAX_WEIGHT_KG, as_number(data.get("kg"))))
    catches = data.get("catches") if isinstance(data.get("catches"), list) else []
    with lock:
        rank_match = records.submit_match(name, fish, kg, "solo") if fish > 0 else None
        rank_fish = None
        for c in catches[:MAX_FISH]:
            c = clean_catch(c)
            if c:
                r = records.submit_fish(name, c)
                if r and (rank_fish is None or r < rank_fish):
                    rank_fish = r
    if rank_match or rank_fish:
        broadcast_records()
    return {"ok": True, "rankMatch": rank_match, "rankFish": rank_fish}


def on_get_records(sid, data):
    with lock:
        return records.snapshot()


# --------------------------------------------------------------------------
# LED matrix state for the sketch
# --------------------------------------------------------------------------

def get_led_state():
    t = now_ms()
    with lock:
        newest = None
        for status, ts in solo.values():
            if t - ts < SOLO_STALE_MS and status["state"] != "menu":
                if newest is None or ts > newest[1]:
                    newest = (status, ts)
        if newest:
            s = newest[0]
            if s["state"] == "countdown":
                return f"count:{max(0, min(3, s['count']))}"
            if s["state"] == "fishing":
                return f"fish:{s['secs']}:{s['fish']}:{s['phase']}"
            return f"finish:{s['fish']}:{s['place']}"
        if match is not None:
            dt = match["startAt"] - t
            if dt > 0:
                return f"count:{max(0, min(3, math.ceil(dt / 1000.0)))}"
            secs = max(0, math.ceil((match["startAt"] + match["durationMs"] - t) / 1000.0))
            best = max((s.get("fish", 0) for s in match["scores"].values()), default=0)
            return f"fish:{secs}:{best}:0"
        if last_results_at and t - last_results_at < RESULTS_LED_MS and last_results["rows"]:
            return f"finish:{last_results['rows'][0]['fish']}:1"
        if members:
            return f"lobby:{len(members)}"
    return "idle"


# --------------------------------------------------------------------------
# REST
# --------------------------------------------------------------------------

def api_status():
    with lock:
        return {"players": len(clients), "board": BOARD_IP, "lobby": lobby_payload(),
                "playing": match is not None, "uptime": round(time.time() - started_at, 1), "version": VERSION}


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
ui.on_message("tourney_join", on_tourney_join)
ui.on_message("tourney_leave", on_tourney_leave)
ui.on_message("tourney_ready", on_tourney_ready)
ui.on_message("tourney_start", on_tourney_start)
ui.on_message("tourney_score", on_tourney_score)
ui.on_message("tourney_catch", on_tourney_catch)
ui.on_message("tourney_state", on_tourney_state)
ui.on_message("record", on_record)
ui.on_message("get_records", on_get_records)
ui.expose_api("GET", "/api/status", api_status)
if os.environ.get("ARDUFISH_DEBUG") == "1":
    ui.expose_api("GET", "/api/debug/led", api_debug_led)
    ui.expose_api("GET", "/api/debug/mcu", api_debug_mcu)

    def api_debug_sim(tilt: float = None, gesture: str = None, button: int = None, auto: bool = False, hold: float = None):
        sim = getattr(Bridge, "sim", None)
        if sim is None:
            return {"ok": False, "error": "start with ARDUKART_SIM_BOARD=1"}
        return {"ok": True, **sim.command(tilt=tilt, gesture=gesture, button=button, auto=auto, hold=hold)}
    ui.expose_api("GET", "/api/debug/sim", api_debug_sim)
motion.register()


_next_tick = time.monotonic()
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
    """20 Hz server tick: scoreboard, match end, debounced record saving."""
    global _next_tick, scores_dirty, last_scores_at
    scores = None
    end = False
    with lock:
        if match is not None:
            t = now_ms()
            if scores_dirty and t - last_scores_at >= 1000.0 / SCORE_RATE_HZ:
                scores = scores_payload_locked()
                scores_dirty = False
                last_scores_at = t
            end = match_should_end_locked(t)
        records.save_if_due()
    if scores:
        ui.send_message("tourney_scores", scores, room="tourney")
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
