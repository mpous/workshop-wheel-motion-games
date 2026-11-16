# Multiplayer models

All three servers tick at `TICK_HZ = 20`, use the server clock (`now_ms()`, synced in the browser by `Net.syncClock()`), and pick the **host as the first lobby member** (`host_id()`). Only the host may start (`not_host`), and every other member must be ready (`not_ready`). Starting while a match runs returns `race_in_progress` or `match_in_progress`. A match carries a random `seed`, so every browser builds the same world.

| | Kart | Fishing | Snowball |
|---|---|---|---|
| Topology | Many browsers, **one board** | One board per player; each browser opens a second `Net` to the **host board** | Same as Fishing |
| Max humans | `MAX_HUMANS = 20` | `MAX_PLAYERS = 20` | `MAX_PLAYERS = 8` (4 v 4), bots fill each team to `TEAM_MIN = 3` |
| Countdown | `COUNTDOWN_MS = 5000` | `COUNTDOWN_MS = 6000` | `COUNTDOWN_MS = 6000` |
| Length | laps (`lobby_settings`) | `MATCH_MS` (3 min, `ARDUFISH_MATCH_MS`) | `MATCH_MS` (3 min, `ARDUSNOW_MATCH_MS`) |
| End grace | n/a | `END_GRACE_MS = 2500` (late scores still count) | `END_GRACE_MS = 1500` |
| What is relayed | kart states → `snapshot` at `netHz`; `event` | only scores; boards are independent | entity states → `snapshot`; `event` |
| Authority | host browser drives the bots | each player is the authority for their own score | host browser drives the bots, the two stars and the score (`game` block) |
| Rooms | `race` | `tourney` | `lobby`, `match` |

## Kart (ardu-kart)

- `lobby_join` / `lobby_update {character, name, ready}` / `lobby_settings {track, cc, laps, bots}` (host only). `DEFAULT_SETTINGS = {"track": "sunset", "cc": 100, "laps": 3, "bots": True}`.
- `lobby_start` → `race_start` (to everyone) with `raceId, seed, track, cc, laps, startAt, grid, hostId, netHz`.
- `netHz` is `TICK_HZ` up to `BIG_FIELD = 10` humans and `TICK_HZ // 2` above (commit topic: 10 Hz above 10 humans).
- `state {karts:[...]}`: the server keeps a kart only if `info["owner"] == sid`. The browser interpolates remote karts `snapDelay = 2000 / netHz + 10` ms behind (`race.js`).
- `finish {id, time, bestLap}` → `race_results` to everyone.
- When a player leaves, `player_left {id, newHostId, botsOwner}`: the new host takes over the bots.

## Fishing (ardu-fishing)

- Hosting is symmetric: every board runs the same app. The browser `Tourney` (`tourney.js`) connects to `hostUrl(addr)`, which strips the scheme and path and adds `:7000` (or the page's port). For example `my-unoq.local` becomes `http://my-unoq.local:7000`. The connection test times out after 5 s. Recent hosts are kept in `localStorage['ardufish.hosts']`.
- `tourney_join {name, board}` → `tourney_lobby` (room `tourney`); `tourney_ready {ready}`; `tourney_start` → `tourney_start {matchId, seed, startAt, durationMs, players}`. The same seed gives the same fish spawn pattern on every board.
- During the match the browser sends `tourney_score {fish, kg, phase}` every `SCORE_MS = 500` and `tourney_catch {species, kg, rarity}` for each catch. A score is accepted only between `startAt` and `startAt + durationMs + END_GRACE_MS`, and it only goes up.
- The host pushes `tourney_scores` at most `SCORE_RATE_HZ = 4` times per second, and only when something changed. `tourney_results` ends the match. `tourney_state` lets a reconnecting browser catch up.

## Snowball (ardu-snowball)

- Same connection pattern as Fishing (`lan.js`, `hostUrl()`, `localStorage['ardusnow.hosts']`).
- `lobby_join {name, board}`; `lobby_update {ready, team}` with team −1 auto, 0 blue, 1 red; `lobby_start` → `match_start` (room `lobby`) with `matchId, seed, startAt, durationMs, roster, hostId, netHz`.
- `state {ents:[own player (+ bots if host)], game:{...} (host only)}`, dropped if larger than `STATE_MAX_BYTES = 6000`. The server merges every state into one `snapshot {t, hostId, ents, ...}` per tick (room `match`).
- `event {type, ...}` (throws, hits, star requests) is relayed to everyone; `type` is a short string (≤ 16 chars).
- The browser sends at `NET_MS = 50` and interpolates remote entities `INTERP_MS = 120` behind (`game.js`).
- If the host leaves, the next active lobby member becomes `hostId` and takes over the bots and the stars; everyone gets `player_left {id, hostId}`. `match_results` ends the match.

## Choosing a model for a new game

- Players share a screen or a room with one board: copy **Kart**.
- Players only compare scores: copy **Fishing**. It is the simplest and the most tolerant of a bad network.
- Players interact in real time: copy **Snowball**. Keep the simulation in the host browser, not in Python.
- Keep the controller on the player's **own** board in every case: the second `Net` only carries game traffic, so `MotionController` keeps talking to the board it was served from.
- Test with `devtools/mp_test.js` (Kart) and `devtools/fish_tourney.js` (Fishing); see `motion-game-devtools`.
