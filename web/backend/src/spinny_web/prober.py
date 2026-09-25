"""Probes a grid of board points with the touch probe on the focus axis.

The head travels between points at the height it had when probing began,
which the operator has chosen to clear the board. At each point it goes
there, lowers the probe until it touches (`probe`, answered once the head
has stopped), and, with a second speed set, backs off and touches again
slower for the height that is recorded. It then rises back to the travel
height before moving on, so the probe never drags across the board.

Every line is sent and answered before the next, so a failed probe stops
the routine before anything else moves: a miss raises the firmware's
`Alarm:2`, which also refuses whatever might still be queued. A stop holds
and resets the machine the way a run's stop does.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from spinny_laser import polar

from .heightmap import Finite, Grid, HeightMap, HeightMapStore
from .kinematics import FOCUS_DECIMALS, Streamer, coord, num, turned
from .link import Link, LinkError, parse_probe
from .runner import halt

RUNNING, DONE, STOPPED, ERROR = "running", "done", "stopped", "error"
# Answer time allowed for a positioning line, and on top of a probe's own
# travel time.
LINE_TIMEOUT = 10.0
PROBE_MARGIN = 10.0
JOIN_WAIT = 2.0


class ProberError(Exception):
    """Probing could not be started or stopped."""


class ProbeSettings(Finite):
    """The host's probing parameters, kept in its config."""

    # The most the probe goes down from the travel height looking for the
    # board, mm.
    depth: float = 5.0
    # First touch, mm/min.
    feed: float = 60.0
    # Second, slower touch after backing off; 0 for one touch only.
    slow: float = 15.0
    # How far the head rises before the second touch, mm.
    backoff: float = 0.3
    # The probe tip from the beam: along the rail and across it, mm.
    offset: tuple[float, float] = (0.0, 0.0)
    # The beam's Rayleigh length, for a run compensated by power, mm.
    rayleigh: float = 0.5

    def check(self) -> None:
        if not 0.0 < self.depth <= 100.0:
            raise ValueError("depth must be above 0 and at most 100 mm")
        if not 0.001 <= self.feed <= 10000.0:
            raise ValueError("feed must be 0.001 to 10000 mm/min")
        if self.slow != 0.0 and not 0.001 <= self.slow <= 10000.0:
            raise ValueError("slow must be 0 (one touch) or 0.001 to 10000 mm/min")
        if not 0.0 < self.backoff <= self.depth:
            raise ValueError("backoff must be above 0 and at most the depth")
        if any(abs(value) > 1000.0 for value in self.offset):
            raise ValueError("the probe offset must be within 1000 mm")
        if not 0.001 <= self.rayleigh <= 100.0:
            raise ValueError("rayleigh must be 0.001 to 100 mm")


def probe_joint(
    point: tuple[float, float], offset: tuple[float, float], previous_angle: float, slack: float = 0.0
) -> tuple[float, float]:
    """The joints that put the probe tip, `offset` from the beam along the
    rail and across it, over a board point.

    The tip at joint (r, a) is at `polar.displaced`: radius
    `hypot(r + along, across)` from the axis, turned by
    `atan2(across, r + along)` past the table angle. Solved for r with the
    tip outside the beam, so the head stays on the near side of the axis
    unless the point lies within `along` of it.

    A tip off the rail never comes nearer the axis than its offset across
    it. A point inside that circle is probed from the nearest place on it
    when that is at most `slack` away, and refused otherwise.
    """
    along, across = offset
    rho = math.hypot(point[0], point[1])
    if rho < abs(across):
        if abs(across) - rho > slack:
            raise ValueError(
                f"the probe cannot reach ({point[0]:.2f}, {point[1]:.2f}): its tip is {abs(across):g} mm off"
                " the rail, so it never comes nearer the axis than that; move the grid off the axis or"
                " mount the probe in line with the rail"
            )
        direction = math.atan2(point[1], point[0]) if rho > 0.0 else 0.0
        rho = abs(across)
        point = (rho * math.cos(direction), rho * math.sin(direction))
    reach = math.sqrt(rho * rho - across * across)
    r = reach - along
    if rho < polar.AXIS_EPSILON:
        return r, previous_angle
    tip = math.degrees(math.atan2(point[1], point[0]))
    angle = tip - math.degrees(math.atan2(across, reach))
    return r, polar.unwrap(angle, previous_angle)


def cartesian_probe_joint(point: tuple[float, float], offset: tuple[float, float], angle: float) -> tuple[float, float]:
    """The rail and cross slide positions that put the probe tip over a
    board point on a cartesian machine: the tip is the head plus `offset`
    along the rail and across it, and the board is turned `angle` degrees
    from the machine, so the head goes to the point turned back less the
    offset. Every point is reachable; only the soft limits bound it."""
    x, y = turned(point, -angle)
    return x - offset[0], y - offset[1]


