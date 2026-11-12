"""The virtual pick and place machine (spinny_web.virtual_pnp) and its
cameras (spinny_web.virtual_camera): moves that take their time, M400 and
the quickstop, the nozzle picking and the vacuum sensor saying so, the
socket it is served on, the pictures drawn from the head's place and the
JPEG they are sent as."""

from __future__ import annotations

import json
import math
import socket
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from spinny_web import virtual_pnp
from spinny_web.gcode_link import GcodeLink, firmware_of
from spinny_web.openpnp import parse
from spinny_web.virtual_camera import COS, ZIGZAG, World, fill_polygon, jpeg, serve_camera
from spinny_web.virtual_pnp import HELD_READING, OPEN_READING, AIR_READING, VirtualMarlin, serve, to_picture

REPO = Path(__file__).resolve().parents[3]
VIRTUAL = REPO / "machines" / "virtual-pnp.toml"
READ = ["M260 A112 B1 S1", "M260 A109 B6 S1", "M261 A109 B1 S2"]


def answers(machine: VirtualMarlin, oks: int, timeout: float = 5.0) -> list[str]:
    """The lines the machine answers until `oks` of them are ok."""
    lines: list[str] = []
    deadline = time.monotonic() + timeout
    pending = ""
    while sum(1 for line in lines if line.startswith("ok")) < oks:
        if time.monotonic() > deadline:
            raise AssertionError(f"only {lines} came")
        pending += machine.read(4096).decode()
        while "\n" in pending:
            line, pending = pending.split("\n", 1)
            if line.strip():
                lines.append(line.strip())
    return lines


def send(machine: VirtualMarlin, *lines: str) -> list[str]:
    machine.write("".join(line + "\n" for line in lines).encode())
    return answers(machine, len(lines))


def fresh(**kwargs) -> VirtualMarlin:
    machine = VirtualMarlin(**kwargs)
    machine.drain()
    return machine


# --- motion ---------------------------------------------------------------------------------


def test_a_move_takes_the_time_its_feed_gives_and_m400_waits_for_it():
    machine = fresh(position=(0.0, 0.0, 0.0), timed=True, pace=10.0)
    began = time.monotonic()
    # 10 mm at 600 mm/min is a second, a tenth at ten times the pace.
    send(machine, "G1 X10 F600")
    # Taken at once, and M114 already says where the moves end, as Marlin's does.
    assert time.monotonic() - began < 0.05
    assert send(machine, "M114")[0].startswith("X:10.00 Y:0.00")
    middle = machine.head()[0]
    assert 0.0 < middle < 10.0
    send(machine, "M400")
    assert 0.08 < time.monotonic() - began < 0.5
    assert machine.head()[:3] == (10.0, 0.0, 0.0)


def test_m400_says_busy_while_it_waits(monkeypatch):
    monkeypatch.setattr(virtual_pnp, "KEEPALIVE", 0.05)
    machine = fresh(position=(0.0, 0.0, 0.0), timed=True, pace=1.0)
    send(machine, "G1 X2 F600")
    lines = send(machine, "M400")
    assert lines[-1] == "ok" and "echo:busy: processing" in lines[:-1]


def test_a_quickstop_stops_the_head_where_it_is_and_ends_the_wait():
    machine = fresh(position=(0.0, 0.0, 0.0), timed=True, pace=1.0)
    send(machine, "G1 X100 F600", "G1 Y100")
    machine.write(b"M400\n")
    time.sleep(0.2)
    began = time.monotonic()
    machine.write(b"M410\n")
    # The wait ends at once, then the quickstop is answered in its turn.
    assert answers(machine, 2) == ["ok", "ok"]
    assert time.monotonic() - began < 0.5
    x = float(send(machine, "M114")[0].split()[0][2:])
    assert 1.0 < x < 10.0
    assert machine.head()[:2] == machine.position[:2]


def test_g28_homes_to_its_place_and_g92_and_relative_moves_count():
    machine = fresh(position=(40.0, 30.0, 0.0), home=(0.0, 0.0, 31.5))
    assert send(machine, "G28") == ["echo:busy: processing", "ok"]
    assert machine.position == (0.0, 0.0, 31.5) and machine.homed
    send(machine, "G92 X5", "G91", "G1 X1 Y2", "G90")
    assert machine.position == (6.0, 2.0, 31.5)


def test_the_firmware_names_itself_as_opulo_marlin():
    machine = fresh()
    assert firmware_of(send(machine, "M115")) == {"firmware": "Marlin 2.1.2 (Opulo)", "machine": "LumenPnP"}


# --- the nozzle and the vacuum ---------------------------------------------------------------


