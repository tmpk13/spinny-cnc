// Crops: the part of a camera's picture each task looks in, as the backend
// has them (spinny_web.crops). A crop is a box [x0, y0, x1, y1] in shares of
// the full picture's width and height from its top left, 0 to 1, so another
// capture size keeps it. A G-code machine's file gives each camera's crops
// by task ([top_camera.crops], [up_camera.crops]); a task with none looks at
// the whole picture.

/** A crop: x0, y0, x1, y1 in shares of the picture's width and height from its top left. */
export type CropBox = [number, number, number, number];

/** The top camera's tasks: the board look, the spot looks, Corner by edges, and the pictures measured by their pixels. */
export const TOP_TASKS = ["board", "spot", "edges", "measure"] as const;
/** The bottom camera's tasks: the nozzle's tip and the part on it. */
export const UP_TASKS = ["nozzle", "part"] as const;

/** What each task covers, in words for a menu's tooltip and the row under a picture. */
export const TASK_WORDS: Record<string, string> = {
    board: "the board look, its searches and scans",
    spot: "Find mark, Measure offset, Find fiducials, Home by fiducial, Look once",
    edges: "Corner by edges and the edge view",
    measure: "Measure camera and the empty picture test",
    nozzle: "Center nozzle, Measure runout, Look once at the nozzle",
    part: "the part on the nozzle, within its circle too",
};

/** A crop from four numbers in order inside the picture; an Error says what is wrong. */
export function checkCrop(box: unknown): CropBox {
    if (!Array.isArray(box) || box.length !== 4) {
        throw new Error("a crop is [x0, y0, x1, y1]");
    }
    if (!box.every((v) => typeof v === "number" && Number.isFinite(v))) {
        throw new Error("a crop's four values must be numbers");
    }
    const [x0, y0, x1, y1] = box as number[];
    if (!(0 <= x0! && x0! < x1! && x1! <= 1 && 0 <= y0! && y0! < y1! && y1! <= 1)) {
        throw new Error("a crop needs 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1: shares of the picture from its top left");
    }
    return [x0!, y0!, x1!, y1!];
}

/** A camera's crops by task, each checked; an Error names an unknown task with the known ones, or the task whose box is wrong. */
export function checkTasks(crops: unknown, tasks: readonly string[]): Record<string, CropBox> {
    if (typeof crops !== "object" || crops === null || Array.isArray(crops)) {
        throw new Error(`crops are a table of tasks: ${tasks.join(", ")}`);
    }
    const taken: Record<string, CropBox> = {};
    for (const [task, box] of Object.entries(crops)) {
        if (!tasks.includes(task)) {
            throw new Error(`no task '${task}': the tasks are ${tasks.join(", ")}`);
        }
        try {
            taken[task] = checkCrop(box);
        } catch (error) {
            throw new Error(`${task}: ${(error as Error).message}`);
        }
    }
    return taken;
}

/** A box drawn on a picture of `size` px (two corners, full size px, either way round) as a crop, clamped to the picture and rounded to hundred-thousandths; null for one with no width or height inside it. */
export function cropOf(from: [number, number], to: [number, number], size: [number, number]): CropBox | null {
    const share = (value: number, whole: number): number => Math.round(Math.max(0, Math.min(1, value / whole)) * 100000) / 100000;
    const box: CropBox = [
        share(Math.min(from[0], to[0]), size[0]),
        share(Math.min(from[1], to[1]), size[1]),
        share(Math.max(from[0], to[0]), size[0]),
        share(Math.max(from[1], to[1]), size[1]),
    ];
    return box[0] < box[2] && box[1] < box[3] ? box : null;
}

/** A crop in words: the part of the picture it keeps, in percent of its width and height. */
export function cropText(box: CropBox | null): string {
    if (box === null) {
        return "the whole picture";
    }
    const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`;
    return `${percent(box[0])} to ${percent(box[2])} across, ${percent(box[1])} to ${percent(box[3])} down`;
}
