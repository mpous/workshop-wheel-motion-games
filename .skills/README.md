# Skills for building motion games on the Arduino UNO Q

These skills teach an AI coding assistant (or a developer) how the games in this repo are built, so you can extend them or make a new one: Ardu Kart, Ardu Fishing and Ardu Snowball all run on an Arduino UNO Q with a Modulino Movement, Buttons and Pixels, and use Edge Impulse gesture models.

Each skill is a folder with a `SKILL.md` (and sometimes `references/`), in the skills format that Claude Code uses.

| Skill | Use it when you… |
|---|---|
| [`unoq-motion-game`](unoq-motion-game/SKILL.md) | want to understand how a game is put together (sketch, Python, browser, multiplayer) or start a new game from an existing one |
| [`modulino-imu-aim`](modulino-imu-aim/SKILL.md) | work on steering or aiming with the gyroscope and accelerometer: filters, calibration, drift |
| [`edge-impulse-motion-gestures`](edge-impulse-motion-gestures/SKILL.md) | design gesture classes, record and train them in the Motion Lab, deploy to the brick or the MCU, and map classes to game actions |
| [`motion-game-devtools`](motion-game-devtools/SKILL.md) | run a game locally with the simulated board, run the headless tests, or deploy and debug on a real board |
| [`arduino-unoq-applab`](arduino-unoq-applab/SKILL.md) | need the general UNO Q and App Lab reference: app layout, bricks, Bridge, CLI, Edge Impulse deployment |

## Use them with Claude Code

Claude Code loads project skills from `.claude/skills/`. From the root of the repo:

```bash
mkdir -p .claude && ln -s ../.skills .claude/skills    # this project only
# or, for every project on your machine:
cp -R .skills/* ~/.claude/skills/
```

Then ask for what you need ("add a new gesture to Ardu Fishing", "start a new game where the Modulino is a tennis racket") and Claude picks the matching skill, or call one directly with `/unoq-motion-game`.

Other assistants can read the `SKILL.md` files directly: point them at this folder.

## Keep them up to date

The skills quote real file names, functions and messages. When you change the architecture, a message name or a tool in `devtools/`, update the skill that mentions it in the same pull request.
