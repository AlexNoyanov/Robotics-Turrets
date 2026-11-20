const $ = (id) => document.getElementById(id);

const rateInput = $("rate");
const accInput = $("acc");
const sprInput = $("spr");
const invX = $("invX");
const invY = $("invY");
const portSelect = $("port");
const needle = $("needle");
const pad = $("pad");
const reticle = $("reticle");
const instrument = $("instrument");

const state = {
  connected: false,
  ready: false,
  enabled: false,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  mode: "I",
  boot: 0,
};

let optimisticArm = null;
let lastBoot = 0;
let dragging = false;
let lastPointer = null;
const held = { x: 0, y: 0 };

const queue = [];
let pendingVel = null;
let inflight = false;

function remember(key, value) {
  try { localStorage.setItem("turret." + key, String(value)); } catch (err) { /* private mode */ }
}

function recall(key, fallback) {
  try {
    const value = localStorage.getItem("turret." + key);
    return value == null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

function enqueue(cmd) {
  if (cmd.startsWith("VEL ")) pendingVel = cmd;
  else queue.push(cmd);
  pump();
}

function estop() {
  queue.length = 0;
  pendingVel = null;
  held.x = 0;
  held.y = 0;
  dragging = false;
  resetReticle();
  queue.push("STOP");
  pump();
}

async function pump() {
  if (inflight) return;
  let cmd = null;
  if (queue.length) cmd = queue.shift();
  else if (pendingVel != null) {
    cmd = pendingVel;
    pendingVel = null;
  } else return;

  inflight = true;
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      $("fault").textContent = data.error || "Command rejected";
    }
  } catch (err) {
    $("fault").textContent = "LINK LOST";
  } finally {
    inflight = false;
    pump();
  }
}

function pushSettings() {
  enqueue("SPD " + rateInput.value);
  enqueue("ACC " + accInput.value);
  enqueue("INV X " + (invX.checked ? "1" : "0"));
  enqueue("INV Y " + (invY.checked ? "1" : "0"));
}

function armed() {
  if (optimisticArm != null) return optimisticArm;
  return !!state.enabled;
}

function requireArm() {
  if (armed() && state.ready) return true;
  $("arm").classList.remove("flash");
  void $("arm").offsetWidth;
  $("arm").classList.add("flash");
  return false;
}

function stepsFor(sign) {
  const choice = document.querySelector('input[name="bump"]:checked').value;
  if (choice === "step") return sign;
  const steps = Math.round((Number(choice) / 360) * Number(sprInput.value) * sign);
  return steps === 0 ? sign : steps;
}

function bump(axis, sign) {
  if (!requireArm()) return;
  enqueue("JOG " + axis.toUpperCase() + " " + stepsFor(sign));
}

function commandVelocity(nx, ny) {
  const rate = Number(rateInput.value);
  enqueue("VEL " + Math.round(nx * rate) + " " + Math.round(ny * rate));
}

function applyHeld() {
  commandVelocity(held.x, held.y);
}

function resetReticle() {
  reticle.style.transform = "translate(0px, 0px)";
  lastPointer = null;
}

function driveStick(clientX, clientY) {
  const rect = pad.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let dx = clientX - cx;
  let dy = clientY - cy;
  const max = rect.width / 2;
  const mag = Math.hypot(dx, dy);
  if (mag > max && mag > 0) {
    dx *= max / mag;
    dy *= max / mag;
  }
  let nx = dx / max;
  let ny = -dy / max;
  if (Math.hypot(nx, ny) < 0.06) {
    nx = 0;
    ny = 0;
    dx = 0;
    dy = 0;
  }
  reticle.style.transform = "translate(" + dx.toFixed(1) + "px, " + dy.toFixed(1) + "px)";
  lastPointer = { x: clientX, y: clientY, nx, ny };
  commandVelocity(nx, ny);
}

function formatDeg(steps) {
  const value = (steps / Number(sprInput.value)) * 360;
  const body = Math.abs(value).toFixed(2);
  if (value > 0.004) return "+" + body;
  if (value < -0.004) return "−" + body;
  return "0.00";
}

function formatTurns(steps) {
  const turns = steps / Number(sprInput.value);
  if (Math.abs(turns) < 1) return "";
  const sign = turns > 0 ? "+" : "−";
  return sign + Math.abs(turns).toFixed(2) + " TURNS";
}

function formatRate(value) {
  if (!value) return "0 ST/S";
  return (value > 0 ? "+" : "−") + Math.abs(value) + " ST/S";
}

function renderPorts(ports, current) {
  const sig = ports.map((port) => port.device).join(",");
  if (portSelect.dataset.sig !== sig) {
    portSelect.dataset.sig = sig;
    portSelect.innerHTML = "";
    if (!ports.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "NO PORT";
      portSelect.appendChild(empty);
    }
    ports.forEach((port) => {
      const option = document.createElement("option");
      option.value = port.device;
      option.textContent = port.device;
      portSelect.appendChild(option);
    });
  }
  if (current && portSelect.value !== current && document.activeElement !== portSelect) {
    portSelect.value = current;
  }
}

