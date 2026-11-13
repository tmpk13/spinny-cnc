// A bug report: the bug in the tab bar's tools opens a dialog to say what
// happened. A screenshot of the page is taken as the bug is pressed, before
// the dialog covers anything (src/pageshot.ts), and shown small; what was
// done lately (src/actions.ts) is listed in a fold; a box leaves either out.
// Save keeps the report on the backend (var/reports/<time>/) and hands it on
// as the report link set on the Config page says: a GitHub repository's
// new-issue page opens filled in (the screenshot is attached there by hand,
// and the text says where it is kept), or the report is posted to another
// address and the dialog says whether it was taken. Closed without saving,
// the words typed wait for the next report.

import { actionLine, actions, reportAction, type ActionLog } from "../actions.ts";
import { button, el, replace, svgIcon } from "../dom.ts";
import { pageShot } from "../pageshot.ts";
import { githubRepository, type ReportAnswer, type ReportSettings } from "../reports.ts";
import type { Ctx } from "./context.ts";

/** A bug: its body, its head and feelers, three legs a side, in a box 16 units square. */
const BUG = "M4.5 10a3.5 4.5 0 1 0 7 0a3.5 4.5 0 1 0 -7 0zM6.2 3.6a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0z"
    + "M1.2 7h3.5v1h-3.5zM1.2 9.5h2.9v1h-2.9zM1.2 12h3.5v1h-3.5zM11.3 7h3.5v1h-3.5zM11.9 9.5h2.9v1h-2.9zM11.3 12h3.5v1h-3.5z"
    + "M4.3 1.1l0.8 -0.7l1.5 1.6l-0.8 0.7zM11.7 1.1l-0.8 -0.7l-1.5 1.6l0.8 0.7z";

export interface BugReportOptions {
    /** Takes the screenshot: the page's own unless a test gives another. */
    shoot?: () => Promise<Blob>;
    /** What was done lately: the page's own log unless a test gives another. */
    log?: ActionLog;
    /** Opens an address in a new tab; false when the browser would not. */
    openTab?: (url: string) => boolean;
}

/** The words typed in a report closed without saving, for the next one. */
let draft = "";

function openInTab(url: string): boolean {
    const opened = window.open(url, "_blank");
    if (opened) {
        opened.opener = null;
    }
    return opened !== null;
}

/** What the dialog says of where a report goes. */
export function whereReportsGo(settings: ReportSettings | null): string {
    if (settings === null || settings.link === "") {
        return "Kept on the backend in var/reports. No report link is set (Config tab).";
    }
    const repository = githubRepository(settings.link);
    if (repository) {
        return `Kept on the backend in var/reports, then opened as a new issue in ${repository.join("/")} on GitHub.`;
    }
    return `Kept on the backend in var/reports, and posted to ${settings.link}.`;
}

