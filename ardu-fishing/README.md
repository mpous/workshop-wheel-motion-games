# Ardu Fishing: a 3D fishing tournament served by the Arduino UNO Q

Ardu Fishing is a 3-minute fishing match on a mountain lake. Watch the water for signs of fish (ripples, bubbles, jumps, dark shadows and the odd golden shimmer), aim your rod at one, cast close to it, fight the fish without snapping the line, and unhook it. Whoever lands the most fish wins; ties go to total weight. There are 7 species, from a common Perch to the legendary Golden Koi.

It uses exactly the same hardware as [Ardu Kart](../ardu-kart/README.md): an Arduino UNO Q with a **Modulino Movement**, a **Modulino Buttons** and a **Modulino Pixels**. Mount them on a stick and you have a rod:

- The **gyroscope aims the cast**: turn the rod left or right to sweep across the lake. The fish finder at the bottom of the screen shows where the signs are.
- An **Edge Impulse model** recognises three gestures, each with its own class: **`cast`** throws the line (a cleaner gesture lands closer to the fish), **`reel`** pulls the hooked fish in, and **`unhook`** takes it off the hook. A fourth class, **`idle`**, covers everything else.
- During the fight the fish runs: **tilt the rod against the run** to tire it, and ease off when the line tension gets too high.

The model runs either in the App Lab **Motion detection brick** on the Linux side or on the MCU, as in Ardu Kart. You can train it from the game: **Train your motion controller → Train your gestures** opens the Motion Lab (`/train.html`), where you record the gestures straight into your Edge Impulse project, train, deploy and test.

**Tournament between boards.** Every player fishes on their own UNO Q. One board hosts: the other players open **Tournament** on their own board and type the host's IP address. The host's board runs the lobby, gives everyone the same fish at the same moment, starts the match in sync on every board and keeps a live scoreboard that you see in the top-right corner while you fish.

```
ardu-fishing/
├── app.yaml        ← app metadata, uses the arduino:web_ui and arduino:motion_detection bricks
├── python/         ← main.py: tournament host, records, LED state
│                      controller.py: Modulino rod, Motion Lab, Edge Impulse API
│                      brick_engine.py: gesture inference with the Motion detection brick
│                      model_installer.py: installs an EI Arduino library into the sketch
├── sketch/         ← sketch.ino: LED matrix, Modulinos, on-device EI inference (MCU)
└── assets/         ← the game (index.html) and the Motion Lab (train.html)
```

---

## 1. Run it on the Arduino UNO Q

You'll need a UNO Q that has finished its first-time setup in Arduino App Lab, with Wi-Fi configured, and your computer on the same network. The examples use the board name `my-unoq`; you can use its IP address instead.

```bash
# from the root of this repository
scp -r ardu-fishing arduino@my-unoq.local:/home/arduino/ArduinoApps/
ssh arduino@my-unoq.local "arduino-app-cli app start user:ardu-fishing"
```

Or open **My Apps → Ardu Fishing** in the Arduino App Lab desktop app and press **Run**. The first start compiles and flashes the sketch, which can take up to a minute. Only one app runs on a board at a time, so this stops Ardu Kart if it was running.

Then open **http://my-unoq.local:7000** on any computer, tablet or phone on the same network.

To stop it, or to update it after you change the code:

```bash
ssh arduino@my-unoq.local "arduino-app-cli app stop user:ardu-fishing"
scp -r ardu-fishing arduino@my-unoq.local:/home/arduino/ArduinoApps/
ssh arduino@my-unoq.local "arduino-app-cli app stop user:ardu-fishing; arduino-app-cli app start user:ardu-fishing"
```

Then hard-refresh the browser (Ctrl/Cmd + Shift + R).

## 2. Play a tournament

1. Every player starts Ardu Fishing on their own UNO Q and opens it in a browser.
2. The host picks **Tournament → Host on this board**. The lobby shows the board's IP address.
3. Everyone else picks **Tournament**, types that IP address under **Join another board** and presses **Join**. Recent hosts are remembered.
4. Players press **Ready**. The host presses **Start match**, and every board counts down together.
5. When the 3 minutes are up, every board shows the same results table. **Back to lobby** keeps the group together for a rematch.

