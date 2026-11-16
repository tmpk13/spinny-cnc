// What the cameras' words mean, said once here: a word on the page marked
// as a term gets a dotted underline and its meaning as its tooltip. The
// words are the ones the camera panels, Board place and the routines'
// lines use without saying what they are.


export const TERMS = {
    spot: ["spot", "a small blob the finder looks for in a picture, darker or brighter than what is around it (or of a color picked): a mark, a fiducial, a pad, the nozzle's bore, a part on the nozzle"],
    shade: ["shade", "whether the spot looked for is dark on a lighter ground or bright on a darker one"],
    lens: ["lens", "how the camera's lens bends straight lines toward the picture's edges; Measure lens measures it from a dot grid (two terms, k1 and k2) and pcbv then corrects every point of a picture by it"],
    dots: ["dots", "the calibration dot grid the lens is measured from (the Calibration test's camera pattern), dark dots on a light ground or bright on dark, its pitch the mm between neighboring dots"],
    color: ["color", "a color picked from the picture: the camera then looks for that color instead of dark or bright, for spots, the board's pads or a blank board's edges"],
    edges: ["edges", "straight lines where the picture's brightness steps, such as a blank board's sides against the bed; Corner by edges takes the two that meet square as the board's corner"],
    roll: ["roll", "how far the camera is turned about its own axis: degrees from the picture's x axis (its right) to the machine's +X, counterclockwise seen from above"],
    scale: ["mm per px", "the picture's scale: the mm on the machine one pixel of the full size picture spans"],
    offset: ["offset", "where the picture's center is from the tool (the head camera) or from the nozzle's tip (the top camera), mm"],
    mirror: ["mirrored", "the picture shows the machine flipped left for right, as a camera looking up at the nozzle does"],
    within: ["within", "how far from the picture's center, or from where a thing is expected, the finder looks for it"],
    side: ["side", "which face of the board the camera looks at: front, or back with the board turned over"],
    finish: ["finish", "masked: solder mask covers the copper and only the pads show; bare: all the copper shows"],
    paste: ["paste", "solder paste printed on the pads, which changes how they look"],
    pose: ["pose", "where pcbv puts the picture on the loaded board: the board point under the picture's center and the board's angle"],
    locked: ["locked", "pcbv has matched the picture to the board (coasting: following a match from frame to frame; lost: no match)"],
    inliers: ["inliers", "the board's features pcbv paired with spots in the picture, of those it expected in view"],
    rms: ["rms", "how far the paired features lie from where the pose puts them, on average (the root of the mean square)"],
    look: ["look", "one picture read for where the board is; looks that agree make a guess"],
    lock: ["lock", "pcbv finding the board afresh after a search (its acquisition number): frames tracked from one lock are not independent, so a board is found only from two"],
    guess: ["guess", "a place the looks put the board, with its share of the evidence: looks weighed by how well pcbv matched"],
    threshold: ["threshold", "the least share of the evidence (or probability) the most likely place must hold to be called found"],
    method: ["method", "vote: counts the locked looks that agree; probability: weighs every picture, those that locked on nothing too, and keeps some for where nothing has looked yet"],
    rival: ["rival", "another place on the board that fits a picture nearly as well, such as a repeated row of pads one pitch off: the place is then ambiguous"],
    stretch: ["board stretch", "how much the board's X and Y scale and shear differ from its design, within a fab's tolerance, fitted from pictures far apart"],
    corner: ["corner", "a corner of the board's outline box, taken where the picture's center was put on it, or where its edges meet"],
    features: ["features", "fiducials, holes or pads far apart on the board, centered one by one to give its turn over a long baseline"],
    finding: ["finding", "what a routine found and applied at once: shown under the picture with Undo for a while, and listed in the camera's Changes"],
} as const satisfies Record<string, readonly [string, string]>;

export type Term = keyof typeof TERMS;

/** What a term means, in a phrase. */
export function meaning(term: Term): string {
    return TERMS[term][1];
}

/**
 * Marks `node` as using a term: a dotted underline, and the term's meaning
 * as its tooltip (after any words it says itself). A `labeled` label marks
 * its words only, so the control keeps its own tooltip.
 */
export function explain<T extends HTMLElement>(node: T, term: Term): T {
    const target = labelText(node) ?? node;
    const [word, said] = TERMS[term];
    target.classList.add("term");
    target.title = target.title ? `${target.title}; ${word}: ${said}` : `${word}: ${said}`;
    return node;
}

/** A `labeled` label's words: its first child, which holds them. */
function labelText(node: HTMLElement): HTMLElement | null {
    const first = node.firstElementChild;
    return node.tagName === "LABEL" && first instanceof HTMLElement && first.classList.contains("labeled-text") ? first : null;
}
