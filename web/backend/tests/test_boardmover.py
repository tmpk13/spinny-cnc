"""The head camera's board mover on a flying scan's row (boardlook.BoardMover):
`arrived` says when the head stands at the row's end, and a machine that
raised an alarm or reset on the way ends the scan instead of leaving it
waiting for a head that will never get there."""

from __future__ import annotations

import pytest

from spinny_web.boardlook import BoardMover
from spinny_web.link import Status


class Link:
    def __init__(self) -> None:
        self.restarts = 0
        self.status = Status(state="Run")
        self.lines: list[str] = []

    def request_ok(self, line: str) -> None:
        self.lines.append(line)


class Streamer:
    """Joints are board points here."""

    def start_of(self, status):
        return (0.0, 0.0)

    def board_of(self, joint):
        return joint

    def _path_moves(self, points, joint):
        return [("cut", None, points[-1], None, None)]

    def cut_line(self, joint, feed, power, extra):
        return f"cut X{joint[0]} Y{joint[1]} F{feed} S{power}"

    def words(self, joint):
        return f"X{joint[0]} Y{joint[1]}"


class Access:
    def __init__(self) -> None:
        self.link = Link()
        self.streamer = Streamer()
        self.has_focus_axis = False
        # The fake's status reports board points as r and a.
        self.head_point = lambda status: (status.r, status.a)


class Stopped(Exception):
    pass


def flying() -> tuple[Access, BoardMover]:
    access = Access()
    mover = BoardMover(access, lambda: False, Stopped, lambda: None)
    mover.fly((10.0, 0.0), 5.0)
    # The row's lines went out a while ago.
    mover._flying -= 1.0
    return access, mover


def test_a_row_ends_once_the_head_stands_at_its_end():
    access, mover = flying()
    assert access.link.lines and access.link.lines[0].startswith("cut ")
    assert not mover.arrived()
    access.link.status = Status(state="Idle", r=10.0, a=0.0)
    assert mover.arrived()


def test_a_row_that_ends_in_an_alarm_ends_the_scan():
    access, mover = flying()
    access.link.status = Status(state="Alarm", r=4.0, a=0.0)
    with pytest.raises(Stopped, match="alarm"):
        mover.arrived()


def test_a_machine_that_reset_on_a_row_ends_the_scan():
    access, mover = flying()
    access.link.restarts += 1
    access.link.status = Status(state="Idle", r=0.0, a=0.0)
    with pytest.raises(Stopped, match="reset"):
        mover.arrived()
