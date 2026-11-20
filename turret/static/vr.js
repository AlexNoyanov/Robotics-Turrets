const $ = (id) => document.getElementById(id);

const rateInput = $("rate");
const scaleInput = $("scale");
const yawInput = $("yawLim");
const pitchInput = $("pitchLim");
const sprInput = $("spr");
const flipYaw = $("flipYaw");
const flipPitch = $("flipPitch");
const preview = $("preview");
const paint = $("paint");
const ctx = paint.getContext("2d", { alpha: false });

const state = {
  ready: false,
  enabled: false,
  x: 0,
  y: 0,
  boot: 0,
  camera: { ok: false, error: "starting" },
  vr: {},
};

let optimisticArm = null;
let lastBoot = 0;
let session = null;
let engaged = false;
let baseYaw = 0;
let basePitch = 0;
let baseX = 0;
let baseY = 0;
let lastSentX = null;
let lastSentY = null;
let wasStop = false;
let wasRecenter = false;
let wasTrigger = false;
let follow = true;
let hud = "LOOK";

const queue = [];
let pendingMov = null;
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
  if (cmd === "STOP") {
    queue.length = 0;
    pendingMov = null;
    queue.push("STOP");
  } else if (cmd.startsWith("MOV ")) {
    pendingMov = cmd;
  } else {
    queue.push(cmd);
  }
  pump();
}

async function pump() {
  if (inflight) return;
  let cmd = null;
  if (queue.length) cmd = queue.shift();
  else if (pendingMov != null) {
    cmd = pendingMov;
    pendingMov = null;
  } else return;
  inflight = true;
  try {
    await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd }),
      keepalive: cmd === "STOP",
    });
  } catch (err) {
    $("fault").textContent = "LINK LOST";
  } finally {
    inflight = false;
    pump();
  }
}

function pushSettings() {
  enqueue("SPD " + rateInput.value);
  enqueue("ACC 8000");
  enqueue("INV X " + (recall("invx", "0") === "1" ? "1" : "0"));
  enqueue("INV Y " + (recall("invy", "0") === "1" ? "1" : "0"));
}

function armed() {
  if (optimisticArm != null) return optimisticArm;
  return !!state.enabled;
}

function stepsPerRev() {
  return Number(sprInput.value) || 3200;
}

function formatDeg(steps) {
  const value = (steps / stepsPerRev()) * 360;
  const body = Math.abs(value).toFixed(1);
  if (value > 0.05) return "+" + body + "°";
  if (value < -0.05) return "−" + body + "°";
  return "0.0°";
}

function loadSettings() {
  if (recall("vrGainVer", "") !== "2") {
    remember("vrScale", "12");
    remember("yawLim", "720");
    remember("pitchLim", "180");
    remember("vrRate", "8000");
    remember("vrGainVer", "2");
  }
  rateInput.value = recall("vrRate", "8000");
  scaleInput.value = recall("vrScale", "12");
  yawInput.value = recall("yawLim", "720");
  pitchInput.value = recall("pitchLim", "180");
  sprInput.value = recall("spr", "3200");
  flipYaw.checked = recall("flipYaw", "0") === "1";
  flipPitch.checked = recall("flipPitch", "0") === "1";
  $("rateVal").textContent = rateInput.value;
  $("scaleVal").textContent = scaleInput.value;
  $("yawVal").textContent = yawInput.value;
  $("pitchVal").textContent = pitchInput.value;
}

function render(next) {
  Object.assign(state, next);
  if (optimisticArm != null && next.enabled === optimisticArm) optimisticArm = null;
  const on = armed();
  $("link").textContent = !next.ready ? "NO LINK" : on ? "ARMED" : "STANDBY";
  $("dot").className = "dot" + (next.ready ? " live" : "") + (on ? " armed" : "");
  $("arm").textContent = on ? "DISABLE" : "ENABLE";
  $("arm").classList.toggle("armed", on);
  $("azStat").textContent = next.ready ? "X " + formatDeg(next.x) : "X —";
  $("elStat").textContent = next.ready ? "Y " + formatDeg(next.y) : "Y —";
  const cam = next.camera || {};
  $("camStat").textContent = cam.ok ? "CAMERA " + cam.width + "×" + cam.height : "NO CAMERA";
  $("previewNote").textContent = cam.ok ? "" : (cam.error || "WAITING FOR CAMERA");
  $("previewNote").style.display = cam.ok ? "none" : "block";
  if (next.vr) {
    if (next.vr.https) {
      $("wifiUrl").textContent = next.vr.https;
      $("wifiUrl").href = next.vr.https;
    }
    if (next.vr.local) $("usbUrl").href = next.vr.local;
  }
  const fault = next.device_error || (!next.ready ? next.error || "" : "");
  if (!session) $("fault").textContent = !window.isSecureContext ? insecureMessage() : (fault || "");
  if (next.ready && next.boot !== lastBoot) {
    lastBoot = next.boot;
    pushSettings();
  }
}

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    render(await res.json());
  } catch (err) {
    $("link").textContent = "PAGE OFFLINE";
  }
}

