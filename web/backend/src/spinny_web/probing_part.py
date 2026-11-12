"""The backend's probing part: the height map and its probe settings, a
map probed over a grid or at pads, a single touch that sets the copper's
height or ties the map, focus here and keep focus, and which compensation
a run follows. Backend is made of this part, the G-code part, the
placing part and its own: the methods use the backend's link, settings
and publishing as theirs."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from fastapi import HTTPException

from spinny_laser import pads as board_pads

from .backend_shared import SURFACE_TOLERANCE, TOUCH_CLEARANCE, _s_max, _soft_limits, _tip_point
from .heightmap import (
    AUTO,
    FOCUS,
    MODES,
    OFF,
    POWER,
    Compensation,
    Grid,
    HeightMap,
    check_covers,
    estimate_points_seconds,
    job_extent,
    nearest_clear_point,
)
from .jobs import Job
from .kinematics import head_board, num
from .link import Link, LinkError
from .log import log
from .prober import ProbeSettings, reach_joint, touch_moves

if TYPE_CHECKING:
    from .app import PadsBody, ProbeBody, ProbeConfigBody, TouchBody


class ProbingPart:
    """The height map's, the touch probe's, focus's and compensation's
    methods, mixed into Backend."""

    def probe_settings(self) -> ProbeSettings:
        try:
            settings = ProbeSettings.model_validate(self.config.get("probe", {}))
            settings.check()
            return settings
        except ValueError:
            return ProbeSettings()

    def heightmap_state(self) -> dict:
        heightmap = self.heightmaps.get()
        return {
            "map": heightmap.model_dump() if heightmap is not None else None,
            "probe": self.prober.snapshot(),
            "settings": self.probe_settings().model_dump(),
        }

    def put_heightmap(self, heightmap: HeightMap) -> dict:
        """Puts back a map, from a file say. Its heights are from a session
        whose focus axis frame nothing here knows, so it needs focus here
        before a run follows it, whatever it says of its offset."""
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        heightmap.focus_set = False
        with self._map_lock:
            self.heightmaps.put(heightmap)
            self._heights_frame = None
        return self.publish_heightmap()

    def clear_heightmap(self) -> dict:
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        with self._map_lock:
            self.heightmaps.put(None)
            self._heights_frame = None
        return self.publish_heightmap()

    def update_probe_settings(self, body: ProbeConfigBody) -> dict:
        patch = body.model_dump(exclude_none=True)
        settings = ProbeSettings.model_validate({**self.probe_settings().model_dump(), **patch})
        settings.check()
        self.config["probe"] = settings.model_dump()
        self._save_config()
        return self.publish_heightmap()

    def probe_grid(self, body: ProbeBody) -> tuple[Grid, HeightMap | None]:
        """The grid a probe request asks for, and the map to go on with
        when it asks to resume. Without a job the grid is probed whole."""
        if body.resume:
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("there is no height map to go on with: probe the board first")
            if heightmap.complete:
                raise ValueError("the height map is complete: nothing is left to probe")
            return heightmap.grid, heightmap
        grid = Grid(x0=body.x0, y0=body.y0, x1=body.x1, y1=body.y1, nx=body.nx, ny=body.ny, mask=body.mask)
        grid.check()
        if body.job is not None:
            job = self._job(body.job)
            margin = float(body.margin) if body.margin is not None else 1.0
            if not (math.isfinite(margin) and 0.0 <= margin <= 100.0):
                raise ValueError("the margin must be 0 to 100 mm")
            grid = grid.with_mask_for(job, margin, float(job.spot or 0.0))
        return grid, None

    def probe_estimate(self, body: ProbeBody) -> dict:
        """About how long probing `body` would take, and the grid it would
        probe, mask included, without touching the machine."""
        grid, resume = self.probe_grid(body)
        settings = self.probe_settings()
        points = len(resume.remaining()) if resume is not None else grid.points
        seconds = grid.estimate_seconds(settings, self.rates)
        if resume is not None and grid.points > 0:
            seconds = seconds * points / grid.points
        return {"seconds": round(seconds, 1), "points": points, "grid": grid.model_dump()}

    def start_probe(self, body: ProbeBody) -> dict:
        grid, resume = self.probe_grid(body)
        self._start_map_probe(grid, resume)
        log.info("probing started: %d points%s", len(resume.remaining()) if resume is not None else grid.points, ", going on with the map" if resume is not None else "")
        return self.heightmap_state()

    def _start_map_probe(
        self,
        grid: Grid | None,
        resume: HeightMap | None,
        points: list[tuple[float, float]] | None = None,
        box: tuple | None = None,
    ) -> None:
        """Starts probing a map: `grid`, or the pads at `points` in `box`
        with no grid; with `resume`, going on with that map."""
        # The check that no run is under way and the prober's claim are one
        # step: a run asked for at the same moment waits for this, then
        # finds the board being probed.
        with self._owner_lock:
            link = self._movable()
            # Claimed before the settings are read: a stop or reset while
            # they are keeps the probing from starting.
            self.prober.reserve(link)
            try:
                r_max, z_max = _soft_limits(self._values(force=True))
                # The tool may be the probe: a spindle has to be stopped.
                spindle_off = self._off_duty() if self.milling else None
                with self._move_lock:
                    self._jog_target = None
                    status = link.status_now(1.0, routine=True)
                    frame = self._frame
                    if resume is not None and self._heights_frame != frame:
                        raise ValueError(
                            "the focus axis was renumbered since the map was probed (a connect, a restart or a"
                            " position set): its heights and the new ones would not agree, so probe it anew"
                        )
                    self.prober.start(
                        self.probe_settings(),
                        link,
                        self.streamer(status),
                        r_max,
                        z_max,
                        spindle_off,
                        keep_focus=self._heights_frame == frame,
                        grid=grid,
                        travel=self.travel_height,
                        resume=resume,
                        points=points,
                        box=box,
                    )
                    self._heights_frame = frame
            finally:
                # A start that went through has let go of the claim already.
                self.prober.release()

    def touch_probe(self, body: TouchBody, dry_run: bool = False) -> dict:
        """One probe down where the head is or, `at` nearest, at the probed
        point of the map nearest the tip that the job's cuts leave clear,
        which the head goes to first. With `map`, the height found ties
        the height map to the focus axis frame in use: the offset moves
        by what the surface reads there against what the map says, so a
        map probed before a power cycle, a restart or a position set
        follows the board again without probing it all over. With `zero`
        the contact height becomes H 0. `dry_run` only says where the
        probe would go down, and how the head gets there.
        """
        if body.mode not in ("map", "zero"):
            raise ValueError("mode must be map or zero")
        if body.at not in ("here", "nearest"):
            raise ValueError("at must be here or nearest")
        if body.mode == "map" and self.heightmaps.get() is None:
            raise ValueError("there is no height map to tie: probe the board, or probe here for H 0")
        job = None
        if body.at == "nearest":
            if body.mode != "map":
                raise ValueError("the nearest probed point is for tying the map: H 0 is set where the head is")
            job = self._touch_job(body.job)
        with self._owner_lock:
            link = self._movable()
            self.prober.reserve(link)
            try:
                r_max, z_max = _soft_limits(self._values(force=True))
                spindle_off = self._off_duty() if self.milling else None
                with self._move_lock:
                    self._jog_target = None
                    status = link.status_now(1.0, routine=True)
                    frame = self._frame
                    settings = self.probe_settings()
                    streamer = self.streamer(status)
                    tip = _tip_point(status, settings.offset, self.cartesian, self.table_angle(status))
                    target = None
                    found = None
                    if job is not None:
                        heightmap = self.heightmaps.get()
                        if heightmap is None:
                            raise ValueError("there is no height map to tie: probe the board first")
                        clearance = TOUCH_CLEARANCE + float(job.spot or 0.0) / 2.0
                        found = nearest_clear_point(heightmap, job, tip, clearance)
                        if found is None:
                            raise ValueError(
                                f"no probed point of the map is {clearance:g} mm clear of the job's cuts:"
                                " jog the tip over copper the map covers and probe here"
                            )
                        tip = found[1]
                        # Refused past a soft limit before anything moves,
                        # as a grid's points are.
                        target = reach_joint(tip, settings.offset, streamer, self.table_angle(status), 0.0, r_max, z_max)
                    if dry_run:
                        # What the prober sends before it probes, when the
                        # head goes to the target first.
                        moves = [] if target is None else touch_moves(streamer, streamer.start_of(status), target, status.h, self.travel_height)
                        return {
                            "point": [round(tip[0], 4), round(tip[1], 4)],
                            "index": list(found[0]) if found is not None else None,
                            "distance": round(found[2], 3) if found is not None else 0.0,
                            "lines": [line for line, _ in moves],
                        }

                    def touched(height: float, travel: float) -> None:
                        self._touched(link, body.mode, height, travel, tip, frame)

                    self.prober.start(
                        settings,
                        link,
                        streamer,
                        r_max,
                        z_max,
                        spindle_off,
                        travel=self.travel_height,
                        touch=touched,
                        target=target,
                    )
            finally:
                self.prober.release()
        log.info(
            "probing one point %s, for %s",
            f"at ({tip[0]:.2f}, {tip[1]:.2f}), the nearest clear of the cuts" if target is not None else "under the head",
            "the map's frame" if body.mode == "map" else "H 0",
        )
        return self.heightmap_state()

    def _touch_job(self, job_id: str | None) -> Job:
        """The job whose cuts a touch keeps clear of: the one named, else
        the last run's, whose cuts are the ones in the copper."""
        if job_id is None:
            record = self.resume_store.get()
            if record is not None and record.get("job"):
                job_id = str(record["job"])
        if job_id is None:
            raise ValueError("the nearest point clear of the cuts needs a job: load one, or run one first")
        return self._job(job_id)

    def _touched(self, link: Link, mode: str, height: float, travel: float, tip: tuple[float, float], frame: int) -> None:
        """What a probe under the head found, with the head back up at rest.
        Runs on the probing thread, which owns the machine."""
        if mode == "zero":
            # The head is at the travel height; the contact height is to
            # read 0, so the head reads how far above it it stands.
            link.request_ok(f"set H{num(travel - height, 4)}")
            self._frame_changed("the surface was probed")
            with self._map_lock:
                self._contact = (self._frame, 0.0)
            try:
                link.status_now(1.0, routine=True)
            except LinkError:
                pass
            self.publish_message("info", f"H 0 is now the surface probed here (it read {height:.4f})")
            return
        x, y = tip
        with self._map_lock:
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("the height map went away while probing")
            if self._frame != frame:
                raise ValueError("the focus axis frame changed while probing: probe here again")
            grid = heightmap.grid
            if not grid.covers((x, y, x, y)):
                raise ValueError(
                    f"probe over the map: the tip is at X {x:.1f} Y {y:.1f}, the map covers"
                    f" X {grid.x0:.1f}..{grid.x1:.1f} Y {grid.y0:.1f}..{grid.y1:.1f}"
                )
            if not heightmap.cell_probed(x, y):
                raise ValueError(f"the map was not probed around X {x:.1f} Y {y:.1f}: probe over a probed cell")
            mapped = heightmap.height_at(x, y)
            # The frame in use against the one the heights are in. The
            # offset is the gap over the contact plus this shift: measured
            # from the gap, so a second tie in the same frame finds the
            # same shift and leaves the offset where it is.
            shift = height - mapped
            if heightmap.focus_gap is not None:
                gap = heightmap.focus_gap
                offset = gap + shift
            elif heightmap.focus_set:
                # Focused in this frame with the gap unknown: the offset
                # is right as it stands, and the touch says what the gap is.
                offset = heightmap.focus_offset
                gap = offset - shift
            elif self.milling:
                # The tool is the probe: contact is where the tool meets
                # the copper, and the map's heights were that too.
                gap = 0.0
                offset = shift
            else:
                raise ValueError(
                    "the map has never been focused: focus the beam by eye over it first (focus here);"
                    " a probe here can then tie it to a new frame"
                )
            heightmap.focus_offset = round(offset, 4)
            heightmap.focus_gap = round(gap, 4)
            heightmap.focus_set = True
            heightmap.focus_known = True
            self.heightmaps.put(heightmap)
            self._focus_frame = frame
            self._contact = (frame, height)
        self.publish_heightmap()
        self.publish_message(
            "info",
            f"height map tied to this frame: the surface at X {x:.1f} Y {y:.1f} reads {height:.4f},"
            f" {shift:+.4f} against the map; focus offset {offset:.4f} ({gap:+.4f} over the contact)",
        )

    def stop_probe(self) -> dict:
        self.prober.stop()
        return self.heightmap_state()

    # --- pad probing ----------------------------------------------------------------

    def pad_points(self, body: PadsBody) -> tuple[list[tuple[float, float]], dict, HeightMap | None, tuple | None]:
        """The points a pad probing would probe, in order, with what was
        left out; the map to go on with when resuming; and the box the
        map's grid covers."""
        if body.resume:
            heightmap = self.heightmaps.get()
            if heightmap is None or heightmap.points is None:
                raise ValueError("there is no pad map to go on with: probe the pads first")
            if heightmap.complete:
                raise ValueError("the pad map is complete: nothing is left to probe")
            left = [heightmap.points[ix] for ix, _ in heightmap.remaining()]
            return left, {"pads": len(heightmap.points), "skipped": 0, "resume": heightmap.probed}, heightmap, None
        if body.job is None:
            raise ValueError("name the job whose pads to probe")
        job = self._job(body.job)
        if not (math.isfinite(body.min_area) and 0.05 <= body.min_area <= 1000.0):
            raise ValueError("min_area must be 0.05 to 1000 mm^2")
        if not 2 <= body.max_points <= 2500:
            raise ValueError("max_points must be 2 to 2500")
        if not job.pads:
            raise ValueError("the job has no pads: import it from a board, a KiCad file or a gerber")
        large = [(x, y) for x, y, area in job.pads if area >= body.min_area]
        if not large:
            raise ValueError(f"no pad of the job is {body.min_area:g} mm^2 or more: lower the least area")
        skipped = len(job.pads) - len(large)
        chosen = [large[i] for i in board_pads.spread(large, body.max_points)] if len(large) > body.max_points else large
        points = [chosen[i] for i in board_pads.tour(chosen)]
        box = job_extent(job)
        if box is None:
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            box = (min(xs), min(ys), max(xs), max(ys))
        return points, {"pads": len(job.pads), "skipped": skipped, "resume": 0}, None, box

    def pads_plan(self, body: PadsBody) -> dict:
        points, counts, _, _ = self.pad_points(body)
        seconds = estimate_points_seconds(points, self.probe_settings(), self.rates)
        return {"points": [[round(x, 4), round(y, 4)] for x, y in points], "seconds": round(seconds, 1), **counts}

    def start_pads(self, body: PadsBody) -> dict:
        points, _, resume, box = self.pad_points(body)
        # A pad map's grid is made from its points.
        if resume is not None:
            self._start_map_probe(None, resume, points=resume.points, box=box)
        else:
            self._start_map_probe(None, None, points=points, box=box)
        log.info("probing the pads: %d points%s", len(points), ", going on with the map" if resume is not None else "")
        return self.heightmap_state()


    def focus(self, offset: float | None) -> dict:
        """Sets the focus offset: given, or from the head's height over the
        board point under the beam, which the operator has just focused.

        Taken from the head, it ties the map to the focus axis frame in use
        whatever frame the heights were probed in. Given as a number, it is
        a plain distance from contact to focus, which holds only for
        heights probed in this frame.
        """
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        if self.heightmaps.get() is None:
            raise ValueError("there is no height map: probe the board first")
        self._check_restart()
        frame = self._frame
        status = None
        if offset is None:
            status = self.require_link().status_now(1.0, routine=True)
            if status.state != "Idle":
                raise ValueError(f"the machine is {status.state}: focus with the head at rest")
            # The report may be the first after a restart.
            self._check_restart()
        with self._map_lock:
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("there is no height map: probe the board first")
            if self._frame != frame:
                raise ValueError("the focus axis frame changed meanwhile: focus again")
            if status is not None:
                # Without a focus axis the head's height is fixed, and zero
                # is as good a name for it as any: the map only needs the
                # same one.
                here = status.h if status.h is not None else 0.0
                x, y = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
                grid = heightmap.grid
                if not grid.covers((x, y, x, y)):
                    # The edge height would stand in for copper nobody
                    # measured, and every compensated line would be off by
                    # the difference.
                    raise ValueError(
                        f"focus over the probed area: the beam is at X {x:.1f} Y {y:.1f}, the map covers"
                        f" X {grid.x0:.1f}..{grid.x1:.1f} Y {grid.y0:.1f}..{grid.y1:.1f}"
                    )
                offset = here - heightmap.height_at(x, y)
            elif self._heights_frame != frame:
                raise ValueError(
                    "the map was probed before the focus axis was last renumbered (a connect, a restart,"
                    " a position set or a map put back): use focus here over the map, or probe again"
                )
            heightmap.focus_offset = round(offset, 4)
            # In the heights' own frame the offset is the gap itself; set
            # from the head in another frame, the gap is unknown until a
            # tie measures the frame, and a gap from before does not
            # outlive a fresh focus by eye.
            heightmap.focus_gap = round(offset, 4) if self._heights_frame == frame else None
            heightmap.focus_set = True
            heightmap.focus_known = True
            self.heightmaps.put(heightmap)
            self._focus_frame = frame
        return self.publish_heightmap()

    def keep_focus(self) -> dict:
        """Takes the offset a frame change took back as it stood, on the
        operator's word that the focus axis has not moved since: a link
        that dropped and came back to a board that kept its position, say.
        Nothing here can check that word; a wrong one runs every line off
        by however far the axis moved."""
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        # A restart not yet seen would take the kept offset straight back.
        self._check_restart()
        with self._map_lock:
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("there is no height map: probe the board first")
            if not heightmap.focus_known:
                raise ValueError("the map has never been focused, so there is no offset to keep: focus here")
            heightmap.focus_set = True
            self.heightmaps.put(heightmap)
            self._focus_frame = self._frame
            offset = heightmap.focus_offset
        what = "touch-off" if self.milling else "focus"
        log.info("focus offset %.4f kept from before the frame change, on the operator's word", offset)
        state = self.publish_heightmap()
        self.publish_message("info", f"kept the height map's {what} offset {offset:.4f} from before")
        return state

    def _check_surface_at_zero(self) -> None:
        """A spindle's run without the height map cuts from H 0 as the
        copper's height. Refused when a probe in this frame found the
        copper well away from there: the run would cut in the air, or
        into the board. A frame nobody has probed in is let through, as
        before: the operator set Z 0 by hand, or means to."""
        if not self.milling:
            return
        with self._map_lock:
            contact = self._contact
        if contact is None or contact[0] != self._frame:
            return
        if abs(contact[1]) > SURFACE_TOLERANCE:
            raise ValueError(
                f"the copper reads H {contact[1]:.3f} where it was last probed, but without the height map"
                " the run cuts from H 0: probe here for Z 0 at the copper, or run with the height map"
            )

    def compensation(self, mode: str, job: Job) -> Compensation | None:
        """What a run of `job` follows the board with, checked; None for off."""
        if mode not in MODES:
            raise ValueError(f"compensate must be one of {', '.join(MODES)}")
        if mode == OFF:
            self._check_surface_at_zero()
            return None
        # A restart not yet seen in a status report takes the offset back
        # before the map is looked at, and so does one probing missed.
        self._check_restart()
        if self._drop_stale_focus():
            self.publish_heightmap()
        heightmap = self.heightmaps.get()
        if heightmap is None:
            raise ValueError("there is no height map: probe the board first")
        heightmap.usable()
        check_covers(heightmap, job)
        # Read afresh: a focus axis taken out a moment ago must not be
        # driven from a cached answer.
        values = self._values(force=True)
        has_axis = bool(values.get("h_axis"))
        if mode == AUTO:
            mode = FOCUS if has_axis else POWER
        if self.milling and mode == POWER:
            raise ValueError("a spindle follows the board with its depth axis: compensate by focus")
        if mode == FOCUS and not has_axis:
            raise ValueError("the focus axis is not fitted ($h_axis=0): compensate by power instead")
        status = self.require_link().status_now(1.0, routine=True)
        return Compensation(
            heightmap=heightmap,
            mode=mode,
            head_h=status.h if status.h is not None else 0.0,
            rayleigh=self.probe_settings().rayleigh,
            s_max=_s_max(values) or 1000.0,
        )
