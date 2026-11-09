// Moving a job's paths between its groups: the paths picked in the preview
// put into a group of their own or into one the job has, or taken out of
// the job. Every function answers a new job and leaves the one given as it
// was; the page sends the new one back whole (PUT /api/jobs/{id}), so a
// group is a set of paths with one power, speed and pass count however its
// paths came to be together.

import type { Group, Job } from "./types.ts";

/** A path of a job: its group's index and its own index within the group. */
export type PathRef = [number, number];

/** A ref as a key for sets and maps. */
export function refKey(ref: PathRef): string {
    return `${ref[0]}:${ref[1]}`;
}

/** The refs that name a path of the job, each once, by group and then path. */
export function tidyRefs(job: Job, refs: PathRef[]): PathRef[] {
    const seen = new Set<string>();
    const out: PathRef[] = [];
    for (const ref of refs) {
        const [g, p] = ref;
        const group = job.groups[g];
        if (!group || !Number.isInteger(p) || p < 0 || p >= group.paths.length || seen.has(refKey(ref))) {
            continue;
        }
        seen.add(refKey(ref));
        out.push([g, p]);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** A group of dots: a dispense's, each path one point with its pad's area beside it. */
function isDotGroup(group: Group): boolean {
    return (group.areas?.length ?? 0) > 0;
}

/** The CAM profile's tool a group was made with, by name, as a refusal says it. */
function madeWith(group: Group): string {
    return group.tool_name || group.tool_id || "no tool of a profile";
}

/**
 * Why the paths cannot be moved into `target` (a group's index, or a new
 * group); empty when they can. A joint-space group's paths are only drawn
 * from its joints, and a model's group has moves, not paths: neither can
 * give a path away. Dots and paths do not mix, nor do groups made for
 * different tools, or with different tools of a CAM profile: the gcode
 * stops to change the bit between groups, never inside one.
 */
export function regroupRefusal(job: Job, refs: PathRef[], target: number | "new"): string {
    const picked = tidyRefs(job, refs);
    if (picked.length === 0) {
        return "pick some paths in the preview first";
    }
    const sources = [...new Set(picked.map(([g]) => g))].map((g) => job.groups[g]!);
    for (const group of sources) {
        if ((group.joints?.length ?? 0) > 0) {
            return `${group.label}: a joint-space group's paths are drawn from its joints and cannot be moved`;
        }
        if ((group.moves?.length ?? 0) > 0) {
            return `${group.label}: a model's moves cannot be moved`;
        }
    }
    const first = sources[0]!;
    const dots = isDotGroup(first);
    for (const group of sources) {
        if (isDotGroup(group) !== dots) {
            return "dots and paths do not go in one group";
        }
        if ((group.tool ?? null) !== (first.tool ?? null)) {
            return `${group.label} was made for ${group.tool ?? "any tool"} and ${first.label} for ${first.tool ?? "any tool"}: they do not go in one group`;
        }
        if ((group.tool_id ?? null) !== (first.tool_id ?? null)) {
            return `${group.label} was made with ${madeWith(group)} and ${first.label} with ${madeWith(first)}: they do not go in one group`;
        }
    }
    if (target !== "new") {
        const into = job.groups[target];
        if (!into) {
            return `the job has no group ${target + 1}`;
        }
        if ((into.joints?.length ?? 0) > 0 || (into.moves?.length ?? 0) > 0) {
            return `${into.label} takes no paths: its cuts are joints or a model's moves`;
        }
        if (into.paths.length > 0 && isDotGroup(into) !== dots) {
            return "dots and paths do not go in one group";
        }
        if (into.paths.length > 0 && (into.tool ?? null) !== (first.tool ?? null)) {
            return `${into.label} was made for ${into.tool ?? "any tool"}, the paths for ${first.tool ?? "any tool"}`;
        }
        if (into.paths.length > 0 && (into.tool_id ?? null) !== (first.tool_id ?? null)) {
            return `${into.label} was made with ${madeWith(into)}, the paths with ${madeWith(first)}`;
        }
    }
    return "";
}

/** A label no group of the job has: `base`, else `base 2`, `base 3` and on. */
export function freshLabel(job: Job, base = "group"): string {
    const taken = new Set(job.groups.map((group) => group.label));
    if (!taken.has(base)) {
        return base;
    }
    for (let n = 2; ; n++) {
        if (!taken.has(`${base} ${n}`)) {
            return `${base} ${n}`;
        }
    }
}

/** The job after a regrouping, and where the moved paths are in it now. */
export interface Regrouped {
    job: Job;
    refs: PathRef[];
}

/**
 * The job with the paths moved to the end of group `target`, or into a new
 * group named `label` placed after the last group they came from and made
 * with the settings of the first (power, speed, passes, focus and the
 * rest), switched on only when every group they came from is: a path that
 * was not to be cut is not cut for having been moved. A group the move
 * leaves empty is dropped; the target never is. Throws with the reason
 * when `regroupRefusal` has one.
 */
export function regroup(job: Job, refs: PathRef[], target: number | "new", label?: string): Regrouped {
    const refusal = regroupRefusal(job, refs, target);
    if (refusal) {
        throw new Error(refusal);
    }
    const picked = tidyRefs(job, refs);
    const moving = new Set(picked.map(refKey));
    const sources = new Set(picked.map(([g]) => g));
    const lastSource = Math.max(...sources);
    const first = job.groups[picked[0]![0]]!;
    const dots = isDotGroup(first);
    const movedPaths = picked.map(([g, p]) => structuredClone(job.groups[g]!.paths[p]!));
    const movedAreas = dots ? picked.map(([g, p]) => job.groups[g]!.areas?.[p] ?? 0) : [];
    const groups: Group[] = [];
    let landed = -1;
    job.groups.forEach((group, g) => {
        const kept = structuredClone(group);
        if (sources.has(g)) {
            const keep = group.paths.map((_, p) => !moving.has(refKey([g, p])));
            kept.paths = group.paths.filter((_, p) => keep[p]).map((path) => structuredClone(path));
            if (isDotGroup(group)) {
                kept.areas = (group.areas ?? []).filter((_, p) => keep[p]);
            }
        }
        if (g === target) {
            kept.paths.push(...movedPaths);
            if (dots) {
                kept.areas = [...(kept.areas ?? []), ...movedAreas];
            }
            landed = groups.length;
        }
        const emptied = sources.has(g) && kept.paths.length === 0 && g !== target;
        if (!emptied) {
            groups.push(kept);
        }
        if (target === "new" && g === lastSource) {
            const made: Group = {
                label: label?.trim() || freshLabel(job),
                power: first.power,
                min_power: first.min_power,
                speed: first.speed,
                passes: first.passes,
                enabled: [...sources].every((g) => job.groups[g]!.enabled),
                paths: movedPaths,
            };
            for (const key of ["depth", "plunge", "thickness", "focus", "tool", "tool_id", "tool_name", "height"] as const) {
                if (first[key] !== undefined) {
                    (made as unknown as Record<string, unknown>)[key] = first[key];
                }
            }
            if (dots) {
                made.areas = movedAreas;
            }
            landed = groups.length;
            groups.push(made);
        }
    });
    const into = groups[landed]!;
    const start = into.paths.length - movedPaths.length;
    return {
        job: { ...structuredClone(job), groups },
        refs: movedPaths.map((_, i) => [landed, start + i] as PathRef),
    };
}

/** The job without the paths; a group left empty is dropped. Throws for a joint-space or a model's group. */
export function removePaths(job: Job, refs: PathRef[]): Job {
    const picked = tidyRefs(job, refs);
    for (const g of new Set(picked.map(([group]) => group))) {
        const group = job.groups[g]!;
        if ((group.joints?.length ?? 0) > 0 || (group.moves?.length ?? 0) > 0) {
            throw new Error(`${group.label}: its paths are drawn from its joints or a model's moves and cannot be taken out one by one`);
        }
    }
    const removing = new Set(picked.map(refKey));
    const groups: Group[] = [];
    job.groups.forEach((group, g) => {
        const keep = group.paths.map((_, p) => !removing.has(refKey([g, p])));
        if (keep.every(Boolean)) {
            groups.push(structuredClone(group));
            return;
        }
        const kept = structuredClone(group);
        kept.paths = group.paths.filter((_, p) => keep[p]).map((path) => structuredClone(path));
        if (isDotGroup(group)) {
            kept.areas = (group.areas ?? []).filter((_, p) => keep[p]);
        }
        if (kept.paths.length > 0) {
            groups.push(kept);
        }
    });
    return { ...structuredClone(job), groups };
}

/** Every path of a group as refs. */
export function groupRefs(job: Job, g: number): PathRef[] {
    return (job.groups[g]?.paths ?? []).map((_, p) => [g, p] as PathRef);
}

/**
 * The picked paths after a click on `ref` (null: on nothing): alone, or
 * added and taken back again with a key held; a click on nothing without
 * one picks nothing.
 */
export function pickedAfter(current: PathRef[], ref: PathRef | null, additive: boolean): PathRef[] {
    if (ref === null) {
        return additive ? current : [];
    }
    if (!additive) {
        return [ref];
    }
    const key = refKey(ref);
    return current.some((one) => refKey(one) === key) ? current.filter((one) => refKey(one) !== key) : [...current, ref];
}

/** The picked paths after a box: those in it, added to the others with a key held. */
export function boxedAfter(current: PathRef[], refs: PathRef[], additive: boolean): PathRef[] {
    if (!additive) {
        return refs;
    }
    const keys = new Set(current.map(refKey));
    return [...current, ...refs.filter((ref) => !keys.has(refKey(ref)))];
}

/**
 * A pattern of copies of the picked paths: `count` instances in all, the
 * picked ones included. Linear steps each copy on by (dx, dy) mm; circular
 * turns each about (cx, cy) by an even share of `sweep` degrees,
 * counterclockwise when positive: a whole turn spreads the instances
 * round it, anything less puts the last on the end of the sweep.
 */
export type ArraySpec =
    | { kind: "linear"; count: number; dx: number; dy: number }
    | { kind: "circular"; count: number; cx: number; cy: number; sweep: number };

/** Instances in one pattern, and paths one pattern may make, at most. */
export const MAX_ARRAY = 1000;
export const MAX_ARRAY_PATHS = 100_000;

/** The turn between two instances of a circular pattern, degrees. */
export function arrayStep(spec: Extract<ArraySpec, { kind: "circular" }>): number {
    return Math.abs(spec.sweep) >= 360 - 1e-9 ? spec.sweep / spec.count : spec.sweep / (spec.count - 1);
}

/** Where copy `k` (1 for the first copy) puts a point. */
export function arrayPlace(spec: ArraySpec, k: number): (point: [number, number]) => [number, number] {
    if (spec.kind === "linear") {
        return ([x, y]) => [x + spec.dx * k, y + spec.dy * k];
    }
    const angle = (arrayStep(spec) * k * Math.PI) / 180;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return ([x, y]) => {
        const dx = x - spec.cx;
        const dy = y - spec.cy;
        return [spec.cx + dx * c - dy * s, spec.cy + dx * s + dy * c];
    };
}

/** Why the picked paths cannot be made a pattern; empty when they can. */
export function arrayRefusal(job: Job, refs: PathRef[], spec: ArraySpec): string {
    const picked = tidyRefs(job, refs);
    if (picked.length === 0) {
        return "pick some paths in the preview first";
    }
    for (const g of new Set(picked.map(([group]) => group))) {
        const group = job.groups[g]!;
        if ((group.joints?.length ?? 0) > 0) {
            return `${group.label}: a joint-space group's paths are drawn from its joints and cannot be copied`;
        }
        if ((group.moves?.length ?? 0) > 0) {
            return `${group.label}: a model's moves cannot be copied`;
        }
    }
    if (!Number.isInteger(spec.count) || spec.count < 2 || spec.count > MAX_ARRAY) {
        return `the count is a whole number from 2 to ${MAX_ARRAY}, the picked paths included`;
    }
    const numbers = spec.kind === "linear" ? [spec.dx, spec.dy] : [spec.cx, spec.cy, spec.sweep];
    if (!numbers.every(Number.isFinite)) {
        return "every field needs a number";
    }
    if (spec.kind === "linear" && spec.dx === 0 && spec.dy === 0) {
        return "the copies need a step: give a step in x or y";
    }
    if (spec.kind === "circular" && spec.sweep === 0) {
        return "the copies need an angle to turn through";
    }
    if (picked.length * (spec.count - 1) > MAX_ARRAY_PATHS) {
        return `${picked.length * (spec.count - 1)} copies are too many: at most ${MAX_ARRAY_PATHS} paths at once`;
    }
    return "";
}

/**
 * The job with copies of the picked paths, each copy at the end of the
 * group its path is in (with its pad's area, in a group of dots), and
 * where the copies are in it, to pick them. The paths picked stay where
 * they are. Throws with the reason when `arrayRefusal` has one.
 */
export function arrayPaths(job: Job, refs: PathRef[], spec: ArraySpec): Regrouped {
    const refusal = arrayRefusal(job, refs, spec);
    if (refusal) {
        throw new Error(refusal);
    }
    const picked = tidyRefs(job, refs);
    const made = structuredClone(job);
    const copies: PathRef[] = [];
    for (let k = 1; k < spec.count; k++) {
        const place = arrayPlace(spec, k);
        for (const [g, p] of picked) {
            const group = made.groups[g]!;
            const source = job.groups[g]!;
            group.paths.push(source.paths[p]!.map((point) => place(point)));
            if (isDotGroup(source)) {
                group.areas = [...(group.areas ?? []), source.areas?.[p] ?? 0];
            }
            copies.push([g, group.paths.length - 1]);
        }
    }
    return { job: made, refs: copies };
}

/** The middle of the box round the picked paths; the origin when none is picked. */
export function pathsMiddle(job: Job, refs: PathRef[]): [number, number] {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [g, p] of tidyRefs(job, refs)) {
        for (const [x, y] of job.groups[g]!.paths[p]!) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
        }
    }
    return x0 > x1 ? [0, 0] : [(x0 + x1) / 2, (y0 + y1) / 2];
}
