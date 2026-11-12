"""The backend's placing part: what the PNP tab does with a G-code machine,
the machine connected from the top bar whose file says `controller =
"gcode"`. The board's references on it per job, the up camera's place on
it and the nozzle's runout, its top camera's settings and routines, its
lights, vacuum and feeder bus, its head over a part, parked or over the up
camera, and placing a job's parts (placer.py's run on the machine's link).

What the PNP tab keeps of a machine lives in the backend's config under
`placing`, by machine id: the board's turn and references per job, the up
camera's place, the top camera's settings, and the parts each feeder has
given. The machine the tab works with is the G-code machine connected, or
the one last connected, so a plan can be made with none connected.

Backend is made of this part and its others: the methods use the
backend's state and publishing as theirs."""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from fastapi import HTTPException

from spinny_laser.machines import GCODE

from .feederbus import BusError, FeederBus, slot_place
from .gcode_link import GcodeLinkError, GcodeMover
from .kinematics import num
from .openpnp import GcodeMachine, Plan, board_fit, goto_lines, move_line, plan, safe_line
from .placer import Placement, PlaceSetup, fiducial_fit
from .pnp import CameraPlace
from .topcam import Found

if TYPE_CHECKING:
    from .app import (
        PnpAngleBody,
        PnpCameraBody,
        PnpFeederBody,
        PnpFiducialsBody,
        PnpGotoBody,
        PnpPlanBody,
        PnpReferenceBody,
        PnpSwapBody,
        PnpVacuumBody,
        TopSettingsBody,
    )


