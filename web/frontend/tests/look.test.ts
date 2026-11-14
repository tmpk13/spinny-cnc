import { afterEach, expect, test } from "bun:test";
import { applyLook, parseLook } from "../src/look.ts";
import { initialState, Store } from "../src/state.ts";
import { accentOf, mountTabs, PAGES } from "../src/views/tabs.ts";

afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("spinny.page");
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
    expect(accentOf("jobs")).toBe("var(--orange)");
    expect(accentOf("nowhere")).toBe("var(--accent)");
    const page = document.createElement("main");
    page.id = "page-jobs";
    const bar = document.createElement("nav");
    document.body.append(page, bar);
    mountTabs(bar, new Store(initialState(true)));
    expect(bar.querySelector<HTMLElement>('.tab[data-page="pnp"]')!.style.getPropertyValue("--page-accent")).toBe("var(--violet)");
    expect(page.style.getPropertyValue("--page-accent")).toBe("var(--orange)");
});
