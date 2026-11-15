// The Machine view: a G-code machine's bed seen from above, in the frame of
// its file's places (the head's X and Y with the nozzle over a point). It
// draws the machine as the box its file's [motion] travel gives (else the
// box round the places the file names), the bed boards lie on ([top_camera]
// bed), the area a board is expected in ([top_camera] board_area, solid
// when boards are only ever placed inside it, dashed when only near it),
// the places the file names (park, the bottom camera, the homing
// fiducial), where the head is now with the top camera's view, the board
// where the top camera's look put it, and the stops of the newest search
// or scan. Under it all a picture of the machine and a 3D model of it, as
// the operator adds them (kept per machine file by the backend,
// spinny_web.machineview), each stretched over a box: a picture by default
// over the travel, a model at its own coordinates, seen from above.
//
// A drag on the view sets a box: the board area (kept inside the bed), or
// the box the picture or the model is drawn over, as the Drag sets choice
// says. The box waits, drawn in orange with its numbers in the fields
// (which take a typed box too), until Save writes it: the board area and
// its near or only within into the machine file, as the Config tab writes
// keys; the picture's or model's box beside the file kept.

import { button, cssVar, el, labeled, lockFor, numberField, replace, setUnlessFocused } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { setPending, type AppState } from "../state.ts";
import { hexColor, parseStl, topViewUrl, type Mesh } from "../stl.ts";
import type { CamValue, GcodeDocument, MachineViewKind, MachineViewState, ScanMosaic } from "../types.ts";
import { frameSize, topCalibration, topCenter } from "./camview.ts";
import type { Ctx } from "./context.ts";
import { pictureToMachine } from "./picture.ts";

/** A box on the machine, mm: x0, y0, x1, y1. */
export type Box = [number, number, number, number];

/** What a drag on the view sets. */
export type DragTarget = "area" | MachineViewKind;

/** The pending key of the store's unapplied edits. */
const PENDING = "machine-view";
/** The longer side of a model's top view, px. */
const MODEL_PX = 1024;
/** A press that moves less than this, CSS px, is a click and sets no box. */
const CLICK_PX = 4;

