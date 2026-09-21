// A confirm dialog that returns a promise.

import { el } from "./dom.ts";

export function askConfirm(message: string, okLabel = "Confirm"): Promise<boolean> {
    if (typeof HTMLDialogElement !== "function" || !("showModal" in HTMLDialogElement.prototype)) {
        return Promise.resolve(window.confirm(message));
    }
    return new Promise((resolve) => {
        const dialog = el("dialog", { class: "confirm" });
        const finish = (value: boolean): void => {
            dialog.close();
            dialog.remove();
            resolve(value);
        };
        const ok = el("button", { type: "button", class: "btn btn-danger", onclick: () => finish(true) }, okLabel);
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
        ok.focus();
    });
}
