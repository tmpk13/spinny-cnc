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
from typing import TYPE_CHECKING, Callable

from fastapi import HTTPException

from spinny_laser.machines import GCODE

from .boardlook import (
    KNOWN_FIRST,
    QUICK_SHARE,
    KnownPlace,
    PictureFrame,
    corners_known,
    found_text,
    known_place,
    measured_known,
    quick_first,
    scan,
    scan_text,
    search,
    search_box,
    search_extra,
    search_stops,
)
from .feederbus import BusError, FeederBus, slot_place
from .findings import Target, UndoRefused
from .gcode_link import GcodeLinkError, GcodeMover
from .gcode_part import HOME_TIMEOUTS
from .kinematics import num
from .openpnp import GcodeMachine, Plan, board_fit, declare_line, goto_lines, needs_lift, plan
from .placer import Placement, PlaceSetup, fiducial_fit
from .pnp import CameraPlace, PnpError
from .log import log
from .topcam import APPROACH_MM, SCALE_NEEDED, Found
from .crops import crop_box_mm
from .vision import VisionError, scale_range

if TYPE_CHECKING:
    from .app import (
        BoardCornerBody,
        BoardPlaceBody,
        BoardScanBody,
        BoardSearchBody,
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

# A top camera search that found its board from looks far apart keeps the
# roll it measured once that is this far from the roll in use, degrees, or
# whenever the camera's scale was not measured. On a LumenPnP one search's
# roll scattered 0.07 degrees and carried the axes' skew (0.13 to 0.16
# degrees) where its places lay along one axis, while Measure camera reads
# the roll to 0.02: at 0.05 every search rewrote a measured roll by its own
# noise (180.33 measured, then 180.43, 180.50, 180.61, 180.53).
PICTURE_ROLL_DEG = 0.3
# With only the file's scale as designed, pcbv's board search keeps within
# this factor of it either way (a measured one: vision.SCALE_SPREAD). On the
# LumenPnP's top camera the windows' search without any scale locked
# pictures at half the true scale with a high share of their pads paired;
# the design keeps those out while a camera somewhat off it still locks.
DESIGN_SCALE_SPREAD = 1.5


# What a board's place says when the top camera's offset from the nozzle is
# not known at all (none measured, none in the machine file) and the place
# is asked for in a frame its references were not taken in. A reference
# taken through the camera is then where the head stood with the picture's
# center on the point; one taken by the nozzle is the nozzle's place.
NOZZLE_NEEDS_OFFSET = (
    "the board's place was taken by the top camera, whose offset from the nozzle is not measured:"
    " put the nozzle on a mark, press Nozzle on mark, then Measure offset"
)
CAMERA_NEEDS_OFFSET = (
    "the board's references were taken by the nozzle, and the top camera's offset from it is not measured:"
    " take the board's place with the camera (Search, a corner, Camera here), or put the nozzle on a mark,"
    " press Nozzle on mark, then Measure offset"
)
MIXED_NEEDS_OFFSET = (
    "the board's place was taken by the top camera for some references and by the nozzle for others, and the"
    " camera's offset from the nozzle is not measured, so they cannot be set against each other:"
    " put the nozzle on a mark, press Nozzle on mark, then Measure offset"
)


def reference_offset(entry: dict) -> tuple[float, float] | None:
    """The top camera's offset a reference was taken with: every reference
    taken through the camera keeps it (0, 0 when none was known). None for
    one taken by the nozzle or typed, and for one kept before references
    carried it."""
    offset = entry.get("offset")
    if not isinstance(offset, (list, tuple)) or len(offset) != 2:
        return None
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in offset):
        return None
    return (float(offset[0]), float(offset[1]))


def reference_place(entry: dict, offset: tuple[float, float]) -> tuple[float, float]:
    """Where a reference lies on the machine with the top camera's offset
    in use now, `offset`. One taken through the camera was the head's place
    plus the offset in use then, so it moves by how far the offset has
    moved since: an offset measured after the board was found is applied
    to the place found. Any other reference is where it was taken."""
    at = (float(entry["at"][0]), float(entry["at"][1]))
    taken = reference_offset(entry)
    if taken is None:
        return at
    return (at[0] + offset[0] - taken[0], at[1] + offset[1] - taken[1])


def take_corner(look, job_id: str, name: str, job_point: tuple[float, float], machine: tuple[float, float], middle: tuple[float, float], angle: float | None, by: str = "edges") -> Callable[[], None]:
    """Takes a corner into a camera's look for a board (boardlook's
    add_corner) and answers its undo for the findings log: the look's
    corners put back as they were, refused (UndoRefused) once they changed
    since. Corners of another job's board, which the corner taken dropped,
    are not brought back: their board's middle is not known here."""
    before_job = look.corners_job
    before = look.corners_of(before_job)
    look.add_corner(job_id, name, job_point, machine, middle, angle, by)
    after = look.corners_of(job_id)

    def undo() -> None:
        if look.corners_job != job_id or look.corners_of(job_id) != after:
            raise UndoRefused("the board's corners changed since: take the corner again, or clear the corners")
        look.clear_corners()
        if before_job == job_id:
            for corner in before:
                look.add_corner(job_id, corner.name, corner.job, corner.machine, middle, corner.angle, corner.by)

    return undo


