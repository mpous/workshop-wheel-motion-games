// Renders each Ardu Fishing LED state to ASCII and checks parsing edge cases.
//   c++ -std=c++17 -o fish_render_test fish_render_test.cpp && ./fish_render_test
#include <cstdio>
#include <cassert>
#include "arduino_shim.h"
#include "../../ardu-fishing/sketch/led_frames.h"

static const char SHADE[] = " .:-=+*#";  // 0..7

static void show(const char *title, const uint8_t *fb) {
  printf("%s\n  +-------------+\n", title);
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

static void dump(const char *state, unsigned long t) {
  uint8_t fb[LED_PIXELS];
  renderLedState(fb, parseLedState(String(state)), t);
  char title[64];
  snprintf(title, sizeof title, "[%s] t=%lu", state, t);
  show(title, fb);
}

int main() {
  LedState s;
  s = parseLedState("fish:120:7:3"); assert(s.kind == LED_FISH && s.a == 120 && s.b == 7 && s.c == PH_FIGHT);
  s = parseLedState("fish:999:150:9"); assert(s.a == MATCH_SECONDS && s.b == 99 && s.c == PH_CAUGHT);
  s = parseLedState("fish:"); assert(s.kind == LED_FISH && s.a == MATCH_SECONDS && s.b == 0 && s.c == PH_AIM);
  s = parseLedState("finish:12:3"); assert(s.kind == LED_FINISH && s.a == 12 && s.b == 3);
  s = parseLedState("finish:4"); assert(s.b == 0);
  s = parseLedState("count:0"); assert(s.kind == LED_COUNT && s.a == 0);
  s = parseLedState("lobby:25"); assert(s.a == 20);
  s = parseLedState("garbage"); assert(s.kind == LED_IDLE);

  assert(gestureIconFor("cast") == GI_CAST);
  assert(gestureIconFor("Llancar") == GI_CAST);
  assert(gestureIconFor("reel") == GI_REEL);
  assert(gestureIconFor("arrossegar") == GI_REEL);
  assert(gestureIconFor("unhook") == GI_UNHOOK);
  assert(gestureIconFor("treure") == GI_UNHOOK);
  assert(gestureIconFor("idle") == GI_NONE);
  assert(gestureIconFor("wave") == GI_OTHER);

  dump("idle", 700);
  dump("lobby:4", 300);
  dump("count:3", 100);
  dump("count:0", 100);
  dump("fish:180:0:0", 500);
  dump("fish:95:3:1", 800);
  dump("fish:95:3:2", 90);
  dump("fish:60:12:3", 400);
  dump("fish:8:12:4", 100);
  dump("fish:40:13:5", 200);
  dump("finish:13:0", 800);
  dump("finish:13:2", 100);
  const GestureIcon icons[] = {GI_CAST, GI_REEL, GI_UNHOOK, GI_OTHER};
  for (GestureIcon g : icons) {
    uint8_t fb[LED_PIXELS];
    renderGesture(fb, g, 4, 0);
    show("gesture", fb);
  }
  printf("all fishing LED tests passed\n");
  return 0;
}
