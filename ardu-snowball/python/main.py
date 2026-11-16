# Ardu Snowball server for the Arduino UNO Q.
#
# Serves the browser game (assets/) through the WebUI brick, keeps the local
# records and pushes a compact status string to the sketch so the LED matrix
# can show ammo, the star, the countdown...
#
# The game itself (3D rendering, physics, bots) runs in the browser: the board
# only has 2 GB of RAM, so Python stays a thin relay.
#
# LAN match between boards: every UNO Q runs this same app and one of them is
# the host. Each player's browser keeps its own board for the Modulino
# controller and opens a second Socket.IO connection to the host board, which
# runs the lobby, starts the match at the same moment for everyone (server
# clock, synced by the browsers) and relays the game:
#   * every browser owns its own player and sends its state ~20 times a second
#   * the host browser (first lobby member) also simulates the bots and is the
#     authority for the two stars and the score ("game" block of its state)
#   * the server merges the states into one `snapshot` per tick and relays
#     gameplay events (throws, hits, star requests) to everyone
#   * if the host leaves, the next member takes over the bots and the stars
#
# controller.py adds the Modulino motion controller (aim with the gyroscope,
# scoop / pack / throw / run gestures from Edge Impulse, buttons, Pixels) and
# the Motion Lab training page (assets/train.html).

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
MATCH_MS = int(os.environ.get("ARDUSNOW_MATCH_MS") or 3 * 60 * 1000)   # env override for quick local tests
COUNTDOWN_MS = 6000
END_GRACE_MS = 1500
TEAM_MIN = 3                      # bots fill each team up to this many players
MAX_PLAYERS = 8                   # humans in a LAN match (4 v 4)
MAX_ENTS = 16
EVENT_RATE_LIMIT = 60             # gameplay events per second per client
STATE_MAX_BYTES = 6000            # one client's state message (sanity cap)
RESULTS_LED_MS = 8000
SOLO_STALE_MS = 4000
RECORDS_PER_LIST = 10
SAVE_DEBOUNCE_S = 1.0
LED_PUSH_S = 1.0                  # resend the LED state at least this often (MCU times out at 3.5 s)
BOT_NAMES = ["Frosty", "Yeti", "Blizzard", "Flurry", "Icicle", "Sleet", "Avalanche", "Powder",
             "Glacier", "Snowdrop", "Mitten", "Tundra"]


def now_ms():
    return time.time() * 1000.0


def as_dict(data):
    return data if isinstance(data, dict) else {}


def clean_name(value, fallback="Player"):
    if not isinstance(value, str):
        return fallback
    value = "".join(ch for ch in value if ch.isprintable() and ch not in "<>&\"'`\\")
    value = re.sub(r"\s+", " ", value).strip()[:16]
    return value or fallback


def clean_word(value, maxlen=24):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^A-Za-z0-9 _.:\-]", "", value)[:maxlen].strip()


