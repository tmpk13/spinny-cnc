// A confirm dialog that returns a promise.

import { el } from "./dom.ts";

/** How long after opening the confirm button starts taking clicks; tests set it to zero. */
export const confirmSettle = { ms: 250 };

export function askConfirm(message: string, okLabel = "Confirm"): Promise<boolean> {
    if (typeof HTMLDialogElement !== "function" || !("showModal" in HTMLDialogElement.prototype)) {
        return Promise.resolve(window.confirm(message));
    }
    return new Promise((resolve) => {
        const dialog = el("dialog", { class: "confirm" });
        const opened = performance.now();
        const finish = (value: boolean): void => {
            dialog.close();
            dialog.remove();
            resolve(value);
        };
        // Confirming takes a separate act: the dialog opens with Cancel
        // focused, so a held or repeated Enter from the button that opened
        // it cannot fire the beam, and an activation in the first moments
        // (a double click landing on the button) is not taken either.
        const ok = el("button", { type: "button", class: "btn btn-danger", onclick: () => {
            if (performance.now() - opened >= confirmSettle.ms) {
                finish(true);
            }
        } }, okLabel);
        const cancel = el("button", { type: "button", class: "btn", onclick: () => finish(false) }, "Cancel");
        dialog.append(
            el("p", {}, message),
            el("div", { class: "confirm-actions" }, cancel, ok),
        );
        dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            finish(false);
        });
        document.body.appendChild(dialog);
        dialog.showModal();
        cancel.focus();
    });
}
