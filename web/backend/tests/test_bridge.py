"""The bridge: one client at a time on the controller's port, a device
that takes nothing given up with the client told, a stale client replaced
and a live one kept. The device is the slave side of a pty whose master a
fake board answers from."""

from __future__ import annotations

import asyncio
import os
import pty
import select
import socket
import threading
import time
import tty

import pytest
from spinny_web import bridge as bridgemod
from spinny_web.bridge import Bridge, BridgeError, find_device

BANNER = b"[spinny v0.1.0 lines:16 blocks:32]\n"
STATUS = b"<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>\n"


class FakeBoard:
    """The master side of a pty; the bridge opens the slave as the device.
    Answers `version` with the banner and `ok`, `?` with a status report,
    a line starting with `;` with nothing and any other line with `ok`.
    `reading = False` is a board that takes nothing: the pty fills and
    the slave's writes stop."""

    def __init__(self) -> None:
        self.master, self.slave = pty.openpty()
        tty.setraw(self.slave)
        self.path = os.ttyname(self.slave)
        self.received = bytearray()
        self.reading = True
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        buffer = bytearray()
        while not self._stop.is_set():
            if not self.reading:
                time.sleep(0.02)
                continue
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(self.master, 4096)
            except OSError:
                return
            self.received += data
            for _ in range(data.count(b"?")):
                self._write(STATUS)
            buffer += data.replace(b"?", b"")
            while b"\n" in buffer:
                line, _, rest = bytes(buffer).partition(b"\n")
                buffer = bytearray(rest)
                self._answer(line.strip())

    def _answer(self, line: bytes) -> None:
        if not line or line.startswith(b";"):
            return
        self._write(BANNER + b"ok\n" if line == b"version" else b"ok\n")

    def _write(self, data: bytes) -> None:
        try:
            os.write(self.master, data)
        except OSError:
            pass

    def vanish(self) -> None:
        """The board off the bus: the slave's reads fail from here on."""
        self._stop.set()
        os.close(self.master)

    def close(self) -> None:
        self._stop.set()
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


@pytest.fixture
def board():
    fake = FakeBoard()
    yield fake
    fake.close()


@pytest.fixture
def start():
    """Starts a bridge on a free port in its own thread and loop."""
    bridges: list[Bridge] = []

    def go(device: str, stall: float = 0.5, **kwargs) -> Bridge:
        bridge = Bridge(device, stall=stall, **kwargs)
        ready = threading.Event()

        def run() -> None:
            async def main() -> None:
                task = asyncio.ensure_future(bridge.run("127.0.0.1", 0))
                while bridge.port is None and not task.done():
                    await asyncio.sleep(0.01)
                ready.set()
                await task

            asyncio.run(main())

        threading.Thread(target=run, daemon=True).start()
        assert ready.wait(3.0), "the bridge did not start"
        bridges.append(bridge)
        return bridge

    yield go
    for bridge in bridges:
        bridge.stop()


def connect(bridge: Bridge, timeout: float = 2.0) -> socket.socket:
    assert bridge.port is not None
    sock = socket.create_connection(("127.0.0.1", bridge.port))
    sock.settimeout(timeout)
    return sock


def read_until(sock: socket.socket, token: bytes, timeout: float = 3.0) -> bytes:
    """What arrives until `token` is in it, or the peer closes, or time is up."""
    deadline = time.monotonic() + timeout
    data = b""
    while token not in data and time.monotonic() < deadline:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        if not chunk:
            break
        data += chunk
    return data