function render(next) {
  Object.assign(state, next);
  if (optimisticArm != null && next.enabled === optimisticArm) optimisticArm = null;
  const on = armed();

  renderPorts(next.ports || [], next.port);
  $("link").textContent = linkLabel(next);
  $("dot").className = "dot" + (next.ready ? " live" : "") + (on ? " armed" : "");
  $("driver").textContent = on ? "DRIVERS ON" : "DRIVERS OFF";
  $("driver").classList.toggle("on", on);
  $("arm").textContent = on ? "DISABLE" : "ENABLE";
  $("arm").classList.toggle("armed", on);
  instrument.classList.toggle("armed", on && next.ready);
  const moving = !!(next.vx || next.vy || next.mode === "V" || next.mode === "P");
  $("stop").classList.toggle("hot", moving);

  document.querySelectorAll(".unit").forEach((node) => {
    node.hidden = !next.ready;
  });

  if (!next.ready) {
    $("xDeg").textContent = "—";
    $("yDeg").textContent = "—";
    $("xSteps").textContent = "— STEPS";
    $("ySteps").textContent = "— STEPS";
    $("xRate").textContent = "0 ST/S";
    $("yRate").textContent = "0 ST/S";
    $("xTurns").textContent = "";
    $("yTurns").textContent = "";
  } else {
    $("xDeg").textContent = formatDeg(next.x);
    $("yDeg").textContent = formatDeg(next.y);
    $("xSteps").textContent = next.x + " STEPS";
    $("ySteps").textContent = next.y + " STEPS";
    $("xRate").textContent = formatRate(next.vx);
    $("yRate").textContent = formatRate(next.vy);
    $("xTurns").textContent = formatTurns(next.x);
    $("yTurns").textContent = formatTurns(next.y);
    const azimuth = (next.x / Number(sprInput.value)) * 360;
    const elevation = (next.y / Number(sprInput.value)) * 360;
    needle.setAttribute("transform", "rotate(" + azimuth + " 50 50)");
    const clamped = Math.max(-180, Math.min(180, elevation));
    $("elevMark").style.top = ((180 - clamped) / 360) * 100 + "%";
  }

  const fault = next.device_error || (!next.ready ? next.error || "" : "");
  $("fault").textContent = fault || "";
  $("last").textContent = next.last || "";

  if (next.ready && next.boot !== lastBoot) {
    lastBoot = next.boot;
    pushSettings();
  }
}

function linkLabel(next) {
  if (!next.connected) return "NO LINK";
  if (!next.ready) return "BOOT";
  if (next.vx || next.vy || next.mode === "V" || next.mode === "P") return "MOVING";
  if (armed()) return "ARMED";
  return "STANDBY";
}

function drawTicks() {
  const ticks = $("ticks");
  for (let i = 0; i < 72; i += 1) {
    const major = i % 6 === 0;
    const len = major ? 4.4 : 2.2;
    const outer = 46;
    const inner = outer - len;
    const angle = ((i * 5 - 90) * Math.PI) / 180;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", (50 + inner * Math.cos(angle)).toFixed(2));
    line.setAttribute("y1", (50 + inner * Math.sin(angle)).toFixed(2));
    line.setAttribute("x2", (50 + outer * Math.cos(angle)).toFixed(2));
    line.setAttribute("y2", (50 + outer * Math.sin(angle)).toFixed(2));
    line.setAttribute("stroke", major ? "#ffffff" : "rgba(255,255,255,0.4)");
    line.setAttribute("stroke-width", major ? "0.45" : "0.25");
    ticks.appendChild(line);
  }
}

function loadSettings() {
  rateInput.value = recall("rate", "500");
  accInput.value = recall("acc", "3000");
  sprInput.value = recall("spr", "3200");
  invX.checked = recall("invx", "0") === "1";
  invY.checked = recall("invy", "0") === "1";
  const bump = recall("bump", "15");
  const picked = document.querySelector('input[name="bump"][value="' + bump + '"]');
  if (picked) picked.checked = true;
  $("rateVal").textContent = rateInput.value;
  $("accVal").textContent = accInput.value;
}

rateInput.addEventListener("input", () => {
  $("rateVal").textContent = rateInput.value;
  remember("rate", rateInput.value);
  enqueue("SPD " + rateInput.value);
  if (dragging && lastPointer) commandVelocity(lastPointer.nx, lastPointer.ny);
  else if (held.x || held.y) applyHeld();
});

accInput.addEventListener("input", () => {
  $("accVal").textContent = accInput.value;
  remember("acc", accInput.value);
  enqueue("ACC " + accInput.value);
});