def as_number(value, default=0.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return float(value)


def as_int(value, lo, hi, default=0):
    v = as_number(value, None)
    if v is None:
        return default
    return max(lo, min(hi, int(v)))


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
    env = os.environ.get("ARDUSNOW_DATA_DIR")
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


def match_points(caps, hits, result):
    return caps * 100 + hits * 10 + (50 if result == "win" else 20 if result == "draw" else 0)


class RecordStore:
    """Local records: best match performances and the longest hits."""

    def __init__(self, path):
        self.path = path
        self.matches = []     # {"name","caps","hits","result","points","mode","date"}
        self.snipes = []      # {"name","dist","date"}
        self.dirty_since = None
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = as_dict(json.load(f))
            self.matches = [e for e in data.get("matches", []) if isinstance(e, dict)
                            and isinstance(e.get("points"), int)][:RECORDS_PER_LIST]
            self.snipes = [e for e in data.get("snipes", []) if isinstance(e, dict)
                           and as_number(e.get("dist"), 0) > 0][:RECORDS_PER_LIST]
        except FileNotFoundError:
            pass
        except Exception as e:  # corrupted file: start fresh but keep a copy
            print(f"[Ardu Snowball] could not read records ({e}), starting empty")
            try:
                os.replace(self.path, self.path + ".bad")
            except OSError:
                pass

    def snapshot(self):
        return {"matches": [dict(e) for e in self.matches], "snipes": [dict(e) for e in self.snipes]}

    def _insert(self, lst, entry, key):
        lst.append(entry)
        lst.sort(key=key)
        del lst[RECORDS_PER_LIST:]
        if entry in lst:
            self.dirty_since = self.dirty_since or time.time()
            return lst.index(entry) + 1
        return None

    def submit_match(self, name, caps, hits, result, mode):
        entry = {"name": name, "caps": caps, "hits": hits, "result": result,
                 "points": match_points(caps, hits, result), "mode": mode, "date": int(time.time() * 1000)}
        return self._insert(self.matches, entry, lambda e: (-e["points"], -e["caps"], e["date"]))

    def submit_snipe(self, name, dist):
        entry = {"name": name, "dist": round(dist, 1), "date": int(time.time() * 1000)}
        return self._insert(self.snipes, entry, lambda e: (-e["dist"], e["date"]))

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
            print(f"[Ardu Snowball] failed to save records: {e}")
            self.dirty_since = time.time()


# --------------------------------------------------------------------------
# Server state (all access guarded by `lock`)
# --------------------------------------------------------------------------

lock = threading.RLock()
started_at = time.time()
records = RecordStore(os.path.join(resolve_data_dir(), "records.json"))

clients = {}        # sid -> {"name": str, "since": ms}
solo = {}           # sid -> (status dict, ms timestamp): this board's own player, for the LED matrix
members = []        # LAN lobby (this board as host): {"id","name","board","ready","team"}
match = None        # running LAN match or None
last_results = None
last_results_at = 0.0
event_times = {}    # sid -> [window_start_ms, count]

_ui_kwargs = {}
if os.environ.get("ARDUSNOW_ASSETS"):
    _ui_kwargs["assets_dir_path"] = os.environ["ARDUSNOW_ASSETS"]
if os.environ.get("ARDUSNOW_PORT"):
    _ui_kwargs["port"] = int(os.environ["ARDUSNOW_PORT"])
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
                     "team": m["team"], "isHost": m["id"] == hid} for m in members],
        "hostId": hid,
        "playing": match is not None,
        "max": MAX_PLAYERS,
        "durationMs": MATCH_MS,
    }


def broadcast_lobby():
    ui.send_message("lobby", lobby_payload(), room="lobby")


def broadcast_records():
    ui.send_message("records", records.snapshot())


def rate_limited(sid, t):
    win = event_times.setdefault(sid, [t, 0])
    if t - win[0] >= 1000:
        win[0], win[1] = t, 0
    win[1] += 1
    return win[1] > EVENT_RATE_LIMIT


# --------------------------------------------------------------------------
# LAN match lifecycle
# --------------------------------------------------------------------------

