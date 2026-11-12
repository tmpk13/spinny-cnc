import { describe, expect, test } from "bun:test";

import { HttpApi } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import type { UpdateState } from "../src/types.ts";
import { mountVersion, versionLines } from "../src/views/version.ts";

const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

const RELEASE: UpdateState = {
    kind: "release", version: "0.1.0", platform: "x86_64-linux", root: "/opt/spinny/spinny-0.1.0-x86_64-linux", link: "/opt/spinny/spinny",
    latest: null, status: null, checked: null, state: "idle", done: 0, total: 0, error: null, installed: null, previous: null,
};

describe("version panel", () => {
    test("the lines say what is installed, what GitHub has, and how an update goes", () => {
        expect(versionLines({ ...RELEASE, kind: "checkout", platform: null, root: null, link: null }).lines).toEqual([
            "0.1.0, a checkout of the repository: it updates with git (git pull), not from the releases.",
        ]);
        expect(versionLines(RELEASE).lines).toEqual(["0.1.0, a release for x86_64-linux.", "Not checked yet: Check asks GitHub for the latest release."]);
        const latest = { version: "0.2.0", tag: "v0.2.0", page: "", published: "2026-11-12T10:00:00Z", archive: "spinny-0.2.0-x86_64-linux.tar.gz", size: 48e6 };
        const going = versionLines({ ...RELEASE, latest, status: "newer", checked: "now", state: "downloading", done: 12.34e6, total: 48e6 });
        expect(going.lines.slice(1)).toEqual([
            "Latest on GitHub: 0.2.0 (2026-11-12), newer: Update installs it beside this one.",
            "Downloading spinny-0.2.0-x86_64-linux.tar.gz: 12.3 of 48.0 MB.",
        ]);
        const done = versionLines({ ...RELEASE, latest, status: "newer", checked: "now", state: "done", installed: "spinny-0.2.0-x86_64-linux", previous: "spinny-0.1.0-x86_64-linux" });
        expect(done.lines.at(-1)).toBe(
            "Installed spinny-0.2.0-x86_64-linux beside this one, and /opt/spinny/spinny points at it; spinny-0.1.0-x86_64-linux stays for a rollback"
            + " (spinny-web --rollback). Restart from /opt/spinny/spinny/bin/spinny-web to finish.",
        );
        expect(versionLines({ ...RELEASE, error: "no release is published at github.com/tmpk13/spinny-cnc yet" }).problem).toBe("no release is published at github.com/tmpk13/spinny-cnc yet");
    });

    test("Check finds the newer release, Update installs it, and the panel says to restart", async () => {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const root = document.createElement("section");
        document.body.append(root);
        mountVersion(root, ctx);
        await settle();
        const buttons = Array.from(root.querySelectorAll("button"));
        const check = buttons.find((b) => b.textContent === "Check")!;
        const install = buttons.find((b) => b.textContent === "Update")!;
        expect(check.title).toBe("Ask GitHub for the latest release");
        expect(install.dataset["reason"]).toBe("check for a release first");
        check.click();
        await settle();
        expect(root.textContent).toContain("Latest on GitHub: 0.2.0 (2026-11-12), newer");
        expect(install.dataset["locked"]).toBeUndefined();
        install.click();
        await settle();
        expect(root.textContent).toContain("Downloading spinny-0.2.0-x86_64-linux.tar.gz");
        expect(check.dataset["reason"]).toBe("an update is under way");
        // The panel asks again while the update goes on.
        await new Promise((resolve) => setTimeout(resolve, 600));
        await settle();
        expect(root.textContent).toContain("Restart from /opt/spinny/spinny/bin/spinny-web to finish.");
        expect(install.dataset["reason"]).toBe("installed: restart from the link to finish");
        await expect(backend.updateInstall()).rejects.toMatchObject({
            status: 400, message: "spinny-0.2.0-x86_64-linux is installed beside this one: restart from /opt/spinny/spinny/bin/spinny-web to run it",
        });
        root.remove();
    });

    test("the routes are asked as the backend has them", async () => {
        const calls: [string, string][] = [];
        const api = new HttpApi("http://host", async (url: string, init?: RequestInit) => {
            calls.push([init?.method ?? "GET", url.replace("http://host", "")]);
            return new Response("{}", { status: 200 });
        });
        await api.updateState();
        await api.updateCheck();
        await api.updateInstall();
        expect(calls).toEqual([["GET", "/api/update"], ["POST", "/api/update/check"], ["POST", "/api/update/install"]]);
    });
});
