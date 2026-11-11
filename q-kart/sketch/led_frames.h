/*
 * Q-Kart LED matrix renderer.
 *
 * Pure drawing/parsing helpers for the 8 x 13 matrix of the UNO Q
 * (3-bit grayscale, values 0..7). Everything here only depends on
 * `String` and plain integers, so it can also be compiled on a desktop
 * for testing.
 *
 * States (pushed by the Python side through the Bridge "led_state" call):
 *   idle | lobby:<n> | count:<N> | race:<lap>:<laps>:<pos> | finish:<pos>
 *
 * On top of the state, a detected motion gesture briefly shows an icon
 * (renderGesture), picked from the class label by keyword.
 */
#pragma once

#include <stdint.h>

#define LED_ROWS 8
#define LED_COLS 13
#define LED_PIXELS (LED_ROWS * LED_COLS)

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

// Kart, side view, 6 x 4, facing right (values are brightness, 9 = wheel)
static const uint8_t KART_SPRITE[4][6] = {
  {0, 0, 7, 7, 0, 0},   // helmet
  {3, 0, 5, 5, 0, 0},   // spoiler + driver
  {6, 6, 6, 6, 6, 4},   // chassis + nose
  {0, 9, 0, 0, 9, 0},   // wheels
};

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

// Triangle wave between lo and hi with the given period (ms)
static int pulse(unsigned long t, unsigned long period, int lo, int hi) {
  unsigned long p = t % period;
  unsigned long half = period / 2;
  long span = hi - lo;
  long v = (p < half) ? (long)(p * span / half) : (long)((period - p) * span / half);
  return lo + (int)v;
}

// ---------------------------------------------------------------- parsing

enum LedKind { LED_IDLE = 0, LED_LOBBY, LED_COUNT, LED_RACE, LED_FINISH };

struct LedState {
  LedKind kind;
  int a, b, c;   // lobby: a=n | count: a=N | race: a=lap b=laps c=pos | finish: a=pos
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
    st.a = clampInt(fieldInt(s, 0, 1), 0, 9);
  } else if (s.startsWith("count:")) {
    st.kind = LED_COUNT;
    st.a = clampInt(fieldInt(s, 0, 3), 0, 9);
  } else if (s.startsWith("race:")) {
    st.kind = LED_RACE;
    st.b = clampInt(fieldInt(s, 1, 3), 1, 9);
    st.a = clampInt(fieldInt(s, 0, 1), 1, st.b);
    st.c = clampInt(fieldInt(s, 2, 1), 1, 9);
  } else if (s.startsWith("finish:")) {
    st.kind = LED_FINISH;
    st.a = clampInt(fieldInt(s, 0, 1), 1, 9);
  }
  return st;
}

// ---------------------------------------------------------------- scenes

// idle: kart driving left -> right over a scrolling dashed road
static void renderIdle(uint8_t *fb, unsigned long t, bool dim) {
  fbClear(fb);
  int maxV = dim ? 2 : 7;
  // road: dashes scroll towards the left so the kart looks fast
  int roadOff = dim ? 0 : (int)((t / 90) % 4);
  for (int c = 0; c < LED_COLS; c++)
    if (((c + roadOff) % 4) < 2) fbSet(fb, 7, c, dim ? 1 : 2);
  // kart position wraps from fully off-screen left to fully off-screen right
  int span = LED_COLS + 6;
  int x = dim ? 3 : (int)((t / 110) % span) - 6;
  bool wheelPhase = ((t / 120) % 2) == 0;
  for (int r = 0; r < 4; r++)
    for (int c = 0; c < 6; c++) {
      int v = KART_SPRITE[r][c];
      if (v == 9) v = wheelPhase ? 7 : 4;
      if (v > maxV) v = maxV;
      if (v) fbSet(fb, 3 + r, x + c, v);
    }
  // occasional exhaust puff drifting behind the kart
  if (!dim) {
    unsigned long cyc = t % 1500;
    if (cyc < 450) {
      int age = (int)(cyc / 150);         // 0..2
      fbMax(fb, 4 + (age > 1 ? -1 : 0), x - 1 - age, 3 - age);
    }
  }
}

