# Browser game structure

The paths are for `ardu-fishing/assets/`. Kart and Snowball follow the same pattern; their differences are noted below.

## Page and boot

- `index.html` contains `<canvas id="game">`, `#hud`, `#menus`, `#toast`, `#fps`, the touch overlay `#touch`, the Edge Impulse logo `#ei-logo`, and `#loader`. It loads `libs/socket.io.min.js` as a classic script, then `js/main.js` as a module. `<body data-screen="...">` is set by `App.onScreen(name)` so that CSS can react to the current screen.
- `main.js` contains `class App`:
  - `constructor`: `loadSettings()`, `AudioEngine`, `Input`, `Net`, `UI`, `MotionController` (`input.motion = motion`), and the multiplayer helper (`Tourney` or `Lan`). Then `_initRenderer()` and `_initNet()`. Audio is unlocked on the first `pointerdown` or `keydown`. A solo game pauses when the tab is hidden.
  - `boot()` steps the loader bar, builds the `World`, starts the `Attract` mode behind the menus, calls `renderer.compile(scene, camera)` so the first match doesn't hitch, and ends with `ui.reset('title')`.
  - The flow methods are `startPressed`, `_startGame(opts)` (hide the UI, create a `Game`, `motion.claim(false)`, `_sendStatus()`), `startSolo`, `startTourney`, `pause` and `resume`, `quitToMenu`, `backToLobby`, `onMatchEnd`, and `updateTouch`.
  - `loop(now)`: `dt` is clamped to 1/20 s. Then `input.poll(dt)`, then either `ui.handle(menuActions)` or a pause check, `game.update(dt, inp)` (or `attract.update`), `world.update`, `motion.update()`, the throttled `solo_status`, `render()` and `_adaptResolution()`.
  - Graphics use `QUALITY` presets (low, medium, high, ultra) with dynamic resolution (`dynScale` 0.6..1, tuned on the fps). A quality change reloads the page from the menu, or after the match.
- The app is also on `window.<prefix>` (`ardukart`, `ardufish`, `ardusnow`), so devtools scripts can drive it.

## Modules

| File | Role |
|---|---|
| `net.js` | `Net(url=null)`: `connect(name)` (then `hello`), `on/_fire`, `send`, `request` (uses `<name>_response`), `joinRoom/leaveRoom`, `syncClock()` (4 pings, keep the lowest RTT, smooth with 0.7/0.3, every 5 s), `now()` |
| `input.js` | `Input`: `KEYMAP`, gamepads (`navigator.getGamepads`: A, X/RT, Y, Start, the d-pad and stick), touch buttons and the aim strip, `poll(dt)` → `state`, `menuActions()`, `rumble()`, `isTouch()`, `lastDevice` |
| `motion.js` | `MotionController`: status, ownership, the aim filter, calibration, gestures → actions, buttons, `poll()`, `update()` (Pixels and button LEDs), `#motion-hud` |
| `ui.js` | `UI`: `show/back/reset/hide`, `handle(actions)`, `toast`, the widgets `btn/selector/slider/header/footer/logo`, and one `_<screen>()` method per screen |
| `hud.js` | In-match DOM overlay (clock, score, prompts, banners, boards) |
| `audio.js` | Procedural Web Audio (no files). Every method is a no-op while the audio is locked or unavailable |
| `util.js` | `clamp/lerp/damp/wrapAngle`, `makeRng(seed)` (mulberry32), `hashString`, `$`, `$$`, `el(tag, attrs, ...children)` |
| game files | Kart: `race.js`, `kart.js`, `track.js`, `tracks.js`, `ai.js`, `items.js`, `camera.js`, `scenery.js`... · Fishing: `game.js` (`Game`, `Attract`, `MATCH_MS`), `world.js`, `fish.js`, `rod.js`, `tourney.js` · Snowball: `game.js`, `world.js`, `models.js`, `fx.js`, `lan.js` |

## The contract between the game and motion.js

`motion.update()` and the HUD call these methods on the current game object (Fishing and Snowball):

| Method | Returns |
|---|---|
| `pixels()` | `[mode, value]` for the `pix` message |
| `buttonMask()` | bits of the button LEDs that do something right now |
| `wantedAction()` | the action whose class glows in the motion HUD |
| `status()` | the `solo_status` payload for the LED matrix |

`motion.poll()` returns a per-game object that `Input.poll` merges. Fishing returns `{aim, cast, unhook, pause, reel, reelTick, reelGesture}`, Snowball `{turn, throw, ...}` and Kart steering and throttle. It returns `null` when the controller isn't active, and the pulses are cleared each frame.

How gestures turn into actions (`_onMl` → `_gesture`):
1. Take the top class. If `p < settings.threshold` (default 0.7), stop.
2. `actionFor(label)` is `settings.map[label] || defaultAction(label)`. If the action is `'none'`, stop.
3. For an `EDGE` action: fire once (`pulses.set(action, p)`), then wait until the class falls below `0.6 × threshold` and `EDGE_COOLDOWN_MS` has passed.
4. For a hold action: `until[action] = now + HOLD_MS[action]`.
5. Update the HUD flash text `"<ACTION> 87%"`, set `input.lastDevice`, and `_emit('gesture')`.

The `ml` messages replayed from `motion_status` set `replay = true`: they update the HUD but don't fire actions.

## Settings persistence

- `localStorage['<prefix>.settings']` holds the name, quality, volume, touch mode, fps, the button strength (`buttonCast`, `buttonThrow`) and `motion` (`enabled`, `sensitivity`, `deadzone`, `invert`, `threshold`, `map`, `cal`). The Motion Lab reads and writes the same key, so a mapping or threshold set there applies to the game.
- `localStorage['<prefix>.records']` holds the browser-side records. `'<prefix>.hosts'` holds recent host addresses (Fishing and Snowball). `'ardukart.ei.key'` holds the Edge Impulse key, shared by all games.
- The gesture engine preference is **not** stored in the browser. It lives on the board (`motion.json`), shared by every browser.

## Vendor libraries

- `devtools/package.json` pins `three` and `esbuild`. Each `devtools/vendor-entry*.js` re-exports `three` and the `examples/jsm` pieces the game uses (EffectComposer, RenderPass, UnrealBloomPass, OutputPass, ShaderPass, FXAAShader, BufferGeometryUtils; Fishing adds Sky and Water). The build command is in the file header, for example:
  `npx esbuild vendor-entry-fishing.js --bundle --format=esm --minify --outfile=../ardu-fishing/assets/libs/three.bundle.js`
- Use it with `import * as THREE from '../libs/three.bundle.js'` and `new THREE.EffectComposer(...)`. Keep the libraries local, so the game works on a LAN without internet.

## Menus

- Navigation is spatial focus over `.nav` elements. Keyboard, gamepad and Modulino buttons all push into `input.menuQueue`.
- Fishing's main menu has a "TRAIN YOUR MOTION CONTROLLER" button that opens the `motion` screen. That screen has the engine selector, class-to-action selectors, threshold, sensitivity, calibration (`_motionCal`), and "TRAIN YOUR GESTURES", which opens `train.html` in a new tab.
- `ui.hide()` clears `#menus` and calls `app.onScreen('')`. Keep that call: without it the results-screen CSS hid the HUD after Retry (Kart commit "Show the race HUD again after Retry").
