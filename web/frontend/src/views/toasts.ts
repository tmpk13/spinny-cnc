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
            return el("div", { class: `toast ${toast.level}`, role: "status", onclick: () => dropToast(ctx.store, toast.id) }, toast.text);
        }));
    }, ["toasts"]);
}
