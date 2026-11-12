"""The cameras attached, for a camera's settings to be picked from.

Two kinds are looked for. The V4L2 cameras on this computer, as pcbv lists
them: it lists only the nodes that capture MJPG or YUYV, the two it reads,
so a camera's metadata node is not one. And the cameras a Raspberry Pi
streams to this computer's loopback: relay-pi forwards ustreamer's ports,
2325 and 2326 unless SPINNY_CAMERA_PORTS names others, and a ustreamer
answers `/state` with its picture's size and rate. A pcbv serving on one
of those ports, as a Pi ran before it only streamed, answers the same
request with a JSON line instead, and is listed as one.

A camera on this computer is named by its /dev/v4l/by-id link, which
survives a replug that renumbers the nodes. Identical cameras without
serial numbers share one by-id name, which udev points at whichever came
last, so when a camera of the same name has no by-id link of its own both
are named by /dev/v4l/by-path, the USB port they are plugged into.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

from .vision import VisionError, find_pcbv

# The ports relay-pi forwards a Pi's cameras to, unless the variable it
# reads names others (an empty one names none).
CAMERA_PORTS = (2325, 2326)
PORTS_VARIABLE = "SPINNY_CAMERA_PORTS"
LOOPBACK = "127.0.0.1"
# How long a port has to answer, s: a Pi on WiFi answers in about 70 ms, a
# port forwarded over ssh to nothing is closed at once.
PROBE_SECONDS = 1.5
# The most of an answer read, bytes: ustreamer's state is under a kilobyte.
PROBE_BYTES = 64 * 1024
# How long pcbv has to list the cameras, s.
LIST_SECONDS = 15.0
BY_ID = Path("/dev/v4l/by-id")
BY_PATH = Path("/dev/v4l/by-path")


def camera_ports(text: str | None = None) -> list[int]:
    """The ports streams are looked for on: the variable's, spaces or commas
    between them, or 2325 and 2326 when it is not set."""
    if text is None:
        text = os.environ.get(PORTS_VARIABLE)
    if text is None:
        return list(CAMERA_PORTS)
    ports: list[int] = []
    for word in text.replace(",", " ").split():
        try:
            port = int(word)
        except ValueError:
            continue
        if 0 < port < 65536 and port not in ports:
            ports.append(port)
    return ports


def links(folder: Path) -> dict[str, str]:
    """Each device node to its first link in a folder, in name order."""
    found: dict[str, str] = {}
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return found
    for entry in entries:
        try:
            target = str(entry.resolve())
        except OSError:
            continue
        found.setdefault(target, str(entry))
    return found


def modes_of(listed: object) -> list[dict]:
    """Each size once, with the best rate any of its formats gives, the
    largest size first."""
    best: dict[tuple[int, int], float] = {}
    for mode in listed if isinstance(listed, list) else []:
        try:
            width, height = int(mode["width"]), int(mode["height"])
            fps = float(mode.get("fps") or 0.0)
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if width > 0 and height > 0:
            best[(width, height)] = max(best.get((width, height), 0.0), fps)
    ordered = sorted(best.items(), key=lambda item: (-item[0][0] * item[0][1], -item[0][0]))
    return [{"size": f"{width}x{height}", "fps": round(fps, 2)} for (width, height), fps in ordered]


def _camera(device: str, names: list[str], name: str, kind: str, modes: list[dict], online: bool | None = None) -> dict:
    unique = list(dict.fromkeys([device, *names]))
    return {"device": device, "names": unique, "name": name, "kind": kind, "modes": modes, "online": online}


def local_cameras(
    pcbv: str,
    by_id: Path = BY_ID,
    by_path: Path = BY_PATH,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> tuple[list[dict], list[str]]:
    """The V4L2 cameras pcbv lists on this computer, and why none could be
    listed."""
    try:
        program = find_pcbv(pcbv)
    except VisionError as exc:
        return [], [f"the cameras on this computer cannot be listed: {exc}"]
    try:
        done = run([program, "cameras", "--json"], capture_output=True, timeout=LIST_SECONDS)
    except (OSError, subprocess.SubprocessError) as exc:
        return [], [f"pcbv could not list the cameras on this computer: {exc}"]
    if done.returncode != 0:
        said = (done.stderr or b"").decode("utf-8", errors="replace").strip().splitlines()
        return [], [f"pcbv could not list the cameras on this computer: {said[-1] if said else f'it ended with {done.returncode}'}"]
    try:
        listed = json.loads(done.stdout)
    except ValueError:
        listed = None
    if not isinstance(listed, list):
        return [], ["pcbv listed the cameras on this computer in something that is not a JSON list"]
    devices = [device for device in listed if isinstance(device, dict) and isinstance(device.get("path"), str)]
    ids, paths = links(by_id), links(by_path)

    def name_of(device: dict) -> str:
        return str(device.get("name") or device["path"])

    cameras = []
    for device in devices:
        node = device["path"]
        twins = [other for other in devices if name_of(other) == name_of(device)]
        shared = not all(ids.get(other["path"]) for other in twins)
        stable = (None if shared else ids.get(node)) or paths.get(node) or node
        others = [name for name in (ids.get(node), paths.get(node), node) if name]
        cameras.append(_camera(stable, others, name_of(device), "v4l2", modes_of(device.get("modes"))))
    return cameras, []


def _answer(host: str, port: int, timeout: float) -> bytes:
    """What a port says to a request for ustreamer's state, read until it
    closes, a JSON line is in, the time is up or the bytes are enough."""
    deadline = time.monotonic() + timeout
    data = b""
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.sendall(f"GET /state HTTP/1.0\r\nHost: {host}:{port}\r\n\r\n".encode("ascii"))
            while len(data) < PROBE_BYTES:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                sock.settimeout(left)
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
                # A pcbv answers every line and keeps the connection.
                if data.lstrip().startswith(b"{") and b"\n" in data:
                    break
    except OSError:
        pass
    return data


def _aliases(host: str, url: str) -> list[str]:
    return [url, url.replace(LOOPBACK, "localhost")] if host == LOOPBACK else [url]


def probe(host: str, port: int, timeout: float = PROBE_SECONDS) -> dict | None:
    """The camera behind a port: a ustreamer's stream, a pcbv serving, or
    None for nothing there, a connection closed unanswered (an ssh forward
    with nothing at the far end) or anything else."""
    data = _answer(host, port, timeout)
    if data.startswith(b"HTTP/"):
        return _stream(host, port, data)
    line = data.lstrip().split(b"\n", 1)[0]
    if line.startswith(b"{"):
        try:
            reply = json.loads(line)
        except ValueError:
            return None
        if isinstance(reply, dict) and ("error" in reply or "id" in reply):
            device = f"socket://{host}:{port}"
            return _camera(device, _aliases(host, device), f"pcbv serving on port {port}", "pcbv", [])
    return None


def _stream(host: str, port: int, data: bytes) -> dict | None:
    """A ustreamer from its answer to `/state`: its picture's size and the
    rate it captures at, and whether its camera gives pictures."""
    head, _, body = data.partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].split()
    if len(status) < 2 or status[1] != b"200":
        return None
    try:
        state = json.loads(body)
    except ValueError:
        return None
    result = state.get("result") if isinstance(state, dict) else None
    source = result.get("source") if isinstance(result, dict) else None
    if not isinstance(source, dict):
        return None
    modes = []
    resolution = source.get("resolution")
    if isinstance(resolution, dict):
        try:
            width, height = int(resolution.get("width", 0)), int(resolution.get("height", 0))
            fps = float(source.get("desired_fps") or 0.0)
        except (TypeError, ValueError):
            width = height = 0
            fps = 0.0
        if width > 0 and height > 0:
            modes = [{"size": f"{width}x{height}", "fps": round(fps, 2)}]
    online = source.get("online")
    device = f"http://{host}:{port}/snapshot"
    return _camera(device, _aliases(host, device), f"stream on port {port}", "stream", modes, online if isinstance(online, bool) else None)


def detect(pcbv: str, held: tuple[str, ...] = (), ports: list[int] | None = None, host: str = LOOPBACK) -> dict:
    """The cameras attached, those on this computer first, and why some
    could not be looked for. `held` are the devices this backend's cameras
    run on: a pcbv serving over TCP answers one client at a time, so one
    held here is listed without being asked."""
    ports = camera_ports() if ports is None else ports
    found: list[tuple[int, dict]] = []
    with ThreadPoolExecutor(max_workers=1 + max(1, len(ports))) as pool:
        local = pool.submit(local_cameras, pcbv)
        asked = []
        for port in ports:
            device = f"socket://{host}:{port}"
            # Held under either name the loopback goes by.
            if any(name in held for name in _aliases(host, device)):
                found.append((port, _camera(device, _aliases(host, device), f"pcbv serving on port {port}", "pcbv", [])))
            else:
                asked.append((port, pool.submit(probe, host, port)))
        cameras, problems = local.result()
        for port, answer in asked:
            camera = answer.result()
            if camera is not None:
                found.append((port, camera))
    found.sort(key=lambda item: item[0])
    return {"cameras": cameras + [camera for _, camera in found], "problems": problems}


# --- a camera's controls ----------------------------------------------------------------
#
# A V4L2 camera on this computer has controls (exposure, gain, focus, white
# balance, brightness and the like) that v4l2-ctl lists and sets, also
# while pcbv streams from it: `--list-ctrls-menus` prints each control on a
# line, `name 0xID (type) : min=.. max=.. step=.. default=.. value=..
# flags=..`, a menu's items on the lines under it, and a heading line over
# each class of controls. A camera reached over HTTP (a bridge Pi's
# snapshots) or a pcbv serving over TCP has none here: its controls are its
# own computer's.

# How long v4l2-ctl has for a listing or a setting, s.
CONTROL_SECONDS = 5.0
# The kinds of control the page can show and set: a number, a switch, a menu.
CONTROL_KINDS = ("int", "bool", "menu", "intmenu")
# Flags that say a control cannot be set now.
FIXED_FLAGS = ("read-only", "disabled", "grabbed")
_CONTROL = re.compile(r"^\s*(?P<name>[a-z0-9_]+)\s+0x[0-9a-f]+\s+\((?P<kind>[a-z0-9]+)\)\s*:\s*(?P<rest>.*)$")
_MENU_ITEM = re.compile(r"^\s+(?P<value>-?\d+):\s*(?P<label>.*?)\s*$")
_FIELD = re.compile(r"\b(min|max|step|default|value)=(-?\d+)")


class ControlsError(Exception):
    """v4l2-ctl is not there, or refused."""


def local_device(device: str) -> bool:
    """Whether a camera's device is a V4L2 node on this computer, the kind
    whose controls v4l2-ctl reaches."""
    return device.startswith("/dev/")


def _v4l2(args: list[str]) -> str:
    """v4l2-ctl run with `args`: what it printed, or a ControlsError."""
    program = shutil.which("v4l2-ctl")
    if program is None:
        raise ControlsError("v4l2-ctl is not installed: install v4l-utils to set a camera's controls")
    try:
        done = subprocess.run([program, *args], capture_output=True, timeout=CONTROL_SECONDS)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ControlsError(f"v4l2-ctl failed: {exc}") from exc
    if done.returncode != 0:
        said = (done.stderr or done.stdout or b"").decode("utf-8", errors="replace").strip().splitlines()
        raise ControlsError(f"v4l2-ctl: {said[-1] if said else f'it ended with {done.returncode}'}")
    return done.stdout.decode("utf-8", errors="replace")


def parse_controls(text: str) -> list[dict]:
    """The controls of a `--list-ctrls-menus` listing that the page can
    set: `name`, `section` (the heading it is under), `kind` (`int`,
    `bool`, `menu`, `intmenu`), `min`, `max`, `step`, `default`, `value`,
    `inactive` (it does nothing while another control, such as automatic
    exposure, is on), and for a menu its `items` ({value, label})."""
    controls: list[dict] = []
    section = ""
    current: dict | None = None
    for line in text.splitlines():
        if not line.strip():
            continue
        match = _CONTROL.match(line)
        if match:
            current = None
            kind = match.group("kind")
            rest = match.group("rest")
            flags = [flag.strip() for flag in rest.split("flags=", 1)[1].split(",")] if "flags=" in rest else []
            if kind not in CONTROL_KINDS or any(flag in FIXED_FLAGS for flag in flags):
                continue
            fields = {key: int(value) for key, value in _FIELD.findall(rest)}
            if "value" not in fields:
                continue
            control = {
                "name": match.group("name"),
                "section": section,
                "kind": kind,
                "min": fields.get("min", 0),
                "max": fields.get("max", 1),
                "step": max(1, fields.get("step", 1)),
                "default": fields.get("default", fields["value"]),
                "value": fields["value"],
                "inactive": "inactive" in flags,
            }
            if kind in ("menu", "intmenu"):
                control["items"] = []
            controls.append(control)
            current = control
            continue
        item = _MENU_ITEM.match(line)
        if item and current is not None and "items" in current:
            current["items"].append({"value": int(item.group("value")), "label": item.group("label")})
            continue
        if not line.startswith((" ", "\t")):
            section = line.strip()
            current = None
    return controls


def list_controls(device: str) -> list[dict]:
    """The controls a V4L2 camera on this computer has, as it is set now."""
    return parse_controls(_v4l2(["-d", device, "--list-ctrls-menus"]))


def set_controls(device: str, values: dict[str, int]) -> list[str]:
    """Sets controls on a V4L2 camera on this computer, the automatic ones
    first (a manual exposure is taken only once automatic exposure is
    off), each on its own so one refused does not keep the others: what
    was refused, each with v4l2-ctl's reason."""
    refused: list[str] = []
    for name in sorted(values, key=lambda key: (0 if "auto" in key else 1, key)):
        try:
            _v4l2(["-d", device, "-c", f"{name}={int(values[name])}"])
        except ControlsError as exc:
            refused.append(f"{name}: {exc}")
    return refused


