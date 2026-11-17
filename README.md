# Motion games for the Arduino UNO Q, controlled with Edge Impulse

This repositoy has been built for a workshop during the Talent Arena Upskilling Week in November 2026. The main goal of the workshop is to enable the developers to train their own motion controller using the Arduino UNO Q, modulinos and Edge Impulse. At the end of the workshop they will be able to participate in a fishing tournament using their own custom ML model with continuous motion recognition on the UNO Q with Edge Impulse.

<img width="800" alt="Talent Arena Upskilling Week Workshop: Train your own Motion Controller" src="https://github.com/user-attachments/assets/77aad852-74b9-45b3-bbe5-44cd78d100ca" />

Here you will find three 3D browser games where your hands are the controller. An Arduino UNO Q with three Modulinos becomes a steering wheel, a fishing rod or a snowball-throwing hand:

- **Aiming and steering:** the gyroscope and accelerometer.
- **Actions:** gestures recognised by a motion model that you record and train with [Edge Impulse](https://edgeimp.com/ta-july26), right from the board.

The Arduino UNO Q runs the whole game. Its Linux side serves the game and the training page, and runs the lobby. Its microcontroller reads the Modulinos and drives the LED matrix. Players open the game in any browser on the same Wi-Fi.

---

## 1. What you need

### Hardware 

| Part | Role in the games |
|---|---|
| **Arduino UNO Q** (2 GB or 4 GB) | Game server on the Linux side, sensor reading, LED matrix and optional on-device inference on the MCU |
| **Modulino Movement** (LSM6DSOX) | Accelerometer and gyroscope: aims, steers and feeds the Edge Impulse model |
| **Modulino Buttons** | Three buttons with LEDs: menu navigation, and a fallback for every gesture |
| **Modulino Pixels** | 8 RGB LEDs: shift lights, line tension, ammo, hit flashes |
| Qwiic cables and a USB-C power supply (5 V, 3 A) or power bank | Chain the Modulinos into the UNO Q's Qwiic connector |
| Something to mount it on | A 3D-printed or cardboard wheel, a stick for the rod, or just your hand |

<img width="800" alt="Motion Controller Arduino UNO Q and Modulinos" src="https://github.com/user-attachments/assets/598a3616-28c1-4947-be9c-3ffb6fce72e5" />

**Mounting:**

- Mount the board in any orientation. The calibration finds the axis.
- Every Modulino is optional and hot-pluggable. Without Buttons or a model, the games fall back to sensible defaults, and a keyboard, gamepad or touch screen always works too.
- For the tournaments in Ardu Fishing every player needs their own kit.

If you would like to print or laser cut your own wheel board, Jim shared more details [here](https://github.com/jimbruges/workshop-racing-telemetry-unoq/tree/main/hardware).

### Software

- **Arduino App Lab**, with the UNO Q set up and connected to your Wi-Fi. The board's first-time setup happens in App Lab.
- A free **Edge Impulse** account at [studio.edgeimpulse.com](https://edgeimp.com/ta-july26).
- A recent **Chrome, Edge, Firefox or Safari** on any computer, tablet or phone on the same network as the board.

## 2. Get the code

```bash
git clone https://github.com/mpous/workshop-wheel-motion-games.git
cd workshop-wheel-motion-games
```

Every command below runs from this folder. The examples use the board name `my-unoq`. Use the name shown in App Lab, or the board's IP address.

## 3. Try a game on your computer

The games developed here are three:

| | Game | You are holding | Gesture classes to train | Multiplayer |
|---|---|---|---|---|
| 🏎️ | **[Ardu Kart](ardu-kart/README.md)**: an arcade kart racer with 8 characters, 4 tracks, items, drifts and a Grand Prix | a wheel: tilt to steer | `idle`, `accelerate`, `brake`, `use_item`, `change_camera` | up to 20 browsers on one board |
| 🎣 | **[Ardu Fishing](ardu-fishing/README.md)**: a 3-minute fishing tournament on a mountain lake, with 7 species | a rod: turn to aim the cast | `idle`, `cast`, `reel`, `unhook` | a tournament between UNO Q boards |
| ❄️ | **[Ardu Snowball](ardu-snowball/README.md)**: a 3-minute 3 v 3 capture-the-star snowball fight | your throwing hand: tilt to aim | `idle`, `scoop`, `pack`, `throw`, `run` | 3 v 3 between UNO Q boards, bots fill the gaps |

You don't need a board to look around. The games run against a desktop copy of the App Lab WebUI brick, and a simulated Modulino controller stands in for the real one.

```bash
./run_local.sh             # Ardu Kart on http://localhost:7000
```

The first run creates `devtools/.venv` and installs FastAPI, Socket.IO and uvicorn, which takes about 30 seconds. Then open **http://localhost:7000**, press **Enter** and play with the keyboard. The script also prints a `Same network:` address, so a phone or a second computer can join a multiplayer race. If port 7000 is busy, use `ARDUKART_PORT=8080 ./run_local.sh`. Stop the server with **Ctrl+C**.

The other two games use the same virtual environment, so run `./run_local.sh` once first:

```bash
devtools/run_fishing.sh    # Ardu Fishing on http://localhost:7000
devtools/run_snowball.sh   # Ardu Snowball on http://localhost:7000
```

Running locally, the LED matrix and the Modulinos are not used; the Bridge calls are stubbed out.

## 4. Run a game on the UNO Q

Each game is an Arduino App Lab app. Import them to Arduino App Lab via SSH or directly with Arduino App Lab.

<img width="315" alt="Create new App" src="https://github.com/user-attachments/assets/c45ca959-bbbc-4a15-850c-fb52d1c5863c" />


**Alternatively via SSH**

```bash
scp -r ardu-kart arduino@my-unoq.local:/home/arduino/ArduinoApps/
```

And start it from the terminal:

```bash
ssh arduino@my-unoq.local "arduino-app-cli app start user:ardu-kart"
```

<img width="800" alt="Arduino App Lab with the 3 games" src="https://github.com/user-attachments/assets/cda660bd-f80c-47c2-9939-1e020b933340" />

Open **My Apps** in the App Lab desktop app, select the game and press **Run**.

- The first start downloads the bricks' containers and compiles and flashes the sketch. This can take a few minutes, and later starts take less than a minute.
- Only one app runs on a board at a time, so starting a game stops the one that was running.


## 5. Train your gestures with Edge Impulse

Every game has a **Motion Lab** at `http://my-unoq.local:7000/train.html`. 

Open it from the game's main menu with **Train your motion controller → Train your gestures**. 

It shows the live sensor charts and records gestures straight into your Edge Impulse project. It also trains, deploys and tests the model, all from the browser. The steps are the same for every game; only the classes change (see the [table above](#motion-games-for-the-arduino-uno-q-controlled-with-edge-impulse), or the game's README for gesture ideas).

### 5.1 Create the Edge Impulse project

Use one project per game.

1. Create a project at [studio.edgeimpulse.com](https://edgeimp.com/ta-july26).
2. Copy its API key from **Dashboard → Keys**. It starts with `ei_`.

<img width="800" alt="Create your own API key to ingest data" src="https://github.com/user-attachments/assets/d54ee504-a805-4712-8b2b-bca804601077" />


3. Open **Create impulse** and set up a [continuous motion recognition](https://docs.edgeimpulse.com/docs/continuous-motion-recognition) impulse:
   - **Time series data:** window size **1000 ms**, window increase **250 ms**. The board samples at **62.5 Hz**, and Studio detects the frequency from your data.
   - **Processing block:** *Spectral Analysis*, with all 6 axes (accelerometer and gyroscope).
   - **Learning block:** *Classification*.
   - Save the impulse.

You can set up the impulse after uploading your first samples. The Motion Lab warns you if the impulse is missing or doesn't match the board's sample rate.

<img width="800" alt="Collecting data from the Motion Lab" src="https://github.com/user-attachments/assets/2d0e479c-dd50-4c32-a2eb-2bd7d499a286" />


### 5.2 Record and train in the Motion Lab

1. **Connect:** paste the API key and press **Connect**. The key goes to the board, which talks to Edge Impulse for you. Your browser remembers it only if you tick the box. The three games share the key.
2. **Record:**
   - Pick a label from the game's classes, or type your own.
   - Choose a length, and the dataset: Training, Testing or Auto 80/20.
   - Press **Record**, button **A** on the Modulino, or **R** on the keyboard. Recording starts after a 3-2-1 countdown.
   - The sample uploads when it finishes, or after you review it if you choose *Review first*.
3. **Collect enough data:**
   - Repeat the gesture continuously for the whole recording.
   - Aim for at least 1 minute per class, for example six 10-second recordings.
   - Record plenty of **`idle`** while you aim or steer normally, so aiming never triggers a gesture.
   - Make the gestures clearly different from each other.

<img width="800" alt="Edge Impulse Studio Dataset" src="https://github.com/user-attachments/assets/71b7d7f7-2284-451c-af54-31a044f57918" />

4. **Train:** **Train the model** retrains the impulse in Edge Impulse, and you can follow each stage in the job log.

<img width="800" alt="Create the impulse" src="https://github.com/user-attachments/assets/9448284e-7ae7-479a-8e03-bb5ff7a61c8c" />

<img width="800" alt="Parameters" src="https://github.com/user-attachments/assets/86fb0859-cf67-4802-bcca-3e81f4c163ec" />

<img width="800" alt="Generate Features" src="https://github.com/user-attachments/assets/ff9e2bd5-c3f8-4751-addb-9dac918ad85f" />

<img width="800" alt="Train the ML motion model" src="https://github.com/user-attachments/assets/8cc0dd42-e443-4b5d-bc14-1b529e589e4e" />


5. **Test:** the test panel shows the class probabilities four times a second, the top class, the recent hits, the DSP and NN timing, and which engine computed them. The confidence slider is shared with the game.

<img width="800" alt="Test the model" src="https://github.com/user-attachments/assets/9664ae53-186f-4812-89ff-d12494e5917b" />


### 5.3 Deploy the model to the board

There are two gesture engines. With **Gesture engine → Auto**, the game uses the MCU model if the sketch has one, and otherwise the brick. You can also pick one in the Motion Lab or in the game.

<img width="800" alt="Download and select the Custom ML model" src="https://github.com/user-attachments/assets/718e81e3-b9a5-445e-901b-d6cc6b2a96e6" />

The App Lab `arduino:motion_detection` brick runs the model (`.eim`) in its own container on the Linux side. The Python app streams the Modulino Movement samples to it and gets all the class probabilities back. You can swap models from App Lab without recompiling anything.

1. In Edge Impulse Studio open **Deployment**, choose **Arduino UNO Q**, press **Build**, then **Go to Arduino**.
2. In App Lab, open the game and click the **Motion detection** brick. Under **AI models**, press **Download** next to your project's model.
3. In **Brick Configuration**, select that model, press **Save**, then press **Run**.

The model needs the accelerometer axes, and optionally the gyroscope axes. The app resamples the data to the model's frequency and converts it to m/s² and deg/s.


### 5.4 Map the classes to actions

Back in the game, open **Train your motion controller**. It shows the live class bars and has these settings:

- **Calibrate and Re-centre:** set up the aim or steering.
- **Sensitivity:** how far the aim moves when you tilt.
- **Gesture confidence:** the probability a class needs before it triggers.
- **Gesture → action:** map every class your model outputs to an action in the game. Defaults are picked from the label names, so a class named `throw` also casts in Ardu Fishing.

While you play, the HUD in the bottom-left corner shows every class with its confidence.

<img width="800" alt="HUD in the bottom-left" src="https://github.com/user-attachments/assets/c2acd70c-9dd6-48f0-9f77-bfa952ad4dfb" />


## 6. Play together

- **Ardu Fishing and Ardu Snowball:** every player runs the game on their own UNO Q, so everyone has a Modulino controller.
  1. One player picks **Tournament → Host on this board**. The lobby shows the board's IP address.
  2. Everyone else picks **Tournament** and types that address under **Join another board**.
  3. The host starts the match, and every board counts down together.

All of it stays on your local network, so the games don't need internet. Some guest and office Wi-Fi networks block traffic between devices. If players can't join, use a phone hotspot or your own router.

## 7. Developer tools

`devtools/` has everything to work on the games without a board, plus headless tests:

| Tool | What it does |
|---|---|
| `run_server.sh`, `run_fishing.sh`, `run_snowball.sh` | Run a game's Python server locally against the real WebUI brick (`./run_local.sh` wraps the first one) |
| `stub/` | A stand-in `arduino` package: the Bridge, the bricks and a simulated Modulino controller |
| `fake_ei.py` | An offline Edge Impulse API, so the whole Motion Lab flow (upload, train, build, install) works without an account. Start the server with the `ARDUKART_EI_STUDIO_URL` and `ARDUKART_EI_INGEST_URL` values it prints (`ARDUFISH_` or `ARDUSNOW_` for the other games) |
| `aim_check.mjs` | Checks the aim filter: held still, turned, rolled through a gesture |
| `test_server.py` | 120+ end-to-end checks of the Ardu Kart server, the multiplayer protocol and the Motion Lab |
| `game_shot.js`, `fish_shot.js`, `snowball_shot.js` | Drive a game in headless Chrome and save screenshots to `devtools/shots/` |
| `mp_test.js`, `fish_tourney.js` | Headless multiplayer races and tournaments |
| `lab_check.js`, `board_probe.js` | Check the Motion Lab locally, or inspect a real board |
| `sketch_test/` | Render the LED matrix frames on your computer |

Set them up once:

```bash
./run_local.sh                                       # creates devtools/.venv, then Ctrl+C
devtools/.venv/bin/pip install "python-socketio[client]" requests   # for test_server.py
(cd devtools && npm install)                         # puppeteer-core, three, esbuild
node devtools/aim_check.mjs                          # quick check that everything works
```

The puppeteer scripts expect Google Chrome at its default macOS path. Change `executablePath` in the script on Linux or Windows. Each game's README lists its own test commands: [Kart](ardu-kart/README.md#6-developer-tools), [Fishing](ardu-fishing/README.md#developer-tools) and [Snowball](ardu-snowball/README.md#developer-tools).

**Compile a sketch on your computer** with arduino-cli 1.x:

```bash
arduino-cli compile --profile default -b arduino:zephyr:unoq ardu-kart/sketch
```

On macOS, build from a folder in your home directory, not `/tmp`. `/tmp` is a symlink to `/private/tmp`, which breaks the detection of the local Edge Impulse library and causes link errors.

## 8. Build your own game

[`.skills/`](.skills/README.md) has skills for Claude Code, or any AI coding assistant, that explain how these games are built. Use them to extend a game or to start a new one, like a tennis racket or a magic wand:

| Skill | Covers |
|---|---|
| [`unoq-motion-game`](.skills/unoq-motion-game/SKILL.md) | The architecture (sketch, Bridge, Python, browser), multiplayer, and a checklist for a new game |
| [`modulino-imu-aim`](.skills/modulino-imu-aim/SKILL.md) | Steering and aiming filters, calibration, drift, and the pitfalls |
| [`edge-impulse-motion-gestures`](.skills/edge-impulse-motion-gestures/SKILL.md) | Designing gesture classes, the Motion Lab, deployment, and mapping classes to actions |
| [`motion-game-devtools`](.skills/motion-game-devtools/SKILL.md) | The simulator, the headless tests, and deploying to a board |
| [`arduino-unoq-applab`](.skills/arduino-unoq-applab/SKILL.md) | A general UNO Q and App Lab reference |

To use them with Claude Code, link them into your project:

```bash
mkdir -p .claude && ln -s ../.skills .claude/skills
```

The quickest way to start is to copy the game closest to your idea, rename it in `app.yaml` and the folder name, and change the classes.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `my-unoq.local` doesn't resolve (common on Android and some Windows setups) | Use the board's IP address: `ssh arduino@my-unoq.local hostname -I`, or check your router. |
| The page doesn't load | Check that the app is running (`arduino-app-cli app list`), and that your device is on the same network as the board. |
| Nothing on the LED matrix | The sketch is flashed when the app starts. Check `arduino-app-cli app logs ... --all` for compile errors. |
| The Motion Lab shows "board offline" or no Modulinos | Check the Qwiic cables. The board looks for Modulinos every 2.5 s, so you can plug them in while the app runs. |
| The brick shows "not available" or keeps retrying | Pick a model in App Lab (Motion detection brick → Brick Configuration) and press **Run** again. The first start downloads the brick's container, which can take a few minutes. |
| The MCU model is installed but the board says "no model" | Restart the app: the model is compiled into the sketch at start-up. If it's still missing, the compile failed, so check the logs. |
| The game shows the wrong classes, or gestures do nothing | The board is running another game's model. Pick this game's model in the brick configuration, or check **Gesture engine**: with *Auto*, an MCU model wins over the brick. You can also map the classes by hand under **Gesture → action**. |
| Gestures fire while you aim or steer | Record more `idle` data while aiming normally, or raise **Gesture confidence**. |
| The aim goes the wrong way or drifts | **Train your motion controller → Calibrate**, or **Re-centre**. |
| The HUD says the wheel, rod or controller is *on another screen* | Another tab has it, often an old tab App Lab opened on a previous **Run**. Press **Use the wheel here** (or rod, or controller) in the HUD, or close the other tab. |
| Players can't join a tournament | Check the host's IP address and that both boards are on the same network. Guest Wi-Fi often blocks traffic between devices. |

Each game's README has a few more fixes specific to that game.


## Credits
The initial idea of this workshop is from Jim Bruges, DevRel from Arduino. Thanks for the great workshop. [Find more details here](https://github.com/jimbruges/workshop-racing-telemetry-unoq/).

## Disclaimer

Use responsibly. Do not use this code in production. Have fun!
