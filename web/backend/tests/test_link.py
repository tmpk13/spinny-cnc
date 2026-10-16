"""The link: whole lines, credits, realtime bypass, banner, disconnect."""

from __future__ import annotations

import logging
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


@pytest.mark.parametrize("poll", [False, True])
def test_a_status_line_does_not_leave_later_requests_a_report_behind(poll):
    # The `status` command prints a report that no `?` asked for. Counted
    # as the answer to one, every later request would take the report
    # before its own and see the machine as it was.
    fake = FakeSerial()
    lk = make_link(fake, poll=poll)
    try:
        lines = lk.request("status")
        assert len(lines) == 2 and lines[0].startswith("<") and lines[-1] == "ok"
        for r in (3.0, 5.0, 7.0):
            fake.joint = [r, 0.0]
            assert lk.status_now(2.0).r == r
    finally:
        lk.close()


def test_a_report_nobody_asked_for_does_not_answer_the_next_request():
    # A report arriving after its request gave up on it is one no request
    # is waiting for; it must not stand in for the next request's own.
    fake = FakeSerial()
    events = Collector()
    lk = make_link(fake, poll=False)
    lk.subscribe(events)
    try:
        lk.status_now(2.0)
        fake._emit(fake.status())
        assert wait_for(lambda: len(events.of("status")) == 2)
        fake.joint = [4.0, 0.0]
        assert lk.status_now(2.0).r == 4.0
    finally:
        lk.close()


def test_a_status_line_takes_one_report_while_a_poll_is_out():
    fake = FakeSerial(byte_delay=0.001)
    lk = make_link(fake, poll=False)
    try:
        lk.realtime(REALTIME_STATUS, routine=True)
        lines = lk.request("status")
        assert len(lines) == 2 and lines[0].startswith("<")
        fake.joint = [6.0, 0.0]
        assert lk.status_now(2.0).r == 6.0
    finally:
        lk.close()


def test_a_refused_status_line_leaves_the_report_to_its_request():
    # `status` with a word after it is refused and prints no report: the
    # report arriving while it waits is the one a request asked for.
    fake = FakeSerial(ok_delay=0.3)
    lk = make_link(fake, poll=False)
    try:
        pending = lk.send("status now")
        fake.joint = [2.0, 0.0]
        assert lk.status_now(1.0).r == 2.0
        assert pending.wait(2.0) and not pending.ok
        assert pending.lines == []
        fake.ok_delay = 0.0
        fake.joint = [3.0, 0.0]
        assert lk.status_now(1.0).r == 3.0
    finally:
        lk.close()


def test_a_restart_while_a_refused_version_line_waits_is_a_restart():
    # `version` with a word after it prints no banner: one arriving while
    # it waits is the firmware starting over.
    fake = FakeSerial(ok_delay=0.5)
    lk = make_link(fake, poll=False)
    try:
        before = lk.restarts
        pending = lk.send("version please")
        fake._emit(fake.banner())
        assert wait_for(lambda: lk.restarts == before + 1)
        assert pending.wait(2.0) and not pending.ok
    finally:
        lk.close()


def test_a_boot_message_is_kept_and_a_fault_is_an_error():
    boot = "panic in poll after 12 s, 100 lines, pass max 300 us, gap max 900 us: core/src/machine.rs:1: x"
    fake = FakeSerial(boot=boot)
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.subscribe(events)
    lk.open()
    assert wait_for(lambda: lk.boot is not None, 2.0)
    assert lk.boot == boot
    message = events.of("message")[0]
    assert message["level"] == "error"
    assert message["text"] == f"boot {boot}"
    lk.close()
    assert linkmod.boot_is_fault("boot watchdog: the main loop stalled in poll after 3 s")
    assert linkmod.boot_is_fault("boot hard fault in line after 1 s: pc 0x1 lr 0x2")
    assert not linkmod.boot_is_fault("boot power on")
    assert not linkmod.boot_is_fault("boot reset pin")
    assert not linkmod.boot_is_fault("boot forced reset in boot after 0 s")
    assert not linkmod.boot_is_fault("reset")


def test_a_quiet_boot_message_is_news():
    fake = FakeSerial(boot="power on")
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.subscribe(events)
    lk.open()
    assert wait_for(lambda: lk.boot == "power on", 2.0)
    assert events.of("message")[0]["level"] == "info"
    lk.close()


def test_a_close_logs_what_the_link_saw(log_records):
    fake = FakeSerial()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.open()
    assert lk.request("go R1")[-1] == "ok"
    lk.close()
    record = next(r for r in log_records.records if "link fake:// closed: closed" in r.getMessage())
    assert record.levelno == logging.INFO
    text = record.getMessage()
    assert "1 lines sent, 0 unanswered, 0 polls unanswered" in text
    assert "last sent 'go R1', last heard 'ok'" in text


