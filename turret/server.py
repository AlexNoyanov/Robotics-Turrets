"""Bench page and USB serial bridge for the turret Arduino.

The bench is at http://127.0.0.1:8092. Quest VR is at /vr.
This process owns the COM port and the webcam.
"""

from __future__ import annotations

import argparse
import datetime
import ipaddress
import json
import queue
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import serial
from serial.tools import list_ports

ROOT = Path(__file__).resolve().parent / "static"
CERT_DIR = Path.home() / "AppData" / "Local" / "turret-tools" / "certs"
HOST = "0.0.0.0"

COMMANDS = re.compile(
    r"^(?:"
    r"STOP|ZERO|\?|"
    r"EN [01]|"
    r"INV [XY] [01]|"
    r"SPD \d{1,5}|"
    r"ACC \d{1,6}|"
    r"VEL -?\d{1,6} -?\d{1,6}|"
    r"JOG [XY] -?\d{1,7}|"
    r"MOV -?\d{1,9} -?\d{1,9}"
    r")$"
)

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


def port_records() -> list[dict]:
    found = []
    for port in list_ports.comports():
        found.append(
            {
                "device": port.device,
                "description": port.description or "",
                "vid": port.vid,
                "pid": port.pid,
            }
        )
    return found


def autodetect() -> str | None:
    ranked: list[tuple[int, str]] = []
    for port in list_ports.comports():
        desc = (port.description or "").lower()
        score = 0
        if port.vid in (0x1A86, 0x2341, 0x2A03, 0x10C4, 0x0403):
            score += 5
        if any(token in desc for token in ("arduino", "ch340", "usb-serial", "usb serial")):
            score += 3
        if port.device.upper() == "COM1":
            score -= 10
        if score > 0:
            ranked.append((score, port.device))
    ranked.sort(reverse=True)
    return ranked[0][1] if ranked else None


class Bridge(threading.Thread):
    def __init__(self, forced_port: str | None = None) -> None:
        super().__init__(daemon=True)
        self.forced_port = forced_port
        self.commands: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.reopen = threading.Event()
        self.boot_id = 0
        self.state = {
            "connected": False,
            "ready": False,
            "port": None,
            "ports": [],
            "x": 0,
            "y": 0,
            "vx": 0,
            "vy": 0,
            "enabled": False,
            "mode": "I",
            "ix": 0,
            "iy": 0,
            "boot": 0,
            "last": "",
            "error": None,
            "device_error": None,
        }

    def submit(self, cmd: str) -> None:
        if not COMMANDS.match(cmd):
            raise ValueError(cmd)
        if cmd == "STOP":
            self._drain()
            self.commands.put(cmd)
            return
        if cmd.startswith("MOV ") or cmd.startswith("VEL "):
            self._replace_motion(cmd)
            return
        self.commands.put(cmd)

    def _replace_motion(self, cmd: str) -> None:
        kept = []
        while True:
            try:
                item = self.commands.get_nowait()
            except queue.Empty:
                break
            if item.startswith(("MOV ", "VEL ", "JOG ")):
                continue
            kept.append(item)
        for item in kept:
            self.commands.put(item)
        self.commands.put(cmd)

    def request_port(self, port: str) -> None:
        self.forced_port = port
        self.reopen.set()
        self._drain()

    def snapshot(self) -> dict:
        with self.lock:
            data = dict(self.state)
        data["ports"] = port_records()
        return data

    def _drain(self) -> None:
        while True:
            try:
                self.commands.get_nowait()
            except queue.Empty:
                return

    def _update(self, **kwargs) -> None:
        with self.lock:
            self.state.update(kwargs)

    def run(self) -> None:
        while not self.stop.is_set():
            port = self.forced_port or autodetect()
            if not port:
                self._update(
                    connected=False,
                    ready=False,
                    port=None,
                    error="No USB serial port found",
                )
                time.sleep(1)
                continue
            try:
                self._session(port)
            except Exception as exc:  # serial unplug, access denied
                self._update(connected=False, ready=False, error=str(exc))
                time.sleep(1)

    def _session(self, port: str) -> None:
        link = serial.Serial(port, 115200, timeout=0.05)
        self.reopen.clear()
        self._drain()
        self._rx = ""
        safed_boot = -1
        poke_at = time.time() + 2.5
        self._update(connected=True, ready=False, port=port, error=None, device_error=None)
        try:
            while not self.stop.is_set() and not self.reopen.is_set():
                self._read(link)
                boot = self.boot_id
                if boot != safed_boot and (self.state["ready"] or time.time() >= poke_at):
                    link.write(b"STOP\nEN 0\n?\n")
                    safed_boot = boot
                self._write_pending(link)
                time.sleep(0.01)
        finally:
            link.close()
            self._update(connected=False, ready=False)

    def _write_pending(self, link: serial.Serial) -> None:
        wrote = False
        while True:
            try:
                cmd = self.commands.get_nowait()
            except queue.Empty:
                break
            link.write((cmd + "\n").encode("ascii"))
            wrote = True
        if wrote:
            link.flush()

    def _read(self, link: serial.Serial) -> None:
        waiting = link.in_waiting
        if waiting <= 0:
            return
        raw = link.read(waiting).decode("latin1", errors="replace")
        # Keep a remainder on the instance so a read can split a line.
        pending = getattr(self, "_rx", "") + raw
        lines = pending.split("\n")
        self._rx = lines.pop()
        for line in lines:
            self._take(line.strip())

    def _take(self, line: str) -> None:
        if not line:
            return
        if line.startswith("READY"):
            self.boot_id += 1
            self._update(ready=True, boot=self.boot_id, last=line, error=None)
            return
        if line.startswith("ERR"):
            self._update(device_error=line, last=line)
            return
        if line == "OK":
            self._update(device_error=None, last=line)
            return
        if not line.startswith("@"):
            self._update(last=line)
            return
        parts = line.split()
        if len(parts) < 9:
            self._update(last=line)
            return
        try:
            x, y, vx, vy = (int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]))
            enabled = parts[5] == "1"
            mode = parts[6]
            ix = 1 if parts[7] == "1" else 0
            iy = 1 if parts[8] == "1" else 0
        except ValueError:
            self._update(last=line)
            return
        boot = self.boot_id or 1
        self.boot_id = boot
        self._update(
            ready=True,
            boot=boot,
            x=x,
            y=y,
            vx=vx,
            vy=vy,
            enabled=enabled,
            mode=mode,
            ix=ix,
            iy=iy,
            last=line,
            error=None,
        )


