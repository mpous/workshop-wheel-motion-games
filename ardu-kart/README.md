# Ardu Kart: a 3D kart racer served by the Arduino UNO Q

Ardu Kart is an original arcade kart racer: 8 characters, 4 tracks, 9 items, drifting with mini-turbos, rocket starts, a Grand Prix with a podium, time trials with ghosts, and LAN multiplayer for up to 20 players.

Mount the UNO Q and three Modulinos on a wheel and your hands become the controller:

- **Steering:** tilt the wheel. The gyroscope and accelerometer give the angle.
- **Gestures:** an **Edge Impulse model** recognises *accelerate*, *brake*, *use item* and *change camera*, or any classes you train. Each class is mapped to an action in the game.
- **Buttons:** hold **A** or **C** to accelerate, and press **B** to use an item.
- **Pixels:** rev and shift lights that show the speed, plus colours for boosts, drift sparks and the finish.
- **LED matrix:** a live race display with the lobby count, the countdown, your lap and your position.

The UNO Q is the game server. Every player runs the game in their own browser (WebGL) and connects to the board over Wi-Fi. Records are saved on the board.

```
ardu-kart/
├── app.yaml        ← app metadata, uses the arduino:web_ui and arduino:motion_detection bricks
├── python/         ← main.py: lobby, race relay, records, LED state
│                      controller.py: Modulino wheel, Motion Lab, Edge Impulse API
│                      brick_engine.py: gesture inference with the Motion detection brick
│                      model_installer.py: installs an EI Arduino library into the sketch
├── sketch/         ← sketch.ino: LED matrix, Modulinos, on-device EI inference (MCU)
└── assets/         ← the game (index.html) and the Motion Lab (train.html)
```

---

## 1. Run it on the Arduino UNO Q

