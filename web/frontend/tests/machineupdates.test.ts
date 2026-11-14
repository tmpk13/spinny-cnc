import { describe, expect, test } from "bun:test";

import type { MachineOffer, MachineUpdates } from "../src/types.ts";
import { mountConfig } from "../src/views/config.ts";
import { diffLines, offerSummary } from "../src/views/machineupdates.ts";
import { settle, setup } from "./harness.ts";

const OFFER: MachineOffer = {
    id: "virtual-pnp",
    name: "Virtual LumenPnP",
    status: "merged",
    changes: ['[up_camera] device = "http://127.0.0.1:2328/snapshot" added', "[motion] place_z: yours kept, 13.2; the release has 14.0"],
    text: "name = \"Virtual LumenPnP\"\n",
    diff: "--- virtual-pnp.toml (yours)\n+++ virtual-pnp.toml (merged)\n@@ -1,2 +1,3 @@\n [up_camera]\n+device = \"http://127.0.0.1:2328/snapshot\"\n-old = 1\n",
    problem: null,
    known: true,
};

describe("a release's machine files offered", () => {
    test("an offer says what it does in a few words, and its diff's lines are told apart", () => {
        expect(offerSummary(OFFER)).toBe("1 change, 1 of yours kept");
        expect(offerSummary({ ...OFFER, status: "new" })).toBe("new in this release");
        expect(offerSummary({ ...OFFER, status: "problem" })).toBe("could not be merged");
        expect(diffLines(OFFER.diff).map((line) => line.kind)).toEqual(["same", "same", "hunk", "same", "add", "del"]);
    });

    test("the machine file panel shows the offers, and Take writes one and takes it off the list", async () => {
        localStorage.removeItem("spinny.machine");
        const { ctx, root, backend, calls } = setup();
        let offered: MachineUpdates = { shipped: true, files: [OFFER] };
        backend.machineUpdates = async () => offered;
        backend.takeMachineUpdate = async (id: string, take: boolean) => {
            expect([id, take]).toEqual(["virtual-pnp", true]);
            offered = { shipped: true, files: [] };
            return offered;
        };
        mountConfig(root, ctx, document.createElement("section"));
        await settle();
        await settle();
        const box = root.querySelector(".machine-updates") as HTMLElement;
        expect(box.classList.contains("hidden")).toBe(false);
        expect(box.textContent).toContain("This release has a machine file for you");
        expect(box.querySelector("summary")?.textContent).toBe("Virtual LumenPnP (virtual-pnp.toml): 1 change, 1 of yours kept");
        expect(Array.from(box.querySelectorAll(".config-notes li")).map((line) => line.textContent)).toEqual(OFFER.changes);
        expect(box.querySelector(".diff-add")?.textContent).toBe('+device = "http://127.0.0.1:2328/snapshot"\n');
        const reads = calls.filter((call) => call.name === "machines").length;
        (Array.from(box.querySelectorAll("button")).find((button) => button.textContent === "Take") as HTMLButtonElement).click();
        await settle();
        await settle();
        expect(box.classList.contains("hidden")).toBe(true);
        // The files are listed again, for the editor to read the one written.
        expect(calls.filter((call) => call.name === "machines").length).toBeGreaterThan(reads);
        localStorage.removeItem("spinny.machine");
    });

    test("a checkout, or the mock, offers nothing and shows nothing", async () => {
        const { ctx, root } = setup();
        mountConfig(root, ctx, document.createElement("section"));
        await settle();
        await settle();
        expect((root.querySelector(".machine-updates") as HTMLElement).classList.contains("hidden")).toBe(true);
    });
});
