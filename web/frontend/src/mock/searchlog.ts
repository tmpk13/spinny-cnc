// The mock's twin of the search records (spinny_web.searchlog): a line for
// each board search the mock ran to its end, kept in memory. The backend
// also records every look for a board and each search's poses, pictures
// and board file; the mock keeps none of those, so a record's links open a
// page that says so.

import { escapeHtml as escape } from "../highlight.ts";
import type { BoardEstimate, SearchCamera, SearchLogState, SearchRecordLine } from "../types.ts";

/** Records kept at most, as the backend keeps them. */
export const MAX_RECORDS = 60;
/** Records a listing gives at most, as the backend's default. */
export const LISTED = 20;

/** What a search that ended says. */
export interface SearchEnd {
    camera: SearchCamera;
    job: string;
    jobName: string;
    /** found, not found, or error (a move refused). */
    result: string;
    message: string | null;
    seconds: number;
    stops: number;
    visited: number;
    estimate: BoardEstimate | null;
}

export class MockSearchLog {
    records: SearchRecordLine[] = [];
    private serial = 0;

    /** A search's line, as it ended; the line kept. */
    add(end: SearchEnd): SearchRecordLine {
        const now = new Date();
        const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
        const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(this.serial++ % 1000, 3)}`;
        const line: SearchRecordLine = {
            id,
            kind: "search",
            camera: end.camera,
            started: new Date(now.getTime() - end.seconds * 1000).toISOString(),
            job: end.job,
            job_name: end.jobName,
            board: null,
            result: end.result,
            message: end.message,
            seconds: Math.round(end.seconds * 10) / 10,
            stops: end.stops,
            visited: end.visited,
            poses: null,
            pictures: 0,
            agree: end.result === "found" ? 5 : 0,
            estimate: end.estimate,
        };
        this.records.push(line);
        if (this.records.length > MAX_RECORDS) {
            this.records.splice(0, this.records.length - MAX_RECORDS);
        }
        return line;
    }

    state(camera?: SearchCamera, limit = LISTED): SearchLogState {
        const lines = this.records.filter((line) => camera === undefined || line.camera === camera);
        return { count: lines.length, records: [...lines].reverse().slice(0, limit).map((line) => structuredClone(line)) };
    }
}

/** The page a record's link opens in the mock. */
export function mockRecordUrl(id: string, name: string): string {
    const page = `<title>Search record ${escape(id)}</title><p>The mock keeps a line for each search it ran, not its ${escape(name)}: the backend writes the record's page, its poses and a picture at each stop.</p>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
}