// lobby:n — pulsing player icon + player count + 8 slot dots
static void renderLobby(uint8_t *fb, unsigned long t, int n) {
  fbClear(fb);
  int v = pulse(t, 1400, 2, 7);
  // player icon (3 x 5): head, arms, torso, legs
  static const uint8_t ICON[5] = {2, 0, 7, 2, 5};
  for (int r = 0; r < 5; r++)
    for (int c = 0; c < 3; c++)
      if (ICON[r] & (4 >> c)) fbSet(fb, 1 + r, 2 + c, (r == 0) ? 7 : v);
  // "x" separator
  fbSet(fb, 3, 6, 2);
  fbSet(fb, 4, 6, 2);
  drawDigit3x5(fb, clampInt(n, 0, 9), 1, 8, 7);
  // 8 grid slots on the bottom row, occupied ones bright
  for (int i = 0; i < 8; i++) fbSet(fb, 7, 2 + i, i < n ? 6 : 1);
}

struct LedAnim {
  int lastCount;
  unsigned long countSince;
};
static LedAnim ledAnim = {-1, 0};

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
  // countdown lights on both sides: lit up to N
  for (int i = 0; i < 3; i++) {
    int on = (i < n) ? 6 : 1;
    fbSet(fb, 1 + 2 * i, 1, on);
    fbSet(fb, 1 + 2 * i, 11, on);
  }
}

// race:lap:laps:pos — big position, lap number, lap progress bar, speed lines
static void renderRace(uint8_t *fb, unsigned long t, int lap, int laps, int pos) {
  fbClear(fb);
  drawGlyph5x7(fb, clampInt(pos, 0, 9), 0, 0, 7);
  // "L" + lap digit at the top right
  for (int r = 0; r < 5; r++) fbSet(fb, r, 6, 3);
  fbSet(fb, 4, 7, 3);
  drawDigit3x5(fb, clampInt(lap, 0, 9), 0, 9, 7);
  // speed lines in rows 5-6 of the right block, sweeping right -> left
  unsigned long off = t / 70;
  for (int r = 5; r <= 6; r++)
    for (int c = 6; c < LED_COLS; c++) {
      int k = (int)((c + off + r * 3) % 6);
      if (k == 0) fbSet(fb, r, c, 3);
      else if (k == 1) fbSet(fb, r, c, 1);
    }
  // lap progress bar on the bottom row, one segment per lap
  bool finalLap = lap >= laps;
  bool blinkOn = ((t / 250) % 2) == 0;
  for (int c = 0; c < LED_COLS; c++) {
    int seg = c * laps / LED_COLS;
    bool gap = laps > 1 && laps <= 6 && ((c + 1) * laps / LED_COLS) != seg && c != LED_COLS - 1;
    if (gap) continue;
    int v;
    if (seg < lap - 1) v = 6;                     // completed laps
    else if (seg == lap - 1) v = finalLap ? (blinkOn ? 7 : 1) : pulse(t, 800, 2, 5);
    else v = 1;                                   // laps to go
    fbSet(fb, 7, c, v);
  }
}

// finish:pos — waving checkered flag, position digit flashes every 2 s
static void renderFinish(uint8_t *fb, unsigned long t, int pos) {
  fbClear(fb);
  static const int WAVE[4] = {0, 1, 1, 0};
  int frame = (int)((t / 180) % 4);
  for (int r = 0; r < LED_ROWS; r++) fbSet(fb, r, 0, 4);   // pole
  for (int c = 1; c < LED_COLS; c++) {
    int s = WAVE[(c / 2 + frame) % 4];
    for (int r = 0; r < LED_ROWS; r++) {
      int rr = r - s;
      if (rr < 0 || rr > 6) continue;              // flag is 7 rows tall, shifts with the wave
      bool dark = (((c - 1) / 2) + (rr / 2)) % 2;
      fbSet(fb, r, c, dark ? 1 : 7);
    }
  }
  if ((t % 2000) < 700) {
    fbFillRect(fb, 0, 3, 8, 7, 0);
    drawGlyph5x7(fb, clampInt(pos, 0, 9), 0, 4, 7);
  }
}

