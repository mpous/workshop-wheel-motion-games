# Ardu Kart: a 3D kart racer served by the Arduino UNO Q

Ardu Kart is an original arcade kart racer: 8 characters, 4 tracks, 9 items, drifting with mini-turbos, rocket starts, a Grand Prix with a podium, time trials with ghosts, and LAN multiplayer for up to 20 players.

The UNO Q acts as the game server. Its Linux side (Python plus the WebUI brick) serves the game, runs the multiplayer lobby and keeps the track records. Its MCU drives the 8×13 LED matrix as a live race display. Every player runs the game in their own browser (WebGL) and connects to the board over Wi-Fi.

**No joystick needed.** Mount the UNO Q on a wheel with three Modulinos and your hands become the controller. You tilt the wheel to steer. An Edge Impulse model recognises your gestures: *accelerate*, *brake*, *use item* and *change camera*, or any classes you train. The model runs either in the App Lab **Motion detection brick** on the Linux side (swap the model from App Lab, no recompiling) or on the MCU. The board also has two web pages:

- **Motion Lab** (`/train.html`) shows the live sensor charts. From there you record gestures straight into your Edge Impulse project, train the model, deploy it and test it.
- **The game** (`/`) is played with the wheel. Press **Train your motion controller** on the main menu to pick which gesture does what, choose the gesture engine and open the Motion Lab. While racing, the bottom-left HUD shows every detected class with its confidence in %.

