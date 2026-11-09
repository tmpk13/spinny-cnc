import { describe, expect, test } from "bun:test";

import { thumbKey, thumbnail } from "../src/mock/thumbs.ts";
import type { Group, Job } from "../src/types.ts";
import { mountJobs } from "../src/views/jobs.ts";
import { dialogButton, settle, setup } from "./harness.ts";

const SVG = (color: string, y: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><path d="M0 ${y} L10 ${y}" stroke="${color}"/></svg>`;

async function settleMany(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await settle();
    }
}

describe("combining jobs", () => {
    test("the jobs checked become one job, cut in the order they were checked", async () => {
        const { store, ctx, root, api, calls } = setup();
        mountJobs(root, ctx);
        const lid = await api.uploadJob(new File([SVG("#f00", 0)], "lid.svg"), { anchor: "keep" });
        const base = await api.uploadJob(new File([SVG("#00f", 5)], "base.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        const before = store.get().jobs.length;
        const combine = (): HTMLButtonElement => Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Combine"))!;
        const check = (name: string): HTMLInputElement => root.querySelector(`input[aria-label="combine ${name}"]`) as HTMLInputElement;
        expect(combine().disabled).toBe(true);
        // The base first, then the lid.
        check(base.name).click();
        check(lid.name).click();
        expect(combine().textContent).toBe("Combine 2");
        expect(combine().disabled).toBe(false);
        combine().click();
        await settle();
        dialogButton("Combine").click();
        await settleMany();
        expect(calls.find((call) => call.name === "combineJobs")?.args[0]).toEqual([base.id, lid.id]);
        const job = store.get().job!;
        expect(job.source).toBe("combined");
        expect(job.name).toBe(`${base.name} + ${lid.name}`);
        expect(job.groups.map((group) => group.label)).toEqual([`${base.name}: stroke #0000ff`, `${lid.name}: stroke #ff0000`]);
        expect(store.get().jobs.length).toBe(before + 1);
        // The checks are spent.
        expect(combine().disabled).toBe(true);
        expect(check(base.name).checked).toBe(false);
        root.remove();
    });

    test("every job in the list carries a small drawing of itself", async () => {
        const { ctx, root, api } = setup();
        mountJobs(root, ctx);
        await api.uploadJob(new File([SVG("#f00", 0)], "lid.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        const img = root.querySelector("img.job-thumb") as HTMLImageElement;
        expect(img.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
        expect(decodeURIComponent(img.getAttribute("src")!)).toContain("<polyline");
        root.remove();
    });
});

describe("a job drawn small", () => {
    const group = (label: string, paths: [number, number][][], extra: Partial<Group> = {}): Group => ({ label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths, ...extra });
    const job = (groups: Group[]): Job => ({
        id: "t", name: "t", source: "svg", spot: 0.1, offset: { x: 0, y: 0 }, groups, outline: [], copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    });

    test("draws nothing for an empty path, as the backend does", () => {
        const svg = thumbnail(job([group("a", [[[0, 0], [5, 0]], []])]));
        expect(svg.split("<polyline").length - 1).toBe(1);
    });

    test("fits the paths with Y up, each group in its color, one switched off faint, a point a dot", () => {
        const svg = thumbnail(job([group("a", [[[0, 0], [10, 0], [10, 20]]]), group("b", [[[5, 5]]], { enabled: false })]));
        expect(svg).toContain('width="35" height="64"');
        expect(svg).toContain('viewBox="-1.20 -21.20 12.40 22.40"');
        expect(svg).toContain('<g stroke="#dc322f"><polyline points="0.00,0.00 10.00,0.00 10.00,-20.00"/></g>');
        expect(svg).toContain('<g fill="#268bd2" opacity="0.3"><circle cx="5.00" cy="-5.00"');
        expect(thumbnail(job([]))).not.toContain("polyline");
    });

    test("its key changes with what the drawing shows and with nothing else", () => {
        const summary = { stats: { length_mm: 10, moves: 2 }, offset: { x: 0, y: 0 }, rotation: 0, groups: [{ enabled: true, paths: 1 }] };
        const key = thumbKey(summary);
        expect(thumbKey({ ...summary })).toBe(key);
        expect(thumbKey({ ...summary, offset: { x: 1, y: 0 } })).not.toBe(key);
        expect(thumbKey({ ...summary, groups: [{ enabled: false, paths: 1 }] })).not.toBe(key);
    });
});
