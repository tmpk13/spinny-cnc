import { describe, expect, test } from "bun:test";

import millText from "../../../cam/mill-3axis.toml" with { type: "text" };
import { ApiError, type Api } from "../src/api.ts";
import { activePage } from "../src/dom.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { buildCamJob, camGcode, formatValue, parseProfile, setValue, summaryOf } from "../src/mock/cam.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import { describeTool, mountCam, reportLines, sourceFields } from "../src/views/cam.ts";
import { PAGES, mountTabs, readPage, showPage } from "../src/views/tabs.ts";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
    <rect x="5" y="5" width="10" height="10" stroke="#ff0000" fill="none"/>
    <circle cx="30" cy="30" r="5" stroke="#00ff00" fill="none"/>
</svg>`;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the mock's CAM profiles", () => {
    test("the shipped mill profile reads as the backend reads it", () => {
        const profile = parseProfile(millText, "mill-3axis");
        expect(profile.kinematics).toBe("cartesian");
        expect(profile.axes.map((axis) => axis.letter)).toEqual(["X", "Y", "Z"]);
        expect(profile.axes[2]?.safe).toBe(5);
        expect(profile.operations[3]?.cutting).toMatchObject({ passes: 3, depth: 1.7, rpm: 10000, step_down: 0.6 });
        expect(profile.operations[0]?.cutting["passes"]).toBe(1);
        expect(summaryOf(profile)).toEqual({
            id: "mill-3axis", name: "3 axis mill", description: "X/Y/Z mill with a spindle, gcode out for a grbl-style controller",
            machine: null, kinematics: "cartesian", tools: ["spindle"], axes: "XYZ", operations: 3,
        });
    });

    test("a fault names the table and the key", () => {
        expect(() => parseProfile(millText.replace("depth = 1.7", "depth = 70"), "m")).toThrow("m.toml: [[operations]] outline depth must be above 0 and at most 50");
        expect(() => parseProfile(millText.replace('tool = "drill"', 'tool = "nope"'), "m")).toThrow(/\[\[operations\]\] drills tool must name a \[\[tools\]\] id: vbit, endmill, drill/);
        expect(() => parseProfile(millText.replace("safe = 5", "sofe = 5"), "m")).toThrow(/\[\[axes\]\] Z sofe is not a key here/);
        expect(() => parseProfile("name = 3\n", "m")).toThrow("m.toml: name must be a string");
    });

    test("setValue changes one line and keeps the comments", () => {
        let text = setValue(millText, ["operations", 1, "enabled"], true);
        text = setValue(text, ["post", "spinup"], 3);
        text = setValue(text, ["tools", 0, "stepover"], 0.3);
        text = setValue(text, ["name"], "Bench");
        text = setValue(text, ["operations", 3, "step_down"], null);
        expect(text).toContain("spinup = 3              # s after the spindle starts or changes speed");
        expect(text).toContain('name = "Bench"');
        expect(text.split("\n").length).toBe(millText.split("\n").length);
        const profile = parseProfile(text, "m");
        expect(profile.operations[1]?.enabled).toBe(true);
        expect(profile.tools[0]?.settings["stepover"]).toBe(0.3);
        expect(profile.operations[3]?.settings["step_down"]).toBeUndefined();
        expect(() => setValue(millText, ["operations", 9, "depth"], 1)).toThrow(/no \[\[operations\]\] table 10/);
        expect(() => setValue(millText, ["extra", "depth"], 1)).toThrow(/no \[extra\] table/);
        expect(formatValue(["G21", "G90"])).toBe('["G21", "G90"]');
        expect(formatValue(1.5)).toBe("1.5");
    });

    test("a design goes through the operations and comes out as gcode", () => {
        const mill = parseProfile(millText, "mill-3axis");
        const built = buildCamJob("0001", mill, "coupon", "board-F_Cu.gbr", "G04*", { rRate: 560, aRate: 400, tolerance: 0.005 });
        expect(built.notes[0]).toMatch(/demo coupon/);
        expect(built.job.groups.map((group) => [group.label, group.enabled, group.tool])).toEqual([
            ["isolation: loop 1 at 0.100 mm", true, "spindle"],
            ["drills: 3 holes at the bit's size", true, "spindle"],
            ["outline: board outline", true, "spindle"],
        ]);
        expect(built.job.groups[1]?.paths.every((path) => path.length === 1)).toBe(true);
        expect(built.job.groups[2]?.passes).toBe(3);
        const written = camGcode(mill, built.job);
        expect(written.filename).toBe("coupon.nc");
        expect(written.text.split("\n").slice(0, 7)).toEqual([
            "(coupon: 3 operations through 3 axis mill)",
            "(board X/Y on X=x Y=y Z=depth)",
            "G21", "G90", "G94", "G17",
            "G0 Z5.000",
        ]);
        expect(written.text).toContain("M3 S12000\nG4 P2\n");
        expect(written.text).toContain("G1 Z-0.100 F60.000");
        expect(written.text).toContain("G1 Z-1.800 F50.000");
        expect(written.text.endsWith("M5\nG0 X0.000 Y0.000\nG0 Z20.000\nM5\nM2\n")).toBe(true);
        expect(written.report.extents["Z"]).toEqual([-1.8, 20]);
        expect(written.report.warnings).toEqual([]);
    });
});

describe("the mock backend's CAM routes", () => {
    test("lists, reads, saves, patches and removes profiles", async () => {
        const backend = new MockBackend({ timers: false });
        const listed = await backend.camProfiles();
        expect(listed.profiles.map((profile) => profile.id)).toEqual(["cartesian-laser", "mill-3axis", "polar-laser"]);
        expect(listed.problems).toEqual([]);
        const read = await backend.camProfile("mill-3axis");
        expect(read.text).toBe(millText);
        await expect(backend.saveCamProfile("mill-3axis", millText.replace("depth = 1.7", "depth = 70"))).rejects.toThrow(/outline depth/);
        expect((await backend.camProfile("mill-3axis")).text).toBe(millText);
        const patched = await backend.patchCamProfile("mill-3axis", ["operations", 0, "depth"], 0.15);
        expect(patched.document.operations[0]?.cutting["depth"]).toBe(0.15);
        expect(patched.text).toContain("depth = 0.15");
        const saved = await backend.saveCamProfile("bench", millText);
        expect(saved.document.id).toBe("bench");
        expect((await backend.camProfiles()).profiles.map((p) => p.id)).toContain("bench");
        await backend.deleteCamProfile("bench");
        await expect(backend.camProfile("bench")).rejects.toThrow(ApiError);
        await expect(backend.saveCamProfile("Bad Id", millText)).rejects.toThrow(/not a profile id/);
    });

    test("makes a job from an svg through the laser profile and writes it as gcode", async () => {
        const backend = new MockBackend({ timers: false });
        const answer = await backend.camJob("cartesian-laser", [new File([SVG], "coupon.svg", { type: "image/svg+xml" })]);
        const cut = answer.job.groups.filter((group) => group.paths.length > 0);
        expect(cut.map((group) => group.label)).toEqual(["engraving: stroke #ff0000", "engraving: stroke #00ff00"]);
        expect(cut.every((group) => group.tool === "laser" && group.power === 300 && group.speed === 1200)).toBe(true);
        expect(answer.notes.some((note) => note.includes("isolation") && note.includes("not a board"))).toBe(true);
        const written = await backend.camGcode("cartesian-laser", answer.job.id);
        expect(written.text).toContain("M4 S0");
        expect(written.text).toContain("G1 X20.000 F1200.000 S300");
        const listed = await backend.jobs();
        expect(listed.find((job) => job.id === answer.job.id)?.groups[0]?.tool).toBe("laser");
        await expect(backend.camGcode("polar-laser", answer.job.id)).rejects.toThrow(/polar gcode writer/);
    });
});

/** An API that records calls on the mock. */
function recordingApi(): { api: Api; calls: { name: string; args: unknown[] }[] } {
    const calls: { name: string; args: unknown[] }[] = [];
    const backend = new MockBackend({ timers: false });
    const api = new Proxy(backend, {
        get(target, name: string) {
            const value = (target as unknown as Record<string, unknown>)[name];
            if (typeof value !== "function") {
                return value;
            }
            return (...args: unknown[]) => {
                calls.push({ name, args });
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    }) as unknown as Api;
    return { api, calls };
}

function field(root: ParentNode, label: string): HTMLInputElement | HTMLSelectElement {
    const found = root.querySelector(`[aria-label="${label}"]`);
    if (!found) {
        throw new Error(`no field ${label}`);
    }
    return found as HTMLInputElement | HTMLSelectElement;
}

function click(root: ParentNode, label: string): void {
    const found = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!found) {
        throw new Error(`no button ${label}`);
    }
    found.click();
}

describe("the CAM view", () => {
    test("shows the picked profile and edits it in place", async () => {
        const store = new Store<AppState>(initialState(true));
        const { api, calls } = recordingApi();
        const ctx = createContext(api, store);
        const root = document.createElement("section");
        const fileRoot = document.createElement("section");
        document.body.append(root, fileRoot);
        mountCam(root, ctx, fileRoot);
        await settle();
        await settle();
        const pick = field(root, "CAM profile") as HTMLSelectElement;
        expect(Array.from(pick.options).map((option) => option.value)).toEqual(["cartesian-laser", "mill-3axis", "polar-laser"]);
        pick.value = "mill-3axis";
        pick.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(root.querySelector(".cam-summary")?.textContent).toContain("gcode only");
        expect(root.querySelectorAll("table.axes tbody tr").length).toBe(3);
        expect(root.querySelectorAll("table.tools tbody tr").length).toBe(3);
        expect(root.querySelectorAll("table.operations tbody").length).toBe(4);
        const textArea = field(fileRoot, "Profile file") as unknown as HTMLTextAreaElement;
        expect(textArea.value).toBe(millText);

        calls.length = 0;
        const depth = field(root, "isolation Depth mm") as HTMLInputElement;
        expect(depth.value).toBe("0.1");
        expect(depth.classList.contains("inherited")).toBe(false);
        depth.value = "0.2";
        depth.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(calls[0]).toEqual({ name: "patchCamProfile", args: ["mill-3axis", ["operations", 0, "depth"], 0.2] });
        expect(textArea.value).toContain("depth = 0.2");
        expect((field(root, "isolation Depth mm") as HTMLInputElement).value).toBe("0.2");

        const plunge = field(root, "isolation Plunge mm/min") as HTMLInputElement;
        expect(plunge.classList.contains("inherited")).toBe(true);
        plunge.value = "";
        plunge.dispatchEvent(new Event("change"));
        await settle();
        expect(calls[1]?.args).toEqual(["mill-3axis", ["operations", 0, "plunge"], null]);

        const enabled = field(root, "clearing enabled") as HTMLInputElement;
        enabled.checked = true;
        enabled.dispatchEvent(new Event("change"));
        await settle();
        expect(calls[2]?.args).toEqual(["mill-3axis", ["operations", 1, "enabled"], true]);
        const pattern = field(root, "clearing Pattern") as HTMLSelectElement;
        pattern.value = "rings";
        pattern.dispatchEvent(new Event("change"));
        await settle();
        expect(calls[3]?.args).toEqual(["mill-3axis", ["operations", 1, "pattern"], "rings"]);

        // The text editor saves the whole file, and says what is wrong with one that does not read.
        calls.length = 0;
        textArea.value = textArea.value.replace("rpm = 12000", "rpm = -1");
        textArea.dispatchEvent(new Event("input"));
        click(fileRoot, "Save");
        await settle();
        await settle();
        expect(calls[0]?.name).toBe("saveCamProfile");
        expect(fileRoot.querySelector(".cam-status")?.textContent).toContain("[[tools]] vbit rpm must be above 0");
        click(fileRoot, "Revert");
        expect(textArea.value).not.toContain("rpm = -1");
        textArea.value = textArea.value.replace('description = "X/Y/Z mill', 'description = "My mill');
        textArea.dispatchEvent(new Event("input"));
        click(fileRoot, "Save");
        await settle();
        await settle();
        expect(fileRoot.querySelector(".cam-status")?.textContent).toBe("saved");
        expect(root.querySelector(".cam-summary")?.textContent).toContain("My mill");

        // A new profile is a copy of the text under a new id.
        calls.length = 0;
        (field(root, "New profile id") as HTMLInputElement).value = "bench";
        click(root, "New");
        await settle();
        await settle();
        expect(calls[0]?.name).toBe("saveCamProfile");
        expect(calls[0]?.args[0]).toBe("bench");
        expect((field(root, "CAM profile") as HTMLSelectElement).value).toBe("bench");

        // A board dropped on the page is a job through the profile; the export writes it.
        calls.length = 0;
        const event = new Event("drop", { cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["G04 x*"], "board-F_Cu.gbr"), new File(["M48"], "board-PTH.drl")] } });
        root.querySelector(".drop")?.dispatchEvent(event);
        for (let i = 0; i < 6; i++) {
            await settle();
        }
        expect(calls.find((call) => call.name === "camJob")?.args[0]).toBe("bench");
        expect(store.get().job?.name).toBe("board-F_Cu");
        expect(store.get().job?.groups.map((group) => group.tool)).toEqual(["spindle", "spindle", "spindle"]);
        expect(root.querySelector(".cam-notes")?.textContent).toContain("demo coupon");
        const jobPick = field(root, "Job to write") as HTMLSelectElement;
        expect(jobPick.value).toBe(store.get().job?.id ?? "");
        calls.length = 0;
        click(root, "Export gcode");
        await settle();
        await settle();
        expect(calls[0]?.name).toBe("camGcode");
        expect(root.querySelector(".cam-report")?.textContent).toContain("Lines");
        root.remove();
        fileRoot.remove();
    });

    test("the helpers describe tools, sources and reports", () => {
        expect(describeTool({ id: "v", kind: "spindle", name: "v", width: 0.2, settings: { rpm: 12000, feed: 300 } })).toBe("S 12000, feed 300");
        expect(sourceFields("clearing", "spindle")[0]?.choices).toEqual(["radial", "rings", "lines"]);
        expect(sourceFields("drills", "spindle")).toEqual([]);
        expect(sourceFields("drills", "laser")[0]?.key).toBe("marks");
        expect(reportLines({ lines: 10, cuts: 3, length_mm: 42, seconds: 90, extents: { X: [0, 10] }, warnings: [] })).toEqual([
            ["Lines", "10"], ["Cuts", "3, 42.0 mm"], ["Time", "1:30"], ["X reach", "0 to 10"],
        ]);
    });
});

describe("the tabs", () => {
    test("show one page at a time and remember the pick", () => {
        const app = document.createElement("div");
        app.id = "app";
        const nav = document.createElement("nav");
        nav.className = "tabs";
        app.append(nav);
        document.body.append(app);
        mountTabs(nav);
        expect(Array.from(nav.querySelectorAll(".tab")).map((tab) => tab.textContent)).toEqual(PAGES.map((page) => page.label));
        expect(activePage()).toBe("machine");
        click(nav, "CAM");
        expect(app.getAttribute("data-page")).toBe("cam");
        expect(activePage()).toBe("cam");
        expect(readPage()).toBe("cam");
        expect(nav.querySelector('[data-page="cam"]')?.getAttribute("aria-selected")).toBe("true");
        showPage("machine");
        expect(readPage()).toBe("machine");
        app.remove();
    });
});
