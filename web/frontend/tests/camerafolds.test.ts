import { afterEach, expect, test } from "bun:test";
import { foldAsPanel } from "../src/dom.ts";
import { mountCameraControls, placeFolds } from "../src/views/cameracontrols.ts";
import { setup, settle } from "./harness.ts";

const realObserver = globalThis.IntersectionObserver;

afterEach(() => {
    globalThis.IntersectionObserver = realObserver;
    document.body.replaceChildren();
    for (const key of ["spinny.test-fold", "spinny.camera-controls.head.open", "spinny.camera-sight.head.open"]) {
        localStorage.removeItem(key);
    }
});

test("a fold made a panel: its summary is the head, its words the title, open or folded kept", () => {
    const section = document.createElement("section");
    const fold = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Picture controls";
    fold.append(summary, document.createElement("div"));
    foldAsPanel(section, fold, "spinny.test-fold");
    expect(section.firstElementChild).toBe(fold);
    expect(fold.classList.contains("panel-fold")).toBe(true);
    expect(summary.classList.contains("panel-head")).toBe(true);
    expect(summary.querySelector("h2")?.textContent).toBe("Picture controls");
    // Open at first; folded, it stays folded next time.
    expect(fold.open).toBe(true);
    fold.open = false;
    fold.dispatchEvent(new Event("toggle"));
    expect(localStorage.getItem("spinny.test-fold")).toBe("0");
    const again = document.createElement("details");
    again.append(document.createElement("summary"));
    foldAsPanel(document.createElement("section"), again, "spinny.test-fold");
    expect(again.open).toBe(false);
});

test("a camera's folds go to their panels when given, else back to the camera's own panel", () => {
    const controls = document.createElement("details");
    const sight = document.createElement("details");
    expect(placeFolds(undefined, "head", controls, sight)).toEqual([controls, sight]);
    const panels = { controls: document.createElement("section"), sight: document.createElement("section") };
    expect(placeFolds(panels, "head", controls, sight)).toEqual([]);
    expect(panels.controls.firstElementChild).toBe(controls);
    expect(panels.sight.firstElementChild).toBe(sight);
});

test("the controls fold asks the camera and measures only while open and on the screen", async () => {
    let report: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    globalThis.IntersectionObserver = class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
            report = callback;
        }
        observe(): void {}
        disconnect(): void {}
    } as unknown as typeof IntersectionObserver;
    const { ctx, calls } = setup();
    const fold = mountCameraControls(ctx, "head", "the head camera");
    document.body.append(fold.root);
    // Open but behind its stack: nothing asked.
    let shown = false;
    fold.root.checkVisibility = () => shown;
    report!([{ isIntersecting: false }]);
    fold.root.open = true;
    fold.root.dispatchEvent(new Event("toggle"));
    await settle();
    expect(calls.filter((call) => call.name === "cameraControls").length).toBe(0);
    // Brought to the front: the list is read, once.
    shown = true;
    report!([{ isIntersecting: true }]);
    await settle();
    expect(calls.filter((call) => call.name === "cameraControls").length).toBe(1);
    report!([{ isIntersecting: false }]);
    report!([{ isIntersecting: true }]);
    await settle();
    expect(calls.filter((call) => call.name === "cameraControls").length).toBe(1);
    // Folded and opened again: read again.
    fold.root.open = false;
    fold.root.dispatchEvent(new Event("toggle"));
    fold.root.open = true;
    fold.root.dispatchEvent(new Event("toggle"));
    await settle();
    expect(calls.filter((call) => call.name === "cameraControls").length).toBe(2);
});

test("a control an automatic one has taken over is left out and named under the list, unless a value is kept for it", async () => {
    const { ctx, api } = setup();
    const fold = mountCameraControls(ctx, "head", "the head camera");
    document.body.append(fold.root);
    await fold.reload();
    await settle();
    const names = (): (string | null)[] => Array.from(fold.root.querySelectorAll(".camera-control-name")).map((name) => name.textContent);
    const listed = (await api.cameraControls("head")).controls;
    const idle = listed.filter((control) => control.inactive).map((control) => control.name.replace(/_/g, " "));
    expect(idle.length).toBeGreaterThan(0);
    // What can be set now is listed; what the camera sets by itself is not.
    expect(names()).toEqual(listed.filter((control) => !control.inactive).map((control) => control.name.replace(/_/g, " ")));
    const line = fold.root.querySelector(".camera-controls-idle")!;
    expect(line.textContent).toBe(`Set by the camera while an automatic control is on, and shown here once it is off: ${idle.join(", ")}.`);
    // A value kept for one of them brings it back, so the value can be forgotten.
    const kept = listed.find((control) => control.inactive)!;
    await api.setCameraControls("head", { [kept.name]: kept.default });
    await fold.reload();
    await settle();
    const after = (await api.cameraControls("head")).controls.find((control) => control.name === kept.name)!;
    expect(after.kept).not.toBeNull();
    expect(names()).toContain(kept.name.replace(/_/g, " "));
    fold.root.remove();
});
