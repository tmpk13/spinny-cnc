// The preview's camera: an orbit about a target on the board, projecting
// board mm (X right, Y up the board, Z out of it toward the head) onto
// the canvas with a little perspective. Pure functions, so the view math
// tests without a canvas.

export type Vec3 = [number, number, number];

export interface Camera {
    /** The point looked at, mm. */
    target: Vec3;
    /** From the target to the eye, mm. */
    distance: number;
    /** Azimuth in degrees: 0 looks along +Y from the -Y side of the target, positive turns the eye counterclockwise seen from above. */
    yaw: number;
    /** Elevation of the eye above the board plane in degrees: 90 is straight down. */
    pitch: number;
}

/** A point on the canvas in CSS px, and its depth along the view, mm. */
export interface Projected {
    x: number;
    y: number;
    depth: number;
}

export const FOV_DEG = 40;
export const MIN_PITCH = 5;
export const MAX_PITCH = 90;
export const MIN_DISTANCE = 2;
export const MAX_DISTANCE = 100_000;
/** The overview: tilted enough to read as a scene, steep enough to read the board. */
export const OVERVIEW_PITCH = 60;
export const OVERVIEW_YAW = 0;
/** Room around the reach in the overview, as a factor on it. */
export const FIT_MARGIN = 1.1;
/** Degrees of orbit per CSS px dragged. */
export const DEG_PER_PX = 0.4;
/** Nothing closer to the eye than this along the view is drawn, mm. */
const NEAR = 0.05;

const DEG = Math.PI / 180;

export function clampPitch(pitch: number): number {
    return Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
}

export function clampDistance(distance: number): number {
    return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance));
}

/** The eye, and the view's right, up and forward unit vectors. */
export interface Frame {
    eye: Vec3;
    right: Vec3;
    up: Vec3;
    forward: Vec3;
}