class PlacingPart:
    """The PNP tab's work with a G-code machine, mixed into Backend."""

    # --- which machine, and what is kept of it ---------------------------------------

    def _placing_id(self) -> str | None:
        """The G-code machine the PNP tab works with: the one connected, else
        the one last connected, else the only G-code machine file; None
        when there is none of these."""
        if self.gcode.connected and self._gcode_id is not None:
            return self._gcode_id
        kept = self.config.get("placing_machine")
        machines, _ = self.machine_store.list()
        ids = [machine.id for machine in machines if machine.controller == GCODE]
        if isinstance(kept, str) and kept in ids:
            return kept
        return ids[0] if len(ids) == 1 else None

    def _placing_config(self) -> dict:
        """What the backend keeps of the placing machine: the board's turn and
        references per job, the up camera's place on it, the top camera's
        settings, and how many parts each feeder has given. With no G-code
        machine to keep them for, an empty dict that goes nowhere."""
        machine_id = self._placing_id()
        if machine_id is None:
            return {}
        everything = self.config.get("placing")
        if not isinstance(everything, dict):
            everything = {}
            self.config["placing"] = everything
        kept = everything.get(machine_id)
        if not isinstance(kept, dict):
            kept = {}
            everything[machine_id] = kept
        return kept

    def placing_machine(self) -> GcodeMachine:
        """The placing machine's file, read; 409 when there is no G-code machine to place with."""
        machine_id = self._placing_id()
        if machine_id is None:
            raise HTTPException(status_code=409, detail='no G-code machine to place with: connect one, or add a machine file with controller = "gcode"')
        return self.machine_store.gcode(machine_id)

    def placing_state(self) -> dict:
        config = self._placing_config()
        machine_id = self._placing_id()
        try:
            machine = self.placing_machine() if machine_id is not None else None
        except (ValueError, LookupError, HTTPException):
            machine = None
        camera = self._up_place(machine)
        connected = self.gcode.connected and self._gcode_id is not None and self._gcode_id == machine_id
        link = self.gcode.state()
        return {
            "machine": machine_id,
            "name": machine.name if machine is not None else None,
            "document": machine.document() if machine is not None else None,
            "angle": config.get("angle"),
            "references": [dict(entry) for entry in config.get("references", [])],
            "taken": dict(config.get("taken", {})),
            "boards": int(config.get("boards", 0)) if isinstance(config.get("boards", 0), int) else 0,
            "camera": {**camera.to_dict(), "measured": isinstance(config.get("camera"), dict) and bool(config["camera"].get("position"))},
            "top": self.top.state(),
            **link,
            "connected": connected,
        }

    def publish_placing(self) -> dict:
        state = self.placing_state()
        self.broadcast.publish_threadsafe({"type": "placing", **state})
        return state

    def _placing_idle(self) -> GcodeMachine:
        """The connected G-code machine, for a request that sends it lines:
        refused while a run, a camera routine or another move has it."""
        machine = self.gcode_machine()
        if self.gcode.running:
            raise HTTPException(status_code=409, detail="a placing run is under way")
        if self.pnp.routine_active:
            raise HTTPException(status_code=409, detail="the up camera routine is moving the head")
        if self.top.routine_active:
            raise HTTPException(status_code=409, detail="the top camera routine is moving the head")
        return machine

    def _head_lines(self, machine: GcodeMachine, lines: list[str]) -> None:
        """Moves of the head, run to their end, the place read after."""
        with self._move_lock:
            self._gcode_run_lines(machine, lines, "Jog")
            self._gcode_position(machine)
        self._publish_gcode_state()

    def _here(self, machine: GcodeMachine) -> dict:
        """The head's place read off the machine, X and Y at least."""
        return self._gcode_position(machine)

    # --- the up camera on the machine -------------------------------------------------

    def _up_place(self, machine: GcodeMachine | None) -> CameraPlace:
        """Where the up camera sits on the machine, as centering the nozzle
        over it measured (or the file has it, until then), at the height
        the file says the nozzle is sharp at."""
        kept = self._placing_config().get("camera")
        kept = kept if isinstance(kept, dict) else {}
        position = kept.get("position")
        if not (isinstance(position, list) and len(position) == 2) and machine is not None and machine.camera_position is not None:
            position = list(machine.camera_position)
        runout = kept.get("runout")
        try:
            return CameraPlace(
                position=(float(position[0]), float(position[1])) if isinstance(position, list) and len(position) == 2 else None,
                height=machine.camera_z if machine is not None else None,
                mm_per_px=float(kept.get("mm_per_px", 0.0)),
                roll=float(kept.get("roll", 0.0)),
                mirror=bool(kept.get("mirror", True)),
                runout=(float(runout[0]), float(runout[1])) if isinstance(runout, list) and len(runout) == 2 else None,
            )
        except (TypeError, ValueError):
            return CameraPlace(height=machine.camera_z if machine is not None else None)

    def _keep_up_place(self, place: CameraPlace) -> None:
        kept = place.to_dict()
        # The height is the file's [up_camera] z, read from it every time.
        del kept["height"]
        self._placing_config()["camera"] = kept
        self._save_config()
        self.publish_placing()

    def gcode_nozzle(self, step: float) -> dict:
        """Centers the G-code machine's nozzle over the up camera, measuring
        where the camera is on it and how its picture lies against its
        moves; on the up camera's routine thread."""
        machine = self._placing_idle()
        mover = GcodeMover(self.gcode, machine, aborted=self.pnp.aborting)
        self.pnp.center_nozzle(mover, step, place=self._up_place(machine), keep=self._keep_up_place)
        return self.placing_state()

    def pnp_runout(self) -> dict:
        """Measures how far the nozzle tip runs off its turning axis, over
        the up camera; on the up camera's routine thread."""
        machine = self._placing_idle()
        mover = GcodeMover(self.gcode, machine, aborted=self.pnp.aborting)
        self.pnp.measure_runout(mover, self._up_place(machine), self._keep_up_place, machine.rotation_cw)
        return self.placing_state()

    def pnp_camera_place(self, body: PnpCameraBody) -> dict:
        """The up camera's place on the machine set by hand: typed, the head's
        place now with the nozzle over it by eye, or forgotten. Its scale,
        roll and the nozzle's runout stay as measured."""
        machine = self._placing_idle() if body.here else self.placing_machine()
        place = self._up_place(machine)
        if body.clear:
            place.position = None
        elif body.here:
            here = self._here(machine)
            place.position = (round(here["x"], 4), round(here["y"], 4))
        elif body.position is not None:
            if any(abs(value) > 10000.0 for value in body.position):
                raise ValueError("the up camera's place must be within 10000 mm")
            place.position = (float(body.position[0]), float(body.position[1]))
        else:
            raise ValueError("give a position, here or clear")
        self._keep_up_place(place)
        return self.placing_state()

    # --- the top camera ---------------------------------------------------------------

    def top_settings(self, body: TopSettingsBody) -> dict:
        self.placing_machine()
        try:
            self.top.update(body.model_dump(exclude={"clear"}, exclude_none=True), tuple(body.clear))
        finally:
            state = self.publish_placing()
        return state

    def top_start(self) -> dict:
        try:
            self.top.start()
        finally:
            state = self.publish_placing()
        return state

    def top_stop(self) -> dict:
        self.top.stop()
        return self.publish_placing()

    def top_frame(self, width: int, overlay: bool) -> bytes:
        from .backend_shared import _check_frame_width

        _check_frame_width(width)
        return self.top.frame(width, overlay)

    def top_mark(self) -> dict:
        """The nozzle's tip is over the mark the offset is measured from: its place is kept."""
        here = self._here(self._placing_idle())
        self.top.update({"mark_at": (float(here["x"]), float(here["y"]))})
        return self.publish_placing()

    def top_offset(self, step: float) -> dict:
        machine = self._placing_idle()
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)
        profile = machine.top
        self.top.measure_offset(mover, step, profile.z if profile is not None else None, profile.offset if profile is not None else None)
        return self.placing_state()

    def top_abort(self) -> dict:
        self.top.abort()
        # The routine waits on a move and its wait command: the machine is
        # told to stop at once.
        self._stop_gcode()
        return self.placing_state()

    def _top_offset(self, machine: GcodeMachine) -> tuple[float, float]:
        """Where the top camera's picture center is from the nozzle: as
        measured, else as the machine's design has it."""
        top = self.top.settings()
        if top.offset is not None:
            return (float(top.offset[0]), float(top.offset[1]))
        if machine.top is not None and machine.top.offset is not None:
            return machine.top.offset
        raise ValueError("the top camera's offset is not known: give [top_camera] offset in the machine file, or Measure offset")

    def pnp_fiducials(self, body: PnpFiducialsBody) -> dict:
        """Finds the board's fiducials with the top camera where the
        references put them and keeps them as the job's references; on the
        top camera's routine thread."""
        machine = self._placing_idle()
        if machine.top is None:
            raise ValueError(f"{machine.name}'s file has no [top_camera] table")
        top = machine.top
        parts = self.job_parts(body.job)["components"]
        fiducials = [part for part in parts if part.get("fiducial")]
        guess = self._board_fit(body.job, parts)
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)

        def done(found: list[Found]) -> str:
            fit = fiducial_fit(found, guess.rotation)
            self._keep_fiducials(body.job, found, fit)
            rms = f", {fit.rms * 1000.0:.0f} um rms" if len(found) > 1 else ""
            return f"{len(found)} fiducials found: the board is turned {fit.rotation:+.3f} degrees on the machine{rms}"

        self.top.find_fiducials(mover, fiducials, guess.apply, top.fiducial, top.within, top.z, done)
        return self.placing_state()

    def _keep_fiducials(self, job_id: str, found: list[Found], fit) -> None:
        """The fiducials found become the job's references: with two or
        more, the ones given by hand give way to them."""
        with self._config_lock:
            config = self._placing_config()
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
        self.publish_placing()

    # --- the board on the machine -------------------------------------------------------

    def placing_angle(self, body: PnpAngleBody) -> dict:
        """The board's turn on the machine as typed, which one reference alone
        cannot tell; or forgotten."""
        self.placing_machine()
        config = self._placing_config()
        if body.clear_angle:
            config.pop("angle", None)
        elif body.angle is not None:
            if abs(body.angle) > 360.0:
                raise ValueError("the board's turn must be within 360 degrees")
            config["angle"] = body.angle
        self._save_config()
        return self.publish_placing()

    def _part(self, job_id: str, ref: str, parts: list[dict] | None = None) -> dict:
        """The part `ref` of a job's board, from `parts` when the job's
        parts are read already; 404 for one the board lacks."""
        if parts is None:
            parts = self.job_parts(job_id)["components"]
        part = next((entry for entry in parts if entry["ref"] == ref), None)
        if part is None:
            raise HTTPException(status_code=404, detail=f"the job has no part {ref!r}")
        return part

    def pnp_reference(self, body: PnpReferenceBody) -> dict:
        """A reference: a part's place in the job paired with where it is on
        the machine, read off it when not given."""
        self._part(body.job, body.ref)
        machine = self.placing_machine()
        if body.at is None:
            offset = (0.0, 0.0)
            if body.camera:
                offset = self._top_offset(machine)
            here = self._here(self._placing_idle())
            at = (float(here["x"]) + offset[0], float(here["y"]) + offset[1])
        else:
            if any(abs(value) > 10000.0 for value in body.at):
                raise ValueError("a reference's place must be within 10000 mm")
            at = (float(body.at[0]), float(body.at[1]))
        config = self._placing_config()
        kept = [entry for entry in config.get("references", []) if not (entry.get("job") == body.job and entry.get("ref") == body.ref)]
        kept.append({"job": body.job, "ref": body.ref, "at": [round(at[0], 4), round(at[1], 4)], "by": "camera" if body.camera else "nozzle"})
        config["references"] = kept
        self._save_config()
        return self.publish_placing()

    def pnp_drop_references(self, job_id: str, ref: str | None) -> dict:
        self.placing_machine()
        config = self._placing_config()
        config["references"] = [
            entry for entry in config.get("references", [])
            if not (entry.get("job") == job_id and (ref is None or entry.get("ref") == ref))
        ]
        self._save_config()
        return self.publish_placing()

    def _board_fit(self, job_id: str, parts: list[dict]):
        by_ref = {part["ref"]: part for part in parts}
        entries = [entry for entry in self._placing_config().get("references", []) if entry.get("job") == job_id and entry.get("ref") in by_ref]
        # Two fiducials or more the top camera found outdo places given by hand.
        found = [entry for entry in entries if entry.get("by") == "fiducial"]
        pairs = []
        for entry in found if len(found) > 1 else entries:
            part = by_ref[entry["ref"]]
            pairs.append(((float(part["x"]), float(part["y"])), (float(entry["at"][0]), float(entry["at"][1]))))
        angle = self._placing_config().get("angle")
        return board_fit(pairs, float(angle) if isinstance(angle, (int, float)) and not isinstance(angle, bool) else None)

    def gcode_goto_part(self, body: PnpGotoBody) -> dict:
        """The nozzle, or the top camera's picture center, over a part's place
        on the machine: up to the safe height, then across; Z stays there."""
        machine = self._placing_idle()
        parts = self.job_parts(body.job)["components"]
        part = self._part(body.job, body.ref, parts)
        fit = self._board_fit(body.job, parts)
        x, y = fit.apply((float(part["x"]), float(part["y"])))
        if body.camera:
            offset = self._top_offset(machine)
            x, y = x - offset[0], y - offset[1]
        self._head_lines(machine, [safe_line(machine), move_line(machine, {"x": x, "y": y})])
        return self.publish_placing()

    # --- placing --------------------------------------------------------------------------

    def _placing(self, job_id: str) -> tuple[list[dict], dict[str, int], str]:
        """What placing a job's parts starts from: the parts, how many parts
        each feeder has given, and the program's title."""
        listing = self.job_parts(job_id)
        parts = listing["components"]
        if not parts:
            raise ValueError(listing["note"] or "the job's board has no parts")
        job = self.store.get(job_id)
        taken = {key: int(value) for key, value in self._placing_config().get("taken", {}).items()}
        return parts, taken, job.name if job else job_id

    def _plan(self, job_id: str, refs: list[str] | None) -> Plan:
        machine = self.placing_machine()
        # Bus feeders' slots are asked for only between runs: a question in
        # the middle of one would take turns with its lines.
        if not self.gcode.running:
            machine = self._found_slots(machine)
        parts, taken, title = self._placing(job_id)
        place = self._up_place(machine)
        return plan(
            machine, parts, self._board_fit(job_id, parts), taken, refs,
            title=title, vision_ready=place.measured, runout=place.runout or (0.0, 0.0),
        )

    def pnp_plan(self, body: PnpPlanBody) -> dict:
        return self._plan(body.job, body.refs).summary()

    def pnp_program(self, job_id: str, refs: list[str] | None) -> str:
        return self._plan(job_id, refs).text()

    def pnp_run(self, body: PnpPlanBody) -> dict:
        """Places the job's parts on the machine on its own thread: each pick
        from where a camera finds it, read by the vacuum, looked at and
        corrected over the up camera, as the machine file asks (placer.py)."""
        if self.gcode.running:
            raise HTTPException(status_code=409, detail="a placing run is already under way")
        machine = self._found_slots(self._placing_idle())
        parts, taken, title = self._placing(body.job)
        config = self._placing_config()

        def on_taken(feeder: str, count: int) -> None:
            with self._config_lock:
                counts = config.setdefault("taken", {})
                counts[feeder] = max(int(counts.get(feeder, 0)), count)
            self._save_config()

        setup = PlaceSetup(
            up=self.pnp,
            up_place=self._up_place(machine),
            top=self.top,
            on_taken=on_taken,
            on_fiducials=lambda found, fit: self._keep_fiducials(body.job, found, fit),
            message=self.publish_message,
            publish_up=self.publish_pnp,
        )
        placement = Placement(
            machine, self.gcode, parts, self._board_fit(body.job, parts), taken, body.refs, title, setup,
            fiducials=body.fiducials,
        )
        program = placement.program
        if not program.blocks:
            raise GcodeLinkError("the program places no part")
        if any(block.vision for block in program.blocks) and not self.pnp.running:
            raise ValueError("the up camera is not running: start it, since some parts are to be looked at over it")
        used = {block.feeder for block in program.blocks}
        looks = body.fiducials or any(feeder.pocket is not None or feeder.marks for feeder in machine.feeders if feeder.id in used)
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
            self.publish_message(level, f"placing on {machine.name} {progress.state}: {len(progress.placed)} parts placed{failed}{why}")
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})

        self.gcode.run_job(placement, placement.total(), machine.timeout, ended, job_id=body.job)
        return {**program.summary(), **self.placing_state()}

    def pnp_run_stop(self) -> dict:
        self._stop_gcode()
        return self.placing_state()

    def _stop_gcode(self) -> None:
        """Stops what the machine is being sent after the line in flight, and
        sends its file's stop at once: none when no file reads."""
        try:
            line = self.gcode_machine().stop
        except (ValueError, LookupError, HTTPException):
            line = ""
        self.gcode.stop(line)

    # --- the head by hand -----------------------------------------------------------------

    def pnp_park(self) -> dict:
        machine = self._placing_idle()
        if machine.park is None:
            raise ValueError(f"{machine.name}'s file has no [motion] park place")
        self._head_lines(machine, goto_lines(machine, self._here(machine), {"x": machine.park[0], "y": machine.park[1], "z": machine.safe_z}))
        return self.publish_placing()

    def pnp_over_camera(self) -> dict:
        """The nozzle over the up camera, turned to 0, at the height it is
        sharp at there (the safe height when the file gives none): across
        at the safe height, the height last."""
        machine = self._placing_idle()
        place = self._up_place(machine)
        if place.position is None:
            raise ValueError("the up camera's place on the machine is not known: set it, or Center nozzle over it")
        lines: list[str] = []
        if machine.light_on and self.gcode.light is not True:
            lines += list(machine.light_on)
            self.gcode.light = True
        here = self._here(machine)
        want = {"x": place.position[0], "y": place.position[1], "rotation": 0.0}
        want["z"] = place.height if place.height is not None else machine.safe_z
        lines += goto_lines(machine, here, want)
        self._head_lines(machine, lines)
        return self.publish_placing()

    def pnp_swap(self, body: PnpSwapBody) -> dict:
        """The nozzle over the point the top camera looks at, or the camera
        over the point the nozzle is over: the head moved by the camera's
        offset, at the safe height."""
        machine = self._placing_idle()
        offset = self._top_offset(machine)
        here = self._here(machine)
        sign = 1.0 if body.to == "nozzle" else -1.0
        point = {"x": here["x"] + sign * offset[0], "y": here["y"] + sign * offset[1]}
        self._head_lines(machine, goto_lines(machine, here, point))
        return self.publish_placing()

    def pnp_light(self, on: bool) -> dict:
        machine = self._placing_idle()
        lines = machine.light_on if on else machine.light_off
        if not lines:
            raise ValueError(f"{machine.name}'s file has no [gcode] light_{'on' if on else 'off'}")
        for line in lines:
            self.gcode.command(line, machine.timeout)
        self.gcode.light = on
        return self.publish_placing()

    def pnp_vacuum(self, body: PnpVacuumBody) -> dict:
        """The vacuum switched with the file's pick and place lines, and the
        sensor read with its read lines: what finding part_on and part_off
        takes."""
        machine = self._placing_idle()
        if body.on is None and not body.read:
            raise ValueError("give on, or read")
        reply: list[str] = []
        if body.on is not None:
            for line in machine.pick if body.on else machine.place:
                self.gcode.command(line, machine.timeout)
            self.gcode.vacuum = body.on
        if body.read:
            vacuum = machine.vacuum
            if vacuum is None:
                raise ValueError(f"{machine.name}'s file has no [vacuum] read lines")
            for line in vacuum.read:
                reply = self.gcode.command(line, machine.timeout)
            value = vacuum.reading(reply)
            if value is None:
                raise GcodeLinkError(f"'{vacuum.read[-1]}' answered no reading its pattern finds: {' | '.join(reply) or 'nothing'}")
            self.gcode.reading = value
        return {"reply": reply, **self.publish_placing()}

    # --- feeders ------------------------------------------------------------------------

    def _bus(self, machine: GcodeMachine) -> FeederBus:
        if machine.bus is None:
            raise ValueError(f"{machine.name}'s file has no [bus] table")
        return FeederBus(machine.bus, send=lambda line: self.gcode.command(line, machine.timeout))

    def _found_slots(self, machine: GcodeMachine) -> GcodeMachine:
        """The machine with each bus feeder whose slot its file does not give
        placed by the slot the bus says it is in; a feeder not found stays
        unplaced, and the plan says so."""
        unplaced = [feeder for feeder in machine.feeders if feeder.bus_id is not None and feeder.at is None]
        if not unplaced or machine.bus is None or not self.gcode.connected or self._gcode_id != machine.id:
            return machine
        bus = self._bus(machine)
        by_address = {slot.address: slot for slot in machine.slots}
        feeders = []
        for feeder in machine.feeders:
            if feeder in unplaced:
                # A feeder the bus cannot find, for whatever reason, stays
                # unplaced: the plan leaves its parts out and says why.
                try:
                    address = bus.find(feeder.bus_id or "")
                except (BusError, GcodeLinkError):
                    address = None
                slot = by_address.get(address) if address is not None else None
                if slot is not None:
                    feeder = replace(feeder, slot=address, at=slot_place(slot.at, slot.rotation, feeder.offset), rotation=feeder.rotation + slot.rotation)
                elif address is not None:
                    self.publish_message("warning", f"feeder {feeder.id} is at bus address {address}, which has no [[slot]] place in the machine file")
            feeders.append(feeder)
        return replace(machine, feeders=tuple(feeders))

    def pnp_bus_scan(self) -> dict:
        """The feeders that answer on the bus, by address, each with its id
        and the file's feeder of that id, when there is one."""
        machine = self._placing_idle()
        found = self._bus(machine).scan()
        by_id = {feeder.bus_id: feeder for feeder in machine.feeders if feeder.bus_id is not None}
        slots = {slot.address for slot in machine.slots}
        return {
            "feeders": [
                {
                    "address": entry["address"],
                    "id": entry["id"],
                    "feeder": by_id[entry["id"]].id if entry["id"] in by_id else None,
                    "slot": entry["address"] in slots,
                }
                for entry in found
            ],
            **self.publish_placing(),
        }

    def pnp_bus_feed(self, feeder_id: str) -> dict:
        """One advance of a feeder on the bus, to see its tape move."""
        machine = self._placing_idle()
        feeder = next((entry for entry in machine.feeders if entry.id == feeder_id), None)
        if feeder is None:
            raise HTTPException(status_code=404, detail=f"{machine.name}'s file has no feeder {feeder_id!r}")
        if feeder.bus_id is None:
            raise ValueError(f"feeder {feeder_id} is not on the bus")
        try:
            address = self._bus(machine).advance(feeder.bus_id, round(feeder.advance * 10), feeder.slot)
        except BusError as exc:
            raise GcodeLinkError(f"feeder {feeder_id}: {exc}") from exc
        self.publish_message("info", f"feeder {feeder_id} advanced {num(feeder.advance)} mm (bus address {address})")
        return self.publish_placing()

    def pnp_boards_reset(self) -> dict:
        self.placing_machine()
        self._placing_config()["boards"] = 0
        self._save_config()
        return self.publish_placing()

    def pnp_reset_feeders(self, body: PnpFeederBody) -> dict:
        self.placing_machine()
        config = self._placing_config()
        taken = config.setdefault("taken", {})
        if body.feeder is None:
            taken.clear()
        else:
            taken.pop(body.feeder, None)
        self._save_config()
        return self.publish_placing()