/** The box holding both, or the one given. */
export function unionBox(a: Box | null, b: Box | null): Box | null {
    if (a === null) {
        return b;
    }
    if (b === null) {
        return a;
    }
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The box round a point, `r` either way. */
function pointBox(point: readonly number[] | null | undefined, r = 0): Box | null {
    return point && point.length >= 2 ? [point[0]! - r, point[1]! - r, point[0]! + r, point[1]! + r] : null;
}

/** The box with x0 below x1 and y0 below y1, from two corners in any order. */
export function boxOf(a: [number, number], b: [number, number]): Box {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** The box cut to lie inside `within`; null when nothing of it is inside. */
export function clampBox(box: Box, within: Box | null): Box | null {
    if (within === null) {
        return box;
    }
    const [lx, hx] = [Math.min(within[0], within[2]), Math.max(within[0], within[2])];
    const [ly, hy] = [Math.min(within[1], within[3]), Math.max(within[1], within[3])];
    const clamped: Box = [Math.max(box[0], lx), Math.max(box[1], ly), Math.min(box[2], hx), Math.min(box[3], hy)];
    return clamped[0] < clamped[2] && clamped[1] < clamped[3] ? clamped : null;
}

/** The box's numbers to a tenth of a mm, as the file keeps them. */
export function roundBox(box: Box): Box {
    return box.map((value) => Math.round(value * 10) / 10 + 0) as Box;
}

/** The box round every place the file names: the bed, the board area, park, the bottom camera, the homing fiducial, the discard place, the slots and the feeders; null with none. */
export function placesBox(document: GcodeDocument | null | undefined): Box | null {
    if (!document) {
        return null;
    }
    let box: Box | null = null;
    const top = document.top;
    if (top?.bed) {
        box = unionBox(box, boxOf([top.bed[0], top.bed[1]], [top.bed[2], top.bed[3]]));
    }
    box = unionBox(box, top?.board_area ?? null);
    for (const point of [document.park, document.camera_position, top?.home_fiducial, document.discard]) {
        box = unionBox(box, pointBox(point));
    }
    for (const slot of document.slots ?? []) {
        box = unionBox(box, pointBox(slot.at));
    }
    for (const feeder of document.feeders ?? []) {
        box = unionBox(box, pointBox(feeder.at));
    }
    return box;
}

/** The machine as the view draws it: the file's travel, else the box round its places; null with neither. */
export function machineBox(document: GcodeDocument | null | undefined): Box | null {
    return document?.travel ?? placesBox(document);
}

/** The box the view shows: everything drawn, a twentieth of the larger side round it; a 100 mm square about 0 with nothing. */
export function viewExtent(...boxes: (Box | null)[]): Box {
    const box = boxes.reduce<Box | null>((all, next) => unionBox(all, next), null) ?? [-50, -50, 50, 50];
    const margin = Math.max(box[2] - box[0], box[3] - box[1], 1) / 20;
    return [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
}

/**
 * A pointer's place on the machine, mm, from its place on the screen over
 * a drawing of `extent` fitted whole and centered in `rect` (the SVG's
 * xMidYMid meet), the machine's +Y up.
 */
export function clientToMachine(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, extent: Box): [number, number] {
    const width = extent[2] - extent[0];
    const height = extent[3] - extent[1];
    const scale = Math.min(rect.width / width, rect.height / height);
    const left = rect.left + (rect.width - width * scale) / 2;
    const top = rect.top + (rect.height - height * scale) / 2;
    return [extent[0] + (clientX - left) / scale, extent[3] - (clientY - top) / scale];
}

/** A box in words: X 10 to 200, Y 80 to 200 mm. */
export function boxText(box: Box): string {
    return `X ${formatFixed(box[0], 1)} to ${formatFixed(box[2], 1)}, Y ${formatFixed(box[1], 1)} to ${formatFixed(box[3], 1)} mm`;
}

/** What the file says of the board area, in words. */
export function areaText(document: GcodeDocument | null | undefined): string {
    const area = document?.top?.board_area ?? null;
    if (area === null) {
        return "No board area in the file: a search with nothing known scans the whole bed.";
    }
    return document?.top?.board_area_only
        ? `Board area ${boxText(area)}, boards only within it: a search never looks outside it.`
        : `Board area ${boxText(area)}, boards near it: a search with nothing known looks there first, then the rest of the bed.`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>, title?: string): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, String(value));
    }
    if (title) {
        const tip = document.createElementNS(SVG_NS, "title");
        tip.textContent = title;
        node.append(tip);
    }
    return node;
}

/** A box as an SVG rect, the machine's +Y up (the drawing's y is -Y). */
function rect(box: Box, className: string, title?: string): SVGElement {
    return svg("rect", { x: box[0], y: -box[3], width: box[2] - box[0], height: box[3] - box[1], class: className }, title);
}

/** Points on the machine as an SVG polygon or polyline. */
function poly(tag: "polygon" | "polyline", points: [number, number][], className: string, title?: string): SVGElement {
    return svg(tag, { points: points.map(([x, y]) => `${x.toFixed(3)},${(-y).toFixed(3)}`).join(" "), class: className }, title);
}

/** The corners of a picture of `width` by `height` px seen with its center over `center`, on the machine. */
function footprint(center: [number, number], width: number, height: number, mmPerPx: number, roll: number, mirror: boolean): [number, number][] {
    return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]].map(([dx, dy]) => {
        const [mx, my] = pictureToMachine(dx!, dy!, mmPerPx, roll, mirror);
        return [center[0] + mx, center[1] + my] as [number, number];
    });
}

export interface MachineView {
    /** The box waiting to be saved, and what it sets; null with none. */
    pending(): { target: DragTarget; box: Box | null; only: boolean } | null;
    render(state: AppState): void;
}

