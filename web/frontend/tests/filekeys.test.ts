import { describe, expect, test } from "bun:test";

import { FILE_KEYS, fileValue, takes, textController, type FileKey } from "../src/filekeys.ts";
import { MACHINE_KEYS, fuzzyScore } from "../src/machinekeys.ts";
import { gcodeMachineOf, parseMachine } from "../src/mock/machines.ts";
import { parseToml } from "../src/toml.ts";
import type { CameraState, MachineDocument, PlacingState } from "../src/types.ts";
import { insertValue, liveValue, rowToml, rowsToml, searchText, settingRows, type SettingRow } from "../src/views/settingslist.ts";

// A file of this project's firmware giving every key of its own (no
// firmware setting holds them), and a G-code machine's giving every key of
// its tables: the mock's readers refuse a key they do not know, so each
// key of the table reads, and the samples must give every key the table
// has for their kind.
const SPINNY_SAMPLE = `name = "Sample"
description = "every file key"
controller = "spinny"
kinematics = "polar"

[camera]
device = "/dev/video0"
size = "1280x720"
fps = 30
pcbv = "pcbv"
side = "front"
finish = "masked"
offset = [1.0, 2.0]
roll = 90
mm_per_px = 0.01

[servo.1]
name = "Pen"
channel = 0
positions = { up = 30 }

[servo.2]
name = "Gate"
channel = 1
positions = { open = 10 }

[servo.3]
name = "Shutter"
channel = 2
positions = { shut = 0 }

[servo.4]
name = "Arm"
channel = 3
positions = { out = 90 }

[controls]
pad = true
pad_steps = [0.1, 1, 10]
pad_step = 1
feed = true
center = { r = 0 }
centering = true

[[controls.axes]]
axis = "r"
letter = "R"
label = "Radius"
steps = [0.1, 1, 10]
step = 1
buttons = ["Radius -", "Radius +"]
feed = true
goto = true
zero = true
zero_hint = "set here as 0"
keys = ["PageDown", "PageUp"]
note = "the rail"
`;

