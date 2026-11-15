// STL models read and drawn from above, for the Machine view: a binary or
// ASCII STL file's triangles, and a top view of them as pixels (the
// highest surface over each pixel wins, shaded by how its normal faces a
// light from above and to the upper left), which the view lays over the
// box on the machine the model is placed in. The count and the checks
// twin the backend's spinny_web.machineview, word for word.

const HEADER = 80;

/** A model's triangles, nine numbers each (three corners, x y z), and the box round them. */
export interface Mesh {
    triangles: Float32Array;
    count: number;
    /** x0, y0, z0, x1, y1, z1. */
    box: [number, number, number, number, number, number];
}

const NOT_STL = "a model must be an STL file, binary or ASCII, with at least one triangle";

/** The triangles a binary STL of `bytes` holds by its length (its header, a count and 50 bytes a triangle), else null. */
function binaryCount(bytes: Uint8Array): number | null {
    if (bytes.length < HEADER + 4) {
        return null;
    }
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER, true);
    return count > 0 && bytes.length === HEADER + 4 + 50 * count ? count : null;
}

/** Whether the file starts as an ASCII STL does: `solid` after any space. */
function asciiStart(bytes: Uint8Array): boolean {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
    return head.startsWith("solid");
}

/** Counts of a word in a text. */
function occurrences(text: string, word: string): number {
    let count = 0;
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
        count += 1;
    }
    return count;
}

/** The triangles an STL file holds, binary or ASCII; an error for a file that is neither. */
export function stlTriangleCount(bytes: Uint8Array): number {
    const binary = binaryCount(bytes);
    if (binary !== null) {
        return binary;
    }
    if (asciiStart(bytes)) {
        const text = new TextDecoder("latin1").decode(bytes);
        const count = occurrences(text, "facet normal");
        if (count > 0 && occurrences(text, "vertex") >= 3 * count) {
            return count;
        }
    }
    throw new Error(NOT_STL);
}

/** An STL file's triangles; an error for a file that is not one. */
export function parseStl(bytes: Uint8Array): Mesh {
    const binary = binaryCount(bytes);
    let triangles: Float32Array;
    if (binary !== null) {
        triangles = new Float32Array(binary * 9);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < binary; index += 1) {
            // Each record: the normal (3 floats, recomputed from the corners here), 3 corners, 2 bytes.
            const at = HEADER + 4 + index * 50 + 12;
            for (let k = 0; k < 9; k += 1) {
                triangles[index * 9 + k] = view.getFloat32(at + k * 4, true);
            }
        }
    } else {
        stlTriangleCount(bytes);
        const text = new TextDecoder("latin1").decode(bytes);
        const numbers: number[] = [];
        const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
        for (let match = vertex.exec(text); match !== null; match = vertex.exec(text)) {
            numbers.push(Number(match[1]), Number(match[2]), Number(match[3]));
        }
        const whole = numbers.length - (numbers.length % 9);
        triangles = Float32Array.from(numbers.slice(0, whole));
    }
    const box: Mesh["box"] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let at = 0; at < triangles.length; at += 3) {
        const x = triangles[at]!;
        const y = triangles[at + 1]!;
        const z = triangles[at + 2]!;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            throw new Error("a model's corners must be numbers");
        }
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.min(box[2], z);
        box[3] = Math.max(box[3], x);
        box[4] = Math.max(box[4], y);
        box[5] = Math.max(box[5], z);
    }
    if (triangles.length === 0) {
        throw new Error(NOT_STL);
    }
    return { triangles, count: triangles.length / 9, box };
}

/** The light the top view is shaded by: from above, a little from the upper left (toward -X, +Y). */
const LIGHT = (() => {
    const [x, y, z] = [-0.35, 0.45, 0.82];
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length] as const;
})();

/**
 * The model seen from above as `width` by `height` pixels covering its own
 * x and y box (row 0 at the box's top, its highest y): per pixel, the
 * brightness 0 to 1 of the highest triangle over it (how squarely its
 * normal faces the light), or -1 where nothing is. Triangles seen edge on
 * from above draw nothing.
 */