Up to 20 anglers fit in a lobby; the live board in the match shows the top 8. Each player's rod stays connected to their own board; only the scores travel to the host. If a player leaves mid-match they are marked *left* on the board. In a tournament the pause menu does not stop the clock.

**Solo match** is the same 3 minutes on your own. The best matches and the biggest fish are saved on the board and shown under **Records**.

## 3. Train the gestures

The Edge Impulse setup is the same for every game (see [Train your gestures with Edge Impulse](../README.md#5-train-your-gestures-with-edge-impulse) in the main README), with these classes:

| Class | Gesture idea |
|---|---|
| `idle` | Holding the rod and turning it to aim, without casting. Record plenty of it |
| `cast` | A quick overhead flick forward |
| `reel` | Small circles with the wrist, like turning a reel handle |
| `unhook` | A short sideways shake or twist |

1. Open the Motion Lab: **Train your motion controller → Train your gestures**, or **http://my-unoq.local:7000/train.html**.
2. Connect your Edge Impulse project with its API key, then record about 1 minute per class.
3. Train the model, then deploy it with the **Motion detection brick** (Studio → Deployment → Arduino UNO Q, then download and select the model in the brick's configuration in App Lab) or as an **MCU model** (**Build & install**, then restart the app).
4. Back in the game, **Train your motion controller** shows the live class bars, and lets you calibrate the rod, change the sensitivity and confidence, and map each class to *Cast*, *Reel*, *Unhook*, *Pause* or *Nothing*. Defaults are picked from the label names, so a class named `throw` also casts.

Without a model the rod still works: the gyroscope aims, and the buttons cast, reel and unhook.

## 4. Controls

| | Modulino rod | Keyboard | Gamepad | Touch |
|---|---|---|---|---|
| Aim | turn the rod (gyroscope) | ← → / A D | stick | aim pad |
| Cast | `cast` gesture or button **A** | Space / Enter | Ⓐ | CAST |
| Reel | `reel` gesture or hold button **B** | hold S / ↓ | Ⓧ / RT | REEL |
| Fight a run | tilt the rod against it | ← → | stick | aim pad |
| Unhook | `unhook` gesture or button **C** | W / ↑ | Ⓨ | UNHOOK |
| Pause | a gesture mapped to *Pause* | Esc | Start | ❚❚ |

The buttons cast at a fixed strength, which you can change under **Settings → Button cast strength**. The bottom-left HUD shows the rod's aim, the gyroscope rate and every class with its confidence; the class the game is waiting for glows.

**On the board:**
- The **buttons' LEDs** light the button that does something right now.
- The **Pixels** show the aim position, flash on a bite, turn into a line-tension bar during the fight (green to red), fill up while you unhook, and celebrate a catch.
- The **LED matrix** shows the lobby count, the countdown, the time left and your fish count during a match, and your place at the end.

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| **Join** says the board can't be reached | Check the host's IP address (shown in its lobby) and that both boards are on the same network. Some guest or office Wi-Fi networks block traffic between devices. |
| The rod aims the wrong way or drifts | **Train your motion controller → Calibrate**, or **Re-centre** while pointing at the middle of the lake. |
| The HUD says *Rod on another screen* | Another tab has the rod. Press **Use the rod here** or close the other tab. |
| Gestures fire while you aim | Record more `idle` data while turning the rod, or raise **Gesture confidence**. |
| The line keeps snapping | Stop reeling when the tension bar turns red, and tilt the rod against the fish when it runs. |

The [shared troubleshooting table](../README.md#troubleshooting) in the main README covers the board, the brick, model installs and the Modulinos.

## Developer tools

```bash
# run the server locally with a simulated rod (from devtools/; run ../run_local.sh once first to create the .venv)
ARDUKART_SIM_BOARD=1 ARDUFISH_DEBUG=1 ARDUFISH_PORT=7311 ./run_fishing.sh
# then open http://localhost:7311, or run the headless checks:
node fish_shot.js menus 7311        # screenshots of every menu
node fish_shot.js play 7311         # an autopilot plays a solo match
node aim_check.mjs                  # the rod's aim filter, held and turned in different ways
# two players in one tournament (start the server with ARDUFISH_MATCH_MS=40000 for a short match)
node fish_tourney.js 7311
```