CAMERA_WORKER = r"""
import sys
import time

import cv2

def open_camera():
    for backend in (cv2.CAP_DSHOW, cv2.CAP_MSMF):
        cap = cv2.VideoCapture(0, backend)
        if cap.isOpened():
            return cap
        cap.release()
    return None

out = sys.stdout.buffer
cap = open_camera()
if cap is None:
    out.write((0).to_bytes(4, "big"))
    out.flush()
    sys.exit(1)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
misses = 0
while True:
    ok, image = cap.read()
    if not ok or image is None:
        misses += 1
        if misses > 30:
            sys.exit(2)
        time.sleep(0.1)
        continue
    misses = 0
    encoded, buf = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 68])
    if not encoded:
        continue
    payload = buf.tobytes()
    out.write(len(payload).to_bytes(4, "big"))
    out.write(payload)
    out.flush()
"""


def _read_exact(stream, size: int) -> bytes | None:
    chunks = []
    remaining = size
    while remaining:
        piece = stream.read(remaining)
        if not piece:
            return None
        chunks.append(piece)
        remaining -= len(piece)
    return b"".join(chunks)


class Camera(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True)
        self._lock = threading.Lock()
        self.frame: bytes | None = None
        self.ok = False
        self.error: str | None = "starting"
        self.width = 0
        self.height = 0

    def latest(self) -> bytes | None:
        with self._lock:
            return self.frame

    def status(self) -> dict:
        with self._lock:
            return {
                "ok": self.ok,
                "error": self.error,
                "width": self.width,
                "height": self.height,
            }

    def run(self) -> None:
        while True:
            process = subprocess.Popen(
                [sys.executable, "-u", "-c", CAMERA_WORKER],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            assert process.stdout is not None
            try:
                self._read_frames(process)
            except Exception as exc:
                with self._lock:
                    self.ok = False
                    self.error = str(exc)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)
            with self._lock:
                if self.error == "starting":
                    self.error = "Camera stopped. Reopening."
            time.sleep(1)

    def _read_frames(self, process: subprocess.Popen) -> None:
        stream = process.stdout
        assert stream is not None
        while process.poll() is None:
            header = _read_exact(stream, 4)
            if header is None:
                with self._lock:
                    self.ok = False
                    self.error = "Camera stopped. Reopening."
                return
            length = int.from_bytes(header, "big")
            if length == 0:
                with self._lock:
                    self.ok = False
                    self.error = "Camera did not open"
                return
            payload = _read_exact(stream, length)
            if not payload:
                return
            with self._lock:
                self.frame = payload
                self.ok = True
                self.error = None
                self.width = 1280
                self.height = 720


def host_ips() -> list[str]:
    found: list[str] = []
    try:
        raw = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        raw = []
    for item in raw:
        ip = item[4][0]
        if ip.startswith("127.") or ip in found:
            continue
        found.append(ip)
    try:
        text = subprocess.check_output(
            ["netsh", "interface", "ipv4", "show", "ipaddresses"],
            text=True,
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError):
        text = ""
    for ip in re.findall(r"(\d+\.\d+\.\d+\.\d+)", text):
        if ip.startswith("127.") or ip.endswith(".255") or ip in found:
            continue
        found.append(ip)

    def rank(ip: str) -> tuple[int, str]:
        parts = [int(piece) for piece in ip.split(".")]
        if parts[0] == 192 and parts[1] == 168:
            score = 0
        elif parts[0] == 10:
            score = 1
        elif parts[0] == 172 and 16 <= parts[1] <= 31:
            score = 2
        elif parts[0] == 100 and 64 <= parts[1] <= 127:
            score = 8
        else:
            score = 5
        return score, ip

    return sorted(found, key=rank)