The steps are the same for every game in this repo. See [Run a game on the UNO Q](../README.md#4-run-a-game-on-the-uno-q) in the main README.

```bash
# from the root of this repository
scp -r ardu-kart arduino@my-unoq.local:/home/arduino/ArduinoApps/
ssh arduino@my-unoq.local "arduino-app-cli app start user:ardu-kart"
```

Then open **http://my-unoq.local:7000** on any computer, tablet or phone on the same network.

**Multiplayer:** everyone opens the same URL and picks **Multiplayer**.

- The first to join is the host. The host chooses the track, the class, the number of laps and whether CPU rivals join.
- **Up to 20 players** race together. With CPU rivals on, the game adds AI karts to smaller lobbies, up to 8 karts in total.
- Above 10 players the board sends race updates at 10 Hz instead of 20 Hz to reduce the Wi-Fi traffic. Remote karts are interpolated, so you won't notice.

> [!NOTE]
> The game used to be called Q-Kart. If the board still has the old app, stop it, copy its saved records and wheel settings over, and remove it so only one copy runs: `ssh arduino@my-unoq.local "cd /home/arduino/ArduinoApps && arduino-app-cli app stop user:q-kart; cp -rn q-kart/data ardu-kart/ 2>/dev/null; rm -rf q-kart"`. A model you installed with `model_installer.py` lives in the old app's sketch folder, so install it again into `ardu-kart`. A model downloaded for the Motion detection brick has to be selected again in the new app's brick configuration.

## 2. Train the gestures

Follow [Train your gestures with Edge Impulse](../README.md#5-train-your-gestures-with-edge-impulse) in the main README, with these classes:

| Class | Gesture idea |
|---|---|
| `idle` | Holding the wheel and steering normally. Record plenty of it, so steering never triggers a gesture |
| `accelerate` | Push the wheel forward |
| `brake` | Pull the wheel towards you |
| `use_item` | A quick up-down shake |
| `change_camera` | A short twist out of plane |

Without any model the wheel still works. It steers, the buttons work, and the throttle stays on automatically.

## 3. Set up the wheel

Open the game and press **Train your motion controller** on the main menu:

- **Calibrate**: hold the wheel straight, then turn it fully right. It takes two seconds and works however the board is mounted.
- **Re-centre**: sets the current pose as straight ahead.
- **Sensitivity / Deadzone / Invert steering / Tilt to navigate menus.**
- **Gesture confidence**: the probability a class needs before it triggers.
- **Gesture → action**: for every class your model outputs, choose *Accelerate, Brake, Use item, Change camera, Look back, Drift, Pause* or *Nothing*. Defaults are picked from the label names.
- **Gesture engine**: *Auto*, *Motion detection brick* or *MCU model*.
- **Train your gestures** opens the Motion Lab.
- A live dial and live class bars, so you can check everything before racing.

The HUD in the bottom-left corner shows:

- a steering wheel that turns with yours, and the direction and angle (for example *◀ LEFT 23°*)
- the gyroscope turn rate and raw axes in °/s
- the throttle state: GAS, CRUISE or BRAKE
- the gesture engine
- every class of your model with its confidence in %. The top class is highlighted, and the yellow mark is the confidence threshold.

Only one screen drives the wheel at a time:

- **The game takes the wheel** when it's free, from the Motion Lab when you switch back to the game tab, and from a game tab in the background or an old tab.
- **It never takes it from another LAN player's game that is on screen.** The HUD then says *Wheel on another screen*, and **Use the wheel here** takes it.

## 4. Controls

| | Modulino wheel | Keyboard | Gamepad | Touch |
|---|---|---|---|---|
| Steer | tilt / turn the wheel | ← → / A D | left stick / d-pad | left stick |
| Accelerate | hold **A** or **C**, or the `accelerate` gesture (the throttle stays on until you brake) | ↑ / W | A / RT | always on |
| Brake / reverse | `brake` gesture; again at a standstill to reverse | ↓ / S | B / LT | BRAKE |
| Use item (hold brake to throw back) | `use_item` gesture or **B** | E / J / X / Ctrl | X | ITEM |
| Drift / hop | a gesture mapped to *Drift* | Space / Shift / K | RB / LB | DRIFT |
| Change camera | `change_camera` gesture | C | | |
| Look back | a gesture mapped to *Look back* | Q / L | Y | ⟲ |
| Pause | a gesture mapped to *Pause* | Esc / P | Start | ❚❚ |
| Menus | A = OK, B = back, C = down; tilt to change options | arrows, Enter, Esc | | tap |

On the main menu the buttons are shortcuts: **A** Start, **B** Grand Prix and **C** LAN. Without a Buttons module and a model, the throttle stays on for you. Keyboard, gamepad and touch keep working alongside the wheel.

Tips:
- **Rocket start:** press the gas just as the countdown shows **1**.
- **Drifts:** hold a drift through a corner. The sparks go blue, then orange, then purple, for bigger mini-turbos.
- **Tricks:** press drift when you leave a ramp for a trick boost.

## 5. Troubleshooting

The [shared troubleshooting table](../README.md#troubleshooting) covers the board, the Modulinos, the brick and model installs. These are specific to Ardu Kart:

| Problem | Fix |
|---|---|
| The game is slow | Open **Settings → Graphics** and choose *Medium* or *Low*. Dynamic resolution also kicks in automatically. |
| "Offline" badge in the menus | The browser lost its Socket.IO connection to the board. Solo modes still work; reload to reconnect. |
| The wheel steers the wrong way or drifts | **Train your motion controller → Calibrate**, or **Re-centre** while holding the wheel straight. |
| Gestures fire while you steer | Record more `idle` data while steering normally, or raise **Gesture confidence**. |
| The wheel doesn't steer, A / C don't accelerate, and the HUD says *Wheel on another screen* | Another tab or browser has the wheel, for example an old tab App Lab opened on a previous **Run**. Press **Use the wheel here**, or close the other tabs. |

## 6. Developer tools

Set up `devtools/` first, as described in [Developer tools](../README.md#7-developer-tools) in the main README.

```bash
# from the root of this repository
ARDUKART_SIM_BOARD=1 ARDUKART_DEBUG=1 ARDUKART_PORT=7111 ./run_local.sh
```

The simulated wheel sways slowly and streams IMU data, class probabilities and button presses. Drive it from a second terminal:

```bash
curl "localhost:7111/api/debug/sim?tilt=0.4"           # radians, + = left, - = right
curl "localhost:7111/api/debug/sim?gesture=accelerate"  # or brake, use_item, change_camera
curl "localhost:7111/api/debug/sim?button=0"            # 0 = A, 1 = B, 2 = C
curl "localhost:7111/api/debug/sim?button=0&hold=3"     # hold A for 3 s (gas in a race)
curl "localhost:7111/api/debug/sim?auto=1"              # back to the slow sway
```

Add `ARDUKART_SIM_BRICK=1` to simulate the Motion detection brick as well, and `ARDUKART_SIM_MODEL=0` to simulate a sketch without an MCU model, so the game uses the brick.

The headless checks, from `devtools/` (the screenshot scripts default to port 7111, and you can pass another port as the last argument):

```bash
node game_shot.js basic           # menu screenshots  -> devtools/shots/
node game_shot.js race            # mid-race screenshots
node game_shot.js full            # a full 1-lap race to the results screen
node mp_test.js                   # two headless players race each other
node mp_test.js 7111 12           # ... or up to 20 players
ARDUKART_URL=http://localhost:7111 node lab_check.js   # Motion Lab, wheel steering, gestures and calibration (needs the simulated board)
node board_probe.js http://my-unoq.local:7000   # on a real board: who owns the wheel, Modulinos, gesture engine
.venv/bin/python test_server.py  # 120+ server checks: protocol, 20-player lobby, wheel, Motion Lab, brick, Edge Impulse (fake API)
```

`test_server.py` needs two more packages: `devtools/.venv/bin/pip install "python-socketio[client]" requests`.

To install an MCU model from a terminal, on your computer before copying the app or on the board:

```bash
python3 ardu-kart/python/model_installer.py ~/Downloads/my-project-arduino-1.0.0.zip
python3 ardu-kart/python/model_installer.py --remove     # back to no model
```
