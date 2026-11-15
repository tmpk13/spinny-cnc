// Message toasts, dismissed after a while or on click.

import { el, replace } from "../dom.ts";
import { dropToast } from "../state.ts";
import type { Ctx } from "./context.ts";

export const TOAST_MS = { info: 4000, error: 8000 };

export function mountToasts(root: HTMLElement, ctx: Ctx): void {
    const scheduled = new Set<number>();
    ctx.store.subscribe((state) => {
        replace(root, ...state.toasts.map((toast) => {
            if (!scheduled.has(toast.id)) {
                scheduled.add(toast.id);
                setTimeout(() => {
                    scheduled.delete(toast.id);
                    dropToast(ctx.store, toast.id);
                }, TOAST_MS[toast.level]);
            }
            const action = toast.action;
            // The action's button runs it and lets the toast go; a press
            // anywhere else on the toast only lets it go.
            const press = action
                ? el("button", { type: "button", class: "btn btn-small toast-action", onclick: (event: Event) => {
                    event.stopPropagation();
                    dropToast(ctx.store, toast.id);
                    action.run();
                } }, action.label)
                : null;
            return el("div", { class: `toast ${toast.level}`, role: "status", onclick: () => dropToast(ctx.store, toast.id) }, toast.text, ...(press ? [press] : []));
        }));
    }, ["toasts"]);
}
