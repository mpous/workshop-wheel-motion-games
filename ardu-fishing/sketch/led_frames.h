/*
 * Ardu Fishing LED matrix renderer.
 *
 * Pure drawing/parsing helpers for the 8 x 13 matrix of the UNO Q
 * (3-bit grayscale, values 0..7). Everything here only depends on
 * `String` and plain integers, so it can also be compiled on a desktop
 * for testing (devtools/sketch_test).
 *
 * States (pushed by the Python side through the Bridge "led_state" call):
 *   idle | lobby:<n> | count:<N> | fish:<secsLeft>:<fish>:<phase> | finish:<fish>:<place>
 *   phase: 0 aim, 1 waiting, 2 bite, 3 fight, 4 unhook, 5 caught
 *
 * On top of the state, a detected motion gesture briefly shows an icon
 * (renderGesture), picked from the class label by keyword.
 */
#pragma once

#include <stdint.h>

#define LED_ROWS 8
#define LED_COLS 13
#define LED_PIXELS (LED_ROWS * LED_COLS)
#define MATCH_SECONDS 180

// ---------------------------------------------------------------- fonts

// 3x5 digits, one byte per row, bit 2 = left column
static const uint8_t FONT3x5[10][5] = {
  {7, 5, 5, 5, 7}, {2, 6, 2, 2, 7}, {7, 1, 7, 4, 7}, {7, 1, 3, 1, 7}, {5, 5, 7, 1, 1},
  {7, 4, 7, 1, 7}, {7, 4, 7, 5, 7}, {7, 1, 2, 2, 2}, {7, 5, 7, 5, 7}, {7, 5, 7, 1, 7},
};

// 5x7 glyphs, one byte per row, bit 4 = left column. 0-9, then G (10), O (11)
static const uint8_t FONT5x7[12][7] = {
  {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E},  // 0
  {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},  // 1
  {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F},  // 2
  {0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E},  // 3
  {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02},  // 4
  {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},  // 5
  {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E},  // 6
  {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},  // 7
  {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E},  // 8
  {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},  // 9
  {0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F},  // G
  {0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},  // O
};
#define GLYPH_G 10
#define GLYPH_O 11

// ---------------------------------------------------------------- frame helpers

static inline void fbClear(uint8_t *fb) {
  for (int i = 0; i < LED_PIXELS; i++) fb[i] = 0;
}

static inline void fbSet(uint8_t *fb, int row, int col, int v) {
  if (row < 0 || row >= LED_ROWS || col < 0 || col >= LED_COLS) return;
  if (v < 0) v = 0;
  if (v > 7) v = 7;
  fb[row * LED_COLS + col] = (uint8_t)v;
}

static inline void fbMax(uint8_t *fb, int row, int col, int v) {
  if (row < 0 || row >= LED_ROWS || col < 0 || col >= LED_COLS) return;
  if (v > fb[row * LED_COLS + col]) fbSet(fb, row, col, v);
}

static void fbFillRect(uint8_t *fb, int row, int col, int h, int w, int v) {
  for (int r = row; r < row + h; r++)
    for (int c = col; c < col + w; c++) fbSet(fb, r, c, v);
}

static void drawDigit3x5(uint8_t *fb, int digit, int row, int col, int v) {
  if (digit < 0 || digit > 9) return;
  for (int r = 0; r < 5; r++)
    for (int c = 0; c < 3; c++)
      if (FONT3x5[digit][r] & (4 >> c)) fbSet(fb, row + r, col + c, v);
}

static void drawGlyph5x7(uint8_t *fb, int glyph, int row, int col, int v) {
  if (glyph < 0 || glyph > 11) return;
  for (int r = 0; r < 7; r++)
    for (int c = 0; c < 5; c++)
      if (FONT5x7[glyph][r] & (0x10 >> c)) fbSet(fb, row + r, col + c, v);
}

// 0..99 as one or two 3x5 digits, right-aligned so the last digit sits at col
static void drawNumber3x5(uint8_t *fb, int n, int row, int col, int v) {
  if (n >= 10) drawDigit3x5(fb, (n / 10) % 10, row, col - 4, v);
  drawDigit3x5(fb, n % 10, row, col, v);
}

// Triangle wave between lo and hi with the given period (ms)
static int pulse(unsigned long t, unsigned long period, int lo, int hi) {
  unsigned long p = t % period;
  unsigned long half = period / 2;
  long span = hi - lo;
  long v = (p < half) ? (long)(p * span / half) : (long)((period - p) * span / half);
  return lo + (int)v;
}

// Fish, side view, 5 x 4, facing left (values are brightness)
static const uint8_t FISH_SPRITE[4][5] = {
  {0, 6, 6, 0, 5},
  {6, 0, 7, 6, 0},
  {6, 7, 7, 6, 0},
  {0, 6, 6, 0, 5},
};

