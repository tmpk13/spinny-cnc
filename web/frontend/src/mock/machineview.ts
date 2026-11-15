// The in-page mock's twin of spinny_web.machineview: the Machine view's
// picture and model of each machine kept in memory, told by their bytes
// with the backend's words, each with its name, type, size, version and
// the box it is drawn over.

import { ApiError } from "../api.ts";
import { stlTriangleCount } from "../stl.ts";
import type { MachineViewFile, MachineViewKind, MachineViewState } from "../types.ts";

export const MAX_PICTURE = 16 * 1024 * 1024;
export const MAX_MODEL = 64 * 1024 * 1024;
const COORD_LIMIT = 10000;
const MAX_NAME = 200;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A picture's media type from its first bytes, as the backend's picture_type; an error for anything else. */
export function pictureType(bytes: Uint8Array): string {
    const starts = (...prefix: number[]): boolean => prefix.every((value, index) => bytes[index] === value);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        return "image/png";
    }
    if (starts(0xff, 0xd8, 0xff)) {
        return "image/jpeg";
    }
    const text = new TextDecoder("latin1").decode(bytes.subarray(0, 12));
    if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") {
        return "image/webp";
    }
    if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) {
        return "image/gif";
    }
    throw new ApiError(400, "a picture must be a PNG, JPEG, WebP or GIF file");
}

/** A box as the backend's checked_box takes it; null keeps the default. */
export function checkedBox(box: number[] | null): [number, number, number, number] | null {
    if (box === null) {
        return null;
    }
    if (box.length !== 4 || !box.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORD_LIMIT)) {
        throw new ApiError(400, `a box must be 4 numbers within ${COORD_LIMIT}: x0, y0, x1, y1`);
    }
    const [x0, y0, x1, y1] = box as [number, number, number, number];
    if (!(x0 < x1 && y0 < y1)) {
        throw new ApiError(400, "a box must be x0, y0, x1, y1 with x0 below x1 and y0 below y1");
    }
    return [x0, y0, x1, y1];
}

interface Kept extends MachineViewFile {
    data: Uint8Array;
}

export class MockMachineViews {
    private readonly kept = new Map<string, Partial<Record<MachineViewKind, Kept>>>();
    // Addresses of the blobs handed out, by machine, kind and version.
    private readonly urls = new Map<string, string>();

    constructor(private readonly exists: (id: string) => boolean) {}

    private check(id: string, kind: string): asserts kind is MachineViewKind {
        if (!ID.test(id)) {
            throw new ApiError(400, `'${id}' is not a machine id: lower case letters, digits, - and _`);
        }
        if (kind !== "picture" && kind !== "model") {
            throw new ApiError(400, `'${kind}' is not a picture or a model`);
        }
    }

    state(id: string): MachineViewState {
        this.check(id, "picture");
        const kept = this.kept.get(id) ?? {};
        const shown = (entry: Kept | undefined): MachineViewFile | null => {
            if (!entry) {
                return null;
            }
            const { data: _data, ...file } = entry;
            return { ...file, box: file.box ? [...file.box] : null };
        };
        return { machine: id, picture: shown(kept.picture), model: shown(kept.model) };
    }

    async put(id: string, kind: MachineViewKind, file: File): Promise<MachineViewState> {
        this.check(id, kind);
        if (!this.exists(id)) {
            throw new ApiError(404, `no machine file '${id}'`);
        }
        const limit = kind === "picture" ? MAX_PICTURE : MAX_MODEL;
        if (file.size > limit) {
            throw new ApiError(413, `the ${kind} is over ${limit >> 20} MB`);
        }
        const data = new Uint8Array(await file.arrayBuffer());
        let type: string;
        let triangles: number | undefined;
        if (kind === "picture") {
            type = pictureType(data);
        } else {
            type = "model/stl";
            try {
                triangles = stlTriangleCount(data);
            } catch (error) {
                throw new ApiError(400, error instanceof Error ? error.message : String(error));
            }
        }
        const kept = this.kept.get(id) ?? {};
        const before = kept[kind];
        const name = (file.name.split(/[\\/]/).pop() || `${kind}`).slice(0, MAX_NAME);
        kept[kind] = { name, type, bytes: data.length, version: (before?.version ?? 0) + 1, box: before?.box ?? null, ...(triangles !== undefined ? { triangles } : {}), data };
        this.kept.set(id, kept);
        return this.state(id);
    }

    place(id: string, kind: MachineViewKind, box: number[] | null): MachineViewState {
        this.check(id, kind);
        const entry = this.kept.get(id)?.[kind];
        if (!entry) {
            throw new ApiError(404, `no ${kind} added for ${id}`);
        }
        entry.box = checkedBox(box);
        entry.version += 1;
        return this.state(id);
    }

    remove(id: string, kind: MachineViewKind): MachineViewState {
        this.check(id, kind);
        const kept = this.kept.get(id);
        if (kept) {
            delete kept[kind];
            if (!kept.picture && !kept.model) {
                this.kept.delete(id);
            }
        }
        return this.state(id);
    }

    /** The kept file's bytes; 404 with none. */
    bytes(id: string, kind: MachineViewKind): Uint8Array {
        this.check(id, kind);
        const entry = this.kept.get(id)?.[kind];
        if (!entry) {
            throw new ApiError(404, `no ${kind} added for ${id}`);
        }
        return entry.data;
    }

    /** An address the page's image can show the kept file from: a blob's, made once a version; empty with none. */
    url(id: string, kind: MachineViewKind): string {
        const entry = this.kept.get(id)?.[kind];
        if (!entry) {
            return "";
        }
        const key = `${id}/${kind}/${entry.version}`;
        let url = this.urls.get(key);
        if (url === undefined) {
            const copy = new Uint8Array(entry.data);
            url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(new Blob([copy], { type: entry.type })) : "";
            this.urls.set(key, url);
        }
        return url;
    }
}
