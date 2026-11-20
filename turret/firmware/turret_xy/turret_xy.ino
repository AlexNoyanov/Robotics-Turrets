// Turret bench firmware for an Arduino Uno on a CNC shield.
// X and Y only. Step pulses are generated in loop() with accel limiting.
//
// CNC shield V3 (GRBL pin map):
//   X step D2   X dir D5
//   Y step D3   Y dir D6
//   Enable D8, active LOW (drivers on when the pin is low)
// Pull the EN jumper so D8 can turn the drivers off.
// Match the page's steps/rev to the microstep jumpers under each driver.
// A4988 with all three jumpers on is 1/16 (3200 steps/rev on a 1.8° motor).
//
// 115200 8N1, one command per line:
//   EN 0|1            drivers off / on
//   VEL <x> <y>       signed steps/s, watchdog returns to 0 if the host goes quiet
//   JOG X <steps>     relative move, queued on that axis
//   JOG Y <steps>
//   MOV <x> <y>       absolute position, steps
//   SPD <steps/s>     cruise cap, 1..12000
//   ACC <steps/s^2>   accel, 100..100000
//   INV X 0|1         flip the X direction pin
//   INV Y 0|1
//   ZERO              this pose becomes 0,0 and motion stops
//   STOP              drop velocity now
//   ?                 status
// Status line: @ x y vx vy en mode ix iy

#include <math.h>

static const int X_STEP_PIN = 2;
static const int Y_STEP_PIN = 3;
static const int X_DIR_PIN = 5;
static const int Y_DIR_PIN = 6;
static const int ENABLE_PIN = 8;

static const uint8_t MODE_IDLE = 0;
static const uint8_t MODE_VEL = 1;
static const uint8_t MODE_POS = 2;

static const unsigned long VEL_WATCHDOG_MS = 500;
static const unsigned long STATUS_MS = 100;
static const int MAX_STEPS_PER_TICK = 24;

struct Axis {
  int stepPin;
  int dirPin;
  long pos;
  long target;
  float vel;
  float cmd;
  float frac;
  uint8_t mode;
  bool invert;
  bool dirHigh;
};

static Axis xAxis = {X_STEP_PIN, X_DIR_PIN, 0, 0, 0, 0, 0, MODE_IDLE, false, false};
static Axis yAxis = {Y_STEP_PIN, Y_DIR_PIN, 0, 0, 0, 0, 0, MODE_IDLE, false, false};

static float maxSpeed = 500.f;
static float accel = 3000.f;
static bool driversOn = false;
static unsigned long lastUs = 0;
static unsigned long lastStatusMs = 0;
static unsigned long lastHostMs = 0;

static char lineBuf[72];
static uint8_t lineLen = 0;
static bool lineDrop = false;

static void sendStatus() {
  int vx = (int)(xAxis.vel + (xAxis.vel >= 0 ? 0.5f : -0.5f));
  int vy = (int)(yAxis.vel + (yAxis.vel >= 0 ? 0.5f : -0.5f));
  char mode = 'I';
  if (xAxis.mode == MODE_POS || yAxis.mode == MODE_POS) mode = 'P';
  else if (xAxis.mode == MODE_VEL || yAxis.mode == MODE_VEL) mode = 'V';

  Serial.print(F("@ "));
  Serial.print(xAxis.pos);
  Serial.print(' ');
  Serial.print(yAxis.pos);
  Serial.print(' ');
  Serial.print(vx);
  Serial.print(' ');
  Serial.print(vy);
  Serial.print(' ');
  Serial.print(driversOn ? 1 : 0);
  Serial.print(' ');
  Serial.print(mode);
  Serial.print(' ');
  Serial.print(xAxis.invert ? 1 : 0);
  Serial.print(' ');
  Serial.println(yAxis.invert ? 1 : 0);
}

static void ok() {
  Serial.println(F("OK"));
  sendStatus();
}

static void fail(const __FlashStringHelper *msg) {
  Serial.print(F("ERR "));
  Serial.println(msg);
}

