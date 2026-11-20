// Each camera's picture a second time on the Cameras page, beside its
// settings: the same camera's frames, a panel and a title of its own, its
// own kept height and switches, and no search box.

import { afterEach, describe, expect, test } from "bun:test";

import { cameraViews, viewPanels } from "../src/views/areaviews.ts";
import { mountCameraViews, topCenter } from "../src/views/camview.ts";
import type { AppState } from "../src/state.ts";
import { mountVision } from "../src/views/vision.ts";
import { click, findButton, settle, setup } from "./harness.ts";

function section(): HTMLElement {
    const node = document.createElement("section");
    document.body.append(node);
    return node;
}

afterEach(() => {
    for (const key of ["up", "up.setup", "top", "top.setup", "head", "head.setup"]) {
        localStorage.removeItem(`spinny.picture.${key}.turn`);
    }
});

describe("the Cameras page's views", () => {
    test("each camera's view leads with its picture, its settings beside it", () => {
        const views = cameraViews();
        expect(viewPanels(views[0]!)).toEqual(["camera-picture", "camera", "camera-controls", "camera-sight", "camera-changes"]);
        expect(viewPanels(views[1]!)).toEqual(["pnp-camera-picture", "pnp-camera", "pnp-nozzle", "pnp-camera-controls", "pnp-camera-sight", "pnp-camera-changes"]);
        expect(viewPanels(views[2]!)).toEqual(["pnp-top-picture", "pnp-top", "pnp-top-controls", "pnp-top-sight", "pnp-top-changes"]);
        // The picture is the work: the first column, and the wider one.
        for (const view of views.slice(0, 3)) {
            expect(view.columns[0]).toHaveLength(1);
            expect(view.cols).toStartWith("minmax(0, 3fr)");
        }
    });

    test("the page's markup has a picture panel a camera, and every picture's panel is marked as one", async () => {
        const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const id of ["camera-picture", "pnp-camera-picture", "pnp-top-picture"]) {
            expect(doc.querySelector(`#pane-setup #page-cameras #${id}.picture-panel`)).not.toBeNull();
        }
        for (const id of ["camera-view", "pnp-view", "pnp-top-view"]) {
            expect(doc.querySelector(`#pane-use #page-run #${id}.picture-panel`)).not.toBeNull();
        }
        // The top camera's are a G-code machine's: away until one is connected.
        expect(doc.querySelector("#pnp-top-picture")!.classList.contains("hidden")).toBe(true);
    });
});

