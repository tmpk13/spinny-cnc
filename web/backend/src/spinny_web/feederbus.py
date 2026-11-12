"""Feeders on a bus: smart feeders a G-code machine's controller relays packets
to, each told to advance its tape before a pick, as Opulo's Photon feeders
are over the LumenPnP's RS-485 through Marlin's M485.

What is generic here is the shape: a packet is a header and a payload,
sent as hex in a G-code line and answered in a line a pattern finds; the
first payload byte of a command is its code, and of an answer how it
went. A feeder is found by its id (a broadcast answered from its
address), initialized with its id, told to feed a number of tenths of a
millimeter, and asked until the feed is done. The machine file's `[bus]` gives
the specifics: the lines, the header's bytes and their order, the
addresses, and every code; `[[slot]]` gives where the feeder at each
address presents its part.

The header's bytes are named: `to`, `from`, `id` (the packet's number,
which its answer carries back), `length` (the payload's) and `crc`
(CRC-8, polynomial 0x07, over every other header byte and the payload, in
order). Photon's header is to, from, id, length, crc.
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from typing import Callable

HEADER_FIELDS = ("to", "from", "id", "length", "crc")
ID_BYTES = 12
# A feed's answer says how long the feeder expects to take; OpenPnP found
# it too long by far, so it bounds the asking rather than being waited out.
FEED_WAIT_FACTOR = 3.0
FEED_WAIT_FLOOR = 2.0


class BusError(Exception):
    """A feeder that could not be found, initialized, or fed."""


def crc8(data: bytes) -> int:
    """CRC-8 with the polynomial 0x07, starting at 0, as Photon checks a packet."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


@dataclass(frozen=True)
class BusProfile:
    """How packets reach the feeders: the line that carries one (`{packet}`
    is its hex), the pattern whose group is the answer's hex, the header's
    bytes in order, this host's address and the broadcast one, tries per
    exchange, the addresses a scan asks, the wait between status asks, and
    the codes: the commands' and the answers'."""

    send: str = "M485 {packet}"
    reply: str = r"rs485-reply: *(?P<packet>[0-9A-Fa-f]*)"
    header: tuple[str, ...] = HEADER_FIELDS
    host: int = 0
    broadcast: int = 255
    tries: int = 3
    max_address: int = 32
    poll_ms: int = 50
    get_id: int = 0x01
    init: int = 0x02
    feed: int = 0x04
    status: int = 0x06
    find: int = 0xC0
    ok: int = 0x00
    wrong_id: int = 0x01
    unreachable: int = 0x02
    uninitialized: int = 0x03
    busy: int = 0x04


@dataclass(frozen=True)
class Packet:
    to: int
    sender: int
    number: int
    payload: bytes

    def encode(self, header: tuple[str, ...]) -> str:
        """The packet as the hex the send line carries, upper case."""
        values = {"to": self.to, "from": self.sender, "id": self.number, "length": len(self.payload)}
        checked = bytes(values[name] & 0xFF for name in header if name != "crc") + self.payload
        values["crc"] = crc8(checked)
        return (bytes(values[name] & 0xFF for name in header) + self.payload).hex().upper()


def decode(text: str, header: tuple[str, ...]) -> Packet | None:
    """A packet from its hex, or None for one that does not read: odd hex,
    too short, a length the payload does not have, or a check that fails."""
    text = text.strip()
    if len(text) % 2 or not re.fullmatch(r"[0-9A-Fa-f]*", text):
        return None
    data = bytes.fromhex(text)
    if len(data) < len(header):
        return None
    values = dict(zip(header, data[: len(header)]))
    payload = data[len(header):]
    if "length" in values and values["length"] != len(payload):
        return None
    if "crc" in values:
        checked = bytes(values[name] for name in header if name != "crc") + payload
        if crc8(checked) != values["crc"]:
            return None
    return Packet(to=values.get("to", 0), sender=values.get("from", 0), number=values.get("id", 0), payload=payload)


def check_id(text: str) -> str:
    """A feeder's id as 24 hex digits, upper case; ValueError otherwise."""
    value = text.strip().upper()
    if not re.fullmatch(r"[0-9A-F]{%d}" % (ID_BYTES * 2), value):
        raise ValueError(f"a feeder's id is {ID_BYTES * 2} hex digits, not {text!r}")
    return value


