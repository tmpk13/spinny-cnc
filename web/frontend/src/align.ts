// Lining a job up with the board on the table: the rigid fit of design
// points to the board points the machine found them at. The backend
// computes the same fit; the page has it for the in-page mock and so a
// reader of the panel can check a number by hand.

export type Pair = { design: [number, number]; machine: [number, number] };

export interface RigidFit {
    /** Degrees counterclockwise about the origin, applied before the shift. */
    rotation: number;
    shift: [number, number];
    /** How much larger the machine's spread is than the design's; reported, never applied. */
    scale: number;
    rms: number;
    /** Each pair's distance from where the fit puts its design point. */
    residuals: number[];
}

/** A point turned counterclockwise by `degrees` about the origin. */
export function turnPoint(point: [number, number], degrees: number): [number, number] {
    const radians = (degrees * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return [point[0] * c - point[1] * s, point[0] * s + point[1] * c];
}

/**
 * Least squares turn and shift that carries the design points onto the
 * machine points: both sets are centered on their centroids, the turn is
 * atan2 of the sum of the cross products and the sum of the dot products of
 * the centered pairs, the scale is the root of the ratio of their spreads,
 * and the shift is the machine centroid less the turned design centroid.
 * One pair gives a shift alone; `fixedRotation` makes any count a shift at
 * that turn, for a lone camera mark that saw the board's angle.
 */
export function fitRigid(pairs: Pair[], fixedRotation: number | null = null): RigidFit {
    if (pairs.length === 0) {
        throw new Error("no marks to fit");
    }
    const n = pairs.length;
    const centroid = (pick: (pair: Pair) => [number, number]): [number, number] => {
        let x = 0;
        let y = 0;
        for (const pair of pairs) {
            const [px, py] = pick(pair);
            x += px;
            y += py;
        }
        return [x / n, y / n];
    };
    const designCenter = centroid((pair) => pair.design);
    const machineCenter = centroid((pair) => pair.machine);
    let cross = 0;
    let dot = 0;
    let designSpread = 0;
    let machineSpread = 0;
    for (const pair of pairs) {
        const dx = pair.design[0] - designCenter[0];
        const dy = pair.design[1] - designCenter[1];
        const mx = pair.machine[0] - machineCenter[0];
        const my = pair.machine[1] - machineCenter[1];
        cross += dx * my - dy * mx;
        dot += dx * mx + dy * my;
        designSpread += dx * dx + dy * dy;
        machineSpread += mx * mx + my * my;
    }
    let rotation: number;
    if (fixedRotation !== null) {
        rotation = fixedRotation;
    } else if (n < 2 || designSpread < 1e-18) {
        rotation = 0;
    } else {
        rotation = (Math.atan2(cross, dot) * 180) / Math.PI;
    }
    const scale = designSpread > 1e-18 && machineSpread > 1e-18 ? Math.sqrt(machineSpread / designSpread) : 1;
    const turnedCenter = turnPoint(designCenter, rotation);
    const shift: [number, number] = [machineCenter[0] - turnedCenter[0], machineCenter[1] - turnedCenter[1]];
    const residuals = pairs.map((pair) => {
        const placed = turnPoint(pair.design, rotation);
        return Math.hypot(placed[0] + shift[0] - pair.machine[0], placed[1] + shift[1] - pair.machine[1]);
    });
    const rms = Math.sqrt(residuals.reduce((total, value) => total + value * value, 0) / n);
    return { rotation, shift, scale, rms, residuals };
}
