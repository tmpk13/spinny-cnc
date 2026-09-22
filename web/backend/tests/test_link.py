"""The link: whole lines, credits, realtime bypass, banner, disconnect."""

from __future__ import annotations

import threading
import time

import pytest
from fake_serial import FakeSerial, fake_opener

from spinny_web import link as linkmod
from spinny_web.link import (
    REALTIME_RESET,
    CommandError,
    Event,
    Link,
    LinkClosed,
    LinkError,
    parse_banner,
    parse_status,
)


def make_link(fake: FakeSerial, poll: bool = True) -> Link:
    lk = Link("fake://", open_port=fake_opener(fake), poll=poll)
    lk.open()
    return lk


class Collector:
    def __init__(self) -> None:
        self.events: list[Event] = []
        self.lock = threading.Lock()

    def __call__(self, event: Event) -> None:
        with self.lock:
            self.events.append(event)

    def of(self, kind: str) -> list:
        with self.lock:
            return [event.data for event in self.events if event.kind == kind]


def wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_status_line_parses():
    status = parse_status("<Run|J:7.512,135.0000|V:300|L:400|Q:30,16|M:dyn|E:1>")
    assert status is not None
    assert status.state == "Run" and status.alarm is None
    assert status.r == 7.512 and status.a == 135.0
    assert status.rate == 300 and status.laser == 400
    assert status.planner == 30 and status.lines == 16
    assert status.mode == "dyn" and status.enabled
    alarm = parse_status("<Alarm:1|J:0.000,0.0000|V:0|L:0|Q:32,16|M:const|E:0>")
    assert alarm.state == "Alarm" and alarm.alarm == 1 and not alarm.enabled
    assert parse_status("<garbage") is None
    assert parse_status("<Idle|J:x,y>") is None


def test_the_cross_slide_field_is_read_and_optional():
    status = parse_status("<Jog|J:1.000,2.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:-0.125>")
    assert status is not None and status.z == -0.125
    # A firmware without the field reads as a machine with the slide at zero.
    older = parse_status("<Idle|J:1.000,2.0000|V:0|L:0|Q:32,16|M:dyn|E:1>")
    assert older is not None and older.z == 0.0
    assert older.joint == (1.0, 2.0)
    assert parse_status("<Idle|J:1.000,2.0000|Z:sideways>") is None


def test_banner_parses():
    banner = parse_banner("[spinny v0.1.0 lines:16 blocks:32]")
    assert banner.version == "0.1.0" and banner.lines == 16 and banner.blocks == 32
    assert parse_banner("[spinny v0.2.0]").lines == 16
    assert parse_banner("[MSG:hi]") is None


def test_lines_arrive_whole_and_banner_is_seen():
    fake = FakeSerial(byte_delay=0.0005)
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.subscribe(events)
    lk.open()
    try:
        assert lk.banner is not None and lk.banner.version == "0.1.0"
        assert lk.credits == 16
        texts = [f"note {i} " + "x" * 40 for i in range(5)]
        for text in texts:
            fake.message(text)
        assert wait_for(lambda: len(events.of("message")) >= 5)
        assert [m["text"] for m in events.of("message")] == texts
        rx = [c["text"] for c in events.of("console") if c["dir"] == "rx"]
        assert all(line.startswith("[") and line.endswith("]") for line in rx)
    finally:
        lk.close()


def test_credits_are_never_exceeded():
    fake = FakeSerial(credits=16, ok_delay=0.003, banner_at_open=True)
    lk = make_link(fake, poll=False)
    try:
        pendings = [lk.send(f"go R{i}", timeout=5.0) for i in range(48)]
        assert all(p.wait(5.0) for p in pendings)
        assert all(p.ok for p in pendings)
        assert fake.max_outstanding <= 16
        # The credit was actually used, not just respected trivially.
        assert fake.max_outstanding >= 8
        assert fake.received_lines[-48:] == [f"go R{i}" for i in range(48)]
        assert lk.outstanding == 0
    finally:
        lk.close()


