"""A serial bridge for a Raspberry Pi the controller is plugged into: the
backend runs elsewhere and connects to `socket://<pi>:2324`, and this
serves the controller's port over TCP, one client at a time.

socat did this before and had to be restarted whenever the board stopped
taking bytes: its child blocked in a write to the tty, outlived its
client, and the next client was accepted but never served, so the backend
saw a port that answered nothing. Here the device is written only when it
is ready, a device that takes nothing for a few seconds is given up with
the client told why, a client that stops reading is dropped the same way,
and a new client takes over from one that has gone quiet.

The device is opened when a client connects and closed when it leaves, so
the host's DTR line follows the client: the firmware greets the opener
with its banner and stops everything when the port closes, and a board
that enumerated again between clients is found under its by-id name.
Notices to the client are `[MSG:bridge ...]` lines, which the backend
logs with the machine's own messages and names in a failed connect.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable

import serial

from .link import BAUD
from .log import LEVELS

log = logging.getLogger("spinny_bridge")

BY_ID = Path("/dev/serial/by-id")
# The firmware's USB manufacturer string, as udev writes it into the name.
BY_ID_PREFIX = "usb-spinny_"
DEFAULT_PORT = 2324
# Seconds the device may take nothing while bytes wait for it, and a client
# may send nothing before another may take its place. The backend polls
# several times a second, so a client quiet this long is gone.
STALL_SECONDS = 3.0
# Bytes waiting for one side beyond which the other is held. A backend has
# at most 16 lines and its polls in flight, so only a side that has stopped
# taking anything reaches this.
BACKLOG = 65536
CHUNK = 4096
PORT_ERRORS = (serial.SerialException, OSError, ValueError)


class BridgeError(Exception):
    pass


def find_device(spec: str) -> str:
    """The device to open: `auto` is the controller under its by-id name,
    which survives a replug and a new ttyACM number; anything else is a
    path. Looked up at every connect, so a board that enumerated again
    since the last client is found."""
    if spec != "auto":
        if not os.path.exists(spec):
            raise BridgeError(f"no {spec}")
        return spec
    try:
        names = sorted(entry.name for entry in BY_ID.iterdir() if entry.name.startswith(BY_ID_PREFIX))
    except OSError:
        names = []
    if not names:
        raise BridgeError(f"no spinny controller under {BY_ID}")
    return str(BY_ID / names[0])


def open_device(path: str) -> Any:
    """The device, raw, for one program at a time, and never blocking: its
    writes are driven by readiness, so a device that takes nothing shows
    as bytes left waiting rather than as a process stuck in the kernel.
    pyserial's flush at open is disabled: the firmware answers the DTR
    raised by the open with its banner, which the flush could discard."""
    port = serial.Serial(port=None, baudrate=BAUD, timeout=0, write_timeout=0, exclusive=True)
    port.port = path
    port.reset_input_buffer = lambda: None  # type: ignore[method-assign]
    port._reset_input_buffer = lambda: None  # type: ignore[attr-defined]
    port.open()
    os.set_blocking(port.fileno(), False)
    return port


class Session:
    """One client on one open device, until either side ends it."""

    def __init__(self, bridge: Bridge, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, port: Any, name: str) -> None:
        self.bridge = bridge
        self.reader = reader
        self.writer = writer
        self.port = port
        self.fd: int = port.fileno()
        self.name = name
        self.loop = asyncio.get_running_loop()
        # Bytes the device has not taken yet, and when it last took some.
        self.pending = bytearray()
        self.last_progress = time.monotonic()
        self.last_from_client = time.monotonic()
        self._writing = False
        # Why the session ended, and then that the device is closed again.
        self.ended: asyncio.Future[str] = self.loop.create_future()
        self.closed: asyncio.Future[None] = self.loop.create_future()

    def end(self, reason: str) -> None:
        if not self.ended.done():
            self.ended.set_result(reason)

    @property
    def quiet_for(self) -> float:
        """Seconds since the client last sent anything."""
        return time.monotonic() - self.last_from_client

    def _device_readable(self) -> None:
        try:
            data = os.read(self.fd, CHUNK)
        except BlockingIOError:
            return
        except OSError as exc:
            self.end(f"{self.name} gone: {exc.strerror or exc}")
            return
        if not data:
            self.end(f"{self.name} gone: end of file")
            return
        self.writer.write(data)
        if self.writer.transport.get_write_buffer_size() > BACKLOG:
            self.end("the client stopped reading")

    def _flush(self) -> None:
        """Hands the device what it will take now; the rest waits for the
        next readiness, and the watch gives the device up when it takes
        nothing for long."""
        try:
            taken = os.write(self.fd, self.pending)
        except BlockingIOError:
            taken = 0
        except OSError as exc:
            self.end(f"{self.name} gone: {exc.strerror or exc}")
            return
        if taken:
            del self.pending[:taken]
            self.last_progress = time.monotonic()
        if self.pending and not self._writing:
            self.loop.add_writer(self.fd, self._flush)
            self._writing = True
        elif not self.pending and self._writing:
            self.loop.remove_writer(self.fd)
            self._writing = False

    async def _client_to_device(self) -> None:
        try:
            while True:
                data = await self.reader.read(CHUNK)
                if not data:
                    self.end("the client closed")
                    return
                self.last_from_client = time.monotonic()
                if not self.pending:
                    # The stall clock runs from when something first waited.
                    self.last_progress = time.monotonic()
                self.pending += data
                self._flush()
                # The client is held while the device is behind, so a flood
                # into a device that takes nothing stays bounded.
                while len(self.pending) > BACKLOG and not self.ended.done():
                    await asyncio.sleep(0.05)
        except OSError as exc:
            self.end(f"the client went away: {exc.strerror or exc}")

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(min(0.25, self.bridge.stall / 4))
            if self.pending and time.monotonic() - self.last_progress > self.bridge.stall:
                self.end(f"{self.name} took nothing for {self.bridge.stall:g} s")
                return

    async def run(self) -> str:
        self.loop.add_reader(self.fd, self._device_readable)
        tasks = [asyncio.ensure_future(self._client_to_device()), asyncio.ensure_future(self._watch())]
        try:
            reason = await self.ended
        finally:
            for task in tasks:
                task.cancel()
            self.loop.remove_reader(self.fd)
            if self._writing:
                self.loop.remove_writer(self.fd)
                self._writing = False
            try:
                self.port.close()
            except PORT_ERRORS:
                pass
            self.closed.set_result(None)
        return reason


class Bridge:
    """Serves the device to one TCP client at a time."""

    def __init__(
        self,
        device: str = "auto",
        stall: float = STALL_SECONDS,
        open_port: Callable[[str], Any] = open_device,
        find: Callable[[str], str] = find_device,
    ) -> None:
        self.device = device
        self.stall = stall
        self._open = open_port
        self._find = find
        self.session: Session | None = None
        # The port bound, once `run` listens; 0 asks for a free one.
        self.port: int | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopped: asyncio.Event | None = None

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        who = f"{peer[0]}:{peer[1]}" if peer else "a client"
        try:
            await self._serve(reader, writer, who)
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 1.0)
            except (OSError, asyncio.TimeoutError):
                pass

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, who: str) -> None:
        current = self.session
        if current is not None and not current.closed.done():
            # A client still sending keeps the controller; one that has
            # gone quiet is a dead connection, replaced by this one.
            if current.quiet_for < self.stall:
                log.warning("%s refused: another client has the controller", who)
                await self._notice(writer, "busy: another client has the controller")
                return
            current.end("replaced by a new client")
            await current.closed
        try:
            name = self._find(self.device)
            port = self._open(name)
        except (BridgeError, *PORT_ERRORS) as exc:
            log.error("%s: no controller: %s", who, exc)
            await self._notice(writer, f"no controller: {exc}")
            return
        session = Session(self, reader, writer, port, name)
        self.session = session
        log.info("%s: opened %s", who, name)
        await self._notice(writer, f"opened {name}")
        reason = await session.run()
        log.info("%s: closed %s: %s", who, name, reason)
        await self._notice(writer, reason)
        if self.session is session:
            self.session = None

    @staticmethod
    async def _notice(writer: asyncio.StreamWriter, text: str) -> None:
        try:
            writer.write(f"[MSG:bridge {text}]\n".encode("ascii", errors="replace"))
            await asyncio.wait_for(writer.drain(), 1.0)
        except (OSError, asyncio.TimeoutError):
            pass

    async def run(self, bind: str = "127.0.0.1", port: int = DEFAULT_PORT) -> None:
        self._loop = asyncio.get_running_loop()
        self._stopped = asyncio.Event()
        server = await asyncio.start_server(self.serve, bind, port)
        self.port = server.sockets[0].getsockname()[1]
        log.info("listening on %s:%d, device %s", bind, self.port, self.device)
        try:
            self._loop.add_signal_handler(signal.SIGTERM, self.stop)
        except (NotImplementedError, RuntimeError):
            pass
        async with server:
            await self._stopped.wait()
            session = self.session
            if session is not None and not session.closed.done():
                session.end("the bridge is stopping")
                await session.closed

    def stop(self) -> None:
        """Ends the server from any thread."""
        if self._loop is not None and self._stopped is not None:
            self._loop.call_soon_threadsafe(self._stopped.set)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spinny-bridge", description="Serves the controller's serial port over TCP, one client at a time.")
    parser.add_argument(
        "--device",
        default="auto",
        help="the controller's device path, or `auto` for the one under /dev/serial/by-id that announces itself"
        " as the controller, looked up at every connect (default: auto)",
    )
    parser.add_argument(
        "--bind",
        default="127.0.0.1",
        help="the address to listen on; the loopback default keeps the controller behind the ssh login that"
        " relay-pi forwards through (default: 127.0.0.1)",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"the port to listen on (default: {DEFAULT_PORT})")
    parser.add_argument(
        "--stall",
        type=float,
        default=STALL_SECONDS,
        help="seconds the device may take nothing before it is given up, and a client may send nothing before"
        f" a new one replaces it (default: {STALL_SECONDS:g})",
    )
    parser.add_argument(
        "--log-level",
        choices=LEVELS,
        default=os.environ.get("SPINNY_LOG_LEVEL", "info").lower(),
        help="how much is written to stderr (default: info, or SPINNY_LOG_LEVEL)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stderr,
    )
    bridge = Bridge(args.device, stall=args.stall)
    try:
        asyncio.run(bridge.run(args.bind, args.port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
