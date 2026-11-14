import { describe, expect, test } from "bun:test";

import { fromBoard, MACHINE_KEYS, valueOf } from "../src/machinekeys.ts";
import { DEFAULT_SETTINGS, parseMachine } from "../src/mock/machines.ts";
import { statusLine } from "../src/mock/backend.ts";
import { angleText, readAngle, servoBars } from "../src/servos.ts";
import type { SettingsResponse } from "../src/types.ts";
import { mountJog } from "../src/views/jog.ts";
import { click, connected, runUntilIdle, settle, setup } from "./harness.ts";

const SERVO_FILE = `
[output]
pin = 20

[probe]
pin = 22

[pca9685]
sda = 24
scl = 29
address = 0x41

[servo.1]
name = "Pen"
pin = 1
min_us = 900
max_us = 2100
range = 270
start = 90
positions = { up = 30, down = 120.5 }

[servo.3]
channel = 15
max_us = 1200
`;

describe("servos in a machine file, as the backend reads them", () => {
    test("land on their numbers, with the page's bars", () => {
        const doc = parseMachine(SERVO_FILE, "servos");
        const s = doc.settings;
        expect([s["i2c_sda"], s["i2c_scl"], s["pca_addr"]]).toEqual([24, 29, 0x41]);
        expect([1, 2, 3, 4].map((n) => s[`servo${n}_out`])).toEqual([1, 0, 2, 0]);
        expect([s["servo1_pin"], s["servo1_min_us"], s["servo1_max_us"], s["servo1_range"], s["servo1_start"]]).toEqual([1, 900, 2100, 270, 90]);
        expect([s["servo3_chan"], s["servo3_max_us"], s["servo3_start"]]).toEqual([15, 1200, -1]);
        expect(doc.servos).toEqual([
            { servo: 1, name: "Pen", range: 270, positions: [{ name: "up", angle: 30 }, { name: "down", angle: 120.5 }] },
            { servo: 3, name: "Servo 3", range: 180, positions: [] },
        ]);
        const plain = parseMachine("", "plain");
        expect(plain.servos).toEqual([]);
        expect([1, 2, 3, 4].map((n) => plain.settings[`servo${n}_out`])).toEqual([0, 0, 0, 0]);
    });

    // The cases and words of toolpath/tests/test_machines.py.
    const refused: [string, string][] = [
        ["[servo.1]\nname = 'x'\n", "servo.1 needs pin, a GPIO of the board, or channel"],
        ["[servo.1]\npin = 29\nchannel = 2\n", "[servo.1] channel and pin cannot both be given"],
        ["[servo.5]\npin = 29\n", "servo.5 is not a servo: the board has servo.1 to servo.4"],
        ["[servo.pen]\npin = 29\n", "servo.pen is not a servo"],
        ["[servo.1]\npin = 13\n", "[servo.1] pin 13 is a driver socket's"],
        ["[servo.1]\npin = 4\n", "[servo.1] pin 4 (X-STOP) is a STOP header's"],
        ["[servo.2]\nchannel = 16\n", "[servo.2] channel must be 0 to 15"],
        ["[servo.1]\npin = 29\nmin_us = 150\n", "[servo.1] min_us must be 200 to 3000"],
        ["[servo.1]\npin = 29\nrange = 0\n", "[servo.1] range must be above 0 and at most 360 degrees"],
        ["[servo.1]\npin = 29\nrange = 90\nstart = 120\n", "[servo.1] start must be 0 to the range, 90 degrees"],
        ["[servo.1]\npin = 29\nstart = -1\n", "[servo.1] start must be 0 to the range"],
        ["[servo.1]\npin = 29\npositions = { up = 200 }\n", "[servo.1] positions up must be an angle, 0 to the range, 180 degrees"],
        ["[servo.1]\npin = 29\npositions = [1, 2]\n", "[servo.1] positions must be a table of names and angles"],
        ["[servo.1]\npin = 29\nspeed = 2\n", "[servo.1] speed is not a key here"],
        ["[servo.1]\npin = 29\nname = ' '\n", "[servo.1] name must not be empty"],
        ["servo = 1\n", "servo must be a table"],
        ["[servo.1]\npin = 20\n", "[servo.1] pin 20 (FAN3) is the [output] pin too"],
        ["[servo.1]\npin = 21\n", "[servo.1] pin 21 (BED) is on PWM slice 2 with the [output] pin 20 (FAN3), which runs at the laser's rate"],
        ["[probe]\npin = 22\n[servo.1]\npin = 22\n", "[servo.1] pin 22 (PROBE) is the [probe] pin too"],
        ["[enable]\nfitted = true\npin = 18\n[servo.2]\npin = 18\n", "[servo.2] pin 18 (FAN2) is the [enable] pin too"],
        ["[servo.1]\npin = 29\n[servo.2]\npin = 29\n", "[servo.2] pin 29 (SERVO) is the [servo.1] pin too"],
        ["[servo.1]\npin = 1\n[servo.4]\npin = 17\n", "[servo.4] pin 17 (FAN1) drives the PWM channel of the [servo.1] pin 1 (RX): GPIO n and n + 16 share one"],
        ["[servo.1]\nchannel = 4\n[servo.3]\nchannel = 4\n", "[servo.3] channel 4 is [servo.1]'s too"],
        ["[pca9685]\nsda = 1\n", "[pca9685] sda must be an even GPIO"],
        ["[pca9685]\nscl = 24\n", "[pca9685] scl must be an odd GPIO"],
        ["[pca9685]\nsda = 16\n", "[pca9685] sda 16 (E-STOP) is a STOP header's"],
        ["[pca9685]\naddress = 0x80\n", "[pca9685] address must be 64 to 127"],
        ["[pca9685]\nsda = 18\n[servo.1]\nchannel = 0\n", "[pca9685] sda 18 (FAN2) and scl 1 (RX) are not one I2C block's"],
        ["[servo.1]\npin = 1\n[servo.2]\nchannel = 0\n", "[pca9685] scl 1 (RX) is the [servo.1] pin too"],
        ["[output]\npin = 24\n[pca9685]\nsda = 24\n[servo.1]\nchannel = 0\n", "[pca9685] sda 24 (RGB) is the [output] pin too"],
        ["[pca9685]\nbus = 1\n", "[pca9685] bus is not a key here"],
        ['[rail]\nendstop = "min"\nendstop_pin = 29\n[servo.1]\npin = 29\n', "[rail] endstop_pin 29 (SERVO) is the [servo.1] pin too"],
        ['[rail]\nendstop = "min"\nendstop_pin = 0\n[servo.1]\nchannel = 0\n', "[rail] endstop_pin 0 (TX) is the [pca9685] pin too"],
        ["[output]\npin = 4\n", "[output] pin 4 (X-STOP) is a STOP header's"],
        ["[enable]\nfitted = true\npin = 25\n[probe]\npin = 22\n", "[enable] pin 25 (Z-STOP) is a STOP header's"],
        ['controller = "gcode"\n[servo.1]\npin = 29\n', "servo is for a machine on this project's firmware"],
    ];
    for (const [text, message] of refused) {
        test(`refuses with the key named: ${message}`, () => {
            expect(() => parseMachine(text, "servos")).toThrow(message);
        });
    }

    test("a bus no servo uses keeps its pins to themselves", () => {
        const s = parseMachine("[pca9685]\nsda = 18\nscl = 1\n[servo.1]\npin = 29\n", "bus").settings;
        expect([s["i2c_sda"], s["i2c_scl"]]).toEqual([18, 1]);
        parseMachine("[output]\npin = 24\n[pca9685]\nsda = 24\n", "bus");
        const both = parseMachine("[servo.1]\npin = 26\n[servo.2]\npin = 27\n", "slice").settings;
        expect([both["servo1_pin"], both["servo2_pin"]]).toEqual([26, 27]);
    });

    test("a servo read from the board comes with its pin or its channel, as the backend writes it", () => {
        const text = "[servo.1]\npin = 29        # the SERVOS header\nstart = 90\n\n[servo.3]\nchannel = 2\n";
        const board = { ...parseMachine(text, "file").settings, servo1_out: 2, servo1_chan: 7, servo2_out: 1, servo2_pin: 24, servo2_max_us: 2400, servo3_out: 0 };
        const read = fromBoard(text, board, null, (t) => parseMachine(t, "read"), "read");
        const machine = parseMachine(read.text, "read");
        expect([1, 2, 3, 4].map((n) => machine.settings[`servo${n}_out`])).toEqual([2, 1, 2, 0]);
        expect([machine.settings["servo1_chan"], machine.settings["servo1_start"]]).toEqual([7, 90]);
        expect([machine.settings["servo2_pin"], machine.settings["servo2_max_us"]]).toEqual([24, 2400]);
        expect(read.text).not.toContain("pin = 29");
        expect(read.changes).toContain("[servo.1] channel = 7 (was unset)");
        expect(read.changes).toContain("[servo.2] pin = 24 (was unset)");
        expect(read.left).toEqual(["servo3_out"]);
        const start = MACHINE_KEYS.find((key) => key.setting === "servo2_start")!;
        expect(valueOf(start, board)).toBeNull();
    });
});

