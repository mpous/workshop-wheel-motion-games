# New game checklist (detailed)

The example below copies `ardu-fishing` to `ardu-<game>` with the prefix `ARDUXXX` / `arduxxx`. Swap in your own names. Run the commands from the repository root.

## 1. Copy and clean

```sh
cp -r ardu-fishing ardu-<game>
rm -rf ardu-<game>/data ardu-<game>/sketch/libraries ardu-<game>/sketch/build ardu-<game>/python/__pycache__
```

Add `data/`, `sketch/libraries/` and `sketch/build/` for the new folder to `.gitignore`. `sketch/libraries/` is where `model_installer.py` unpacks an uploaded Edge Impulse library, so it must never be committed.

## 2. App manifest

- `app.yaml`: new `name`, `icon`, `description`. Keep both bricks (WebUI and motion detection). Update the comment that lists the gesture classes.
- The WebUI brick serves on port 7000. Only one app runs on a board at a time, so all games can keep it.

## 3. Rename the prefix

```sh
grep -rn "ARDUFISH\|ardufish\|Ardu Fishing" ardu-<game> devtools/run_fishing.sh
```

Rename:
- env vars (`ARDUFISH_PORT`, `_ASSETS`, `_DATA_DIR`, `_APP_DIR`, `_DEBUG`, `_MATCH_MS`);
- sketch macros in `sketch.ino`, `model_config.h` and `model_installer.py` (`*_HAS_MODEL`, `*_EI_HEADER`, `*_SAMPLE_US`);
- log tags, `localStorage` keys (`.settings`, `.records`, `.hosts`) and `window.ardufish`.

Do **not** rename `ARDUKART_SIM_*` (shared by the stub Bridge) or `ardukart.ei.key` (shared Edge Impulse key).

## 4. Sketch

- Keep `sketch/sketch.yaml` (`arduino:zephyr` profile, pinned libraries). The library list must match `BASE_LIBRARIES` in `model_installer.py`, because the installer rewrites `sketch.yaml` when it adds a model.
- Reset `model_config.h` to `#define ARDUXXX_HAS_MODEL 0`, so the first build works without a model.
- Rewrite `led_frames.h`: the state list in the header comment, `parseLedState()`, the frames and `gestureIconFor()`.
- Rewrite `onPix()` / `renderPixels()` with your modes (0 = idle by convention, keep a `PIX_TIMEOUT` back to idle).
- Keep: `sampleImu()`, `runModel()`, `pollButtons()`, `sendInfo()`, `onLedState`, `onButtonLeds`, `onGesture`, `onEngine`, `GESTURE_CONFIDENCE`.
- Build and flash through App Lab; see `arduino-unoq-applab`.

## 5. Python

- Keep `controller.py`, `brick_engine.py` and `model_installer.py` (prefix rename only).
- `main.py`:
  - `get_led_state()`: map the game state to the strings of step 4.
  - `on_solo_status()`: validate with `as_int` / `clean_name` and clamp to your ranges.
  - `RecordStore`: the record fields, and the rule that only better scores replace older ones.
  - The lobby or match handlers from the base you copied (`references/multiplayer.md`).
  - Keep `tick()` calling `push_led_state()`, and keep `resolve_data_dir()`.

## 6. Browser

| File | Change |
|---|---|
| `motion.js` | `ACTIONS`, `DEFAULT_LABELS`, `defaultAction()` keywords, `EDGE`, `HOLD_MS`, `poll()` return object, `_onButton()` mapping, the aim axis (see `modulino-imu-aim`). Keep the claim / release / visibility code and the HUD |
| `input.js` | `KEYMAP`, gamepad buttons, touch buttons, and how `poll()` merges `motion.poll()` |
| `index.html` | the `#touch` buttons, the title |
| `game.js` | your game, with `pixels()`, `buttonMask()`, `wantedAction()`, `status()` |
| `ui.js` | screens, help text, the motion screen's action list |
| `hud.js` | in-match overlay (filter `null` children) |
| `audio.js` | new procedural sounds |
| `train.html` / `train.js` | keep; only the default labels and the prefix change |

## 7. Class names

Keep three places consistent with your Edge Impulse classes:
- the sketch `isIdleLabel()` and `GESTURE_CONFIDENCE` in `sketch.ino`;
- the Python `IDLE_RE` in `controller.py`;
- the browser `defaultAction()` keywords and `DEFAULT_LABELS`.

The idle class must match `IDLE_RE`, or it will fire actions and flash the board. Model training is covered by `edge-impulse-motion-gestures`.

## 8. three.js bundle

```sh
cd devtools
cp vendor-entry-fishing.js vendor-entry-<game>.js   # edit the exports you need
npx esbuild vendor-entry-<game>.js --bundle --format=esm --minify --outfile=../ardu-<game>/assets/libs/three.bundle.js
```

## 9. Local run and checks

- Copy `devtools/run_fishing.sh` to `run_<game>.sh` and set `ARDUXXX_ASSETS`, `ARDUXXX_DATA_DIR`, `ARDUXXX_PORT`, `ARDUXXX_APP_DIR` and `ARDUKART_SIM_LABELS` (your classes).
- Add a headless check (copy `fish_tourney.js` or `mp_test.js`). Details are in `motion-game-devtools`.
- On the board, open `http://my-unoq.local:7000`.

## 10. Docs

- `ardu-<game>/README.md`: how to play, how to train, buttons, LED matrix, Pixels, and how to run it on the board.
- Add the game to the TIP in the root `README.md`.

## Done when

- [ ] The game is playable with the keyboard, a gamepad, touch and the Modulino buttons, with no model.
- [ ] With a model, every class shows in the HUD, and the class the game wants glows.
- [ ] The LED matrix shows `idle`, the countdown, live play and finish; the Pixels return to idle on their own.
- [ ] Two tabs: the visible one drives the controller, and the other shows "on another screen".
- [ ] Records survive an app restart (`data/records.json`).
- [ ] The engine selector (auto, brick, mcu) works and survives a restart (`data/motion.json`).