def reading(machine: VirtualMarlin) -> int:
    return int(send(machine, *READ)[-2].rsplit("data:", 1)[1])


def lumen(**kwargs) -> VirtualMarlin:
    return fresh(position=(100.0, 100.0, 31.5), touch_z=16.5, valve_fan=1, **kwargs)


def test_a_part_is_picked_with_the_tip_down_and_the_suction_on():
    machine = lumen()
    assert abs(reading(machine) - AIR_READING) <= 2
    # The pump alone does not draw through a closed valve.
    send(machine, "M106")
    assert machine.vacuum and not machine.suction and abs(reading(machine) - AIR_READING) <= 2
    # Open, up in the air: the open nozzle.
    send(machine, "M106 P1 S180")
    assert machine.held is None and abs(reading(machine) - OPEN_READING) <= 2
    # Down on something: held, and it stays held going up.
    send(machine, "G1 Z13", "G1 Z31.5")
    assert machine.held is not None and abs(reading(machine) - HELD_READING) <= 2
    # N2's sensor, on the mux's other channel, reads the open air.
    assert int(send(machine, "M260 A112 B2 S1", "M261 A109 B1 S2")[-2].rsplit("data:", 1)[1]) >= AIR_READING - 2
    # Let go: the part lies where the tip was.
    send(machine, "G1 X120 Y80 Z14", "M107 P1", "M107")
    assert machine.held is None and len(machine.lying) == 1
    assert math.dist(machine.lying[0].center, (120.0, 80.0)) < 0.15
    assert abs(reading(machine) - AIR_READING) <= 2


def test_every_nth_pick_misses_and_the_bottom_camera_holds_no_parts():
    machine = lumen(miss_every=2, no_parts_near=(60.0, 220.0))
    for _ in range(2):
        send(machine, "G1 Z13", "M106 P1 S180", "M106", "G1 Z31.5")
        held = machine.held is not None
        send(machine, "M107 P1", "M107")
    assert machine.picks == 2 and not held
    send(machine, "G1 X60 Y220", "G1 Z4", "M106 P1 S180", "M106")
    assert machine.held is None


def test_a_held_part_turns_with_the_nozzle():
    machine = lumen(runout=(0.05, 0.0))
    send(machine, "G1 Z13", "M106 P1 S180", "M106", "G1 Z31.5")
    before = machine.held_part(machine.head())
    send(machine, "G1 A90")
    after = machine.held_part(machine.head())
    assert after.angle == pytest.approx(before.angle + 90.0)
    # About the turning axis, which the head's place is.
    assert math.dist(after.center, (100.0, 100.0)) == pytest.approx(math.dist(before.center, (100.0, 100.0)))
    assert machine.tip(machine.head()) == pytest.approx((100.0, 100.05))


def test_the_photon_bus_answers_on_m485():
    from spinny_web.feederbus import HEADER_FIELDS, Packet, decode

    machine = fresh()
    machine.bus = virtual_pnp.PhotonBus({1: "AB" * 12})
    packet = Packet(to=1, sender=0, number=7, payload=bytes([0x01])).encode(HEADER_FIELDS)
    reply = send(machine, f"M485 {packet}")[0]
    answer = decode(reply.split(":", 1)[1].strip(), HEADER_FIELDS)
    assert answer is not None and answer.number == 7 and answer.payload == bytes([0]) + bytes.fromhex("AB" * 12)


# --- on a socket -------------------------------------------------------------------------------


def test_the_link_connects_to_the_machine_on_a_socket_and_finds_it_where_it_left_it():
    machine = VirtualMarlin(position=(10.0, 20.0, 31.5))
    machine.report_angle = True
    server = socket.create_server(("127.0.0.1", 0))
    url = f"socket://127.0.0.1:{server.getsockname()[1]}"
    stop = threading.Event()
    thread = threading.Thread(target=serve, args=(machine, server, stop), daemon=True)
    thread.start()
    try:
        link = GcodeLink(lambda: None)
        link.connect(url, 115200, 0, ("G21", "G90"), 5.0)
        assert link.command("M114", 5.0)[0].startswith("X:10.00 Y:20.00 Z:31.50 A:0.00")
        link.command("G1 X15", 5.0)
        link.disconnect()
        # The next client finds the head where the last one left it.
        link = GcodeLink(lambda: None)
        link.connect(url, 115200, 0, (), 5.0)
        assert link.command("M114", 5.0)[0].startswith("X:15.00 Y:20.00")
        link.disconnect()
    finally:
        stop.set()
        server.close()
        thread.join(timeout=2.0)


# --- the pictures ---------------------------------------------------------------------------------