def assign_teams(humans, rng):
    """Humans keep their chosen team when it is not full, the rest balance out."""
    teams = {0: [], 1: []}
    cap = max(TEAM_MIN, (len(humans) + 1) // 2)
    auto = []
    for m in humans:
        if m["team"] in (0, 1) and len(teams[m["team"]]) < cap:
            teams[m["team"]].append(m)
        else:
            auto.append(m)
    rng.shuffle(auto)
    for m in auto:
        t = 0 if len(teams[0]) <= len(teams[1]) else 1
        teams[t].append(m)
    return teams


def build_match():
    seed = random.randint(1, 2**31 - 1)
    rng = random.Random(seed)
    hid = host_id()
    teams = assign_teams(list(members), rng)
    size = max(TEAM_MIN, len(teams[0]), len(teams[1]))
    names = list(BOT_NAMES)
    rng.shuffle(names)
    roster = []
    nbot = 0
    for team in (0, 1):
        for slot in range(size):
            if slot < len(teams[team]):
                m = teams[team][slot]
                roster.append({"id": m["id"], "name": m["name"], "team": team, "slot": slot,
                               "isBot": False, "owner": m["id"], "board": m["board"]})
            else:
                roster.append({"id": f"bot{nbot}", "name": names[nbot % len(names)], "team": team,
                               "slot": slot, "isBot": True, "owner": hid, "board": ""})
                nbot += 1
    return {
        "matchId": f"s{int(time.time())}-{seed % 10000}",
        "seed": seed,
        "startAt": now_ms() + COUNTDOWN_MS,
        "durationMs": MATCH_MS,
        "roster": roster,
        "hostId": hid,
        "netHz": TICK_HZ,
        "ent": {e["id"]: e for e in roster},
        "humans": {e["id"] for e in roster if not e["isBot"]},
        "left": set(),
        "states": {},
        "game": None,            # authoritative block from the host browser: score, stars, stats
        "best_snipe": {},        # id -> longest hit (m)
    }


def match_public(m):
    return {k: m[k] for k in ("matchId", "seed", "startAt", "durationMs", "roster", "hostId", "netHz")}


def results_locked():
    """Final scoreboard from the host's last game block. Must hold lock."""
    m = match
    game = as_dict(m["game"])
    score = game.get("score") if isinstance(game.get("score"), list) else [0, 0]
    hits = game.get("hits") if isinstance(game.get("hits"), list) else [0, 0]
    score = [as_int(score[i] if i < len(score) else 0, 0, 999) for i in (0, 1)]
    hits = [as_int(hits[i] if i < len(hits) else 0, 0, 9999) for i in (0, 1)]
    stats = as_dict(game.get("stats"))
    if score[0] != score[1]:
        winner = 0 if score[0] > score[1] else 1
    elif hits[0] != hits[1]:
        winner = 0 if hits[0] > hits[1] else 1
    else:
        winner = -1
    rows = []
    for e in m["roster"]:
        st = stats.get(e["id"]) if isinstance(stats.get(e["id"]), list) else []
        rows.append({"id": e["id"], "name": e["name"], "team": e["team"], "isBot": e["isBot"],
                     "hits": as_int(st[0] if len(st) > 0 else 0, 0, 999),
                     "caps": as_int(st[1] if len(st) > 1 else 0, 0, 99),
                     "outs": as_int(st[2] if len(st) > 2 else 0, 0, 999),
                     "left": e["id"] in m["left"]})
    rows.sort(key=lambda r: (-r["caps"], -r["hits"], r["outs"], r["name"]))
    return {"matchId": m["matchId"], "score": score, "hits": hits, "winner": winner, "rows": rows}


def finalize_locked():
    global match, last_results, last_results_at
    payload = results_locked()
    new_record = False
    for r in payload["rows"]:
        if r["isBot"] or r["left"]:
            continue
        result = "draw" if payload["winner"] < 0 else "win" if payload["winner"] == r["team"] else "loss"
        if r["caps"] or r["hits"]:
            if records.submit_match(r["name"], r["caps"], r["hits"], result, "lan"):
                new_record = True
        d = match["best_snipe"].get(r["id"])
        if d and records.submit_snipe(r["name"], d):
            new_record = True
    match = None
    last_results, last_results_at = payload, now_ms()
    for mem in members:
        mem["ready"] = False
    return payload, new_record


def finalize_and_broadcast():
    with lock:
        if match is None:
            return
        payload, new_record = finalize_locked()
    ui.send_message("match_results", payload, room="match")
    broadcast_lobby()
    if new_record:
        broadcast_records()


def match_should_end_locked(t):
    if not (match["humans"] - match["left"]):
        return True
    return t >= match["startAt"] + match["durationMs"] + END_GRACE_MS


def remove_member(sid, disconnected):
    left_payload = None
    end = False
    with lock:
        was_member = find_member(sid) is not None
        members[:] = [m for m in members if m["id"] != sid]
        if disconnected:
            clients.pop(sid, None)
            solo.pop(sid, None)
            event_times.pop(sid, None)
        if match is not None and sid in match["humans"] and sid not in match["left"]:
            match["left"].add(sid)
            match["states"].pop(sid, None)
            active = [e["id"] for e in match["roster"] if e["id"] in match["humans"] - match["left"]]
            if match["hostId"] == sid or match["hostId"] not in active:
                # next lobby member still playing takes over bots and stars
                nxt = next((m["id"] for m in members if m["id"] in active), active[0] if active else None)
                match["hostId"] = nxt
            for e in match["roster"]:
                if e["isBot"] or e["id"] == sid:
                    e["owner"] = match["hostId"]
            left_payload = {"id": sid, "hostId": match["hostId"]}
            end = match_should_end_locked(now_ms())
    if left_payload:
        ui.send_message("player_left", left_payload, room="match")
    if end:
        finalize_and_broadcast()
    elif was_member:
        broadcast_lobby()


# --------------------------------------------------------------------------
# Socket.IO handlers
# --------------------------------------------------------------------------

def on_connect(sid):
    with lock:
        clients[sid] = {"name": "Player", "since": now_ms()}


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
    # this board's player (solo or in a LAN match hosted anywhere): drives the LED matrix
    data = as_dict(data)
    state = data.get("state")
    if state not in ("menu", "countdown", "playing", "finished"):
        return None
    status = {"state": state,
              "count": as_int(data.get("count"), 0, 9),
              "secs": as_int(data.get("secs"), 0, MATCH_MS // 1000, MATCH_MS // 1000),
              "ammo": as_int(data.get("ammo"), 0, 3),
              "snow": as_int(data.get("snow"), 0, 100),
              "flags": as_int(data.get("flags"), 0, 15),
              "my": as_int(data.get("my"), 0, 99),
              "their": as_int(data.get("their"), 0, 99),
              "result": as_int(data.get("result"), 0, 2)}
    with lock:
        solo[sid] = (status, now_ms())
    return None


def on_lobby_join(sid, data):
    data = as_dict(data)
    with lock:
        if match is not None:
            return {"ok": False, "reason": "match_in_progress"}
        m = find_member(sid)
        name = clean_name(data.get("name"), clients.get(sid, {}).get("name", "Player"))
        board = clean_word(data.get("board"), 40) or "?"
        if m is None:
            if len(members) >= MAX_PLAYERS:
                return {"ok": False, "reason": "lobby_full"}
            members.append({"id": sid, "name": name, "board": board, "ready": False, "team": -1})
        else:
            m["name"], m["board"] = name, board
        if sid in clients:
            clients[sid]["name"] = name
    broadcast_lobby()
    return {"ok": True, "lobby": lobby_payload()}


def on_lobby_leave(sid, data):
    remove_member(sid, disconnected=False)
    return {"ok": True}


def on_lobby_update(sid, data):
    # ready toggle and / or team pick (-1 = auto, 0 = blue, 1 = red)
    data = as_dict(data)
    with lock:
        m = find_member(sid)
        if m is None:
            return {"ok": False, "reason": "not_in_lobby"}
        if match is not None:
            return {"ok": False, "reason": "match_in_progress"}
        if "ready" in data:
            m["ready"] = bool(data.get("ready"))
        if "team" in data:
            m["team"] = as_int(data.get("team"), -1, 1, -1)
    broadcast_lobby()
    return {"ok": True}


def on_lobby_start(sid, data):
    global match
    with lock:
        if match is not None:
            return {"ok": False, "reason": "match_in_progress"}
        if not members or sid != host_id():
            return {"ok": False, "reason": "not_host"}
        if any(not m["ready"] for m in members[1:]):
            return {"ok": False, "reason": "not_ready"}
        match = build_match()
        payload = match_public(match)
    ui.send_message("match_start", payload, room="lobby")
    broadcast_lobby()
    return {"ok": True, "matchId": payload["matchId"]}


def on_state(sid, data):
    # {"ents": [own player (+ bots if host)], "game": {...} (host only)}
    data = as_dict(data)
    ents = data.get("ents")
    if not isinstance(ents, list):
        return None
    with lock:
        if match is None or sid in match["left"]:
            return None
        if len(json.dumps(data, separators=(",", ":"))) > STATE_MAX_BYTES:
            return None
        for e in ents[:MAX_ENTS]:
            if not isinstance(e, dict):
                continue
            eid = e.get("id")
            info = match["ent"].get(eid) if isinstance(eid, str) else None
            if info is not None and info["owner"] == sid:
                match["states"][eid] = e
        if sid == match["hostId"] and isinstance(data.get("game"), dict):
            match["game"] = data["game"]
    return None


def on_event(sid, data):
    # gameplay events relayed to every client in the match: throw, hit, grab, drop, capture...
    data = as_dict(data)
    kind = data.get("type")
    if not isinstance(kind, str) or len(kind) > 16:
        return None
    t = now_ms()
    with lock:
        if match is None or sid not in match["humans"] or sid in match["left"] or rate_limited(sid, t):
            return None
        if kind == "hit":
            # longest hit per thrower, for the records
            by = data.get("by")
            dist = as_number(data.get("dist"), 0.0)
            if isinstance(by, str) and by in match["humans"] and 0 < dist < 200:
                if dist > match["best_snipe"].get(by, 0):
                    match["best_snipe"][by] = dist
    payload = dict(data)
    payload["from"] = sid
    payload["t"] = t
    ui.send_message("event", payload, room="match")
    return None


def on_match_state(sid, data):
    with lock:
        resp = {"lobby": lobby_payload(), "serverTime": now_ms()}
        if match is not None:
            resp["match"] = match_public(match)
        elif last_results is not None:
            resp["results"] = last_results
    return resp


def on_record(sid, data):
    # end of a solo match on this board
    data = as_dict(data)
    name = clean_name(data.get("name"))
    caps = as_int(data.get("caps"), 0, 99)
    hits = as_int(data.get("hits"), 0, 999)
    result = data.get("result") if data.get("result") in ("win", "loss", "draw") else "loss"
    snipe = as_number(data.get("snipe"), 0.0)
    with lock:
        rank_match = records.submit_match(name, caps, hits, result, "solo") if (caps or hits) else None
        rank_snipe = records.submit_snipe(name, snipe) if 0 < snipe < 200 else None
    if rank_match or rank_snipe:
        broadcast_records()
    return {"ok": True, "rankMatch": rank_match, "rankSnipe": rank_snipe}


def on_get_records(sid, data):
    with lock:
        return records.snapshot()


# --------------------------------------------------------------------------
# LED matrix state for the sketch
#   idle | lobby:<n> | count:<n> | play:<secs>:<ammo>:<flags>:<my>:<their>:<snow>
#   | finish:<my>:<their>:<result 0 loss 1 win 2 draw>
#   flags: 1 carrying the star, 2 frozen, 4 our star is stolen, 8 snow in hands
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
            if s["state"] == "playing":
                return f"play:{s['secs']}:{s['ammo']}:{s['flags']}:{s['my']}:{s['their']}:{s['snow']}"
            return f"finish:{s['my']}:{s['their']}:{s['result']}"
        if match is not None:
            dt = match["startAt"] - t
            if dt > 0:
                return f"count:{max(0, min(3, math.ceil(dt / 1000.0)))}"
            secs = max(0, math.ceil((match["startAt"] + match["durationMs"] - t) / 1000.0))
            sc = as_dict(match["game"]).get("score")
            sc = sc if isinstance(sc, list) and len(sc) == 2 else [0, 0]
            return f"play:{secs}:0:0:{as_int(sc[0], 0, 99)}:{as_int(sc[1], 0, 99)}:0"
        if last_results_at and t - last_results_at < RESULTS_LED_MS and last_results:
            sc = last_results["score"]
            return f"finish:{sc[0]}:{sc[1]}:{2 if last_results['winner'] < 0 else 1}"
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
ui.on_message("lobby_join", on_lobby_join)
ui.on_message("lobby_leave", on_lobby_leave)
ui.on_message("lobby_update", on_lobby_update)
ui.on_message("lobby_start", on_lobby_start)
ui.on_message("state", on_state)
ui.on_message("event", on_event)
ui.on_message("match_state", on_match_state)
ui.on_message("record", on_record)
ui.on_message("get_records", on_get_records)
ui.expose_api("GET", "/api/status", api_status)
if os.environ.get("ARDUSNOW_DEBUG") == "1":
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
    """20 Hz server tick: snapshots, match end, debounced record saving."""
    global _next_tick
    snapshot = None
    end = False
    with lock:
        if match is not None:
            t = now_ms()
            if match["states"] or match["game"]:
                snapshot = {"t": t, "hostId": match["hostId"], "ents": list(match["states"].values()),
                            "game": match["game"]}
            end = match_should_end_locked(t)
        records.save_if_due()
    if snapshot:
        ui.send_message("snapshot", snapshot, room="match")
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
