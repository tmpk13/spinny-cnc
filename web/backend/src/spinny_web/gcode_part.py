"""The backend's G-code machine part: the connection to a machine whose
machine file says `controller = "gcode"` (a pick and place machine's own
Marlin, Smoothieware, RepRapFirmware or Grbl), opened from the top bar
like any other, and the page's readout, jog, goto, position, home, stop,
motors and console on it.

Its joints are the cartesian machine's: r is X, z is Y, h is Z (the
nozzle's height) and a the rotation axis as the controller counts it, so
the readout, the jog panel and the goto rows serve it unchanged. The head's
place is read with the file's position command (M114) at the connect,
about once a second while nothing else is in flight, and before every
jog: Marlin answers with where the queued moves end, so jogs pressed
quickly add up. A jog is queued and answered at once; a goto rises to the
safe height only when it goes across, puts the height last, and is
answered once its moves have run (the file's wait command). A stop is the
file's stop (M410), sent ahead of anything in flight.

Backend is made of this part and its others: the methods use the
backend's state and publishing as theirs.
"""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING

from fastapi import HTTPException

from spinny_laser.machines import GCODE

from .gcode_link import IDENTIFY, GcodeLinkError, firmware_of
from .kinematics import check_feed, num
from .log import log, wire_line, wire_note
from .openpnp import LINE as GCODE_LINE
from .openpnp import AXIS_NAMES, GcodeMachine, goto_lines, lifts_leaving, move_line, read_position, safe_line

if TYPE_CHECKING:
    from .app import GotoBody, JogBody, PositionBody

# How often the head's place is read while the machine is left alone, s.
POLL_SECONDS = 1.0
# A jog's step and a goto's place, at most: mm (degrees for the turn).
STEP_LIMIT = 1000.0
TURN_LIMIT = 3600.0
PLACE_LIMIT = 10000.0
# The page's joints to the controller's axes, by openpnp's names.
JOINTS = {"r": "x", "z": "y", "h": "z", "a": "rotation"}
# How long a home may take, in the file's line timeouts.
HOME_TIMEOUTS = 3


