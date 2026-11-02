import { describe, expect, test } from "bun:test";

import fixture from "../../../toolpath/tests/data/machine-keys.json" with { type: "json" };
import { MACHINE_KEYS, fromBoard, fuzzyScore, keyLine, setKey, valueOf } from "../src/machinekeys.ts";
import { parseMachine } from "../src/mock/machines.ts";

describe("machine keys", () => {
    test("are the backend's, key for key (mise run keys-fixture)", () => {
        expect(MACHINE_KEYS).toEqual(fixture.keys as typeof MACHINE_KEYS);
    });

    test("read a board into a file as the backend does, line for line", () => {
        const { into, board, host, text, changes, left } = fixture.case;
        const read = fromBoard(into, board as Record<string, number>, host, (given) => parseMachine(given, "into"), "into.toml");
        expect(read.changes).toEqual(changes);
        expect(read.text).toEqual(text);
        expect(read.left).toEqual(left);
    });

    test("a file read from the board it describes is left as it is", () => {
        const { into } = fixture.case;
        const settings = parseMachine(into, "into").settings;
        const read = fromBoard(into, settings, { tolerance: 0.005, clearance: 2 }, (given) => parseMachine(given, "into"), "into.toml");
        expect(read).toEqual({ text: into, changes: [], left: [] });
    });

    test("a key is written in place, its comment kept, or added where it belongs", () => {
        const text = 'name = "x"\n\n[rail]\nmax_rate = 560              # mm/min\n\n[controls]\npad = true\n';
        expect(setKey(text, "rail", "max_rate", 900)).toBe('name = "x"\n\n[rail]\nmax_rate = 900              # mm/min\n\n[controls]\npad = true\n');
        const probe = setKey(text, "probe", "pin", 26);
        expect(probe.indexOf("[probe]\npin = 26")).toBeLessThan(probe.indexOf("[controls]"));
        expect(setKey(text, null, "kinematics", "cartesian").startsWith('name = "x"\nkinematics = "cartesian"\n')).toBe(true);
        expect(keyLine(text, "rail", "max_rate")).toBe(3);
        expect(keyLine(text, "rail", "accel")).toBeNull();
        expect(setKey('[c]\nhint = "a # b"   # note\n', "c", "hint", "z")).toBe('[c]\nhint = "z"       # note\n');
    });

    test("values are read per key, a bit of a mask or a socket's digit", () => {
        const settings = { dir_invert: 0b0101, sockets: 1324, r_stop: 2, cartesian: 1, spindle: 1 };
        const of = (section: string | null, name: string) => valueOf(MACHINE_KEYS.find((k) => k.section === section && k.key === name)!, settings);
        expect(of("rail", "invert")).toBe(true);
        expect(of("table", "invert")).toBe(false);
        expect(of("table", "socket")).toBe("Z");
        expect(of("rail", "endstop")).toBe("max");
        expect(of(null, "tool")).toBe("spindle");
    });

    test("fuzzy search finds the letters in order, closer runs first", () => {
        expect(fuzzyScore("rmr", "[rail] max_rate r_rate")).not.toBeNull();
        expect(fuzzyScore("xyz", "[rail] max_rate r_rate")).toBeNull();
        expect(fuzzyScore("max", "[rail] max_rate")!).toBeGreaterThan(fuzzyScore("max", "[rail] microsteps accel x")!);
        expect(fuzzyScore("", "anything")).toBe(0);
    });
});
