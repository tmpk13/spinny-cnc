import { describe, expect, test } from "bun:test";

import { jointOfBoard } from "../src/kinematics.ts";
import { FIND_STEP_SECONDS, type MockBackend } from "../src/mock/backend.ts";
import { MockFindings } from "../src/mock/findings.ts";
import type { FindingEntry } from "../src/types.ts";
import { appliedText, changeText, entryTime, mountChanges, valueText } from "../src/views/changes.ts";
import { settle, setup } from "./harness.ts";

/** The head camera's find run on the mock until it ends, from a mark at the tool's point. */
async function measured(backend: MockBackend): Promise<void> {
    await backend.connect("/dev/ttyACM0");
    await backend.cameraStart();
    const joint = jointOfBoard({ x: 10, y: 14 });
    await backend.setPosition({ r: joint.r, a: joint.a });
    await backend.cameraMark({ here: true });
    await backend.cameraFind(2);
    for (let guard = 0; (await backend.camera()).routine?.state === "running" && guard < 100; guard += 1) {
        backend.step(FIND_STEP_SECONDS);
    }
}

describe("the log of changes in words", () => {
    test("values, changes, times and the row's words", () => {
        expect(valueText(180.38123456)).toBe("180.38123");
        expect(valueText(0.01597)).toBe("0.01597");
        expect(valueText([12.5, -3.25])).toBe("12.5, -3.25");
        expect(valueText(null)).toBe("none");
        expect(valueText(true)).toBe("yes");
        expect(valueText([{ ref: "FID1" }, { ref: "FID2" }])).toBe("FID1, FID2");
        expect(valueText([])).toBe("none");
        expect(changeText({ target: "top", name: "roll", label: "roll, degrees", before: 180, after: 180.38 })).toBe("roll, degrees: 180 -> 180.38");
        expect(entryTime("2026-11-14T20:15:02", "2026-11-14")).toBe("20:15:02");
        expect(entryTime("2026-11-13T20:15:02", "2026-11-14")).toBe("2026-11-13 20:15:02");
        const entry = { kind: "undo", text: "undone: offset measured" } as FindingEntry;
        expect(appliedText(entry)).toBe("Undone: offset measured.");
        expect(appliedText({ ...entry, kind: "offset", text: "offset measured" })).toBe("Applied: offset measured.");
    });
});

describe("the mock's log", () => {
    test("keeps a patch with its values before, undoes it, and refuses once a value changed since", () => {
        const settings: Record<string, unknown> = { roll: 0, offset: [1, 2] };
        let told = 0;
        let busy = false;
        const target = { read: () => ({ ...settings }), write: (values: Record<string, unknown>) => void Object.assign(settings, values) };
        const log = new MockFindings({ head: target, up: target, top: target }, () => busy, () => {
            told += 1;
        });
        expect(log.keep("head", "offset", "offset measured", { roll: 1.5, offset: [1, 2] }, { spot: { dx: 1, dy: 2, mm: 0.1 } })).toBe("offset measured");
        const entry = log.newest("head")!;
        expect(entry.changes).toEqual([{ target: "head", name: "roll", label: "roll, degrees", before: 0, after: 1.5 }]);
        expect(entry.undoable).toBe(true);
        busy = true;
        expect(() => log.undo(entry.id)).toThrow("under way");
        busy = false;
        const undone = log.undo(entry.id);
        expect(settings["roll"]).toBe(0);
        expect(undone.kind).toBe("undo");
        expect(() => log.undo(entry.id)).toThrow("undone already");
        settings["roll"] = 3;
        expect(log.newest("head")!.why).toContain("it changed since");
        expect(() => log.undo(undone.id)).toThrow("it changed since");
        expect(told).toBe(2);
        expect(log.list().count).toBe(2);
    });
});

describe("a camera's log of changes", () => {
    test("lists what the routines applied newest first with Undo, and an undo goes through the backend", async () => {
        const { ctx, store, backend, root } = setup();
        const fold = mountChanges(ctx, "head", "the head camera");
        root.append(fold.root);
        await settle();
        fold.render(store.get());
        expect(root.textContent).toContain("Nothing applied yet");
        await measured(backend);
        store.set({ findings: await backend.findings() });
        fold.render(store.get());
        const items = [...root.querySelectorAll(".changes-entry")];
        expect(items).toHaveLength(1);
        expect(items[0]!.textContent).toContain("camera offset measured");
        expect(items[0]!.querySelector(".changes-values")?.textContent).toContain("offset, mm:");
        const undo = [...items[0]!.querySelectorAll("button")].find((node) => node.textContent === "Undo")!;
        expect(undo.disabled).toBe(false);
        undo.click();
        await settle();
        await settle();
        fold.render(store.get());
        const after = [...root.querySelectorAll(".changes-entry")];
        const texts = after.map((node) => node.querySelector(".changes-text")?.textContent ?? "");
        expect(texts).toHaveLength(2);
        expect(texts[0]).toContain("Undone: camera offset measured");
        expect(texts[1]).toContain("camera offset measured");
        expect(after[1]!.classList.contains("undone")).toBe(true);
        expect(store.get().camera?.applied?.kind).toBe("undo");
        // The measured entry's own button is locked with why.
        const locked = [...after[1]!.querySelectorAll("button")].find((node) => node.textContent === "Undo")!;
        expect(locked.disabled).toBe(true);
        expect(locked.dataset["reason"]).toContain("undone already");
    });
});