class GcodePart:
    """The G-code machine's connection and its controls, mixed into Backend."""

    # --- which machine -----------------------------------------------------------

    def gcode_connected(self) -> bool:
        return self.gcode.connected

    def gcode_machine(self) -> GcodeMachine:
        """The connected G-code machine's file, read afresh; 409 with none connected."""
        machine_id = self._gcode_id
        if not self.gcode.connected or machine_id is None:
            raise HTTPException(status_code=409, detail="no G-code machine is connected: connect one from the top bar")
        return self.machine_store.gcode(machine_id)

    def gcode_claimant(self, url: str, names: str = "") -> str | None:
        """The G-code machine file whose port `url` is: its own url, or the
        port's USB names (`names`) holding one of its words; None for a port
        no G-code machine claims, which is this project's firmware's."""
        machines, _ = self.machine_store.list()
        for machine in machines:
            if machine.controller != GCODE:
                continue
            try:
                gcode = self.machine_store.gcode(machine.id)
            except (ValueError, LookupError):
                continue
            if gcode.claims(url, names):
                return machine.id
        return None

    def _port_names(self, url: str) -> str:
        """The USB names of the listed port at `url`, for matching a file's words; empty for a port not listed."""
        for port in self.ports(claims=False)["ports"]:
            if url in (port.get("url"), port.get("device")):
                return " ".join(str(port.get(key) or "") for key in ("product", "manufacturer", "description", "url", "device"))
        return ""

    # --- the connection ------------------------------------------------------------

    def _gcode_connect(self, url: str, machine_id: str) -> dict:
        """Opens the port as the machine `machine_id` describes: the file's
        baud, its wait for a board that resets as its port opens, its init
        lines; then asks the firmware what it is and where the head is."""
        machine = self.machine_store.gcode(machine_id)
        with self._lock:
            if self.gcode.connected and self.gcode.url == url and self._gcode_id == machine_id:
                return self.snapshot()
            self._close_link()
            self._close_gcode()
            self._gcode_id = machine_id
            try:
                self.gcode.connect(url, machine.baud, machine.wait_ms, machine.init, machine.timeout)
            except GcodeLinkError:
                self._gcode_id = None
                raise
            self.url = url
            self.config["last_url"] = url
            self.config["placing_machine"] = machine_id
            self._save_config()
            self.autoconnect_paused = False
        wire_note(f"link opened: {url} as {machine_id}, G-code")
        log.info("G-code link opened: %s as %s", url, machine_id)
        try:
            self.gcode.firmware = firmware_of(self.gcode.command(IDENTIFY, 5.0)).get("firmware")
        except GcodeLinkError:
            # Grbl and others do not take M115: the machine is still there.
            pass
        try:
            self._gcode_position(machine)
        except (GcodeLinkError, ValueError) as exc:
            self.publish_message("error", f"{machine.name}: the head's place could not be read: {exc}")
        firmware = f", {self.gcode.firmware}" if self.gcode.firmware else ""
        self.publish_message("info", f"connected to {url}: {machine.name}{firmware}")
        self._start_gcode_poll()
        self.publish_placing()
        return self.snapshot()

    def _close_gcode(self) -> None:
        """Lets the G-code machine's port go: a placing run on it is stopped
        first, after the line in flight."""
        if self.gcode.url is None and not self.gcode.connected:
            self._gcode_id = None
            return
        if self.gcode.running:
            self._stop_gcode()
        self.gcode.disconnect()
        wire_note("link closed: disconnected")
        self._gcode_id = None

    def _gcode_lost(self, reason: str) -> None:
        """The machine's port failed on its own."""
        wire_note(f"link closed: {reason}")
        self.publish_message("error", f"link closed: {reason}")
        self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})

    def _gcode_line(self, direction: str, text: str, poll: bool) -> None:
        """A line over the G-code link, to the wire log and the console."""
        wire_line(direction, text, poll)
        self.broadcast.publish_threadsafe({"type": "console", "dir": direction, "text": text, "poll": poll})

    def _start_gcode_poll(self) -> None:
        if self.gcode_poll_seconds <= 0:
            return
        thread = threading.Thread(target=self._gcode_poll_loop, args=(self.gcode.url,), name="gcode-poll", daemon=True)
        thread.start()

    def _gcode_poll_loop(self, url: str | None) -> None:
        """Reads the head's place every `gcode_poll_seconds` while the
        machine stays connected at `url` and nothing else is in flight."""
        while self.gcode.connected and self.gcode.url == url:
            time.sleep(self.gcode_poll_seconds)
            if not self.gcode.connected or self.gcode.url != url or self.gcode.running:
                continue
            try:
                machine = self.machine_store.gcode(self._gcode_id) if self._gcode_id else None
            except (ValueError, LookupError):
                machine = None
            if machine is None or not machine.position:
                continue
            try:
                reply = self.gcode.poll(machine.position, machine.timeout)
            except GcodeLinkError:
                continue
            if reply is None:
                continue
            position = read_position(reply, machine.axes)
            if position and position != self.gcode.position:
                self.gcode.position = {**(self.gcode.position or {}), **position}
                self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})

    # --- what the page shows -----------------------------------------------------------

    def _gcode_snapshot(self) -> dict:
        """The snapshot of a G-code machine: its place as the readout's
        joints, its state, and its firmware's name."""
        name = self._gcode_id or "G-code machine"
        try:
            machine = self.machine_store.gcode(self._gcode_id) if self._gcode_id else None
            name = machine.name if machine is not None else name
        except (ValueError, LookupError):
            machine = None
        connected = self.gcode.connected
        state = None
        if connected:
            position = self.gcode.position or {}
            x = float(position.get("x", 0.0))
            y = float(position.get("y", 0.0))
            z = position.get("z")
            if self.gcode.running or self.pnp.routine_active or self.top.routine_active:
                busy = "Run"
            else:
                busy = self.gcode.busy or "Idle"
            state = {
                "state": busy,
                "alarm": None,
                "joint": {"r": x, "a": float(position.get("rotation", 0.0)), "z": y, "h": float(z) if z is not None else None},
                "probe": None,
                "homed": None,
                "board": {"x": round(x, 4), "y": round(y, 4)},
                "rate": 0.0,
                "laser": 0,
                "mode": "dyn",
                "enabled": self.gcode.motors,
                "queue": {"planner": 0, "lines": 0},
                "age": 0.0,
            }
        firmware = self.gcode.firmware
        return {
            "connected": connected,
            "url": self.url,
            "firmware": {"version": firmware or "", "lines": 1, "blocks": 0, "name": firmware or name} if connected else None,
            "machine": state,
            "profile": {
                "kinematics": "cartesian",
                "tool": "nozzle",
                "h_axis": True,
                "r_max": 0.0,
                "z_max": 0.0,
                "controller": GCODE,
                "machine": self._gcode_id,
                "name": name,
            },
            "run": None,
            "resume": None,
            "position": None,
        }

    def _gcode_settings(self) -> dict:
        """What the page's settings request gets for a G-code machine: none of
        this project's firmware settings, the file and its controls."""
        machine = self.gcode_machine()
        return {
            "values": {},
            "schema": [],
            "host": self.host_settings(),
            "machine": machine.id,
            "unsaved": [],
            "controls_from": machine.id,
            "controls": machine.controls,
            "controller": GCODE,
        }

    # --- moving -----------------------------------------------------------------------

    def _gcode_movable(self) -> GcodeMachine:
        """The machine, for a request that moves its head; refused while a
        placing run or a camera routine moves it."""
        machine = self.gcode_machine()
        if self.gcode.running:
            raise HTTPException(status_code=409, detail="a placing run is under way")
        if self.pnp.routine_active:
            raise HTTPException(status_code=409, detail="the up camera routine is moving the head")
        if self.top.routine_active:
            raise HTTPException(status_code=409, detail="the top camera routine is moving the head")
        return machine

    def _gcode_position(self, machine: GcodeMachine) -> dict:
        """The head's place as the controller reports it (Marlin: where the
        queued moves end), kept as the link's."""
        if not machine.position:
            raise ValueError(f"{machine.name}'s file has no [gcode] position command")
        reply = self.gcode.command(machine.position, machine.timeout)
        position = read_position(reply, machine.axes)
        if "x" not in position or "y" not in position:
            raise GcodeLinkError(f"'{machine.position}' answered no {machine.axes[0]} and {machine.axes[1]}: {' | '.join(reply)}")
        self.gcode.position = position
        return dict(position)

    def _gcode_jog(self, body: JogBody) -> dict:
        check_feed(body.feed)
        if body.kind == "joint":
            steps = {JOINTS[joint]: getattr(body, f"d{joint}") for joint in ("r", "z", "h", "a")}
        elif body.kind == "board":
            steps = {"x": body.dx, "y": body.dy}
        else:
            raise ValueError("kind must be joint or board")
        steps = {name: float(value) for name, value in steps.items() if value}
        if not steps:
            raise ValueError("a jog moves at least one axis")
        for name, value in steps.items():
            limit = TURN_LIMIT if name == "rotation" else STEP_LIMIT
            if abs(value) > limit:
                raise ValueError(f"a jog's step is at most {limit:g} {'degrees' if name == 'rotation' else 'mm'} either way")
        with self._move_lock:
            machine = self._gcode_movable()
            here = self._gcode_position(machine)
            missing = [name for name in steps if name not in here]
            if missing:
                letter = machine.axes[AXIS_NAMES.index(missing[0])]
                raise GcodeLinkError(f"'{machine.position}' answered no {letter}: it cannot be jogged from where it is")
            target = {name: here[name] + value for name, value in steps.items()}
            feed = body.feed if body.feed is not None and set(target) & {"x", "y"} else None
            lines = [move_line(machine, target, feed)]
            # Leaving the up camera with the nozzle down near its lens goes
            # up first, when the file asks for it.
            if lifts_leaving(machine, here, target, self._up_place(machine).position):
                lines.insert(0, safe_line(machine))
                here = {**here, "z": machine.safe_z}
            for line in lines:
                self.gcode.command(line, machine.timeout)
            self.gcode.position = {**here, **{name: round(value, 4) for name, value in target.items()}}
        self._publish_gcode_state()
        return {"lines": lines}

    def _gcode_goto(self, body: GotoBody) -> dict:
        check_feed(body.feed)
        if body.kind == "joint":
            want = {JOINTS[joint]: getattr(body, joint) for joint in ("r", "z", "h", "a")}
        elif body.kind == "board":
            if body.x is None and body.y is None:
                raise ValueError("a board goto needs x and/or y")
            want = {"x": body.x, "y": body.y}
        else:
            raise ValueError("kind must be joint or board")
        want = {name: float(value) for name, value in want.items() if value is not None}
        if not want:
            raise ValueError("give at least one axis to go to")
        for name, value in want.items():
            limit = TURN_LIMIT if name == "rotation" else PLACE_LIMIT
            if abs(value) > limit:
                raise ValueError(f"a place is within {limit:g} {'degrees' if name == 'rotation' else 'mm'} of 0")
        with self._move_lock:
            machine = self._gcode_movable()
            here = self._gcode_position(machine)
            lines = goto_lines(machine, here, want, body.feed)
            self._gcode_run_lines(machine, lines, "Jog")
            # At rest now: where it stopped, the safe height included when
            # it went across.
            self._gcode_position(machine)
        self._publish_gcode_state()
        return {"lines": lines}

    def _gcode_run_lines(self, machine: GcodeMachine, lines: list[str], state: str, timeout: float | None = None) -> None:
        """Lines sent one after another, then the file's wait, with the state
        the page shows while they run."""
        if not lines:
            return
        self.gcode.busy = state
        self._publish_gcode_state()
        try:
            for line in lines:
                self.gcode.command(line, timeout or machine.timeout)
            if machine.wait:
                self.gcode.command(machine.wait, timeout or machine.timeout)
        finally:
            self.gcode.busy = None

    def _gcode_set_position(self, body: PositionBody) -> dict:
        """Declares where the head is (G92), as the zero buttons and Set
        position do on any machine."""
        given = {JOINTS[joint]: getattr(body, joint) for joint in ("r", "z", "h", "a")}
        given = {name: float(value) for name, value in given.items() if value is not None}
        if not given:
            raise ValueError("give r, a, h and/or z")
        with self._move_lock:
            machine = self._gcode_movable()
            words = [f"{machine.axes[AXIS_NAMES.index(name)]}{num(value)}" for name, value in given.items()]
            self.gcode.command("G92 " + " ".join(words), machine.timeout)
            self._gcode_position(machine)
        return self._publish_gcode_state()

    def _gcode_home(self, axes: str) -> dict:
        """The file's home line (G28), with the axes named when some are:
        R, Z, H and A as the cartesian machine's joints, X, Y, Z and the
        rotation axis to the controller."""
        letters = []
        for word in axes.split():
            joint = word.rstrip("+-").lower()
            if joint not in JOINTS:
                raise ValueError(f"not an axis to home: {word!r}; give R, A, H or Z")
        with self._move_lock:
            machine = self._gcode_movable()
            if not machine.home:
                raise ValueError(f"{machine.name}'s file has no [gcode] home command")
            for word in axes.split():
                letters.append(machine.axes[AXIS_NAMES.index(JOINTS[word.rstrip("+-").lower()])])
            line = " ".join([machine.home, *letters])
            self.gcode.busy = "Home"
            self._publish_gcode_state()
            try:
                self.gcode.command(line, machine.timeout * HOME_TIMEOUTS)
            finally:
                self.gcode.busy = None
            self.gcode.homed = True
            self._gcode_position(machine)
        return self._publish_gcode_state()

    def _gcode_realtime(self, action: str) -> dict:
        """The console's and the jog panel's realtime buttons: a reset or a
        jog cancel stops the machine (the file's stop, ahead of anything in
        flight, and a placing run after its line in flight); a status reads
        the head's place. A G-code machine has no hold to resume from."""
        machine = self.gcode_machine()
        if action in ("reset", "cancel"):
            for camera in (self.pnp, self.top):
                if camera.routine_active:
                    camera.abort()
            self.gcode.stop(machine.stop)
        elif action == "status":
            if not self.gcode.running:
                self._gcode_position(machine)
        elif action in ("hold", "resume"):
            raise ValueError(f"{machine.name} takes no hold: Stop stops it ({machine.stop or 'no stop line in its file'})")
        else:
            raise ValueError("action must be hold, resume, reset, cancel or status")
        return self._publish_gcode_state()

    def _gcode_command(self, line: str) -> dict:
        """A console line as typed, and its answer."""
        text = line.strip()
        if not text or not GCODE_LINE.match(text):
            raise ValueError("a line is one line of printable ASCII")
        machine = self.gcode_machine()
        if self.gcode.running:
            raise HTTPException(status_code=409, detail="a placing run is under way: its lines go out one at a time")
        reply = self.gcode.command(text, machine.timeout)
        return {"lines": reply}

    def _gcode_motors(self, enabled: bool) -> dict:
        machine = self._gcode_movable()
        line = machine.motors_on if enabled else machine.motors_off
        if not line:
            raise ValueError(f"{machine.name}'s file has no [gcode] motors_{'on' if enabled else 'off'} line")
        self.gcode.command(line, machine.timeout)
        self.gcode.motors = enabled
        return self._publish_gcode_state()

    def _publish_gcode_state(self) -> dict:
        snapshot = self.snapshot()
        self.broadcast.publish_threadsafe({"type": "state", **snapshot})
        return snapshot