_CONTROL_NAME = re.compile(r"^[a-z0-9_]{1,64}$")


def check_controls(controls: dict) -> None:
    """Kept control values: names as v4l2-ctl prints them, whole numbers."""
    if len(controls) > 64:
        raise ValueError("a camera keeps at most 64 control values")
    for name, value in controls.items():
        if not isinstance(name, str) or not _CONTROL_NAME.match(name):
            raise ValueError(f"{name!r} is not a camera control's name")
        if isinstance(value, bool) or not isinstance(value, int) or abs(value) > 2**31:
            raise ValueError(f"the control {name} takes a whole number")


def controls_note(device: str) -> str | None:
    """Why a camera's device has no controls here; None for one that has."""
    if local_device(device):
        return None
    if device.startswith(("http://", "https://")):
        return "a camera reached over HTTP (a bridge Pi's snapshots) has no controls here: they are set on the computer it is plugged into"
    if device.startswith("socket://"):
        return "a pcbv serving over TCP has no controls here: its camera's are set on the computer it runs on"
    return "pictures replayed from files have no controls"


def apply_kept(device: str, controls: dict[str, int]) -> str | None:
    """Sets the control values a camera keeps on its device, as it starts:
    what went wrong, or None."""
    if not controls or not local_device(device):
        return None
    try:
        refused = set_controls(device, controls)
    except ControlsError as exc:
        return str(exc)
    return "; ".join(refused) if refused else None
