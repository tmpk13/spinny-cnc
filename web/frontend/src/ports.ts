// Telling a G-code controller's serial port (a pick and place machine's
// Marlin, Smoothieware, a Duet, Grbl) from this machine's by the names its
// USB device gives, so the top bar never offers one for this machine and
// the PNP page's device panel offers them first.

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