def test_a_vanished_port_is_logged_as_an_error(log_records):
    fake = FakeSerial()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True)
    lk.open()
    fake.vanish()
    assert wait_for(lambda: not lk.is_open, 2.0)
    errors = [r.getMessage() for r in log_records.records if r.levelno == logging.ERROR]
    assert any(m.startswith("port fake:// failed:") for m in errors), errors
    assert any("link fake:// closed: port error" in m for m in errors), errors


def test_a_machine_that_stops_answering_is_logged_with_its_last_words(log_records):
    fake = FakeSerial()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True, stall=0.3)
    lk.open()
    assert lk.request("go R1")[-1] == "ok"
    assert wait_for(lambda: lk.status is not None, 2.0), "a poll was answered first"
    # The port stays open but nothing comes back: the polls go unanswered.
    fake.mute()
    assert wait_for(lambda: not lk.is_open, 3.0)
    assert lk.close_reason is not None and lk.close_reason.startswith("no answer from the machine")
    text = next(r.getMessage() for r in log_records.records if r.levelno == logging.ERROR and "closed: no answer" in r.getMessage())
    assert "1 polls unanswered" in text and "last sent 'go R1'" in text
    assert "last heard '<Idle" in text and "last status '<Idle" in text


def test_a_bridge_notice_names_the_reason_when_the_port_then_fails():
    fake = FakeSerial()
    events = Collector()
    lk = Link("fake://", open_port=fake_opener(fake), poll=False)
    lk.subscribe(events)
    lk.open()
    fake.message("bridge no controller: no spinny controller under /dev/serial/by-id")
    assert wait_for(lambda: any("bridge" in m["text"] for m in events.of("message")))
    fake.vanish()
    assert wait_for(lambda: not lk.is_open, 2.0)
    assert "bridge: no controller: no spinny controller under /dev/serial/by-id" in (lk.close_reason or "")
    lk.close()


def test_a_reader_held_up_is_not_the_machines_silence():
    """A backend starved for seconds has the answers waiting unread: the
    poller must not take that for a machine that stopped."""
    fake = FakeSerial()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True, stall=0.3)
    hold = threading.Event()
    held = threading.Event()

    def starve(event):
        # In the reader thread, right after a report was heard.
        if event.kind == "status" and hold.is_set() and not held.is_set():
            held.set()
            time.sleep(0.7)

    lk.subscribe(starve)
    lk.open()
    assert wait_for(lambda: lk.status is not None, 2.0)
    hold.set()
    assert held.wait(1.0)
    time.sleep(0.5)
    assert lk.is_open, lk.close_reason
    assert wait_for(lambda: lk.age < 0.3, 2.0)
    lk.close()


def test_a_reader_stuck_for_several_stalls_ends_the_link_with_its_own_reason():
    fake = FakeSerial()
    lk = Link("fake://", open_port=fake_opener(fake), poll=True, stall=0.3)
    stuck = threading.Event()

    def jam(event):
        if event.kind == "status" and not stuck.is_set():
            stuck.set()
            time.sleep(1.6)

    lk.subscribe(jam)
    lk.open()
    assert wait_for(lambda: not lk.is_open, 3.0)
    assert lk.close_reason is not None and "reader has not run" in lk.close_reason


class _LastWordsPort:
    """A port that hands over its final bytes and fails on the next read,
    as a socket does when the far end closes after a last line."""

    def __init__(self, lines: list[bytes]) -> None:
        self._data = bytearray(b"".join(lines))
        self.is_open = True
        self.timeout = 0.05

    @property
    def in_waiting(self) -> int:
        return len(self._data)

    def read(self, size: int = 1) -> bytes:
        if not self._data:
            raise linkmod.serial.SerialException("read failed: socket disconnected")
        out = bytes(self._data[:size])
        del self._data[:size]
        return out

    def write(self, data: bytes) -> int:
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.is_open = False


def test_a_last_line_before_the_port_fails_is_still_heard():
    port = _LastWordsPort([b"[MSG:bridge /dev/ttyACM0 gone: end of file]\n"])
    events = Collector()
    lk = Link("socket://127.0.0.1:1", open_port=lambda url: port, poll=False)
    lk.subscribe(events)
    with pytest.raises(LinkError):
        lk.open()
    assert any(m["text"] == "bridge /dev/ttyACM0 gone: end of file" for m in events.of("message"))
    assert lk.close_reason is not None and "bridge: /dev/ttyACM0 gone: end of file" in lk.close_reason