export function mountMachineView(root: HTMLElement, ctx: Ctx): MachineView {
    // The picture and model kept for the machine shown, as last read.
    let view: MachineViewState | null = null;
    let viewFor: string | null = null;
    // The model's top view: by machine and version, its image and its own box.
    let model: { key: string; url: string | null; box: Box; triangles: number } | null = null;
    let modelLoading: string | null = null;
    // The newest search's or scan's stops, by the look's scan version.
    let mosaic: ScanMosaic | null = null;
    let mosaicFor: string | null = null;
    // The box a drag or the fields set, waiting for Save.
    let pending: { target: DragTarget; box: Box | null; only: boolean } | null = null;
    let target: DragTarget = "area";
    // The drag under way: where it began on the machine and on the screen.
    let drag: { from: [number, number]; client: [number, number] } | null = null;
    // The box the drawing shows, as last drawn.
    let extent: Box = viewExtent();

    const drawing = svg("svg", { class: "machine-view-svg", preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": "The machine's bed from above" }) as SVGSVGElement;
    const images = svg("g", { class: "machine-view-images" });
    const marks = svg("g", { class: "machine-view-marks" });
    const pictureImage = svg("image", { class: "machine-view-picture", preserveAspectRatio: "none" });
    const modelImage = svg("image", { class: "machine-view-model", preserveAspectRatio: "none" });
    images.append(pictureImage, modelImage);
    drawing.append(images, marks);
    const frame = el("div", { class: "machine-view-frame" }, drawing);

    const swatch = (kind: string, words: string): HTMLElement => el("span", { class: "machine-view-key" }, el("span", { class: `machine-view-swatch ${kind}` }), words);
    const legend = el("p", { class: "muted machine-view-legend" },
        swatch("travel", "travel"), swatch("bed", "bed"), swatch("area", "board area"), swatch("head", "head and top camera"),
        swatch("board", "board found"), swatch("stop", "search stops"), swatch("pending", "box to save"));

    const targetPick = el("select", { class: "field", "aria-label": "What a drag sets" },
        el("option", { value: "area" }, "Board area"),
        el("option", { value: "picture" }, "Picture's box"),
        el("option", { value: "model" }, "Model's box")) as HTMLSelectElement;
    targetPick.title = "what a drag on the view sets: the area boards are expected in, or the box the picture or the model is drawn over";
    targetPick.addEventListener("change", () => {
        target = targetPick.value as DragTarget;
        pending = null;
        render(ctx.store.get());
    });
    const onlyPick = el("select", { class: "field", "aria-label": "Boards near or only within the area" },
        el("option", { value: "near" }, "Boards near it"),
        el("option", { value: "only" }, "Boards only within it")) as HTMLSelectElement;
    onlyPick.title = "near: a search with nothing known looks in the area first, then the rest of the bed; only within: a search never looks outside it";
    onlyPick.addEventListener("change", () => {
        const doc = ctx.store.get().placing?.document;
        const box = pending?.target === "area" ? pending.box : doc?.top?.board_area ?? null;
        if (box === null && pending === null) {
            // No area to say it of: nothing to save, and the choice goes back.
            note.textContent = "draw or type a board area first: near or only within is said of it";
            render(ctx.store.get());
            return;
        }
        setEdit({ target: "area", box, only: onlyPick.value === "only" });
    });
    const onlyLabel = labeled("Board", onlyPick, "labeled inline");

    const fields = ["x0", "y0", "x1", "y1"].map((name) => {
        const field = numberField({ step: 1, width: "5rem" });
        field.setAttribute("aria-label", `Box ${name}`);
        field.title = `the box's ${name}, mm on the machine: type one and press Enter, or drag on the view`;
        field.addEventListener("change", () => typedBox());
        return field;
    });
    const save = button("Save", () => void saveEdit(), "btn btn-primary", "write the box: the board area into the machine file, or the picture's or model's box beside it");
    const cancel = button("Cancel", () => setEdit(null), "btn btn-quiet", "forget the box drawn: the view shows what is saved");
    const clear = button("Clear", () => clearBox(), "btn btn-quiet");
    const areaLine = el("p", { class: "muted machine-view-area" });

    const pictureInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "hidden", "aria-label": "Picture of the machine" }) as HTMLInputElement;
    const modelInput = el("input", { type: "file", accept: ".stl,model/stl", class: "hidden", "aria-label": "3D model of the machine" }) as HTMLInputElement;
    const addPicture = button("Add picture", () => pictureInput.click(), "btn", "a picture of the machine from above (PNG, JPEG, WebP or GIF), drawn stretched over the travel or the box set for it");
    const removePicture = button("Remove picture", () => void removeFile("picture"), "btn btn-quiet", "take the picture away");
    const addModel = button("Add model", () => modelInput.click(), "btn", "a 3D model of the machine (STL), drawn from above at its own coordinates or over the box set for it");
    const removeModel = button("Remove model", () => void removeFile("model"), "btn btn-quiet", "take the model away");
    const pictureLine = el("span", { class: "muted machine-view-file" });
    const modelLine = el("span", { class: "muted machine-view-file" });
    pictureInput.addEventListener("change", () => void addFile("picture", pictureInput));
    modelInput.addEventListener("change", () => void addFile("model", modelInput));

    const note = el("p", { class: "muted hint" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Machine view")),
        el("div", { class: "panel-body" },
            el("p", { class: "muted hint" }, "The bed from above, in the machine's X and Y with the nozzle over a point. Drag on it to set the area boards are placed in,"
                + " or the box a picture or a model of the machine is drawn over."),
            frame,
            legend,
            el("div", { class: "button-row" }, labeled("Drag sets", targetPick, "labeled inline"), onlyLabel),
            el("div", { class: "button-row machine-view-fields" }, ...fields.map((field, index) => labeled(["X0", "Y0", "X1", "Y1"][index]!, field, "labeled inline")), save, cancel, clear),
            areaLine,
            el("div", { class: "button-row" }, addPicture, removePicture, pictureLine, pictureInput),
            el("div", { class: "button-row" }, addModel, removeModel, modelLine, modelInput),
            note,
        ),
    );

    // --- the edit -------------------------------------------------------------

    function setEdit(next: typeof pending): void {
        pending = next;
        setPending(ctx.store, PENDING, pending === null ? 0 : 1);
        render(ctx.store.get());
    }

    /** The box the fields hold, taken as the pending box of what a drag sets. */
    function typedBox(): void {
        const values = fields.map((field) => parseNumber(field.value.trim()));
        if (values.some((value) => value === null)) {
            return;
        }
        const [x0, y0, x1, y1] = values as number[];
        const box = boxOf([x0!, y0!], [x1!, y1!]);
        if (!(box[0] < box[2] && box[1] < box[3])) {
            ctx.toast("info", "a box needs some width and height");
            return;
        }
        const placed = settle(box);
        if (placed !== null) {
            setEdit({ target, box: placed, only: onlyPick.value === "only" });
        }
    }

    /** A box for what a drag sets: an area kept inside the bed and rounded; null (with a word) when none of it is on the bed. */
    function settle(box: Box): Box | null {
        if (target !== "area") {
            return roundBox(box);
        }
        const bed = ctx.store.get().placing?.document?.top?.bed ?? null;
        const inside = clampBox(box, bed);
        if (inside === null) {
            ctx.toast("info", "the board area must lie on the bed ([top_camera] bed)");
            return null;
        }
        return roundBox(inside);
    }

    /** Clear: the board area taken out of the file, or the picture's or model's box back to its default. */
    function clearBox(): void {
        setEdit({ target, box: null, only: false });
    }

    async function saveEdit(): Promise<void> {
        const state = ctx.store.get();
        const id = state.placing?.machine ?? null;
        const edit = pending;
        if (id === null || edit === null) {
            return;
        }
        if (edit.target === "area") {
            // Taken out, the flag goes first; put in, the area does, so
            // the file reads after each write.
            const writes: [string, CamValue][] = edit.box === null
                ? [["board_area_only", null], ["board_area", null]]
                : [["board_area", edit.box], ["board_area_only", edit.only]];
            for (const [key, value] of writes) {
                const saved = await ctx.call(ctx.api.patchMachineFile(id, ["top_camera", key], value));
                if (saved === undefined) {
                    return;
                }
            }
            note.textContent = edit.box === null ? `board_area taken out of ${id}.toml` : `[top_camera] board_area and board_area_only saved in ${id}.toml`;
            setEdit(null);
            await ctx.refreshPlacing();
            // The Config tab's editor shows the file with the values in it.
            await ctx.refreshMachines();
            return;
        }
        const answer = await ctx.call(ctx.api.placeMachineView(id, edit.target, edit.box));
        if (answer) {
            view = answer;
            note.textContent = `the ${edit.target}'s box saved`;
            setEdit(null);
        }
    }

    async function addFile(kind: MachineViewKind, input: HTMLInputElement): Promise<void> {
        const file = input.files?.[0];
        input.value = "";
        const id = ctx.store.get().placing?.machine ?? null;
        if (!file || id === null) {
            return;
        }
        const answer = await ctx.call(ctx.api.putMachineView(id, kind, file));
        if (answer) {
            view = answer;
            viewFor = id;
            note.textContent = `${file.name} added as the machine's ${kind}`;
            render(ctx.store.get());
        }
    }

    async function removeFile(kind: MachineViewKind): Promise<void> {
        const id = ctx.store.get().placing?.machine ?? null;
        if (id === null) {
            return;
        }
        const answer = await ctx.call(ctx.api.removeMachineView(id, kind));
        if (answer) {
            view = answer;
            render(ctx.store.get());
        }
    }

    // --- what is read from the backend -------------------------------------------

    async function readView(id: string): Promise<void> {
        viewFor = id;
        const answer = await ctx.call(ctx.api.machineView(id));
        if (answer && viewFor === id) {
            view = answer;
            render(ctx.store.get());
        }
    }

    async function readModel(id: string, version: number, key: string): Promise<void> {
        modelLoading = key;
        try {
            const bytes = await ctx.api.machineViewBytes(id, "model", version);
            const mesh: Mesh = parseStl(bytes);
            const dark = hexColor(cssVar(root, "--base02", "#073642")) ?? [7, 54, 66];
            const light = hexColor(cssVar(root, "--base2", "#eee8d5")) ?? [238, 232, 213];
            if (modelLoading === key) {
                model = { key, url: topViewUrl(mesh, MODEL_PX, dark, light), box: [mesh.box[0], mesh.box[1], mesh.box[3], mesh.box[4]], triangles: mesh.count };
            }
        } catch (error) {
            note.textContent = `the model cannot be drawn: ${error instanceof Error ? error.message : String(error)}`;
            model = null;
        } finally {
            if (modelLoading === key) {
                modelLoading = null;
            }
        }
        render(ctx.store.get());
    }

    async function readMosaic(key: string): Promise<void> {
        mosaicFor = key;
        const answer = await ctx.api.topScanState().catch(() => null);
        if (mosaicFor === key) {
            mosaic = answer;
            render(ctx.store.get());
        }
    }

    // --- the drag -------------------------------------------------------------

    drawing.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || ctx.store.get().placing?.machine == null) {
            return;
        }
        event.preventDefault();
        drag = { from: clientToMachine(event.clientX, event.clientY, drawing.getBoundingClientRect(), extent), client: [event.clientX, event.clientY] };
        drawing.setPointerCapture?.(event.pointerId);
        frame.classList.add("dragging");
    });
    drawing.addEventListener("pointermove", (event) => {
        if (drag === null) {
            return;
        }
        const now = clientToMachine(event.clientX, event.clientY, drawing.getBoundingClientRect(), extent);
        drawPending(boxOf(drag.from, now));
    });
    const release = (event: PointerEvent): void => {
        const done = drag;
        drag = null;
        frame.classList.remove("dragging");
        if (done === null) {
            return;
        }
        if (Math.hypot(event.clientX - done.client[0], event.clientY - done.client[1]) < CLICK_PX) {
            render(ctx.store.get());
            return;
        }
        const placed = settle(boxOf(done.from, clientToMachine(event.clientX, event.clientY, drawing.getBoundingClientRect(), extent)));
        if (placed === null) {
            render(ctx.store.get());
            return;
        }
        const doc = ctx.store.get().placing?.document;
        const only = pending?.target === "area" ? pending.only : doc?.top?.board_area_only === true;
        setEdit({ target, box: placed, only });
    };
    drawing.addEventListener("pointerup", release);
    drawing.addEventListener("pointercancel", () => {
        drag = null;
        frame.classList.remove("dragging");
        render(ctx.store.get());
    });

    /** The box being dragged, over what is drawn. */
    function drawPending(box: Box): void {
        marks.querySelector(".mv-dragging")?.remove();
        marks.append(rect(box, "mv-pending mv-dragging"));
    }

    // --- drawing --------------------------------------------------------------

    /** The box a picture or model is drawn over: its own, else its default. */
    function boxFor(kind: MachineViewKind, doc: GcodeDocument | null | undefined): Box | null {
        const kept = view?.[kind]?.box ?? null;
        if (pending && pending.target === kind) {
            return pending.box ?? (kind === "picture" ? machineBox(doc) : model?.box ?? null);
        }
        if (kept !== null) {
            return kept;
        }
        return kind === "picture" ? machineBox(doc) : model?.box ?? null;
    }

    function render(state: AppState): void {
        const placing = state.placing ?? null;
        const id = placing?.machine ?? null;
        const doc = placing?.document ?? null;
        if (id !== viewFor) {
            view = null;
            model = null;
            pending = null;
            setPending(ctx.store, PENDING, 0);
            if (id !== null) {
                void readView(id);
            } else {
                viewFor = null;
            }
        }
        // The model's top view, read again when its version changes.
        const modelFile = view?.model ?? null;
        const modelKey = id !== null && modelFile ? `${id}/${modelFile.version}` : null;
        if (modelKey === null) {
            model = null;
        } else if (model?.key !== modelKey && modelLoading !== modelKey) {
            void readModel(id!, modelFile!.version, modelKey);
        }
        // The newest search's or scan's stops, read again when the look's scan changes.
        const look = placing?.top?.board_look ?? null;
        const scanKey = look?.scan ? `${look.scan.job}/${look.scan.version}` : null;
        if (scanKey === null) {
            mosaic = null;
            mosaicFor = null;
        } else if (scanKey !== mosaicFor) {
            void readMosaic(scanKey);
        }

        const travel = doc?.travel ?? null;
        const machine = machineBox(doc);
        const bed = doc?.top?.bed ? boxOf([doc.top.bed[0], doc.top.bed[1]], [doc.top.bed[2], doc.top.bed[3]]) : null;
        const area = pending?.target === "area" ? pending.box : doc?.top?.board_area ?? null;
        const only = pending?.target === "area" ? pending.only : doc?.top?.board_area_only === true;
        const head = placing?.position && placing.position.x !== undefined && placing.position.y !== undefined ? [placing.position.x, placing.position.y] as [number, number] : null;
        const camera = topCenter(state);
        const pictureBox = view?.picture ? boxFor("picture", doc) : null;
        const modelBox = view?.model ? boxFor("model", doc) : null;
        const stops = (mosaic?.pictures ?? []).map((tile) => tile.center);
        extent = viewExtent(machine, bed, area, pictureBox, modelBox, pointBox(head), pointBox(camera),
            ...stops.map((stop) => pointBox(stop)), pending?.box ?? null);
        const span = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
        drawing.setAttribute("viewBox", `${extent[0].toFixed(3)} ${(-extent[3]).toFixed(3)} ${(extent[2] - extent[0]).toFixed(3)} ${(extent[3] - extent[1]).toFixed(3)}`);
        frame.style.aspectRatio = `${(extent[2] - extent[0]).toFixed(3)} / ${(extent[3] - extent[1]).toFixed(3)}`;

        // The picture and the model under everything.
        const place = (image: SVGElement, href: string | null, box: Box | null): void => {
            if (!href || box === null) {
                image.setAttribute("visibility", "hidden");
                return;
            }
            if (image.getAttribute("href") !== href) {
                image.setAttribute("href", href);
            }
            image.setAttribute("x", String(box[0]));
            image.setAttribute("y", String(-box[3]));
            image.setAttribute("width", String(box[2] - box[0]));
            image.setAttribute("height", String(box[3] - box[1]));
            image.setAttribute("visibility", "visible");
        };
        place(pictureImage, id !== null && view?.picture ? ctx.api.machineViewUrl(id, "picture", view.picture.version) : null, pictureBox);
        place(modelImage, model?.url ?? null, modelBox);

        // The marks, drawn afresh.
        const r = span / 120;
        const shapes: SVGElement[] = [];
        if (machine !== null) {
            shapes.push(rect(machine, travel !== null ? "mv-travel" : "mv-travel mv-guessed",
                travel !== null ? `the head's reach, [motion] travel: ${boxText(travel)}` : "no [motion] travel in the file: the box round the places it names"));
        }
        if (bed !== null) {
            shapes.push(rect(bed, "mv-bed", `the bed boards lie on, [top_camera] bed: ${boxText(bed)}`));
        }
        if (area !== null) {
            shapes.push(rect(area, `${only ? "mv-area mv-only" : "mv-area"}${pending?.target === "area" ? " mv-unsaved" : ""}`, `${pending?.target === "area" ? "the board area to save" : "the board area"}: ${boxText(area)}, ${only ? "boards only within it" : "boards near it"}`));
        }
        const named: [readonly number[] | null | undefined, string][] = [
            [doc?.park, "park: where the head waits"],
            [doc?.camera_position, "the bottom camera, as the file places it"],
            [doc?.top?.home_fiducial, "the homing fiducial"],
        ];
        for (const [point, words] of named) {
            if (point && point.length >= 2) {
                shapes.push(svg("circle", { cx: point[0]!, cy: -point[1]!, r: r * 0.8, class: "mv-place" }, words));
            }
        }
        for (const stop of stops) {
            shapes.push(svg("circle", { cx: stop[0], cy: -stop[1], r: r * 0.5, class: "mv-stop" }, "a stop of the newest search or scan"));
        }
        // The board where the top camera's look put it: the job's outline when the job is the one shown, else its center.
        const estimate = look?.estimate ?? null;
        if (estimate) {
            const job = look?.job && state.job?.id === look.job ? state.job : null;
            const words = look?.found ? "the board where the top camera's look found it" : "the board where the top camera's look puts it so far";
            const className = look?.found ? "mv-board" : "mv-board mv-unsure";
            if (job && job.outline.length > 0) {
                const radians = (estimate.rotation * Math.PI) / 180;
                const c = Math.cos(radians);
                const s = Math.sin(radians);
                for (const path of job.outline) {
                    shapes.push(poly("polyline", path.map(([x, y]) => [x * c - y * s + estimate.shift[0], x * s + y * c + estimate.shift[1]] as [number, number]), className, words));
                }
            } else {
                shapes.push(svg("circle", { cx: estimate.center[0], cy: -estimate.center[1], r: r * 1.5, class: className }, words));
            }
        }
        // The head, and what the top camera sees from there.
        const calibration = topCalibration(state);
        const size = frameSize(placing?.top?.frame, placing?.top?.size);
        if (camera !== null && calibration !== null && size !== null) {
            shapes.push(poly("polygon", footprint(camera, size[0], size[1], calibration.mmPerPx, calibration.roll, calibration.mirror), "mv-view", "what the top camera sees now"));
        }
        if (camera !== null) {
            shapes.push(svg("circle", { cx: camera[0], cy: -camera[1], r, class: "mv-camera" }, "the top camera's picture center"));
        }
        if (head !== null) {
            shapes.push(poly("polyline", [[head[0] - 2 * r, head[1]], [head[0] + 2 * r, head[1]]], "mv-head", "the nozzle, where the head is now"));
            shapes.push(poly("polyline", [[head[0], head[1] - 2 * r], [head[0], head[1] + 2 * r]], "mv-head", "the nozzle, where the head is now"));
        }
        if (pending !== null && pending.box !== null && pending.target !== "area") {
            shapes.push(rect(pending.box, "mv-pending", `the ${pending.target}'s box to save: ${boxText(pending.box)}`));
        }
        replace(marks, ...shapes);

        // The controls.
        const shown = pending?.target === target ? pending.box : target === "area" ? doc?.top?.board_area ?? null : view?.[target]?.box ?? null;
        const focused = globalThis.document?.activeElement ?? null;
        fields.forEach((field, index) => setUnlessFocused(field, shown ? formatFixed(shown[index]!, 1) : "", focused));
        onlyLabel.classList.toggle("hidden", target !== "area");
        onlyPick.value = only ? "only" : "near";
        const none = id === null ? "no G-code machine to place with" : null;
        const noFile = target !== "area" && !view?.[target] ? `add a ${target} first` : null;
        lockFor(save, [none !== null, none ?? ""], [pending === null, "drag a box on the view, or type one, first"]);
        lockFor(cancel, [pending === null, "nothing to forget"]);
        clear.textContent = target === "area" ? "Clear area" : "Default box";
        clear.title = target === "area"
            ? "take the board area out of the file (on Save): a search with nothing known scans the whole bed"
            : `draw the ${target} at its default (on Save): ${target === "picture" ? "over the travel" : "at its own coordinates"}`;
        lockFor(clear, [none !== null, none ?? ""], [noFile !== null, noFile ?? ""],
            [target === "area" && pending === null && (doc?.top?.board_area ?? null) === null, "the file has no board area"],
            [target !== "area" && pending === null && (view?.[target]?.box ?? null) === null, `the ${target} is drawn at its default place`]);
        for (const node of [...fields, targetPick, onlyPick]) {
            node.disabled = id === null;
        }
        areaLine.textContent = pending !== null
            ? pending.target === "area"
                ? pending.box === null ? "Save takes the board area out of the file." : `Save writes the board area ${boxText(pending.box)}, ${pending.only ? "boards only within it" : "boards near it"}.`
                : pending.box === null ? `Save draws the ${pending.target} at its default place.` : `Save draws the ${pending.target} over ${boxText(pending.box)}.`
            : areaText(doc);
        lockFor(addPicture, [none !== null, none ?? ""]);
        lockFor(addModel, [none !== null, none ?? ""]);
        lockFor(removePicture, [!view?.picture, "no picture added"]);
        lockFor(removeModel, [!view?.model, "no model added"]);
        pictureLine.textContent = view?.picture ? `Picture: ${view.picture.name}` : "No picture: the machine is drawn as boxes.";
        modelLine.textContent = view?.model
            ? `Model: ${view.model.name}, ${view.model.triangles ?? model?.triangles ?? 0} triangles${modelLoading !== null ? " (drawing)" : model && model.url === null ? " (cannot be drawn in this browser)" : ""}`
            : "No model.";
        note.classList.toggle("hidden", note.textContent === "");
    }

    ctx.store.subscribe((state) => render(state), ["placing", "job"]);
    render(ctx.store.get());
    return { pending: () => pending, render };
}