def closed_by_peer(sock: socket.socket, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if sock.recv(4096) == b"":
                return True
        except socket.timeout:
            continue
        except OSError:
            return True
    return False


def test_a_client_is_told_the_device_and_talks_to_the_board(board, start):
    bridge = start(board.path)
    sock = connect(bridge)
    opened = read_until(sock, b"]\n")
    assert opened == f"[MSG:bridge opened {board.path}]\n".encode()
    sock.sendall(b"version\n")
    assert BANNER in read_until(sock, b"[spinny")
    sock.sendall(b"go R1\n")
    assert b"ok\n" in read_until(sock, b"ok\n")
    sock.close()
    assert b"version\ngo R1\n" in bytes(board.received)
    # The device is closed with the client, and open again for the next.
    deadline = time.monotonic() + 2.0
    while bridge.session is not None and time.monotonic() < deadline:
        time.sleep(0.02)
    assert bridge.session is None
    again = connect(bridge)
    assert b"opened" in read_until(again, b"]\n")
    again.sendall(b"version\n")
    assert BANNER in read_until(again, b"[spinny")
    again.close()


def test_no_device_tells_the_client_why_and_closes(start):
    bridge = start("/dev/no-such-spinny-controller")
    sock = connect(bridge)
    text = read_until(sock, b"]\n")
    assert text == b"[MSG:bridge no controller: no /dev/no-such-spinny-controller]\n"
    assert closed_by_peer(sock)


def test_a_device_that_takes_nothing_is_given_up_and_the_next_client_served(board, start):
    bridge = start(board.path, stall=0.5)
    sock = connect(bridge)
    assert b"opened" in read_until(sock, b"]\n")
    board.reading = False
    # Far more than the pty holds, so the device's writes stop; the client
    # is held once the bridge's own backlog is full, so it sends from a thread.
    flood = threading.Thread(target=lambda: _send_quietly(sock, b";" * 999 + b"\n", 400), daemon=True)
    flood.start()
    text = read_until(sock, b"took nothing", timeout=6.0)
    assert f"[MSG:bridge {board.path} took nothing for 0.5 s]".encode() in text
    assert closed_by_peer(sock)
    flood.join(2.0)
    board.reading = True
    again = connect(bridge)
    assert b"opened" in read_until(again, b"]\n")
    # The flood may have left a partial line in the board; end it first.
    again.sendall(b"\nversion\n")
    assert BANNER in read_until(again, b"[spinny", timeout=5.0)
    again.close()


def _send_quietly(sock: socket.socket, chunk: bytes, times: int) -> None:
    try:
        for _ in range(times):
            sock.sendall(chunk)
    except OSError:
        pass


def test_the_board_vanishing_ends_the_session_with_a_notice(board, start):
    bridge = start(board.path)
    sock = connect(bridge)
    assert b"opened" in read_until(sock, b"]\n")
    board.vanish()
    text = read_until(sock, b"gone")
    assert f"[MSG:bridge {board.path} gone:".encode() in text
    assert closed_by_peer(sock)


def test_a_live_client_keeps_the_controller_and_a_quiet_one_is_replaced(board, start):
    bridge = start(board.path, stall=0.5)
    first = connect(bridge)
    assert b"opened" in read_until(first, b"]\n")
    second = connect(bridge)
    assert read_until(second, b"]\n") == b"[MSG:bridge busy: another client has the controller]\n"
    assert closed_by_peer(second)
    first.sendall(b"version\n")
    assert BANNER in read_until(first, b"[spinny")
    # Quiet for longer than the stall: a dead connection, replaced.
    time.sleep(0.8)
    third = connect(bridge)
    assert b"opened" in read_until(third, b"]\n")
    assert b"replaced by a new client" in read_until(first, b"replaced")
    assert closed_by_peer(first)
    third.sendall(b"version\n")
    assert BANNER in read_until(third, b"[spinny")
    third.close()


def test_find_device_picks_the_controller_by_its_id(monkeypatch, tmp_path):
    monkeypatch.setattr(bridgemod, "BY_ID", tmp_path)
    other = tmp_path / "usb-FTDI_FT232R_USB_UART_A1-if00-port0"
    other.touch()
    with pytest.raises(BridgeError, match="no spinny controller"):
        find_device("auto")
    ours = tmp_path / "usb-spinny_spinny_laser_controller_E66118604B3F-if00"
    ours.touch()
    assert find_device("auto") == str(ours)
    assert find_device(str(other)) == str(other)
    with pytest.raises(BridgeError, match="no /dev/no-such"):
        find_device("/dev/no-such")


def test_find_device_with_no_by_id_folder(monkeypatch, tmp_path):
    monkeypatch.setattr(bridgemod, "BY_ID", tmp_path / "missing")
    with pytest.raises(BridgeError):
        find_device("auto")


def test_the_backends_link_talks_through_the_bridge_and_hears_why_it_closed(board, start):
    """The whole path: the link's socket url, the bridge, the device, and
    the bridge's notice naming the reason when the board goes away."""
    from spinny_web.link import Link

    bridge = start(board.path, stall=0.5)
    events: list = []
    lk = Link(f"socket://127.0.0.1:{bridge.port}", poll=True, stall=1.0)
    lk.subscribe(events.append)
    lk.open()
    assert lk.banner is not None and lk.banner.version == "0.1.0"
    assert lk.request("go R1")[-1] == "ok"
    assert any(e.kind == "message" and e.data["text"] == f"bridge opened {board.path}" for e in events)
    board.vanish()
    deadline = time.monotonic() + 3.0
    while lk.is_open and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not lk.is_open
    assert lk.close_reason is not None and f"bridge: {board.path} gone" in lk.close_reason, lk.close_reason
    lk.close()