static void renderLedState(uint8_t *fb, const LedState &st, unsigned long t) {
  if (st.kind != LED_COUNT) ledAnim.lastCount = -1;
  switch (st.kind) {
    case LED_LOBBY: renderLobby(fb, t, st.a); break;
    case LED_COUNT: renderCount(fb, t, st.a); break;
    case LED_RACE: renderRace(fb, t, st.a, st.b, st.c); break;
    case LED_FINISH: renderFinish(fb, t, st.a); break;
    default: renderIdle(fb, t, false); break;
  }
}

// ---------------------------------------------------------------- gestures

enum GestureIcon { GI_NONE = 0, GI_ACCEL, GI_BRAKE, GI_ITEM, GI_CAMERA, GI_BACK, GI_DRIFT, GI_OTHER };

// 13 x 8 icons, '#' = lit
static const char *const GESTURE_ICONS[7][8] = {
  {  // accelerate: double chevron up
    "......#......", ".....###.....", "....##.##....", "...##...##...",
    "......#......", ".....###.....", "....##.##....", "...##...##..."},
  {  // brake: stop sign
    "....#####....", "...#.....#...", "..#.......#..", "..#.#####.#..",
    "..#.#####.#..", "..#.......#..", "...#.....#...", "....#####...."},
  {  // item: mystery box
    "..#########..", "..#..###..#..", "..#.#...#.#..", "..#....#..#..",
    "..#...#...#..", "..#.......#..", "..#...#...#..", "..#########.."},
  {  // camera
    ".....###.....", ".###########.", ".#...###...#.", ".#..#...#..#.",
    ".#..#...#..#.", ".#...###...#.", ".###########.", "............."},
  {  // look back: double chevron left
    ".....#.....#.", "....#.....#..", "...#.....#...", "..#.....#....",
    "..#.....#....", "...#.....#...", "....#.....#..", ".....#.....#."},
  {  // drift: zig-zag
    ".............", "#.....#.....#", ".#...#.#...#.", "..#.#...#.#..",
    "...#.....#...", ".............", "#############", "............."},
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
         labelHas(l, "background") || labelHas(l, "still");
}

static GestureIcon gestureIconFor(const String &label) {
  String l = label;
  l.toLowerCase();
  if (isIdleLabel(label)) return GI_NONE;
  if (labelHas(l, "brake") || labelHas(l, "stop") || labelHas(l, "slow")) return GI_BRAKE;
  if (labelHas(l, "acc") || labelHas(l, "gas") || labelHas(l, "go") || labelHas(l, "forward") || labelHas(l, "throttle")) return GI_ACCEL;
  if (labelHas(l, "item") || labelHas(l, "throw") || labelHas(l, "fire") || labelHas(l, "shoot") || labelHas(l, "punch")) return GI_ITEM;
  if (labelHas(l, "cam") || labelHas(l, "view")) return GI_CAMERA;
  if (labelHas(l, "back") || labelHas(l, "look") || labelHas(l, "behind") || labelHas(l, "rear")) return GI_BACK;
  if (labelHas(l, "drift") || labelHas(l, "hop") || labelHas(l, "jump")) return GI_DRIFT;
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
  if (icon == GI_ACCEL) shiftRow = -(int)((age / 120) % 2);         // chevrons nudge up
  if (icon == GI_BACK) shiftCol = -(int)((age / 120) % 2);          // ...or left
  const char *const *rows = GESTURE_ICONS[icon - 1];
  for (int r = 0; r < LED_ROWS; r++)
    for (int c = 0; c < LED_COLS; c++)
      if (rows[r][c] == '#') fbSet(fb, r + shiftRow, c + shiftCol, v);
  if (icon == GI_OTHER) drawDigit3x5(fb, clampInt(classIndex, 0, 9), 2, 5, v);
}
