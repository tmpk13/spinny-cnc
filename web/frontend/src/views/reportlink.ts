// The Config page's Bug reports panel: the report link, a backend setting
// since the backend hands reports on. Empty, the default, a report is only
// kept on the backend; a GitHub repository's address opens a new issue
// there filled in; any other http(s) address gets the report posted to it.

import { button, el, onEnter } from "../dom.ts";
import { githubRepository, type ReportSettings } from "../reports.ts";
import type { Ctx } from "./context.ts";

/** What the panel says the link does. */
export function linkSays(settings: ReportSettings): string {
    if (settings.link === "") {
        return "Off: reports are only kept on the backend.";
    }
    const repository = githubRepository(settings.link);
    return repository
        ? `A report opens a new issue in ${repository.join("/")} on GitHub, filled in.`
        : `A report is posted to ${settings.link} as JSON.`;
}

export function mountReportLink(root: HTMLElement, ctx: Ctx): { settled(): Promise<void> } {
    const field = el("input", {
        type: "url",
        class: "field report-link",
        placeholder: "https://github.com/owner/repository",
        "aria-label": "Report link",
        autocomplete: "off",
        spellcheck: "false",
    }) as HTMLInputElement;
    const said = el("p", { class: "hint", role: "status" }, "");
    const keep = button("Save", () => store(), "btn", "keep the link; empty hands reports on to nothing");
    field.addEventListener("keydown", onEnter(keep));
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Bug reports")),
        el("div", { class: "panel-body stack" },
            el("p", { class: "muted hint" }, "The bug in the tab bar saves a report under var/reports. A link hands it on too: a GitHub repository, or an address that takes it as JSON."),
            el("div", { class: "button-row" }, field, keep),
            said,
        ),
    );

    function show(settings: ReportSettings): void {
        field.value = settings.link;
        said.textContent = linkSays(settings);
    }

    async function store(): Promise<void> {
        const settings = await ctx.call(ctx.api.setReportLink(field.value));
        if (settings) {
            show(settings);
        }
    }

    const loaded = ctx.call(ctx.api.reportSettings()).then((settings) => {
        if (settings) {
            show(settings);
        }
    });
    return {
        async settled() {
            await loaded;
        },
    };
}
