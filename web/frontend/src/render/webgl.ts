// The WebGL2 painter: the scene's items (scene.ts) drawn by the graphics
// card. The job's lines, dots and copper go onto the card once a job (and
// once a selection or a speed map) as points it projects itself, so a pan,
// a zoom or an orbit costs a few uniforms and a draw call per set however
// large the job is. What is worked out for each view (the grid or the
// rings, the rail, the limits, the probe mesh, the markers) is projected
// here and sent each frame, a few thousand points at most.
//
// A set of lines is one float texture of points and one draw of six
// vertices (a quad) per segment, each vertex fetching its segment's two
// points by its index: segment i joins point i to point i + 1, and a pair
// whose ids differ (two lines, or a lifted pen) draws nothing. Drawn as
// instances of a four-vertex quad instead, a board's 400,000 segments took
// seconds a frame in Chromium's software GL, which sets each instance up on
// its own, and leave a graphics card's vertex units mostly idle too. Each
// quad is wide enough for round caps; its fragments measure their distance
// to the segment and shade the last device pixel of the edge partly, so
// caps, joins and edges come out as a 2D stroke's do. Dashes are measured
// along the line in device px. A translucent set is drawn opaque into a
// layer of its own keeping the strongest cover where its lines overlap (MAX
// blending), and laid on the picture with its alpha, so it is no darker
// where its lines cross or join, as one 2D stroke draws it. Dots are quads
// the same way, a disc or a ring shaded by the distance to the center.
// Copper is filled even-odd with the stencil: a fan from each shape's first
// point flips a stencil bit under each of its triangles, which leaves the
// bit set where a point lies inside an odd count of shapes, and one quad
// over the copper's box fills where the bit is set and clears it.

import { NEAR, type Frame, Projector, focal, frameOf } from "../camera.ts";
import type { PathRef } from "../regroup.ts";
import type { SpeedMap } from "../speed.ts";
import type { Path } from "../types.ts";
import type { AnyCanvas, PaintInput } from "./canvas2d.ts";
import {
    type Circle,
    type Item,
    type Line,
    type LineSource,
    type Polyline,
    type RenderGroup,
    type RenderJob,
    cachedRuns,
    cutOrderOf,
    dotRadius,
    speedLines,
    spotOf,
} from "./scene.ts";

/** How the painter asks for its context: a stencil for copper, multisampled edges for the fills, no depth (everything is drawn in order). */
export const GL_ATTRIBUTES: WebGLContextAttributes = {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
};

/** A dot or a pad drawn smaller than this would vanish: 1.5 CSS px, as the 2D painter draws them. */
const LEAST_DOT_PX = 1.5;
/** Texels a row of a points texture: within the 2048 every WebGL2 allows. */
const ROW = 2048;

const parsed = new Map<string, [number, number, number, number]>();

/** A CSS color (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb() or rgba()) as red, green, blue and alpha in 0..1; anything else is a mid gray. */
export function parseColor(css: string): [number, number, number, number] {
    const known = parsed.get(css);
    if (known) {
        return known;
    }
    let rgba: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
    const text = css.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3,8})$/.exec(text);
    const call = /^rgba?\(([^)]*)\)$/.exec(text);
    if (hex) {
        const digits = hex[1]!;
        const short = digits.length === 3 || digits.length === 4;
        if (short || digits.length === 6 || digits.length === 8) {
            const part = (i: number): number => (short ? parseInt(digits[i]! + digits[i]!, 16) : parseInt(digits.slice(2 * i, 2 * i + 2), 16)) / 255;
            const count = short ? digits.length : digits.length / 2;
            rgba = [part(0), part(1), part(2), count === 4 ? part(3) : 1];
        }
    } else if (call) {
        const parts = call[1]!.split(/[\s,/]+/).filter((part) => part !== "");
        const channel = (part: string | undefined): number => (part === undefined ? 0 : part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part) / 255);
        const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
        rgba = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
    }
    if (rgba.some((value) => !Number.isFinite(value))) {
        rgba = [0.5, 0.5, 0.5, 1];
    }
    parsed.set(css, rgba);
    return rgba;
}

// The view as the 2D painter's Projector has it, in device px: the eye and
// its right, up and forward unit vectors, the focal length, and the point
// the view's axis meets the canvas at, from the top left. A point's or a
// dot's place in its texture, and the corners of the two triangles of a
// quad in the order its six vertices take them.
const COMMON = `
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform float uLens;
uniform vec2 uCenter;
uniform vec2 uSize;
const float NEAR = ${NEAR.toFixed(6)};
const int CORNER[6] = int[6](0, 1, 2, 2, 1, 3);

vec3 toView(vec3 p) {
    vec3 d = p - uEye;
    return vec3(dot(d, uRight), dot(d, uUp), dot(d, uForward));
}

vec2 toScreen(vec3 v) {
    return uCenter + uLens * vec2(v.x, -v.y) / v.z;
}

vec4 toClip(vec2 s) {
    return vec4(s.x / uSize.x * 2.0 - 1.0, 1.0 - s.y / uSize.y * 2.0, 0.0, 1.0);
}

vec4 texel(highp sampler2D points, int i) {
    int w = textureSize(points, 0).x;
    return texelFetch(points, ivec2(i % w, i / w), 0);
}
`;

// A segment between two points as a quad: world points projected (the end
// behind the eye moved up to the near plane), or points already on the
// screen with their distance along the line for the dashes. uFilter keeps
// the segments whose id is before uAt (1) or from it on (2): a path's id is
// its place in the cut order.
const LINE_VERTEX = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
uniform highp sampler2D uPoints;
uniform int uStart;
uniform bool uScreen;
uniform float uHalf;
uniform int uFilter;
uniform float uAt;
out vec2 vLocal;
out float vAlong;
flat out float vLength;