def dark_center(raster: bytearray, width: int, below: int) -> tuple[float, float, int]:
    xs = ys = n = 0
    for index, value in enumerate(raster):
        if value < below:
            xs += index % width + 0.5
            ys += index // width + 0.5
            n += 1
    return xs / n, ys / n, n


def world_over(head) -> World:
    world = World.from_machine(parse(VIRTUAL.read_text(encoding="utf-8"), "virtual-pnp"))
    machine = fresh(position=head, touch_z=world.touch_z, valve_fan=1, runout=world.runout, no_parts_near=world.bottom.place)
    machine.light = 255
    world.machine = machine
    return world


def test_the_bottom_camera_sees_the_tip_where_the_head_puts_it():
    world = world_over((0.0, 0.0, 4.0))
    camera = world.bottom
    head = (camera.place[0] + 0.3, camera.place[1] - 0.2, 4.0)
    send(world.machine, f"G1 X{head[0]:.4f} Y{head[1]:.4f}")
    x, y, n = dark_center(camera.picture(), camera.width, 120)
    tip = world.machine.tip(world.machine.head())
    u, v = to_picture((tip[0] - camera.place[0], tip[1] - camera.place[1]), camera.roll, camera.mirror, camera.scale)
    assert (x, y) == pytest.approx((camera.width / 2 + u, camera.height / 2 + v), abs=0.2)
    assert n == pytest.approx(math.pi * (0.25 / camera.scale) ** 2, rel=0.05)
    # With the light off the window is dim.
    world.machine.light = 0
    assert max(camera.picture()) < 100


def test_the_bottom_camera_sees_a_held_part_over_the_tip():
    world = world_over((100.0, 100.0, 31.5))
    camera = world.bottom
    machine = world.machine
    send(machine, "G1 Z13", "M106 P1 S180", "M106", "G1 Z31.5", f"G1 X{camera.place[0]:.4f} Y{camera.place[1]:.4f} Z4")
    _, _, n = dark_center(camera.picture(), camera.width, 120)
    assert n == pytest.approx(1.6 * 0.8 / camera.scale**2, rel=0.03)