const GCODE_SAMPLE = `name = "Sample"
description = "every key"
controller = "gcode"
kinematics = "cartesian"
tool = "nozzle"

[port]
url = "socket://127.0.0.1:9"
match = ["sample"]
baud = 115200
wait_ms = 0
timeout = 2

[gcode]
init = ["G21", "G90"]
end = []
move = "G0"
x = "X"
y = "Y"
z = "Z"
rotation = "A"
rotation_cw = false
wait = "M400"
pick = "M106"
place = "M107"
dwell = "G4 P{ms}"
home = "G28"
position = "M114"
stop = "M410"
motors_on = "M17"
motors_off = "M18"
light_on = ["M150 P255"]
light_off = ["M150 P0"]
skew = "M852 I{skew}"

[motion]
feed_xy = 6000
feed_z = 1200
safe_z = 5
place_z = -1
pick_dwell_ms = 200
place_dwell_ms = 150
pick_tries = 3
park = [40.0, 400.0]
travel = [0.0, 0.0, 433.0, 487.0]
seesaw = true
skew = 0.0023
skew_by = "link"
discard = [10.0, 10.0, -1.0]

[vacuum]
read = "M105"
pattern = "T:\\\\s*(-?[0-9]+)"
part_on = [40.0, 100.0]
part_off = [0.0, 10.0]

[up_camera]
position = [150.0, 30.0]
z = -4
crop = 3.0
max_offset = 1.0
max_turn = 15
size_tolerance = 0.3
leave = 2.0
roll = 90
mirror = false
device = "/dev/video1"
size = "640x480"
fps = 30
pcbv = "pcbv"
nozzle_spot = "dark"
part_spot = "bright"

[up_camera.crops]
nozzle = [0.35, 0.3, 0.65, 0.7]
part = [0.2, 0.1, 0.8, 0.9]

[top_camera]
z = 0
offset = [40.0, 0.0]
roll = 180
mm_per_px = 0.016
bed = [20.0, 60.0, 450.0, 550.0]
board_area = [40.0, 80.0, 200.0, 200.0]
board_area_only = true
fiducial = "bright"
within = 2.0
home_fiducial = [60.0, 170.0]
device = "/dev/video4"
size = "640x480"
fps = 30
pcbv = "pcbv"
mark_spot = "dark"

[top_camera.crops]
board = [0.0, 0.0, 1.0, 1.0]
spot = [0.3, 0.25, 0.7, 0.75]
edges = [0.1, 0.1, 0.9, 0.9]
measure = [0.1, 0.1, 0.9, 0.9]

[bus]
send = "M485 {packet}"
reply = "rs485-reply: *(?<packet>[0-9A-Fa-f]*)"
header = ["to", "from", "id", "length", "crc"]
host = 0
broadcast = 255
tries = 3
max_address = 25
poll_ms = 50
get_id = 1
init = 2
feed = 4
status = 6
find = 192
identify = 193
program_floor = 194
unready = 195
ok = 0
wrong_id = 1
unreachable = 2
uninitialized = 3
busy = 4
fail = 5

[controls]
pad = true
pad_steps = [0.1, 1, 10]
pad_step = 1
feed = true
center = { r = 0 }

[[controls.axes]]
axis = "r"
letter = "X"
label = "X"
steps = [0.1, 1, 10]
step = 1
buttons = ["X-", "X+"]
feed = true
goto = true
zero = true
zero_hint = "set here as 0"
keys = ["PageDown", "PageUp"]
note = "the head"

[[slot]]
address = 1
at = [100.0, 30.0, 12.0]
rotation = 0

[[part_class]]
name = "0402"
match = "0402"
crop = 1.0

[[feeder]]
id = "tray"
match = "10k"
refs = ["R1"]
at = [100.0, 50.0, -2.0]
pitch = [4.0, 0.0]
count = 10
columns = 5
row_pitch = [0.0, 4.0]
rotation = 0
place_z = -1
feed = ["M400"]
vision = true
size = [1.6, 0.8]
pocket = "bright"
marks = [[98.0, 48.0]]
mark = "dark"
crop = 2.0

[[feeder]]
id = "photon"
match = "100n"
bus_id = "0123456789ABCDEF01234567"
slot = 1
offset = [0.0, 0.0, 0.0]
advance = 2
`;

/** Every key a sample gives, as (section, key): an array of tables by its name, the top by null. */
function keysOf(text: string): Set<string> {
    const found = new Set<string>();
    let section: string | null = null;
    for (const line of text.split("\n")) {
        const head = /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?/.exec(line);
        if (head) {
            section = head[1]!;
            continue;
        }
        const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
        if (key) {
            found.add(`${section ?? ""}:${key[1]}`);
        }
    }
    return found;
}

const id = (key: FileKey): string => `${key.section ?? ""}:${key.key}`;