/** Mounts the bug in the tab bar's tools, before the page settings gear. */
export function mountBugReport(tools: HTMLElement, ctx: Ctx, options: BugReportOptions = {}): { button: HTMLButtonElement; open(): HTMLDialogElement } {
    const shoot = options.shoot ?? (async () => (await pageShot()).png);
    const log = options.log ?? actions;
    const openTab = options.openTab ?? openInTab;
    const bug = el("button", { type: "button", class: "tabs-tool tabs-bug", "aria-label": "Report a bug", "aria-haspopup": "dialog", title: "report a bug, with a screenshot" });
    bug.append(svgIcon(BUG));
    const gear = tools.querySelector(".tabs-gear");
    if (gear) {
        gear.before(bug);
    } else {
        tools.append(bug);
    }

    function open(): HTMLDialogElement {
        // Taken now, before the dialog is drawn over the page.
        const shot: Promise<Blob | Error> = shoot().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        const done = log.list();
        let shotUrl: string | null = null;
        let saved = false;

        const area = el("textarea", { class: "field bug-text", rows: 5, "aria-label": "What happened", placeholder: "what you did, what you expected, what happened instead" }) as HTMLTextAreaElement;
        area.value = draft;
        const shotBox = el("input", { type: "checkbox", checked: true }) as HTMLInputElement;
        const shotView = el("div", { class: "bug-shot" }, el("p", { class: "muted hint" }, "Taking the screenshot."));
        const doneBox = el("input", { type: "checkbox", checked: done.length > 0 }) as HTMLInputElement;
        doneBox.disabled = done.length === 0;
        const doneList = el("details", { class: "bug-actions stack" },
            el("summary", { title: "show what the report would carry" }, "What was done lately"),
            el("pre", { class: "bug-actions-list" }, done.map(actionLine).join("\n")),
        );
        doneList.hidden = done.length === 0;
        const where = el("p", { class: "muted hint" }, whereReportsGo(null));
        const problem = el("p", { class: "hint bug-problem", role: "status" });
        const save = button("Save", () => submit(), "btn btn-primary", "keep the report, and hand it on as the report link says");
        const cancel = button("Cancel", () => dialog.close(), "btn", "close without saving; the words typed wait for the next report");
        const form = el("div", { class: "stack" },
            el("label", { class: "labeled" }, el("span", { class: "labeled-text" }, "What happened"), area),
            el("label", { class: "check" }, shotBox, " Include a screenshot"),
            shotView,
            el("label", { class: "check" }, doneBox, ` Include what was done lately (${done.length})`),
            doneList,
            where,
            problem,
            el("div", { class: "button-row" }, save, cancel),
        );
        const outcome = el("div", { class: "stack", role: "status" });
        outcome.hidden = true;
        const dialog = el("dialog", { class: "panel bug-dialog", "aria-label": "Report a bug" },
            el("div", { class: "panel-head" }, el("h2", {}, "Report a bug")),
            form,
            outcome,
        ) as HTMLDialogElement;

        void shot.then((taken) => {
            if (taken instanceof Blob) {
                shotUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(taken) : null;
                replace(shotView, shotUrl ? el("img", { class: "bug-shot-img", src: shotUrl, alt: "The screenshot" }) : el("p", { class: "muted hint" }, "Screenshot taken."));
            } else {
                shotBox.checked = false;
                shotBox.disabled = true;
                replace(shotView, el("p", { class: "muted hint" }, `No screenshot: ${taken.message}.`));
            }
        });
        shotBox.addEventListener("change", () => {
            shotView.hidden = !shotBox.checked;
        });
        void ctx.api.reportSettings().then((settings) => {
            where.textContent = whereReportsGo(settings);
        }, () => undefined);

        async function submit(): Promise<void> {
            const text = area.value.trim();
            if (text === "") {
                problem.textContent = "Say what happened first.";
                area.focus();
                return;
            }
            problem.textContent = "";
            const taken = shotBox.checked ? await shot : null;
            const answer = await ctx.call(ctx.api.saveReport({
                text,
                page: document.getElementById("app")?.getAttribute("data-page") ?? "",
                address: window.location.href,
                browser: navigator.userAgent,
                window: `${window.innerWidth} x ${window.innerHeight}`,
                actions: doneBox.checked ? done.map(reportAction) : null,
                screenshot: taken instanceof Blob ? taken : null,
            }));
            if (answer) {
                saved = true;
                draft = "";
                showOutcome(answer);
            }
        }

        function showOutcome(answer: ReportAnswer): void {
            const said: Node[] = [el("p", {}, `Saved in ${answer.folder}.`)];
            const link = answer.link;
            if (link?.kind === "github") {
                const opened = openTab(link.url);
                said.push(el("p", {}, opened ? "The new issue opened in another tab: look it over and submit it there." : "Open the new issue, look it over and submit it there."));
                if (answer.files.includes("screenshot.png")) {
                    said.push(el("p", { class: "hint" }, `Attach ${answer.folder}/screenshot.png to it: a picture cannot ride in the address.`));
                }
                said.push(el("div", { class: "button-row" },
                    el("a", { class: "btn", href: link.url, target: "_blank", rel: "noopener", title: "the new issue on GitHub, filled in" }, "Open the issue on GitHub"),
                ));
            } else if (link?.kind === "post") {
                said.push(el("p", { class: link.taken ? "" : "bug-problem" }, link.taken
                    ? `Sent to ${link.url}: taken (${link.status}).`
                    : `Not taken by ${link.url}: ${link.detail || (link.status === null ? "no answer" : `status ${link.status}`)}.`));
            }
            const close = button("Close", () => dialog.close(), "btn btn-primary", "close the report");
            said.push(el("div", { class: "button-row" }, close));
            replace(outcome, ...said);
            form.hidden = true;
            outcome.hidden = false;
            close.focus();
        }

        dialog.addEventListener("close", () => {
            if (!saved) {
                draft = area.value;
            }
            if (shotUrl) {
                URL.revokeObjectURL(shotUrl);
            }
            dialog.remove();
            bug.focus({ preventScroll: true });
        });
        document.body.append(dialog);
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
        area.focus();
        return dialog;
    }

    bug.addEventListener("click", () => {
        if (!document.querySelector("dialog.bug-dialog[open]")) {
            open();
        }
    });
    return { button: bug, open };
}