def _inside(box: tuple[float, float, float, float], point: tuple[float, float]) -> bool:
    """Whether a point lies in a box (x0, y0, x1, y1, either way round)."""
    return min(box[0], box[2]) <= point[0] <= max(box[0], box[2]) and min(box[1], box[3]) <= point[1] <= max(box[1], box[3])


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

    def _top_crops(self) -> dict:
        """The top camera's crops by task, from the placing machine's file
        ([top_camera.crops]); none without one."""
        machine_id = self._placing_id()
        if machine_id is None:
            return {}
        machine = self.machine_store.gcode(machine_id)
        return dict(machine.top.crops) if machine.top is not None else {}

    def _up_crops(self) -> dict:
        """The bottom camera's crops by task, from the connected G-code
        machine's file ([up_camera.crops]); none while the camera works on
        a machine of this project's firmware."""
        if not self.gcode.connected or self._gcode_id is None:
            return {}
        return dict(self.machine_store.gcode(self._gcode_id).camera_crops)

    def machine_written(self, machine_id: str) -> None:
        """A machine file was written: the placing machine's board crop is
        told to the top camera's pcbv, so a crop drawn on the page holds at
        once; and the connected machine's firmware is told a skew it is to
        take out now, unless something moves the head (the next request
        that moves it tells it then), so the place the page shows holds at
        once too."""
        if machine_id == self._placing_id() and self.top.client.running:
            self.top.send_board_crop()
        if machine_id != self._gcode_id or not self.gcode.connected:
            return
        if self.gcode.running or self.pnp.routine_active or self.top.routine_active:
            return
        try:
            self._gcode_skew(self.gcode_machine())
        except (GcodeLinkError, ValueError, LookupError, HTTPException) as exc:
            self.publish_message("error", f"the axes' skew was not told to the firmware: {getattr(exc, 'detail', None) or exc}")

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
        offset, _ = self._top_offset_in_use(machine)
        return {
            "machine": machine_id,
            "name": machine.name if machine is not None else None,
            "document": machine.document() if machine is not None else None,
            "angle": config.get("angle"),
            "references": [self._reference_now(entry, offset) for entry in config.get("references", [])],
            "taken": dict(config.get("taken", {})),
            "boards": int(config.get("boards", 0)) if isinstance(config.get("boards", 0), int) else 0,
            "camera": {**camera.to_dict(), "measured": isinstance(config.get("camera"), dict) and bool(config["camera"].get("position"))},
            "top": {**self.top.state(), "board_look": self.top_look.state()},
            **link,
            "connected": connected,
        }

    @staticmethod
    def _reference_now(entry: dict, offset: tuple[float, float]) -> dict:
        """A reference as the page gets it: `at` where it lies with the top
        camera's offset in use now (reference_place); the offset it was
        taken with stays beside it. One whose place does not read is given
        as kept."""
        shown = dict(entry)
        if reference_offset(entry) is None:
            return shown
        try:
            at = reference_place(entry, offset)
        except (KeyError, TypeError, ValueError, IndexError):
            return shown
        shown["at"] = [round(at[0], 4), round(at[1], 4)]
        return shown

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
            raise HTTPException(status_code=409, detail="the bottom camera routine is moving the head")
        if self.top.routine_active:
            raise HTTPException(status_code=409, detail="the top camera routine is moving the head")
        self._gcode_skew(machine)
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
        the file says the nozzle is sharp at. Its roll and mirror are the
        measured ones once its scale is, else the file's [up_camera] roll
        and mirror where it gives them."""
        kept = self._placing_config().get("camera")
        kept = kept if isinstance(kept, dict) else {}
        position = kept.get("position")
        if not (isinstance(position, list) and len(position) == 2) and machine is not None and machine.camera_position is not None:
            position = list(machine.camera_position)
        runout = kept.get("runout")
        try:
            place = CameraPlace(
                position=(float(position[0]), float(position[1])) if isinstance(position, list) and len(position) == 2 else None,
                height=machine.camera_z if machine is not None else None,
                mm_per_px=float(kept.get("mm_per_px", 0.0)),
                roll=float(kept.get("roll", 0.0)),
                mirror=bool(kept.get("mirror", True)),
                runout=(float(runout[0]), float(runout[1])) if isinstance(runout, list) and len(runout) == 2 else None,
            )
        except (TypeError, ValueError):
            place = CameraPlace(height=machine.camera_z if machine is not None else None)
        if place.mm_per_px <= 0.0 and machine is not None:
            # Not measured yet: the camera as the file says it is mounted.
            if machine.camera_roll is not None:
                place.roll = machine.camera_roll
            if machine.camera_mirror is not None:
                place.mirror = machine.camera_mirror
        return place

    def take_camera_settings(self, machine: GcodeMachine) -> None:
        """The cameras' own settings the machine's file names ([top_camera]
        and [up_camera] device, size, fps, pcbv and the shades their routines
        look for) put into the cameras as the machine is connected, as a
        load puts a file's [camera] into the head camera's. What the file
        leaves out keeps the camera's own; a camera that cannot take them
        says so and keeps what it had."""
        given = ((self.top, machine.top.settings if machine.top is not None else {}), (self.pnp, machine.camera_settings))
        for camera, settings in given:
            current = camera.settings()
            if not settings or all(getattr(current, key) == value for key, value in settings.items()):
                continue
            try:
                camera.update(dict(settings))
                log.info("%s: the %s took the file's %s", machine.id, camera.label, ", ".join(sorted(settings)))
            except (PnpError, VisionError, ValueError) as exc:
                self.publish_message("error", f"{machine.name}: the {camera.label} did not take the file's settings: {exc}")

    def _up_place_target(self) -> Target:
        """The up camera's place on the G-code machine (what centering the
        nozzle and the runout keep) as the findings log reads and writes
        it, None taking a value away."""

        def read() -> dict:
            kept = self._placing_config().get("camera")
            return dict(kept) if isinstance(kept, dict) else {}

        def write(values: dict) -> None:
            with self._config_lock:
                config = self._placing_config()
                kept = dict(config["camera"]) if isinstance(config.get("camera"), dict) else {}
                for key, value in values.items():
                    if value is None:
                        kept.pop(key, None)
                    else:
                        kept[key] = value
                config["camera"] = kept
            self._save_config()
            self.publish_placing()

        return Target(read=read, write=write, machine=self._placing_id)

    def _references_target(self) -> Target:
        """The board's references on the G-code machine as the findings log
        reads and writes them: each job's list, by its id. A job's list
        written without the fiducials found also forgets the fiducials the
        top camera shows found for it."""

        def read() -> dict:
            by_job: dict[str, list] = {}
            for entry in self._placing_config().get("references", []):
                if isinstance(entry, dict) and isinstance(entry.get("job"), str):
                    by_job.setdefault(entry["job"], []).append(dict(entry))
            return by_job

        def write(values: dict) -> None:
            with self._config_lock:
                config = self._placing_config()
                kept = [entry for entry in config.get("references", []) if not (isinstance(entry, dict) and entry.get("job") in values)]
                for entries in values.values():
                    kept.extend(dict(entry) for entry in entries or [])
                config["references"] = kept
            shown = self.top.fiducials
            if shown is not None and shown.get("job") in values and not any(entry.get("by") == "fiducial" for entry in values[shown["job"]] or []):
                self.top.fiducials = None
            self._save_config()
            self.publish_placing()

        return Target(read=read, write=write, machine=self._placing_id, label=lambda job: f"the board's references (job {job})")

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
        self.pnp.center_nozzle(mover, step, place=self._up_place(machine), keep=self._keep_up_place, target="up place")
        return self.placing_state()

    def pnp_runout(self) -> dict:
        """Measures how far the nozzle tip runs off its turning axis, over
        the up camera; on the up camera's routine thread."""
        machine = self._placing_idle()
        mover = GcodeMover(self.gcode, machine, aborted=self.pnp.aborting)
        self.pnp.measure_runout(mover, self._up_place(machine), self._keep_up_place, machine.rotation_cw, target="up place")
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
                raise ValueError("the bottom camera's place must be within 10000 mm")
            place.position = (float(body.position[0]), float(body.position[1]))
        else:
            raise ValueError("give a position, here or clear")
        self._keep_up_place(place)
        return self.placing_state()

    # --- the top camera ---------------------------------------------------------------

    def top_settings(self, body: TopSettingsBody) -> dict:
        self.placing_machine()
        before = self.top.settings()
        try:
            after = self.top.update(body.model_dump(exclude={"clear"}, exclude_none=True), tuple(body.clear))
        finally:
            # A camera started again on other settings has no board loaded.
            if self.top_look.job is not None and not self._top_board_loaded():
                self.top_look.stop()
            self.top_look.retune()
            state = self.publish_placing()
        job = self.top_look.job
        if job is not None and not self.top.routine_active:
            if (after.side, after.finish) != (before.side, before.finish):
                # Another side or finish is another model: the board is
                # loaded again, the look begun afresh.
                state = self.top_board(job)
            elif after.paste != before.paste:
                self._tell_assembly(job)
                state = self.publish_placing()
        return state

    def top_start(self) -> dict:
        try:
            self.top.start()
        finally:
            self.top_look.stop()
            state = self.publish_placing()
        return state

    def top_stop(self) -> dict:
        self.top.stop()
        self.top_look.stop()
        return self.publish_placing()

    def _top_board_loaded(self) -> bool:
        """Whether the top camera's pcbv still holds a board."""
        if not self.top.client.running:
            return False
        try:
            return self.top.client.request("hello").get("board") is not None
        except Exception:
            return False

    def top_board(self, job_id: str | None) -> dict:
        """The job's board loaded into the top camera's pcbv, which looks
        for it in every picture from then on (`top.look`); None unloads it."""
        machine = self.placing_machine()
        if job_id is None:
            self.top_look.stop()
            if self.top.client.running:
                self.top.client.board(None)
            return self.publish_placing()
        if not self.top.client.running:
            raise ValueError("the top camera is not running: start it first")
        job = self._job(job_id)
        path = self.store.board_path(job_id)
        if job.design is None or not job.design.board or path is None:
            raise ValueError("the job was not imported from a KiCad board file kept here: the camera has nothing to look for")
        self.top_look.stop()
        # What the look kept of before (corners, a place found) is brought
        # onto the offset in use before the board's poses are read by it.
        self._settle_top_look(machine)
        board = self._top_board_settings(job_id)
        # pcbv keeps the board crop through loads; sent again so a crop
        # changed in the file since the start holds for this look.
        self.top.send_board_crop()
        self.top.client.board(str(path), **board)
        middle, _ = self._board_size(job)
        # A place the head is seen at that changed is a move at about half
        # the file's feed, its acceleration allowed for.
        self._top_rest.speed = max(machine.feed_xy / 120.0, 1.0)
        record = self._board_record("look", "top", job, self.top.client, board, self._top_picture(machine))
        self.top_look.start(
            job_id, job.design.board_to_job, middle, self._top_look_place, record, features=self._look_features(job), outline=self._board_box(job),
        )
        return self.publish_placing()

    def _top_board_settings(self, job_id: str) -> dict:
        """What the job's board is loaded into the top camera's pcbv with
        besides its file: the camera's side, finish and paste, the scale
        range its search keeps to once the scale is measured, and the parts
        placed on the board now on the machine."""
        settings = self.top.settings()
        scale = scale_range(settings.mm_per_px)
        design = self._design_top_scale()
        if scale is None and design:
            scale = (design / DESIGN_SCALE_SPREAD, design * DESIGN_SCALE_SPREAD)
        return {
            "side": settings.side, "finish": settings.finish, "scale": scale,
            "paste": settings.paste, "placed": list(self._board_placed.get(job_id, [])), "color": settings.colors.get("board"),
        }

    def _design_top_scale(self) -> float | None:
        """The top camera's scale as the placing machine's file designs it,
        mm per full size pixel; None when it says none or no machine is known."""
        try:
            machine = self.placing_machine()
        except (ValueError, LookupError, HTTPException):
            return None
        return machine.top.mm_per_px if machine.top is not None else None

    def _tell_assembly(self, job_id: str) -> None:
        """The top camera's pcbv, looking for the job's board, told the
        paste and parts on it now, so its model shows the placed parts'
        bodies and goes on tracking. A failure is logged: the look goes on
        with the model it has."""
        if self.top_look.job != job_id or not self.top.client.running:
            return
        try:
            self.top.client.assembly(paste=self.top.settings().paste, placed=list(self._board_placed.get(job_id, [])))
        except Exception as exc:  # never stops a run
            log.warning("top camera: the parts placed were not told to pcbv: %s", exc)

    def _top_picture(self, machine: GcodeMachine) -> dict:
        """The top camera's place and scale, for a search record; its
        offset None while not measured."""
        settings = self.top.settings()
        try:
            offset = list(self._top_offset(machine))
        except (ValueError, LookupError, HTTPException):
            offset = None
        return {
            "offset": offset, "roll": self._top_roll(machine), "mirror": settings.mirror,
            "mm_per_px": settings.mm_per_px, "device": settings.device, "pcbv": settings.pcbv, "lens": settings.lens,
            "machine": machine.name,
            # The crops its looks kept to, by task (crops.py).
            "crops": {task: list(box) for task, box in (machine.top.crops if machine.top is not None else {}).items()},
        }

    def _top_look_place(self, captured: float) -> PictureFrame | str:
        """Where the top camera's picture lay on the machine for a frame
        taken at `captured`: the head's place as last read or moved to,
        plus the camera's offset in use, once the move there has had time
        to end."""
        if self.gcode.running:
            return "a placing run is moving the head"
        position = self.gcode.position
        here = (float(position["x"]), float(position["y"])) if isinstance(position, dict) and "x" in position and "y" in position else None
        quiet = self._top_rest.see(here)
        if quiet is None:
            return "the head's place is not known: jog it, or read the position"
        if captured < quiet:
            return "the head is moving"
        machine = self._placing_machine_or_none()
        if machine is None:
            return "the placing machine's file does not read"
        # With no offset known the picture's place is the head's: the
        # look's places are then the camera's own (_top_offset_in_use).
        offset = self._settle_top_look(machine)
        return PictureFrame((here[0] + offset[0], here[1] + offset[1]), self._top_roll(machine), self.top.settings().mirror)

    def top_search(self, body: BoardSearchBody) -> dict:
        """Moves the top camera over a box until enough looks agree on the
        board loaded (boardlook.py), on its routine thread."""
        machine = self._placing_idle()
        if self.top_look.job is None:
            raise ValueError("no board loaded: press Look for board first")
        job = self._job(self.top_look.job)
        _, diagonal = self._board_size(job)
        offset = self._settle_top_look(machine)
        settings = self.top.settings()
        roll = self._top_roll(machine)
        width, height, scale = self._look_scale(self.top.client, settings.mm_per_px, self.top_look.scale_seen or self._design_top_scale())
        here = self._here(machine)
        center = (float(here["x"]) + offset[0], float(here["y"]) + offset[1])
        known = self._top_known(job, settings.corner_mm)
        prior = self._top_known(job, settings.corner_mm, corners=False)
        box = body.box if body.box is not None else self._corners_box(self.top_look, job, settings.corner_mm)
        coarse = None
        quick = None
        view = (width * scale, height * scale)
        bed = machine.top.bed if machine.top is not None else None
        area = machine.top.board_area if machine.top is not None else None
        only = bool(machine.top.board_area_only) if machine.top is not None else False
        outline = self._board_box(job)
        stops: list[tuple[float, float]] = []
        if box is None and known is None and (bed is not None or area is not None) and outline is not None:
            # Nothing says where the board is: a quick scan of where boards
            # lie, its stops spaced by the board's size so one falls well
            # inside it. A board area in the file is scanned first; the rest
            # of the bed after it, unless boards only ever lie within it.
            coarse = QUICK_SHARE * min(outline[2] - outline[0], outline[3] - outline[1])
            first = area if area is not None else bed
            stops = search_stops(first, view, center, coarse)
            quick = quick_first(first, view, coarse)
            if area is not None and bed is not None and not only:
                stops += [point for point in search_stops(bed, view, stops[-1], coarse) if not _inside(area, point)]
            box = first if only or bed is None else bed
        box = box or search_box(center, diagonal)
        if not stops:
            stops = search_stops(box, view, known.place.center if known is not None else center, coarse)
        # The board crop pcbv looks in, where the checks count pads.
        crop_box = crop_box_mm(self.top.board_crop(), width, height, scale, roll, settings.mirror)
        if known is not None:
            # Where the known place puts the most pads in a picture first:
            # its middle may be bare, its edges lock wrong.
            stops = self._check_places(job, (width * scale, height * scale), crop_box)(known.place)[:KNOWN_FIRST] + stops
        # The posterior steers to the stop that tells most for its time,
        # unless a known place already put the board's dense places first:
        # steered past them, a LumenPnP search waited out bare stops.
        steer = (
            {"width": width, "height": height, "scale": scale, "speed": max(machine.feed_xy / 60.0, 1.0), "start": center}
            if settings.look_method == "posterior" and known is None else None
        )
        z = machine.top.z if machine.top is not None else None
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)
        look = self.top_look
        steps = ("lifting", *[f"stop {index + 1}" for index in range(len(stops))], "done")

        def run(progress) -> None:
            mover.begin()
            self.top._step(progress, "lifting")
            mover.lift()
            if z is not None:
                mover.lower(z)
            record = self._board_record(
                "search", "top", job, self.top.client, self._top_board_settings(job.id),
                {**self._top_picture(machine), "width": width, "height": height, "mm_per_px_used": scale, "z": z},
                search_extra(box, center, stops, width * scale, height * scale, known),
            )
            found = search(
                look, mover, stops, offset, lambda point: PictureFrame(point, roll, settings.mirror),
                mover.stopped, lambda index, count: self.top._step(progress, f"stop {index + 1}"), PnpError, record,
                checks=self._check_places(job, (width * scale, height * scale), crop_box), known=known, side=settings.side, box=box, prior=prior,
                steer=steer, picture=(width, height, scale), outline=self._board_box(job),
                quick=quick,
            )
            self._learn_from_look("top", look, found)
            self.top._message("info", found_text(found, look.consensus))
            self._offer_top_picture(machine, found, look.scale_seen)

        self.top._begin("search", steps, mover, run)
        return self.placing_state()

    def _offer_top_picture(self, machine: GcodeMachine, found, scale: float | None) -> None:
        """A board found from looks far apart says the top camera's roll
        (the roll in use plus the guess's `roll_off`) and pcbv its scale:
        kept at once and logged (findings.py, Undo takes them back) when
        they differ from the camera's settings (by PICTURE_ROLL_DEG, or a
        scale not measured), so the picture is measured without a mark.
        A scale measured is kept: `scale` is pcbv's newest lock's, which
        may be a wrong lock's (a LumenPnP search's last check locked a
        repeated cell 39 mm off at 3% over the scale), and a search moved
        a measured 16.13 um to 16.47. The offset still needs a mark."""
        roll_off = getattr(found, "roll_off", None)
        if found is None or roll_off is None or not scale or scale <= 0.0:
            return
        settings = self.top.settings()
        in_use = self._top_roll(machine)
        roll = in_use + roll_off
        unmeasured = settings.mm_per_px <= 0.0
        if not unmeasured and abs(roll_off) < PICTURE_ROLL_DEG:
            return
        words = f"the board's turn from the head's moves puts the top camera's roll at {roll:.2f} degrees ({in_use:.2f} in use)"
        patch: dict = {"roll": roll}
        if unmeasured:
            words += f" and pcbv its scale at {scale * 1000.0:.2f} um a pixel"
            patch["mm_per_px"] = scale
        self.top._message("info", self.top.findings.keep("picture", words, patch))

    def top_scan(self, body: BoardScanBody) -> dict:
        """Moves the top camera over the whole board where a rough place
        puts it, row by row, stopping for each picture (a G-code machine
        reports its place only at rest), every one weighed by the look and
        kept for the mosaic (boardlook.scan), on its routine thread."""
        machine = self._placing_idle()
        if self.top_look.job is None:
            raise ValueError("no board loaded: press Look for board first")
        job = self._job(self.top_look.job)
        offset = self._settle_top_look(machine)
        settings = self.top.settings()
        roll = self._top_roll(machine)
        width, height, scale = self._look_scale(self.top.client, settings.mm_per_px, self.top_look.scale_seen or self._design_top_scale())
        known = self._top_known(job, settings.corner_mm)
        box, stops, outline = self._scan_plan(self.top_look, job, known, (width * scale, height * scale), body.margin)
        prior = self._top_known(job, settings.corner_mm, corners=False)
        here = self._here(machine)
        center = (float(here["x"]) + offset[0], float(here["y"]) + offset[1])
        z = machine.top.z if machine.top is not None else None
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)
        look = self.top_look
        steps = ("lifting", *[f"picture {index + 1}" for index in range(len(stops))], "done")

        def run(progress) -> None:
            mover.begin()
            self.top._step(progress, "lifting")
            mover.lift()
            if z is not None:
                mover.lower(z)
            record = self._board_record(
                "scan", "top", job, self.top.client, self._top_board_settings(job.id),
                {**self._top_picture(machine), "width": width, "height": height, "mm_per_px_used": scale, "z": z},
                {**search_extra(box, center, stops, width * scale, height * scale, known), "motion": "stop"},
            )
            found = scan(
                look, mover, stops, offset, lambda point: PictureFrame(point, roll, settings.mirror),
                mover.stopped, lambda index, count: self.top._step(progress, f"picture {index + 1}"), PnpError, record,
                box=box, prior=prior, picture=(width, height, scale), outline=outline,
            )
            self._learn_from_look("top", look, found)
            self.top._message("info", scan_text(found, look.consensus, len(stops)))

        self.top._begin("scan", steps, mover, run)
        return self.placing_state()

    def _top_known(self, job, corner_mm: float, corners: bool = True) -> KnownPlace | None:
        """Where the top camera's search expects the job's board: where the
        corners taken put it (unless `corners` is false: the posterior
        weighs them as evidence of their own), else where the camera found
        it, else where the job's references (fiducials found, places taken
        by hand) put it (boardlook.known_place). The job's own frame is not
        the G-code machine's, so it says nothing here."""
        middle, diagonal = self._board_size(job)
        look = self.top_look
        references = None
        try:
            # The corners the look holds are weighed on their own (taken, or
            # by the posterior), not again as references; corners kept as
            # references the look no longer holds (taken before a restart)
            # count among the references.
            # The look's places are the camera's: with no offset known,
            # references taken by the nozzle say nothing of them.
            fit = self._board_fit(job.id, self.job_parts(job.id)["components"], corners=not look.corners_of(job.id), frame="camera")
            references = measured_known("references", fit.rotation, fit.shift, fit.rms, fit.marks, middle)
        except Exception:  # no references, none of the job's parts, or none in the camera's frame: nothing known from them
            references = None
        taken = corners_known(look.corners_of(job.id), middle, corner_mm, diagonal) if corners else None
        return known_place(taken, look.found_known(job.id), references)

    def top_place(self, body: BoardPlaceBody) -> dict:
        """The board's place the top camera's look found, else the place
        the corners taken of it give, kept as the job's references: the two
        parts furthest apart (fiducials first) where it puts them, by
        `look` or `corners`; Find fiducials then refines them. Each keeps
        the camera's offset the place was made with, so an offset measured
        after moves it (reference_place)."""
        offset = self._settle_top_look(self._placing_machine_or_none())
        consensus = self.top_look.consensus
        best = consensus.best if self.top_look.job == body.job and consensus.found else None
        by = "look"
        if best is None:
            best = self.top_look.rough(body.job)
            by = "corners"
        if best is None:
            raise ValueError(
                "the top camera has not found this job's board: Look for board, then Search, until a guess is likely enough;"
                " or put the picture's center on its corners and take them"
            )
        parts = self.job_parts(body.job)["components"]
        if len(parts) < 2:
            raise ValueError("the board needs two parts to take its place from")
        fiducials = [part for part in parts if part.get("fiducial")]
        pool = fiducials if len(fiducials) >= 2 else parts
        pair = max(
            ((a, b) for index, a in enumerate(pool) for b in pool[index + 1:]),
            key=lambda ab: (ab[0]["x"] - ab[1]["x"]) ** 2 + (ab[0]["y"] - ab[1]["y"]) ** 2,
        )
        with self._config_lock:
            config = self._placing_config()
            refs = {part["ref"] for part in pair}
            # This place takes over from the places a look or corners gave
            # before, the corners taken as references among them.
            kept = [
                entry for entry in config.get("references", [])
                if not (entry.get("job") == body.job and (entry.get("ref") in refs or entry.get("by") in ("look", "corners", "corner")))
            ]
            for part in pair:
                at = best.apply((float(part["x"]), float(part["y"])))
                kept.append({"job": body.job, "ref": part["ref"], "at": [round(at[0], 4), round(at[1], 4)], "by": by, "offset": list(offset)})
            config["references"] = kept
        self._save_config()
        return self.publish_placing()

    def top_corner(self, body: BoardCornerBody) -> dict:
        """The top camera's picture's center is on a corner of the job's
        board: the machine point under it is kept for that corner, the
        guesses weighed against it and a rough place made (boardlook.py),
        and kept as one of the job's references, which Nozzle to Part, Camera to Part, Find
        fiducials and a plan place the board by."""
        machine = self._placing_idle()
        job = self._job(body.job)
        point = self._corner_point(job, body.corner)
        here = self._here(machine)
        offset = self._settle_top_look(machine)
        middle, _ = self._board_size(job)
        at = (float(here["x"]) + offset[0], float(here["y"]) + offset[1])
        self.top_look.add_corner(job.id, body.corner, point, at, middle)
        self._keep_corner(job.id, body.corner, point, at, None, offset)
        return self.publish_placing()

    def _keep_corner(self, job_id: str, name: str, point: tuple[float, float], at: tuple[float, float], angle: float | None, offset: tuple[float, float]) -> None:
        """A corner taken of the job's board kept as one of its references
        (`by` corner): its place in the job's frame (`point`) paired with
        where it lies on the machine, in place of one taken of that corner
        before; a corner found by its edges keeps the board's turn they
        showed, which a lone reference is turned by. `offset` is the top
        camera's it was taken with, kept beside it (reference_place)."""
        ref = f"corner {name}"
        entry: dict = {
            "job": job_id, "ref": ref, "at": [round(at[0], 4), round(at[1], 4)], "by": "corner",
            "point": [round(point[0], 4), round(point[1], 4)], "offset": list(offset),
        }
        if angle is not None:
            entry["angle"] = round(angle, 4)
        with self._config_lock:
            config = self._placing_config()
            kept = [item for item in config.get("references", []) if not (item.get("job") == job_id and item.get("ref") == ref)]
            config["references"] = [*kept, entry]
        self._save_config()

    def top_edge_corner(self, body: BoardCornerBody) -> dict:
        """The top camera sees a corner of the job's (blank) board against
        the bed: where its two edges meet is kept as that corner, with the
        board's turn they show."""
        machine = self._placing_idle()
        job = self._job(body.job)
        point = self._corner_point(job, body.corner)
        settings = self.top.settings()
        if settings.mm_per_px <= 0.0:
            raise ValueError(SCALE_NEEDED)
        if not self.top.client.running:
            raise ValueError("the top camera is not running: start it first")
        here = self._here(machine)
        offset = self._settle_top_look(machine)
        frame = PictureFrame((float(here["x"]) + offset[0], float(here["y"]) + offset[1]), self._top_roll(machine), settings.mirror)
        corner, rotation, marks = self._edge_corner(
            self.top.client, "top", self.top_look, body.corner, frame, settings, crop=self.top.crop("edges"), uncropped=self.top._no_crops,
        )
        middle, _ = self._board_size(job)
        words = f"{body.corner} corner found by its edges at {corner[0]:.3f}, {corner[1]:.3f} mm, the board turned {rotation:+.3f} degrees"
        # Taken at once and logged: the look's corners come back by an undo
        # this backend run holds, the references by their values.
        before = self.top.findings.read("references")
        undo = take_corner(self.top_look, job.id, body.corner, point, corner, middle, rotation)
        # A corner taken is also one of the board's references.
        self._keep_corner(job.id, body.corner, point, corner, rotation, offset)
        changes = self.top.findings.since(before, "references", (job.id,))
        self.publish_message("info", self.top.findings.apply("corner", words, changes, {**marks, "points": [{"at": list(corner), "label": body.corner}]}, undo))
        return self.publish_placing()

    def top_corners_clear(self) -> dict:
        """The corners taken forgotten, the references they were kept as too."""
        job = self.top_look.corners_job
        self.top_look.clear_corners()
        if job is not None:
            with self._config_lock:
                config = self._placing_config()
                config["references"] = [entry for entry in config.get("references", []) if not (entry.get("job") == job and entry.get("by") == "corner")]
            self._save_config()
        return self.publish_placing()

    def top_frame(self, width: int, overlay: bool) -> bytes:
        return self.top_frame_and_age(width, overlay)[0]

    def top_frame_and_age(self, width: int, overlay: bool) -> tuple[bytes, dict]:
        """The top camera's picture with its frame number and age (ms)."""
        from .backend_shared import _check_frame_width

        _check_frame_width(width)
        return self.top.frame_and_age(width, overlay)

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

    def top_measure(self, step: float = 0.0, approach: float | None = None, settle: float = 0.0) -> dict:
        """Measure camera: the top camera's scale, roll and mirror from the
        head's moves over whatever lies under it (topcam.measure_picture),
        on its routine thread; the roll measured is written the way nearest
        the one in use."""
        machine = self._placing_idle()
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)
        profile = machine.top
        self.top.measure_picture(
            mover, step, profile.z if profile is not None else None, near_roll=self._top_roll(machine),
            approach=APPROACH_MM if approach is None else approach, settle=settle,
        )
        return self.placing_state()

    def top_home(self, home: bool = True) -> dict:
        """Homes the machine, then finds the bed's homing fiducial with the
        top camera and declares where the head is from it (visual homing,
        OpenPnP's head homing fiducial). With `home` false the machine is
        not homed first: the fiducial is found from where the head's numbers
        put it now, and they are tied to it again (a check after a long run
        or a knock, quicker than a home)."""
        machine = self._placing_idle()
        profile = machine.top
        if profile is None or profile.home_fiducial is None:
            raise ValueError(f"{machine.name}'s file has no [top_camera] home_fiducial")
        if home and not machine.home:
            raise ValueError(f"{machine.name}'s file has no [gcode] home command")
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)

        def homing() -> None:
            self._lift_before_home(machine)
            self.gcode.command(machine.home, machine.timeout * HOME_TIMEOUTS)
            self.gcode.homed = True

        def declare(head: tuple[float, float]) -> None:
            self.gcode.command(declare_line(machine, {"x": head[0], "y": head[1]}), machine.timeout)

        self.top.home_by_fiducial(mover, profile.home_fiducial, profile.fiducial, profile.within, profile.z, homing if home else None, declare)
        return self.placing_state()

    def top_look_once(self) -> dict:
        """The top camera's mark spot found once, no move: kept in its state
        for the page to draw over the picture."""
        self.top.look_once(self.top.settings().mark_spot)
        return self.publish_placing()

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

    def _top_offset_in_use(self, machine: GcodeMachine | None) -> tuple[tuple[float, float], bool]:
        """The top camera's offset its looks go by, and whether one is
        known: as measured, else as the machine's design has it, else 0, 0
        and False. With none known a place the camera takes is the
        camera's own: where the head stood with the picture's center on
        the point. Finding a board needs no more than that; the offset is
        applied when it is measured (reference_place, _settle_top_look)."""
        top = self.top.settings()
        if top.offset is not None:
            return (float(top.offset[0]), float(top.offset[1])), True
        if machine is not None and machine.top is not None and machine.top.offset is not None:
            return (float(machine.top.offset[0]), float(machine.top.offset[1])), True
        return (0.0, 0.0), False

    def _placing_machine_or_none(self) -> GcodeMachine | None:
        """The placing machine's file, or None with none that reads."""
        try:
            return self.placing_machine()
        except (ValueError, LookupError, HTTPException):
            return None

    def _settle_top_look(self, machine: GcodeMachine | None) -> tuple[float, float]:
        """The top camera's offset in use, with the places its look holds
        (corners taken, boards found, guesses) brought onto it first: they
        were made with the offset in use then, and when that has moved
        since (Measure offset, a typed one, an Undo, the file's) they move
        by the difference and the guesses start over, said once. The first
        call, and one for another machine, only notes the offset."""
        offset, _ = self._top_offset_in_use(machine)
        machine_id = machine.id if machine is not None else None
        with self._top_look_settle:
            made = self._top_look_offset
            self._top_look_offset = (machine_id, offset)
            if made is None or made[0] != machine_id:
                return offset
            dx, dy = offset[0] - made[1][0], offset[1] - made[1][1]
            if abs(dx) < 1e-9 and abs(dy) < 1e-9:
                return offset
            moved = self.top_look.shift(dx, dy)
        if moved:
            self.publish_message(
                "info",
                f"the top camera's offset moved by X {dx:+.3f} Y {dy:+.3f} mm:"
                " the corners and the place found moved with it, the guesses start over",
            )
        return offset

    def _top_roll(self, machine: GcodeMachine) -> float:
        """The turn of the top camera's picture, degrees: as measured with
        its scale, else as the machine's design has it, else the settings'
        (0 until set)."""
        top = self.top.settings()
        if top.mm_per_px <= 0.0 and machine.top is not None and machine.top.roll is not None:
            return machine.top.roll
        return top.roll

    def pnp_fiducials(self, body: PnpFiducialsBody) -> dict:
        """Finds the board's fiducials with the top camera where the
        references put them and keeps them as the job's references; on the
        top camera's routine thread. The camera goes by its offset in use,
        measured or not: the camera goes to a place and reads one off its
        own picture, so the offset drops out of the looking, and each
        fiducial keeps the one it was found with (reference_place). Only
        the scale has to be measured."""
        machine = self._placing_idle()
        if machine.top is None:
            raise ValueError(f"{machine.name}'s file has no [top_camera] table")
        top = machine.top
        parts = self.job_parts(body.job)["components"]
        fiducials = [part for part in parts if part.get("fiducial")]
        offset, _ = self._top_offset_in_use(machine)
        guess = self._board_fit(body.job, parts, frame="camera")
        mover = GcodeMover(self.gcode, machine, aborted=self.top.aborting)

        def done(found: list[Found]) -> str:
            fit = fiducial_fit(found, guess.rotation)
            rms = f", {fit.rms * 1000.0:.0f} um rms" if len(found) > 1 else ""
            words = f"{len(found)} fiducials found: the board is turned {fit.rotation:+.3f} degrees on the machine{rms}"
            # Kept at once and logged with the references they replaced.
            before = self.top.findings.read("references")
            self._keep_fiducials(body.job, found, fit, offset)
            points = [{"at": list(entry.seen), "label": entry.ref} for entry in found]
            return self.top.findings.apply("fiducials", words, self.top.findings.since(before, "references", (body.job,)), {"points": points})

        self.top.find_fiducials(mover, fiducials, guess.apply, top.fiducial, top.within, top.z, done, offset=offset)
        return self.placing_state()

    def _keep_fiducials(self, job_id: str, found: list[Found], fit, offset: tuple[float, float] | None = None) -> None:
        """The fiducials found become the job's references: with two or
        more, the ones given by hand give way to them. `offset` is the top
        camera's they were found with, kept beside each (reference_place);
        left out, the one in use now (a placing run's, the measured one)."""
        if offset is None:
            offset, _ = self._top_offset_in_use(self._placing_machine_or_none())
        with self._config_lock:
            config = self._placing_config()
            refs = {entry.ref for entry in found}
            kept = [
                entry for entry in config.get("references", [])
                if not (entry.get("job") == job_id and (entry.get("ref") in refs or (len(found) > 1 and entry.get("by") != "fiducial")))
            ]
            kept.extend({"job": job_id, "ref": entry.ref, "at": [entry.seen[0], entry.seen[1]], "by": "fiducial", "offset": list(offset)} for entry in found)
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
        the machine, read off it when not given. One read with the top
        camera's picture center on the part keeps the camera's offset it
        was taken with (0, 0 with none known: the head's place), and moves
        with the offset after (reference_place)."""
        self._part(body.job, body.ref)
        machine = self.placing_machine()
        taken: tuple[float, float] | None = None
        if body.at is None:
            offset = (0.0, 0.0)
            if body.camera:
                offset, _ = self._top_offset_in_use(machine)
                taken = offset
            here = self._here(self._placing_idle())
            at = (float(here["x"]) + offset[0], float(here["y"]) + offset[1])
        else:
            if any(abs(value) > 10000.0 for value in body.at):
                raise ValueError("a reference's place must be within 10000 mm")
            at = (float(body.at[0]), float(body.at[1]))
        config = self._placing_config()
        kept = [entry for entry in config.get("references", []) if not (entry.get("job") == body.job and entry.get("ref") == body.ref)]
        entry: dict = {"job": body.job, "ref": body.ref, "at": [round(at[0], 4), round(at[1], 4)], "by": "camera" if body.camera else "nozzle"}
        if taken is not None:
            entry["offset"] = list(taken)
        kept.append(entry)
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

    def _board_fit(self, job_id: str, parts: list[dict], corners: bool = True, frame: str = "nozzle"):
        """Where the job's board lies on the machine, from its references:
        parts taken by hand, the fiducials found (two or more outdo the
        rest), and the corners taken of its board (each a reference of its
        own, `point` its place in the job; left out with `corners` false).
        One reference alone is turned by the typed angle, else by the turn
        a corner's edges showed.

        Each reference is read with the top camera's offset in use now
        (reference_place). While no offset is known at all, the ones taken
        through the camera are the camera's places (the head's, with the
        picture's center on the point) and the others the nozzle's, a
        distance apart nothing here knows: `frame` says whose places the
        caller goes by ("nozzle" to put the nozzle on the board, "camera"
        to put the picture's center there, the answer then to be used with
        the offset in use), and a fit whose references are of the other
        kind, or of both, is refused. With an offset known both are one."""
        by_ref = {part["ref"]: part for part in parts}
        pairs = []
        turns = []
        frames: set[str] = set()
        offset, known = self._top_offset_in_use(self._placing_machine_or_none())
        entries = [entry for entry in self._placing_config().get("references", []) if entry.get("job") == job_id]
        found = [entry for entry in entries if entry.get("by") == "fiducial" and entry.get("ref") in by_ref]
        for entry in found if len(found) > 1 else entries:
            try:
                at = reference_place(entry, offset)
                if entry.get("by") == "corner":
                    if not corners:
                        continue
                    point = (float(entry["point"][0]), float(entry["point"][1]))
                    turns.append(entry.get("angle"))
                elif entry.get("ref") in by_ref:
                    part = by_ref[entry["ref"]]
                    point = (float(part["x"]), float(part["y"]))
                    turns.append(None)
                else:
                    continue
            except (KeyError, TypeError, ValueError, IndexError):
                continue
            pairs.append((point, at))
            frames.add("camera" if reference_offset(entry) is not None else "nozzle")
        if not known and len(frames) > 1:
            raise ValueError(MIXED_NEEDS_OFFSET)
        if not known and frames and frame not in frames:
            raise ValueError(NOZZLE_NEEDS_OFFSET if frame == "nozzle" else CAMERA_NEEDS_OFFSET)
        angle = self._placing_config().get("angle")
        typed = float(angle) if isinstance(angle, (int, float)) and not isinstance(angle, bool) else None
        if typed is None and len(pairs) == 1 and isinstance(turns[0], (int, float)):
            typed = float(turns[0])
        return board_fit(pairs, typed)

    def gcode_goto_part(self, body: PnpGotoBody) -> dict:
        """The nozzle, or the top camera's picture center, over a part's place
        on the machine: X and Y only, as a goto goes across. The nozzle goes
        up to the safe height first only from below it (on a seesaw Z from
        above it too); it never comes down. The camera goes by its offset
        in use, known or not: over a place it took itself the offset drops
        out."""
        machine = self._placing_idle()
        parts = self.job_parts(body.job)["components"]
        part = self._part(body.job, body.ref, parts)
        fit = self._board_fit(body.job, parts, frame="camera" if body.camera else "nozzle")
        x, y = fit.apply((float(part["x"]), float(part["y"])))
        if body.camera:
            offset, _ = self._top_offset_in_use(machine)
            x, y = x - offset[0], y - offset[1]
        self._head_lines(machine, goto_lines(machine, self._here(machine), {"x": x, "y": y}))
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

        def on_placed(ref: str) -> None:
            self._board_placed.setdefault(body.job, []).append(ref)
            self._tell_assembly(body.job)

        setup = PlaceSetup(
            up=self.pnp,
            up_place=self._up_place(machine),
            top=self.top,
            on_taken=on_taken,
            on_fiducials=lambda found, fit: self._keep_fiducials(body.job, found, fit),
            message=self.publish_message,
            publish_up=self.publish_pnp,
            on_placed=on_placed,
        )
        placement = Placement(
            machine, self.gcode, parts, self._board_fit(body.job, parts), taken, body.refs, title, setup,
            fiducials=body.fiducials,
        )
        program = placement.program
        if not program.blocks:
            counts: dict[str, int] = {}
            for entry in program.skipped:
                counts[entry["reason"]] = counts.get(entry["reason"], 0) + 1
            why = "; ".join(f"{count} part{'' if count == 1 else 's'} {reason}" for reason, count in sorted(counts.items(), key=lambda item: -item[1]))
            raise GcodeLinkError(f"the program places no part{': ' + why if why else ''}")
        if any(block.vision for block in program.blocks) and not self.pnp.running:
            raise ValueError("the bottom camera is not running: start it, since some parts are to be looked at over it")
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

        # A run places on the next board, bare of parts.
        self._board_placed[body.job] = []
        self._tell_assembly(body.job)
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
        here = self._here(machine)
        # The head waits at the safe height, or above it where Z grows upward.
        want = {"x": machine.park[0], "y": machine.park[1]}
        if needs_lift(machine, here.get("z")):
            want["z"] = machine.safe_z
        self._head_lines(machine, goto_lines(machine, here, want))
        return self.publish_placing()

    def pnp_over_camera(self) -> dict:
        """The nozzle over the up camera, turned to 0, at the height it is
        sharp at there (the safe height when the file gives none): across
        at the safe height, the height last."""
        machine = self._placing_idle()
        place = self._up_place(machine)
        if place.position is None:
            raise ValueError("the bottom camera's place on the machine is not known: set it, or Center nozzle over it")
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

    def pnp_bus_scan(self, feeders: list[str] | None = None) -> dict:
        """The feeders that answer on the bus, by address, each with its id
        and the file's feeder of that id, when there is one. With `feeders`
        (the file's feeders by name), only those are looked for, each by its
        id (one question each, not one per address); `missing` names those
        that did not answer, or are not on the bus."""
        machine = self._placing_idle()
        bus = self._bus(machine)
        missing: list[dict] = []
        if feeders is None:
            found = bus.scan()
        else:
            by_name = {feeder.id: feeder for feeder in machine.feeders}
            unknown = [name for name in feeders if name not in by_name]
            if unknown:
                raise HTTPException(status_code=404, detail=f"{machine.name}'s file has no feeder {unknown[0]!r}")
            found = []
            for name in dict.fromkeys(feeders):
                feeder = by_name[name]
                if feeder.bus_id is None:
                    missing.append({"feeder": name, "id": None, "reason": "not on the bus: its file gives no bus_id"})
                    continue
                try:
                    address = bus.find(feeder.bus_id)
                except BusError as exc:
                    raise GcodeLinkError(f"feeder {name}: {exc}") from exc
                if address is None:
                    missing.append({"feeder": name, "id": feeder.bus_id, "reason": "did not answer to its id: is it in a slot?"})
                else:
                    found.append({"address": address, "id": feeder.bus_id})
            found.sort(key=lambda entry: entry["address"])
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
            "missing": missing,
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