function wrap(rad) {
  let value = rad;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function clamp(value, limit) {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

function headAngles(q) {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const fx = -2 * (w * y + x * z);
  const fy = 2 * (w * x - y * z);
  const fz = -1 + 2 * (x * x + y * y);
  return {
    yaw: Math.atan2(fx, -fz),
    pitch: Math.atan2(fy, Math.hypot(fx, fz)),
  };
}

function track(angles) {
  if (!engaged) return;
  let dYaw = wrap(angles.yaw - baseYaw);
  let dPitch = angles.pitch - basePitch;
  if (flipYaw.checked) dYaw = -dYaw;
  if (flipPitch.checked) dPitch = -dPitch;
  const scale = Number(scaleInput.value) || 1;
  dYaw = clamp(dYaw * scale, Number(yawInput.value) * Math.PI / 180);
  dPitch = clamp(dPitch * scale, Number(pitchInput.value) * Math.PI / 180);
  const spr = stepsPerRev();
  const tx = baseX + Math.round((dYaw / (Math.PI * 2)) * spr);
  const ty = baseY + Math.round((dPitch / (Math.PI * 2)) * spr);
  const limited = Math.abs(dYaw) >= Number(yawInput.value) * Math.PI / 180 - 0.01
    || Math.abs(dPitch) >= Number(pitchInput.value) * Math.PI / 180 - 0.01;
  hud = limited ? "LIMIT" : "TRACKING";
  if (lastSentX == null || Math.abs(tx - lastSentX) >= 4 || Math.abs(ty - lastSentY) >= 4) {
    lastSentX = tx;
    lastSentY = ty;
    if (!armed()) {
      optimisticArm = true;
      enqueue("EN 1");
    }
    enqueue("MOV " + tx + " " + ty);
  }
}

function buttons(xrSession) {
  let trigger = false;
  let stop = false;
  let recenter = false;
  for (const source of xrSession.inputSources) {
    const pad = source.gamepad;
    if (!pad || !pad.buttons) continue;
    if (pad.buttons[0] && pad.buttons[0].pressed) trigger = true;
    if (pad.buttons[1] && pad.buttons[1].pressed) trigger = true;
    if (pad.buttons[5] && pad.buttons[5].pressed) stop = true;
    if (pad.buttons[4] && pad.buttons[4].pressed) recenter = true;
  }
  return { trigger, stop, recenter };
}

function engage(angles) {
  engaged = true;
  baseYaw = angles.yaw;
  basePitch = angles.pitch;
  baseX = state.x;
  baseY = state.y;
  lastSentX = baseX;
  lastSentY = baseY;
  hud = "TRACKING";
  if (!armed()) {
    optimisticArm = true;
    enqueue("EN 1");
  }
}

function release() {
  follow = false;
  engaged = false;
  hud = "STOPPED";
  optimisticArm = false;
  enqueue("STOP");
  enqueue("EN 0");
}

function paintFrame() {
  const w = paint.width;
  const h = paint.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (preview.naturalWidth > 0) {
    ctx.drawImage(preview, 0, 0, w, h);
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = "700 42px Arial";
    ctx.fillText("NO CAMERA", 48, h / 2);
  }
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.fillRect(0, h - 78, w, 78);
  ctx.fillStyle = "#fff";
  ctx.font = "700 34px Arial";
  ctx.fillText(hud, 28, h - 28);
  const right = state.ready ? formatDeg(state.x) + "   " + formatDeg(state.y) : "";
  ctx.textAlign = "right";
  ctx.fillText(right, w - 28, h - 28);
  ctx.textAlign = "left";
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "shader");
  }
  return shader;
}

