"""Probes a grid of board points with the touch probe on the focus axis.

The head travels between points at the height it had when probing began,
which the operator has chosen to clear the board. At each point it goes
there, lowers the probe until it touches (`probe`, answered once the head
has stopped), and, with a second speed set, backs off and touches again
slower for the height that is recorded. It then rises back to the travel
height before moving on, so the probe never drags across the board.

Every line is sent and answered before the next, so a failed probe stops
the routine before anything else moves: a miss raises the firmware's
`Alarm:2`, which also refuses whatever might still be queued. Each probe
starts from rest: a move is answered once it is queued, and a probe only
once the motion ahead of it has run as well, so the rise and the move to a
point are waited out first and the probe's answer time covers its descent
alone. A stop holds and resets the machine the way a run's stop does.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from spinny_laser import polar

from .heightmap import Finite, Grid, HeightMap, HeightMapStore, estimate_points_seconds
from .kinematics import FOCUS_DECIMALS, Streamer, coord, num, turned
from .link import Link, LinkError, parse_probe
from .runner import halt

RUNNING, DONE, STOPPED, ERROR = "running", "done", "stopped", "error"
# Answer time allowed for a positioning line, on top of the time a move
# should take to come to rest, and on top of a probe's own travel time.
LINE_TIMEOUT = 10.0
PROBE_MARGIN = 10.0
JOIN_WAIT = 2.0
# Between status requests while waiting for the head to come to rest, s.
SETTLE_POLL = 0.02


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


def _box_of(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


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


def reach_joint(
    point: tuple[float, float],
    offset: tuple[float, float],
    streamer: Streamer,
    angle: float,
    slack: float,
    r_max: float,
    z_max: float,
) -> tuple[float, float]:
    """The joint that puts the probe tip over a board point on the machine
    the streamer is for, `angle` the table's angle to unwrap from; refused
    when the head would pass a soft limit (0 for none)."""
    if streamer.cartesian:
        joint = cartesian_probe_joint(point, offset, float(getattr(streamer, "angle", 0.0)))
        if z_max > 0 and abs(joint[1]) > z_max + 1e-9:
            raise ProberError(
                f"the probe cannot reach ({point[0]:.2f}, {point[1]:.2f}): the head would go to"
                f" Z{joint[1]:.3f}, past the soft limit z_max={z_max:g}"
            )
    else:
        try:
            joint = probe_joint(point, offset, angle, slack)
        except ValueError as exc:
            raise ProberError(str(exc)) from exc
    if r_max > 0 and abs(joint[0]) > r_max + 1e-9:
        raise ProberError(
            f"the probe cannot reach ({point[0]:.2f}, {point[1]:.2f}): the head would go to"
            f" R{joint[0]:.3f}, past the soft limit r_max={r_max:g}"
        )
    return joint


@dataclass
class ProbeProgress:
    state: str = RUNNING
    done: int = 0
    total: int = 0
    # The point being probed, (ix, iy) of the grid; None on a pad map,
    # where `pad` is the index of the pad being probed instead.
    point: tuple[int, int] | None = None
    pad: int | None = None
    error: str | None = None
    # About how long the whole of it was to take, s, from the grid before
    # the first point; None when nobody guessed.
    estimate: float | None = None
    started: float = field(default_factory=time.monotonic, repr=False)
    finished: float | None = field(default=None, repr=False)
    # How many points were already done when this probing started: its own
    # pace is measured over the rest.
    started_done: int = field(default=0, repr=False)

    def remaining(self, now: float | None = None) -> float | None:
        """Seconds left: at the pace so far once a few points are done,
        else what is left of the guess."""
        if self.state != RUNNING:
            return 0.0 if self.state == DONE else None
        end = now if now is not None else time.monotonic()
        elapsed = end - self.started
        own = self.done - self.started_done
        left = max(0, self.total - self.done)
        if own >= 2 and elapsed > 0:
            return elapsed / own * left
        if self.estimate is not None and self.total > 0:
            return max(0.0, self.estimate * left / self.total - (elapsed if own == 0 else 0.0))
        return None

    def to_dict(self) -> dict:
        end = self.finished if self.finished is not None else time.monotonic()
        remaining = self.remaining(end)
        return {
            "state": self.state,
            "done": self.done,
            "total": self.total,
            "point": list(self.point) if self.point is not None else None,
            "pad": self.pad,
            "seconds": round(end - self.started, 1),
            "estimate": round(self.estimate, 1) if self.estimate is not None else None,
            "remaining": round(remaining, 1) if remaining is not None else None,
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
        # The link's restart count when the start was claimed: a restart
        # from then on is one the probing did not ask for.
        self._restarts: int | None = None
        self.progress: ProbeProgress | None = None

    @property
    def active(self) -> bool:
        progress = self.progress
        return self._starting or (progress is not None and progress.state == RUNNING)

    def snapshot(self) -> dict | None:
        with self._lock:
            return self.progress.to_dict() if self.progress is not None else None

    def reserve(self, link: Link | None) -> None:
        """Claims the machine for a probing about to start, before the
        caller reads what it needs: a stop or reset from here on keeps it
        from starting. `start(..., reserved=True)` takes the claim over;
        `release` gives it back when no start follows."""
        with self._lock:
            self._claim(link)

    def release(self) -> None:
        """Gives back a claim `reserve` made that no `start` took over."""
        with self._lock:
            self._starting = False

    def _claim(self, link: Link | None) -> None:
        if self.active:
            raise ProberError("probing is already under way")
        thread = self._thread
        if thread is not None and thread.is_alive():
            raise ProberError("the last probing is still stopping")
        self._starting = True
        # A stop from here on ends the start before anything moves.
        self._abort.clear()
        self._restarts = link.restarts if link is not None else None

    def start(
        self,
        grid: Grid,
        settings: ProbeSettings,
        link: Link | None,
        streamer: Streamer,
        r_max: float = 0.0,
        z_max: float = 0.0,
        spindle_off: int | None = None,
        keep_focus: bool = True,
        reserved: bool = False,
        resume: HeightMap | None = None,
        touch: Callable[[float, float], None] | None = None,
        target: tuple[float, float] | None = None,
        points: list[tuple[float, float]] | None = None,
        box: tuple[float, float, float, float] | None = None,
    ) -> dict:
        """Starts probing `grid`. `spindle_off` is the output's duty with a
        spindle stopped, on a machine whose output drives one: probing is
        refused while the status shows any other, since the tool may be
        the probe and would be lowered onto the copper turning.
        `keep_focus` false starts the new map without the last one's focus
        offset, which then held only for heights from another frame.
        `reserved` takes over a claim `reserve` made, with whatever stop or
        reset came since.

        `resume` goes on with a map probed in part: its grid is probed
        where it has no height yet, and the heights it has are kept.
        `touch` makes it a single point under the head rather than a map:
        the grid is ignored, the probe goes down where the head is, and
        `touch` is called with the contact height and the travel height
        once the head is back up and at rest, before probing is reported
        done; the map in the store is left alone. With `target`, a joint
        the caller has checked for reach, the head goes there at the
        travel height first and the probe goes down under it there.
        `points` makes it a pad map rather than a grid: those board points
        are probed, in their order, and the map's grid is `box` (the job's
        extent) with a margin, filled in from them; `resume` goes on with a
        pad map the same way, its points being the ones."""
        try:
            if touch is None and points is None:
                grid.check()
            if points is not None and not points:
                raise ProberError("no pads to probe")
            settings.check()
            if link is None or not link.is_open:
                raise ProberError("not connected")
            if resume is not None:
                resume.check()
                if resume.grid != grid:
                    raise ProberError("the map to go on with was probed on another grid")
        except Exception:
            if reserved:
                self.release()
            raise
        with self._lock:
            if reserved:
                if not self._starting:
                    raise ProberError("the probing was not reserved")
            else:
                self._claim(link)
        try:
            return self._start(
                grid, settings, link, streamer, r_max, z_max, spindle_off, keep_focus, resume, touch, target, points, box
            )
        finally:
            self._starting = False

    def _start(
        self,
        grid: Grid,
        settings: ProbeSettings,
        link: Link,
        streamer: Streamer,
        r_max: float,
        z_max: float,
        spindle_off: int | None,
        keep_focus: bool,
        resume: HeightMap | None = None,
        touch: Callable[[float, float], None] | None = None,
        target: tuple[float, float] | None = None,
        points: list[tuple[float, float]] | None = None,
        box: tuple[float, float, float, float] | None = None,
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
        if spindle_off is not None and status.laser != spindle_off:
            raise ProberError("the spindle is turning: stop it before probing")
        if touch is not None:
            with self._lock:
                if self._abort.is_set():
                    raise ProberError("probing was stopped before it started")
                if self._restarts is not None and link.restarts != self._restarts:
                    raise ProberError("the machine was reset while probing was being started")
                self.progress = ProbeProgress(total=1)
                progress = self.progress
                self._link = link
                self._thread = threading.Thread(
                    target=self._run_touch,
                    args=(
                        settings,
                        link,
                        streamer,
                        status.h,
                        progress,
                        self._restarts,
                        touch,
                        streamer.start_of(status),
                        target,
                    ),
                    name="prober",
                    daemon=True,
                )
                self._thread.start()
            self._emit(progress, None)
            return progress.to_dict()
        if resume is not None:
            heightmap = resume
            done = heightmap.probed
        else:
            if points is not None:
                heightmap = HeightMap.for_points(points, box if box is not None else _box_of(points), settings.offset)
            else:
                heightmap = HeightMap.empty(grid, settings.offset)
            done = 0
            # A map probed before keeps its focus offset only if the probe has
            # not changed: the offset is contact to focus for that probe.
            previous = self.store.get()
            if keep_focus and previous is not None and tuple(previous.probe_offset) == tuple(settings.offset):
                heightmap.focus_offset = previous.focus_offset
                heightmap.focus_set = previous.focus_set
                heightmap.focus_known = previous.focus_known
                heightmap.focus_gap = previous.focus_gap
        grid = heightmap.grid
        # Every point is checked for reach before the first move. A grid
        # point inside the tip's circle about the axis is probed from the
        # circle when near enough; a pad is where it is.
        angle = status.a if not streamer.cartesian else float(getattr(streamer, "angle", 0.0))
        slack = 0.0 if heightmap.is_pad_map else grid.spacing / 2.0
        joints = {}
        todo = heightmap.remaining()
        for key in todo:
            point = heightmap.point_of(key)
            # On a cartesian machine the joint is the rail and the cross
            # slide, the table staying where the streamer's frame has it;
            # on a polar one each angle unwraps from the point before.
            joints[key] = reach_joint(point, settings.offset, streamer, angle, slack, r_max, z_max)
            if not streamer.cartesian:
                angle = joints[key][1]
        with self._lock:
            if self._abort.is_set():
                raise ProberError("probing was stopped before it started")
            if self._restarts is not None and link.restarts != self._restarts:
                raise ProberError("the machine was reset while probing was being started")
            # The new map replaces the old one from the start, so the page
            # shows its grid filling in rather than the old heights.
            self.store.put(heightmap)
            try:
                estimate = estimate_points_seconds([heightmap.point_of(key) for key in todo], settings, streamer.rates)
            except (TypeError, ValueError, ZeroDivisionError):
                estimate = None
            self.progress = ProbeProgress(total=heightmap.wanted, done=done, started_done=done, estimate=estimate)
            progress = self.progress
            self._link = link
            start = streamer.start_of(status)
            self._thread = threading.Thread(
                target=self._run,
                args=(grid, settings, link, streamer, start, status.h, joints, heightmap, progress, self._restarts, todo),
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
                if self._starting:
                    # Nothing has moved yet: the start sees the flag before
                    # its first line and gives up.
                    self._abort.set()
                    return ProbeProgress(state=STOPPED, error="stopped before it started").to_dict()
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
                if self._starting:
                    self._abort.set()
                return
        self._abort.set()
        self._finish(progress, STOPPED, reason)

    # --- the probing thread -----------------------------------------------

    def _run_touch(self, settings, link, streamer, travel, progress, restarts, touch, start, target) -> None:
        """One probe down where the head is, or at `target` after a move
        there from `start`, then back up; `touch` gets the contact height
        with the head at rest at the travel height."""
        if restarts is None:
            restarts = link.restarts
        h_rate = streamer.rates.h_rate
        try:
            with self._lock:
                progress.point = (0, 0)
            self._emit(progress, None)
            if target is not None:
                self._request(link, f"go {streamer.words(target)}", LINE_TIMEOUT)
                self._settle(link, streamer._rapid_seconds(start, target), restarts)
            height = self._touch(link, settings.feed, settings.depth, h_rate)
            if settings.slow > 0.0:
                self._request(link, f"go H{coord(height + settings.backoff, FOCUS_DECIMALS)}", LINE_TIMEOUT)
                self._settle(link, settings.backoff / h_rate * 60.0, restarts)
                height = self._touch(link, settings.slow, 2.0 * settings.backoff, h_rate)
            self._request(link, f"go H{coord(travel, FOCUS_DECIMALS)}", LINE_TIMEOUT)
            self._settle(link, abs(travel - height) / h_rate * 60.0, restarts)
            if link.restarts != restarts:
                raise LinkError("the machine reset during probing")
            with self._lock:
                progress.done = 1
                progress.point = None
            touch(round(height, 4), travel)
            self._finish(progress, DONE, None)
        except (LinkError, ValueError) as exc:
            if self._abort.is_set():
                return
            reason = str(exc)
            self._abort.set()
            if link.restarts == restarts and link.is_open:
                try:
                    status = link.status_now(1.0, routine=True)
                except LinkError:
                    status = None
                if status is None or status.state != "Alarm":
                    stopped, note = halt(link, self._message)
                    if not stopped:
                        reason = f"{reason}; the machine could not be stopped: {note}"
            self._message("error", f"probing failed: {reason}")
            self._finish(progress, ERROR, reason)
        except Exception as exc:
            self._abort.set()
            self._message("error", f"probing failed: {exc!r}")
            self._finish(progress, ERROR, f"probing failed: {exc!r}")

    def _run(self, grid, settings, link, streamer, start, travel, joints, heightmap, progress, restarts, todo=None) -> None:
        if restarts is None:
            restarts = link.restarts
        h_rate = streamer.rates.h_rate
        # Where the head is, and how far the rise to the travel height
        # queued ahead of the next move has to go.
        joint = start
        rise = 0.0
        try:
            for key in grid.order() if todo is None else todo:
                if self._abort.is_set():
                    return
                with self._lock:
                    progress.point = key if key[1] >= 0 else None
                    progress.pad = key[0] if key[1] < 0 else None
                self._emit(progress, None)
                target = joints[key]
                self._request(link, f"go {streamer.words(target)}", LINE_TIMEOUT)
                self._settle(link, rise / h_rate * 60.0 + streamer._rapid_seconds(joint, target), restarts)
                joint = target
                height = self._touch(link, settings.feed, settings.depth, h_rate)
                if settings.slow > 0.0:
                    self._request(link, f"go H{coord(height + settings.backoff, FOCUS_DECIMALS)}", LINE_TIMEOUT)
                    self._settle(link, settings.backoff / h_rate * 60.0, restarts)
                    height = self._touch(link, settings.slow, 2.0 * settings.backoff, h_rate)
                self._request(link, f"go H{coord(travel, FOCUS_DECIMALS)}", LINE_TIMEOUT)
                rise = abs(travel - height)
                heightmap.record(key, height)
                with self._lock:
                    progress.done += 1
                if link.restarts != restarts:
                    raise LinkError("the machine reset during probing")
                self.store.put(heightmap)
                self._emit(progress, heightmap)
            # The last rise is answered once it is queued, not once it is
            # done; the map is finished when the head is back up and still,
            # so a run started on it finds the machine at rest.
            self._settle(link, rise / h_rate * 60.0, restarts)
            with self._lock:
                progress.point = None
                progress.pad = None
            self._finish(progress, DONE, None, heightmap)
        except (LinkError, ValueError) as exc:
            if self._abort.is_set():
                # The stop that set the flag reports the end.
                return
            reason = str(exc)
            self._abort.set()
            if link.restarts != restarts:
                # The machine came back up with its focus axis wherever the
                # head was: the offset kept from the last map belongs to
                # the old numbers.
                heightmap.focus_set = False
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

    def _settle(self, link: Link, seconds: float, restarts: int) -> None:
        """Waits for the head to come to rest: the motion queued should take
        `seconds`, and LINE_TIMEOUT more is allowed. A hold extends the
        wait, as it does a line's.

        A machine that started over since `restarts` is at rest too, with
        its motion gone and its focus axis renumbered: that is an error,
        not the end of the move, whether a probe or the finished map
        would come next."""
        allowed = seconds + LINE_TIMEOUT
        deadline = time.monotonic() + allowed
        while True:
            if self._abort.is_set():
                raise LinkError("stopped")
            status = link.status_now(1.0, routine=True)
            if link.restarts != restarts:
                raise LinkError("the machine reset during probing")
            if status.state == "Idle":
                return
            if status.state == "Alarm":
                raise LinkError(f"the machine raised an alarm: {status.raw}")
            if status.state == "Hold":
                deadline = time.monotonic() + allowed
            if time.monotonic() > deadline:
                raise LinkError(f"the head did not come to rest: {status.raw}")
            time.sleep(SETTLE_POLL)

    def _touch(self, link: Link, feed: float, distance: float, h_rate: float) -> float:
        """One probe down from rest; the height at contact. The focus axis
        goes no faster than its rate, whatever the feed asks."""
        timeout = distance / min(feed, h_rate) * 60.0 + PROBE_MARGIN
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
