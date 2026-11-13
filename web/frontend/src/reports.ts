// Bug reports as the backend keeps them (spinny_web.reports): what a report
// carries, what the backend answers, where reports are handed on, and the
// words and the GitHub address the backend makes of a report, which the
// mock makes the same way.

import { actionLine, type Action } from "./actions.ts";

/** What a bug report says and carries. */
export interface BugReport {
    /** What happened, in the operator's words; its first line is the title. */
    text: string;
    /** The page shown. */
    page: string;
    address: string;
    browser: string;
    /** The window's size, "1440 x 900". */
    window: string;
    /** What was done lately, oldest first, as reportAction writes them; null leaves them out. */
    actions: Record<string, string | number>[] | null;
    /** The screenshot, a PNG; null leaves it out. */
    screenshot: Blob | null;
}

/** Where a report went past the backend: a GitHub new-issue page for the page to open, or a post and whether it was taken. */
export type ReportLink =
    | { kind: "github"; url: string }
    | { kind: "post"; url: string; taken: boolean; status: number | null; detail: string };

export interface ReportAnswer {
    /** The report's folder name, when it came. */
    id: string;
    /** The folder it is kept in, on the machine the backend runs on. */
    folder: string;
    files: string[];
    link: ReportLink | null;
}

/** The report link: a GitHub repository's address, any other http(s) address, or empty for none. */
export interface ReportSettings {
    link: string;
    kind: "github" | "post" | null;
}

/** The most text a report takes, characters. */
export const MAX_REPORT_TEXT = 20000;
/** The longest new-issue address made: GitHub refuses one much past 8 KB. */
export const MAX_ISSUE_URL = 6000;

const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/issues(?:\/new)?)?\/?$/;

/** The owner and name of the GitHub repository a link names; null for any other link. */
export function githubRepository(link: string): [string, string] | null {
    const match = GITHUB.exec(link);
    if (!match || match[2] === "." || match[2] === "..") {
        return null;
    }
    return [match[1]!, match[2]!];
}

export function linkKind(link: string): ReportSettings["kind"] {
    if (link === "") {
        return null;
    }
    return githubRepository(link) ? "github" : "post";
}

/** An issue's title: the text's first line, cut to 80 characters. */
export function reportTitle(text: string): string {
    const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
    if (first === "") {
        return "Bug report";
    }
    return first.length <= 80 ? first : `${first.slice(0, 79).trimEnd()}...`;
}

/** An action as reportAction wrote it, read back for its line. */
function actionOf(entry: Record<string, string | number>): Action {
    const at = typeof entry["at"] === "string" ? Date.parse(entry["at"]) : Number.NaN;
    return { ...(entry as unknown as Action), at: Number.isFinite(at) ? at : 0 };
}

/**
 * A repository's new-issue page with the title and the body filled in: the
 * text, the facts, and as many of the newest actions as keep the address
 * under MAX_ISSUE_URL; a text too long for it is cut, saying where the
 * rest is. The backend makes the same of a report.
 */
export function issueUrl(owner: string, repo: string, title: string, text: string, facts: string[], actions: Record<string, string | number>[] | null): string {
    const base = `https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent(title)}&body=`;
    const lines = (actions ?? []).map((entry) => actionLine(actionOf(entry)));
    const body = (said: string, kept: string[]): string => {
        const parts = [said, "", "---", ...facts];
        if (kept.length > 0) {
            parts.push("", `What was done lately, oldest first (${kept.length} of ${lines.length}; all of them in actions.json):`, "```", ...kept, "```");
        }
        return parts.join("\n");
    };
    const fits = (said: string, kept: string[]): boolean => base.length + encodeURIComponent(body(said, kept)).length <= MAX_ISSUE_URL;
    let low = 0;
    let high = lines.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (fits(text, lines.slice(middle))) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    let kept = lines.slice(low);
    let said = text;
    if (!fits(said, kept)) {
        kept = [];
        const note = "\n\n(cut here: the whole text is in report.txt)";
        let shortest = 0;
        let longest = text.length;
        while (shortest < longest) {
            const middle = Math.floor((shortest + longest + 1) / 2);
            if (fits(text.slice(0, middle) + note, kept)) {
                shortest = middle;
            } else {
                longest = middle - 1;
            }
        }
        said = text.slice(0, shortest) + note;
    }
    return base + encodeURIComponent(body(said, kept));
}
