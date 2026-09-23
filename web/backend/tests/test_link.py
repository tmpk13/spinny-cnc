"""The link: whole lines, credits, realtime bypass, banner, disconnect."""

from __future__ import annotations

import threading
import time

import pytest
from fake_serial import FakeSerial, fake_opener

from spinny_web import link as linkmod
from spinny_web.link import (
    REALTIME_STATUS,
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


def test_a_reset_settles_the_dropped_lines_before_a_sender_can_write():
    """A run learns of a reset through the callbacks on the lines it
    dropped, and stops sending. A sender woken by the credit the reset
    freed, before those callbacks had run, would write its line into the
    machine the reset just emptied; the callbacks are slow here so that
    order would be caught every time."""
    fake = FakeSerial(credits=4, ok_delay=5.0)
    lk = make_link(fake, poll=False)
    abort = threading.Event()

    def on_drop(pending):
        if not pending.answered:
            time.sleep(0.05)
            abort.set()

    result: dict[str, object] = {}

    def sender() -> None:
        try:
            lk.send("go R9", abort=abort, timeout=5.0)
            result["sent"] = True
        except LinkError as exc:
            result["error"] = str(exc)

    try:
        for i in range(4):
            lk.send(f"go R{i}", callback=on_drop)
        thread = threading.Thread(target=sender)
        thread.start()
        time.sleep(0.15)
        assert thread.is_alive() and "go R9" not in fake.received_lines
        lk.realtime(REALTIME_RESET)
        thread.join(3.0)
        assert not thread.is_alive()
        assert result == {"error": "aborted"}
        assert "go R9" not in fake.received_lines
        assert lk.outstanding == 0
    finally:
        lk.close()


def test_the_banner_that_answers_version_is_not_a_restart():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        before = lk.restarts
        lines = lk.request("version")
        assert lines[0].startswith("[spinny v") and lines[-1] == "ok"
        assert lk.restarts == before
        # An unasked banner still counts, and so does the one a reset brings.
        fake._emit(fake.banner())
        assert wait_for(lambda: lk.restarts == before + 1)
        lk.realtime(REALTIME_RESET)
        assert wait_for(lambda: lk.restarts == before + 2)
    finally:
        lk.close()


def test_a_sender_waiting_for_a_credit_does_not_hold_the_others_up():
    # Nothing answers, so every credit stays taken; a second sender with
    # its own timeout must time out on time rather than wait behind the
    # first one's open-ended wait.
    fake = FakeSerial(credits=4, ok_delay=30.0)
    lk = make_link(fake, poll=False)
    stop = threading.Event()
    try:
        for i in range(4):
            lk.send(f"go R{i}")
        def hold_a_credit_wait() -> None:
            try:
                lk.send("go R9", abort=stop)
            except LinkError:
                pass

        blocked = threading.Thread(target=hold_a_credit_wait)
        blocked.start()
        time.sleep(0.1)
        started = time.monotonic()
        with pytest.raises(linkmod.LinkTimeout):
            lk.request("laser off", timeout=0.3)
        assert time.monotonic() - started < 1.0
    finally:
        stop.set()
        blocked.join(2.0)
        lk.close()


def test_a_version_with_a_comment_is_still_an_answer():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        before = lk.restarts
        lines = lk.request("version ; check")
        assert lines[0].startswith("[spinny v") and lines[-1] == "ok"
        assert lk.restarts == before
    finally:
        lk.close()


def test_the_resets_banner_is_taken_before_a_version_request_can_claim_it():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        before = lk.restarts
        lk.realtime(REALTIME_RESET)
        pending = lk.send("version")
        assert pending.wait(2.0) and pending.ok
        assert pending.lines and pending.lines[0].startswith("[spinny v")
        assert wait_for(lambda: lk.restarts == before + 1)
        assert lk._expected_banners == 0
        # A later reset still finds its banner.
        assert lk.reset(timeout=1.0)
    finally:
        lk.close()


def test_a_raising_callback_does_not_end_the_reader():
    fake = FakeSerial()
    events = Collector()
    lk = make_link(fake, poll=False)
    lk.subscribe(events)
    try:
        def boom(pending):
            raise RuntimeError("boom")
        pending = lk.send("go R1", callback=boom)
        assert pending.wait(2.0) and pending.ok
        assert lk.request_ok("$r_rate") == ["r_rate=1000"]
        assert lk.is_open and lk._reader is not None and lk._reader.is_alive()
        assert any("callback failed" in m["text"] for m in events.of("message"))
    finally:
        lk.close()


def test_a_status_request_on_a_lost_port_raises():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        fake.vanish()
        with pytest.raises(LinkError):
            lk.status_now(0.5)
        assert not lk.is_open
    finally:
        lk.close()


def test_realtime_and_control_bytes_are_refused_inside_a_line():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        for line in ("go R2\x18", "cut R5 F100 S200 ; go!", "go R1 ?", "go R1\x7f"):
            with pytest.raises(ValueError):
                lk.send(line)
        assert fake.received_lines == []
    finally:
        lk.close()


def test_the_status_command_returns_its_report():
    fake = FakeSerial()
    lk = make_link(fake, poll=False)
    try:
        lines = lk.request("status")
        assert lines[0].startswith("<") and lines[0].endswith(">")
        assert lines[-1] == "ok"
    finally:
        lk.close()


def test_a_line_that_never_ends_is_dropped_with_a_message():
    fake = FakeSerial(byte_delay=0.0)
    events = Collector()
    lk = make_link(fake, poll=False)
    lk.subscribe(events)
    try:
        fake._out.put("x" * 6000)
        assert wait_for(lambda: any("no line end" in m["text"] for m in events.of("message")), 5.0)
        # What is left of the junk ends at the next line end; the link reads on.
        fake._out.put("\n")
        fake.message("still here")
        assert wait_for(lambda: any(m["text"] == "still here" for m in events.of("message")), 5.0)
    finally:
        lk.close()


def test_open_fails_when_the_port_dies_during_the_banner_wait():
    fake = FakeSerial(banner_at_open=False)
    fake.vanish()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    with pytest.raises(LinkError):
        lk.open()
    assert not lk.is_open


def test_a_status_request_waits_for_its_own_report_not_a_polls():
    # A poll's report may still be on its way when a request is made; the
    # request must not take that report, which shows the machine before
    # anything the request was sent to check.
    fake = FakeSerial(byte_delay=0.001)
    lk = make_link(fake, poll=False)
    try:
        lk.status_now(2.0)
        lk.realtime(REALTIME_STATUS, routine=True)
        fake.joint = [7.0, 0.0]
        status = lk.status_now(2.0)
        assert status.r == 7.0
    finally:
        lk.close()