export function frameOf(camera: Camera): Frame {
    const yaw = camera.yaw * DEG;
    const pitch = clampPitch(camera.pitch) * DEG;
    // From the target to the eye.
    const out: Vec3 = [Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
    const eye: Vec3 = [
        camera.target[0] + out[0] * camera.distance,
        camera.target[1] + out[1] * camera.distance,
        camera.target[2] + out[2] * camera.distance,
    ];
    const forward: Vec3 = [-out[0], -out[1], -out[2]];
    // The right vector comes from the yaw alone, so a view straight down
    // keeps a direction.
    const right: Vec3 = [Math.cos(yaw), Math.sin(yaw), 0];
    const up = cross(right, forward);
    return { eye, right, up, forward };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Focal length in CSS px for a canvas `height` px tall. */
export function focal(height: number): number {
    return (height / 2) / Math.tan((FOV_DEG / 2) * DEG);
}

/** Where a world point lands on the canvas; null behind the eye. */
export function project(frame: Frame, width: number, height: number, point: Vec3): Projected | null {
    const d: Vec3 = [point[0] - frame.eye[0], point[1] - frame.eye[1], point[2] - frame.eye[2]];
    const depth = dot(d, frame.forward);
    if (depth <= NEAR) {
        return null;
    }
    const f = focal(height);
    return {
        x: width / 2 + f * dot(d, frame.right) / depth,
        y: height / 2 - f * dot(d, frame.up) / depth,
        depth,
    };
}

/** The point of the plane z = `planeZ` under a canvas point; null when the ray misses it (looking at the sky). */
export function unproject(frame: Frame, width: number, height: number, sx: number, sy: number, planeZ = 0): Vec3 | null {
    const f = focal(height);
    const u = (sx - width / 2) / f;
    const v = -(sy - height / 2) / f;
    const ray: Vec3 = [
        frame.forward[0] + frame.right[0] * u + frame.up[0] * v,
        frame.forward[1] + frame.right[1] * u + frame.up[1] * v,
        frame.forward[2] + frame.right[2] * u + frame.up[2] * v,
    ];
    if (Math.abs(ray[2]) < 1e-9) {
        return null;
    }
    const t = (planeZ - frame.eye[2]) / ray[2];
    if (t <= 0) {
        return null;
    }
    return [frame.eye[0] + ray[0] * t, frame.eye[1] + ray[1] * t, planeZ];
}

/** CSS px per mm at the target's depth: what a length on the board there measures on the canvas. */
export function pxPerMm(camera: Camera, height: number): number {
    return focal(height) / camera.distance;
}

export function orbit(camera: Camera, dx: number, dy: number): Camera {
    return {
        ...camera,
        yaw: ((camera.yaw + dx * DEG_PER_PX) % 360 + 360) % 360,
        pitch: clampPitch(camera.pitch + dy * DEG_PER_PX),
    };
}

/**
 * Moves the target so the board point that was under `from` is under
 * `to`. A drag across the horizon, or one that would throw the target
 * off by more than the view is wide, is taken as far as makes sense.
 */
export function pan(camera: Camera, width: number, height: number, from: [number, number], to: [number, number]): Camera {
    const frame = frameOf(camera);
    const planeZ = camera.target[2];
    const a = unproject(frame, width, height, from[0], from[1], planeZ);
    const b = unproject(frame, width, height, to[0], to[1], planeZ);
    if (!a || !b) {
        return camera;
    }
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    const limit = camera.distance * 4;
    const moved = Math.hypot(dx, dy);
    if (moved > limit) {
        dx *= limit / moved;
        dy *= limit / moved;
    }
    return { ...camera, target: [camera.target[0] + dx, camera.target[1] + dy, planeZ] };
}

/** Zooms by `factor` (above 1 is closer) keeping the board point under the canvas point still. */
export function zoomAt(camera: Camera, width: number, height: number, sx: number, sy: number, factor: number): Camera {
    const before = unproject(frameOf(camera), width, height, sx, sy, camera.target[2]);
    const zoomed = { ...camera, distance: clampDistance(camera.distance / factor) };
    const after = unproject(frameOf(zoomed), width, height, sx, sy, camera.target[2]);
    if (!before || !after) {
        return zoomed;
    }
    return {
        ...zoomed,
        target: [zoomed.target[0] + before[0] - after[0], zoomed.target[1] + before[1] - after[1], zoomed.target[2]],
    };
}

/** Every point inside the canvas, with `margin` px to spare. */
function allInside(camera: Camera, width: number, height: number, points: Vec3[], margin: number): boolean {
    const frame = frameOf(camera);
    for (const point of points) {
        const p = project(frame, width, height, point);
        if (!p || p.x < margin || p.x > width - margin || p.y < margin || p.y > height - margin) {
            return false;
        }
    }
    return true;
}

/** The nearest distance from which every point fits on the canvas, for a camera otherwise given. */
export function fitDistance(camera: Camera, width: number, height: number, points: Vec3[], margin = 0): number {
    let low = MIN_DISTANCE;
    let high = MAX_DISTANCE;
    if (!allInside({ ...camera, distance: high }, width, height, points, margin)) {
        return high;
    }
    for (let step = 0; step < 48; step++) {
        const mid = Math.sqrt(low * high);
        if (allInside({ ...camera, distance: mid }, width, height, points, margin)) {
            high = mid;
        } else {
            low = mid;
        }
    }
    return high;
}

/** A ring of points on the board about the axis. */
export function circlePoints(radius: number, count = 48, z = 0): Vec3[] {
    const points: Vec3[] = [];
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        points.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
    return points;
}

/** The overview: the axis in the middle, tilted, far enough back that a circle of `reach` fits. */
export function overview(reach: number, width: number, height: number): Camera {
    const base: Camera = { target: [0, 0, 0], distance: MIN_DISTANCE, yaw: OVERVIEW_YAW, pitch: OVERVIEW_PITCH };
    const radius = Math.max(reach, 1) * FIT_MARGIN;
    const points = [...circlePoints(radius), ...circlePoints(radius, 48, radius * 0.15)];
    return { ...base, distance: fitDistance(base, Math.max(width, 1), Math.max(height, 1), points, 4) };
}

export function sameCamera(a: Camera, b: Camera): boolean {
    return a.distance === b.distance && a.yaw === b.yaw && a.pitch === b.pitch
        && a.target[0] === b.target[0] && a.target[1] === b.target[1] && a.target[2] === b.target[2];
}