def test_banner_credit_overrides_default():
    fake = FakeSerial(credits=4, ok_delay=0.005)
    lk = make_link(fake, poll=False)
    try:
        assert lk.credits == 4
        pendings = [lk.send(f"go R{i}", timeout=5.0) for i in range(12)]
        assert all(p.wait(5.0) for p in pendings)
        assert fake.max_outstanding <= 4
    finally:
        lk.close()


def test_realtime_bypasses_credits():
    fake = FakeSerial(credits=4, ok_delay=0.5)
    lk = make_link(fake, poll=False)
    try:
        for i in range(4):
            lk.send(f"go R{i}")
        assert lk.outstanding == 4
        started = time.monotonic()
        status = lk.status_now(timeout=1.0)
        assert time.monotonic() - started < 0.4
        assert status.state in ("Run", "Idle")
        assert 0x3F in fake.realtime_bytes
        # A fifth line has to wait for a credit.
        with pytest.raises(linkmod.LinkTimeout):
            lk.send("go R9", timeout=0.05)
    finally:
        lk.close()


def test_request_returns_content_lines_and_errors():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        lines = lk.request("$")
        assert lines[-1] == "ok"
        assert "r_rate=1000" in lines and "a_steps=888.889" in lines
        assert lk.request_ok("$r_rate") == ["r_rate=1000"]
        assert lk.request("nonsense") == ["error:1 unknown command"]
        with pytest.raises(CommandError):
            lk.request_ok("$nope=1")
        fake.settings["r_max"] = 50
        pending = lk.send("go R60")
        assert pending.wait(2.0) and pending.failed and pending.response.startswith("error:4")
        assert pending.answered
    finally:
        lk.close()


def test_status_poll_runs_and_speeds_up_when_moving():
    fake = FakeSerial(move_time=1.2)
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True)
    lk.subscribe(events)
    lk.open()
    try:
        time.sleep(0.65)
        idle = len(events.of("status"))
        assert 2 <= idle <= 5
        lk.request_ok("go R5")
        before = len(events.of("status"))
        time.sleep(0.8)
        moving = len(events.of("status")) - before
        assert moving >= 5
        assert lk.status is not None
    finally:
        lk.close()


def test_reset_drops_outstanding_and_the_new_banner_is_read():
    fake = FakeSerial(ok_delay=0.5)
    lk = make_link(fake, poll=False)
    try:
        pendings = [lk.send(f"go R{i}") for i in range(3)]
        lk.realtime(REALTIME_RESET)
        assert all(p.wait(1.0) for p in pendings)
        assert all(p.response == "reset" for p in pendings)
        assert not any(p.answered for p in pendings) and all(p.failed for p in pendings)
        assert 0x18 in fake.realtime_bytes
        assert lk.outstanding == 0
        assert lk.request("$r_rate")[-1] == "ok"
    finally:
        lk.close()


def test_port_vanishing_closes_the_link_and_reports():
    fake = FakeSerial()
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True)
    lk.subscribe(events)
    lk.open()
    pending = lk.send("go R1")
    assert pending.wait(1.0)
    fake.vanish()
    assert wait_for(lambda: not lk.is_open, 2.0)
    assert len(events.of("disconnect")) == 1
    assert "error" in events.of("disconnect")[0]["reason"]
    with pytest.raises(LinkClosed):
        lk.send("go R2")
    lk.close()
    assert len(events.of("disconnect")) == 1


def test_send_refuses_bad_lines():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        with pytest.raises(ValueError):
            lk.send("")
        with pytest.raises(ValueError):
            lk.send("go R1\ngo R2")
        with pytest.raises(ValueError):
            lk.send("x" * 120)
    finally:
        lk.close()