void hide() {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vLocal = vec2(0.0);
    vAlong = 0.0;
    vLength = 0.0;
}

void main() {
    int segment = uStart + gl_VertexID / 6;
    int corner = CORNER[gl_VertexID % 6];
    vec4 pa = texel(uPoints, segment);
    vec4 pb = texel(uPoints, segment + 1);
    if (pa.w != pb.w || (uFilter == 1 && pa.w >= uAt) || (uFilter == 2 && pa.w < uAt)) {
        hide();
        return;
    }
    vec2 a;
    vec2 b;
    float along0 = 0.0;
    if (uScreen) {
        a = pa.xy;
        b = pb.xy;
        along0 = pa.z;
    } else {
        vec3 va = toView(pa.xyz);
        vec3 vb = toView(pb.xyz);
        if (va.z <= NEAR && vb.z <= NEAR) {
            hide();
            return;
        }
        if (va.z < NEAR) {
            va = mix(va, vb, (NEAR - va.z) / (vb.z - va.z));
        } else if (vb.z < NEAR) {
            vb = mix(vb, va, (NEAR - vb.z) / (va.z - vb.z));
        }
        a = toScreen(va);
        b = toScreen(vb);
    }
    vec2 d = b - a;
    float len = length(d);
    vec2 u = len > 1e-6 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-u.y, u.x);
    float ext = uHalf + 1.0;
    float along = corner < 2 ? -ext : len + ext;
    float across = (corner & 1) == 0 ? -ext : ext;
    vLocal = vec2(along, across);
    vAlong = along0 + along;
    vLength = len;
    gl_Position = toClip(a + u * along + n * across);
}
`;

// Cover by the distance to the segment (to the nearest dash of it, with
// dashes), a device pixel of soft edge.
const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vAlong;
flat in float vLength;
uniform float uHalf;
uniform vec4 uColor;
uniform vec2 uDash;
out vec4 outColor;

void main() {
    float beyond = max(0.0, max(-vLocal.x, vLocal.x - vLength));
    if (uDash.x > 0.0) {
        float period = uDash.x + uDash.y;
        float w = mod(vAlong, period);
        beyond = max(beyond, w < uDash.x ? 0.0 : min(w - uDash.x, period - w));
    }
    float cover = clamp(uHalf + 0.5 - length(vec2(beyond, vLocal.y)), 0.0, 1.0);
    if (cover <= 0.0) {
        discard;
    }
    outColor = uColor * cover;
}
`;

// A dot or a ring: a job's dot (x, y, radius in mm, id) at a board point,
// at least uLeast device px, in uColor; or a circle already on the screen,
// two texels (x, y, radius and ring's half width in device px; its color).
const DOT_VERTEX = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
uniform highp sampler2D uPoints;
uniform int uStart;
uniform bool uScreen;
uniform float uScale;
uniform float uLeast;
uniform int uFilter;
uniform float uAt;
uniform vec4 uColor;
out vec2 vLocal;
flat out float vRadius;
flat out float vRing;
flat out vec4 vColor;

void main() {
    int index = uStart + gl_VertexID / 6;
    int corner = CORNER[gl_VertexID % 6];
    vec2 c;
    float r;
    float ring;
    if (uScreen) {
        vec4 circle = texel(uPoints, 2 * index);
        c = circle.xy;
        r = circle.z;
        ring = circle.w;
        vColor = texel(uPoints, 2 * index + 1);
    } else {
        vec4 dot = texel(uPoints, index);
        vec3 v = toView(vec3(dot.xy, 0.0));
        if (v.z <= NEAR || (uFilter == 1 && dot.w >= uAt) || (uFilter == 2 && dot.w < uAt)) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            vLocal = vec2(0.0);
            vRadius = 0.0;
            vRing = 0.0;
            vColor = vec4(0.0);
            return;
        }
        c = toScreen(v);
        r = max(dot.z * uScale, uLeast);
        ring = 0.0;
        vColor = uColor;
    }
    float ext = r + ring + 1.0;
    vLocal = vec2((corner & 1) == 0 ? -ext : ext, corner < 2 ? -ext : ext);
    vRadius = r;
    vRing = ring;
    gl_Position = toClip(c + vLocal);
}
`;

const DOT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vRadius;
flat in float vRing;
flat in vec4 vColor;
uniform float uAlpha;
out vec4 outColor;

void main() {
    float d = length(vLocal);
    float cover = vRing > 0.0 ? clamp(vRing + 0.5 - abs(d - vRadius), 0.0, 1.0) : clamp(vRadius + 0.5 - d, 0.0, 1.0);
    if (cover <= 0.0) {
        discard;
    }
    outColor = vColor * (cover * uAlpha);
}
`;

// Board points in clip space with the depth along the view as w, so the
// card clips a triangle at the near plane: the stencil fan and its cover.
const FILL_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPoint;
${COMMON}

void main() {
    vec3 v = toView(vec3(aPoint, 0.0));
    vec2 k = 2.0 * uLens / uSize;
    vec2 o = vec2(2.0 * uCenter.x / uSize.x - 1.0, 1.0 - 2.0 * uCenter.y / uSize.y);
    gl_Position = vec4(k.x * v.x + o.x * v.z, k.y * v.y + o.y * v.z, v.z - 2.0 * NEAR, v.z);
}
`;

const FILL_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;

void main() {
    outColor = uColor;
}
`;

// A layer laid on the picture pixel for pixel at an alpha, by one triangle
// over the whole canvas.
const LAYER_VERTEX = `#version 300 es
void main() {
    gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}
`;

const LAYER_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uLayer;
uniform float uAlpha;
out vec4 outColor;