describe("the file keys no firmware setting holds", () => {
    test("every one reads in the mock's readers, and the samples give every one", () => {
        expect(() => parseMachine(SPINNY_SAMPLE, "sample")).not.toThrow();
        expect(() => gcodeMachineOf(GCODE_SAMPLE, "sample")).not.toThrow();
        // The firmware's keys are MACHINE_KEYS's; the spinny sample gives
        // kinematics, which is one of those.
        const firmware = new Set(MACHINE_KEYS.map((key) => `${key.section ?? ""}:${key.key}`));
        const spinny = [...keysOf(SPINNY_SAMPLE)].filter((key) => !firmware.has(key) && !/^servo\.\d:(channel|pin)$/.test(key));
        expect(spinny.sort()).toEqual(FILE_KEYS.filter((key) => takes(key, "spinny")).map(id).sort());
        expect([...keysOf(GCODE_SAMPLE)].sort()).toEqual(FILE_KEYS.filter((key) => takes(key, "gcode")).map(id).sort());
        // No key twice.
        expect(new Set(FILE_KEYS.map((key) => `${id(key)}:${key.machine}`)).size).toBe(FILE_KEYS.length);
    });

    test("every key docs/MACHINES.md names in its schemas is listed", async () => {
        const machinesDoc = await Bun.file(new URL("../../../docs/MACHINES.md", import.meta.url)).text();
        const listed = new Set([
            ...MACHINE_KEYS.map((key) => `${key.section ?? ""}:${key.key}`),
            // The dispenser's plunger is the table's driver, in mm.
            ...MACHINE_KEYS.filter((key) => key.section === "table").map((key) => `dispenser:${key.key === "full_steps_per_deg" ? "full_steps_per_mm" : key.key}`),
            ...FILE_KEYS.map(id),
        ]);
        const blocks = [...machinesDoc.matchAll(/```toml\n([\s\S]*?)```/g)].map((match) => match[1]!);
        expect(blocks.length).toBeGreaterThan(1);
        const named = blocks.flatMap((block) => [...keysOf(block)]);
        expect(named.filter((key) => !listed.has(key))).toEqual([]);
    });

    test("a file's values are read from its text, each table of an array listed", () => {
        const parsed = parseToml(GCODE_SAMPLE);
        const key = (section: string | null, name: string): FileKey => FILE_KEYS.find((entry) => entry.section === section && entry.key === name && takes(entry, "gcode"))!;
        expect(fileValue(parsed, key("vacuum", "part_on"))).toEqual([40, 100]);
        expect(fileValue(parsed, key("up_camera", "roll"))).toBe(90);
        expect(fileValue(parsed, key("feeder", "id"))).toEqual(["tray", "photon"]);
        expect(fileValue(parsed, key("feeder", "bus_id"))).toEqual(["0123456789ABCDEF01234567"]);
        expect(fileValue(parseToml("[controls]\npad = true\n"), key("controls", "center"))).toBeNull();
        expect(fileValue(parseToml(SPINNY_SAMPLE), FILE_KEYS.find((entry) => entry.section === "controls" && entry.key === "center")!)).toBe("{ r = 0 }");
        expect(textController(GCODE_SAMPLE)).toBe("gcode");
        expect(textController("[rail]\nmax_rate = 5\n")).toBe("spinny");
    });
});