static void pulse(Axis &axis, int dir) {
  bool high = dir > 0;
  if (axis.invert) high = !high;
  if (high != axis.dirHigh) {
    digitalWrite(axis.dirPin, high ? HIGH : LOW);
    axis.dirHigh = high;
    delayMicroseconds(4);
  }
  digitalWrite(axis.stepPin, HIGH);
  delayMicroseconds(3);
  digitalWrite(axis.stepPin, LOW);
  axis.pos += dir;
}

static void haltAxis(Axis &axis) {
  axis.vel = 0;
  axis.cmd = 0;
  axis.frac = 0;
  axis.mode = MODE_IDLE;
}

static void stopAll() {
  haltAxis(xAxis);
  haltAxis(yAxis);
}

static void setDrivers(bool on) {
  if (!on) stopAll();
  driversOn = on;
  digitalWrite(ENABLE_PIN, on ? LOW : HIGH);
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
}

static float clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static void service(Axis &axis, float dt) {
  if (!driversOn) {
    haltAxis(axis);
    return;
  }

  float goal = 0;
  if (axis.mode == MODE_VEL) {
    goal = axis.cmd;
  } else if (axis.mode == MODE_POS) {
    if (axis.pos == axis.target) {
      haltAxis(axis);
      return;
    }
    float dist = (float)(axis.target - axis.pos);
    float sgn = dist > 0.f ? 1.f : -1.f;
    float approach = sqrtf(2.f * accel * fabs(dist));
    float mag = approach < maxSpeed ? approach : maxSpeed;
    goal = sgn * mag;
  }

  float maxDv = accel * dt;
  float dv = goal - axis.vel;
  if (dv > maxDv) dv = maxDv;
  else if (dv < -maxDv) dv = -maxDv;
  axis.vel += dv;

  if (axis.mode == MODE_VEL && axis.cmd == 0.f && fabs(axis.vel) < 1.f) {
    haltAxis(axis);
    return;
  }
  if (axis.mode == MODE_IDLE) return;

  axis.frac += axis.vel * dt;

  int steps = 0;
  while (axis.frac >= 1.f && steps < MAX_STEPS_PER_TICK) {
    axis.frac -= 1.f;
    pulse(axis, +1);
    steps++;
    if (axis.mode == MODE_POS && axis.pos == axis.target) {
      haltAxis(axis);
      return;
    }
  }
  while (axis.frac <= -1.f && steps < MAX_STEPS_PER_TICK) {
    axis.frac += 1.f;
    pulse(axis, -1);
    steps++;
    if (axis.mode == MODE_POS && axis.pos == axis.target) {
      haltAxis(axis);
      return;
    }
  }
}

static bool motionAllowed() {
  if (driversOn) return true;
  fail(F("disabled"));
  return false;
}

static void startJog(Axis &axis, long steps) {
  if (!motionAllowed()) return;
  long base = axis.mode == MODE_POS ? axis.target : axis.pos;
  axis.target = base + steps;
  axis.mode = MODE_POS;
  ok();
}

