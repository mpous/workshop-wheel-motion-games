// Renders each Ardu Snowball LED state to ASCII and checks parsing edge cases.
//   c++ -std=c++17 -o snow_render_test snow_render_test.cpp && ./snow_render_test
#include <cstdio>
#include <cassert>
#include "arduino_shim.h"
#include "../../ardu-snowball/sketch/led_frames.h"

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

static int lit(const uint8_t *fb) {
  int n = 0;
  for (int i = 0; i < LED_PIXELS; i++) n += fb[i] > 0;
  return n;
}

static void dump(const char *state, unsigned long t) {
  uint8_t fb[LED_PIXELS];
  renderLedState(fb, parseLedState(String(state)), t);
  char title[96];
  snprintf(title, sizeof title, "[%s] t=%lu", state, t);
  show(title, fb);
  assert(lit(fb) > 0);
}

int main() {
  LedState s;
  s = parseLedState("play:120:2:9:3:1:40");
  assert(s.kind == LED_PLAY && s.a == 120 && s.b == 2 && s.c == 9 && s.d == 3 && s.e == 1 && s.f == 40);
  s = parseLedState("play:999:7:99:150:-4:300");
  assert(s.a == MATCH_SECONDS && s.b == MAX_AMMO && s.c == 15 && s.d == 99 && s.e == 0 && s.f == 100);
  s = parseLedState("play:");
  assert(s.kind == LED_PLAY && s.a == MATCH_SECONDS && s.b == 0 && s.c == 0 && s.f == 0);
  s = parseLedState("play:30:1");   // missing trailing fields
  assert(s.a == 30 && s.b == 1 && s.c == 0 && s.d == 0 && s.e == 0);
  s = parseLedState("finish:3:1:1"); assert(s.kind == LED_FINISH && s.a == 3 && s.b == 1 && s.c == RES_WIN);
  s = parseLedState("finish:2:2"); assert(s.c == RES_DRAW);
  s = parseLedState("finish:0:4:9"); assert(s.c == RES_DRAW);
  s = parseLedState("count:0"); assert(s.kind == LED_COUNT && s.a == 0);
  s = parseLedState("lobby:25"); assert(s.kind == LED_LOBBY && s.a == 8);
  s = parseLedState("fish:1:2:3"); assert(s.kind == LED_IDLE);
  s = parseLedState("garbage"); assert(s.kind == LED_IDLE);

  assert(gestureIconFor("scoop") == GI_SCOOP);
  assert(gestureIconFor("Recollir") == GI_SCOOP);
  assert(gestureIconFor("pack") == GI_PACK);
  assert(gestureIconFor("premer") == GI_PACK);
  assert(gestureIconFor("throw") == GI_THROW);
  assert(gestureIconFor("Llancar") == GI_THROW);
  assert(gestureIconFor("run") == GI_RUN);
  assert(gestureIconFor("correr") == GI_RUN);
  assert(gestureIconFor("idle") == GI_NONE);
  assert(gestureIconFor("wave") == GI_OTHER);

  dump("idle", 700);
  dump("lobby:5", 300);
  dump("count:3", 100);
  dump("count:0", 100);
  dump("play:180:0:0:0:0:0", 500);
  dump("play:150:3:0:1:0:0", 500);
  dump("play:95:1:8:2:1:60", 800);
  dump("play:60:2:1:2:2:0", 100);     // carrying the star (icon phase)
  dump("play:60:2:1:2:2:0", 500);     // carrying the star (score phase)
  dump("play:40:0:2:2:2:0", 400);     // frozen
  dump("play:8:3:4:1:3:0", 100);      // star stolen, hurry
  dump("finish:3:1:1", 800);
  dump("finish:1:3:0", 800);
  dump("finish:2:2:2", 800);
  dump("finish:3:1:1", 2000);
  const GestureIcon icons[] = {GI_SCOOP, GI_PACK, GI_THROW, GI_RUN, GI_OTHER};
  for (GestureIcon g : icons) {
    uint8_t fb[LED_PIXELS];
    renderGesture(fb, g, 4, 0);
    show("gesture", fb);
    assert(lit(fb) > 0);
  }
  printf("all snowball LED tests passed\n");
  return 0;
}
