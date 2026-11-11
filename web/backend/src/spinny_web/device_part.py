"""The backend's G-code device part: a pick and place machine of its own
on a port, its profile picked and its port, the board's references on it,
its moves by hand, its up camera place and runout, its top camera's
settings and routines, its lights and vacuum, and placing a job's parts
on it (placer.py's run on the device's link). Backend is made of this part,
the probing part and its own: the methods use the backend's state and
publishing as theirs."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import HTTPException

from .backend_shared import _check_frame_width, _check_port
from .gcode_device import DeviceLinkError, DeviceMover
from .kinematics import num
from .openpnp import LINE as GCODE_LINE
from .openpnp import Device, Plan, board_fit, board_goto, move_xy, move_z, plan, read_position, safe_line
from .openpnp import NotFound as DeviceNotFound
from .placer import Placement, PlaceSetup, fiducial_fit
from .pnp import CameraPlace
from .topcam import Found

if TYPE_CHECKING:
    from .app import (
        DeviceCameraBody,
        DeviceFeederBody,
        DeviceFiducialsBody,
        DeviceGotoBody,
        DeviceJogBody,
        DeviceMoveBody,
        DevicePlanBody,
        DeviceReferenceBody,
        DeviceSelectBody,
        DeviceSwapBody,
        DeviceVacuumBody,
        TopSettingsBody,
    )


class DevicePart:
    """The G-code device's methods, mixed into Backend."""

    def _device_config(self) -> dict:
        """What the backend keeps of the G-code device: the profile picked,
        the board's references on it per job, a typed turn, and how many
        parts each feeder has given."""
        value = self.config.get("pnp_device")
        if not isinstance(value, dict):
            value = {}
            self.config["pnp_device"] = value
        return value

    def device_profile(self) -> Device:
        chosen = self._device_config().get("profile")
        if not isinstance(chosen, str):
            raise ValueError("no device profile is picked: pick one of pnp/*.toml")
        return self.pnp_devices.get(chosen)

    def device_state(self) -> dict:
        config = self._device_config()
        try:
            camera = self._device_camera_place(self.device_profile())
        except (ValueError, DeviceNotFound):
            camera = self._device_camera_place(None)
        port = config.get("url")
        return {
            "profile": config.get("profile"),
            "port": port if isinstance(port, str) and port else None,
            "angle": config.get("angle"),
            "references": [dict(entry) for entry in config.get("references", [])],
            "taken": dict(config.get("taken", {})),
            "boards": int(config.get("boards", 0)) if isinstance(config.get("boards", 0), int) else 0,
            "camera": {**camera.to_dict(), "measured": isinstance(config.get("camera"), dict) and bool(config["camera"].get("position"))},
            "top": self.top.state(),
            **self.pnp_device.state(),
        }

    def _device_camera_place(self, device: Device | None) -> CameraPlace:
        """Where the up camera sits on the device, as centering the nozzle
        over it measured (or the profile has it, until then), at the height
        the profile says the nozzle is sharp at."""
        kept = self._device_config().get("camera")
        kept = kept if isinstance(kept, dict) else {}
        position = kept.get("position")
        if not (isinstance(position, list) and len(position) == 2) and device is not None and device.camera_position is not None:
            position = list(device.camera_position)
        runout = kept.get("runout")
        try:
            return CameraPlace(
                position=(float(position[0]), float(position[1])) if isinstance(position, list) and len(position) == 2 else None,
                height=device.camera_z if device is not None else None,
                mm_per_px=float(kept.get("mm_per_px", 0.0)),
                roll=float(kept.get("roll", 0.0)),
                mirror=bool(kept.get("mirror", True)),
                runout=(float(runout[0]), float(runout[1])) if isinstance(runout, list) and len(runout) == 2 else None,
            )
        except (TypeError, ValueError):
            return CameraPlace(height=device.camera_z if device is not None else None)

    def _keep_device_camera(self, place: CameraPlace) -> None:
        kept = place.to_dict()
        # The height is the profile's camera_z, read from it every time.
        del kept["height"]
        self._device_config()["camera"] = kept
        self._save_config()
        self.publish_pnp_device()

    def device_nozzle(self, step: float) -> dict:
        """Centers the device's nozzle over the up camera, measuring where
        the camera is on the device and how its picture lies against the
        device's moves; on the up camera's routine thread."""
        device = self._device_idle()
        mover = DeviceMover(self.pnp_device, device, aborted=self.pnp.aborting)
        self.pnp.center_nozzle(mover, step, place=self._device_camera_place(device), keep=self._keep_device_camera)
        return self.device_state()

    def device_runout(self) -> dict:
        """Measures how far the device's nozzle tip runs off its turning
        axis, over the up camera; on the up camera's routine thread."""
        device = self._device_idle()
        mover = DeviceMover(self.pnp_device, device, aborted=self.pnp.aborting)
        self.pnp.measure_runout(mover, self._device_camera_place(device), self._keep_device_camera, device.rotation_cw)
        return self.device_state()

    # --- the device's top camera ---

    def top_settings(self, body: TopSettingsBody) -> dict:
        try:
            self.top.update(body.model_dump(exclude={"clear"}, exclude_none=True), tuple(body.clear))
        finally:
            state = self.publish_pnp_device()
        return state

    def top_start(self) -> dict:
        try:
            self.top.start()
        finally:
            state = self.publish_pnp_device()
        return state

    def top_stop(self) -> dict:
        self.top.stop()
        return self.publish_pnp_device()

    def top_frame(self, width: int, overlay: bool) -> bytes:
        _check_frame_width(width)
        return self.top.frame(width, overlay)

    def top_mark(self) -> dict:
        """The nozzle's tip is over the mark the offset is measured from: its place is kept."""
        self.device_position()
        position = self.pnp_device.position or {}
        self.top.update({"mark_at": (float(position["x"]), float(position["y"]))})
        return self.publish_pnp_device()

    def top_offset(self, step: float) -> dict:
        device = self._device_idle()
        mover = DeviceMover(self.pnp_device, device, aborted=self.top.aborting)
        profile = device.top
        self.top.measure_offset(mover, step, profile.z if profile is not None else None, profile.offset if profile is not None else None)
        return self.device_state()

    def top_abort(self) -> dict:
        self.top.abort()
        # The routine waits on a move and its wait command: the device is
        # told to stop at once.
        self._stop_device()
        return self.device_state()

    def device_fiducials(self, body: DeviceFiducialsBody) -> dict:
        """Finds the board's fiducials with the top camera where the
        references put them and keeps them as the job's references; on the
        top camera's routine thread."""
        device = self._device_idle()
        if device.top is None:
            raise ValueError("the device profile has no [top_camera] section")
        top = device.top
        parts = self.job_parts(body.job)["components"]
        fiducials = [part for part in parts if part.get("fiducial")]
        guess = self._device_fit(body.job, parts)
        mover = DeviceMover(self.pnp_device, device, aborted=self.top.aborting)

        def done(found: list[Found]) -> str:
            fit = fiducial_fit(found, guess.rotation)
            self._keep_fiducials(body.job, found, fit)
            rms = f", {fit.rms * 1000.0:.0f} um rms" if len(found) > 1 else ""
            return f"{len(found)} fiducials found: the board is turned {fit.rotation:+.3f} degrees on the device{rms}"

        self.top.find_fiducials(mover, fiducials, guess.apply, top.fiducial, top.within, top.z, done)
        return self.device_state()

    def _keep_fiducials(self, job_id: str, found: list[Found], fit) -> None:
        """The fiducials found become the job's references: with two or
        more, the ones given by hand give way to them."""
        with self._config_lock:
            config = self._device_config()
            refs = {entry.ref for entry in found}
            kept = [
                entry for entry in config.get("references", [])
                if not (entry.get("job") == job_id and (entry.get("ref") in refs or (len(found) > 1 and entry.get("by") != "fiducial")))
            ]
            kept.extend({"job": job_id, "ref": entry.ref, "at": [entry.seen[0], entry.seen[1]], "by": "fiducial"} for entry in found)
            config["references"] = kept
        self.top.fiducials = {
            "job": job_id,
            "found": [{"ref": entry.ref, "at": [entry.seen[0], entry.seen[1]]} for entry in found],
            "fit": fit.to_dict(),
        }
        self._save_config()
        self.publish_pnp_device()

    def device_select(self, body: DeviceSelectBody) -> dict:
        config = self._device_config()
        if body.profile is not None:
            if self.pnp_device.connected and body.profile != config.get("profile"):
                raise HTTPException(status_code=409, detail="disconnect the device before picking another profile")
            self.pnp_devices.get(body.profile)
            config["profile"] = body.profile
        if body.clear_angle:
            config.pop("angle", None)
        elif body.angle is not None:
            if abs(body.angle) > 360.0:
                raise ValueError("the board's turn must be within 360 degrees")
            config["angle"] = body.angle
        if body.url is not None:
            url = body.url.strip()
            if self.pnp_device.connected and url != (config.get("url") or ""):
                raise HTTPException(status_code=409, detail="disconnect the device before picking another port")
            if url:
                _check_port(url)
                if self.link is not None and self.link.is_open and self.link.url == url:
                    raise ValueError(f"{url} is this machine's own port")
                config["url"] = url
            else:
                config.pop("url", None)
        self._save_config()
        return self.publish_pnp_device()

    def _device_idle(self) -> Device:
        if self.pnp_device.running:
            raise HTTPException(status_code=409, detail="a program is being sent to the device")
        if self.pnp.routine_active and self.pnp.target == "device":
            raise HTTPException(status_code=409, detail="the up camera routine is moving the device")
        if self.top.routine_active:
            raise HTTPException(status_code=409, detail="the top camera routine is moving the device")
        return self.device_profile()

    def device_url(self, device: Device) -> str:
        """The port the device is talked to on: the one picked in the panel, else the profile's."""
        picked = self._device_config().get("url")
        return picked if isinstance(picked, str) and picked else device.url

    def device_connect(self) -> dict:
        device = self.device_profile()
        url = self.device_url(device)
        if url and self.link is not None and self.link.is_open and self.link.url == url:
            raise ValueError(f"{url} is this machine's own port: pick the device's")
        self.pnp_device.connect(url, device.baud, device.wait_ms, device.init, device.timeout)
        return self.device_state()

    def device_identify(self, url: str) -> dict:
        """What the firmware on a port says it is (M115), the port opened only
        for the question; the device's own port is asked over its link, and
        this machine's is never opened."""
        url = url.strip()
        _check_port(url)
        if self.link is not None and self.link.is_open and self.link.url == url:
            raise ValueError(f"{url} is this machine's own port")
        if self.pnp_device.connected and self.pnp_device.url == url:
            from .gcode_device import IDENTIFY, firmware_of

            self._device_idle()
            reply = self.pnp_device.command(IDENTIFY, 5.0)
            return {"url": url, "lines": reply, **firmware_of(reply)}
        try:
            baud = self.device_profile().baud
        except (ValueError, DeviceNotFound):
            baud = 115200
        return self.pnp_device.identify(url, baud)

    def device_disconnect(self) -> dict:
        if self.pnp_device.running:
            raise HTTPException(status_code=409, detail="a program is being sent to the device: stop it first")
        self.pnp_device.disconnect()
        return self.device_state()

    def device_command(self, line: str) -> dict:
        device = self._device_idle()
        if not GCODE_LINE.match(line) or not line.strip():
            raise ValueError("a line is one line of printable ASCII")
        reply = self.pnp_device.command(line, device.timeout)
        return {"reply": reply, **self.publish_pnp_device()}

    def device_home(self) -> dict:
        device = self._device_idle()
        if not device.home:
            raise ValueError("the device profile has no home command")
        self.pnp_device.command(device.home, device.timeout * 3)
        self.pnp_device.homed = True
        return self.publish_pnp_device()

    def device_position(self) -> dict:
        device = self._device_idle()
        if not device.position:
            raise ValueError("the device profile has no position command")
        reply = self.pnp_device.command(device.position, device.timeout)
        position = read_position(reply, device.axes)
        if "x" not in position or "y" not in position:
            raise DeviceLinkError(f"'{device.position}' answered no {device.axes[0]} and {device.axes[1]}: {' | '.join(reply)}")
        self.pnp_device.position = position
        return self.publish_pnp_device()

    def _part(self, job_id: str, ref: str, parts: list[dict] | None = None) -> dict:
        """The part `ref` of a job's board, from `parts` when the job's
        parts are read already; 404 for one the board lacks."""
        if parts is None:
            parts = self.job_parts(job_id)["components"]
        part = next((entry for entry in parts if entry["ref"] == ref), None)
        if part is None:
            raise HTTPException(status_code=404, detail=f"the job has no part {ref!r}")
        return part

    def device_reference(self, body: DeviceReferenceBody) -> dict:
        """A reference: a part's place in the job paired with where it is on
        the device, read off it when not given."""
        self._part(body.job, body.ref)
        if body.at is None:
            offset = (0.0, 0.0)
            if body.camera:
                offset = self._top_offset(self.device_profile())
            self.device_position()
            position = self.pnp_device.position or {}
            at = (float(position["x"]) + offset[0], float(position["y"]) + offset[1])
        else:
            if any(abs(value) > 10000.0 for value in body.at):
                raise ValueError("a reference's place must be within 10000 mm")
            at = (float(body.at[0]), float(body.at[1]))
        config = self._device_config()
        kept = [entry for entry in config.get("references", []) if not (entry.get("job") == body.job and entry.get("ref") == body.ref)]
        kept.append({"job": body.job, "ref": body.ref, "at": [round(at[0], 4), round(at[1], 4)], "by": "camera" if body.camera else "nozzle"})
        config["references"] = kept
        self._save_config()
        return self.publish_pnp_device()

    def device_drop_references(self, job_id: str, ref: str | None) -> dict:
        config = self._device_config()
        config["references"] = [
            entry for entry in config.get("references", [])
            if not (entry.get("job") == job_id and (ref is None or entry.get("ref") == ref))
        ]
        self._save_config()
        return self.publish_pnp_device()

    def _device_fit(self, job_id: str, parts: list[dict]):
        by_ref = {part["ref"]: part for part in parts}
        entries = [entry for entry in self._device_config().get("references", []) if entry.get("job") == job_id and entry.get("ref") in by_ref]
        # Two fiducials or more the top camera found outdo places given by hand.
        found = [entry for entry in entries if entry.get("by") == "fiducial"]
        pairs = []
        for entry in found if len(found) > 1 else entries:
            part = by_ref[entry["ref"]]
            pairs.append(((float(part["x"]), float(part["y"])), (float(entry["at"][0]), float(entry["at"][1]))))
        angle = self._device_config().get("angle")
        return board_fit(pairs, float(angle) if isinstance(angle, (int, float)) and not isinstance(angle, bool) else None)

    def _placing(self, job_id: str) -> tuple[list[dict], dict[str, int], str]:
        """What placing a job's parts on the device starts from: the parts,
        how many parts each feeder has given, and the program's title."""
        listing = self.job_parts(job_id)
        parts = listing["components"]
        if not parts:
            raise ValueError(listing["note"] or "the job's board has no parts")
        job = self.store.get(job_id)
        taken = {key: int(value) for key, value in self._device_config().get("taken", {}).items()}
        return parts, taken, job.name if job else job_id

    def _device_plan(self, job_id: str, refs: list[str] | None) -> Plan:
        device = self.device_profile()
        parts, taken, title = self._placing(job_id)
        place = self._device_camera_place(device)
        return plan(
            device, parts, self._device_fit(job_id, parts), taken, refs,
            title=title, vision_ready=place.measured, runout=place.runout or (0.0, 0.0),
        )

    def device_plan(self, body: DevicePlanBody) -> dict:
        return self._device_plan(body.job, body.refs).summary()

    def device_program(self, job_id: str, refs: list[str] | None) -> str:
        return self._device_plan(job_id, refs).text()

    def device_run(self, body: DevicePlanBody) -> dict:
        """Places the job's parts on the device on its own thread: each pick
        from where a camera finds it, read by the vacuum, looked at and
        corrected over the up camera, as the profile asks (placer.py)."""
        if self.pnp_device.running:
            raise HTTPException(status_code=409, detail="a program is already being sent to the device")
        device = self._device_idle()
        parts, taken, title = self._placing(body.job)
        config = self._device_config()

        def on_taken(feeder: str, count: int) -> None:
            with self._config_lock:
                counts = config.setdefault("taken", {})
                counts[feeder] = max(int(counts.get(feeder, 0)), count)
            self._save_config()

        setup = PlaceSetup(
            up=self.pnp,
            up_place=self._device_camera_place(device),
            top=self.top,
            on_taken=on_taken,
            on_fiducials=lambda found, fit: self._keep_fiducials(body.job, found, fit),
            message=self.publish_message,
            publish_up=self.publish_pnp,
        )
        placement = Placement(
            device, self.pnp_device, parts, self._device_fit(body.job, parts), taken, body.refs, title, setup,
            fiducials=body.fiducials,
        )
        program = placement.program
        if not program.blocks:
            raise DeviceLinkError("the program places no part")
        if any(block.vision for block in program.blocks) and not self.pnp.running:
            raise ValueError("the up camera is not running: start it, since some parts are to be looked at over it")
        used = {block.feeder for block in program.blocks}
        looks = body.fiducials or any(feeder.pocket is not None or feeder.marks for feeder in device.feeders if feeder.id in used)
        if looks and not self.top.running:
            raise ValueError("the top camera is not running: start it, since the run looks with it")

        def ended(progress) -> None:
            if progress.state == "done":
                with self._config_lock:
                    config["boards"] = int(config.get("boards", 0) or 0) + 1
                self._save_config()
            level = "info" if progress.state == "done" else "error"
            failed = f", {len(progress.failed)} left out" if progress.failed else ""
            why = f", {progress.error}" if progress.error and progress.state == "error" else ""
            self.publish_message(level, f"placing on {device.name} {progress.state}: {len(progress.placed)} parts placed{failed}{why}")

        self.pnp_device.run_job(placement, placement.total(), device.timeout, ended, job_id=body.job)
        return {**program.summary(), **self.device_state()}

    def device_stop(self) -> dict:
        self._stop_device()
        return self.device_state()

    def _stop_device(self) -> None:
        """Stops what the device is sending after the line in flight, and
        sends its profile's stop at once: none when no profile reads."""
        try:
            line = self.device_profile().stop
        except (ValueError, DeviceNotFound):
            line = ""
        self.pnp_device.stop(line)

    def device_goto(self, body: DeviceGotoBody) -> dict:
        """The nozzle, or the top camera's picture center, over a part's place
        on the device: up to the safe height, then across; Z stays there."""
        device = self._device_idle()
        parts = self.job_parts(body.job)["components"]
        part = self._part(body.job, body.ref, parts)
        fit = self._device_fit(body.job, parts)
        if body.camera:
            offset = self._top_offset(device)
            x, y = fit.apply((float(part["x"]), float(part["y"])))
            self._device_lines(device, [safe_line(device), move_xy(device, (x - offset[0], y - offset[1]))])
        else:
            self._device_lines(device, board_goto(device, fit, part))
        return self.publish_pnp_device()

    def _top_offset(self, device: Device) -> tuple[float, float]:
        """Where the top camera's picture center is from the nozzle: as
        measured, else as the profile's design has it."""
        top = self.top.settings()
        if top.offset is not None:
            return (float(top.offset[0]), float(top.offset[1]))
        if device.top is not None and device.top.offset is not None:
            return device.top.offset
        raise ValueError("the top camera's offset is not known: give [top_camera] offset in the profile, or Measure offset")

    def _device_lines(self, device: Device, lines: list[str], track: dict | None = None) -> None:
        """Lines sent one at a time, each answered, the position kept as
        `track` says it ends (x, y, z, rotation) when given."""
        for line in lines:
            self.pnp_device.command(line, device.timeout)
        if track:
            position = dict(self.pnp_device.position or {})
            position.update(track)
            self.pnp_device.position = position

    def _device_here(self, device: Device) -> dict:
        """The head's place read off the device, X and Y at least."""
        self.device_position()
        return dict(self.pnp_device.position or {})

    def device_jog(self, body: DeviceJogBody) -> dict:
        """One axis moved by a step from where the device says it is: the
        position is read first (a queued move counts), then the move goes
        out at the axis' feed. Z moves alone, X and Y keep the height."""
        device = self._device_idle()
        if not device.position:
            raise ValueError("the device profile has no position command, which a jog starts from")
        limit = 360.0 if body.axis == "rotation" else 500.0
        if body.step == 0.0 or abs(body.step) > limit:
            raise ValueError(f"step: up to {limit:g} {'degrees' if body.axis == 'rotation' else 'mm'} either way")
        here = self._device_here(device)
        if body.axis not in here:
            letter = device.axes[("x", "y", "z", "rotation").index(body.axis)]
            raise DeviceLinkError(f"'{device.position}' answered no {letter}: it cannot be jogged from where it is")
        if body.axis == "rotation":
            # The axis' own value: turned the other way on an axis that turns clockwise.
            value = here["rotation"] + (-body.step if device.rotation_cw else body.step)
            line = f"{device.move} {device.axes[3]}{num(value)} F{num(device.feed_xy, 0)}"
        elif body.axis == "z":
            value = here["z"] + body.step
            line = move_z(device, value)
        else:
            value = here[body.axis] + body.step
            point = (value, here["y"]) if body.axis == "x" else (here["x"], value)
            line = move_xy(device, point)
        self._device_lines(device, [line], {body.axis: round(value, 4)})
        return self.publish_pnp_device()

    def device_move(self, body: DeviceMoveBody) -> dict:
        """The head to a place: across at the safe height when X or Y is
        given (the other one kept), then down or up to Z, the nozzle turned
        on the way across."""
        device = self._device_idle()
        if body.x is None and body.y is None and body.z is None and body.rotation is None:
            raise ValueError("give x, y, z or rotation")
        for value in (body.x, body.y, body.z):
            if value is not None and abs(value) > 10000.0:
                raise ValueError("a place must be within 10000 mm")
        lines: list[str] = []
        track: dict = {}
        if body.x is not None or body.y is not None:
            here = self._device_here(device) if body.x is None or body.y is None else {}
            point = (body.x if body.x is not None else here["x"], body.y if body.y is not None else here["y"])
            lines += [safe_line(device), move_xy(device, point, body.rotation)]
            track.update({"x": point[0], "y": point[1], "z": device.safe_z})
        elif body.rotation is not None:
            lines.append(move_xy(device, None, body.rotation))
        if body.z is not None:
            lines.append(move_z(device, body.z))
            track["z"] = body.z
        self._device_lines(device, lines, track)
        return self.publish_pnp_device()

    def device_park(self) -> dict:
        device = self._device_idle()
        if device.park is None:
            raise ValueError("the device profile has no [motion] park place")
        self._device_lines(device, [safe_line(device), move_xy(device, device.park)], {"x": device.park[0], "y": device.park[1], "z": device.safe_z})
        return self.publish_pnp_device()

    def device_over_camera(self) -> dict:
        """The nozzle over the up camera, turned to 0, at the height it is
        sharp at there (the safe height when the profile gives none)."""
        device = self._device_idle()
        place = self._device_camera_place(device)
        if place.position is None:
            raise ValueError("the up camera's place on the device is not known: set it, or Center nozzle over it")
        lines = [safe_line(device), move_xy(device, place.position, 0.0)]
        track = {"x": place.position[0], "y": place.position[1], "z": device.safe_z}
        if place.height is not None:
            lines.append(move_z(device, place.height))
            track["z"] = place.height
        if device.light_on and self.pnp_device.light is not True:
            lines = [*device.light_on, *lines]
            self.pnp_device.light = True
        self._device_lines(device, lines, track)
        return self.publish_pnp_device()

    def device_swap(self, body: DeviceSwapBody) -> dict:
        """The nozzle over the point the top camera looks at, or the camera
        over the point the nozzle is over: the head moved by the camera's
        offset, at the safe height."""
        device = self._device_idle()
        offset = self._top_offset(device)
        here = self._device_here(device)
        sign = 1.0 if body.to == "nozzle" else -1.0
        point = (here["x"] + sign * offset[0], here["y"] + sign * offset[1])
        self._device_lines(device, [safe_line(device), move_xy(device, point)], {"x": point[0], "y": point[1], "z": device.safe_z})
        return self.publish_pnp_device()

    def device_camera(self, body: DeviceCameraBody) -> dict:
        """The up camera's place on the device set by hand: typed, the head's
        place now with the nozzle over it by eye, or forgotten. Its scale,
        roll and the nozzle's runout stay as measured."""
        device = self._device_idle() if body.here else self.device_profile()
        place = self._device_camera_place(device)
        if body.clear:
            place.position = None
        elif body.here:
            here = self._device_here(device)
            place.position = (round(here["x"], 4), round(here["y"], 4))
        elif body.position is not None:
            if any(abs(value) > 10000.0 for value in body.position):
                raise ValueError("the up camera's place must be within 10000 mm")
            place.position = (float(body.position[0]), float(body.position[1]))
        else:
            raise ValueError("give a position, here or clear")
        self._keep_device_camera(place)
        return self.device_state()

    def device_light(self, on: bool) -> dict:
        device = self._device_idle()
        lines = device.light_on if on else device.light_off
        if not lines:
            raise ValueError(f"the device profile has no [gcode] light_{'on' if on else 'off'}")
        self._device_lines(device, list(lines))
        self.pnp_device.light = on
        return self.publish_pnp_device()

    def device_vacuum(self, body: DeviceVacuumBody) -> dict:
        """The vacuum switched with the profile's pick and place lines, and
        the sensor read with its read lines: what finding part_on and
        part_off takes."""
        device = self._device_idle()
        if body.on is None and not body.read:
            raise ValueError("give on, or read")
        reply: list[str] = []
        if body.on is not None:
            self._device_lines(device, list(device.pick if body.on else device.place))
            self.pnp_device.vacuum = body.on
        if body.read:
            vacuum = device.vacuum
            if vacuum is None:
                raise ValueError("the device profile has no [vacuum] read lines")
            for line in vacuum.read:
                reply = self.pnp_device.command(line, device.timeout)
            value = vacuum.reading(reply)
            if value is None:
                raise DeviceLinkError(f"'{vacuum.read[-1]}' answered no reading its pattern finds: {' | '.join(reply) or 'nothing'}")
            self.pnp_device.reading = value
        return {"reply": reply, **self.publish_pnp_device()}

    def device_boards_reset(self) -> dict:
        self._device_config()["boards"] = 0
        self._save_config()
        return self.publish_pnp_device()

    def device_reset_feeders(self, body: DeviceFeederBody) -> dict:
        config = self._device_config()
        taken = config.setdefault("taken", {})
        if body.feeder is None:
            taken.clear()
        else:
            taken.pop(body.feeder, None)
        self._save_config()
        return self.publish_pnp_device()
