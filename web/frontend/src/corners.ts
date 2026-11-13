// The corners of a board's outline box that can be taken by hand to put the
// board roughly in place, by name, as the board drawing shows them (the
// job's y up): shared by the Find board panel and the in-page mock.

import type { CornerName } from "./types.ts";

export const CORNER_NAMES: readonly CornerName[] = ["bottom left", "bottom right", "top right", "top left"];

/** The corner of a box (the job's frame) by its name. */
export function cornerOf(box: { x0: number; y0: number; x1: number; y1: number }, name: CornerName): [number, number] {
    switch (name) {
        case "bottom left":
            return [box.x0, box.y0];
        case "bottom right":
            return [box.x1, box.y0];
        case "top right":
            return [box.x1, box.y1];
        case "top left":
            return [box.x0, box.y1];
    }
}
