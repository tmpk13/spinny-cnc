import { afterEach, describe, expect, test } from "bun:test";

import { ActionLog, actionLine, labelOf, panelOf, recordActions, recordingFetch, recordPresses, reportAction, type Action } from "../src/actions.ts";
import { HttpApi } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { checkedLink, MockReports } from "../src/mock/reports.ts";
import { copyPage, rootStyle, shotScale, svgOf } from "../src/pageshot.ts";
import { githubRepository, issueUrl, MAX_ISSUE_URL, reportTitle, type BugReport } from "../src/reports.ts";
import { pushToast, Store, initialState, type AppState } from "../src/state.ts";
import { mountBugReport, whereReportsGo } from "../src/views/bugreport.ts";
import { linkSays, mountReportLink } from "../src/views/reportlink.ts";
import { showPage } from "../src/views/tabs.ts";

const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("spinny.page");
});

describe("what was done lately", () => {
    test("the ring keeps the newest, counts an action repeated straight after, and cuts long words", () => {
        let now = 1000;
        const log = new ActionLog(3, () => now);
        log.push({ kind: "page", page: "jobs" });
        now = 2000;
        log.push({ kind: "request", method: "GET", path: "/api/jobs", status: 200, ms: 4 });
        now = 3000;
        log.push({ kind: "request", method: "GET", path: "/api/jobs", status: 200, ms: 9 });
        expect(log.list()).toEqual([
            { at: 1000, kind: "page", page: "jobs" },
            { at: 3000, kind: "request", method: "GET", path: "/api/jobs", status: 200, ms: 9, count: 2 },
        ]);
        log.push({ kind: "toast", level: "error", text: `${"x".repeat(400)}\n  more` });
        log.push({ kind: "press", label: "Run", panel: "Run", page: "jobs" });
        const kept = log.list();
        expect(kept.map((action) => action.kind)).toEqual(["request", "toast", "press"]);
        expect(kept[1]!.text).toHaveLength(300);
        expect(kept[1]!.text!.endsWith("...")).toBe(true);
    });

    test("an action is written for the report with its time spelled out, and as a line", () => {
        const at = new Date(2026, 10, 13, 12, 0, 1).getTime();
        const action: Action = { at, kind: "request", method: "POST", path: "/api/jobs/a1/run", status: 409, ms: 12, count: 2 };
        expect(reportAction(action)).toEqual({ at: new Date(at).toISOString(), kind: "request", method: "POST", path: "/api/jobs/a1/run", status: 409, ms: 12, count: 2 });
        expect(actionLine(action)).toBe("12:00:01 POST /api/jobs/a1/run 409 12 ms (x2)");
        expect(actionLine({ at, kind: "press", label: "Run", panel: "Run", page: "jobs" })).toBe('12:00:01 press "Run" (Run, jobs)');
        expect(actionLine({ at, kind: "page", page: "plot" })).toBe("12:00:01 page plot");
        expect(actionLine({ at, kind: "toast", level: "error", text: "connect first" })).toBe("12:00:01 toast error: connect first");
        expect(actionLine({ at, kind: "error", text: "boom" })).toBe("12:00:01 error: boom");
    });

    test("a press is recorded with its label, its panel and the page, from the capture phase", () => {
        const app = document.createElement("div");
        app.id = "app";
        app.setAttribute("data-page", "jobs");
        app.innerHTML = `<header><button class="stop">Stop</button></header>
            <section class="panel" id="run" aria-label="Run"><button id="go"><span>Run</span></button><label><input type="checkbox" id="box"> Follow the map</label></section>`;
        document.body.append(app);
        const log = new ActionLog();
        recordPresses(document, log);
        // A handler that stops the click does not hide it.
        app.querySelector("#go")!.addEventListener("click", (event) => event.stopPropagation());
        app.querySelector<HTMLElement>("#go span")!.click();
        app.querySelector<HTMLElement>(".stop")!.click();
        app.querySelector<HTMLInputElement>("#box")!.click();
        expect(log.list().map(({ label, panel, page }) => [label, panel, page])).toEqual([
            ["Run", "Run", "jobs"],
            ["Stop", "top bar", "jobs"],
            ["Follow the map (on)", "Run", "jobs"],
        ]);
        expect(labelOf(app.querySelector("#go")!)).toBe("Run");
        expect(panelOf(document.body)).toBe("");
    });

    test("requests are recorded with method, path without the query, status and time; never a body", async () => {
        const log = new ActionLog();
        let clock = 0;
        const fetchFn = recordingFetch(async (url) => {
            clock += 7;
            if (url.includes("down")) {
                throw new TypeError("network down");
            }
            return new Response("{}", { status: url.includes("jobs") ? 200 : 409 });
        }, log, () => clock);
        await fetchFn("http://host/api/jobs?x=1", { method: "PUT", body: JSON.stringify({ secret: "s" }) });
        await fetchFn("http://host/api/run/stop", { method: "post" });
        await expect(fetchFn("http://host/api/down")).rejects.toThrow("network down");
        expect(log.list().map(({ method, path, status, ms }) => [method, path, status, ms])).toEqual([
            ["PUT", "/api/jobs", 200, 7],
            ["POST", "/api/run/stop", 409, 7],
            ["GET", "/api/down", 0, 7],
        ]);
        expect(JSON.stringify(log.list())).not.toContain("secret");
    });

    test("toasts and pages shown are recorded from the store and the tabs", () => {
        const app = document.createElement("div");
        app.id = "app";
        document.body.append(app);
        const store = new Store<AppState>(initialState(true));
        const log = new ActionLog();
        recordActions(store, log);
        pushToast(store, "error", "connect first");
        store.set({ toasts: [...store.get().toasts] });
        showPage("plot");
        expect(log.list().filter((action) => action.kind !== "press").map(({ kind, text, page }) => [kind, text ?? page])).toEqual([
            ["toast", "connect first"],
            ["page", "plot"],
        ]);
    });
});

