// The mock's log of what the cameras' routines applied, as the backend's
// spinny_web.findings keeps it: each result applied at once and recorded
// with every setting it changed (before and after) and its marks; Undo
// writes the values before back, runs the result's own undo (a callable
// for what is no setting: corners, references, Align marks) and is logged
// itself. Refused (409) once undone, while a routine of the camera runs,
// or once a setting no longer holds the value the entry left.

import { ApiError } from "../api.ts";
import type { ControlledCamera, FindingChange, FindingEntry, FindingMarks, FindingsLog } from "../types.ts";

/** Entries the log keeps at most, and of each camera a state lists. */
export const MAX_ENTRIES = 500;
export const LISTED = 50;

/** Where a camera's settings live: read whole, written in part. */
export interface MockTarget {
    read(): Record<string, unknown>;
    write(values: Record<string, unknown>): void;
}

/** The settings' names in words, as the backend's LABELS. */
const LABELS: Record<string, string> = {
    offset: "offset, mm", roll: "roll, degrees", mm_per_px: "mm a pixel", mirror: "mirrored",
    position: "place, mm", runout: "runout, mm", height: "height, mm",
};

/** Whether two JSON values are the same, numbers within rounding. */
export function sameValue(a: unknown, b: unknown): boolean {
    if (typeof a === "number" && typeof b === "number") {
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
    }
    return JSON.stringify(a) === JSON.stringify(b);
}

function plain<T>(value: T): T {
    return value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T);
}

function localTime(): string {
    const now = new Date();
    const two = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

type Kept = Omit<FindingEntry, "undoable" | "why">;

export class MockFindings {
    private entries: Kept[] = [];
    private held = new Map<number, () => void>();
    private next = 1;

    /** `targets` give each camera's settings; `busy` says whether a routine of the camera runs; `changed` hears of every new entry. */
    constructor(
        private targets: Record<ControlledCamera, MockTarget>,
        private busy: (camera: ControlledCamera) => boolean,
        private changed: () => void,
    ) {}

    /** Writes `patch` into the camera's settings and records it with each value it changed; the words. */
    keep(camera: ControlledCamera, kind: string, text: string, patch: Record<string, unknown>, marks: FindingMarks = {}, undo?: () => void): string {
        const target = this.targets[camera];
        const before = plain(target.read());
        target.write(patch);
        const after = plain(target.read());
        const changes: FindingChange[] = Object.keys(patch)
            .filter((name) => !sameValue(before[name] ?? null, after[name] ?? null))
            .map((name) => ({ target: camera, name, label: LABELS[name] ?? name.replace(/_/g, " "), before: before[name] ?? null, after: after[name] ?? null }));
        return this.apply(camera, kind, text, changes, marks, undo);
    }

    /** Records a result applied by the caller, with its own undo when it changed more than settings; the words. */
    apply(camera: ControlledCamera, kind: string, text: string, changes: FindingChange[] = [], marks: FindingMarks = {}, undo?: () => void): string {
        const entry: Kept = {
            id: this.next++, time: localTime(), camera, kind, text, changes: plain(changes), marks: plain(marks), machine: null,
            undo: undo ? "held" : changes.length > 0 ? "data" : "none", undoes: null, undone_by: null,
        };
        this.add(entry, undo);
        return text;
    }

    private add(entry: Kept, undo?: () => void): void {
        this.entries.push(entry);
        if (undo) {
            this.held.set(entry.id, undo);
        }
        for (const gone of this.entries.splice(0, Math.max(0, this.entries.length - MAX_ENTRIES))) {
            this.held.delete(gone.id);
        }
        this.changed();
    }

    /** Why the entry cannot be undone now, or null. */
    private refusal(entry: Kept): string | null {
        if (entry.undone_by !== null) {
            return `undone already (entry ${entry.undone_by})`;
        }
        if (entry.undo === "none") {
            return entry.undoes !== null ? "an undo of what only that run of the backend could undo: run the routine again to apply it again" : "it changed nothing";
        }
        if (entry.undo === "held" && !this.held.has(entry.id)) {
            return "applied before the backend started again: what it changed besides its settings can no longer be undone";
        }
        for (const change of entry.changes) {
            const now = plain(this.targets[change.target as ControlledCamera]?.read() ?? {})[change.name] ?? null;
            if (!sameValue(now, change.after)) {
                return `${change.label} is ${JSON.stringify(now)} now, not ${JSON.stringify(change.after)}: it changed since`;
            }
        }
        return null;
    }

    private shown(entry: Kept): FindingEntry {
        const why = this.refusal(entry);
        return { ...plain(entry), undoable: why === null, why };
    }

    /** Takes the entry back; the undo's entry. 404 for none, 409 when it cannot be now. */
    undo(id: number): FindingEntry {
        const entry = this.entries.find((item) => item.id === id);
        if (!entry) {
            throw new ApiError(404, `no entry ${id} in the camera log of changes`);
        }
        if (this.busy(entry.camera)) {
            throw new ApiError(409, `a routine of the ${entry.camera} camera is under way: undo once it ends`);
        }
        const why = this.refusal(entry);
        if (why !== null) {
            throw new ApiError(409, `entry ${id} cannot be undone: ${why}`);
        }
        const own = this.held.get(id);
        if (own) {
            try {
                own();
            } catch (error) {
                if (error instanceof ApiError) {
                    throw new ApiError(409, `entry ${id} cannot be undone: ${error.message}`);
                }
                throw error;
            }
        }
        const target = this.targets[entry.camera];
        const values: Record<string, unknown> = {};
        for (const change of entry.changes) {
            values[change.name] = change.before;
        }
        if (entry.changes.length > 0) {
            target.write(values);
        }
        const reverse = entry.changes.map((change) => ({ ...change, before: change.after, after: change.before }));
        const undone: Kept = {
            id: this.next++, time: localTime(), camera: entry.camera, kind: "undo", text: `undone: ${entry.text}`, changes: reverse, marks: {},
            machine: entry.machine, undo: entry.undo === "data" && reverse.length > 0 ? "data" : "none", undoes: entry.id, undone_by: null,
        };
        entry.undone_by = undone.id;
        this.add(undone);
        return this.shown(undone);
    }

    /** The entries newest first, of one camera when given. */
    list(camera?: ControlledCamera, limit = MAX_ENTRIES): FindingsLog {
        const chosen = [...this.entries].reverse().filter((entry) => camera === undefined || entry.camera === camera);
        return { entries: chosen.slice(0, limit).map((entry) => this.shown(entry)), count: chosen.length };
    }

    /** Each camera's newest LISTED entries, newest first: what a `findings` event carries. */
    state(): FindingsLog {
        const cameras: ControlledCamera[] = ["head", "up", "top"];
        const chosen = cameras.flatMap((camera) => [...this.entries].reverse().filter((entry) => entry.camera === camera).slice(0, LISTED));
        chosen.sort((a, b) => b.id - a.id);
        return { entries: chosen.map((entry) => this.shown(entry)), count: this.entries.length };
    }

    /** The camera's newest entry, null with none. */
    newest(camera: ControlledCamera): FindingEntry | null {
        return this.list(camera, 1).entries[0] ?? null;
    }
}