sprInput.addEventListener("change", () => {
  remember("spr", sprInput.value);
  render(state);
});

invX.addEventListener("change", () => {
  remember("invx", invX.checked ? "1" : "0");
  enqueue("INV X " + (invX.checked ? "1" : "0"));
});

invY.addEventListener("change", () => {
  remember("invy", invY.checked ? "1" : "0");
  enqueue("INV Y " + (invY.checked ? "1" : "0"));
});

document.querySelectorAll('input[name="bump"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) remember("bump", input.value);
  });
});

$("arm").addEventListener("click", () => {
  if (!state.ready) return;
  const next = !armed();
  optimisticArm = next;
  if (!next) {
    held.x = 0;
    held.y = 0;
    dragging = false;
    resetReticle();
    enqueue("VEL 0 0");
  }
  enqueue(next ? "EN 1" : "EN 0");
  render(state);
});

$("stop").addEventListener("click", estop);
$("zero").addEventListener("click", () => enqueue("ZERO"));

portSelect.addEventListener("change", () => {
  if (!portSelect.value) return;
  fetch("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ port: portSelect.value }),
  });
});

pad.addEventListener("pointerdown", (event) => {
  if (!requireArm()) return;
  dragging = true;
  held.x = 0;
  held.y = 0;
  pad.setPointerCapture(event.pointerId);
  driveStick(event.clientX, event.clientY);
});

pad.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  driveStick(event.clientX, event.clientY);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  resetReticle();
  enqueue("VEL 0 0");
}

pad.addEventListener("pointerup", endDrag);
pad.addEventListener("pointercancel", endDrag);

document.querySelectorAll(".hold").forEach((btn) => {
  let timer = 0;
  let holding = false;
  let live = false;

  btn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    live = requireArm();
    if (!live) return;
    holding = false;
    btn.setPointerCapture(event.pointerId);
    timer = window.setTimeout(() => {
      holding = true;
      held[btn.dataset.axis] = Number(btn.dataset.sign);
      applyHeld();
    }, 220);
  });

  btn.addEventListener("pointerup", () => {
    window.clearTimeout(timer);
    if (!live) return;
    const axis = btn.dataset.axis;
    const sign = Number(btn.dataset.sign);
    if (holding) {
      if (held[axis] === sign) held[axis] = 0;
      if (!held.x && !held.y && !dragging) enqueue("VEL 0 0");
      else applyHeld();
    } else {
      bump(axis, sign);
    }
    holding = false;
    live = false;
  });

  btn.addEventListener("pointercancel", () => {
    window.clearTimeout(timer);
    if (holding) {
      const axis = btn.dataset.axis;
      const sign = Number(btn.dataset.sign);
      if (held[axis] === sign) held[axis] = 0;
      enqueue("VEL 0 0");
    }
    holding = false;
    live = false;
  });
});

window.addEventListener("keydown", (event) => {
  if (event.target && event.target.tagName === "SELECT") return;
  if (event.code === "Space") {
    event.preventDefault();
    estop();
    return;
  }
  if (event.repeat) return;
  if (event.key === "e" || event.key === "E") {
    $("arm").click();
    return;
  }
  if ((event.key === "z" || event.key === "Z") && !event.ctrlKey && !event.metaKey) {
    enqueue("ZERO");
    return;
  }
  const map = { ArrowLeft: ["x", -1], ArrowRight: ["x", 1], ArrowUp: ["y", 1], ArrowDown: ["y", -1] };
  const binding = map[event.key];
  if (!binding) return;
  event.preventDefault();
  if (!requireArm()) return;
  held[binding[0]] = binding[1];
  applyHeld();
});

window.addEventListener("keyup", (event) => {
  const map = { ArrowLeft: ["x", -1], ArrowRight: ["x", 1], ArrowUp: ["y", 1], ArrowDown: ["y", -1] };
  const binding = map[event.key];
  if (!binding) return;
  if (held[binding[0]] === binding[1]) held[binding[0]] = 0;
  if (!held.x && !held.y && !dragging) enqueue("VEL 0 0");
  else applyHeld();
});

function releaseJog() {
  const wasMoving = dragging || held.x || held.y;
  held.x = 0;
  held.y = 0;
  dragging = false;
  resetReticle();
  if (wasMoving) enqueue("VEL 0 0");
}

window.addEventListener("blur", releaseJog);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseJog();
});

setInterval(() => {
  if (!armed()) return;
  if (dragging && lastPointer) commandVelocity(lastPointer.nx, lastPointer.ny);
  else if (held.x || held.y) applyHeld();
}, 150);

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    render(await res.json());
  } catch (err) {
    $("link").textContent = "PAGE OFFLINE";
    $("dot").className = "dot";
  }
}

drawTicks();
loadSettings();
setInterval(poll, 100);
poll();