void main() {
    outColor = texelFetch(uLayer, ivec2(gl_FragCoord.xy), 0) * uAlpha;
}
`;

/** An axis-aligned box: x0, y0, z0, x1, y1, z1; empty while x0 > x1. */
export type Box3 = Float64Array;

function emptyBox(): Box3 {
    return Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
}

function grow(box: Box3, x: number, y: number, z: number): void {
    box[0] = Math.min(box[0]!, x);
    box[1] = Math.min(box[1]!, y);
    box[2] = Math.min(box[2]!, z);
    box[3] = Math.max(box[3]!, x);
    box[4] = Math.max(box[4]!, y);
    box[5] = Math.max(box[5]!, z);
}

/** Lines as the line program reads them: x, y, z and an id a point; a line of one point is written twice, a dot. */
export interface LinePoints {
    data: Float32Array;
    points: number;
    box: Box3;
}

/** Dots as the dot program reads them: x, y, radius in mm and an id a dot; the box holds their centers, `widest` is the largest radius, mm. */
export interface DotPoints extends LinePoints {
    widest: number;
}

/**
 * Lines with their ids as one buffer of points. Ids must differ from one
 * line to the next, so no segment joins two of them.
 */
export function linePoints(lines: readonly (readonly [Line, number])[]): LinePoints {
    let points = 0;
    for (const [line] of lines) {
        points += line.length === 1 ? 2 : line.length;
    }
    const data = new Float32Array(points * 4);
    const box = emptyBox();
    let at = 0;
    const put = (point: readonly number[], id: number): void => {
        const x = point[0]!;
        const y = point[1]!;
        const z = point[2] ?? 0;
        data[at] = x;
        data[at + 1] = y;
        data[at + 2] = z;
        data[at + 3] = id;
        at += 4;
        grow(box, x, y, z);
    };
    for (const [line, id] of lines) {
        for (const point of line) {
            put(point, id);
        }
        if (line.length === 1) {
            put(line[0]!, id);
        }
    }
    return { data, points, box };
}

/** A group's dots as the dot program reads them: x, y, radius in mm and the path's id a dot. */
export function dotPoints(group: RenderGroup, spot: number, idOf: (path: number) => number): DotPoints {
    let count = 0;
    for (const path of group.paths) {
        if (path.length === 1) {
            count += 1;
        }
    }
    const data = new Float32Array(count * 4);
    const box = emptyBox();
    let at = 0;
    let widest = 0;
    group.paths.forEach((path, p) => {
        if (path.length !== 1) {
            return;
        }
        const [x, y] = path[0]!;
        const radius = dotRadius(group.areas?.[p], spot);
        data[at] = x;
        data[at + 1] = y;
        data[at + 2] = radius;
        data[at + 3] = idOf(p);
        at += 4;
        widest = Math.max(widest, radius);
        grow(box, x, y, 0);
    });
    return { data, points: count, box, widest };
}

/** Closed shapes as fans of triangles from each one's first point, for the even-odd stencil fill. */
export function fanTriangles(paths: readonly Path[]): { points: Float32Array; indices: Uint32Array; box: Box3 } {
    let pointCount = 0;
    let triangleCount = 0;
    for (const path of paths) {
        if (path.length >= 3) {
            pointCount += path.length;
            triangleCount += path.length - 2;
        }
    }
    const points = new Float32Array(pointCount * 2);
    const indices = new Uint32Array(triangleCount * 3);
    const box = emptyBox();
    let base = 0;
    let at = 0;
    for (const path of paths) {
        const n = path.length;
        if (n < 3) {
            continue;
        }
        path.forEach(([x, y], i) => {
            points[2 * (base + i)] = x;
            points[2 * (base + i) + 1] = y;
            grow(box, x, y, 0);
        });
        for (let i = 1; i < n - 1; i++) {
            indices[at] = base;
            indices[at + 1] = base + i;
            indices[at + 2] = base + i + 1;
            at += 3;
        }
        base += n;
    }
    return { points, indices, box };
}

/**
 * How a list of texels goes into textures of rows of `ROW`, at most
 * `maxRows` rows each: the texel each starts at and how many it holds.
 * Pieces of a line overlap by a texel, so the segment between two of them
 * is drawn by the first.
 */
export function texturePieces(texels: number, maxRows: number, overlap: boolean): { start: number; count: number }[] {
    const room = ROW * Math.max(1, maxRows);
    const step = overlap ? room - 1 : room;
    const pieces: { start: number; count: number }[] = [];
    for (let start = 0; start < texels; start += step) {
        pieces.push({ start, count: Math.min(room, texels - start) });
        if (start + room >= texels) {
            break;
        }
    }
    return pieces;
}

/** A growing list of floats, kept from frame to frame. */
class Floats {
    data = new Float32Array(4096);
    length = 0;

    push4(a: number, b: number, c: number, d: number): void {
        if (this.length + 4 > this.data.length) {
            const bigger = new Float32Array(this.data.length * 2);
            bigger.set(this.data);
            this.data = bigger;
        }
        this.data[this.length] = a;
        this.data[this.length + 1] = b;
        this.data[this.length + 2] = c;
        this.data[this.length + 3] = d;
        this.length += 4;
    }
}

/** A screen rectangle in device px, top left origin. */
interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Points of a frame's polylines or circles in the frame's textures, and the screen rectangle round them. */
interface Range {
    start: number;
    count: number;
    rect: Rect | null;
}

/** A texture of texels on the card, and how many it holds. */
interface Piece {
    texture: WebGLTexture;
    count: number;
}

/** Geometry on the card: textures of points (lines, dots) or buffers of a fill, its world box, and for dots their largest radius. */
interface Geometry {
    pieces: Piece[];
    box: Box3;
    /** For dots: the largest radius, mm. A dot is drawn as wide on the screen wherever it lies, so its room is taken there, not on the board. */
    widest?: number;
    /** For a fill: its buffers, the vertex arrays of its fan and of the quad over its box, and its index count. */
    fill?: { buffers: WebGLBuffer[]; fan: WebGLVertexArrayObject; cover: WebGLVertexArrayObject; indices: number };
}

class Program {
    readonly program: WebGLProgram;
    private readonly locations = new Map<string, WebGLUniformLocation | null>();
    /** The frame whose view this program's uniforms hold. */
    frame = -1;

    constructor(private readonly gl: WebGL2RenderingContext, vertex: string, fragment: string) {
        const program = gl.createProgram();
        if (!program) {
            throw new Error("no WebGL program");
        }
        for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
            const shader = gl.createShader(type);
            if (!shader) {
                throw new Error("no WebGL shader");
            }
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(`shader: ${gl.getShaderInfoLog(shader) ?? "does not compile"}`);
            }
            gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`program: ${gl.getProgramInfoLog(program) ?? "does not link"}`);
        }
        this.program = program;
    }

    at(name: string): WebGLUniformLocation | null {
        if (!this.locations.has(name)) {
            this.locations.set(name, this.gl.getUniformLocation(this.program, name));
        }
        return this.locations.get(name)!;
    }
}

/** The programs and the textures kept from frame to frame; made again after a lost context comes back. */
interface Resources {
    line: Program;
    dot: Program;
    fill: Program;
    layer: Program;
    /** The frame's polylines (x, y, along, id in device px) and circles (x, y, radius, ring half width, then the color). */
    lines: { texture: WebGLTexture; rows: number };
    circles: { texture: WebGLTexture; rows: number };
    /** A vertex array with nothing in it: the line, dot and layer programs fetch what they draw themselves. */
    emptyVao: WebGLVertexArrayObject;
}

/** The view of a frame, as the uniforms take it. */
interface View {
    frame: Frame;
    /** The 2D painter's projection, CSS px. */
    projector: Projector;
    dpr: number;
    lens: number;
    center: [number, number];
    width: number;
    height: number;
    /** Device px per mm at the target's depth. */
    scale: number;
}

export class WebGLPainter {
    readonly kind = "gl";
    private res: Resources;
    private lost = false;
    private frameCount = 0;
    private view: View | null = null;
    /** Rows a texture may have. */
    private readonly maxRows: number;
    /** The job's geometry, by what it is: a group's paths, dots or runs, the outline, the copper. */
    private jobGpu: { job: RenderJob; entries: Map<string, Geometry | null> } | null = null;
    private pickedGpu: { job: RenderJob; selection: PathRef[]; geometry: Geometry | null } | null = null;
    private speedGpu: { map: SpeedMap; entries: Map<string, Geometry | null> } | null = null;
    /** The layer a translucent set is drawn into. */
    private target: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
    private readonly lines = new Floats();
    private readonly circles = new Floats();
    private readonly onLost = (event: Event): void => {
        event.preventDefault();
        this.lost = true;
    };
    private readonly onRestored = (): void => {
        this.jobGpu = null;
        this.pickedGpu = null;
        this.speedGpu = null;
        this.target = null;
        this.res = this.resources();
        this.lost = false;
        this.restored();
    };

    /** `restored` is called when a lost context comes back, to have the picture drawn again. */
    constructor(private readonly gl: WebGL2RenderingContext, private readonly canvas: AnyCanvas, private readonly restored: () => void) {
        this.maxRows = Math.max(1, Math.floor(Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || ROW));
        this.res = this.resources();
        canvas.addEventListener("webglcontextlost", this.onLost);
        canvas.addEventListener("webglcontextrestored", this.onRestored);
    }

    paint(input: PaintInput): void {
        const gl = this.gl;
        if (this.lost || gl.isContextLost()) {
            return;
        }
        const { state, scene } = input;
        this.frameCount += 1;
        const dpr = state.dpr;
        this.view = {
            frame: frameOf(state.camera),
            projector: input.view,
            dpr,
            lens: focal(state.height) * dpr,
            center: [(state.width / 2) * dpr, (state.height / 2) * dpr],
            width: gl.drawingBufferWidth,
            height: gl.drawingBufferHeight,
            scale: input.scale * dpr,
        };
        if (this.jobGpu !== null && this.jobGpu.job !== state.job) {
            this.jobGpu.entries.forEach((geometry) => this.release(geometry));
            this.jobGpu = null;
        }
        if (this.pickedGpu !== null && (this.pickedGpu.job !== state.job || this.pickedGpu.selection !== state.selection)) {
            this.release(this.pickedGpu.geometry);
            this.pickedGpu = null;
        }
        const items = [...scene.board, ...scene.rail, ...scene.work];
        const ranges = this.upload(items);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.view.width, this.view.height);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);
        gl.colorMask(true, true, true, true);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const [r, g, b] = parseColor(state.colors.bg);
        gl.clearColor(r, g, b, 1);
        gl.clearStencil(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        // Translucent items in a row of one color and alpha share a layer:
        // a group's lines and its dots are one set.
        for (let i = 0; i < items.length;) {
            const key = unionKey(items[i]!);
            let j = i + 1;
            while (key !== null && j < items.length && unionKey(items[j]!) === key) {
                j += 1;
            }
            if (key === null) {
                this.draw(items[i]!, input, ranges, false);
            } else {
                this.drawUnion(items.slice(i, j), input, ranges);
            }
            i = j;
        }
        gl.bindVertexArray(null);
    }

    /** The picture as drawn, top row first, for checks; call in the same task as `paint`. */
    readPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
        const gl = this.gl;
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const raw = new Uint8Array(width * height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const pixels = new Uint8ClampedArray(raw.length);
        const row = width * 4;
        for (let y = 0; y < height; y++) {
            pixels.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        }
        return { width, height, pixels };
    }

    dispose(): void {
        this.canvas.removeEventListener("webglcontextlost", this.onLost);
        this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }

    private resources(): Resources {
        const gl = this.gl;
        const emptyVao = gl.createVertexArray();
        if (!emptyVao) {
            throw new Error("no WebGL vertex array");
        }
        return {
            line: new Program(gl, LINE_VERTEX, LINE_FRAGMENT),
            dot: new Program(gl, DOT_VERTEX, DOT_FRAGMENT),
            fill: new Program(gl, FILL_VERTEX, FILL_FRAGMENT),
            layer: new Program(gl, LAYER_VERTEX, LAYER_FRAGMENT),
            lines: { texture: this.texture(), rows: 0 },
            circles: { texture: this.texture(), rows: 0 },
            emptyVao,
        };
    }

    /** A float texture read texel by texel. */
    private texture(): WebGLTexture {
        const gl = this.gl;
        const texture = gl.createTexture();
        if (!texture) {
            throw new Error("no WebGL texture");
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    /** Fills a texture with `texels` texels of `data` (four floats each), rows of `ROW` (one shorter row for fewer). */
    private fillTexture(texture: WebGLTexture, data: Float32Array, texels: number): number {
        const gl = this.gl;
        const width = Math.min(ROW, Math.max(1, texels));
        const rows = Math.max(1, Math.ceil(texels / width));
        let pixels = data.subarray(0, texels * 4);
        if (pixels.length < width * rows * 4) {
            const padded = new Float32Array(width * rows * 4);
            padded.set(pixels);
            pixels = padded;
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, rows, 0, gl.RGBA, gl.FLOAT, pixels);
        return rows;
    }

    /** Takes a program into use with the frame's view in its uniforms. */
    private use(program: Program): Program {
        const gl = this.gl;
        gl.useProgram(program.program);
        const view = this.view!;
        if (program.frame !== this.frameCount && program !== this.res.layer) {
            const { eye, right, up, forward } = view.frame;
            gl.uniform3f(program.at("uEye"), eye[0], eye[1], eye[2]);
            gl.uniform3f(program.at("uRight"), right[0], right[1], right[2]);
            gl.uniform3f(program.at("uUp"), up[0], up[1], up[2]);
            gl.uniform3f(program.at("uForward"), forward[0], forward[1], forward[2]);
            gl.uniform1f(program.at("uLens"), view.lens);
            gl.uniform2f(program.at("uCenter"), view.center[0], view.center[1]);
            gl.uniform2f(program.at("uSize"), view.width, view.height);
            gl.uniform1i(program.at("uPoints"), 0);
        }
        program.frame = this.frameCount;
        return program;
    }

    /** Projects the frame's polylines and circles and sends them to the card, a texture each. */
    private upload(items: readonly Item[]): Map<Item, Range> {
        const ranges = new Map<Item, Range>();
        this.lines.length = 0;
        this.circles.length = 0;
        let id = 0;
        const at = new Float64Array(2);
        for (const item of items) {
            if (item.kind === "polylines") {
                const start = this.lines.length / 4;
                const rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
                for (const line of item.lines) {
                    id = this.writePolyline(line, id, at, rect);
                }
                const count = this.lines.length / 4 - start;
                ranges.set(item, { start, count, rect: rect.x0 <= rect.x1 ? rect : null });
            } else if (item.kind === "circles") {
                const start = this.circles.length / 8;
                for (const circle of item.circles) {
                    this.writeCircle(circle, at);
                }
                ranges.set(item, { start, count: this.circles.length / 8 - start, rect: null });
            }
        }
        if (this.lines.length > 0) {
            this.res.lines.rows = this.fillTexture(this.res.lines.texture, this.lines.data, this.lines.length / 4);
        }
        if (this.circles.length > 0) {
            this.res.circles.rows = this.fillTexture(this.res.circles.texture, this.circles.data, this.circles.length / 4);
        }
        return ranges;
    }

    /**
     * One polyline into the frame's line texture in device px, each run
     * between lifts of the pen (a null, a point behind the eye) a line of
     * its own id, its distance along it restarting there as a 2D dash does;
     * a closed one goes back to its first point unless it broke, and one of
     * a single point is a dot. Returns the next free id.
     */
    private writePolyline(line: Polyline, id: number, at: Float64Array, rect: Rect): number {
        const { projector, dpr } = this.view!;
        const points = line.points;
        const put = (x: number, y: number, along: number, run: number): void => {
            this.lines.push4(x, y, along, run);
            rect.x0 = Math.min(rect.x0, x);
            rect.y0 = Math.min(rect.y0, y);
            rect.x1 = Math.max(rect.x1, x);
            rect.y1 = Math.max(rect.y1, y);
        };
        if (points.length === 1) {
            const point = points[0];
            if (point && projector.into(point[0], point[1], point[2], at)) {
                put(at[0]! * dpr, at[1]! * dpr, 0, id);
                put(at[0]! * dpr, at[1]! * dpr, 0, id);
            }
            return id + 1;
        }
        let pen = false;
        let broken = false;
        let started = false;
        let along = 0;
        let lastX = 0;
        let lastY = 0;
        let firstX = 0;
        let firstY = 0;
        for (const point of points) {
            if (!point || !projector.into(point[0], point[1], point[2], at)) {
                if (pen) {
                    id += 1;
                }
                pen = false;
                broken = true;
                continue;
            }
            const x = at[0]! * dpr;
            const y = at[1]! * dpr;
            if (pen) {
                along += Math.hypot(x - lastX, y - lastY);
            } else {
                along = 0;
                pen = true;
                if (!started) {
                    started = true;
                    firstX = x;
                    firstY = y;
                }
            }
            put(x, y, along, id);
            lastX = x;
            lastY = y;
        }
        if (line.closed && pen && started && !broken) {
            put(firstX, firstY, along + Math.hypot(firstX - lastX, firstY - lastY), id);
        }
        return id + 1;
    }

    /** One circle into the frame's circle texture in device px, its color premultiplied; left out behind the eye. */
    private writeCircle(circle: Circle, at: Float64Array): void {
        const { projector, dpr } = this.view!;
        if (!projector.into(circle.at[0], circle.at[1], circle.at[2], at)) {
            return;
        }
        const [r, g, b, a] = parseColor(circle.color);
        this.circles.push4(at[0]! * dpr, at[1]! * dpr, circle.radius * dpr, circle.stroke !== undefined ? (circle.stroke / 2) * dpr : 0);
        this.circles.push4(r * a, g * a, b * a, a);
    }

    /** Draws one item onto the frame buffer bound; `opaque` draws it at full strength, for a layer laid on at its alpha. */
    private draw(item: Item, input: PaintInput, ranges: Map<Item, Range>, opaque: boolean): void {
        const gl = this.gl;
        const view = this.view!;
        gl.bindVertexArray(this.res.emptyVao);
        gl.activeTexture(gl.TEXTURE0);
        switch (item.kind) {
            case "lines": {
                const geometry = this.lineGeometry(item.source, input);
                if (!geometry) {
                    return;
                }
                const program = this.use(this.res.line);
                this.lineInk(program, item.ink.color, opaque ? 1 : item.ink.alpha, item.ink.width, item.ink.dash);
                gl.uniform1i(program.at("uScreen"), 0);
                gl.uniform1i(program.at("uStart"), 0);
                this.filter(program, item.source, input);
                for (const piece of geometry.pieces) {
                    if (piece.count >= 2) {
                        gl.bindTexture(gl.TEXTURE_2D, piece.texture);
                        gl.drawArrays(gl.TRIANGLES, 0, 6 * (piece.count - 1));
                    }
                }
                return;
            }
            case "polylines": {
                const range = ranges.get(item);
                if (!range || range.count < 2) {
                    return;
                }
                const program = this.use(this.res.line);
                this.lineInk(program, item.ink.color, opaque ? 1 : item.ink.alpha, item.ink.width, item.ink.dash);
                gl.uniform1i(program.at("uScreen"), 1);
                gl.uniform1i(program.at("uFilter"), 0);
                gl.uniform1i(program.at("uStart"), range.start);
                gl.bindTexture(gl.TEXTURE_2D, this.res.lines.texture);
                gl.drawArrays(gl.TRIANGLES, 0, 6 * (range.count - 1));
                return;
            }
            case "dots": {
                const geometry = this.dotGeometry(item.group, input);
                if (!geometry) {
                    return;
                }
                const program = this.use(this.res.dot);
                const [r, g, b] = parseColor(item.color);
                gl.uniform1i(program.at("uScreen"), 0);
                gl.uniform1i(program.at("uStart"), 0);
                gl.uniform1f(program.at("uScale"), view.scale);
                gl.uniform1f(program.at("uLeast"), LEAST_DOT_PX * view.dpr);
                gl.uniform1f(program.at("uAlpha"), opaque ? 1 : item.alpha);
                gl.uniform4f(program.at("uColor"), r, g, b, 1);
                const start = cutOrderOf(input.state.job).start[item.group] ?? -1;
                const filter = start < 0 ? 0 : item.filter.kind === "before" ? 1 : item.filter.kind === "from" ? 2 : 0;
                gl.uniform1i(program.at("uFilter"), filter);
                gl.uniform1f(program.at("uAt"), item.filter.kind === "all" ? 0 : item.filter.at);
                for (const piece of geometry.pieces) {
                    gl.bindTexture(gl.TEXTURE_2D, piece.texture);
                    gl.drawArrays(gl.TRIANGLES, 0, 6 * piece.count);
                }
                return;
            }
            case "circles": {
                const range = ranges.get(item);
                if (!range || range.count < 1) {
                    return;
                }
                const program = this.use(this.res.dot);
                gl.uniform1i(program.at("uScreen"), 1);
                gl.uniform1i(program.at("uFilter"), 0);
                gl.uniform1i(program.at("uStart"), range.start);
                gl.uniform1f(program.at("uAlpha"), opaque ? 1 : item.alpha);
                gl.bindTexture(gl.TEXTURE_2D, this.res.circles.texture);
                gl.drawArrays(gl.TRIANGLES, 0, 6 * range.count);
                return;
            }
            case "copper": {
                const fill = this.copperGeometry(input)?.fill;
                if (!fill || fill.indices < 3) {
                    return;
                }
                const program = this.use(this.res.fill);
                const [r, g, b] = parseColor(item.color);
                gl.enable(gl.STENCIL_TEST);
                gl.stencilMask(1);
                gl.colorMask(false, false, false, false);
                gl.stencilFunc(gl.ALWAYS, 0, 1);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
                gl.bindVertexArray(fill.fan);
                gl.drawElements(gl.TRIANGLES, fill.indices, gl.UNSIGNED_INT, 0);
                gl.colorMask(true, true, true, true);
                gl.stencilFunc(gl.EQUAL, 1, 1);
                gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
                gl.uniform4f(program.at("uColor"), r * item.alpha, g * item.alpha, b * item.alpha, item.alpha);
                gl.bindVertexArray(fill.cover);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                gl.disable(gl.STENCIL_TEST);
                return;
            }
        }
    }

    private lineInk(program: Program, color: string, alpha: number, width: number, dash: readonly [number, number] | undefined): void {
        const gl = this.gl;
        const dpr = this.view!.dpr;
        const [r, g, b] = parseColor(color);
        gl.uniform4f(program.at("uColor"), r * alpha, g * alpha, b * alpha, alpha);
        gl.uniform1f(program.at("uHalf"), (width / 2) * dpr);
        gl.uniform2f(program.at("uDash"), dash ? dash[0] * dpr : 0, dash ? dash[1] * dpr : 0);
    }

    /** The cut order filter of a group's paths; their ids are their places in the cut order only while the group is on. */
    private filter(program: Program, source: LineSource, input: PaintInput): void {
        const gl = this.gl;
        let mode = 0;
        let at = 0;
        if (source.kind === "paths" && source.filter.kind !== "all" && (cutOrderOf(input.state.job).start[source.group] ?? -1) >= 0) {
            mode = source.filter.kind === "before" ? 1 : 2;
            at = source.filter.at;
        }
        gl.uniform1i(program.at("uFilter"), mode);
        gl.uniform1f(program.at("uAt"), at);
    }

    /** A translucent set: drawn opaque into the layer, strongest cover kept, then laid on the picture at its alpha. */
    private drawUnion(items: readonly Item[], input: PaintInput, ranges: Map<Item, Range>): void {
        const gl = this.gl;
        const view = this.view!;
        let rect: Rect | null = null;
        for (const item of items) {
            const part = this.rectOf(item, input, ranges);
            if (part !== null) {
                rect = rect === null ? part : { x0: Math.min(rect.x0, part.x0), y0: Math.min(rect.y0, part.y0), x1: Math.max(rect.x1, part.x1), y1: Math.max(rect.y1, part.y1) };
            }
        }
        const x0 = Math.max(0, Math.floor(rect?.x0 ?? 0));
        const y0 = Math.max(0, Math.floor(rect?.y0 ?? 0));
        const x1 = Math.min(view.width, Math.ceil(rect?.x1 ?? 0));
        const y1 = Math.min(view.height, Math.ceil(rect?.y1 ?? 0));
        if (rect === null || x1 <= x0 || y1 <= y0) {
            return;
        }
        const target = this.layerTarget();
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x0, view.height - y1, x1 - x0, y1 - y0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.blendEquation(gl.MAX);
        for (const item of items) {
            this.draw(item, input, ranges, true);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const layer = this.use(this.res.layer);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.uniform1i(layer.at("uLayer"), 0);
        gl.uniform1f(layer.at("uAlpha"), alphaOf(items[0]!));
        gl.bindVertexArray(this.res.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.SCISSOR_TEST);
    }

    /** The layer for translucent sets, the size of the drawing buffer. */
    private layerTarget(): { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } {
        const gl = this.gl;
        const { width, height } = this.view!;
        if (this.target && this.target.width === width && this.target.height === height) {
            return this.target;
        }
        if (this.target) {
            gl.deleteFramebuffer(this.target.framebuffer);
            gl.deleteTexture(this.target.texture);
        }
        const texture = this.texture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) {
            throw new Error("no WebGL framebuffer");
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.target = { framebuffer, texture, width, height };
        return this.target;
    }

    /** Where an item lands on the screen, device px, with room for its width; null for nothing on it. */
    private rectOf(item: Item, input: PaintInput, ranges: Map<Item, Range>): Rect | null {
        const view = this.view!;
        switch (item.kind) {
            case "lines": {
                const geometry = this.lineGeometry(item.source, input);
                return geometry ? this.project(geometry.box, (item.ink.width / 2) * view.dpr + 2) : null;
            }
            case "dots": {
                const geometry = this.dotGeometry(item.group, input);
                return geometry ? this.project(geometry.box, Math.max((geometry.widest ?? 0) * view.scale, LEAST_DOT_PX * view.dpr) + 2) : null;
            }
            case "polylines": {
                const rect = ranges.get(item)?.rect ?? null;
                const pad = (item.ink.width / 2) * view.dpr + 2;
                return rect === null ? null : { x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
            }
            default:
                return { x0: 0, y0: 0, x1: view.width, y1: view.height };
        }
    }

    /** The screen rectangle round a world box, device px; the whole canvas when a corner is behind the eye. */
    private project(box: Box3, pad: number): Rect | null {
        const view = this.view!;
        if (!(box[0]! <= box[3]!)) {
            return null;
        }
        const at = new Float64Array(2);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let corner = 0; corner < 8; corner++) {
            const x = corner & 1 ? box[3]! : box[0]!;
            const y = corner & 2 ? box[4]! : box[1]!;
            const z = corner & 4 ? box[5]! : box[2]!;
            if (!view.projector.into(x, y, z, at)) {
                return { x0: 0, y0: 0, x1: view.width, y1: view.height };
            }
            x0 = Math.min(x0, at[0]!);
            y0 = Math.min(y0, at[1]!);
            x1 = Math.max(x1, at[0]!);
            y1 = Math.max(y1, at[1]!);
        }
        return { x0: x0 * view.dpr - pad, y0: y0 * view.dpr - pad, x1: x1 * view.dpr + pad, y1: y1 * view.dpr + pad };
    }

    /** The job's geometry kept under `key`, made by `make` the first time. */
    private kept(job: RenderJob, key: string, make: () => Geometry | null): Geometry | null {
        if (this.jobGpu === null || this.jobGpu.job !== job) {
            this.jobGpu?.entries.forEach((geometry) => this.release(geometry));
            this.jobGpu = { job, entries: new Map() };
        }
        const entries = this.jobGpu.entries;
        if (!entries.has(key)) {
            entries.set(key, make());
        }
        return entries.get(key)!;
    }

    private lineGeometry(source: LineSource, input: PaintInput): Geometry | null {
        const { state, speeds } = input;
        const job = state.job;
        if (job === null) {
            return null;
        }
        switch (source.kind) {
            case "paths":
                return this.kept(job, `paths ${source.group}`, () => {
                    const group = job.groups[source.group];
                    if (!group) {
                        return null;
                    }
                    const start = cutOrderOf(job).start[source.group] ?? -1;
                    const lines: [Line, number][] = [];
                    group.paths.forEach((path, p) => {
                        if (path.length !== 1) {
                            lines.push([path, start >= 0 ? start + p : p]);
                        }
                    });
                    return this.lineTextures(linePoints(lines));
                });
            case "runs":
                return this.kept(job, `runs ${source.group}`, () =>
                    this.lineTextures(linePoints(cachedRuns(job.groups[source.group]?.moves ?? []).map((run, index) => [run, index] as [Line, number]))));
            case "outline":
                return this.kept(job, "outline", () => this.lineTextures(linePoints(job.outline.map((path, index) => [path, index] as [Line, number]))));
            case "picked": {
                const kept = this.pickedGpu;
                if (kept && kept.job === job && kept.selection === state.selection) {
                    return kept.geometry;
                }
                if (kept) {
                    this.release(kept.geometry);
                }
                const lines: [Line, number][] = [];
                state.selection.forEach(([g, p], index) => {
                    const path = job.groups[g]?.paths[p];
                    if (path) {
                        lines.push([path, index]);
                    }
                });
                this.pickedGpu = { job, selection: state.selection, geometry: this.lineTextures(linePoints(lines)) };
                return this.pickedGpu.geometry;
            }
            case "speed": {
                if (speeds === null) {
                    return null;
                }
                if (this.speedGpu === null || this.speedGpu.map !== speeds) {
                    this.speedGpu?.entries.forEach((geometry) => this.release(geometry));
                    this.speedGpu = { map: speeds, entries: new Map() };
                }
                const key = String(source.bucket);
                const entries = this.speedGpu.entries;
                if (!entries.has(key)) {
                    const lines = speedLines(speeds);
                    const set = source.bucket === null ? lines.capped : lines.buckets[source.bucket] ?? [];
                    entries.set(key, this.lineTextures(linePoints(set.map((line, index) => [line, index] as [Line, number]))));
                }
                return entries.get(key)!;
            }
        }
    }

    private dotGeometry(group: number, input: PaintInput): Geometry | null {
        const job = input.state.job;
        if (job === null) {
            return null;
        }
        return this.kept(job, `dots ${group}`, () => {
            const held = job.groups[group];
            if (!held) {
                return null;
            }
            const start = cutOrderOf(job).start[group] ?? -1;
            const dots = dotPoints(held, spotOf(job), (p) => (start >= 0 ? start + p : p));
            if (dots.points === 0) {
                return null;
            }
            return { pieces: this.pieces(dots.data, dots.points, false), box: dots.box, widest: dots.widest };
        });
    }

    private copperGeometry(input: PaintInput): Geometry | null {
        const job = input.state.job;
        if (job === null) {
            return null;
        }
        return this.kept(job, "copper", () => {
            const fan = fanTriangles(job.copper);
            if (fan.indices.length === 0) {
                return null;
            }
            const gl = this.gl;
            const points = gl.createBuffer()!;
            const indices = gl.createBuffer()!;
            const vao = gl.createVertexArray()!;
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, points);
            gl.bufferData(gl.ARRAY_BUFFER, fan.points, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, fan.indices, gl.STATIC_DRAW);
            const [x0, y0, , x1, y1] = fan.box;
            const corners = gl.createBuffer()!;
            const cover = gl.createVertexArray()!;
            gl.bindVertexArray(cover);
            gl.bindBuffer(gl.ARRAY_BUFFER, corners);
            gl.bufferData(gl.ARRAY_BUFFER, Float32Array.of(x0!, y0!, x1!, y0!, x0!, y1!, x1!, y1!), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
            gl.bindVertexArray(null);
            return { pieces: [], box: fan.box, fill: { buffers: [points, indices, corners], fan: vao, cover, indices: fan.indices.length } };
        });
    }

    /** Lines onto the card as textures of points; null when there is no segment. */
    private lineTextures(points: LinePoints): Geometry | null {
        if (points.points < 2) {
            return null;
        }
        return { pieces: this.pieces(points.data, points.points, true), box: points.box };
    }

    /** Texels into as many textures as they need, each as tall as the card allows; pieces of lines overlap by one. */
    private pieces(data: Float32Array, texels: number, overlap: boolean): Piece[] {
        return texturePieces(texels, this.maxRows, overlap).map(({ start, count }) => {
            const texture = this.texture();
            this.fillTexture(texture, data.subarray(start * 4, (start + count) * 4), count);
            return { texture, count };
        });
    }

    private release(geometry: Geometry | null): void {
        if (geometry === null) {
            return;
        }
        const gl = this.gl;
        for (const piece of geometry.pieces) {
            gl.deleteTexture(piece.texture);
        }
        if (geometry.fill) {
            geometry.fill.buffers.forEach((buffer) => gl.deleteBuffer(buffer));
            gl.deleteVertexArray(geometry.fill.fan);
            gl.deleteVertexArray(geometry.fill.cover);
        }
    }
}

/** Translucent sets of lines and dots go through the layer, those of one color and alpha together; null draws an item straight on. */
function unionKey(item: Item): string | null {
    switch (item.kind) {
        case "lines":
        case "polylines":
            return item.ink.alpha < 1 ? `${item.ink.color} ${item.ink.alpha}` : null;
        case "dots":
            return item.alpha < 1 ? `${item.color} ${item.alpha}` : null;
        default:
            return null;
    }
}

function alphaOf(item: Item): number {
    switch (item.kind) {
        case "lines":
        case "polylines":
            return item.ink.alpha;
        default:
            return item.alpha;
    }
}