// Trophy, 5 x 6
static const uint8_t TROPHY[6] = {0x1F, 0x1F, 0x0E, 0x04, 0x04, 0x0E};

static void drawFish(uint8_t *fb, int row, int col, int maxV) {
  for (int r = 0; r < 4; r++)
    for (int c = 0; c < 5; c++) {
      int v = FISH_SPRITE[r][c];
      if (v > maxV) v = maxV;
      if (v) fbSet(fb, row + r, col + c, v);
    }
}

// ---------------------------------------------------------------- parsing

enum LedKind { LED_IDLE = 0, LED_LOBBY, LED_COUNT, LED_FISH, LED_FINISH };
enum FishPhase { PH_AIM = 0, PH_WAIT, PH_BITE, PH_FIGHT, PH_UNHOOK, PH_CAUGHT };

struct LedState {
  LedKind kind;
  int a, b, c;   // lobby: a=n | count: a=N | fish: a=secs b=fish c=phase | finish: a=fish b=place
};

static int fieldInt(const String &s, int index, int fallback) {
  // returns the index-th ':'-separated field after the state name as int
  int start = s.indexOf(':');
  for (int i = 0; i < index && start >= 0; i++) start = s.indexOf(':', start + 1);
  if (start < 0) return fallback;
  int end = s.indexOf(':', start + 1);
  String part = (end < 0) ? s.substring(start + 1) : s.substring(start + 1, end);
  if (part.length() == 0) return fallback;
  return part.toInt();
}