def test_a_port_that_breaks_on_close_does_not_kill_the_reader():
    """Closing the link races the reader thread's own read.

    pyserial raises whatever the handler happens to hit once the port is
    gone: a socket url leaves its handler reading from None and a closed
    file object raises ValueError, neither of which is a SerialException.
    An unhandled one kills the reader thread and prints a traceback under
    every disconnect.
    """
    fake = FakeSerial()
    errors: list[BaseException] = []
    original = threading.excepthook
    threading.excepthook = lambda args: errors.append(args.exc_value)
    try:
        lk = Link("fake://", open_port=fake_opener(fake), poll=False)
        lk.open()
        fake.break_with(AttributeError("'NoneType' object has no attribute 'recv'"))
        lk.close()
        assert wait_for(lambda: not lk.is_open, 2.0)
    finally:
        threading.excepthook = original
    assert errors == [], f"the reader thread died: {errors}"

    fake = FakeSerial()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.open()
    fake.break_with(ValueError("I/O operation on closed file"))
    assert wait_for(lambda: not lk.is_open, 2.0)
    assert "port error" in (lk.close_reason or "")
    lk.close()


def test_the_links_own_status_polls_are_marked_and_a_users_are_not():
    """The poll runs several times a second forever.

    A console that shows it buries every line an operator or a job sent, so
    the poll and the report it brings back carry a flag the page can filter
    on. A status an operator asked for carries none.
    """
    fake = FakeSerial()
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True)
    lk.subscribe(events)
    lk.open()
    try:
        assert wait_for(lambda: len(events.of("status")) >= 2, 3.0)
        console = events.of("console")
        polls_out = [e for e in console if e["dir"] == "tx" and e["text"] == "?"]
        reports = [e for e in console if e["dir"] == "rx" and e["text"].startswith("<")]
        assert polls_out and reports
        assert all(e["poll"] for e in polls_out), "a poll was not marked"
        assert all(e["poll"] for e in reports), "a poll's report was not marked"

        # A line an operator sent is never a poll.
        events.events.clear()
        lk.request("$r_rate")
        sent = [e for e in events.of("console") if e["dir"] == "tx" and e["text"] == "$r_rate"]
        assert sent and not any(e["poll"] for e in sent)

    finally:
        lk.close()

    # A status an operator asked for is not a poll. On its own link, so a
    # poll firing in between cannot claim the report.
    quiet = FakeSerial()
    asked_events = Collector()
    lk2 = Link("fake://", open_port=fake_opener(quiet), poll=False)
    lk2.subscribe(asked_events)
    lk2.open()
    try:
        lk2.realtime(b"?")
        assert wait_for(lambda: any(e["dir"] == "rx" and e["text"].startswith("<") for e in asked_events.of("console")), 2.0)
        asked = [e for e in asked_events.of("console") if e["text"] == "?" or e["text"].startswith("<")]
        assert asked and not any(e["poll"] for e in asked), asked
    finally:
        lk2.close()


def test_a_sender_waiting_for_credit_does_not_write_once_it_is_aborted():
    """Stopping a run frees the credit the next line was waiting for.

    The reset fails everything outstanding, which wakes whoever is queued
    behind the credit limit. If it writes its line then, a machine that
    has just been stopped and gone back to idle takes it and moves, with
    the beam on, which is what a stop exists to prevent.
    """
    # Answers held back, so the credits fill and the next line has to wait.
    fake = FakeSerial(ok_delay=10.0)
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.open()
    try:
        # Fill the credits, so nothing more can be written.
        for i in range(lk.credits):
            lk.send(f"cut R{i + 1} F60 S400")
        assert wait_for(lambda: lk.outstanding == lk.credits, 2.0)
        sent_before = len(fake.received_lines)

        abort = threading.Event()
        failed: list[BaseException] = []

        def queued():
            try:
                lk.send("cut R99 A402 F60 S400", abort=abort)
            except BaseException as exc:
                failed.append(exc)

        waiter = threading.Thread(target=queued, daemon=True)
        waiter.start()
        time.sleep(0.2)
        assert not failed, "it should still be waiting for a credit"

        # The stop: abort first, then the reset frees every credit.
        abort.set()
        lk.realtime(b"\x18")
        waiter.join(timeout=2.0)
        assert not waiter.is_alive()
        assert failed and isinstance(failed[0], LinkError), failed
        assert not any("R99" in line for line in fake.received_lines[sent_before:]), fake.received_lines[sent_before:]
    finally:
        lk.close()
