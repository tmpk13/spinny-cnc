// Number formatting for the DRO and the job panel.

/** Fixed decimals; a non-number shows as dashes and a rounded zero has no sign. */
export function formatFixed(value: number | null | undefined, decimals: number): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return decimals > 0 ? "-." + "-".repeat(decimals) : "-";
    }
    let text = value.toFixed(decimals);
    if (Number(text) === 0) {
        text = (0).toFixed(decimals);
    }
    return text;
}

/** Millimeters to three decimals, the protocol's resolution. */
export function formatMm(value: number | null | undefined): string {
    return formatFixed(value, 3);
}

/** Degrees to four decimals, the protocol's resolution. */
export function formatDeg(value: number | null | undefined): string {
    return formatFixed(value, 4);
}

/** A rate in units per minute as a whole number. */
export function formatRate(value: number | null | undefined): string {
    return formatFixed(value, 0);
}

/** Laser duty from permille to a percentage with one decimal. */
export function formatDuty(permille: number | null | undefined): string {
    if (permille === null || permille === undefined || !Number.isFinite(permille)) {
        return "-.-%";
    }
    return formatFixed(permille / 10, 1) + "%";
}

/** A share from 0..1 as a whole percentage. */
export function formatPercent(fraction: number | null | undefined): string {
    if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
        return "-%";
    }
    return Math.round(fraction * 100) + "%";
}

/** Seconds as m:ss, or h:mm:ss from an hour up. */
export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return "-:--";
    }
    const total = Math.round(seconds);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const ss = s.toString().padStart(2, "0");
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
    }
    return `${m}:${ss}`;
}

/** A length in mm with one decimal, in meters past a meter. */
export function formatLength(mm: number | null | undefined): string {
    if (mm === null || mm === undefined || !Number.isFinite(mm)) {
        return "- mm";
    }
    if (Math.abs(mm) >= 1000) {
        return formatFixed(mm / 1000, 2) + " m";
    }
    return formatFixed(mm, 1) + " mm";
}

/** Parses a text field; blank or invalid text gives null. */
export function parseNumber(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === "") {
        return null;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
}