static int clampInt(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

static LedState parseLedState(const String &s) {
  LedState st = {LED_IDLE, 0, 0, 0};
  if (s.startsWith("lobby:")) {
    st.kind = LED_LOBBY;
    st.a = clampInt(fieldInt(s, 0, 1), 0, 20);
  } else if (s.startsWith("count:")) {
    st.kind = LED_COUNT;
    st.a = clampInt(fieldInt(s, 0, 3), 0, 9);
  } else if (s.startsWith("fish:")) {
    st.kind = LED_FISH;
    st.a = clampInt(fieldInt(s, 0, MATCH_SECONDS), 0, MATCH_SECONDS);
    st.b = clampInt(fieldInt(s, 1, 0), 0, 99);
    st.c = clampInt(fieldInt(s, 2, 0), PH_AIM, PH_CAUGHT);
  } else if (s.startsWith("finish:")) {
    st.kind = LED_FINISH;
    st.a = clampInt(fieldInt(s, 0, 0), 0, 99);
    st.b = clampInt(fieldInt(s, 1, 0), 0, 20);   // 0 = solo game
  }
  return st;
}

// ---------------------------------------------------------------- scenes

// idle: a fish swims right -> left under a rolling wave line, bubbles rise
static void renderIdle(uint8_t *fb, unsigned long t, bool dim) {
  fbClear(fb);
  int maxV = dim ? 2 : 7;
  static const int WAVE[6] = {0, 0, 1, 1, 1, 0};
  int off = dim ? 0 : (int)((t / 160) % 6);
  for (int c = 0; c < LED_COLS; c++) fbSet(fb, 1 - WAVE[(c + off) % 6] + 1, c, dim ? 1 : 3);
  int span = LED_COLS + 5;
  int x = dim ? 4 : LED_COLS - (int)((t / 140) % (span + 5));
  int bob = dim ? 0 : (int)((t / 400) % 2);
  drawFish(fb, 3 + bob, x, maxV);
  if (!dim) {
    unsigned long cyc = t % 1800;
    if (cyc < 900) {
      int age = (int)(cyc / 300);         // 0..2, bubble rises from the mouth
      fbMax(fb, 3 + bob - age, x - 1, 4 - age);
    }
  }
}

// lobby:n — pulsing angler icon + player count (up to 20) + slot dots
static void renderLobby(uint8_t *fb, unsigned long t, int n) {
  fbClear(fb);
  int v = pulse(t, 1400, 2, 7);
  static const uint8_t ICON[5] = {2, 0, 7, 2, 5};
  for (int r = 0; r < 5; r++)
    for (int c = 0; c < 3; c++)
      if (ICON[r] & (4 >> c)) fbSet(fb, 1 + r, 2 + c, (r == 0) ? 7 : v);
  n = clampInt(n, 0, 20);
  if (n < 10) {   // "x" separator
    fbSet(fb, 3, 6, 2);
    fbSet(fb, 4, 6, 2);
  }
  drawNumber3x5(fb, n, 1, 10, 7);
  for (int i = 0; i < 10; i++) fbSet(fb, 7, 1 + i, n >= 2 * i + 2 ? 6 : (n == 2 * i + 1 ? 3 : 1));
}

struct LedAnim {
  int lastCount;
  unsigned long countSince;
  int lastPhase;
  unsigned long phaseSince;
};
static LedAnim ledAnim = {-1, 0, -1, 0};

// count:N — big digit with a brightness pulse on every change; 0 => flashing GO
static void renderCount(uint8_t *fb, unsigned long t, int n) {
  fbClear(fb);
  if (n != ledAnim.lastCount) {
    ledAnim.lastCount = n;
    ledAnim.countSince = t;
  }
  unsigned long age = t - ledAnim.countSince;
  if (n <= 0) {
    int v = ((t / 120) % 2) ? 7 : 2;
    drawGlyph5x7(fb, GLYPH_G, 0, 1, v);
    drawGlyph5x7(fb, GLYPH_O, 0, 7, v);
    for (int c = 0; c < LED_COLS; c++) fbSet(fb, 7, c, ((c + t / 60) % 2) ? v : 0);
    return;
  }
  int v = 7 - (int)((age % 1000) * 5 / 1000);   // 7 -> 3 each second
  drawGlyph5x7(fb, clampInt(n, 0, 9), 0, 4, v);
  for (int i = 0; i < 3; i++) {
    int on = (i < n) ? 6 : 1;
    fbSet(fb, 1 + 2 * i, 1, on);
    fbSet(fb, 1 + 2 * i, 11, on);
  }
}

// big flashing "!" for a bite
static void renderBite(uint8_t *fb, unsigned long t) {
  fbClear(fb);
  int v = ((t / 90) % 2) ? 7 : 3;
  fbFillRect(fb, 0, 5, 5, 3, v);
  fbFillRect(fb, 6, 5, 2, 3, v);
  for (int r = 0; r < LED_ROWS; r += 2) {          // splash marks on both sides
    fbSet(fb, r + (int)((t / 90) % 2), 1, 3);
    fbSet(fb, r + (int)((t / 90) % 2), 11, 3);
  }
}

// fish:secs:fish:phase — fish icon + catch count, phase strip, time-left bar
static void renderFish(uint8_t *fb, unsigned long t, int secs, int fish, int phase) {
  if (phase != ledAnim.lastPhase) {
    ledAnim.lastPhase = phase;
    ledAnim.phaseSince = t;
  }
  if (phase == PH_BITE) { renderBite(fb, t); return; }
  fbClear(fb);
  unsigned long age = t - ledAnim.phaseSince;
  bool caught = phase == PH_CAUGHT;
  drawFish(fb, 1, 0, caught ? (((t / 110) % 2) ? 7 : 2) : 6);
  drawNumber3x5(fb, fish, 0, 10, caught && age < 1500 ? pulse(t, 300, 3, 7) : 7);
  // phase strip on row 6
  switch (phase) {
    case PH_AIM: {                                   // sweeping aim dot
      int p = (int)((t / 120) % 24);
      fbSet(fb, 6, p < 12 ? p : 24 - p, 4);
      break;
    }
    case PH_WAIT: {                                  // bobber on the water
      int bob = pulse(t, 1600, 0, 2);
      for (int c = 0; c < LED_COLS; c++) fbSet(fb, 6, c, 1);
      fbSet(fb, 6 - (bob > 1 ? 1 : 0), 6, 7);
      break;
    }
    case PH_FIGHT: {                                 // reel spinning: fast chase
      int k = (int)((t / 50) % 4);
      for (int c = 0; c < LED_COLS; c++) if ((c + k) % 4 == 0) fbSet(fb, 6, c, 6);
      break;
    }
    case PH_UNHOOK: {                                // pulsing dots
      int v = pulse(t, 500, 1, 7);
      for (int c = 1; c < LED_COLS; c += 3) fbSet(fb, 6, c, v);
      break;
    }
    default: break;
  }
  // time left on the bottom row; blinks in the last 10 seconds
  int lit = (secs * LED_COLS + MATCH_SECONDS - 1) / MATCH_SECONDS;
  bool hurry = secs <= 10;
  bool on = !hurry || ((t / 250) % 2) == 0;
  for (int c = 0; c < LED_COLS; c++) fbSet(fb, 7, c, c < lit ? (on ? 6 : 1) : 0);
}

// finish:fish:place — trophy + catch count; the place digit flashes every 2 s
static void renderFinish(uint8_t *fb, unsigned long t, int fish, int place) {
  fbClear(fb);
  bool showPlace = place > 0 && (t % 2000) < 700;
  if (showPlace) {
    drawGlyph5x7(fb, clampInt(place, 1, 9), 0, 4, 7);
    if (place >= 10) { fbClear(fb); drawNumber3x5(fb, clampInt(place, 10, 20), 1, 8, 7); }
    return;
  }
  int v = pulse(t, 900, 4, 7);
  for (int r = 0; r < 6; r++)
    for (int c = 0; c < 5; c++)
      if (TROPHY[r] & (0x10 >> c)) fbSet(fb, 1 + r, c, v);
  drawNumber3x5(fb, fish, 1, 10, 7);
  int sp = (int)((t / 80) % 26);                     // sparkle running along the top row
  if (sp < LED_COLS) fbSet(fb, 0, sp, 5);
}

static void renderLedState(uint8_t *fb, const LedState &st, unsigned long t) {
  if (st.kind != LED_COUNT) ledAnim.lastCount = -1;
  if (st.kind != LED_FISH) ledAnim.lastPhase = -1;
  switch (st.kind) {
    case LED_LOBBY: renderLobby(fb, t, st.a); break;
    case LED_COUNT: renderCount(fb, t, st.a); break;
    case LED_FISH: renderFish(fb, t, st.a, st.b, st.c); break;
    case LED_FINISH: renderFinish(fb, t, st.a, st.b); break;
    default: renderIdle(fb, t, false); break;
  }
}

// ---------------------------------------------------------------- gestures

enum GestureIcon { GI_NONE = 0, GI_CAST, GI_REEL, GI_UNHOOK, GI_OTHER };

// 13 x 8 icons, '#' = lit
static const char *const GESTURE_ICONS[4][8] = {
  {  // cast: line flying out in an arc
    ".......####..", ".....##....#.", "....#.......#", "...#.........",
    "..#..........", ".#...........", "#............", "#............"},
  {  // reel: circular arrow
    "....####.....", "..##....##...", ".#........#..", ".#.......###.",
    ".#........#..", "..##.........", "....####.....", "............."},
  {  // unhook: hook
    "......##.....", "......##.....", ".......#.....", ".......#.....",
    ".#.....#.....", ".##....#.....", "..##..##.....", "...####......"},
  {  // other: filled frame (a digit is drawn inside)
    "#############", "#...........#", "#...........#", "#...........#",
    "#...........#", "#...........#", "#...........#", "#############"},
};

static bool labelHas(const String &lower, const char *word) { return lower.indexOf(word) >= 0; }

// Is this the "nothing happening" class? (idle, rest, noise, background...)
static bool isIdleLabel(const String &label) {
  String l = label;
  l.toLowerCase();
  return labelHas(l, "idle") || labelHas(l, "rest") || labelHas(l, "noise") || labelHas(l, "none") ||
         labelHas(l, "background") || labelHas(l, "still") || labelHas(l, "repos");
}

// Same keywords as defaultAction() in assets/js/motion.js
static GestureIcon gestureIconFor(const String &label) {
  String l = label;
  l.toLowerCase();
  if (isIdleLabel(label)) return GI_NONE;
  if (labelHas(l, "unhook") || labelHas(l, "release") || labelHas(l, "treu") || labelHas(l, "ham") || labelHas(l, "free")) return GI_UNHOOK;
  if (labelHas(l, "reel") || labelHas(l, "pull") || labelHas(l, "drag") || labelHas(l, "arross") || labelHas(l, "recull")) return GI_REEL;
  if (labelHas(l, "cast") || labelHas(l, "throw") || labelHas(l, "llan") || labelHas(l, "lanz") || labelHas(l, "tir")) return GI_CAST;
  return GI_OTHER;
}

// Draws the icon for a gesture detected `age` ms ago (fades out over ~700 ms).
// `classIndex` is shown as a digit for labels without a dedicated icon.
static void renderGesture(uint8_t *fb, GestureIcon icon, int classIndex, unsigned long age) {
  if (icon == GI_NONE) return;
  fbClear(fb);
  int v = age < 350 ? 7 : 7 - (int)((age - 350) * 6 / 350);
  if (v < 1) v = 1;
  int shiftRow = 0, shiftCol = 0;
  if (icon == GI_CAST) { shiftCol = (int)((age / 120) % 2); shiftRow = -shiftCol; }   // line flies out
  if (icon == GI_UNHOOK) shiftRow = -(int)((age / 140) % 2);                         // hook lifts
  const char *const *rows = GESTURE_ICONS[icon - 1];
  for (int r = 0; r < LED_ROWS; r++)
    for (int c = 0; c < LED_COLS; c++)
      if (rows[r][c] == '#') fbSet(fb, r + shiftRow, c + shiftCol, v);
  if (icon == GI_OTHER) drawDigit3x5(fb, clampInt(classIndex, 0, 9), 2, 5, v);
}