describe("the servos' bars", () => {
    test("one per servo the settings fit, named and buttoned by its file", () => {
        const values = { ...DEFAULT_SETTINGS, servo1_out: 1, servo3_out: 2, servo3_range: 90 };
        const bars = servoBars(values, [{ servo: 3, name: "Gate", range: 90, positions: [{ name: "open", angle: 10 }, { name: "far", angle: 120 }] }], false);
        expect(bars).toEqual([
            { servo: 1, name: "Servo 1", range: 180, positions: [] },
            { servo: 3, name: "Gate", range: 90, positions: [{ name: "open", angle: 10 }] },
        ]);
        expect(servoBars(values, [], true)).toEqual([]);
        expect(servoBars(undefined, [], false)).toEqual([]);
        expect(angleText(null)).toBe("off");
        expect(angleText(12.3456)).toBe("12.35 deg");
        expect(readAngle("45", 90)).toEqual({ angle: 45 });
        expect(readAngle("91", 90)).toEqual({ problem: "enter an angle, 0 to 90 deg" });
        expect("problem" in readAngle("", 90)).toBe(true);
    });

    test("the jog panel moves them, lets them go and reads where they are", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        mountJog(root, ctx);
        store.set({ snapshot: connected() });
        expect(root.querySelector("[data-servo]")).toBeNull();
        for (const line of ["$servo1_out=1", "$servo2_out=2", "$servo2_range=90"]) {
            expect(await api.command(line)).toEqual(["ok"]);
        }
        const settings: SettingsResponse = { ...(await api.settings()), servos: [{ servo: 1, name: "Pen", range: 180, positions: [{ name: "up", angle: 30 }] }] };
        store.set({ settings });
        const pen = root.querySelector('[data-servo="1"]')!;
        expect(pen.textContent).toContain("Pen");
        expect(pen.textContent).toContain("off");
        expect(root.querySelector('[data-servo="2"]')!.textContent).toContain("Servo 2");
        click(pen, "up");
        await settle();
        expect(calls.find((c) => c.name === "servo")?.args).toEqual([1, 30]);
        calls.length = 0;
        const field = pen.querySelector("input") as HTMLInputElement;
        field.value = "200";
        click(pen, "Go");
        await settle();
        expect(calls.find((c) => c.name === "servo")).toBeUndefined();
        field.value = "75";
        click(pen, "Go");
        await settle();
        expect(calls.find((c) => c.name === "servo")?.args).toEqual([1, 75]);
        click(pen, "Off");
        await settle();
        expect(calls.filter((c) => c.name === "servo").at(-1)?.args).toEqual([1, null]);
        store.set({ snapshot: connected({ servos: [75, 12.5, null, null] }) });
        expect(root.querySelector('[data-servo="1"]')!.textContent).toContain("75 deg");
        expect(root.querySelector('[data-servo="2"]')!.textContent).toContain("12.5 deg");
    });
});

