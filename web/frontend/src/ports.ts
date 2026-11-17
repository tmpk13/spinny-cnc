// Telling a G-code controller's serial port (a pick and place machine's
// Marlin, Smoothieware, a Duet, Grbl) from this machine's by the names its
// USB device gives, so the top bar never offers one for this machine and
// the PNP page's device panel offers them first. Also what every place
// that connects shares: the port to offer first, the machine file a port
// opens as, the ports shown and what a port is called.

import type { Port } from "./types.ts";

/** Words in a port's USB names that a G-code controller's carry: Marlin's, Opulo's LumenPnP's, Smoothieware's, a Duet's, Grbl's. */
export const GCODE_WORDS = ["marlin", "lumen", "opulo", "cdc in fs mode", "smoothie", "duet", "reprap", "grbl"];

/** A port that looks like a G-code controller: by its USB names, or as an STM32 virtual COM port (Marlin on an STM32 board). */
export function gcodePort(port: Port): boolean {
    const words = `${port.product ?? ""} ${port.manufacturer ?? ""} ${port.description} ${port.url}`.toLowerCase();
    if (GCODE_WORDS.some((word) => words.includes(word))) {
        return true;
    }
    return port.vid === 0x0483 && port.pid === 0x5740;
}

/** How often the ports are listed again while nothing is connected, ms: a controller plugged in shows up by itself. */
export const PORT_POLL_MS = 10_000;
/**
 * The port to offer first: the controller by name, then the url last used,
 * then a G-code machine's port its file claims, then any USB device that
 * does not look like an unclaimed G-code controller, then anything.
 */
export function defaultPort(ports: Port[]): Port | null {
    const usb = ports.filter((port) => port.kind === "usb" && (port.machine || !gcodePort(port)));
    return ports.find((port) => port.spinny)
        ?? ports.find((port) => port.kind === "last")
        ?? ports.find((port) => port.machine)
        ?? usb[0]
        ?? ports.find((port) => !gcodePort(port))
        ?? null;
}

/** The G-code machine file a url opens as: the one the port listed under it names; null for this project's firmware. */
export function machineOfPort(ports: Port[], url: string): string | null {
    return ports.find((port) => port.url === url || port.device === url)?.machine ?? null;
}

/** The ports shown: without the built-in ones when asked, which are never the controller. */
export function visiblePorts(ports: Port[], hideSystem: boolean): Port[] {
    return hideSystem ? ports.filter((port) => port.kind !== "system") : ports;
}

/**
 * What the select says for a port, short: the G-code machine it is, else
 * what it is, then its device node (the long by-id url is the field's).
 */
export function portLabel(port: Port): string {
    const name = port.product || port.description;
    const where = port.device && port.device !== port.url ? port.device : port.url;
    if (port.kind === "machine") {
        return `${port.machine_name ?? port.description}: ${port.url}`;
    }
    if (port.machine_name) {
        return `${port.machine_name}: ${where}`;
    }
    return name ? `${name} (${where})` : where;
}