See [section 3](#3-the-modulino-wheel-motion-controller--edge-impulse).

```
workshop-q-kart/
├── ardu-kart/            ← the App Lab app (this is what goes on the UNO Q)
│   ├── app.yaml       ← app metadata, uses the arduino:web_ui and arduino:motion_detection bricks
│   ├── python/        ← main.py: lobby, race relay, records, LED state
│   │                     controller.py: Modulino wheel, Motion Lab, Edge Impulse API
│   │                     brick_engine.py: gesture inference with the Motion detection brick
│   │                     model_installer.py: installs an EI Arduino library into the sketch
│   ├── sketch/        ← sketch.ino: LED matrix, Modulinos, on-device EI inference (MCU)
│   └── assets/        ← the game (index.html) and the Motion Lab (train.html)
├── run_local.sh       ← run the game on your computer, no board needed
└── devtools/          ← local runner, WebUI brick stub, automated tests
```

---

## 1. Run it locally (on your computer)

You'll need:
- **Python 3.10 or newer**. Check with `python3 --version`. On macOS use `brew install python@3.13`; on Ubuntu, `sudo apt install python3 python3-venv`.
- A recent **Chrome, Edge, Firefox or Safari**.

Steps:

1. Open a terminal in this folder:
   ```bash
   cd ~/Documents/projects/EdgeImpulse/workshop-q-kart
   ```
2. Start the local server:
   ```bash
   ./run_local.sh
   ```
   The first run creates `devtools/.venv` and installs FastAPI, Socket.IO and uvicorn, which takes about 30 seconds. It uses a vendored copy of the real Arduino WebUI brick. Later runs start instantly.
3. Open **http://localhost:7000** in your browser.
4. Press **Enter** (or click) on the title screen and race.
5. *(Optional)* Test multiplayer. The script prints a `Same network: http://192.168.x.x:7000` address. Open it on a second computer or phone on the same Wi-Fi (or in a second browser window). Pick **Multiplayer** on both, mark **Ready**, and the host presses **Start**.
6. Stop the server with **Ctrl+C**.

If port 7000 is busy, run `ARDUKART_PORT=8080 ./run_local.sh` instead. When running locally, the LED-matrix sketch is not used; the Bridge calls are stubbed out.

**Try the wheel without hardware:** run `ARDUKART_SIM_BOARD=1 ARDUKART_DEBUG=1 ./run_local.sh`. This adds a simulated Modulino wheel that sways slowly and streams IMU data, class probabilities and button presses, so the Motion Lab at **http://localhost:7000/train.html** and the wheel screens in the game behave as they do on the board. You drive the simulated board from a second terminal:
```bash
curl "localhost:7000/api/debug/sim?tilt=0.4"           # radians, + = left, - = right
curl "localhost:7000/api/debug/sim?gesture=accelerate"  # or brake, use_item, change_camera
curl "localhost:7000/api/debug/sim?button=0"            # 0 = A, 1 = B, 2 = C
curl "localhost:7000/api/debug/sim?auto=1"              # back to the slow sway
```
Add `ARDUKART_SIM_BRICK=1` to simulate the Motion detection brick as well, and `ARDUKART_SIM_MODEL=0` to simulate a sketch without an MCU model, so the game uses the brick.

---

## 2. Run it on the Arduino UNO Q

You'll need:
- A UNO Q that has finished its first-time setup in Arduino App Lab, with Wi-Fi configured.
- Your computer and the board on the **same network**.
- The board's name. It is shown in App Lab, and the examples below use `my-unoq`. You can use its IP address instead.

### Step 1: Copy the app to the board

```bash
cd ~/Documents/projects/EdgeImpulse/workshop-q-kart
scp -r ardu-kart arduino@my-unoq.local:/home/arduino/ArduinoApps/
```
The password is the one you set during the board's setup.

> [!NOTE]
> The game used to be called Q-Kart. If the board still has the old app, stop it, copy its saved records and wheel settings over, and remove it so only one copy runs: `ssh arduino@my-unoq.local "cd /home/arduino/ArduinoApps && arduino-app-cli app stop user:q-kart; cp -rn q-kart/data ardu-kart/ 2>/dev/null; rm -rf q-kart"`. A model you installed with `model_installer.py` lives in the old app's sketch folder, so install it again into `ardu-kart`. A model downloaded for the Motion detection brick has to be selected again in the new app's brick configuration.

### Step 2: Start the app

**Option A: from the terminal (SSH)**
```bash
ssh arduino@my-unoq.local
arduino-app-cli app start user:ardu-kart
```
The first start compiles and flashes the LED-matrix sketch, which can take up to a minute. To check that it is running:
```bash
arduino-app-cli app list
arduino-app-cli app logs /home/arduino/ArduinoApps/ardu-kart --all
```

**Option B: from the Arduino App Lab desktop app.** Connect to the board, open **My Apps**, select **Ardu Kart**, and press **Run**.

### Step 3: Play

On any computer, tablet or phone on the same network, open:

```
http://my-unoq.local:7000
```
(or `http://<board-ip>:7000`)

- The LED matrix shows the idle animation, then the lobby count, the countdown, and your lap and position during a race.
- **Multiplayer:** everyone opens the same URL and picks **Multiplayer**. The first to join is the host, who chooses the track, class, laps and whether CPU rivals join. **Up to 20 players** race together. With CPU rivals on, smaller lobbies are filled with AI up to 8 karts. Above 10 players the board sends race updates at 10 Hz instead of 20 Hz to keep the Wi-Fi traffic down; remote karts are interpolated, so you won't notice.
- Track records are saved on the board and shared by everyone who plays on it.

### Step 4: Stop the app

```bash
arduino-app-cli app stop /home/arduino/ArduinoApps/ardu-kart
```

### Updating after you change the code

```bash
scp -r ardu-kart arduino@my-unoq.local:/home/arduino/ArduinoApps/
ssh arduino@my-unoq.local "arduino-app-cli app stop /home/arduino/ArduinoApps/ardu-kart; arduino-app-cli app start user:ardu-kart"
```
Then hard-refresh the browser (Ctrl/Cmd + Shift + R).

### Troubleshooting

| Problem | Fix |
|---|---|
| `my-unoq.local` doesn't resolve (common on Android and some Windows setups) | Use the board's IP address. You can get it with `ssh arduino@my-unoq.local hostname -I`, or from your router. |
| The page loads but the game is slow | Open **Settings → Graphics** and choose *Medium* or *Low*. Dynamic resolution also kicks in automatically. |
| "Offline" badge in the menus | The browser lost its Socket.IO connection to the board. Solo modes still work; reload to reconnect. |
| Nothing on the LED matrix | The sketch is flashed when the app starts, so check `arduino-app-cli app logs ...` for compile errors. |
| Motion Lab shows "board offline" or no Modulinos | Check the Qwiic cables. Modulinos are detected every 2.5 s, so you can plug them in while the app runs. |
| The model is installed but the board still says "no model" | Restart the app. The model is only compiled into the sketch at start-up (see [3.4](#34-deploy-the-model-on-the-board)). If it is still missing, the compile failed, so check `arduino-app-cli app logs`. |
| The wheel steers the wrong way or drifts | Run **Train your motion controller → Calibrate** (main menu), or use **Re-centre** while holding the wheel straight. |
| The brick shows "not available" or keeps retrying | Pick a model in App Lab (Motion detection brick → Brick Configuration) and press Run again. The first start downloads the brick's container, which can take a few minutes. |
| The game shows the wrong classes | Check **Gesture engine**. With *Auto*, an MCU model installed in the sketch wins over the brick; pick *Motion detection brick* to use the model chosen in App Lab. |
| Gestures fire while you steer | Record more `idle` data while steering normally. You can also raise **Gesture confidence**. |
| Two browsers both react to the wheel | Only one screen drives the wheel at a time. Press **Use the wheel on this screen** on the *Train your motion controller* screen. |

---

## 3. The Modulino wheel (motion controller + Edge Impulse)

### 3.1 Hardware

| Part | Role |
|---|---|
| Arduino UNO Q | Game server (Linux side) and gesture classifier (MCU side) |
| **Modulino Movement** (LSM6DSOX) | Accelerometer and gyroscope. Its data steers the kart and feeds the Edge Impulse model |
| **Modulino Buttons** | A / B / C buttons with LEDs: Start, Grand Prix and LAN in the main menu. In a race, A (held) drifts, B uses the item and C pauses |
| **Modulino Pixels** | 8 RGB LEDs used as rev and shift lights. They show the kart speed, plus colours for boosts, drift sparks and the finish |

Chain the three Modulinos with Qwiic cables into the UNO Q's Qwiic connector, then mount everything on a wheel (a 3D-printed or cardboard disc works) and power the board over USB-C. Mount the board in any orientation: the calibration finds the steering axis. Every Modulino is optional and hot-pluggable.

When the app runs, the LED matrix shows the race display. When a gesture is recognised, the matrix flashes its icon and the Pixels flash its colour.

### 3.2 Create the Edge Impulse project

1. Create a free project at [studio.edgeimpulse.com](https://studio.edgeimpulse.com).
2. Copy its API key from **Dashboard → Keys**. It starts with `ei_`.
3. Open **Create impulse** and set up a [continuous motion recognition](https://docs.edgeimpulse.com/docs/continuous-motion-recognition) impulse:
   - **Time series data**: window size **1000 ms**, window increase **250 ms**. The frequency (**62.5 Hz**) is detected from your data.
   - **Processing block**: *Spectral Analysis*, using all 6 axes.
   - **Learning block**: *Classification*.
   - Save the impulse.

You can do step 3 after uploading your first samples. The Motion Lab warns you if the impulse is missing or doesn't match the board's sample rate.

### 3.3 Record, train and test in the Motion Lab

Open **http://my-unoq.local:7000/train.html**, or press **Train your motion controller → Train your gestures** on the game's main menu.

1. **Edge Impulse project:** paste the API key and press **Connect**. The key goes to the board, which talks to Edge Impulse for you. It is remembered only in this browser, and only if you tick the box.
2. **Record gestures:** pick a label. The default classes are `idle`, `accelerate`, `brake`, `use_item` and `change_camera`, but you can type any label. Choose a length and the dataset (Training, Testing, or Auto 80/20). Then press **Record**, button **A** on the wheel, or **R** on the keyboard. Recording starts after a 3-2-1 countdown, and the sample is uploaded when it finishes (or after you review it, if you choose *Review first*).
   - For each label, repeat the gesture continuously for the whole recording. Aim for at least 1 minute per class, for example six 10 s recordings.
   - Record plenty of **`idle`** while holding the wheel and steering normally, so steering never triggers a gesture.
   - Make the gestures distinct. For example: push the wheel forward to accelerate, pull it towards you to brake, do a quick up-down shake for the item, and give it a short twist out of plane to change the camera.
3. **Train & deploy:** **Train the model** retrains the impulse in Edge Impulse. You can follow each stage live in the job log. Then deploy it in one of the two ways described in [3.4](#34-deploy-the-model-on-the-board).
4. **Test the model:** shows the class probabilities four times per second, the top class, a history of hits and the DSP/NN timing, and which engine computed them. The confidence slider is shared with the game.

### 3.4 Deploy the model on the board

There are two gesture engines. The game uses whichever is ready (the MCU model if the sketch has one, otherwise the brick), or the one you pick under **Gesture engine** in the Motion Lab or on the game's *Train your motion controller* screen.

#### Option A: Motion detection brick (recommended)

The app uses the App Lab `arduino:motion_detection` brick. It runs the Edge Impulse model (`.eim`) in its own container on the Linux side. The Python app streams the Modulino Movement samples to it and gets all class probabilities back, so any classes you trained show up in the game. You swap the model from App Lab, without recompiling the sketch:

1. In Edge Impulse Studio open **Deployment** (the Motion Lab links to it), choose the target **Arduino UNO Q**, press **Build**, then **Go to Arduino**.
2. In Arduino App Lab, open the Ardu Kart app and click the **Motion detection** brick. Under **AI models** press **Download** next to your project's model.
3. In **Brick Configuration**, select that model and press **Save**. Then press **Run** (App Lab restarts the app).

The Motion Lab header and the game's HUD then show the brick's model name and its classes. The brick needs the model to use the accelerometer (and optionally the gyroscope) axes of the Modulino Movement. The app resamples to the model's frequency and converts to m/s² and deg/s.

#### Option B: model compiled into the MCU sketch

**Build & install** in the Motion Lab builds the Arduino library (EON compiler), downloads it and installs it into the app's sketch. **Train + build + install** does everything in one go. You can also install a library `.zip` that you downloaded from Studio (**Deployment → Arduino library**) under *Manual model files*.

The model is compiled into the MCU sketch, so after an install **restart the app**:
```bash
arduino-app-cli app stop user:ardu-kart && arduino-app-cli app start user:ardu-kart
```
(or press Stop and then Run in App Lab). The recompile takes 1–3 minutes. The Motion Lab then shows the model name in its header and the board starts classifying.

You can also install a model from a terminal, on your computer before copying the app or on the board:
```bash
python3 ardu-kart/python/model_installer.py ~/Downloads/my-project-arduino-1.0.0.zip
python3 ardu-kart/python/model_installer.py --remove     # back to no model
```

Without any model the wheel still works. It steers, the buttons work, and the throttle stays down automatically.

### 3.5 Play with the wheel

Open the game and press **Train your motion controller** on the main menu:

- **Calibrate**: hold the wheel straight, then turn it fully right. Two seconds, and it works with any mounting.
- **Re-centre**: sets the current pose as straight ahead.
- **Sensitivity / Deadzone / Invert steering / Tilt to navigate menus.**
- **Gesture confidence**: the probability a class needs before it triggers.
- **Gesture → action**: for every class your model outputs, choose *Accelerate, Brake, Use item, Change camera, Look back, Drift, Pause* or *Nothing*. Sensible defaults are picked from the label names.
- **Gesture engine**: *Auto*, *Motion detection brick* or *MCU model*.
- **Train your gestures** opens the Motion Lab.
- A live dial and live class bars, so you can check everything before racing.

| | Modulino wheel |
|---|---|
| Steer | tilt / turn the wheel |
| Accelerate | `accelerate` gesture: the throttle stays on (cruise) until you brake. Do it on the **1** of the countdown for a rocket start |
| Brake | `brake` gesture: slows the kart to a stop. Do it again at a standstill to reverse |
| Use item | `use_item` gesture or button **B** (it throws backwards if you brake or look back at the same time) |
| Change camera | `change_camera` gesture |
| Drift / hop | hold button **A** |
| Pause | button **C** |
| Menus | A = OK, B = back, C = down; tilt left/right to change options. On the main menu: A Start, B Grand Prix, C LAN |

The HUD in the bottom-left corner shows the wheel angle, the throttle state (CRUISE / COAST / BRAKE), the gesture engine and every class of your model with its confidence in % (the top class is highlighted, the yellow mark is the confidence threshold). Keyboard, gamepad and touch keep working alongside the wheel. With several browsers on the LAN, only one screen drives the wheel. The game takes it automatically when it is free, and the Motion Lab takes it while it is open.

---

## Controls

| | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Accelerate | ↑ / W | A / RT | always on |
| Brake / reverse | ↓ / S | B / LT | BRAKE |
| Steer | ← → / A D | left stick / d-pad | left stick |
| Drift / hop | Space / Shift / K | RB / LB | DRIFT |
| Use item (hold ↓ to throw back) | E / J / X / Ctrl | X | ITEM |
| Look back | Q / L | Y | ⟲ |
| Camera distance | C | | |
| Pause | Esc / P | Start | ❚❚ |

Tips:
- **Rocket start:** press accelerate just as the countdown shows **1**.
- **Drifts:** hold a drift through a corner. Sparks go blue, then orange, then purple, for bigger mini-turbos.
- **Tricks:** press drift when leaving a ramp for a trick boost.

---

## Developer tools (optional)

These live in `devtools/`. You need Node 18+ and Chrome.

```bash
./run_local.sh && Ctrl+C          # once, to create devtools/.venv
devtools/.venv/bin/pip install "python-socketio[client]" requests
devtools/.venv/bin/python devtools/test_server.py   # 120+ checks: protocol, 20-player lobby, wheel, Motion Lab, brick, Edge Impulse (fake API)

cd devtools && npm install        # puppeteer-core, three, esbuild
ARDUKART_PORT=7111 ../run_local.sh & # then:
node game_shot.js basic           # menu screenshots  -> devtools/shots/
node game_shot.js race            # mid-race screenshots
node game_shot.js full            # full 1-lap race to the results screen
node mp_test.js                   # two headless players race each other
node mp_test.js 7111 12           # ... or up to 20 players
# with ARDUKART_SIM_BOARD=1 ARDUKART_DEBUG=1 ARDUKART_PORT=7123 on the server:
node lab_check.js                 # Motion Lab + wheel steering/gestures/calibration in the game
```
`devtools/fake_ei.py` is an offline stand-in for the Edge Impulse API. Run it, then start the server with the `ARDUKART_EI_STUDIO_URL` and `ARDUKART_EI_INGEST_URL` values it prints, and the whole Motion Lab flow (upload, train, build, install) works without an account.

To compile the sketch on your computer (arduino-cli 1.x): `arduino-cli compile --profile default -b arduino:zephyr:unoq ardu-kart/sketch`. On macOS, build from a folder in your home directory, not `/tmp`: `/tmp` is a symlink to `/private/tmp`, which breaks the detection of the local Edge Impulse library (`dir:` entries) and causes link errors.
(The screenshot scripts default to port 7111; pass a port as the last argument to change it.)
