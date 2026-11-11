// Ardu Kart — MCU side of the Arduino UNO Q.
//
//  * LED matrix: live race display. Python pushes a compact state string
//    ("idle", "lobby:n", "count:N", "race:lap:laps:pos", "finish:pos").
//  * Modulino Movement: accelerometer + gyroscope streamed to Python at the
//    model's sample rate. The browser uses it for steering and for recording
//    Edge Impulse training data.
//  * Edge Impulse: when a model is installed (model_config.h), continuous
//    motion recognition runs right here on the STM32U585 and the class
//    probabilities are sent to Python. Gestures flash on the matrix and Pixels.
//    Without one (or when the App Lab Motion detection brick is selected)
//    Python sends the brick's gestures back for the same matrix / Pixels effects.
//  * Modulino Buttons: A / B / C edges are forwarded to Python (Start, Grand
//    Prix, LAN in the menus; drift, item, pause while racing).
//  * Modulino Pixels: rev / shift lights driven by the kart speed.
//
// Every Modulino is optional and hot-pluggable: missing ones are retried.

#include <Arduino_RouterBridge.h>
#include <Arduino_LED_Matrix.h>
#include <Arduino_Modulino.h>
#include "led_frames.h"
#include "model_config.h"

#if ARDUKART_HAS_MODEL
#include ARDUKART_EI_HEADER
#define ARDUKART_AXES EI_CLASSIFIER_RAW_SAMPLES_PER_FRAME
#define ARDUKART_WINDOW_VALUES EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE
#define ARDUKART_SAMPLE_US ((unsigned long)(EI_CLASSIFIER_INTERVAL_MS * 1000.0f))
#else
#define ARDUKART_SAMPLE_US 16000UL          // 62.5 Hz, as in the EI continuous motion tutorial
#endif

const unsigned long INFER_STRIDE_MS = 250;   // classify the rolling window 4x per second
const unsigned long FRAME_INTERVAL = 30;     // matrix redraw ~33 fps
const unsigned long PIXEL_INTERVAL = 40;     // Pixels refresh 25 fps
const unsigned long BUTTON_INTERVAL = 15;
const unsigned long PROBE_INTERVAL = 2500;   // retry missing Modulinos
const unsigned long INFO_INTERVAL = 2000;    // hardware heartbeat to Python
const unsigned long LED_STATE_TIMEOUT = 3500;
const unsigned long REV_TIMEOUT = 1200;
const float GRAVITY = 9.80665f;
const float GESTURE_CONFIDENCE = 0.7f;       // local effects only; the game uses its own threshold

Arduino_LED_Matrix matrix;
ModulinoMovement movement;
ModulinoButtons buttons;
ModulinoPixels pixels;

bool hasMovement = false, hasButtons = false, hasPixels = false;
uint8_t frame[LED_PIXELS];

// --- state pushed from Python (provide_safe: handlers run in the loop thread)
LedState ledState = {LED_IDLE, 0, 0, 0};
unsigned long ledStateAt = 0;
int revSpeed = 0, revFlags = 0;               // speed 0..120 (% of top speed), flags see onRev()
unsigned long revAt = 0;
int buttonLeds = 0b111;
bool buttonLedsDirty = true;

// --- gesture display
GestureIcon gestureIcon = GI_NONE;
int gestureClass = -1;
unsigned long gestureAt = 0;
int topClass = -1;
float topConfidence = 0;
bool mcuGestures = true;    // false while Python uses the App Lab Motion detection brick instead

unsigned long nextSampleUs = 0, lastFrame = 0, lastPixels = 0, lastButtons = 0, lastProbe = 0, lastInfo = 0;
bool prevPressed[3] = {false, false, false};

static const uint8_t CLASS_RGB[8][3] = {
  {0, 200, 190}, {40, 230, 40}, {255, 40, 30}, {255, 200, 0},
  {40, 120, 255}, {190, 60, 255}, {255, 120, 0}, {255, 255, 255},
};

// ------------------------------------------------------------------ gesture display