@dataclass
class ProbeProgress:
    state: str = RUNNING
    done: int = 0
    total: int = 0
    # The point being probed, (ix, iy).
    point: tuple[int, int] | None = None
    error: str | None = None
    started: float = field(default_factory=time.monotonic, repr=False)
    finished: float | None = field(default=None, repr=False)

    def to_dict(self) -> dict:
        end = self.finished if self.finished is not None else time.monotonic()
        return {
            "state": self.state,
            "done": self.done,
            "total": self.total,
            "point": list(self.point) if self.point is not None else None,
            "seconds": round(end - self.started, 1),
            "error": self.error,
        }


class Prober:
    def __init__(
        self,
        store: HeightMapStore,
        publish: Callable[[dict | None, dict | None], None] | None = None,
        message: Callable[[str, str], None] | None = None,
    ) -> None:
        self.store = store
        # Called with the progress and the map after every change.
        self._publish = publish or (lambda progress, heightmap: None)
        self._message = message or (lambda level, text: None)
        self._lock = threading.Lock()
        self._abort = threading.Event()
        self._thread: threading.Thread | None = None
        self._link: Link | None = None
        # A start is checking the machine: nothing else may move it.
        self._starting = False
        self.progress: ProbeProgress | None = None

    @property
    def active(self) -> bool:
        progress = self.progress
        return self._starting or (progress is not None and progress.state == RUNNING)

    def snapshot(self) -> dict | None:
        with self._lock:
            return self.progress.to_dict() if self.progress is not None else None

    def start(
        self,
        grid: Grid,
        settings: ProbeSettings,
        link: Link | None,
        streamer: Streamer,
        r_max: float = 0.0,
        z_max: float = 0.0,
    ) -> dict:
        grid.check()
        settings.check()
        if link is None or not link.is_open:
            raise ProberError("not connected")
        with self._lock:
            if self.active:
                raise ProberError("probing is already under way")
            thread = self._thread
            if thread is not None and thread.is_alive():
                raise ProberError("the last probing is still stopping")
            self._starting = True
        try:
            return self._start(grid, settings, link, streamer, r_max, z_max)
        finally:
            self._starting = False

    def _start(
        self, grid: Grid, settings: ProbeSettings, link: Link, streamer: Streamer, r_max: float, z_max: float
    ) -> dict:
        try:
            status = link.status_now(1.0, routine=True)
        except LinkError as exc:
            raise ProberError(f"no status from the machine: {exc}") from exc
        if status.state != "Idle":
            raise ProberError(f"the machine is {status.raw or status.state}, not Idle")
        if status.h is None:
            raise ProberError("the machine has no focus axis: set $h_axis=1 to probe")
        if status.probe:
            raise ProberError("the probe is already touching: raise the head clear of the board first")
        # Every point is checked for reach before the first move.
        angle = status.a
        joints = {}
        for ix, iy in grid.order():
            point = (grid.xs[ix], grid.ys[iy])
            if streamer.cartesian:
                # The joint is the rail and the cross slide; the table
                # stays where the streamer's frame has it.
                joints[(ix, iy)] = cartesian_probe_joint(point, settings.offset, streamer.angle)
                if z_max > 0 and abs(joints[(ix, iy)][1]) > z_max + 1e-9:
                    raise ProberError(
                        f"the probe cannot reach ({point[0]:.2f}, {point[1]:.2f}): the head would go to"
                        f" Z{joints[(ix, iy)][1]:.3f}, past the soft limit z_max={z_max:g}"
                    )
            else:
                try:
                    joints[(ix, iy)] = probe_joint(point, settings.offset, angle, grid.spacing / 2.0)
                except ValueError as exc:
                    raise ProberError(str(exc)) from exc
                angle = joints[(ix, iy)][1]
            if r_max > 0 and abs(joints[(ix, iy)][0]) > r_max + 1e-9:
                raise ProberError(
                    f"the probe cannot reach ({point[0]:.2f}, {point[1]:.2f}): the head would go to"
                    f" R{joints[(ix, iy)][0]:.3f}, past the soft limit r_max={r_max:g}"
                )
        heightmap = HeightMap.empty(grid, settings.offset)
        # A map probed before keeps its focus offset only if the probe has
        # not changed: the offset is contact to focus for that probe.
        previous = self.store.get()
        if previous is not None and tuple(previous.probe_offset) == tuple(settings.offset):
            heightmap.focus_offset = previous.focus_offset
            heightmap.focus_set = previous.focus_set
        # The new map replaces the old one from the start, so the page shows
        # its grid filling in rather than the old heights.
        self.store.put(heightmap)
        with self._lock:
            self.progress = ProbeProgress(total=grid.nx * grid.ny)
            progress = self.progress
            self._link = link
            self._abort.clear()
            self._thread = threading.Thread(
                target=self._run,
                args=(grid, settings, link, streamer, status.h, joints, heightmap, progress),
                name="prober",
                daemon=True,
            )
            self._thread.start()
        self._emit(progress, heightmap)
        return progress.to_dict()

    def stop(self) -> dict:
        with self._lock:
            progress = self.progress
            if progress is None or progress.state != RUNNING:
                raise ProberError("nothing is being probed")
            link = self._link
        assert link is not None
        self._abort.set()
        stopped, note = halt(link, self._message)
        if not stopped:
            self._finish(progress, ERROR, f"the machine could not be stopped: {note}")
        else:
            self._finish(progress, STOPPED, note)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=JOIN_WAIT)
        return progress.to_dict()

    def cancel(self, reason: str) -> None:
        """Ends probing from outside without touching the machine: the
        caller has stopped it already, as an operator's reset does."""
        with self._lock:
            progress = self.progress
            if progress is None or progress.state != RUNNING:
                return
        self._abort.set()
        self._finish(progress, STOPPED, reason)

    # --- the probing thread -----------------------------------------------

    def _run(self, grid, settings, link, streamer, travel, joints, heightmap, progress) -> None:
        restarts = link.restarts
        try:
            for ix, iy in grid.order():
                if self._abort.is_set():
                    return
                with self._lock:
                    progress.point = (ix, iy)
                self._emit(progress, None)
                r, a = joints[(ix, iy)]
                self._request(link, f"go {streamer.words((r, a))}", LINE_TIMEOUT)
                height = self._touch(link, settings.feed, settings.depth)
                if settings.slow > 0.0:
                    self._request(link, f"go H{coord(height + settings.backoff, FOCUS_DECIMALS)}", LINE_TIMEOUT)
                    height = self._touch(link, settings.slow, 2.0 * settings.backoff)
                self._request(link, f"go H{coord(travel, FOCUS_DECIMALS)}", LINE_TIMEOUT)
                heightmap.heights[iy][ix] = round(height, 4)
                with self._lock:
                    progress.done += 1
                if link.restarts != restarts:
                    raise LinkError("the machine reset during probing")
                self.store.put(heightmap)
                self._emit(progress, heightmap)
            # The last rise is answered once it is queued, not once it is
            # done; the map is finished when the head is back up and still,
            # so a run started on it finds the machine at rest.
            self._settle(link)
            with self._lock:
                progress.point = None
            self._finish(progress, DONE, None, heightmap)
        except (LinkError, ValueError) as exc:
            if self._abort.is_set():
                # The stop that set the flag reports the end.
                return
            reason = str(exc)
            self._abort.set()
            if link.restarts == restarts and link.is_open:
                # A missed probe has already raised the alarm and stopped;
                # anything else is halted the way a stop would halt it.
                try:
                    status = link.status_now(1.0, routine=True)
                except LinkError:
                    status = None
                if status is None or status.state != "Alarm":
                    stopped, note = halt(link, self._message)
                    if not stopped:
                        reason = f"{reason}; the machine could not be stopped: {note}"
            self._message("error", f"probing failed: {reason}")
            self._finish(progress, ERROR, reason, heightmap)
        except Exception as exc:
            self._abort.set()
            self._message("error", f"probing failed: {exc!r}")
            self._finish(progress, ERROR, f"probing failed: {exc!r}", heightmap)

    def _settle(self, link: Link) -> None:
        deadline = time.monotonic() + LINE_TIMEOUT
        while not self._abort.is_set():
            status = link.status_now(1.0, routine=True)
            if status.state == "Idle":
                return
            if status.state == "Alarm":
                raise LinkError(f"the machine raised an alarm: {status.raw}")
            if time.monotonic() > deadline:
                raise LinkError(f"the head did not come to rest: {status.raw}")
            time.sleep(0.01)

    def _touch(self, link: Link, feed: float, distance: float) -> float:
        """One probe down; the height at contact."""
        timeout = distance / feed * 60.0 + PROBE_MARGIN
        lines = self._request(link, f"probe H-{num(distance, FOCUS_DECIMALS)} F{num(feed)}", timeout)
        result = parse_probe(lines)
        if result is None:
            raise LinkError(f"no probe result in {lines!r}")
        height, contact = result
        if not contact:
            raise LinkError(f"the probe found nothing within {distance:g} mm")
        return height

    def _request(self, link: Link, line: str, timeout: float) -> list[str]:
        """Sends one line and waits for its answer. A hold extends the wait:
        the operator may pause a probe as long as they like."""
        pending = link.send(line, timeout=timeout, abort=self._abort)
        deadline = time.monotonic() + timeout
        while not pending.wait(0.1):
            if self._abort.is_set():
                raise LinkError("stopped")
            status = link.status
            if status is not None and status.state == "Hold":
                deadline = time.monotonic() + timeout
            if time.monotonic() > deadline:
                raise LinkError(f"no answer to {line!r}")
        if not pending.answered:
            raise LinkError(f"{line!r} was dropped: {pending.response}")
        if pending.response != "ok":
            raise LinkError(f"{line!r}: {pending.response}")
        return pending.lines

    def _finish(self, progress: ProbeProgress, state: str, error: str | None, heightmap: HeightMap | None = None) -> None:
        with self._lock:
            if progress is not self.progress or progress.state != RUNNING:
                return
            progress.state = state
            progress.error = error
            progress.finished = time.monotonic()
        if heightmap is not None:
            self.store.put(heightmap)
        self._emit(progress, heightmap)

    def _emit(self, progress: ProbeProgress, heightmap: HeightMap | None) -> None:
        with self._lock:
            snapshot = progress.to_dict()
        self._publish(snapshot, heightmap.model_dump() if heightmap is not None else None)