static void handleLine(char *line) {
  lastHostMs = millis();

  for (char *p = line; *p; ++p) {
    if (*p >= 'a' && *p <= 'z') *p = (char)(*p - 32);
  }

  if (line[0] == '?' && line[1] == 0) {
    sendStatus();
    return;
  }
  if (!strcmp(line, "STOP")) {
    stopAll();
    ok();
    return;
  }
  if (!strcmp(line, "ZERO")) {
    stopAll();
    xAxis.pos = 0;
    yAxis.pos = 0;
    xAxis.target = 0;
    yAxis.target = 0;
    ok();
    return;
  }
  if (!strcmp(line, "EN 0")) {
    setDrivers(false);
    ok();
    return;
  }
  if (!strcmp(line, "EN 1")) {
    setDrivers(true);
    ok();
    return;
  }
  if (!strncmp(line, "INV X ", 6) && (line[6] == '0' || line[6] == '1') && line[7] == 0) {
    xAxis.invert = line[6] == '1';
    ok();
    return;
  }
  if (!strncmp(line, "INV Y ", 6) && (line[6] == '0' || line[6] == '1') && line[7] == 0) {
    yAxis.invert = line[6] == '1';
    ok();
    return;
  }
  if (!strncmp(line, "SPD ", 4)) {
    long v = strtol(line + 4, nullptr, 10);
    if (v < 1 || v > 12000) {
      fail(F("spd"));
      return;
    }
    maxSpeed = (float)v;
    xAxis.cmd = clampf(xAxis.cmd, -maxSpeed, maxSpeed);
    yAxis.cmd = clampf(yAxis.cmd, -maxSpeed, maxSpeed);
    ok();
    return;
  }
  if (!strncmp(line, "ACC ", 4)) {
    long v = strtol(line + 4, nullptr, 10);
    if (v < 100 || v > 100000) {
      fail(F("acc"));
      return;
    }
    accel = (float)v;
    ok();
    return;
  }
  if (!strncmp(line, "VEL ", 4)) {
    if (!motionAllowed()) return;
    char *end = nullptr;
    long vx = strtol(line + 4, &end, 10);
    if (end == line + 4) {
      fail(F("vel"));
      return;
    }
    long vy = strtol(end, nullptr, 10);
    xAxis.cmd = clampf((float)vx, -maxSpeed, maxSpeed);
    yAxis.cmd = clampf((float)vy, -maxSpeed, maxSpeed);
    xAxis.mode = MODE_VEL;
    yAxis.mode = MODE_VEL;
    ok();
    return;
  }
  if (!strncmp(line, "JOG X ", 6)) {
    startJog(xAxis, strtol(line + 6, nullptr, 10));
    return;
  }
  if (!strncmp(line, "JOG Y ", 6)) {
    startJog(yAxis, strtol(line + 6, nullptr, 10));
    return;
  }
  if (!strncmp(line, "MOV ", 4)) {
    if (!motionAllowed()) return;
    char *end = nullptr;
    long tx = strtol(line + 4, &end, 10);
    if (end == line + 4) {
      fail(F("mov"));
      return;
    }
    long ty = strtol(end, nullptr, 10);
    xAxis.target = tx;
    yAxis.target = ty;
    xAxis.mode = MODE_POS;
    yAxis.mode = MODE_POS;
    ok();
    return;
  }

  fail(F("cmd"));
}

static void pollSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (!lineDrop && lineLen > 0) {
        lineBuf[lineLen] = 0;
        handleLine(lineBuf);
      }
      lineLen = 0;
      lineDrop = false;
      continue;
    }
    if (lineDrop) continue;
    if (lineLen >= sizeof(lineBuf) - 1) {
      lineDrop = true;
      lineLen = 0;
      continue;
    }
    lineBuf[lineLen++] = c;
  }
}

void setup() {
  pinMode(X_STEP_PIN, OUTPUT);
  pinMode(Y_STEP_PIN, OUTPUT);
  pinMode(X_DIR_PIN, OUTPUT);
  pinMode(Y_DIR_PIN, OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(X_STEP_PIN, LOW);
  digitalWrite(Y_STEP_PIN, LOW);
  digitalWrite(X_DIR_PIN, LOW);
  digitalWrite(Y_DIR_PIN, LOW);
  digitalWrite(ENABLE_PIN, HIGH);
  digitalWrite(LED_BUILTIN, LOW);

  Serial.begin(115200);
  lastUs = micros();
  lastHostMs = millis();
  Serial.println(F("READY turret-xy 1"));
}

void loop() {
  pollSerial();

  unsigned long nowUs = micros();
  unsigned long dtUs = nowUs - lastUs;
  if (dtUs < 150) return;
  if (dtUs > 20000) dtUs = 20000;
  lastUs = nowUs;

  if ((xAxis.mode == MODE_VEL || yAxis.mode == MODE_VEL) &&
      millis() - lastHostMs > VEL_WATCHDOG_MS) {
    xAxis.cmd = 0;
    yAxis.cmd = 0;
  }

  float dt = dtUs * 1e-6f;
  service(xAxis, dt);
  service(yAxis, dt);

  unsigned long nowMs = millis();
  if (nowMs - lastStatusMs >= STATUS_MS) {
    lastStatusMs = nowMs;
    sendStatus();
  }
}