def test_the_top_camera_sees_the_mark_and_a_board_s_fiducials(tmp_path):
    board = tmp_path / "fid.kicad_pcb"
    board.write_text(
        '(kicad_pcb (version 20240108)\n'
        '  (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))\n'
        '  (footprint "Fiducial:Fiducial_1mm_Mask2mm" (layer "F.Cu") (at 5 5)\n'
        '    (property "Reference" "FID1")\n'
        '    (pad "" smd circle (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask"))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )
    world = world_over((0.0, 0.0, 31.5))
    found = world.add_board(board, (200.0, 100.0), 90.0)
    # KiCad's y down turned up, then the board turned a quarter.
    assert found.fiducials[0][0] == pytest.approx((205.0, 105.0))
    assert len(found.outline) == 4
    camera = world.top
    machine = world.machine
    for place, shade in ((world.mark, "dark"), (found.fiducials[0][0], "bright")):
        head = (place[0] - camera.offset[0] + 0.5, place[1] - camera.offset[1])
        send(machine, f"G1 X{head[0]:.4f} Y{head[1]:.4f}")
        raster = camera.picture()
        if shade == "dark":
            x, y, _ = dark_center(raster, camera.width, 120)
        else:
            inverted = bytearray(255 - value for value in raster)
            # Brighter than the bed: the copper alone.
            x, y, _ = dark_center(inverted, camera.width, 255 - 215)
        u, v = to_picture((-0.5, 0.0), camera.roll, camera.mirror, camera.scale)
        assert (x, y) == pytest.approx((camera.width / 2 + u, camera.height / 2 + v), abs=0.3)


def test_a_polygon_s_edge_pixels_are_blended_by_cover():
    raster = bytearray([200]) * 16
    fill_polygon(raster, 4, 4, [(1.5, 0.0), (3.0, 0.0), (3.0, 4.0), (1.5, 4.0)], 0)
    assert list(raster[:4]) == [200, 100, 0, 200]


# --- JPEG -------------------------------------------------------------------------------------------


def decode(data: bytes) -> tuple[int, int, bytearray]:
    """This writer's own JPEG read back: its flat tables (DC sizes in 4
    bits, AC symbols in 8, in its order), quantized by 1."""
    from spinny_web.virtual_camera import AC_SYMBOLS

    assert data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"
    at = data.index(b"\xff\xc0")
    height, width = int.from_bytes(data[at + 5 : at + 7], "big"), int.from_bytes(data[at + 7 : at + 9], "big")
    at = data.index(b"\xff\xda")
    body = data[at + 2 + int.from_bytes(data[at + 2 : at + 4], "big") : -2].replace(b"\xff\x00", b"\xff")
    bits = "".join(f"{byte:08b}" for byte in body)
    position = 0

    def take(n: int) -> int:
        nonlocal position
        value = int(bits[position : position + n], 2) if n else 0
        position += n
        return value

    def number(size: int) -> int:
        value = take(size)
        return value if size == 0 or value >> (size - 1) else value - (1 << size) + 1

    out = bytearray(width * height)
    previous = 0
    for top in range(0, height, 8):
        for left in range(0, width, 8):
            coefficients = [0] * 64
            previous += number(take(4))
            coefficients[0] = previous
            k = 1
            while k < 64:
                symbol = AC_SYMBOLS[take(8)]
                if symbol == 0x00:
                    break
                if symbol == 0xF0:
                    k += 16
                    continue
                k += symbol >> 4
                coefficients[ZIGZAG[k]] = number(symbol & 15)
                k += 1
            if not any(coefficients[1:]):
                shade = max(0, min(255, round(coefficients[0] / 8 + 128)))
                for y in range(8):
                    out[(top + y) * width + left : (top + y) * width + left + 8] = bytes([shade]) * 8
                continue
            for y in range(8):
                for x in range(8):
                    value = sum(coefficients[v * 8 + u] * COS[x][u] * COS[y][v] for v in range(8) for u in range(8))
                    out[(top + y) * width + left + x] = max(0, min(255, round(value + 128)))
    return width, height, out


def test_a_picture_comes_back_from_its_jpeg_within_a_shade():
    world = world_over((0.0, 0.0, 4.0))
    camera = world.bottom
    send(world.machine, f"G1 X{camera.place[0] + 0.1:.4f} Y{camera.place[1]:.4f}")
    raster = camera.picture()[: 64 * 48]
    # A corner of the picture with noise over it: every block through the DCT.
    noisy = bytearray((value + (index * 37) % 23) % 256 for index, value in enumerate(raster))
    width, height, back = decode(jpeg(noisy, 64, 48))
    assert (width, height) == (64, 48)
    assert max(abs(a - b) for a, b in zip(noisy, back)) <= 1
    # A whole drawn picture: mostly flat blocks, a few edges.
    full = camera.picture()
    _, _, back = decode(jpeg(full, camera.width, camera.height))
    assert max(abs(a - b) for a, b in zip(full, back)) <= 1


def test_a_jpeg_of_the_wrong_size_is_refused():
    with pytest.raises(ValueError, match="multiples of 8"):
        jpeg(bytearray(10 * 8), 10, 8)


def test_the_cameras_answer_as_a_ustreamer_does():
    world = world_over((0.0, 0.0, 31.5))
    server = serve_camera(world.top, "127.0.0.1:0")
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(f"{base}/state", timeout=5) as answer:
            state = json.load(answer)
        assert state["result"]["source"]["resolution"] == {"width": 640, "height": 480}
        with urllib.request.urlopen(f"{base}/snapshot", timeout=5) as answer:
            assert answer.headers["Content-Type"] == "image/jpeg"
            assert answer.read()[:2] == b"\xff\xd8"
    finally:
        server.shutdown()


# --- the program --------------------------------------------------------------------------------------


def test_the_shipped_virtual_machine_file_reads_and_points_at_the_program():
    machine = parse(VIRTUAL.read_text(encoding="utf-8"), "virtual-pnp")
    assert machine.url == "socket://127.0.0.1:2327"
    assert machine.vacuum is not None and machine.vacuum.part_on == (220.0, 241.0)
    assert [slot.address for slot in machine.slots] == [1, 2, 3]
    # The virtual sensor's readings fall in the file's ranges.
    assert machine.vacuum.part_on[0] <= HELD_READING - 2 and HELD_READING + 2 <= machine.vacuum.part_on[1]
    assert machine.vacuum.part_off[0] <= OPEN_READING - 2 and AIR_READING + 1 <= machine.vacuum.part_off[1]


def test_a_board_argument_names_its_file_and_place():
    assert virtual_pnp._board("a/b.kicad_pcb@10,20") == ("a/b.kicad_pcb", 10.0, 20.0, 0.0)
    assert virtual_pnp._board("b.kicad_pcb@1,2,90") == ("b.kicad_pcb", 1.0, 2.0, 90.0)
    with pytest.raises(Exception, match="give FILE"):
        virtual_pnp._board("b.kicad_pcb")


def test_a_missing_machine_file_is_said(tmp_path, capsys):
    assert virtual_pnp.main(["--machine", str(tmp_path / "none.toml")]) == 2
    assert "none.toml" in capsys.readouterr().err
