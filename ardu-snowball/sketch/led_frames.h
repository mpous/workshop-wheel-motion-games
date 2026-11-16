/*
 * Ardu Snowball LED matrix renderer.
 *
 * Pure drawing/parsing helpers for the 8 x 13 matrix of the UNO Q
 * (3-bit grayscale, values 0..7). Everything here only depends on
 * `String` and plain integers, so it can also be compiled on a desktop
 * for testing (devtools/sketch_test/snow_render_test.cpp).
 *
 * States (pushed by the Python side through the Bridge "led_state" call):
 *   idle | lobby:<n> | count:<N>
 *   play:<secsLeft>:<ammo>:<flags>:<myScore>:<theirScore>:<snow%>
 *   finish:<myScore>:<theirScore>:<result>      result: 0 loss, 1 win, 2 draw
 *   flags: 1 carrying the star, 2 frozen, 4 our star is stolen, 8 snow in hands
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
#define MAX_AMMO 3

#define FLAG_STAR 1
#define FLAG_FROZEN 2
#define FLAG_STOLEN 4
#define FLAG_SNOW 8

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

static int clampInt(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Triangle wave between lo and hi with the given period (ms)
static int pulse(unsigned long t, unsigned long period, int lo, int hi) {
  unsigned long p = t % period;
  unsigned long half = period / 2;
  long span = hi - lo;
  long v = (p < half) ? (long)(p * span / half) : (long)((period - p) * span / half);
  return lo + (int)v;
}

// Small sprites, one byte per row, bit 4 = left column (5 wide)
static const uint8_t STAR5[5] = {0x04, 0x1F, 0x0E, 0x0E, 0x11};
static const uint8_t FLAKE5[5] = {0x15, 0x0E, 0x1F, 0x0E, 0x15};
static const uint8_t TROPHY[6] = {0x1F, 0x1F, 0x0E, 0x04, 0x04, 0x0E};

static void drawSprite5(uint8_t *fb, const uint8_t *rows, int h, int row, int col, int v) {
  for (int r = 0; r < h; r++)
    for (int c = 0; c < 5; c++)
      if (rows[r] & (0x10 >> c)) fbSet(fb, row + r, col + c, v);
}

// 2 x 2 snowball (rounded with dim corners)
static void drawBall(uint8_t *fb, int row, int col, int v) {
  fbSet(fb, row, col, v);
  fbSet(fb, row, col + 1, v);
  fbSet(fb, row + 1, col, v);
  fbSet(fb, row + 1, col + 1, v);
}

// Cheap deterministic hash for the snowfall
static unsigned hash32(unsigned x) {
  x ^= x >> 16;
  x *= 0x7feb352dU;
  x ^= x >> 15;
  x *= 0x846ca68bU;
  x ^= x >> 16;
  return x;
}

// ---------------------------------------------------------------- parsing

enum LedKind { LED_IDLE = 0, LED_LOBBY, LED_COUNT, LED_PLAY, LED_FINISH };
enum MatchResult { RES_LOSS = 0, RES_WIN, RES_DRAW };

struct LedState {
  LedKind kind;
  int a, b, c, d, e, f;
  // lobby: a=n | count: a=N
  // play: a=secs b=ammo c=flags d=my e=their f=snow% | finish: a=my b=their c=result
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

static LedState parseLedState(const String &s) {
  LedState st = {LED_IDLE, 0, 0, 0, 0, 0, 0};
  if (s.startsWith("lobby:")) {
    st.kind = LED_LOBBY;
    st.a = clampInt(fieldInt(s, 0, 1), 0, 8);
  } else if (s.startsWith("count:")) {
    st.kind = LED_COUNT;
    st.a = clampInt(fieldInt(s, 0, 3), 0, 9);
  } else if (s.startsWith("play:")) {
    st.kind = LED_PLAY;
    st.a = clampInt(fieldInt(s, 0, MATCH_SECONDS), 0, MATCH_SECONDS);
    st.b = clampInt(fieldInt(s, 1, 0), 0, MAX_AMMO);
    st.c = clampInt(fieldInt(s, 2, 0), 0, 15);
    st.d = clampInt(fieldInt(s, 3, 0), 0, 99);
    st.e = clampInt(fieldInt(s, 4, 0), 0, 99);
    st.f = clampInt(fieldInt(s, 5, 0), 0, 100);
  } else if (s.startsWith("finish:")) {
    st.kind = LED_FINISH;
    st.a = clampInt(fieldInt(s, 0, 0), 0, 99);
    st.b = clampInt(fieldInt(s, 1, 0), 0, 99);
    st.c = clampInt(fieldInt(s, 2, RES_DRAW), RES_LOSS, RES_DRAW);
  }
  return st;
}

// ---------------------------------------------------------------- scenes

// idle: snow falling on a snowball pile, a star twinkling on top
static void renderIdle(uint8_t *fb, unsigned long t, bool dim) {
  fbClear(fb);
  int ground = dim ? 1 : 3;
  for (int c = 0; c < LED_COLS; c++) fbSet(fb, 7, c, ground);
  if (dim) {
    drawSprite5(fb, FLAKE5, 5, 1, 4, 2);
    return;
  }
  // pile of three snowballs bottom-right
  drawBall(fb, 5, 8, 5);
  drawBall(fb, 5, 10, 5);
  drawBall(fb, 3, 9, 6);
  fbSet(fb, 2, 9, pulse(t, 900, 2, 7));
  fbSet(fb, 2, 10, pulse(t + 450, 900, 2, 7));
  // flakes: 6 columns, each one falls at its own speed and phase
  for (int i = 0; i < 6; i++) {
    unsigned h = hash32(i * 977 + 13);
    int col = (int)(h % 8);
    unsigned long period = 900 + (h >> 8) % 700;
    unsigned long ph = (t + (h >> 4) % period) % period;
    int row = (int)(ph * 8 / period);
    int drift = ((t / 500 + i) % 3 == 0) ? 1 : 0;
    fbMax(fb, row, col + drift, row < 6 ? 4 + (i % 3) : 2);
  }
}

// lobby:n — pulsing star + player count + slot dots (up to 8 players)
static void renderLobby(uint8_t *fb, unsigned long t, int n) {
  fbClear(fb);
  drawSprite5(fb, STAR5, 5, 1, 0, pulse(t, 1400, 2, 7));
  n = clampInt(n, 0, 8);
  fbSet(fb, 3, 6, 2);   // "x" separator
  drawNumber3x5(fb, n, 1, 9, 7);
  for (int i = 0; i < 8; i++) {
    int col = 1 + i + (i >= 4 ? 3 : 0);   // two teams of four dots
    fbSet(fb, 7, col, i < n ? 6 : 1);
  }
}

struct LedAnim {
  int lastCount;
  unsigned long countSince;
  int lastFlags;
  unsigned long flagsSince;
  int lastScore;
  unsigned long scoreSince;
};
static LedAnim ledAnim = {-1, 0, -1, 0, -1, 0};

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

// frozen: ice crystal growing from the corners with a big flake in the middle
static void renderFrozen(uint8_t *fb, unsigned long t, unsigned long age) {
  fbClear(fb);
  int grow = clampInt((int)(age / 60), 0, 6);
  for (int i = 0; i <= grow; i++) {
    fbSet(fb, 0, i, 3);
    fbSet(fb, i, 0, 3);
    fbSet(fb, 7, LED_COLS - 1 - i, 3);
    fbSet(fb, 7 - i, LED_COLS - 1, 3);
  }
  drawSprite5(fb, FLAKE5, 5, 1, 4, pulse(t, 700, 3, 7));
  int sp = (int)((t / 70) % 40);   // glint
  if (sp < LED_COLS) fbMax(fb, 6, sp, 6);
}

// play — score my:their (3x5 digits), ammo balls on the right, snow bar, time bar
static void renderPlay(uint8_t *fb, unsigned long t, const LedState &st) {
  int secs = st.a, ammo = st.b, flags = st.c, my = st.d, their = st.e, snow = st.f;
  if (flags != ledAnim.lastFlags) {
    if ((flags & FLAG_FROZEN) && !(ledAnim.lastFlags >= 0 && (ledAnim.lastFlags & FLAG_FROZEN))) ledAnim.flagsSince = t;
    ledAnim.lastFlags = flags;
  }
  int score = my * 100 + their;
  if (score != ledAnim.lastScore) {
    if (ledAnim.lastScore >= 0) ledAnim.scoreSince = t;
    else ledAnim.scoreSince = t - 10000;
    ledAnim.lastScore = score;
  }
  if (flags & FLAG_FROZEN) { renderFrozen(fb, t, t - ledAnim.flagsSince); return; }
  fbClear(fb);
  bool scored = t - ledAnim.scoreSince < 1500;
  if ((flags & FLAG_STAR) && ((t / 400) % 2) == 0 && !scored) {
    // carrying the enemy star: star icon alternates with the score
    drawSprite5(fb, STAR5, 5, 0, 2, 7);
    int sp = (int)((t / 60) % 6);
    fbSet(fb, sp < 3 ? 0 : 4, sp < 3 ? sp : 9 - sp, 3);
  } else {
    int v = scored ? pulse(t, 240, 3, 7) : 7;
    drawDigit3x5(fb, clampInt(my, 0, 9), 0, 0, v);
    fbSet(fb, 2, 4, 3);
    fbSet(fb, 2, 5, 3);
    drawDigit3x5(fb, clampInt(their, 0, 9), 0, 6, v > 4 ? 4 : v);   // theirs dimmer
  }
  // ammo: up to three 2x2 balls in a column at the right edge (rows 0..1, 2..3 overlap-free)
  for (int i = 0; i < MAX_AMMO; i++) {
    int row = 4 - i * 2;   // bottom first: rows 4, 2, 0
    if (i < ammo) {
      fbSet(fb, row, 11, 7);
      fbSet(fb, row, 12, 6);
    } else {
      fbSet(fb, row, 11, 1);
    }
  }
  // row 5: alarm when our star is stolen
  if (flags & FLAG_STOLEN) {
    bool on = ((t / 150) % 2) == 0;
    for (int c = 0; c < LED_COLS; c += 2) fbSet(fb, 5, c + (on ? 0 : 1), 4);
  }
  // row 6: snow in the hands (packing progress)
  int lit = (clampInt(snow, 0, 100) * LED_COLS + 50) / 100;
  if ((flags & FLAG_SNOW) && lit == 0) lit = 1;
  for (int c = 0; c < lit; c++) fbSet(fb, 6, c, 3);
  // row 7: time left; blinks in the last 10 seconds
  int tl = (secs * LED_COLS + MATCH_SECONDS - 1) / MATCH_SECONDS;
  bool on = secs > 10 || ((t / 250) % 2) == 0;
  for (int c = 0; c < LED_COLS; c++) fbSet(fb, 7, c, c < tl ? (on ? 6 : 1) : 0);
}

// finish — win: trophy + score; loss: snowflake; draw: "=" ; final score flashes every 2 s
static void renderFinish(uint8_t *fb, unsigned long t, int my, int their, int result) {
  fbClear(fb);
  if ((t % 2400) >= 1600) {
    drawDigit3x5(fb, clampInt(my, 0, 9), 1, 1, 7);
    fbSet(fb, 3, 5, 4);
    fbSet(fb, 3, 6, 4);
    fbSet(fb, 3, 7, 4);
    drawDigit3x5(fb, clampInt(their, 0, 9), 1, 9, 5);
    return;
  }
  int v = pulse(t, 900, 4, 7);
  if (result == RES_WIN) {
    for (int r = 0; r < 6; r++)
      for (int c = 0; c < 5; c++)
        if (TROPHY[r] & (0x10 >> c)) fbSet(fb, 1 + r, 4 + c, v);
    int sp = (int)((t / 80) % 26);                    // sparkle running along the top row
    if (sp < LED_COLS) fbSet(fb, 0, sp, 5);
    if (sp >= 13 && sp - 13 < LED_COLS) fbSet(fb, 7, LED_COLS - 1 - (sp - 13), 5);
  } else if (result == RES_DRAW) {
    fbFillRect(fb, 2, 3, 1, 7, v);
    fbFillRect(fb, 5, 3, 1, 7, v);
  } else {
    drawSprite5(fb, FLAKE5, 5, 1, 4, v);
    for (int c = 0; c < LED_COLS; c++) fbSet(fb, 7, c, 2);
  }
}

static void renderLedState(uint8_t *fb, const LedState &st, unsigned long t) {
  if (st.kind != LED_COUNT) ledAnim.lastCount = -1;
  if (st.kind != LED_PLAY) { ledAnim.lastFlags = -1; ledAnim.lastScore = -1; }
  switch (st.kind) {
    case LED_LOBBY: renderLobby(fb, t, st.a); break;
    case LED_COUNT: renderCount(fb, t, st.a); break;
    case LED_PLAY: renderPlay(fb, t, st); break;
    case LED_FINISH: renderFinish(fb, t, st.a, st.b, st.c); break;
    default: renderIdle(fb, t, false); break;
  }
}

// ---------------------------------------------------------------- gestures

enum GestureIcon { GI_NONE = 0, GI_SCOOP, GI_PACK, GI_THROW, GI_RUN, GI_OTHER };

// 13 x 8 icons, '#' = lit
static const char *const GESTURE_ICONS[5][8] = {
  {  // scoop: hand scooping snow off the ground
    ".............", ".............", "#...........#", ".#.........#.",
    "..##.....##..", "....#####....", ".............", "#############"},
  {  // pack: two hands pressing a ball
    ".............", "##.........##", ".##..###..##.", "..#.#####.#..",
    "..#.#####.#..", ".##..###..##.", "##.........##", "............."},
  {  // throw: ball flying with a trail
    ".............", ".........##..", "........####.", "...-....####.",
    ".--..-...##..", "--...........", ".............", "............."},
  {  // run: speed lines
    ".............", "#####........", "......######.", "##...........",
    "....#########", "#............", "...######....", "............."},
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
  if (labelHas(l, "scoop") || labelHas(l, "dig") || labelHas(l, "grab") || labelHas(l, "recull") || labelHas(l, "recoll") || labelHas(l, "recog") || labelHas(l, "pala")) return GI_SCOOP;
  if (labelHas(l, "pack") || labelHas(l, "press") || labelHas(l, "squeez") || labelHas(l, "compact") || labelHas(l, "prem") || labelHas(l, "apret")) return GI_PACK;
  if (labelHas(l, "throw") || labelHas(l, "launch") || labelHas(l, "shoot") || labelHas(l, "llan") || labelHas(l, "lanz") || labelHas(l, "tir")) return GI_THROW;
  if (labelHas(l, "run") || labelHas(l, "sprint") || labelHas(l, "dash") || labelHas(l, "corr")) return GI_RUN;
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
  if (icon == GI_THROW) shiftCol = (int)((age / 100) % 3) - 1;          // ball flies right
  if (icon == GI_RUN) shiftCol = -(int)((age / 80) % 3);                // lines rush past
  if (icon == GI_SCOOP) shiftRow = -(int)((age / 160) % 2);             // hand lifts the snow
  const char *const *rows = GESTURE_ICONS[icon - 1];
  for (int r = 0; r < LED_ROWS; r++)
    for (int c = 0; c < LED_COLS; c++) {
      char ch = rows[r][c];
      if (ch == '#') fbSet(fb, r + shiftRow, c + shiftCol, v);
      else if (ch == '-') fbSet(fb, r + shiftRow, c + shiftCol, v > 3 ? 3 : v);   // dim trail
    }
  if (icon == GI_PACK) {   // squeeze: hands close in on the ball
    if ((age / 120) % 2) { fbSet(fb, 3, 3, v); fbSet(fb, 4, 3, v); fbSet(fb, 3, 9, v); fbSet(fb, 4, 9, v); }
  }
  if (icon == GI_OTHER) drawDigit3x5(fb, clampInt(classIndex, 0, 9), 2, 5, v);
}
