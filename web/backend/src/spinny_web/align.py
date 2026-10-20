"""Marks that line a job up with the board, and the fit they make.

A mark pairs a design point of a job (a pad, a hole, any point) with the
board point the machine found it at, from the tool put over it or from
the camera's picture centered on it. The marks are kept for one job at a
time; `spinny_laser.align` fits them, and applying the fit turns and
shifts the job.
"""

from __future__ import annotations

import math
import threading
from dataclasses import asdict, dataclass

from spinny_laser import align as fitting
from spinny_laser import pads as board_pads

Point = tuple[float, float]
TOOL, CAMERA = "tool", "camera"
KINDS = ("pad", "hole", "point", "center")


@dataclass
class Mark:
    design: Point
    machine: Point
    source: str
    kind: str
    # How far the tool was from the pad or hole it was paired with.
    distance: float = 0.0
    # The board's turn a camera mark saw, degrees, or None.
    angle: float | None = None
    # The mark's distance from where the last fit puts it, mm.
    residual: float | None = None

    def to_dict(self) -> dict:
        data = asdict(self)
        data["design"] = [round(self.design[0], 4), round(self.design[1], 4)]
        data["machine"] = [round(self.machine[0], 4), round(self.machine[1], 4)]
        data["distance"] = round(self.distance, 4)
        data["angle"] = round(self.angle, 4) if self.angle is not None else None
        data["residual"] = round(self.residual, 4) if self.residual is not None else None
        return data


class Alignment:
    """The marks for one job and what they fit."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.job: str | None = None
        self.marks: list[Mark] = []

    def state(self) -> dict:
        with self._lock:
            fit = self._fit() if self.marks else None
            return {"job": self.job, "marks": [mark.to_dict() for mark in self.marks], "fit": fit.to_dict() if fit else None}

    def _fit(self) -> fitting.Fit | None:
        if not self.marks:
            return None
        angle = None
        if len(self.marks) == 1 and self.marks[0].angle is not None:
            angle = self.marks[0].angle
        try:
            fit = fitting.fit_rigid([(mark.design, mark.machine) for mark in self.marks], angle=angle)
        except ValueError:
            return None
        for mark, residual in zip(self.marks, fit.residuals):
            mark.residual = residual
        return fit

    def _for(self, job_id: str) -> None:
        if self.job != job_id:
            self.job = job_id
            self.marks = []

    def mark_tool(self, job, machine: Point, design: Point | None, nearest: str | None, within: float) -> dict:
        """A mark from the tool's board point: paired with `design`, or
        with the job's pad or hole nearest the tool within `within` mm."""
        if not all(math.isfinite(v) for v in machine):
            raise ValueError("the machine's position is not a number")
        if design is None and nearest is None:
            raise ValueError("give a design point, or nearest pad or hole")
        if nearest is not None and nearest not in ("pad", "hole"):
            raise ValueError("nearest must be pad or hole")
        if not (math.isfinite(within) and 0.1 <= within <= 100.0):
            raise ValueError("within must be 0.1 to 100 mm")
        with self._lock:
            self._for(job.id)
            if design is not None:
                if not all(math.isfinite(v) for v in design):
                    raise ValueError("the design point must be two numbers")
                mark = Mark(design=(float(design[0]), float(design[1])), machine=machine, source=TOOL, kind="point")
            else:
                candidates = job.pads if nearest == "pad" else job.holes
                if not candidates:
                    raise ValueError(f"the job has no {nearest}s to pair with: import it from a board, or give a design point")
                found = board_pads.nearest(candidates, machine)
                assert found is not None
                index, distance = found
                if distance > within:
                    raise ValueError(
                        f"no {nearest} of the job within {within:g} mm of the tool: the nearest is {distance:.2f} mm away,"
                        " put the tool over one or widen the search"
                    )
                point = candidates[index]
                mark = Mark(design=(float(point[0]), float(point[1])), machine=machine, source=TOOL, kind=nearest, distance=distance)
            self.marks.append(mark)
            self._fit()
        return self.state()

    def mark_camera(self, job, design: Point, machine: Point, angle: float | None) -> dict:
        """A mark from the camera: the picture's center in the job's frame
        and the machine point it sits at, with the board's turn seen."""
        with self._lock:
            self._for(job.id)
            self.marks.append(Mark(design=design, machine=machine, source=CAMERA, kind="center", angle=angle))
            self._fit()
        return self.state()

    def remove(self, index: int) -> dict:
        with self._lock:
            if not 0 <= index < len(self.marks):
                raise IndexError(f"no mark {index}")
            del self.marks[index]
            self._fit()
        return self.state()

    def clear(self) -> dict:
        with self._lock:
            self.marks = []
        return self.state()

    def fit(self, job_id: str) -> fitting.Fit:
        with self._lock:
            if self.job != job_id or not self.marks:
                raise ValueError("no marks for this job: mark a pad or a hole, or capture the camera's pose, first")
            fit = fitting.fit_rigid(
                [(mark.design, mark.machine) for mark in self.marks],
                angle=self.marks[0].angle if len(self.marks) == 1 else None,
            )
            for mark, residual in zip(self.marks, fit.residuals):
                mark.residual = residual
            return fit

    def apply(self, job) -> tuple[object, fitting.Fit]:
        """The job turned and shifted by the fit, as a new object; the
        marks are cleared, since their design points have moved."""
        fit = self.fit(job.id)
        updated = job.model_copy(deep=True)
        updated.turn(fit.rotation)
        updated.shift(fit.shift[0], fit.shift[1])
        with self._lock:
            self.marks = []
        return updated, fit
