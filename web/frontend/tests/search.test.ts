import { afterEach, expect, test } from "bun:test";

import { collectFeatures, featurePath, fuzzyScore, mountSearch, rankFeatures, type Feature } from "../src/views/search.ts";

afterEach(() => {
    document.getElementById("app")?.remove();
    localStorage.removeItem("spinny.page");
});

function makeApp(): HTMLElement {
    const app = document.createElement("div");
    app.id = "app";
    app.innerHTML = `
        <nav class="tabs"><div class="tabs-tools"></div></nav>
        <main id="page-jobs" class="grid page"><div class="column">
            <section id="heightmap" class="panel" aria-label="Height map"><div class="panel-head panel-head-tools"><button class="panel-menu-button">...</button><h2>Height map</h2></div>
                <button title="probe the grid">Probe</button><button>Save map</button></section>
        </div></main>
        <main id="page-config" class="grid page"><div class="column">
            <section id="machine-file" class="panel" aria-label="Machine file"><button>Save</button></section>
        </div></main>`;
    document.body.append(app);
    return app;
}

test("letters match in order, loosely; runs and word starts count more", () => {
    expect(fuzzyScore("hm", "Height map")).not.toBeNull();
    expect(fuzzyScore("mh", "Height map")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("probe", "Probe")!).toBeGreaterThan(fuzzyScore("probe", "a p r o b e")!);
    expect(fuzzyScore("sm", "Save map")!).toBeGreaterThan(fuzzyScore("sm", "dismiss")!);
});

test("every page, panel and button is a feature, the layer's head buttons left out", () => {
    makeApp();
    const features = collectFeatures();
    const buttons = features.filter((feature) => feature.kind === "button").map((feature) => `${feature.where}: ${feature.label}`);
    expect(buttons).toEqual(["Jobs > Height map: Probe", "Jobs > Height map: Save map", "Config > Machine file: Save"]);
    expect(features.some((feature) => feature.kind === "panel" && feature.label === "Height map")).toBe(true);
    expect(features.some((feature) => feature.kind === "page" && feature.label === "Connection")).toBe(true);
});

test("the best match comes first, a tooltip word finds a button too", () => {
    makeApp();
    const features: Feature[] = collectFeatures();
    expect(rankFeatures(features, "save map")[0]?.label).toBe("Save map");
    expect(rankFeatures(features, "grid")[0]?.label).toBe("Probe");
    expect(rankFeatures(features, "zzz")).toEqual([]);
});

test("the box opens with Ctrl+K, lists matches, and Enter takes the page there", () => {
    const app = makeApp();
    mountSearch(app.querySelector(".tabs-tools") as HTMLElement);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const sheet = app.querySelector(".search-sheet") as HTMLElement;
    expect(sheet.hidden).toBe(false);
    const input = sheet.querySelector("input") as HTMLInputElement;
    input.value = "mach file";
    input.dispatchEvent(new Event("input"));
    expect(sheet.querySelector(".search-item .search-label")?.textContent).toBe("Machine file");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sheet.hidden).toBe(true);
    expect(app.getAttribute("data-page")).toBe("config");
    expect(document.getElementById("machine-file")!.classList.contains("pulse")).toBe(true);
});

test("a match's tooltip gives its whole path and what its button's tooltip says", () => {
    const app = makeApp();
    mountSearch(app.querySelector(".tabs-tools") as HTMLElement);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const input = app.querySelector(".search-sheet input") as HTMLInputElement;
    input.value = "probe";
    input.dispatchEvent(new Event("input"));
    expect((app.querySelector(".search-item") as HTMLElement).title).toBe("Jobs > Height map > Probe: probe the grid");
    const features = collectFeatures();
    expect(featurePath(features.find((feature) => feature.label === "Save map")!)).toBe("Jobs > Height map > Save map");
    expect(featurePath(features.find((feature) => feature.kind === "panel" && feature.label === "Machine file")!)).toBe("Config > Machine file");
    expect(featurePath(features.find((feature) => feature.kind === "page" && feature.label === "Jobs")!)).toBe("Jobs tab: jobs, the preview and runs");
});
