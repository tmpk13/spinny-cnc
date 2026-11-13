// A camera's V4L2 controls (exposure, gain, focus, white balance,
// brightness and the like), a panel of its own stacked with its camera's
// panel (or a fold inside it where no panel is given): the
// list v4l2-ctl gives of the camera's device on the backend's computer, as
// sliders for numbers, boxes for switches and lists for menus. A value set
// is sent at once and kept by the backend, which sets it again whenever the
// camera starts; Forget takes a kept value back, leaving the camera's own.
// A camera reached over HTTP (a bridge Pi's snapshots) or a pcbv over TCP
// has none here, and the fold says so. Live numbers of the camera's picture
// (sharpness, noise, brightness, clipping) head the fold while it is open
// (camerastats.ts), to turn the controls by.

import { button, el, foldAsPanel, replace } from "../dom.ts";
import type { CameraControl, CameraControls, ControlledCamera } from "../types.ts";
import { mountCameraStats } from "./camerastats.ts";
import type { Ctx } from "./context.ts";

/** A control's name as words: v4l2-ctl's underscores as spaces. */
export function controlLabel(name: string): string {
    return name.replace(/_/g, " ");
}

/** The panels a camera's two folds go into: its picture controls, and its lens and colors. */
export interface CameraFolds {
    controls: HTMLElement;
    sight: HTMLElement;
}

/**
 * Puts a camera's two folds where they go: each into its panel of its own,
 * open or folded as last left there (per camera); with no panels given,
 * back as the nodes the camera's own panel holds.
 */
export function placeFolds(folds: CameraFolds | undefined, camera: ControlledCamera, controls: HTMLDetailsElement, sight: HTMLDetailsElement): HTMLElement[] {
    if (!folds) {
        return [controls, sight];
    }
    foldAsPanel(folds.controls, controls, `spinny.camera-controls.${camera}.open`);
    foldAsPanel(folds.sight, sight, `spinny.camera-sight.${camera}.open`);
    return [];
}

/** Whether a node shows now (not under anything display: none); a browser that cannot tell counts it as shown. */
function visibleNow(node: Element): boolean {
    return typeof node.checkVisibility === "function" ? node.checkVisibility() : true;
}

/** The value a control shows: the kept one when there is, else the camera's own. */
export function shownValue(control: CameraControl): number {
    return control.kept ?? control.value;
}

export interface ControlsFold {
    root: HTMLDetailsElement;
    /** Lists the controls again, as the device has them now. */
    reload(): Promise<void>;
}

export function mountCameraControls(ctx: Ctx, camera: ControlledCamera, label: string): ControlsFold {
    const list = el("div", { class: "camera-controls-list" });
    const note = el("p", { class: "muted camera-controls-note" });
    const read = button("Read", () => void reload(), "btn btn-quiet btn-small");
    read.title = "list the controls again, as the camera has them now";
    const summary = el("summary", { class: "camera-controls-head" }, "Picture controls");
    summary.title = `${label}'s exposure, gain, focus, white balance and the like`;
    // Measured only while the fold is open.
    const stats = mountCameraStats(camera);
    const root = el("details", { class: "camera-controls" },
        summary,
        el("div", { class: "button-row" }, read, el("span", { class: "muted" }, "Values set here are kept and set again each time the camera starts.")),
        stats.root,
        note,
        list,
    ) as HTMLDetailsElement;
    let shown: CameraControls | null = null;

    // At work while open and on the screen: as a panel of its own the fold
    // starts behind its camera's panel in their stack, and an open fold
    // there must neither ask the camera for its controls nor measure its
    // frames. The list is read once each time the fold opens, when it
    // first shows.
    let working = false;
    let onScreen = true;
    let listed = false;
    const follow = (): void => {
        const want = root.open && onScreen && visibleNow(root);
        if (want && !working) {
            working = true;
            if (!listed) {
                listed = true;
                void reload();
            }
            stats.start();
        } else if (!want && working) {
            working = false;
            stats.stop();
        }
    };
    root.addEventListener("toggle", () => {
        if (!root.open) {
            listed = false;
        }
        follow();
    });
    if (typeof IntersectionObserver === "function") {
        new IntersectionObserver((entries) => {
            onScreen = entries[entries.length - 1]?.isIntersecting ?? onScreen;
            follow();
        }).observe(root);
    }

    async function reload(): Promise<void> {
        const answer = await ctx.call(ctx.api.cameraControls(camera));
        if (answer) {
            show(answer);
        }
    }

    async function send(values: Record<string, number | null>): Promise<void> {
        const answer = await ctx.call(ctx.api.setCameraControls(camera, values));
        if (!answer) {
            return;
        }
        if (answer.refused && answer.refused.length > 0) {
            ctx.toast("error", `the camera refused ${answer.refused.join("; ")}`);
        }
        show(answer);
    }

    function row(control: CameraControl): HTMLElement {
        const value = shownValue(control);
        const name = controlLabel(control.name);
        let input: HTMLElement;
        const readout = el("span", { class: "mono camera-control-value" }, String(value));
        if (control.kind === "bool") {
            const box = el("input", { type: "checkbox", "aria-label": name }) as HTMLInputElement;
            box.checked = value !== 0;
            box.addEventListener("change", () => void send({ [control.name]: box.checked ? 1 : 0 }));
            input = box;
            readout.textContent = "";
        } else if (control.items) {
            const select = el("select", { class: "field", "aria-label": name },
                ...control.items.map((item) => el("option", { value: String(item.value) }, item.label))) as HTMLSelectElement;
            select.value = String(value);
            select.addEventListener("change", () => void send({ [control.name]: Number(select.value) }));
            input = select;
            readout.textContent = "";
        } else {
            const slider = el("input", { type: "range", class: "camera-control-slider", "aria-label": name, min: String(control.min), max: String(control.max), step: String(control.step) }) as HTMLInputElement;
            slider.value = String(value);
            slider.addEventListener("input", () => {
                readout.textContent = slider.value;
            });
            // Sent once let go, not at every step of a drag.
            slider.addEventListener("change", () => void send({ [control.name]: Number(slider.value) }));
            input = slider;
        }
        const forget = button("Forget", () => void send({ [control.name]: null }), "btn btn-quiet btn-small");
        forget.title = "forget the kept value: the camera keeps its own from now on";
        forget.classList.toggle("hidden", control.kept === null);
        const title = control.inactive
            ? `${name}: does nothing while an automatic control is on (default ${control.default})`
            : `${name}: ${control.min} to ${control.max}, default ${control.default}${control.kept !== null ? `; kept at ${control.kept}` : ""}`;
        const line = el("div", { class: `camera-control${control.inactive ? " inactive" : ""}${control.kept !== null ? " kept" : ""}`, title },
            el("span", { class: "camera-control-name" }, name),
            input,
            readout,
            forget,
        );
        return line;
    }

    function show(answer: CameraControls): void {
        shown = answer;
        note.textContent = answer.note ?? (answer.controls.length === 0 ? "The camera lists no controls that can be set." : "");
        note.classList.toggle("hidden", note.textContent === "");
        const sections: HTMLElement[] = [];
        let section = "";
        for (const control of answer.controls) {
            if (control.section !== section) {
                section = control.section;
                sections.push(el("h4", { class: "camera-controls-section" }, section || "Controls"));
            }
            sections.push(row(control));
        }
        replace(list, ...sections);
        list.classList.toggle("hidden", answer.controls.length === 0);
    }

    return {
        root,
        reload,
        get shown() {
            return shown;
        },
    } as ControlsFold;
}