static void showGesture(int cls, const String &label, float confidence) {
  topClass = cls;
  topConfidence = confidence;
  bool fresh = cls != gestureClass || millis() - gestureAt > 900;
  if (confidence >= GESTURE_CONFIDENCE && !isIdleLabel(label) && fresh) {
    gestureIcon = gestureIconFor(label);
    gestureClass = cls;
    gestureAt = millis();
  } else if (isIdleLabel(label)) {
    gestureClass = -1;
  }
}

// ------------------------------------------------------------------ Bridge handlers

void onLedState(String s) {
  s.trim();
  ledState = parseLedState(s);
  ledStateAt = millis();
}

// flags: bit0 racing, bit1 boost, bits2-3 drift spark level, bit4 finished
void onRev(int speed, int flags) {
  revSpeed = clampInt(speed, 0, 150);
  revFlags = flags;
  revAt = millis();
}

// Gesture recognised by the Motion detection brick on the Linux side.
void onGesture(int cls, String label, int pct) {
  showGesture(cls, label, pct / 100.0f);
}

// 1: this sketch's model drives the game, 0: the brick does (sent with every heartbeat)
void onEngine(int mcu) {
  bool on = mcu != 0;
  if (on != mcuGestures) { gestureClass = -1; topClass = -1; }
  mcuGestures = on;
}

void onButtonLeds(int mask) {
  if (mask != buttonLeds) buttonLedsDirty = true;
  buttonLeds = mask;
}

// ------------------------------------------------------------------ Edge Impulse

#if ARDUKART_HAS_MODEL
static float imuWindow[ARDUKART_WINDOW_VALUES];
static int axisSource[ARDUKART_AXES];            // model axis -> index in {ax,ay,az,gx,gy,gz}
static size_t windowSamples = 0;
static unsigned long lastInfer = 0;

// Map the impulse axes ("accX + accY + accZ", "gyrZ"...) onto our six channels.
static void buildAxisMap() {
  for (int i = 0; i < ARDUKART_AXES; i++) axisSource[i] = i % 6;
#ifdef EI_CLASSIFIER_FUSION_AXES_STRING
  String axes = EI_CLASSIFIER_FUSION_AXES_STRING;
  int idx = 0, start = 0;
  while (idx < ARDUKART_AXES && start <= (int)axes.length()) {
    int end = axes.indexOf('+', start);
    if (end < 0) end = axes.length();
    String name = axes.substring(start, end);
    name.trim();
    name.toLowerCase();
    if (name.length()) {
      int base = (name.indexOf("gy") >= 0) ? 3 : 0;
      char last = name.charAt(name.length() - 1);
      int comp = last == 'y' ? 1 : (last == 'z' ? 2 : 0);
      axisSource[idx++] = base + comp;
    }
    start = end + 1;
  }
#endif
}

static int classifySignal(size_t offset, size_t length, float *out) {
  memcpy(out, imuWindow + offset, length * sizeof(float));
  return 0;
}

static void runModel() {
  signal_t signal;
  signal.total_length = ARDUKART_WINDOW_VALUES;
  signal.get_data = &classifySignal;
  ei_impulse_result_t result;
  memset(&result, 0, sizeof(result));
  if (run_classifier(&signal, &result, false) != EI_IMPULSE_OK) return;

  String probs;
  int best = 0;
  for (size_t i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++) {
    float v = result.classification[i].value;
    if (v > result.classification[best].value) best = i;
    if (i) probs += ',';
    probs += String(v, 3);
  }
  Bridge.notify("ml", probs, (int)result.timing.dsp, (int)result.timing.classification);

  if (mcuGestures) showGesture(best, ei_classifier_inferencing_categories[best], result.classification[best].value);
}

static void pushModelSample(const float *v) {
  if (windowSamples * ARDUKART_AXES >= ARDUKART_WINDOW_VALUES) {
    memmove(imuWindow, imuWindow + ARDUKART_AXES, (ARDUKART_WINDOW_VALUES - ARDUKART_AXES) * sizeof(float));
    windowSamples--;
  }
  float *dst = imuWindow + windowSamples * ARDUKART_AXES;
  for (int i = 0; i < ARDUKART_AXES; i++) dst[i] = v[axisSource[i]];
  windowSamples++;
  unsigned long now = millis();
  if (windowSamples * ARDUKART_AXES >= ARDUKART_WINDOW_VALUES && now - lastInfer >= INFER_STRIDE_MS) {
    lastInfer = now;
    runModel();
  }
}
#endif

