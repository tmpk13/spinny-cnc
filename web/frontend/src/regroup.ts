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

/**
 * Why the paths cannot be moved into `target` (a group's index, or a new
 * group); empty when they can. A joint-space group's paths are only drawn
 * from its joints, and a model's group has moves, not paths: neither can
 * give a path away. Dots and paths do not mix, nor do groups made for
 * different tools.
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
 * rest). A group the move leaves empty is dropped; the target never is.
 * Throws with the reason when `regroupRefusal` has one.
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
                enabled: true,
                paths: movedPaths,
            };
            for (const key of ["depth", "plunge", "thickness", "focus", "tool"] as const) {
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
