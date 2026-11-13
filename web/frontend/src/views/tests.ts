// The Tests panel: the centering test and the calibration tests, each a
// fold that makes its burn or pattern as a job. They lived in the Jobs
// panel; on their own they start stacked with the Align panel (the
// markup's data-stack), out of the job list's way. The panel hides when
// neither test applies to the machine (the centering test follows the
// machine file's controls, the calibration tests leave a dispenser out).

import { el } from "../dom.ts";
import { calibrationTest } from "./calibrate.ts";
import { centerTest } from "./center.ts";
import type { Ctx } from "./context.ts";

export function mountTests(root: HTMLElement, ctx: Ctx): void {
    const center = centerTest(ctx);
    const calibrate = calibrationTest(ctx);
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Tests")), center, calibrate);
    // The tests hide themselves as the state changes; this listener comes
    // after theirs, so it sees what they decided.
    const follow = (): void => {
        root.classList.toggle("hidden", center.classList.contains("hidden") && calibrate.classList.contains("hidden"));
    };
    ctx.store.subscribe(follow);
    follow();
}
