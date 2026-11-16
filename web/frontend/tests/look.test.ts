import { afterEach, expect, test } from "bun:test";
import { applyLook, LOOK_KEY, parseLook } from "../src/look.ts";
import { initialState, Store } from "../src/state.ts";
import { mountPageSettings } from "../src/views/pagesettings.ts";
import { mountPanels } from "../src/views/panels.ts";
import { accentOf, mountTabs, PAGES } from "../src/views/tabs.ts";

afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("spinny.page");
    localStorage.removeItem(LOOK_KEY);
    document.documentElement.removeAttribute("data-colors");
});

test("the look reads safely and goes on the root as attributes, colors on unless turned off", () => {
    expect(parseLook(null)).toEqual({ fonts: "page", motion: "on", colors: "on" });
    expect(parseLook("{\"colors\":\"off\",\"motion\":\"off\"}")).toEqual({ fonts: "page", motion: "off", colors: "off" });
    expect(parseLook("not json").colors).toBe("on");
    const root = document.createElement("div");
    applyLook({ fonts: "page", motion: "on", colors: "off" }, root);
    expect(root.getAttribute("data-colors")).toBe("off");
    applyLook({ fonts: "page", motion: "on", colors: "on" }, root);
    expect(root.hasAttribute("data-colors")).toBe(false);
});

test("every page has a color of its own, which its tab and its page carry", () => {
    const accents = PAGES.map((page) => page.accent);
    expect(new Set(accents).size).toBe(PAGES.length);
    expect(accentOf("job")).toBe("var(--orange)");
    expect(accentOf("nowhere")).toBe("var(--accent)");
    const page = document.createElement("main");
    page.id = "page-job";
    const bar = document.createElement("nav");
    document.body.append(page, bar);
    mountTabs(bar, new Store(initialState(true)));
    expect(bar.querySelector<HTMLElement>('.tab[data-page="run"]')!.style.getPropertyValue("--page-accent")).toBe("var(--green)");
    expect(page.style.getPropertyValue("--page-accent")).toBe("var(--orange)");
});

test("the page settings turn the colors off and on", () => {
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
    const tools = document.createElement("div");
    app.append(tools);
    mountPageSettings(tools, mountPanels(app));
    tools.querySelector<HTMLButtonElement>(".tabs-gear")!.click();
    const box = Array.from(tools.querySelectorAll("label.check")).find((label) => label.textContent?.includes("Colors for tabs and panels"))!.querySelector("input")!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(document.documentElement.getAttribute("data-colors")).toBe("off");
    expect(parseLook(localStorage.getItem(LOOK_KEY)).colors).toBe("off");
    const again = Array.from(tools.querySelectorAll("label.check")).find((label) => label.textContent?.includes("Colors for tabs and panels"))!.querySelector("input")!;
    again.checked = true;
    again.dispatchEvent(new Event("change"));
    expect(document.documentElement.hasAttribute("data-colors")).toBe(false);
});