describe("the page's copy for a screenshot", () => {
    test("fields keep what is typed, what is hidden and other pages are left out, canvases and pictures are listed", () => {
        const app = document.createElement("div");
        app.id = "app";
        app.setAttribute("data-page", "jobs");
        app.innerHTML = `<main id="page-jobs" class="page">
                <input id="typed" value="1">
                <input id="key" type="password">
                <input id="tick" type="checkbox">
                <textarea id="area"></textarea>
                <select id="pick"><option>a</option><option>b</option></select>
                <p hidden>gone</p><p class="hidden">gone too</p><p data-no-shot>left out</p>
                <canvas id="paint"></canvas><img id="pic" src="data:image/png;base64,AAAA">
            </main>
            <main id="page-plot" class="page"><p>another page</p></main>`;
        document.body.append(app);
        (app.querySelector("#typed") as HTMLInputElement).value = "25.4/2";
        (app.querySelector("#key") as HTMLInputElement).value = "hunter2";
        (app.querySelector("#tick") as HTMLInputElement).checked = true;
        (app.querySelector("#area") as HTMLTextAreaElement).value = "a note";
        (app.querySelector("#pick") as HTMLSelectElement).selectedIndex = 1;
        const copy = copyPage(document);
        const html = copy.body.innerHTML;
        expect(copy.body.querySelector("#typed")!.getAttribute("value")).toBe("25.4/2");
        expect(copy.body.querySelector("#key")!.getAttribute("value")).toBe("");
        expect(copy.body.querySelector("#tick")!.hasAttribute("checked")).toBe(true);
        expect(copy.body.querySelector("#area")!.textContent).toBe("a note");
        expect(Array.from(copy.body.querySelectorAll("#pick option")).map((option) => option.hasAttribute("selected"))).toEqual([false, true]);
        expect(html).not.toContain("gone");
        expect(html).not.toContain("left out");
        expect(html).not.toContain("another page");
        expect(copy.canvases.map(({ from }) => from.id)).toEqual(["paint"]);
        expect(copy.images.map(({ from }) => from.id)).toEqual(["pic"]);
        // The page itself is not touched.
        expect(app.querySelector("#typed")!.getAttribute("value")).toBe("1");
    });

    test("the SVG holds the copy in an XHTML document with the stylesheet, its text escaped for XML", () => {
        const body = document.createElement("body");
        body.innerHTML = `<p class="x">a &amp; b</p>`;
        const svg = svgOf(body, ".x > b { content: \"<\"; }", "--font: \"Segoe UI\";", 800, 600, { x: 0, y: 40 });
        expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" style="--font: &quot;Segoe UI&quot;;">`)).toBe(true);
        expect(svg).toContain(`<foreignObject x="0" y="0" width="100%" height="100%"><html xmlns="http://www.w3.org/1999/xhtml"`);
        expect(svg).toContain(".x &gt; b { content: \"&lt;\"; }");
        expect(svg).toContain("a &amp; b");
        expect(svg).toContain("top: -40px");
        expect(new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror")).toBeNull();
    });

    test("the root's custom properties are taken as they are now", () => {
        document.documentElement.style.setProperty("--bg", "#eee8d5");
        try {
            expect(rootStyle(":root { --bg: var(--base2); --unset: 1px; }", document.documentElement)).toContain("--bg: #eee8d5;");
        } finally {
            document.documentElement.style.removeProperty("--bg");
        }
    });

    test("a screenshot is drawn at the screen's scale, at most 2 and at most four million pixels", () => {
        expect(shotScale(1440, 900, 1)).toBe(1);
        expect(shotScale(400, 800, 3)).toBe(2);
        expect(shotScale(2560, 1440, 2)).toBeCloseTo(Math.sqrt(4_000_000 / (2560 * 1440)), 6);
    });
});

describe("reports and their GitHub page", () => {
    test("GitHub repositories and titles", () => {
        expect(githubRepository("https://github.com/tmpk13/spinny-cnc.git")).toEqual(["tmpk13", "spinny-cnc"]);
        expect(githubRepository("https://github.com/tmpk13/spinny-cnc/issues/new")).toEqual(["tmpk13", "spinny-cnc"]);
        expect(githubRepository("https://github.com/tmpk13")).toBeNull();
        expect(githubRepository("https://example.com/a/b")).toBeNull();
        expect(reportTitle("\n Run did nothing \nmore")).toBe("Run did nothing");
        expect(reportTitle(" ")).toBe("Bug report");
        expect(reportTitle("y".repeat(100))).toHaveLength(82);
    });

    test("the issue page keeps the newest actions that fit, and cuts a text too long for any", () => {
        const many = Array.from({ length: 400 }, (_, n) => ({ at: "2026-11-13T12:00:00.000Z", kind: "request", method: "GET", path: `/api/jobs/${String(n).padStart(4, "0")}`, status: 200, ms: 3 }));
        const url = issueUrl("o", "r", "Run did nothing", "Run did nothing", ["Page: jobs"], many);
        expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
        const body = new URL(url).searchParams.get("body")!;
        expect(body).toContain("/api/jobs/0399");
        expect(body).not.toContain("/api/jobs/0000");
        const long = new URL(issueUrl("o", "r", "t", "word ".repeat(3000), [], many)).searchParams.get("body")!;
        expect(long).toContain("(cut here: the whole text is in report.txt)");
        expect(long).not.toContain("What was done lately");
    });

    test("the mock keeps reports, answers a GitHub link's page and sends nothing anywhere", () => {
        const reports = new MockReports(() => new Date(2026, 10, 13, 12, 0, 0));
        const report: BugReport = { text: "Run did nothing", page: "jobs", address: "", browser: "Test", window: "800 x 600", actions: null, screenshot: new Blob(["png"]) };
        const first = reports.save(report);
        expect(first).toEqual({ id: "20261113-120000-000", folder: "var/reports/20261113-120000-000", files: ["report.txt", "screenshot.png"], link: null });
        expect(reports.save(report).id).toBe("20261113-120000-001");
        reports.setLink("https://github.com/o/r");
        const github = reports.save(report).link;
        expect(github?.kind).toBe("github");
        expect(new URL(github!.url).searchParams.get("body")).toContain("var/reports/20261113-120000-002/screenshot.png: attach it here.");
        expect(reports.setLink("https://hooks.example/bugs")).toEqual({ link: "https://hooks.example/bugs", kind: "post" });
        expect(reports.save(report).link).toEqual({ kind: "post", url: "https://hooks.example/bugs", taken: false, status: null, detail: "the mock sends nothing anywhere" });
        expect(() => reports.save({ ...report, text: "  " })).toThrow("say what happened");
        expect(() => checkedLink("ftp://x")).toThrow("http or https");
        expect(() => checkedLink("https://a b")).toThrow("without spaces");
        expect(checkedLink("  ")).toBe("");
    });

    test("HttpApi sends a report as a form, the screenshot as a file, and the link as JSON", async () => {
        const calls: [string, string, unknown][] = [];
        const api = new HttpApi("http://host", async (url, init) => {
            let body: unknown = null;
            if (init?.body instanceof FormData) {
                const fields: Record<string, unknown> = {};
                init.body.forEach((value, key) => {
                    fields[key] = value instanceof File ? `file ${value.name}` : value;
                });
                body = fields;
            } else if (typeof init?.body === "string") {
                body = JSON.parse(init.body);
            }
            calls.push([init?.method ?? "GET", url.replace("http://host", ""), body]);
            return new Response("{}", { status: 200 });
        });
        await api.saveReport({ text: "t", page: "jobs", address: "a", browser: "b", window: "1 x 2", actions: [{ at: "x", kind: "page", page: "jobs" }], screenshot: new Blob(["png"], { type: "image/png" }) });
        await api.saveReport({ text: "t", page: "", address: "", browser: "", window: "", actions: null, screenshot: null });
        await api.reportSettings();
        await api.setReportLink("https://github.com/o/r");
        expect(calls).toEqual([
            ["POST", "/api/reports", { text: "t", page: "jobs", address: "a", browser: "b", window: "1 x 2", actions: JSON.stringify([{ at: "x", kind: "page", page: "jobs" }]), screenshot: "file screenshot.png" }],
            ["POST", "/api/reports", { text: "t", page: "", address: "", browser: "", window: "" }],
            ["GET", "/api/reports/settings", null],
            ["PUT", "/api/reports/settings", { link: "https://github.com/o/r" }],
        ]);
    });
});

describe("the bug report dialog", () => {
    function mount(shoot: () => Promise<Blob> = async () => new Blob(["png"], { type: "image/png" })) {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const tools = document.createElement("div");
        const gear = document.createElement("button");
        gear.className = "tabs-gear";
        tools.append(gear);
        document.body.append(tools);
        const log = new ActionLog();
        log.push({ kind: "page", page: "jobs" });
        log.push({ kind: "press", label: "Run", panel: "Run", page: "jobs" });
        const opened: string[] = [];
        const bug = mountBugReport(tools, ctx, { shoot, log, openTab: (url) => {
            opened.push(url);
            return true;
        } });
        return { backend, store, tools, gear, bug, opened };
    }

    function press(root: ParentNode, label: string): void {
        const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label);
        if (!found) {
            throw new Error(`no button ${label}`);
        }
        found.click();
    }

    test("the bug sits before the gear and opens a dialog with the screenshot and what was done lately", async () => {
        const { gear, bug } = mount();
        expect(gear.previousElementSibling).toBe(bug.button);
        expect(bug.button.title).toBe("report a bug, with a screenshot");
        bug.button.click();
        await settle();
        const dialog = document.querySelector<HTMLDialogElement>("dialog.bug-dialog")!;
        expect(dialog.open).toBe(true);
        expect(document.activeElement).toBe(dialog.querySelector("textarea"));
        expect(dialog.querySelector(".bug-shot img")).not.toBeNull();
        expect(dialog.textContent).toContain("Include what was done lately (2)");
        expect(dialog.querySelector(".bug-actions-list")!.textContent).toContain('press "Run" (Run, jobs)');
        expect(dialog.textContent).toContain("No report link is set (Config tab).");
    });

    test("Save asks for words first, then keeps the report and says where", async () => {
        const { backend, bug } = mount();
        const dialog = bug.open();
        await settle();
        press(dialog, "Save");
        await settle();
        expect(dialog.querySelector(".bug-problem")!.textContent).toBe("Say what happened first.");
        dialog.querySelector("textarea")!.value = "Run did nothing";
        press(dialog, "Save");
        await settle();
        expect(dialog.querySelector('[role="status"]:not(.bug-problem)')!.textContent).toMatch(/^Saved in var\/reports\/\d{8}-\d{6}-000\./);
        const kept = (backend as unknown as { reportDesk: MockReports }).reportDesk.kept;
        const [entry] = [...kept.values()];
        expect(entry!.files).toEqual(["report.txt", "screenshot.png", "actions.json"]);
        expect(entry!.report.actions!.map((action) => action["kind"])).toEqual(["page", "press"]);
        press(dialog, "Close");
        expect(document.querySelector("dialog.bug-dialog")).toBeNull();
    });

    test("a GitHub link opens its new issue; boxes left unticked leave the screenshot and the actions out", async () => {
        const { backend, bug, opened } = mount();
        await backend.setReportLink("https://github.com/o/r");
        const dialog = bug.open();
        await settle();
        expect(dialog.textContent).toContain("then opened as a new issue in o/r on GitHub.");
        dialog.querySelector("textarea")!.value = "Preview stays blank";
        for (const box of Array.from(dialog.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) {
            box.checked = false;
        }
        press(dialog, "Save");
        await settle();
        expect(opened).toHaveLength(1);
        expect(opened[0]).toStartWith("https://github.com/o/r/issues/new?title=Preview%20stays%20blank&body=");
        expect(dialog.querySelector("a.btn")!.getAttribute("href")).toBe(opened[0]!);
        expect(dialog.textContent).not.toContain("Attach");
        const [entry] = [...(backend as unknown as { reportDesk: MockReports }).reportDesk.kept.values()];
        expect(entry!.files).toEqual(["report.txt"]);
    });

    test("words typed wait for the next report when it is closed unsaved; a failed screenshot says why", async () => {
        const { bug } = mount(async () => {
            throw new Error("this browser gives no canvas to draw on");
        });
        const dialog = bug.open();
        await settle();
        expect(dialog.querySelector(".bug-shot")!.textContent).toBe("No screenshot: this browser gives no canvas to draw on.");
        const box = dialog.querySelector<HTMLInputElement>("input[type=checkbox]")!;
        expect(box.checked).toBe(false);
        expect(box.disabled).toBe(true);
        dialog.querySelector("textarea")!.value = "half a report";
        press(dialog, "Cancel");
        await settle();
        expect(document.querySelector("dialog.bug-dialog")).toBeNull();
        expect(bug.open().querySelector("textarea")!.value).toBe("half a report");
    });

    test("what the dialog and the Config panel say of the link", () => {
        expect(whereReportsGo({ link: "", kind: null })).toBe("Kept on the backend in var/reports. No report link is set (Config tab).");
        expect(whereReportsGo({ link: "https://hooks.example/b", kind: "post" })).toBe("Kept on the backend in var/reports, and posted to https://hooks.example/b.");
        expect(linkSays({ link: "", kind: null })).toBe("Off: reports are only kept on the backend.");
        expect(linkSays({ link: "https://github.com/o/r", kind: "github" })).toBe("A report opens a new issue in o/r on GitHub, filled in.");
    });

    test("the Config panel keeps the link and refuses one that is not an address", async () => {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const root = document.createElement("section");
        document.body.append(root);
        const panel = mountReportLink(root, ctx);
        await panel.settled();
        expect(root.querySelector('[role="status"]')!.textContent).toBe("Off: reports are only kept on the backend.");
        const field = root.querySelector<HTMLInputElement>(".report-link")!;
        field.value = "https://github.com/o/r/";
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await settle();
        expect((await backend.reportSettings()).link).toBe("https://github.com/o/r/");
        expect(root.querySelector('[role="status"]')!.textContent).toBe("A report opens a new issue in o/r on GitHub, filled in.");
        field.value = "ftp://nowhere";
        press(root, "Save");
        await settle();
        expect(store.get().toasts.at(-1)?.text).toContain("http or https");
        expect((await backend.reportSettings()).link).toBe("https://github.com/o/r/");
    });
});