describe("the mock's servos, as the firmware and the backend have them", () => {
    test("the line moves a fitted servo after the motion before it, and the status line says where", async () => {
        const { api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        expect(await api.command("servo N1 A90")).toEqual(["error:2 bad word"]);
        expect(await api.command("$servo1_out=1")).toEqual(["ok"]);
        expect(await api.command("$servo3_out=2")).toEqual(["ok"]);
        expect(statusLine(backend.machine)).toMatch(/\|S:,,,>$/);
        expect(await api.command("servo N1 A90")).toEqual(["ok"]);
        expect(statusLine(backend.machine)).toMatch(/\|S:90,,,>$/);
        expect(await api.command("servo N3 A181")).toEqual(["error:4 out of range"]);
        expect(await api.command("servo N5 A1")).toEqual(["error:4 out of range"]);
        expect(await api.command("servo N1.5 A1")).toEqual(["error:2 bad word"]);
        expect(await api.command("servo N1")).toEqual(["error:3 missing word"]);
        expect(await api.command("servo N1 off A3")).toEqual(["error:2 bad word"]);
        // Behind a move it waits for the move.
        expect(await api.command("go R10")).toEqual(["ok"]);
        expect(await api.command("servo N3 A45.25")).toEqual(["ok"]);
        expect(backend.machine.servoAngle(2)).toBeNull();
        runUntilIdle(backend);
        expect(statusLine(backend.machine)).toMatch(/\|S:90,,45.25,>$/);
        expect(await api.command("servo N1 off")).toEqual(["ok"]);
        expect((await api.state()).machine?.servos).toEqual([null, null, 45.25, null]);
        // The defaults keep the servos; a servo wired anew lets go.
        expect(await api.command("$defaults")).toEqual(["ok"]);
        expect(backend.machine.settings["servo3_out"]).toBe(2);
        expect(backend.machine.servoAngle(2)).toBe(45.25);
        expect(await api.command("$servo3_chan=9")).toEqual(["ok"]);
        expect(backend.machine.servoAngle(2)).toBeNull();
        expect(await api.command("$servo1_pin=4")).toEqual(["error:7 bad setting value"]);
    });

    test("the route checks what the backend checks", async () => {
        const { api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        await expect(api.servo(1, 90)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("servo 1 has no output") });
        await api.command("$servo2_out=1");
        await api.command("$servo2_range=90");
        await expect(api.servo(5, 10)).rejects.toMatchObject({ status: 400 });
        await expect(api.servo(2, 91)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("0 to 90 degrees") });
        await api.servo(2, 30);
        expect(backend.machine.servoAngle(1)).toBe(30);
        await api.servo(2, null);
        expect(backend.machine.servoAngle(1)).toBeNull();
    });
});
