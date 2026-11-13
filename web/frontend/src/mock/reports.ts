// The mock's twin of the backend's bug reports (spinny_web.reports): the
// report link kept in memory, reports kept in memory under the folder name
// the backend would give them, a GitHub link answered with the issue page
// the backend would make, and a post refused, since the mock sends nothing
// anywhere.

import { ApiError } from "../api.ts";
import { githubRepository, issueUrl, linkKind, MAX_REPORT_TEXT, reportTitle, type BugReport, type ReportAnswer, type ReportSettings } from "../reports.ts";

const MAX_LINK = 500;

/** The link trimmed, or the backend's 400 for what is wrong with it. */
export function checkedLink(link: string): string {
    const trimmed = link.trim();
    if (trimmed === "") {
        return "";
    }
    if (trimmed.length > MAX_LINK || /\s/.test(trimmed)) {
        throw new ApiError(400, `the report link is an http or https address of at most ${MAX_LINK} characters, without spaces`);
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new ApiError(400, "the report link is an http or https address, such as https://github.com/owner/repository");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
        throw new ApiError(400, "the report link is an http or https address, such as https://github.com/owner/repository");
    }
    return trimmed;
}

function stamp(now: Date): string {
    const two = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

export class MockReports {
    private link = "";
    /** The reports kept, by folder name: what the backend would have written. */
    readonly kept = new Map<string, { report: BugReport; files: string[] }>();

    constructor(private readonly clock: () => Date = () => new Date()) {}

    settings(): ReportSettings {
        return { link: this.link, kind: linkKind(this.link) };
    }

    setLink(link: string): ReportSettings {
        this.link = checkedLink(link);
        return this.settings();
    }

    save(report: BugReport): ReportAnswer {
        const text = report.text.trim();
        if (text === "") {
            throw new ApiError(400, "say what happened");
        }
        if (text.length > MAX_REPORT_TEXT) {
            throw new ApiError(400, `what happened is at most ${MAX_REPORT_TEXT} characters`);
        }
        const base = stamp(this.clock());
        let serial = 0;
        while (this.kept.has(`${base}-${String(serial).padStart(3, "0")}`)) {
            serial += 1;
        }
        const id = `${base}-${String(serial).padStart(3, "0")}`;
        const folder = `var/reports/${id}`;
        const files = ["report.txt", ...(report.screenshot ? ["screenshot.png"] : []), ...(report.actions ? ["actions.json"] : [])];
        this.kept.set(id, { report, files });
        const answer: ReportAnswer = { id, folder, files, link: null };
        const repository = githubRepository(this.link);
        if (repository) {
            const facts = ["Version: mock", `Page: ${report.page || "-"}`, `Browser: ${report.browser || "-"}`, `Window: ${report.window || "-"}`];
            if (report.screenshot) {
                facts.push(`Screenshot: saved on the machine the backend runs on, as ${folder}/screenshot.png: attach it here.`);
            }
            answer.link = { kind: "github", url: issueUrl(repository[0], repository[1], reportTitle(text), text, facts, report.actions) };
        } else if (this.link !== "") {
            answer.link = { kind: "post", url: this.link, taken: false, status: null, detail: "the mock sends nothing anywhere" };
        }
        return answer;
    }
}