@dataclass
class FeederBus:
    """The feeders' bus as one run or one request sees it: packets out
    through `send` (one G-code line, its answer's lines back), the
    addresses found and the feeders initialized remembered meanwhile."""

    profile: BusProfile
    send: Callable[[str], list[str]]
    sleep: Callable[[float], None] = time.sleep
    stopped: Callable[[], bool] = lambda: False
    number: int = 0
    found: dict[str, int] = field(default_factory=dict)
    ready: set[int] = field(default_factory=set)

    def exchange(self, to: int, code: int, payload: bytes = b"") -> Packet | None:
        """One command and its answer, tried up to the profile's tries; None
        when no answer reads (a timeout, a garbled one, another packet's)."""
        pattern = re.compile(self.profile.reply)
        for _ in range(max(1, self.profile.tries)):
            if self.stopped():
                raise BusError("stopped")
            number = self.number
            self.number = (self.number + 1) % 256
            packet = Packet(to=to, sender=self.profile.host, number=number, payload=bytes([code]) + payload)
            line = self.profile.send.replace("{packet}", packet.encode(self.profile.header))
            for text in self.send(line):
                found = pattern.search(text)
                if found is None:
                    continue
                named = found.groupdict().get("packet")
                answer = decode(named if named is not None else found.group(1), self.profile.header)
                if answer is not None and ("id" not in self.profile.header or answer.number == number):
                    return answer
        return None

    def _code(self, answer: Packet) -> int:
        return answer.payload[0] if answer.payload else -1

    def find(self, feeder_id: str) -> int | None:
        """The address of the feeder with this id, asked of every feeder at once."""
        if feeder_id in self.found:
            return self.found[feeder_id]
        answer = self.exchange(self.profile.broadcast, self.profile.find, bytes.fromhex(check_id(feeder_id)))
        if answer is None or self._code(answer) != self.profile.ok:
            return None
        self.found[feeder_id] = answer.sender
        return answer.sender

    def feeder_at(self, address: int) -> str | None:
        """The id of the feeder at an address, or None for no answer."""
        answer = self.exchange(address, self.profile.get_id)
        if answer is None or self._code(answer) != self.profile.ok or len(answer.payload) < 1 + ID_BYTES:
            return None
        return answer.payload[1 : 1 + ID_BYTES].hex().upper()

    def scan(self) -> list[dict]:
        """Every address from 1 to the profile's last that answers, with its feeder's id."""
        feeders = []
        for address in range(1, self.profile.max_address + 1):
            feeder_id = self.feeder_at(address)
            if feeder_id is not None:
                feeders.append({"address": address, "id": feeder_id})
                self.found[feeder_id] = address
        return feeders

    def initialize(self, address: int, feeder_id: str) -> None:
        """Tells the feeder at an address it is that feeder, as a feeder
        wants before it feeds; BusError for another feeder there, or none."""
        answer = self.exchange(address, self.profile.init, bytes.fromhex(check_id(feeder_id)))
        if answer is None:
            raise BusError(f"no feeder answered at address {address}")
        code = self._code(answer)
        if code == self.profile.wrong_id:
            other = answer.payload[1 : 1 + ID_BYTES].hex().upper() if len(answer.payload) >= 1 + ID_BYTES else "another"
            raise BusError(f"the feeder at address {address} is {other}, not {feeder_id}")
        if code != self.profile.ok:
            raise BusError(f"the feeder at address {address} would not initialize (code {code})")
        self.ready.add(address)

    def advance(self, feeder_id: str, tenths: int, address: int | None = None) -> int:
        """Moves the feeder's tape on by `tenths` of a millimeter and waits
        until it is done: the feeder found by its id (or at `address`),
        initialized once, told to feed (again after initializing, should it
        say it was not), then asked until it says done. The address fed."""
        if not 1 <= tenths <= 255:
            raise BusError(f"a feed is 1 to 255 tenths of a mm, not {tenths}")
        if address is None:
            address = self.find(feeder_id)
            if address is None:
                raise BusError(f"no feeder answered to the id {feeder_id}: is it in its slot?")
        for attempt in range(2):
            if address not in self.ready:
                self.initialize(address, feeder_id)
            answer = self.exchange(address, self.profile.feed, bytes([tenths]))
            if answer is None:
                self.ready.discard(address)
                raise BusError(f"the feeder at address {address} did not answer the feed")
            code = self._code(answer)
            if code == self.profile.uninitialized and attempt == 0:
                self.ready.discard(address)
                continue
            if code != self.profile.ok:
                raise BusError(f"the feeder at address {address} refused the feed (code {code})")
            expected = int.from_bytes(answer.payload[1:3], "big") / 1000.0 if len(answer.payload) >= 3 else 0.0
            self._wait(address, max(FEED_WAIT_FLOOR, expected * FEED_WAIT_FACTOR))
            return address
        raise BusError(f"the feeder at address {address} stays uninitialized")

    def _wait(self, address: int, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        asks = 0
        while True:
            self.sleep(self.profile.poll_ms / 1000.0)
            asks += 1
            answer = self.exchange(address, self.profile.status)
            if answer is not None:
                code = self._code(answer)
                if code == self.profile.ok:
                    return
                if code == self.profile.unreachable:
                    raise BusError(f"the feeder at address {address} could not reach its place: is its tape jammed?")
                if code != self.profile.busy:
                    raise BusError(f"the feeder at address {address} answered the status with code {code}")
            if time.monotonic() > deadline and asks > self.profile.tries:
                raise BusError(f"the feeder at address {address} did not finish its feed in {seconds:.1f} s")


def slot_place(slot_at: tuple[float, float, float], slot_rotation: float, offset: tuple[float, float, float]) -> tuple[float, float, float]:
    """A feeder's pick place from its slot's: the offset turned by the
    slot's rotation and added, as OpenPnP places a Photon feeder."""
    radians = math.radians(slot_rotation)
    c, s = math.cos(radians), math.sin(radians)
    return (
        slot_at[0] + offset[0] * c - offset[1] * s,
        slot_at[1] + offset[0] * s + offset[1] * c,
        slot_at[2] + offset[2],
    )
