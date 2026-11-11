// Renders each LED state to ASCII and checks parsing edge cases.
#include <cstdio>
#include <cassert>
#include "arduino_shim.h"
#include "../../ardu-kart/sketch/led_frames.h"

static const char SHADE[] = " .:-=+*#";  // 0..7

static void dump(const char *title, const char *state, unsigned long t, bool dim = false) {
  uint8_t fb[LED_PIXELS];
  LedState st = parseLedState(String(state));
  if (dim) renderIdle(fb, t, true); else renderLedState(fb, st, t);
  printf("%s  [%s] t=%lu\n", title, state, t);
  printf("  +-------------+\n");
  for (int r = 0; r < LED_ROWS; r++) {
    printf("  |");
    for (int c = 0; c < LED_COLS; c++) {
      int v = fb[r * LED_COLS + c];
      assert(v >= 0 && v <= 7);
      putchar(SHADE[v]);
    }
    printf("|\n");
  }
  printf("  +-------------+\n");
}

int main() {
  // parsing
  LedState s;
  s = parseLedState("race:2:3:4"); assert(s.kind == LED_RACE && s.a == 2 && s.b == 3 && s.c == 4);
  s = parseLedState("race:7:3:12"); assert(s.a == 3 && s.b == 3 && s.c == 12);
  s = parseLedState("race:1:3:42"); assert(s.c == 20);
  s = parseLedState("lobby:25"); assert(s.a == 20);
  s = parseLedState("finish:17"); assert(s.a == 17);
  s = parseLedState("race:"); assert(s.kind == LED_RACE && s.a == 1 && s.b == 3 && s.c == 1);
  s = parseLedState("count:0"); assert(s.kind == LED_COUNT && s.a == 0);
  s = parseLedState("count:x"); assert(s.kind == LED_COUNT && s.a == 0);
  s = parseLedState("lobby:5"); assert(s.kind == LED_LOBBY && s.a == 5);
  s = parseLedState("finish:2"); assert(s.kind == LED_FINISH && s.a == 2);
  s = parseLedState("garbage"); assert(s.kind == LED_IDLE);
  s = parseLedState(""); assert(s.kind == LED_IDLE);
  printf("parse tests: OK\n\n");

  dump("IDLE frame A", "idle", 660);
  dump("IDLE frame B", "idle", 1210);
  dump("BRIDGE FAIL (dim idle)", "idle", 0, true);
  dump("LOBBY 3 (pulse low)", "lobby:3", 0);
  dump("LOBBY 3 (pulse high)", "lobby:3", 700);
  dump("COUNT 3", "count:3", 10000);
  dump("COUNT 2", "count:2", 11000);
  dump("COUNT 1 (decayed)", "count:1", 12000);
  dump("COUNT 1 (decayed)", "count:1", 12800);
  dump("GO (on)", "count:0", 13080);
  dump("GO (off)", "count:0", 13200);
  dump("LOBBY 14", "lobby:14", 700);
  dump("LOBBY 20", "lobby:20", 700);
  dump("RACE P4 lap 2/3", "race:2:3:4", 20000);
  dump("RACE P17 lap 2/3", "race:2:3:17", 20000);
  dump("RACE P4 lap 2/3 (later)", "race:2:3:4", 20210);
  dump("RACE P1 final lap 3/3 (blink on)", "race:3:3:1", 30000);
  dump("RACE P1 final lap 3/3 (blink off)", "race:3:3:1", 30250);
  dump("RACE P2 lap 5/9", "race:5:9:2", 30000);
  dump("FINISH P2 flag frame 0", "finish:2", 41000);
  dump("FINISH P2 flag frame 1", "finish:2", 41180);
  dump("FINISH P2 digit flash", "finish:2", 42100);
  dump("FINISH P12 digit flash", "finish:12", 42100);
  printf("render tests: OK\n");
  return 0;
}
