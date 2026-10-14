"""The log files: the backend's own and the wire's."""

from __future__ import annotations

import logging
import re

from spinny_web.log import log, path_for, setup, tail, wire_line, wire_note


def test_the_log_and_the_wire_go_to_their_own_files(tmp_path):
    path = setup(tmp_path, to_stderr=False)
    assert path == tmp_path / "spinny.log"
    log.info("the link opened")
    wire_line("tx", "go R1")
    wire_line("rx", "<Idle|J:0,0>", poll=True)
    wire_note("link closed: closed")
    spinny = (tmp_path / "spinny.log").read_text()
    assert "INFO the link opened" in spinny
    assert "go R1" not in spinny, "wire lines stay out of the log"
    wire = (tmp_path / "wire.log").read_text().splitlines()
    assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} tx go R1", wire[0]), wire[0]
    assert wire[1].endswith(" rx-poll <Idle|J:0,0>")
    assert wire[2].endswith(" -- link closed: closed")
    assert tail(tmp_path / "wire.log", 2) == wire[1:]
    assert path_for(tmp_path, "wire") == tmp_path / "wire.log"
    assert path_for(tmp_path, "spinny") == path
    assert path_for(tmp_path, "nope") is None


def test_setting_up_again_keeps_one_handler_each_and_applies_the_level(tmp_path):
    setup(tmp_path, to_stderr=False, level="debug")
    assert logging.getLogger("spinny_web").level == logging.DEBUG
    setup(tmp_path, to_stderr=False)
    assert logging.getLogger("spinny_web").level == logging.INFO
    assert len(logging.getLogger("spinny_web").handlers) == 1
    assert len(logging.getLogger("spinny_web.wire").handlers) == 1
    assert not logging.getLogger("spinny_web.wire").propagate