function makeRenderer(gl) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, `
    attribute vec3 aPos;
    attribute vec2 aUv;
    uniform mat4 uProj;
    varying vec2 vUv;
    void main() {
      vUv = aUv;
      gl_Position = uProj * vec4(aPos, 1.0);
    }
  `);
  const fs = compile(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    void main() {
      gl_FragColor = texture2D(uTex, vUv);
    }
  `);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.bindAttribLocation(program, 1, "aUv");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "link");
  }
  const quad = gl.createBuffer();
  const w = 1.92;
  const h = 1.08;
  const z = -1.7;
  const x = w / 2;
  const y = h / 2;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -x, -y, z, 0, 0,
     x, -y, z, 1, 0,
     x,  y, z, 1, 1,
    -x, -y, z, 0, 0,
     x,  y, z, 1, 1,
    -x,  y, z, 0, 1,
  ]), gl.STATIC_DRAW);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  const proj = new Float32Array(16);
  return { program, quad, tex, proj, uProj: gl.getUniformLocation(program, "uProj") };
}

async function begin(xrSession) {
  const canvas = $("xr");
  const gl = canvas.getContext("webgl2", { xrCompatible: true, antialias: false });
  if (!gl) throw new Error("WebGL2 unavailable");
  await gl.makeXRCompatible();
  const layer = new XRWebGLLayer(xrSession, gl);
  await xrSession.updateRenderState({ baseLayer: layer });
  const ref = await xrSession.requestReferenceSpace("local-floor").catch(() => xrSession.requestReferenceSpace("local"));
  const draw = makeRenderer(gl);
  session = xrSession;
  follow = true;
  engaged = false;
  $("enter").textContent = "IN HEADSET";
  xrSession.addEventListener("end", () => {
    release();
    session = null;
    $("enter").disabled = false;
    $("enter").textContent = "ENTER VR";
  });

  const onFrame = (time, frame) => {
    if (session !== xrSession) return;
    xrSession.requestAnimationFrame(onFrame);
    const pose = frame.getViewerPose(ref);
    if (!pose) return;
    const angles = headAngles(pose.transform.orientation);
    const pad = buttons(xrSession);
    if (pad.stop && !wasStop) {
      follow = false;
      engaged = false;
      hud = "STOPPED";
      optimisticArm = false;
      enqueue("STOP");
      enqueue("EN 0");
    }
    wasStop = pad.stop;
    const resume = (pad.trigger && !wasTrigger) || (pad.recenter && !wasRecenter);
    wasTrigger = pad.trigger;
    wasRecenter = pad.recenter;
    if (resume) {
      follow = true;
      engage(angles);
    }
    if (follow && !engaged) engage(angles);
    if (follow) track(angles);
    paintFrame();
    gl.bindTexture(gl.TEXTURE_2D, draw.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paint);
    const glLayer = xrSession.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(draw.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, draw.quad);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      draw.proj.set(view.projectionMatrix);
      gl.uniformMatrix4fv(draw.uProj, false, draw.proj);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  };
  xrSession.requestAnimationFrame(onFrame);
}

function httpsUrl() {
  if (state.vr && state.vr.https) return state.vr.https;
  const link = $("wifiUrl");
  const href = link && link.getAttribute("href");
  return href && href.indexOf("https://") === 0 ? href : "";
}

function insecureMessage() {
  const url = httpsUrl();
  if (url) return "Open " + url + " for Wi-Fi. Continue past the certificate warning, then tap ENTER VR.";
  return "This address cannot enter VR. Pause the VPN, then open the https address.";
}

$("enter").addEventListener("click", () => {
  const xr = navigator.xr;
  if (!xr || !window.isSecureContext) {
    const why = !window.isSecureContext
      ? insecureMessage()
      : "This browser has no WebXR. Use the Quest Browser, not Quest Link.";
    $("fault").textContent = why;
    $("enter").textContent = "ENTER VR";
    return;
  }
  $("enter").textContent = "STARTING";
  $("fault").textContent = "";
  xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] })
    .then((xrSession) => begin(xrSession))
    .catch((err) => {
      const name = err && err.name ? err.name : "Error";
      const message = err && err.message ? err.message : "Could not enter VR";
      $("fault").textContent = name + " — " + message;
      $("enter").textContent = "ENTER VR";
    });
});

$("arm").addEventListener("click", () => {
  if (!state.ready) return;
  const next = !armed();
  optimisticArm = next;
  if (!next) {
    engaged = false;
    enqueue("STOP");
  }
  enqueue(next ? "EN 1" : "EN 0");
  render(state);
});

$("stop").addEventListener("click", () => {
  engaged = false;
  enqueue("STOP");
});

rateInput.addEventListener("input", () => {
  $("rateVal").textContent = rateInput.value;
  remember("vrRate", rateInput.value);
  enqueue("SPD " + rateInput.value);
});
scaleInput.addEventListener("input", () => {
  $("scaleVal").textContent = scaleInput.value;
  remember("vrScale", scaleInput.value);
});
yawInput.addEventListener("input", () => {
  $("yawVal").textContent = yawInput.value;
  remember("yawLim", yawInput.value);
});
pitchInput.addEventListener("input", () => {
  $("pitchVal").textContent = pitchInput.value;
  remember("pitchLim", pitchInput.value);
});
sprInput.addEventListener("change", () => remember("spr", sprInput.value));
flipYaw.addEventListener("change", () => remember("flipYaw", flipYaw.checked ? "1" : "0"));
flipPitch.addEventListener("change", () => remember("flipPitch", flipPitch.checked ? "1" : "0"));

window.addEventListener("pagehide", () => {
  fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "STOP" }),
    keepalive: true,
  });
});

async function detectHeadset() {
  $("enter").disabled = false;
  $("enter").textContent = "ENTER VR";
  if (!navigator.xr) {
    $("fault").textContent = "No WebXR in this window. Open the page in the Quest Browser.";
    return;
  }
  if (!window.isSecureContext) {
    $("fault").textContent = insecureMessage();
    return;
  }
  try {
    const ok = await navigator.xr.isSessionSupported("immersive-vr");
    if (!ok) {
      $("fault").textContent = "Tap ENTER VR anyway. The headset asks for permission on that tap.";
    }
  } catch (err) {
    $("fault").textContent = "Tap ENTER VR.";
  }
}

loadSettings();
detectHeadset();
setInterval(poll, 150);
poll();
