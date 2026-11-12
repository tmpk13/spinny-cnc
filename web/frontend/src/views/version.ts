// The Config page's Version panel: the release this backend runs from,
// the latest one GitHub lists (Check), and the update to it (Update): the
// archive for this platform downloaded, checked against the SHA256SUMS
// published beside it, unpacked beside the running release, and the link
// `spinny` beside them pointed at it. The running backend goes on with the
// code it started with until it is started again from that link. A
// checkout of the repository updates with git instead, and says so.

import { button, el, lockFor, replace } from "../dom.ts";
import type { UpdateState } from "../types.ts";
import type { Ctx } from "./context.ts";

/** How often the panel asks how an update is going while one is, ms. */
export const UPDATE_POLL_MS = 500;

function megabytes(bytes: number): string {
    return (bytes / 1e6).toFixed(1);
}

/** What the panel says of the state, a line each; the second item says whether the last line is a problem. */
export function versionLines(state: UpdateState): { lines: string[]; problem: string | null } {
    if (state.kind === "checkout") {
        return { lines: [`${state.version}, a checkout of the repository: it updates with git (git pull), not from the releases.`], problem: null };
    }
    const lines = [`${state.version}, a release for ${state.platform ?? "a platform its VERSION file does not name"}.`];
    const latest = state.latest;
    if (latest) {
        const said: Record<string, string> = {
            newer: "newer: Update installs it beside this one",
            same: "this one",
            older: "older than this one",
            other: "the same version, as released: Update installs it beside this build",
        };
        const published = latest.published ? ` (${latest.published.slice(0, 10)})` : "";
        lines.push(`Latest on GitHub: ${latest.version}${published}, ${said[state.status ?? "same"] ?? state.status}.`);
    } else if (state.checked === null) {
        lines.push("Not checked yet: Check asks GitHub for the latest release.");
    }
    if (state.state === "downloading") {
        lines.push(`Downloading ${latest?.archive ?? "the archive"}: ${megabytes(state.done)} of ${megabytes(state.total)} MB.`);
    } else if (state.state === "unpacking") {
        lines.push("Checked against SHA256SUMS; unpacking it.");
    } else if (state.state === "done") {
        lines.push(
            `Installed ${state.installed} beside this one, and ${state.link} points at it; ${state.previous} stays for a rollback`
            + ` (spinny-web --rollback). Restart from ${state.link}/bin/spinny-web to finish.`,
        );
    }
    return { lines, problem: state.error };
}

export function mountVersion(root: HTMLElement, ctx: Ctx): void {
    const said = el("div", { class: "stack" });
    const check = button("Check", () => run(ctx.api.updateCheck()), "btn");
    check.title = "Ask GitHub for the latest release";
    const install = button("Update", () => run(ctx.api.updateInstall()), "btn");
    install.title = "Download the latest release for this platform, check it and install it beside this one";
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Version")),
        el("div", { class: "panel-body" },
            said,
            el("div", { class: "button-row" }, check, install),
        ),
    );

    let polling: ReturnType<typeof setTimeout> | null = null;

    function show(state: UpdateState): void {
        const { lines, problem } = versionLines(state);
        replace(said,
            ...lines.map((line) => el("p", { class: "muted" }, line)),
            ...(problem ? [el("p", { class: "config-status error" }, problem)] : []),
        );
        const checkout = state.kind === "checkout";
        const busy = state.state === "downloading" || state.state === "unpacking";
        lockFor(check,
            [checkout, "a checkout updates with git"],
            [busy, "an update is under way"],
        );
        lockFor(install,
            [checkout, "a checkout updates with git"],
            [busy, "an update is under way"],
            [state.state === "done", "installed: restart from the link to finish"],
            [state.latest === null, "check for a release first"],
            [state.latest !== null && state.latest.archive === null, `the release has no archive for ${state.platform}`],
            [state.status !== "newer" && state.status !== "other", "nothing newer to install"],
        );
        if (busy && polling === null) {
            polling = setTimeout(() => {
                polling = null;
                void refresh();
            }, UPDATE_POLL_MS);
        }
    }

    async function refresh(): Promise<void> {
        const state = await ctx.call(ctx.api.updateState());
        if (state) {
            show(state);
        }
    }

    async function run(asked: Promise<UpdateState>): Promise<void> {
        const state = await ctx.call(asked);
        if (state) {
            show(state);
        } else {
            await refresh();
        }
    }

    void refresh();
}