describe("the head camera's picture beside its settings", () => {
    test("shows the same camera in a panel of its own, with no start of its own and no search box", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        await ctx.refreshState();
        await ctx.refreshCamera();
        const viewRoot = section();
        const setupRoot = section();
        const panel = mountVision(root, ctx, viewRoot, undefined, setupRoot);
        try {
            expect(viewRoot.querySelector("h2")?.textContent).toBe("Head camera view");
            expect(setupRoot.querySelector("h2")?.textContent).toBe("Head camera picture");
            const run = viewRoot.querySelector("img.picture-img") as HTMLImageElement;
            const beside = setupRoot.querySelector("img.picture-img") as HTMLImageElement;
            expect(beside).not.toBe(run);
            expect(beside.getAttribute("src")).toBeNull();
            // Stopped, it says where the camera is started: its settings' panel, beside it.
            const empty = setupRoot.querySelector(".camera-view-empty")!;
            expect(empty.textContent).toBe("The camera is not running: Start is in its panel.");
            expect(empty.classList.contains("hidden")).toBe(false);
            expect(setupRoot.querySelector(".picture-actions")).toBeNull();
            // The box a board search keeps to is drawn on the picture the search is run from.
            expect(viewRoot.querySelector(".picture-box-line")?.textContent).not.toBe("");
            expect(setupRoot.querySelector(".picture-box-line")?.textContent ?? "").toBe("");
            // Started from the settings' panel, both pictures show the camera.
            Array.from(root.querySelectorAll("button")).find((press) => press.textContent === "Start" && !press.hidden)!.click();
            await settle();
            await settle();
            expect(store.get().camera?.running).toBe(true);
            expect(run.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
            expect(beside.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
            expect(empty.classList.contains("hidden")).toBe(true);
            // What it keeps is its own: a turn here leaves the Run area's picture as it was.
            click(setupRoot, "Turn");
            expect(localStorage.getItem("spinny.picture.head.setup.turn")).toBe("3");
            expect(localStorage.getItem("spinny.picture.head.turn")).toBeNull();
        } finally {
            panel.stop();
        }
    });
});

describe("the pick and place cameras' pictures beside their settings", () => {
    test("mount a second time, the top camera's shown with a G-code machine only", async () => {
        const { store, ctx, backend } = setup();
        const roots = { bottom: section(), top: section(), setup: { bottom: section(), top: section() } };
        const views = mountCameraViews(roots, ctx);
        try {
            expect(roots.bottom.querySelector("h2")?.textContent).toBe("Bottom camera view");
            expect(roots.setup.bottom.querySelector("h2")?.textContent).toBe("Bottom camera picture");
            expect(roots.setup.top.querySelector("h2")?.textContent).toBe("Top camera picture");
            // A picture each: four in all, the views answered being the Run area's.
            const pictures = [roots.bottom, roots.top, roots.setup.bottom, roots.setup.top].map((root) => root.querySelector("img.picture-img"));
            expect(new Set(pictures).size).toBe(4);
            expect(roots.bottom.contains(views.bottom.root)).toBe(true);
            expect(roots.top.contains(views.top.root)).toBe(true);
            // With no G-code machine the top camera's panels are away, both of them.
            expect(roots.top.classList.contains("hidden")).toBe(true);
            expect(roots.setup.top.classList.contains("hidden")).toBe(true);
            expect(roots.setup.bottom.classList.contains("hidden")).toBe(false);
            store.set({ snapshot: await backend.connect("/dev/ttyACM1", "opulo-lumen-rev5") });
            await ctx.refreshPlacing();
            await settle();
            expect(roots.top.classList.contains("hidden")).toBe(false);
            expect(roots.setup.top.classList.contains("hidden")).toBe(false);
            // The nozzle's box is drawn on either; the search box only where the search is run.
            expect(findButton(roots.setup.top, "Nozzle box").title).not.toBe("");
            expect(roots.top.querySelector(".picture-box-line")?.textContent).not.toBe("");
            expect(roots.setup.top.querySelector(".picture-box-line")?.textContent ?? "").toBe("");
            // Stopped, each says so; the one beside the settings says where Start is.
            expect(roots.top.querySelector(".camera-view-empty")?.textContent).toBe("The top camera is not running.");
            expect(roots.setup.top.querySelector(".camera-view-empty")?.textContent).toBe("The top camera is not running: Start is in its panel.");
            // What each keeps is its own.
            click(roots.setup.bottom, "Turn");
            expect(localStorage.getItem("spinny.picture.up.setup.turn")).toBe("3");
            expect(localStorage.getItem("spinny.picture.up.turn")).toBeNull();
        } finally {
            views.bottom.stop();
            views.top.stop();
        }
    });
});

describe("the top camera's picture center", () => {
    test("is the head's place plus the offset in use; with none known the head's own place, as the backend's looks take it", () => {
        const state = (offset: [number, number] | null, fileOffset: [number, number] | null): AppState => ({
            placing: { top: { offset }, document: { top: fileOffset === null ? {} : { offset: fileOffset } }, position: { x: 10, y: 20 } },
        }) as unknown as AppState;
        expect(topCenter(state([1, 2], [5, 6]))).toEqual([11, 22]);
        expect(topCenter(state(null, [5, 6]))).toEqual([15, 26]);
        // No offset measured and none in the machine file: the backend goes
        // by 0, 0 and the places are the camera's own, so the board a look
        // found and a box drawn are drawn about the head's own place.
        expect(topCenter(state(null, null))).toEqual([10, 20]);
        expect(topCenter({ placing: { top: { offset: null }, document: null, position: {} } } as unknown as AppState)).toBeNull();
    });
});
