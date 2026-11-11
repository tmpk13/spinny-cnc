import { describe, expect, test } from "bun:test";
import { button, el, lockFieldset, lockFor, setLocked } from "../src/dom.ts";
import { MACHINE_KEYS } from "../src/machinekeys.ts";
import { disabledTip } from "../src/tooltip.ts";
import { keyAt, keyTip, type SettingRow } from "../src/views/settingslist.ts";

describe("locks with a reason", () => {
    test("a lock keeps its reason until it is let go; the busy flag stays apart", () => {
        const node = button("Run", () => undefined);
        setLocked(node, true, "connect first");
        expect(node.disabled).toBe(true);
        expect(node.dataset["reason"]).toBe("connect first");
        setLocked(node, true);
        expect(node.dataset["reason"]).toBeUndefined();
        setLocked(node, true, "pick a job first");
        setLocked(node, false, "ignored when unlocked");
        expect(node.disabled).toBe(false);
        expect(node.dataset["reason"]).toBeUndefined();
    });

    test("the first condition that holds locks the button and says why", () => {
        const node = button("Run", () => undefined);
        lockFor(node, [false, "connect first"], [true, "pick a job first"], [true, "a run is under way"]);
        expect(node.disabled).toBe(true);
        expect(node.dataset["reason"]).toBe("pick a job first");
        lockFor(node, [false, "connect first"], [false, "pick a job first"]);
        expect(node.disabled).toBe(false);
        expect(node.dataset["reason"]).toBeUndefined();
    });
});

describe("the words over a disabled button", () => {
    test("what it does over why it is off; the same words once", () => {
        const node = button("Apply", () => undefined);
        node.title = "save the text as the job";
        setLocked(node, true, "nothing edited");
        expect(disabledTip(node)).toBe("save the text as the job\nnothing edited");
        setLocked(node, true, "save the text as the job");
        expect(disabledTip(node)).toBe("save the text as the job");
        setLocked(node, true);
        expect(disabledTip(node)).toBe("save the text as the job");
        node.removeAttribute("title");
        expect(disabledTip(node)).toBeNull();
    });

    test("a button in a disabled fieldset takes the fieldset's reason", () => {
        const inner = button("X+", () => undefined);
        const fieldset = el("fieldset", {}, inner) as HTMLFieldSetElement;
        lockFieldset(fieldset, true, "connect first");
        expect(fieldset.disabled).toBe(true);
        expect(disabledTip(inner)).toBe("connect first");
        // The button's own reason comes first.
        setLocked(inner, true, "no such axis");
        expect(disabledTip(inner)).toBe("no such axis");
        setLocked(inner, false);
        lockFieldset(fieldset, false, "connect first");
        expect(fieldset.dataset["reason"]).toBeUndefined();
        expect(disabledTip(inner)).toBeNull();
    });
});

describe("a machine file key under the pointer", () => {
    const text = [
        "# a machine",
        "name = \"x\"",
        "",
        "[rail]",
        "  max_rate = 560",
        "accel = 50",
        "[host]",
        "travel = 3",
    ].join("\n");

    test("only the key's name, in the section above it", () => {
        expect(keyAt(text, 1, 0)).toEqual({ section: null, name: "name" });
        expect(keyAt(text, 1, 3)).toEqual({ section: null, name: "name" });
        // Past the name: the value.
        expect(keyAt(text, 1, 4)).toBeNull();
        expect(keyAt(text, 4, 1)).toBeNull();
        expect(keyAt(text, 4, 2)).toEqual({ section: "rail", name: "max_rate" });
        expect(keyAt(text, 5, 0)).toEqual({ section: "rail", name: "accel" });
        expect(keyAt(text, 7, 2)).toEqual({ section: "host", name: "travel" });
        // A comment, a blank line, a section head, and past the end.
        expect(keyAt(text, 0, 2)).toBeNull();
        expect(keyAt(text, 2, 0)).toBeNull();
        expect(keyAt(text, 3, 1)).toBeNull();
        expect(keyAt(text, 40, 0)).toBeNull();
    });

    test("a key's tip: its help and the setting it drives, the setting alone without help", () => {
        const entry = MACHINE_KEYS.find((key) => key.setting === "r_rate")!;
        const host = MACHINE_KEYS.find((key) => key.setting === "host.travel")!;
        const row = (fields: Partial<SettingRow>): SettingRow => ({ entry, section: "rail", name: "max_rate", file: null, board: null, differs: false, help: "", ...fields });
        expect(keyTip([row({ help: "mm/min: max radius rate" })], "rail", "max_rate")).toBe("mm/min: max radius rate (r_rate)");
        expect(keyTip([row({})], "rail", "max_rate")).toBe("sets r_rate");
        expect(keyTip([row({})], "slide", "max_rate")).toBeNull();
        const travel = row({ entry: host, section: "host", name: "travel", help: "H to rise to before travel moves" });
        expect(keyTip([travel], "host", "travel")).toBe("H to rise to before travel moves");
        expect(keyTip([{ ...travel, help: "" }], "host", "travel")).toBeNull();
    });
});