def lan_ip() -> str:
    ips = host_ips()
    return ips[0] if ips else "127.0.0.1"


def ensure_cert(ips: list[str]) -> tuple[Path, Path] | None:
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        return None

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    cert_path = CERT_DIR / "cert.pem"
    key_path = CERT_DIR / "key.pem"
    stamp = CERT_DIR / "ip.txt"
    stamp_value = ",".join(ips)
    if cert_path.exists() and key_path.exists() and stamp.exists() and stamp.read_text().strip() == stamp_value:
        return cert_path, key_path

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "turret")])
    now = datetime.datetime.now(datetime.timezone.utc)
    alt_names: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.DNSName("turret.local"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    for ip in ips:
        try:
            alt_names.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            continue
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    stamp.write_text(stamp_value)
    return cert_path, key_path


def make_handler(bridge: Bridge, camera: Camera, urls: dict):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/api/state":
                payload = bridge.snapshot()
                payload["camera"] = camera.status()
                payload["vr"] = urls
                self._json(200, payload)
                return
            if path == "/api/ports":
                self._json(200, {"ports": port_records()})
                return
            if path == "/api/camera.mjpg":
                self._mjpeg()
                return
            if path in ("/vr", "/vr/"):
                path = "/vr.html"
            agent = self.headers.get("User-Agent", "")
            if path in ("/", "/index.html") and ("OculusBrowser" in agent or "Quest" in agent):
                self.send_response(302)
                self.send_header("Location", "/vr")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self._file(path)

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length > 4000:
                self._json(413, {"error": "body too large"})
                return
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                self._json(400, {"error": "bad json"})
                return
            if path == "/api/command":
                cmd = str(payload.get("cmd", "")).strip()
                try:
                    bridge.submit(cmd)
                except ValueError:
                    self._json(400, {"error": f"rejected: {cmd}"})
                    return
                self._json(200, {"ok": True})
                return
            if path == "/api/connect":
                port = str(payload.get("port", "")).strip()
                if not re.fullmatch(r"COM\d+", port, flags=re.IGNORECASE):
                    self._json(400, {"error": "pick a COM port"})
                    return
                bridge.request_port(port.upper())
                self._json(200, {"ok": True, "port": port.upper()})
                return
            self._json(404, {"error": "not found"})

        def _file(self, path: str) -> None:
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            target = (ROOT / rel).resolve()
            try:
                target.relative_to(ROOT.resolve())
            except ValueError:
                self.send_error(404)
                return
            if not target.is_file():
                self.send_error(404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES.get(target.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Permissions-Policy", "xr-spatial-tracking=(self)")
            self.end_headers()
            self.wfile.write(data)

        def _mjpeg(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    frame = camera.latest()
                    if frame:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
                        self.wfile.write(frame)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
                return

        def _json(self, code: int, payload: dict) -> None:
            data = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt: str, *args) -> None:
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Turret X/Y bench controller")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--com", default="", help="Serial port, for example COM3")
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()

    ips = host_ips()
    ip = ips[0] if ips else "127.0.0.1"
    urls = {
        "local": f"http://127.0.0.1:{args.port}/vr",
        "lan": f"http://{ip}:{args.port}/vr",
        "https": None,
    }
    bridge = Bridge(args.com.upper() or None)
    camera = Camera()
    bridge.start()
    camera.start()
    handler = make_handler(bridge, camera, urls)
    server = ThreadingHTTPServer((HOST, args.port), handler)
    https = None
    pair = ensure_cert(ips or ["127.0.0.1"])
    if pair:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(pair[0], pair[1])
        try:
            https = ThreadingHTTPServer((HOST, args.https_port), handler)
            https.socket = context.wrap_socket(https.socket, server_side=True)
            urls["https"] = f"https://{ip}:{args.https_port}/vr"
            threading.Thread(target=https.serve_forever, daemon=True).start()
        except OSError as exc:
            print(f"HTTPS skipped: {exc}", flush=True)
            https = None

    print(f"Turret bench  http://127.0.0.1:{args.port}", flush=True)
    print(f"Quest VR      {urls['local']}", flush=True)
    if urls["https"]:
        print(f"Quest Wi-Fi   {urls['https']}", flush=True)
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}/vr")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        bridge.stop.set()
        server.server_close()
        if https:
            https.server_close()


if __name__ == "__main__":
    main()
