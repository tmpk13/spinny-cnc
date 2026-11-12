// G-code machines for the page's tests: a profile written the way the tests
// write them made into a G-code machine file, read as the mock reads it,
// and saved into the mock's machine files and connected as the top bar
// connects a G-code machine.

import type { MockBackend } from "../src/mock/backend.ts";
import { gcodeMachineOf } from "../src/mock/machines.ts";
import type { MockDevice } from "../src/mock/openpnp.ts";

/** Where the tests connect their G-code machines; the mock answers on any url. */
export const RIG_URL = "socket://127.0.0.1:9";

/** A profile made a G-code machine file: `controller = "gcode"` first, its up camera's table under that name. */
export function gcodeFile(text: string): string {
    return `controller = "gcode"\n${text.replace(/^\[camera\]/gm, "[up_camera]")}`;
}

/** A profile read as the G-code machine it makes, as the mock reads machine files. */
export function parseDevice(text: string, id: string): MockDevice {
    return gcodeMachineOf(gcodeFile(text), id);
}

/** The profile saved as a machine file, when given, and the machine connected from the top bar. */
export async function connectGcode(backend: MockBackend, id: string, text?: string, url = RIG_URL): Promise<void> {
    if (text !== undefined) {
        await backend.saveMachineFile(id, gcodeFile(text));
    }
    await backend.connect(url, id);
}