describe("the settings list's search", () => {
    const profile = { tool: "laser", h_axis: false };
    const best = (rows: SettingRow[], query: string, count = 3): string[] =>
        rows
            .map((row) => ({ row, score: fuzzyScore(query, searchText(row)) }))
            .filter((item) => item.score !== null)
            .sort((a, b) => b.score! - a.score!)
            .slice(0, count)
            .map(({ row }) => (row.section ? `[${row.section}] ${row.name}` : row.name));

    test("a G-code machine's file lists its own tables, the vacuum's keys found by vacuum or suction", () => {
        const rows = settingRows(null, GCODE_SAMPLE, null, profile);
        // The firmware's keys are refused in such a file, so none is listed.
        expect(rows.some((row) => row.entry !== null)).toBe(false);
        expect(best(rows, "vacuum", 4)).toEqual(["[vacuum] read", "[vacuum] pattern", "[vacuum] part_on", "[vacuum] part_off"]);
        expect(best(rows, "suction", 6)).toContain("[gcode] pick");
        const part = rows.find((row) => row.section === "vacuum" && row.name === "part_on")!;
        expect(part.file).toEqual([40, 100]);
        expect(part.board).toBeNull();
    });

    test("a camera's roll is found as rotation, turn or angle", () => {
        const spinny = settingRows(null, SPINNY_SAMPLE, null, profile);
        expect(best(spinny, "camera rotation", 1)).toEqual(["[camera] roll"]);
        expect(best(spinny, "camera turn", 1)).toEqual(["[camera] roll"]);
        expect(best(spinny, "picture angle", 1)).toEqual(["[camera] roll"]);
        const gcode = settingRows(null, GCODE_SAMPLE, null, profile);
        expect(best(gcode, "bottom camera rotation", 1)).toEqual(["[up_camera] roll"]);
        expect(best(gcode, "top camera angle", 1)).toEqual(["[top_camera] roll"]);
        expect(best(gcode, "flip", 1)).toEqual(["[up_camera] mirror"]);
    });

    test("a camera's keys show the camera's values, the top camera's roll once measured", () => {
        const document = { id: "sample", controller: "gcode" } as MachineDocument;
        const roll = (section: string): FileKey => FILE_KEYS.find((key) => key.section === section && key.key === "roll")!;
        const camera = { roll: 2.5, offset: [1, 2] } as CameraState;
        expect(liveValue({ camera, placing: null, pnp: null }, { id: "head", controller: "spinny" } as MachineDocument, roll("camera"))).toBe(2.5);
        // The head camera is no G-code machine's.
        expect(liveValue({ camera, placing: null, pnp: null }, document, roll("camera"))).toBeNull();
        const placing = {
            machine: "sample",
            top: { mm_per_px: 0, roll: 0 },
            camera: { position: [150, 30], mm_per_px: 0.02, roll: 1.5, mirror: true, measured: true },
        } as unknown as PlacingState;
        expect(liveValue({ camera: null, placing, pnp: null }, document, roll("top_camera"))).toBeNull();
        expect(liveValue({ camera: null, placing, pnp: null }, document, roll("up_camera"))).toBe(1.5);
        const measured = { ...placing, top: { ...placing.top, mm_per_px: 0.02, roll: 179.5 } } as PlacingState;
        expect(liveValue({ camera: null, placing: measured, pnp: null }, document, roll("top_camera"))).toBe(179.5);
        // Another machine's cameras are not this file's.
        expect(liveValue({ camera: null, placing: measured, pnp: null }, { ...document, id: "other" }, roll("top_camera"))).toBeNull();
        // In the rows: the file's roll beside the measured one, differing.
        const rows = settingRows(document, GCODE_SAMPLE, null, profile, (key) => liveValue({ camera: null, placing: measured, pnp: null }, document, key));
        const top = rows.find((row) => row.section === "top_camera" && row.name === "roll")!;
        expect([top.file, top.board, top.differs]).toEqual([180, 179.5, true]);
    });
});

describe("the settings list's Copy and Insert", () => {
    const rows = settingRows(null, GCODE_SAMPLE, null, { tool: "laser", h_axis: false });
    const row = (section: string | null, name: string): SettingRow => rows.find((entry) => entry.section === section && entry.name === name)!;

    test("a row copies as its table and its key, a feeder's as its first table's", () => {
        expect(rowToml(row("vacuum", "part_on"))).toBe("[vacuum]\npart_on = [40, 100]\n");
        expect(rowToml(row(null, "name"))).toBe('name = "Sample"\n');
        expect(rowToml(row("feeder", "id"))).toBe('[[feeder]]\nid = "tray"\n');
    });

    test("rows copy as one text, the top's keys first, each table once, an array's keys left out", () => {
        const text = rowsToml([row("vacuum", "read"), row(null, "name"), row("vacuum", "part_on"), row("feeder", "id"), row("motion", "safe_z")]);
        expect(text).toBe('name = "Sample"\n\n[vacuum]\nread = "M105"\npart_on = [40, 100]\n\n[motion]\nsafe_z = 5\n');
        expect(parseToml(text)).toEqual({ name: "Sample", vacuum: { read: "M105", part_on: [40, 100] }, motion: { safe_z: 5 } });
        expect(rowsToml([row("feeder", "id")])).toBe("");
    });

    test("Insert writes the live value where the file says otherwise, else adds a missing key with its value", () => {
        const camera = { ...row("up_camera", "roll"), board: 1.5, differs: true };
        expect(insertValue(camera, true)).toBe(1.5);
        expect(insertValue({ ...camera, board: 90, differs: false }, true)).toBeNull();
        expect(insertValue({ ...row("up_camera", "crop"), file: null }, false)).toBeNull();
        expect(insertValue(row("motion", "feed_xy"), false)).toBe(6000);
        expect(insertValue(row("feeder", "id"), true)).toBeNull();
    });
});

