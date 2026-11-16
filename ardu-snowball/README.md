# Ardu Snowball: capture the star, served by the Arduino UNO Q

Ardu Snowball is a 3-minute, first-person snowball fight in an alpine arena. Two teams of three each defend a star inside their snow fort.

- **Capture:** grab the enemy star and carry it back to your own fort.
- **Ammo:** scoop snow from the ground (the frozen ponds and the wooden decks have none), pack it into snowballs (up to 3 in hand) and throw them. Snowballs fly in an arc.
- **Hits:** a hit freezes the target in an ice block for a few seconds. They drop the star they were carrying and respawn at their base. Touch your own dropped star to send it home.
- **Winning:** the most captures wins, and ties go to the team with more hits.

It uses the same hardware as Ardu Kart: an Arduino UNO Q with a **Modulino Movement**, a **Modulino Buttons** and a **Modulino Pixels**. Hold the Movement in your throwing hand:

- **Aim:** the **gyroscope aims**. Tilt left / right to turn, and up / down to raise or lower the throw.
- **Gestures:** an **Edge Impulse model** recognises four gestures, each with its own class:
  - **`scoop`** grabs a handful of snow.
  - **`pack`** turns snow into a snowball.
  - **`throw`** throws. The model's confidence sets the power, so a cleaner throw flies further.
  - **`run`** sprints for about 0.6 s per detection, so keep pumping your arm.

  A fifth class, **`idle`**, covers everything else, including aiming. The class-to-action map and the confidence threshold can be changed under **Train your motion controller** in the game.
- **Buttons:** without a model the Modulino buttons work too. **A** throws, **B** runs (hold it) and **C** scoops or packs, whichever makes sense. Their LEDs light the buttons that are useful right now.
- **LED matrix:** shows the countdown, the clock, your snowballs, the stars and the score.
- **Pixels:** show your ammo and snow, a carried star, the freeze timer and hit / capture flashes.

The model runs either in the App Lab **Motion detection brick** on the Linux side or on the MCU, as in Ardu Kart. Train it from the game: **Train your motion controller → Train your gestures** opens the Motion Lab (`/train.html`).

**Two ways to play**
- **Solo 3 v 3:** you and two bots against three bots. Bot skill is set in Settings.
- **Tournament between boards:** every player plays on their own UNO Q.
  - One board hosts. The others open **Tournament** on their own board and type the host's IP address.
  - Everyone picks a team (or AUTO) and toggles READY, then the host presses START. The match starts after a synced countdown on every board.
  - Bots fill the empty slots. The host's browser simulates them, and if the host leaves, another player's browser takes over.
  - Everything stays on your local network: no internet is needed.

```
ardu-snowball/
├── app.yaml        ← app metadata, uses the arduino:web_ui and arduino:motion_detection bricks
├── python/         ← main.py: lobby / match relay, records, LED state (kept light)
│                      controller.py: Modulino controller, Motion Lab, Edge Impulse API
│                      brick_engine.py: gesture inference with the Motion detection brick
│                      model_installer.py: installs an EI Arduino library into the sketch
├── sketch/         ← sketch.ino + led_frames.h: LED matrix, Modulinos, on-device EI inference
└── assets/         ← the game (index.html, three.js) and the Motion Lab (train.html)
```

---

## 1. Run it on the Arduino UNO Q

```bash
# from the root of this repository
scp -r ardu-snowball arduino@my-unoq.local:/home/arduino/ArduinoApps/
ssh arduino@my-unoq.local "arduino-app-cli app start user:ardu-snowball"
```

Or open **My Apps → Ardu Snowball** in the Arduino App Lab desktop app and press **Run**. The first start compiles and flashes the sketch, which can take up to a minute. Only one app runs on a board at a time.

Then open **http://my-unoq.local:7000** on any computer, tablet or phone on the same network.

## 2. Train the gestures

Open **Train your motion controller → Train your gestures** (or `http://my-unoq.local:7000/train.html`).
1. Paste the API key of an Edge Impulse project.
2. Record 10-second samples of `idle`, `scoop`, `pack`, `throw` and `run`. Repeat the gesture for the whole recording, and press Modulino button A to start one.
3. Train the model.
4. Deploy it with option A (Motion detection brick) or option B (model on the MCU), exactly like the Ardu Kart wheel ([main README, section 3](../README.md#3-the-modulino-wheel-motion-controller--edge-impulse)).

The Ardu Kart and Ardu Fishing Motion Labs share the same Edge Impulse key.

## 3. Controls

| | Modulino | Keyboard + mouse | Gamepad | Touch |
|---|---|---|---|---|
| Move | (run gesture / B) | W A S D | left stick | left pad |
| Aim | tilt (gyroscope) | mouse (click the game first) | right stick | drag on the right |
| Throw | `throw` / A | click · Space | A · RT | ❄ |
| Scoop / pack | `scoop` · `pack` / C | F · R, or right-click / C for either | X (LB · Y) | SNOW |
| Run | `run` / hold B | Shift | B · LT | RUN |
| Scoreboard · menu | | Tab · Esc | START | ❚❚ |

## Developer tools

```bash
# run the server locally with a simulated Modulino controller (from devtools/)
ARDUSNOW_PORT=7322 ARDUKART_SIM_BOARD=1 ARDUSNOW_DEBUG=1 ./run_snowball.sh
# then open http://localhost:7322, or run the headless checks (screenshots in devtools/shots/snow_*.png):
node snowball_shot.js all 7322   # menus, solo match, gesture flow via /api/debug/sim, LED states, results
# LED matrix frames, compiled on the computer:
(cd sketch_test && c++ -std=c++17 -o snow_render_test snow_render_test.cpp && ./snow_render_test)
```
`/api/debug/sim?gesture=throw`, `?button=0..2` and `?tilt=0.3` drive the simulated controller, and `/api/debug/led` returns the state shown on the LED matrix.