// ------------------------------------------------------------------ hardware

static void probeModulinos() {
  if (!hasMovement) hasMovement = movement.begin();
  if (!hasButtons) { hasButtons = buttons.begin(); buttonLedsDirty = hasButtons; }
  if (!hasPixels) { hasPixels = pixels.begin(); if (hasPixels) { pixels.clear(); pixels.show(); } }
}

static void sendInfo() {
  String s = "v=2;mv=";
  s += hasMovement ? '1' : '0';
  s += ";bt=";
  s += hasButtons ? '1' : '0';
  s += ";px=";
  s += hasPixels ? '1' : '0';
  s += ";interval=";
  s += String(ARDUKART_SAMPLE_US / 1000.0f, 2);
#if ARDUKART_HAS_MODEL
  s += ";model=1;name=";
  s += EI_CLASSIFIER_PROJECT_NAME;
  s += ";project=";
  s += EI_CLASSIFIER_PROJECT_ID;
  s += ";deploy=";
  s += EI_CLASSIFIER_PROJECT_DEPLOY_VERSION;
  s += ";window=";
  s += (int)(EI_CLASSIFIER_RAW_SAMPLE_COUNT * EI_CLASSIFIER_INTERVAL_MS);
  s += ";axes=";
#ifdef EI_CLASSIFIER_FUSION_AXES_STRING
  s += EI_CLASSIFIER_FUSION_AXES_STRING;
#else
  s += ARDUKART_AXES;
#endif
  s += ";labels=";
  for (size_t i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++) {
    if (i) s += '|';
    s += ei_classifier_inferencing_categories[i];
  }
#else
  s += ";model=0";
#endif
  Bridge.notify("hw", s);
}

static void sampleImu() {
  if (!hasMovement) return;
  if (movement.update() != 1) return;
  float v[6] = {movement.getX(), movement.getY(), movement.getZ(),
                movement.getRoll(), movement.getPitch(), movement.getYaw()};
  // g and deg/s on the wire; Python converts acceleration to m/s^2 for Edge Impulse
  Bridge.notify("imu", v[0], v[1], v[2], v[3], v[4], v[5]);
#if ARDUKART_HAS_MODEL
  float m[6] = {v[0] * GRAVITY, v[1] * GRAVITY, v[2] * GRAVITY, v[3], v[4], v[5]};
  pushModelSample(m);
#endif
}

static void pollButtons() {
  if (!hasButtons) return;
  if (buttonLedsDirty) {
    buttons.setLeds(buttonLeds & 1, buttonLeds & 2, buttonLeds & 4);
    buttonLedsDirty = false;
  }
  if (!buttons.update()) return;
  for (int i = 0; i < 3; i++) {
    bool p = buttons.isPressed(i) == HIGH;
    if (p != prevPressed[i]) {
      prevPressed[i] = p;
      Bridge.notify("btn", i, p);
    }
  }
}

static void setPixel(int i, int r, int g, int b, int bright) {
  pixels.set(i, (uint8_t)clampInt(r, 0, 255), (uint8_t)clampInt(g, 0, 255), (uint8_t)clampInt(b, 0, 255), (uint8_t)bright);
}