export function topShades(mesh: Mesh, width: number, height: number): Float32Array {
    const shades = new Float32Array(width * height).fill(-1);
    const depth = new Float32Array(width * height).fill(-Infinity);
    const [x0, y0, , x1, y1] = mesh.box;
    const sx = width / Math.max(x1 - x0, 1e-9);
    const sy = height / Math.max(y1 - y0, 1e-9);
    const t = mesh.triangles;
    for (let at = 0; at < t.length; at += 9) {
        const ax = (t[at]! - x0) * sx;
        const ay = (y1 - t[at + 1]!) * sy;
        const az = t[at + 2]!;
        const bx = (t[at + 3]! - x0) * sx;
        const by = (y1 - t[at + 4]!) * sy;
        const bz = t[at + 5]!;
        const cx = (t[at + 6]! - x0) * sx;
        const cy = (y1 - t[at + 7]!) * sy;
        const cz = t[at + 8]!;
        // The normal from the corners as they lie on the model.
        const ux = t[at + 3]! - t[at]!;
        const uy = t[at + 4]! - t[at + 1]!;
        const uz = bz - az;
        const vx = t[at + 6]! - t[at]!;
        const vy = t[at + 7]! - t[at + 1]!;
        const vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (!(length > 0)) {
            continue;
        }
        nx /= length;
        ny /= length;
        nz /= length;
        // Facing down or edge on: seen from above it is the other side of something, or nothing.
        if (nz < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        const shade = 0.25 + 0.75 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        // The triangle's area on the screen, signed: its pixels by their barycentric weights.
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-12) {
            continue;
        }
        const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const right = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
        const top = Math.max(0, Math.floor(Math.min(ay, by, cy)));
        const bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let py = top; py <= bottom; py += 1) {
            const fy = py + 0.5;
            for (let px = left; px <= right; px += 1) {
                const fx = px + 0.5;
                const wa = ((bx - fx) * (cy - fy) - (by - fy) * (cx - fx)) / area;
                const wb = ((cx - fx) * (ay - fy) - (cy - fy) * (ax - fx)) / area;
                const wc = 1 - wa - wb;
                if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) {
                    continue;
                }
                const z = wa * az + wb * bz + wc * cz;
                const index = py * width + px;
                if (z > depth[index]!) {
                    depth[index] = z;
                    shades[index] = shade;
                }
            }
        }
    }
    return shades;
}

/** The pixels' size for a top view of `mesh` at most `longest` px on its longer side, at least 1 a side. */
export function topSize(mesh: Mesh, longest: number): [number, number] {
    const spanX = Math.max(mesh.box[3] - mesh.box[0], 1e-9);
    const spanY = Math.max(mesh.box[4] - mesh.box[1], 1e-9);
    return spanX >= spanY
        ? [longest, Math.max(1, Math.round((longest * spanY) / spanX))]
        : [Math.max(1, Math.round((longest * spanX) / spanY)), longest];
}

/** A color as its red, green and blue, from #rrggbb; null for anything else. */
export function hexColor(text: string): [number, number, number] | null {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text.trim());
    return match ? [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)] : null;
}

/**
 * The top view as RGBA pixels: each covered pixel between `dark` (shade 0)
 * and `light` (shade 1), the rest clear.
 */
export function shadePixels(shades: Float32Array, dark: [number, number, number], light: [number, number, number]): Uint8ClampedArray<ArrayBuffer> {
    const pixels = new Uint8ClampedArray(new ArrayBuffer(shades.length * 4));
    for (let index = 0; index < shades.length; index += 1) {
        const shade = shades[index]!;
        if (shade < 0) {
            continue;
        }
        pixels[index * 4] = dark[0] + (light[0] - dark[0]) * shade;
        pixels[index * 4 + 1] = dark[1] + (light[1] - dark[1]) * shade;
        pixels[index * 4 + 2] = dark[2] + (light[2] - dark[2]) * shade;
        pixels[index * 4 + 3] = 255;
    }
    return pixels;
}

/** The top view as a PNG data address, at most `longest` px on its longer side; null where the page cannot draw (no canvas). */
export function topViewUrl(mesh: Mesh, longest: number, dark: [number, number, number], light: [number, number, number]): string | null {
    const [width, height] = topSize(mesh, longest);
    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    const context = canvas?.getContext?.("2d") ?? null;
    if (canvas === null || context === null || typeof ImageData === "undefined") {
        return null;
    }
    canvas.width = width;
    canvas.height = height;
    context.putImageData(new ImageData(shadePixels(topShades(mesh, width, height), dark, light), width, height), 0, 0);
    try {
        return canvas.toDataURL("image/png");
    } catch {
        return null;
    }
}