// Rev / shift lights, gesture flashes, idle scanner.
static void renderPixels(unsigned long now) {
  if (!hasPixels) return;
  bool racing = (now - revAt < REV_TIMEOUT) && (revFlags & 1);
  unsigned long gAge = now - gestureAt;

  if (gestureClass >= 0 && gAge < 260) {
    const uint8_t *c = CLASS_RGB[gestureClass % 8];
    int b = gAge < 120 ? 25 : 12;
    for (int i = 0; i < 8; i++) setPixel(i, c[0], c[1], c[2], b);
  } else if (racing) {
    bool boost = revFlags & 2;
    int drift = (revFlags >> 2) & 3;
    if (revSpeed >= 97 && ((now / 70) % 2) == 0 && !boost) {
      for (int i = 0; i < 8; i++) setPixel(i, 30, 80, 255, 20);           // shift light
    } else {
      int lit = (revSpeed * 8 + 50) / 100;
      for (int i = 0; i < 8; i++) {
        if (boost) {
          int k = (int)((i + now / 45) % 4);
          setPixel(i, k ? 160 : 255, k ? 40 : 200, 255, k ? 8 : 22);       // purple chase
        } else if (i < lit) {
          if (i < 4) setPixel(i, 20, 220, 40, 10);
          else if (i < 6) setPixel(i, 255, 180, 0, 12);
          else setPixel(i, 255, 20, 20, 14);
        } else {
          setPixel(i, 0, 0, 0, 0);
        }
      }
      if (drift) {
        static const uint8_t DRIFT_RGB[4][3] = {{0, 0, 0}, {40, 140, 255}, {255, 130, 0}, {200, 60, 255}};
        setPixel(0, DRIFT_RGB[drift][0], DRIFT_RGB[drift][1], DRIFT_RGB[drift][2], 18);
        setPixel(7, DRIFT_RGB[drift][0], DRIFT_RGB[drift][1], DRIFT_RGB[drift][2], 18);
      }
    }
  } else if (topClass >= 0 && topConfidence > 0.3f && gestureClass >= 0) {
    // model running, no race: confidence bar of the current gesture class
    const uint8_t *c = CLASS_RGB[topClass % 8];
    int lit = (int)(topConfidence * 8 + 0.5f);
    for (int i = 0; i < 8; i++) {
      if (i < lit) setPixel(i, c[0], c[1], c[2], 8);
      else setPixel(i, 0, 0, 0, 0);
    }
  } else {
    // idle: slow teal scanner
    int pos = (int)((now / 140) % 14);
    if (pos > 7) pos = 14 - pos;
    for (int i = 0; i < 8; i++) {
      int d = abs(i - pos);
      if (d == 0) setPixel(i, 0, 200, 190, 6);
      else if (d == 1) setPixel(i, 0, 120, 110, 2);
      else setPixel(i, 0, 0, 0, 0);
    }
  }
  pixels.show();
}

// ------------------------------------------------------------------ setup / loop

void setup() {
  matrix.begin();
  matrix.setGrayscaleBits(3);   // 3-bit grayscale (0-7 levels)
  renderIdle(frame, 0, true);
  matrix.draw(frame);

  Bridge.begin();
  Bridge.provide_safe("led_state", onLedState);
  Bridge.provide_safe("rev", onRev);
  Bridge.provide_safe("btn_leds", onButtonLeds);
  Bridge.provide_safe("gesture", onGesture);
  Bridge.provide_safe("ml_engine", onEngine);

  Modulino.begin(Wire1);
  probeModulinos();
#if ARDUKART_HAS_MODEL
  buildAxisMap();
#endif
  nextSampleUs = micros();
  sendInfo();
}

void loop() {
  unsigned long nowUs = micros();
  if ((long)(nowUs - nextSampleUs) >= 0) {
    nextSampleUs += ARDUKART_SAMPLE_US;
    if ((long)(nowUs - nextSampleUs) > (long)(ARDUKART_SAMPLE_US * 4)) nextSampleUs = nowUs + ARDUKART_SAMPLE_US;  // fell behind: resync
    sampleImu();
  }

  unsigned long now = millis();
  if (now - lastButtons >= BUTTON_INTERVAL) { lastButtons = now; pollButtons(); }
  if (now - lastPixels >= PIXEL_INTERVAL) { lastPixels = now; renderPixels(now); }

  if (now - lastFrame >= FRAME_INTERVAL) {
    lastFrame = now;
    bool online = ledStateAt && now - ledStateAt < LED_STATE_TIMEOUT;
    if (online) renderLedState(frame, ledState, now);
    else renderIdle(frame, now, true);       // dim idle frame while Python is unreachable
    if (gestureIcon != GI_NONE && now - gestureAt < 700) renderGesture(frame, gestureIcon, gestureClass, now - gestureAt);
    matrix.draw(frame);
  }

  if (now - lastProbe >= PROBE_INTERVAL) {
    lastProbe = now;
    if (!hasMovement || !hasButtons || !hasPixels) probeModulinos();
  }
  if (now - lastInfo >= INFO_INTERVAL) { lastInfo = now; sendInfo(); }
}
