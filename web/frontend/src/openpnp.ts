// Reading an OpenPnP setup into a G-code machine file: its machine.xml (the
// GcodeDriver's commands, the axes, a nozzle and its vacuum, the cameras,
// the park and discard places, the nozzle tips' dwells and vacuum levels,
// and the feeders), and a job with its boards (where each placement's part
// lies on the machine, which becomes a reference, and which part each
// placement takes, which tells the feeders their parts), and its parts.xml
// and packages.xml (each part's height and its package's body, which give
// a feeder's parts their size for the bottom camera's check and, with the
// job's board height, the height they are placed at). Every value read
// is an item the page shows with a box to keep or leave it; the file is
// written from the items kept over the shipped generic file's defaults.
//
// OpenPnP keeps its places as the points the tools are over: the head's
// cameras and nozzles each sit at their head offset from the head's place,
// the controller's X and Y. A G-code machine file keeps the head's place with
// the nozzle over a point, so each place read here loses the nozzle's head
// offset; the top camera's offset from the nozzle is the camera's head
// offset less the nozzle's.

import type { Component } from "./types.ts";

// --- XML ---------------------------------------------------------------------------

export interface XmlNode {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    /** The text and CDATA directly inside, entities decoded. */
    text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
        if (name.startsWith("#x")) {
            return String.fromCodePoint(parseInt(name.slice(2), 16));
        }
        if (name.startsWith("#")) {
            return String.fromCodePoint(parseInt(name.slice(1), 10));
        }
        return ENTITIES[name] ?? whole;
    });
}

/**
 * The root element of an XML text, as OpenPnP writes its files: elements,
 * attributes, text and CDATA; comments, the declaration and doctypes are
 * passed over. A text that does not close what it opens is refused.
 */
export function parseXml(text: string): XmlNode {
    const top: XmlNode = { name: "", attrs: {}, children: [], text: "" };
    const stack: XmlNode[] = [top];
    let at = 0;
    const attribute = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    while (at < text.length) {
        const open = text.indexOf("<", at);
        const current = stack[stack.length - 1]!;
        if (open < 0) {
            current.text += decode(text.slice(at));
            break;
        }
        if (open > at) {
            current.text += decode(text.slice(at, open));
        }
        if (text.startsWith("<!--", open)) {
            const end = text.indexOf("-->", open + 4);
            if (end < 0) {
                throw new Error("a comment that is never closed");
            }
            at = end + 3;
            continue;
        }
        if (text.startsWith("<![CDATA[", open)) {
            const end = text.indexOf("]]>", open + 9);
            if (end < 0) {
                throw new Error("a CDATA section that is never closed");
            }
            current.text += text.slice(open + 9, end);
            at = end + 3;
            continue;
        }
        if (text.startsWith("<?", open) || text.startsWith("<!", open)) {
            const end = text.indexOf(">", open);
            at = end < 0 ? text.length : end + 1;
            continue;
        }
        const end = text.indexOf(">", open);
        if (end < 0) {
            throw new Error("a tag that is never closed");
        }
        const tag = text.slice(open + 1, end);
        at = end + 1;
        if (tag.startsWith("/")) {
            const name = tag.slice(1).trim();
            const closing = stack.pop();
            if (!closing || closing.name !== name || stack.length === 0) {
                throw new Error(`</${name}> closes ${closing?.name ? `<${closing.name}>` : "nothing"}`);
            }
            continue;
        }
        const selfClosing = tag.endsWith("/");
        const body = selfClosing ? tag.slice(0, -1) : tag;
        const name = body.match(/^[^\s/>]+/)?.[0] ?? "";
        const node: XmlNode = { name, attrs: {}, children: [], text: "" };
        attribute.lastIndex = 0;
        let found: RegExpExecArray | null;
        while ((found = attribute.exec(body.slice(name.length))) !== null) {
            node.attrs[found[1]!] = decode(found[3] ?? found[4] ?? "");
        }
        current.children.push(node);
        if (!selfClosing) {
            stack.push(node);
        }
    }
    if (stack.length !== 1) {
        throw new Error(`<${stack[stack.length - 1]!.name}> is never closed`);
    }
    const root = top.children[0];
    if (!root) {
        throw new Error("no element in the file");
    }
    return root;
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
    return node?.children.find((each) => each.name === name);
}

function kids(node: XmlNode | undefined, name: string): XmlNode[] {
    return node?.children.filter((each) => each.name === name) ?? [];
}

function number(text: string | undefined, fallback = 0): number {
    const value = Number(text);
    return text !== undefined && text.trim() !== "" && Number.isFinite(value) ? value : fallback;
}

interface Place {
    x: number;
    y: number;
    z: number;
    rotation: number;
}

/** Millimeters in one of OpenPnP's length units; 1 for one it does not name. */
function unitScale(units: string | undefined): number {
    return { Millimeters: 1, Inches: 25.4, Centimeters: 10, Meters: 1000, Microns: 0.001 }[units ?? "Millimeters"] ?? 1;
}

/** A location element (location, head-offsets, park-location ...) in millimeters. */
function placeOf(node: XmlNode | undefined): Place | null {
    if (!node) {
        return null;
    }
    const scale = unitScale(node.attrs["units"]);
    return {
        x: number(node.attrs["x"]) * scale,
        y: number(node.attrs["y"]) * scale,
        z: number(node.attrs["z"]) * scale,
        rotation: number(node.attrs["rotation"]),
    };
}

/** A length element (value and units) in millimeters. */
function lengthOf(node: XmlNode | undefined, fallback: number): number {
    if (!node) {
        return fallback;
    }
    const scale = { Millimeters: 1, Inches: 25.4, Centimeters: 10, Meters: 1000, Microns: 0.001 }[node.attrs["units"] ?? "Millimeters"] ?? 1;
    return number(node.attrs["value"], fallback / scale) * scale;
}

/** A value element's text as a number: <vacuum-level-part-on-low>220.0</...>. */
function valueOf(node: XmlNode | undefined): number | null {
    const text = node?.text.trim();
    return text ? (Number.isFinite(Number(text)) ? Number(text) : null) : null;
}

// --- OpenPnP's command templates ---------------------------------------------------------

/** A line without its comment and the space around it. */
function bare(line: string): string {
    return line.split(";", 1)[0]!.trim();
}

/**
 * An actuator's boolean command for one state: each {True:...} and
 * {False:...} part kept for its own state and dropped for the other, the
 * comments taken off, empty lines dropped.
 */
export function branch(lines: string[], on: boolean): string[] {
    return lines
        .map((line) => line.replace(/\{(True|False):([^}]*)\}/g, (_all, which: string, words: string) => ((which === "True") === on ? words : "")))
        .map(bare)
        .filter((line) => line !== "");
}

/** Lines with OpenPnP's {Name:format} variables, the lines that are nothing but one dropped and the comments taken off. */
function plain(lines: string[]): string[] {
    return lines
        .filter((line) => !/^\s*\{[A-Za-z]+:[^}]*\}\s*(;.*)?$/.test(line))
        .map(bare)
        .filter((line) => line !== "" && !/\{[A-Za-z]+:/.test(line));
}

/** OpenPnP's regular expression as the machine file takes it: Java's (?<Value>...) reads in both. */
function pattern(text: string): string {
    return text.trim();
}

// --- the machine -------------------------------------------------------------------------

interface Axis {
    id: string;
    name: string;
    type: string;
    letter: string | null;
    home: number;
    safeLow: number | null;
    safeHigh: number | null;
    feed: number | null;
    /** The axis a mapped axis (OpenPnP's ReferenceMappedAxis) follows: a seesaw's other nozzle's Z follows the first's. */
    input: string | null;
    /** OpenPnP's class for it, its last name: ReferenceControllerAxis, ReferenceMappedAxis, ReferenceLinearTransformAxis. */
    kind: string;
    /**
     * A linear transform axis's X and Y inputs and their factors: this axis
     * is factorX * X + factorY * Y of the controller's axes. OpenPnP takes
     * out its axes' non-squareness so, on the X axis: X plus the factor
     * times Y.
     */
    inputX: string | null;
    inputY: string | null;
    factorX: number;
    factorY: number;
}

interface Command {
    type: string;
    mount: string | null;
    lines: string[];
}

interface Nozzle {
    id: string;
    name: string;
    offset: Place;
    axes: { x?: string; y?: string; z?: string; rotation?: string };
    vacuum: string | null;
    sense: string | null;
    tips: string[];
    pickDwell: number;
    placeDwell: number;
}

interface Tip {
    id: string;
    name: string;
    pickDwell: number;
    placeDwell: number;
    partOn: [number, number] | null;
    partOff: [number, number] | null;
}

interface Camera {
    id: string;
    name: string;
    looking: string;
    place: Place;
    mmPerPx: number;
    light: string | null;
    /** OpenPnP's turn of the picture, degrees, and its flips of it. */
    rotation: number;
    flipX: boolean;
    flipY: boolean;
}

export interface OpenPnpFeeder {
    kind: string;
    id: string;
    name: string;
    partId: string;
    enabled: boolean;
    at: Place;
    pitch: [number, number];
    count: number;
    columns: number;
    rowPitch: [number, number];
    rotation: number;
    taken: number;
    /** An auto feeder's actuator, which is told to feed. */
    actuator: string | null;
    note: string | null;
    /** Why its place cannot be read from the file, when it cannot: such a feeder is left out. */
    unplaced: string | null;
    /** A Photon feeder: its id on the bus, its pick place from its slot's, and its advance per part, mm. */
    busId: string | null;
    busOffset: Place | null;
    advance: number;
}

export interface OpenPnpMachine {
    port: string | null;
    baud: number | null;
    /** The Photon feeders' bus as its data actuator sends and reads it, and its slots' places. */
    busSend: string | null;
    busReply: string | null;
    slots: { address: number; place: Place }[];
    commands: Command[];
    axes: Map<string, Axis>;
    nozzles: Nozzle[];
    tips: Map<string, Tip>;
    cameras: Camera[];
    actuators: Map<string, string>;
    park: Place | null;
    discard: Place | null;
    /** The head's homing fiducial, where the top camera looks for it; null when the file has none (or all zeros). */
    homeFiducial: Place | null;
    feeders: OpenPnpFeeder[];
    /** OpenPnP 1's GcodeDriver non-squareness factor, which it added to X as the nozzle's place went out (X plus it times Y); 0 for none. */
    driverSkew: number;
}

function commandsOf(driver: XmlNode | undefined): Command[] {
    return kids(driver, "command").map((node) => ({
        type: node.attrs["type"] ?? "",
        mount: node.attrs["head-mountable-id"] ?? null,
        lines: kids(node, "text").map((text) => text.text),
    }));
}

function axesOf(machine: XmlNode): Map<string, Axis> {
    const axes = new Map<string, Axis>();
    for (const node of kids(child(machine, "axes"), "axis")) {
        const id = node.attrs["id"] ?? "";
        axes.set(id, {
            id,
            name: node.attrs["name"] ?? id,
            type: node.attrs["type"] ?? "",
            letter: node.attrs["letter"] ?? null,
            home: lengthOf(child(node, "home-coordinate"), 0),
            safeLow: node.attrs["safe-zone-low-enabled"] === "true" ? lengthOf(child(node, "safe-zone-low"), 0) : null,
            safeHigh: node.attrs["safe-zone-high-enabled"] === "true" ? lengthOf(child(node, "safe-zone-high"), 0) : null,
            feed: child(node, "feedrate-per-second") ? lengthOf(child(node, "feedrate-per-second"), 0) * 60 : null,
            input: node.attrs["input-axis-id"] ?? null,
            kind: (node.attrs["class"] ?? "").split(".").pop() ?? "",
            inputX: node.attrs["input-axis-x-id"] || null,
            inputY: node.attrs["input-axis-y-id"] || null,
            factorX: number(node.attrs["factor-x"]),
            factorY: number(node.attrs["factor-y"]),
        });
    }
    return axes;
}

function cameraOf(node: XmlNode): Camera {
    const units = placeOf(child(node, "units-per-pixel"));
    return {
        id: node.attrs["id"] ?? "",
        name: node.attrs["name"] ?? "",
        looking: node.attrs["looking"] ?? "",
        place: placeOf(child(node, "head-offsets")) ?? { x: 0, y: 0, z: 0, rotation: 0 },
        mmPerPx: units ? (Math.abs(units.x) + Math.abs(units.y)) / 2 : 0,
        light: node.attrs["light-actuator-id"] ?? null,
        rotation: number(node.attrs["rotation"]),
        flipX: node.attrs["flip-x"] === "true",
        flipY: node.attrs["flip-y"] === "true",
    };
}

/**
 * How a down-looking camera's own picture is turned as mounted, degrees,
 * from the transform OpenPnP puts on it to show it upright: flipping both
 * ways is a half turn (Opulo's LumenPnP top camera); null when OpenPnP
 * turns it by some other amount or flips it one way only, which a turn
 * cannot undo.
 */
export function downCameraRoll(camera: { rotation: number; flipX: boolean; flipY: boolean }): number | null {
    if (camera.flipX !== camera.flipY || camera.rotation !== 0) {
        return null;
    }
    return camera.flipX ? 180 : 0;
}

function feederOf(node: XmlNode, nozzleOffset: Place): OpenPnpFeeder {
    const kind = (node.attrs["class"] ?? "").split(".").pop() ?? "";
    const base = {
        kind,
        id: node.attrs["id"] ?? "",
        name: node.attrs["name"] ?? node.attrs["id"] ?? "",
        partId: node.attrs["part-id"] ?? "",
        enabled: node.attrs["enabled"] !== "false",
        pitch: [0, 0] as [number, number],
        count: 0,
        columns: 0,
        rowPitch: [0, 0] as [number, number],
        taken: number(node.attrs["feed-count"]),
        actuator: node.attrs["actuator-name"] ?? null,
        note: null as string | null,
        unplaced: null as string | null,
        busId: null as string | null,
        busOffset: null as Place | null,
        advance: 4,
    };
    const location = placeOf(child(node, "location")) ?? { x: 0, y: 0, z: 0, rotation: 0 };
    // A place of 0, 0, 0 is one never set: going there would take the
    // nozzle down to Z 0 wherever that is.
    const unset = location.x === 0 && location.y === 0 && location.z === 0 ? "its place is not set in the file" : null;
    // The head's place with the nozzle over a point.
    const head = (place: Place): Place => ({ x: place.x - nozzleOffset.x, y: place.y - nozzleOffset.y, z: place.z - nozzleOffset.z, rotation: place.rotation });
    if (kind === "ReferenceTrayFeeder" || kind === "ReferenceRotatedTrayFeeder") {
        const offsets = placeOf(child(node, "offsets")) ?? { x: 0, y: 0, z: 0, rotation: 0 };
        const countX = number(node.attrs["tray-count-x"] ?? node.attrs["tray-count-cols"], 1);
        const countY = number(node.attrs["tray-count-y"] ?? node.attrs["tray-count-rows"], 1);
        // OpenPnP walks the longer side last: along Y first when X has the most.
        const yFirst = countX >= countY;
        return {
            ...base,
            at: head(location),
            pitch: yFirst ? [0, offsets.y] : [offsets.x, 0],
            columns: yFirst ? countY : countX,
            rowPitch: yFirst ? [offsets.x, 0] : [0, offsets.y],
            count: countX * countY,
            rotation: location.rotation,
            note: kind === "ReferenceRotatedTrayFeeder" ? "a rotated tray, read as square to the axes" : null,
            unplaced: unset,
        };
    }
    if (kind === "ReferenceStripFeeder") {
        const first = placeOf(child(node, "reference-hole-location")) ?? location;
        const last = placeOf(child(node, "last-hole-location")) ?? first;
        const partPitch = lengthOf(child(node, "part-pitch"), 4);
        const tapeWidth = lengthOf(child(node, "tape-width"), 8);
        const along = Math.atan2(last.y - first.y, last.x - first.x);
        const span = Math.hypot(last.x - first.x, last.y - first.y);
        // The part sits beside the hole line, past the first hole by 2 mm.
        const lateral = tapeWidth / 2 - 0.5;
        const turn = along - Math.PI / 2;
        const part = { x: lateral * Math.cos(turn) - 2 * Math.sin(turn), y: lateral * Math.sin(turn) + 2 * Math.cos(turn) };
        const pitch: [number, number] = [partPitch * Math.cos(along), partPitch * Math.sin(along)];
        // The strip starts at the part OpenPnP would take next.
        const fed = Math.max(0, base.taken);
        const at = head({ x: first.x + part.x + fed * pitch[0], y: first.y + part.y + fed * pitch[1], z: first.z, rotation: 0 });
        const most = number(node.attrs["max-feed-count"]);
        const eia = node.attrs["standard-eia-481"] === "true";
        const total = most > 0 ? most : Math.max(1, Math.round(span / partPitch) + 1);
        // Fed to its end, the next part would lie past the strip's last.
        const used = fed >= total ? `OpenPnP has fed all ${total} of its parts` : null;
        return {
            ...base,
            at,
            pitch,
            count: Math.max(1, total - fed),
            rotation: (turn * 180) / Math.PI + (eia ? 90 : 0) + location.rotation,
            note: fed > 0 ? `starts at OpenPnP's next part, #${fed + 1}` : null,
            unplaced: first.x === 0 && first.y === 0 && first.z === 0 ? "its reference hole is not set in the file" : used,
        };
    }
    if (kind === "PhotonFeeder") {
        // Its slot is found on the bus by its hardware id when a run starts
        // (OpenPnP keeps no slot for it), and its place is the slot's with
        // its offset; it advances by its part pitch.
        const id = (node.attrs["hardware-id"] ?? "").toUpperCase();
        if (!/^[0-9A-F]{24}$/.test(id)) {
            return { ...base, at: head(location), rotation: 0, unplaced: "a Photon feeder with no hardware id in the file" };
        }
        return {
            ...base, at: head(location), rotation: 0,
            busId: id,
            busOffset: placeOf(child(node, "offset")) ?? { x: 0, y: 0, z: 0, rotation: 0 },
            advance: Math.min(25.5, Math.max(0.1, number(node.attrs["part-pitch"], 4))),
        };
    }
    // An auto feeder, a tube, a drag feeder: picked from one place.
    const known = ["ReferenceAutoFeeder", "ReferenceTubeFeeder", "ReferenceDragFeeder", "ReferencePushPullFeeder", "ReferenceLoosePartFeeder"].includes(kind);
    return {
        ...base, at: head(location), rotation: location.rotation, unplaced: unset,
        note: kind === "ReferenceAutoFeeder" ? null : known ? `a ${kind}: picked at its one place` : `a ${kind}, which the import does not know: check its place before keeping it`,
        enabled: base.enabled && known,
    };
}

/**
 * The Photon feeders' bus: the PhotonFeederData actuator's read command and
 * pattern (OpenPnP's defaults, M485 and rs485-reply, when the file has no
 * actuator), and the slots' places, kept in the machine's properties.
 */
function busOf(machine: XmlNode, driver: XmlNode | undefined, head: XmlNode | undefined): { busSend: string | null; busReply: string | null; slots: { address: number; place: Place }[] } {
    const actuator = [...kids(child(machine, "actuators"), "actuator"), ...kids(child(head, "actuators"), "actuator")].find((node) => node.attrs["name"] === "PhotonFeederData");
    const commands = commandsOf(driver).filter((command) => actuator !== undefined && command.mount === actuator.attrs["id"]);
    const read = commands.find((command) => command.type === "ACTUATOR_READ_COMMAND")?.lines.map(bare).find((line) => line.includes("{Value}"));
    const regex = commands.find((command) => command.type === "ACTUATOR_READ_REGEX")?.lines.join("").trim();
    const slots: { address: number; place: Place }[] = [];
    for (const entry of kids(child(machine, "properties"), "entry")) {
        if (child(entry, "string")?.text.trim() !== "PhotonFeeder.FeederSlots") {
            continue;
        }
        const holder = child(child(entry, "object"), "slots") ?? child(entry, "object");
        for (const slot of kids(holder, "slot")) {
            const place = placeOf(child(slot, "location"));
            const address = number(slot.attrs["address"], 0);
            if (place && address >= 1 && address <= 254 && !(place.x === 0 && place.y === 0 && place.z === 0)) {
                slots.push({ address, place });
            }
        }
    }
    return { busSend: read ? read.replace("{Value}", "{packet}") : null, busReply: regex || null, slots };
}

/** The setup an OpenPnP machine.xml describes. */
export function readMachine(text: string): OpenPnpMachine {
    const root = parseXml(text);
    if (root.name !== "openpnp-machine") {
        throw new Error(`not an OpenPnP machine.xml: its root is <${root.name}>`);
    }
    const machine = child(root, "machine");
    if (!machine) {
        throw new Error("no <machine> in the file");
    }
    const driver = kids(child(machine, "drivers"), "driver").find((node) => (node.attrs["class"] ?? "").endsWith("GcodeDriver"));
    const serial = child(driver, "serial");
    const tcp = child(driver, "tcp");
    let port: string | null = null;
    if (serial?.attrs["port-name"]) {
        const name = serial.attrs["port-name"];
        port = name.startsWith("/") || /^COM[0-9]+$/.test(name) ? name : `/dev/${name}`;
    } else if (tcp?.attrs["ip-address"]) {
        port = `socket://${tcp.attrs["ip-address"]}:${tcp.attrs["port"] ?? "23"}`;
    }
    const head = kids(child(machine, "heads"), "head")[0];
    const actuators = new Map<string, string>();
    for (const node of [...kids(child(machine, "actuators"), "actuator"), ...kids(child(head, "actuators"), "actuator")]) {
        actuators.set(node.attrs["name"] ?? "", node.attrs["id"] ?? "");
    }
    const nozzles: Nozzle[] = kids(child(head, "nozzles"), "nozzle").map((node) => ({
        id: node.attrs["id"] ?? "",
        name: node.attrs["name"] ?? node.attrs["id"] ?? "",
        offset: placeOf(child(node, "head-offsets")) ?? { x: 0, y: 0, z: 0, rotation: 0 },
        axes: { x: node.attrs["axis-X-id"], y: node.attrs["axis-Y-id"], z: node.attrs["axis-Z-id"], rotation: node.attrs["axis-rotation-id"] },
        vacuum: child(node, "vacuum-actuator-name")?.text.trim() || null,
        sense: child(node, "vacuum-sense-actuator-name")?.text.trim() || null,
        tips: kids(child(node, "compatible-nozzle-tip-ids"), "string").map((each) => each.text.trim()),
        pickDwell: number(node.attrs["pick-dwell-milliseconds"]),
        placeDwell: number(node.attrs["place-dwell-milliseconds"]),
    }));
    const tips = new Map<string, Tip>();
    for (const node of kids(child(machine, "nozzle-tips"), "nozzle-tip")) {
        const span = (low: string, high: string): [number, number] | null => {
            const a = valueOf(child(node, low));
            const b = valueOf(child(node, high));
            return a !== null && b !== null && (a !== 0 || b !== 0) ? [Math.min(a, b), Math.max(a, b)] : null;
        };
        tips.set(node.attrs["id"] ?? "", {
            id: node.attrs["id"] ?? "",
            name: node.attrs["name"] ?? "",
            pickDwell: number(node.attrs["pick-dwell-milliseconds"]),
            placeDwell: number(node.attrs["place-dwell-milliseconds"]),
            partOn: span("vacuum-level-part-on-low", "vacuum-level-part-on-high"),
            partOff: span("vacuum-level-part-off-low", "vacuum-level-part-off-high"),
        });
    }
    const cameras = [...kids(child(head, "cameras"), "camera"), ...kids(child(machine, "cameras"), "camera")].map(cameraOf);
    const firstNozzle = nozzles[0]?.offset ?? { x: 0, y: 0, z: 0, rotation: 0 };
    return {
        port,
        baud: serial?.attrs["baud"] ? number(serial.attrs["baud"]) : null,
        commands: commandsOf(driver),
        axes: axesOf(machine),
        nozzles,
        tips,
        cameras,
        actuators,
        park: placeOf(child(head, "park-location")),
        homeFiducial: (() => {
            const place = placeOf(child(head, "homing-fiducial-location"));
            return place && (place.x !== 0 || place.y !== 0) ? place : null;
        })(),
        discard: placeOf(child(machine, "discard-location")),
        feeders: kids(child(machine, "feeders"), "feeder").map((node) => feederOf(node, firstNozzle)),
        driverSkew: number(driver?.attrs["non-squareness-factor"]),
        ...busOf(machine, driver, head),
    };
}

// --- the machine file written ------------------------------------------------------------------

/** A G-code machine file's values, as the importer fills them and the writer writes them. */
export interface ProfileData {
    name: string;
    description: string;
    url: string;
    baud: number;
    init: string[];
    move: string;
    axes: [string, string, string, string];
    wait: string;
    pick: string[];
    place: string[];
    dwell: string;
    home: string;
    position: string;
    lightOn: string[];
    lightOff: string[];
    feedXy: number;
    feedZ: number;
    safeZ: number;
    /** One Z motor drives two nozzles: the first down below safe Z, the other above it. */
    seesaw: boolean;
    /** How far the head's Y travel leans toward +X, mm of X per mm of Y: OpenPnP's non-squareness, taken out by this backend's link. */
    skew: number;
    placeZ: number | null;
    pickDwell: number;
    placeDwell: number;
    park: [number, number] | null;
    discard: [number, number, number] | null;
    vacuumRead: string[];
    vacuumPattern: string;
    partOn: [number, number] | null;
    partOff: [number, number] | null;
    cameraPosition: [number, number] | null;
    cameraZ: number | null;
    topOffset: [number, number] | null;
    /** The top camera's picture's turn as mounted, degrees; null when not known. */
    topRoll: number | null;
    /** The bed's homing fiducial as the nozzle's place over it. */
    homeFiducial: [number, number] | null;
    feeders: ProfileFeeder[];
    /** The feeder bus's lines, and its slots' places. */
    bus: { send: string; reply: string } | null;
    slots: { address: number; at: [number, number, number]; rotation: number }[];
}

export interface ProfileFeeder {
    id: string;
    match: string;
    refs: string[];
    at: [number, number, number];
    pitch: [number, number];
    count: number;
    columns: number;
    rowPitch: [number, number];
    rotation: number;
    feed: string[];
    partId: string;
    /** On the bus: its id, its pick place from its slot's, and its advance per part. */
    busId?: string;
    offset?: [number, number, number];
    advance?: number;
    /** Its parts' body as the cameras see it, mm, and the height they are placed at, from OpenPnP's parts and packages. */
    size?: [number, number];
    placeZ?: number;
    /** A line said over the feeder: its part as OpenPnP keeps it. */
    note?: string;
}

/** What a file starts as before anything is kept: the shipped generic file's defaults. */
export function defaultProfile(name: string): ProfileData {
    return {
        name,
        description: "read from an OpenPnP machine.xml",
        url: "",
        baud: 115200,
        init: ["G21", "G90"],
        move: "G0",
        axes: ["X", "Y", "Z", "A"],
        wait: "M400",
        pick: ["M106"],
        place: ["M107"],
        dwell: "G4 P{ms}",
        home: "G28",
        position: "M114",
        lightOn: [],
        lightOff: [],
        feedXy: 6000,
        feedZ: 1200,
        safeZ: 0,
        seesaw: false,
        skew: 0,
        placeZ: null,
        pickDwell: 200,
        placeDwell: 150,
        park: null,
        discard: null,
        vacuumRead: [],
        vacuumPattern: "",
        partOn: null,
        partOff: null,
        cameraPosition: null,
        cameraZ: null,
        topOffset: null,
        topRoll: null,
        homeFiducial: null,
        feeders: [],
        bus: null,
        slots: [],
    };
}

function fixed(value: number): string {
    const text = value.toFixed(4).replace(/\.?0+$/, "");
    return text === "-0" ? "0" : text;
}

const quote = (text: string): string => JSON.stringify(text);
const list = (lines: string[]): string => `[${lines.map(quote).join(", ")}]`;
const pair = (point: readonly number[]): string => `[${point.map(fixed).join(", ")}]`;

/** A feeder id the file takes: lower case letters, digits, - and _. */
export function feederId(name: string, taken: Set<string>): string {
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "feeder";
    let id = /^[a-z0-9]/.test(base) ? base : `f${base}`;
    for (let n = 2; taken.has(id); n += 1) {
        id = `${base}-${n}`;
    }
    taken.add(id);
    return id;
}

/** The machine file's TOML text: every section, with a line on where its values came from. */
export function profileText(data: ProfileData): string {
    const lines: string[] = [
        "# Read from an OpenPnP machine.xml by the Machines page's import. Places are",
        "# the head's X and Y with the nozzle over a point. The machine's port is",
        "# named by url, or by words its USB names hold (match).",
        `name = ${quote(data.name)}`,
        `description = ${quote(data.description)}`,
        'controller = "gcode"',
        "",
        "[port]",
        `url = ${quote(data.url)}`,
        "match = []",
        `baud = ${data.baud}`,
        "wait_ms = 2000",
        "timeout = 60",
        "",
        "[gcode]",
        `init = ${list(data.init)}`,
        "end = []",
        `move = ${quote(data.move)}`,
        `x = ${quote(data.axes[0])}`,
        `y = ${quote(data.axes[1])}`,
        `z = ${quote(data.axes[2])}`,
        `rotation = ${quote(data.axes[3])}`,
        "rotation_cw = false",
        `wait = ${quote(data.wait)}`,
        `pick = ${list(data.pick)}`,
        `place = ${list(data.place)}`,
        `dwell = ${quote(data.dwell)}`,
        `home = ${quote(data.home)}`,
        `position = ${quote(data.position)}`,
        'stop = "M410"',
    ];
    if (data.lightOn.length > 0) {
        lines.push(`light_on = ${list(data.lightOn)}`);
    }
    if (data.lightOff.length > 0) {
        lines.push(`light_off = ${list(data.lightOff)}`);
    }
    lines.push(
        "",
        "[motion]",
        `feed_xy = ${fixed(data.feedXy)}`,
        `feed_z = ${fixed(data.feedZ)}`,
        `safe_z = ${fixed(data.safeZ)}`,
        ...(data.seesaw ? ["seesaw = true            # one Z motor, two nozzles: moves across come to safe_z from either side, Z jogs stop there"] : []),
        ...(data.skew !== 0 ? [`skew = ${Number(data.skew.toFixed(6))}           # OpenPnP's non-squareness: the head's Y travel leans this many mm toward +X a mm, taken out on every move`] : []),
        ...(data.placeZ === null
            ? ["# MEASURE: jog the tip down onto the board's top, and set this to that Z plus the parts' height.", `place_z = ${fixed(data.safeZ)}`]
            : [`place_z = ${fixed(data.placeZ)}`]),
        `pick_dwell_ms = ${Math.round(data.pickDwell)}`,
        `place_dwell_ms = ${Math.round(data.placeDwell)}`,
        "pick_tries = 3",
    );
    if (data.park) {
        lines.push(`park = ${pair(data.park)}`);
    }
    if (data.discard) {
        lines.push(`discard = ${pair(data.discard)}`);
    }
    if (data.vacuumRead.length > 0) {
        lines.push("", "[vacuum]", `read = ${list(data.vacuumRead)}`);
        if (data.vacuumPattern) {
            lines.push(`pattern = ${quote(data.vacuumPattern)}`);
        }
        if (data.partOn) {
            lines.push(`part_on = ${pair(data.partOn)}`);
        }
        if (data.partOff) {
            lines.push(`part_off = ${pair(data.partOff)}`);
        }
    }
    if (data.cameraPosition || data.cameraZ !== null) {
        lines.push("", "[up_camera]");
        if (data.cameraPosition) {
            lines.push(`position = ${pair(data.cameraPosition)}`);
        }
        if (data.cameraZ !== null) {
            lines.push(`z = ${fixed(data.cameraZ)}`);
        }
    }
    if (data.topOffset || data.homeFiducial || data.topRoll !== null) {
        lines.push("", "[top_camera]");
        if (data.topOffset) {
            lines.push(`offset = ${pair(data.topOffset)}`);
        }
        if (data.topRoll !== null) {
            lines.push(`roll = ${fixed(data.topRoll)}`);
        }
        if (data.homeFiducial) {
            lines.push(`home_fiducial = ${pair(data.homeFiducial)}`);
        }
    }
    if (data.bus) {
        lines.push(
            "",
            "# The feeders' bus: packets as hex through the controller, answered in its reply.",
            "[bus]",
            `send = ${quote(data.bus.send)}`,
            `reply = ${quote(data.bus.reply)}`,
        );
        for (const slot of data.slots) {
            lines.push("", "[[slot]]", `address = ${slot.address}`, `at = ${pair(slot.at)}`, `rotation = ${fixed(slot.rotation)}`);
        }
    }
    for (const feeder of data.feeders) {
        lines.push("", "[[feeder]]", ...(feeder.note ? [`# ${feeder.note}`] : []), `id = ${quote(feeder.id)}`);
        if (feeder.refs.length > 0) {
            lines.push(`refs = ${list(feeder.refs)}`);
        }
        if (feeder.match) {
            lines.push(`match = ${quote(feeder.match)}`);
        }
        if (feeder.size) {
            lines.push(`size = ${pair(feeder.size)}`);
        }
        if (feeder.placeZ !== undefined) {
            lines.push(`place_z = ${fixed(feeder.placeZ)}`);
        }
        if (feeder.busId) {
            // Its slot is found on the bus by its id when a run starts.
            lines.push(`bus_id = ${quote(feeder.busId)}`, `offset = ${pair(feeder.offset ?? [0, 0, 0])}`, `advance = ${fixed(feeder.advance ?? 4)}`);
            if (feeder.rotation !== 0) {
                lines.push(`rotation = ${fixed(feeder.rotation)}`);
            }
            continue;
        }
        lines.push(`at = ${pair(feeder.at)}`, `pitch = ${pair(feeder.pitch)}`, `count = ${feeder.count}`);
        if (feeder.columns > 0) {
            lines.push(`columns = ${feeder.columns}`, `row_pitch = ${pair(feeder.rowPitch)}`);
        }
        lines.push(`rotation = ${fixed(feeder.rotation)}`);
        if (feeder.feed.length > 0) {
            lines.push(`feed = ${list(feeder.feed)}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

// --- the items -------------------------------------------------------------------------------

export interface ImportItem {
    id: string;
    group: string;
    label: string;
    /** What it reads as, in words. */
    value: string;
    /** Kept unless the operator leaves it out. */
    keep: boolean;
    /** Kept whatever: the file cannot do without it. */
    needed?: boolean;
    note?: string;
    apply(data: ProfileData): void;
}

function commandOf(machine: OpenPnpMachine, type: string, mount: string | null = null): Command | undefined {
    return machine.commands.find((command) => command.type === type && (mount === null || command.mount === mount));
}

/** The items a machine.xml gives for one of its nozzles (the first by default), and what could not be read. */
export function machineItems(machine: OpenPnpMachine, nozzleName?: string): { items: ImportItem[]; warnings: string[] } {
    const items: ImportItem[] = [];
    const warnings: string[] = [];
    const nozzle = machine.nozzles.find((each) => each.name === nozzleName) ?? machine.nozzles[0];
    if (!nozzle) {
        warnings.push("no nozzle on the head: only the commands are read");
    }
    const offset = nozzle?.offset ?? { x: 0, y: 0, z: 0, rotation: 0 };
    const push = (item: ImportItem): void => {
        items.push(item);
    };
    if (machine.port) {
        push({ id: "port", group: "Connection", label: "Port", value: machine.port, keep: true, note: "the port OpenPnP opened; Linux may number it otherwise", apply: (data) => { data.url = machine.port!; } });
    }
    const connect = commandOf(machine, "CONNECT_COMMAND");
    if (connect) {
        const init = plain(connect.lines);
        push({ id: "init", group: "Commands", label: "Connect lines", value: init.join(" | "), keep: true, apply: (data) => { data.init = init; } });
    }
    const move = commandOf(machine, "MOVE_TO_COMMAND");
    const word = move ? plain(move.lines.map((line) => line.replace(/\{[A-Za-z]+:[^}]*\}/g, "")))[0]?.split(/\s+/)[0] : undefined;
    if (word) {
        push({ id: "move", group: "Commands", label: "Move word", value: word, keep: true, apply: (data) => { data.move = word; } });
    }
    const complete = commandOf(machine, "MOVE_TO_COMPLETE_COMMAND");
    if (complete && plain(complete.lines)[0]) {
        const wait = plain(complete.lines)[0]!;
        push({ id: "wait", group: "Commands", label: "Wait for the moves", value: wait, keep: true, apply: (data) => { data.wait = wait; } });
    }
    const home = commandOf(machine, "HOME_COMMAND");
    if (home && plain(home.lines).length > 0) {
        const homing = plain(home.lines).join(" ");
        if (plain(home.lines).length > 1) {
            warnings.push(`the home command is several lines; only "${plain(home.lines)[0]}" is kept`);
        }
        push({ id: "home", group: "Commands", label: "Home", value: homing, keep: true, apply: (data) => { data.home = plain(home.lines)[0]!; } });
    }
    const position = commandOf(machine, "GET_POSITION_COMMAND");
    if (position && plain(position.lines)[0]) {
        const asking = plain(position.lines)[0]!;
        push({ id: "position", group: "Commands", label: "Read the position", value: asking, keep: true, apply: (data) => { data.position = asking; } });
    }
    const delay = commandOf(machine, "DELAY_COMMAND");
    const dwellLine = delay?.lines.map((line) => bare(line.replace(/\{TimeMS:([^}]*)\}/, (_all, format: string) => format.replace(/%d/, "{ms}")))).find((line) => line.includes("{ms}"));
    if (dwellLine) {
        push({ id: "dwell", group: "Commands", label: "Dwell", value: dwellLine, keep: true, apply: (data) => { data.dwell = dwellLine; } });
    }
    if (nozzle) {
        // X taken out of square by a linear transform (OpenPnP 2's
        // non-squareness) is X plus factor-y times Y of the controller's
        // axes: its letter is its X input's, and the factor the file's
        // skew. OpenPnP 1's driver factor went the other way (X out was the
        // nozzle's X plus it times Y): its sign changes.
        const xAxis = nozzle.axes.x ? machine.axes.get(nozzle.axes.x) : undefined;
        const transform = xAxis?.kind === "ReferenceLinearTransformAxis" && xAxis.inputX !== null && Math.abs(xAxis.factorX - 1) < 1e-9 ? xAxis : undefined;
        const letterOf = (id: string | undefined): string | null => {
            const axis = id ? machine.axes.get(id) : undefined;
            if (axis === transform && transform?.inputX) {
                return machine.axes.get(transform.inputX)?.letter ?? null;
            }
            return axis?.letter ?? null;
        };
        const skew = transform && transform.inputY !== null ? transform.factorY : -machine.driverSkew;
        if (skew !== 0) {
            const shown = Number(skew.toFixed(6));
            push({
                id: "skew", group: "Motion", label: "Axes out of square", value: `skew ${shown} (${fixed(Math.abs(Math.atan(skew) * 180 / Math.PI))} degrees)`, keep: true,
                note: transform ? `${transform.name} is ${fixed(transform.factorY)} of Y added to X: OpenPnP's places hold it` : "OpenPnP 1's non-squareness factor, its sign changed",
                apply: (data) => { data.skew = skew; },
            });
        } else if (xAxis && xAxis.letter === null && !transform) {
            warnings.push(`${nozzle.name}'s X is ${xAxis.name}, an axis made of others that is not read: its places may hold a correction left out`);
        }
        const letters = [letterOf(nozzle.axes.x), letterOf(nozzle.axes.y), letterOf(nozzle.axes.z), letterOf(nozzle.axes.rotation)];
        if (letters.every((letter) => letter !== null)) {
            push({ id: "axes", group: "Commands", label: `${nozzle.name}'s axes`, value: letters.join(" "), keep: true, apply: (data) => { data.axes = letters as [string, string, string, string]; } });
        } else {
            warnings.push(`${nozzle.name}'s Z or turn is not a controller axis of its own (a seesaw's mapped axis): its letters are left as X Y Z A`);
        }
        const z = nozzle.axes.z ? machine.axes.get(nozzle.axes.z) : undefined;
        if (z) {
            const inZone = z.safeLow !== null && z.safeHigh !== null && z.home >= z.safeLow && z.home <= z.safeHigh;
            const safe = inZone || z.safeHigh === null ? z.home : z.safeHigh;
            push({
                id: "safe_z", group: "Motion", label: "Safe Z", value: fixed(safe), keep: true, needed: true,
                note: z.safeLow !== null ? `OpenPnP's safe zone ${fixed(z.safeLow)} to ${fixed(z.safeHigh ?? z.safeLow)}, home ${fixed(z.home)}` : `home ${fixed(z.home)}`,
                apply: (data) => { data.safeZ = safe; },
            });
            // Another nozzle's Z mapped from this one's: one motor, a seesaw.
            const other = [...machine.axes.values()].find((axis) => axis.type === "Z" && axis.input === z.id);
            if (other) {
                push({
                    id: "seesaw", group: "Motion", label: "Seesaw Z", value: `${nozzle.name} and ${other.name} on ${z.name}`, keep: true,
                    note: `${other.name}'s Z follows ${z.name}: above safe Z the other nozzle goes down`,
                    apply: (data) => { data.seesaw = true; },
                });
            }
            if (z.feed) {
                const feedZ = z.feed;
                push({ id: "feed_z", group: "Motion", label: "Feed Z, OpenPnP's most", value: `${fixed(feedZ)} mm/min`, keep: false, apply: (data) => { data.feedZ = feedZ; } });
            }
        }
        const xy = [nozzle.axes.x, nozzle.axes.y].map((id) => (id ? machine.axes.get(id)?.feed ?? null : null)).filter((value): value is number => value !== null);
        if (xy.length > 0) {
            const feedXy = Math.min(...xy);
            push({ id: "feed_xy", group: "Motion", label: "Feed XY, OpenPnP's most", value: `${fixed(feedXy)} mm/min`, keep: false, apply: (data) => { data.feedXy = feedXy; } });
        }
        const vacuumId = nozzle.vacuum ? machine.actuators.get(nozzle.vacuum) : undefined;
        const switching = vacuumId ? commandOf(machine, "ACTUATE_BOOLEAN_COMMAND", vacuumId) : undefined;
        if (switching) {
            const on = branch(switching.lines, true);
            const off = branch(switching.lines, false);
            push({ id: "vacuum", group: "Vacuum", label: `${nozzle.vacuum} on and off`, value: `${on.join(" | ")}  /  ${off.join(" | ")}`, keep: true, apply: (data) => { data.pick = on; data.place = off; } });
        }
        const senseId = nozzle.sense ? machine.actuators.get(nozzle.sense) : undefined;
        const read = senseId ? commandOf(machine, "ACTUATOR_READ_COMMAND", senseId) : undefined;
        const regex = senseId ? commandOf(machine, "ACTUATOR_READ_REGEX", senseId) : undefined;
        if (read && regex) {
            const lines = plain(read.lines);
            const reading = pattern(regex.lines.join(""));
            push({ id: "sensor", group: "Vacuum", label: `${nozzle.sense} read`, value: `${lines.join(" | ")}  /  ${reading}`, keep: true, apply: (data) => { data.vacuumRead = lines; data.vacuumPattern = reading; } });
            const tip = nozzle.tips.map((id) => machine.tips.get(id)).find((each) => each?.partOn);
            if (tip?.partOn) {
                push({
                    id: "levels", group: "Vacuum", label: `${tip.name}'s vacuum levels`,
                    value: `held ${tip.partOn.join(" to ")}${tip.partOff ? `, empty ${tip.partOff.join(" to ")}` : ""}`, keep: false,
                    note: "checked after every pick and place once kept; read your own with Read vacuum first",
                    apply: (data) => { data.partOn = tip.partOn; data.partOff = tip.partOff; },
                });
            }
        }
        const tip = nozzle.tips.map((id) => machine.tips.get(id)).find((each) => each !== undefined);
        const pickDwell = (tip?.pickDwell ?? 0) + nozzle.pickDwell;
        const placeDwell = (tip?.placeDwell ?? 0) + nozzle.placeDwell;
        push({ id: "dwells", group: "Vacuum", label: `Dwells${tip ? ` (${tip.name})` : ""}`, value: `pick ${pickDwell} ms, place ${placeDwell} ms`, keep: true, apply: (data) => { data.pickDwell = pickDwell; data.placeDwell = placeDwell; } });
    }
    const down = machine.cameras.find((camera) => camera.looking === "Down");
    const up = machine.cameras.find((camera) => camera.looking === "Up");
    const light = machine.cameras.map((camera) => camera.light).find((id) => id !== null);
    const lights = light ? commandOf(machine, "ACTUATE_BOOLEAN_COMMAND", light) : undefined;
    if (lights) {
        const on = branch(lights.lines, true);
        const off = branch(lights.lines, false);
        push({ id: "lights", group: "Cameras", label: "The cameras' light", value: `${on.join(" | ")}  /  ${off.join(" | ")}`, keep: true, apply: (data) => { data.lightOn = on; data.lightOff = off; } });
    }
    if (up && nozzle) {
        const position: [number, number] = [up.place.x - offset.x, up.place.y - offset.y];
        const z = up.place.z - offset.z;
        push({
            id: "up_camera", group: "Cameras", label: `${up.name} (the bottom camera)`, value: `X ${fixed(position[0])} Y ${fixed(position[1])}, sharp at Z ${fixed(z)}`, keep: true,
            note: "a first guess: Center nozzle measures it",
            apply: (data) => { data.cameraPosition = position; data.cameraZ = z; },
        });
    }
    if (down && nozzle) {
        const camera: [number, number] = [down.place.x - offset.x, down.place.y - offset.y];
        const roll = downCameraRoll(down);
        const turned = roll === null
            ? `, its picture turned ${fixed(down.rotation)} degrees${down.flipX ? ", flipped in X" : ""}${down.flipY ? ", flipped in Y" : ""} (not taken)`
            : roll !== 0 ? `, upside down as mounted (roll ${fixed(roll)})` : "";
        push({
            id: "top_camera", group: "Cameras", label: `${down.name} (the top camera)`, value: `X ${fixed(camera[0])} Y ${fixed(camera[1])} from ${nozzle.name}${turned}`, keep: true,
            note: roll === null ? "Measure offset measures the picture's turn" : undefined,
            apply: (data) => { data.topOffset = camera; data.topRoll = roll; },
        });
    }
    if (machine.homeFiducial && nozzle) {
        // OpenPnP keeps it where the top camera looks; kept as the nozzle's place over it.
        const fiducial: [number, number] = [machine.homeFiducial.x - offset.x, machine.homeFiducial.y - offset.y];
        push({
            id: "home_fiducial", group: "Cameras", label: "Homing fiducial", value: `X ${fixed(fiducial[0])} Y ${fixed(fiducial[1])}`, keep: true,
            note: "Home by fiducial looks for it with the top camera",
            apply: (data) => { data.homeFiducial = fiducial; },
        });
    }
    if (machine.park) {
        const park: [number, number] = [machine.park.x - (down?.place.x ?? 0), machine.park.y - (down?.place.y ?? 0)];
        push({ id: "park", group: "Places", label: "Park", value: `X ${fixed(park[0])} Y ${fixed(park[1])}`, keep: true, apply: (data) => { data.park = park; } });
    }
    if (machine.discard && nozzle) {
        const discard: [number, number, number] = [machine.discard.x - offset.x, machine.discard.y - offset.y, machine.discard.z - offset.z];
        push({ id: "discard", group: "Places", label: "Discard", value: `X ${fixed(discard[0])} Y ${fixed(discard[1])} Z ${fixed(discard[2])}`, keep: false, note: "left out, a failed part goes back in its pocket", apply: (data) => { data.discard = discard; } });
    }
    const photons = machine.feeders.filter((feeder) => feeder.busId !== null && !feeder.unplaced);
    const busSend = machine.busSend ?? "M485 {packet}";
    const busReply = machine.busReply ?? "rs485-reply: *(?<Value>.*)";
    const slots = machine.slots.map((slot) => ({
        address: slot.address,
        at: [slot.place.x - offset.x, slot.place.y - offset.y, slot.place.z - offset.z] as [number, number, number],
        rotation: slot.place.rotation,
    }));
    const giveBus = (data: ProfileData): void => {
        data.bus = { send: busSend, reply: busReply };
        data.slots = slots;
    };
    if (photons.length > 0 || machine.busSend !== null) {
        push({
            id: "bus", group: "Feeders", label: "Photon feeder bus",
            value: `${busSend}  /  ${busReply}${slots.length > 0 ? `, ${slots.length} slots placed` : ", no slot placed in the file"}`,
            keep: true,
            note: "the slots' places as OpenPnP keeps them; a feeder's slot is found by its id when a run starts",
            apply: giveBus,
        });
    }
    const ids = new Set<string>();
    for (const feeder of machine.feeders) {
        if (feeder.unplaced) {
            warnings.push(`feeder ${feeder.name} (${feeder.partId || "no part"}) is left out: ${feeder.unplaced}`);
            continue;
        }
        // The feeders' places were read for the first nozzle: move them to this one's.
        const shift = { x: (machine.nozzles[0]?.offset.x ?? 0) - offset.x, y: (machine.nozzles[0]?.offset.y ?? 0) - offset.y, z: (machine.nozzles[0]?.offset.z ?? 0) - offset.z };
        const id = feederId(feeder.name, ids);
        if (feeder.busId !== null) {
            const busId = feeder.busId;
            const busOffset = feeder.busOffset ?? { x: 0, y: 0, z: 0, rotation: 0 };
            const match = feeder.partId.replace(/[-_]+/g, " ").trim();
            push({
                id: `feeder:${id}`, group: "Feeders", label: `${feeder.name} (Photon)`,
                value: `${feeder.partId || "no part"}, id ${busId}, ${fixed(feeder.advance)} mm a part, its slot found when a run starts`,
                keep: feeder.enabled,
                note: "its parts are matched by the words of its part id unless a job tells them",
                apply: (data) => {
                    if (!data.bus) {
                        giveBus(data);
                    }
                    data.feeders.push({
                        id, match: match || id, refs: [], at: [0, 0, 0], pitch: [0, 0], count: 0, columns: 0, rowPitch: [0, 0],
                        rotation: busOffset.rotation, feed: [], partId: feeder.partId,
                        busId, offset: [busOffset.x, busOffset.y, busOffset.z], advance: feeder.advance,
                    });
                },
            });
            continue;
        }
        const at: [number, number, number] = [feeder.at.x + shift.x, feeder.at.y + shift.y, feeder.at.z + shift.z];
        const match = feeder.partId.replace(/[-_]+/g, " ").trim();
        const feedId = feeder.actuator ? machine.actuators.get(feeder.actuator) : undefined;
        const feedCommand = feedId ? commandOf(machine, "ACTUATE_BOOLEAN_COMMAND", feedId) : undefined;
        const actuated = feedCommand ? branch(feedCommand.lines, true) : [];
        push({
            id: `feeder:${id}`, group: "Feeders", label: `${feeder.name} (${feeder.kind.replace(/^Reference/, "")})`,
            value: `${feeder.partId || "no part"} at X ${fixed(at[0])} Y ${fixed(at[1])} Z ${fixed(at[2])}${feeder.count > 0 ? `, ${feeder.count} parts` : ""}`,
            keep: feeder.enabled,
            note: [feeder.note, feeder.taken > 0 && feeder.kind !== "ReferenceStripFeeder" ? `OpenPnP had fed ${feeder.taken}` : null, "its parts are matched by the words of its part id unless a job tells them"].filter((word) => word).join("; "),
            apply: (data) => {
                data.feeders.push({ id, match: match || id, refs: [], at, pitch: feeder.pitch, count: feeder.count, columns: feeder.columns, rowPitch: feeder.rowPitch, rotation: feeder.rotation, feed: actuated, partId: feeder.partId });
            },
        });
    }
    return { items, warnings };
}

// --- a job ------------------------------------------------------------------------------------

export interface JobPlacement {
    ref: string;
    partId: string;
    /** Where it lies on the machine as OpenPnP has it: the point, not the head. */
    at: [number, number];
    rotation: number;
    enabled: boolean;
    fiducial: boolean;
}

/**
 * The placements of an OpenPnP job on the machine: each board location's
 * place and turn applied to its board's placements. `boards` are the board
 * files by their names; a board on the bottom side is passed over with a
 * warning. The board's Z is the height parts go down to.
 */
export function readJob(jobText: string, boards: Map<string, string>): { placements: JobPlacement[]; boardZ: number | null; warnings: string[] } {
    const root = parseXml(jobText);
    if (root.name !== "openpnp-job") {
        throw new Error(`not an OpenPnP job: its root is <${root.name}>`);
    }
    const warnings: string[] = [];
    const placements: JobPlacement[] = [];
    let boardZ: number | null = null;
    for (const location of kids(child(root, "board-locations"), "board-location")) {
        const file = location.attrs["board-file"] ?? location.attrs["file-name"] ?? "";
        const name = file.split(/[\\/]/).pop() ?? file;
        const text = boards.get(name);
        if (!text) {
            warnings.push(`the board ${name || "(unnamed)"} was not given: its placements are left out`);
            continue;
        }
        if ((location.attrs["side"] ?? "Top") !== "Top") {
            warnings.push(`the board ${name} lies bottom side up: left out`);
            continue;
        }
        const place = placeOf(child(location, "location")) ?? { x: 0, y: 0, z: 0, rotation: 0 };
        boardZ ??= place.z;
        const board = parseXml(text);
        const radians = (place.rotation * Math.PI) / 180;
        for (const node of kids(child(board, "placements"), "placement")) {
            const at = placeOf(child(node, "location")) ?? { x: 0, y: 0, z: 0, rotation: 0 };
            placements.push({
                ref: node.attrs["id"] ?? "",
                partId: node.attrs["part-id"] ?? "",
                at: [place.x + at.x * Math.cos(radians) - at.y * Math.sin(radians), place.y + at.x * Math.sin(radians) + at.y * Math.cos(radians)],
                rotation: at.rotation + place.rotation,
                enabled: node.attrs["enabled"] !== "false",
                fiducial: node.attrs["type"] === "Fiducial",
            });
        }
    }
    return { placements, boardZ, warnings };
}

/**
 * The items a job gives against the board job picked: a reference for each
 * placement whose reference the board has (the nozzle's place over it),
 * the feeders' parts by reference, and the board's height as the place Z.
 */
export function jobItems(
    job: { placements: JobPlacement[]; boardZ: number | null },
    parts: Component[],
    nozzleOffset: { x: number; y: number; z: number },
    feeders: OpenPnpFeeder[],
): { items: ImportItem[]; references: { ref: string; at: [number, number] }[] } {
    const known = new Set(parts.map((part) => part.ref));
    const matched = job.placements.filter((placement) => known.has(placement.ref));
    const references = matched.map((placement) => ({ ref: placement.ref, at: [placement.at[0] - nozzleOffset.x, placement.at[1] - nozzleOffset.y] as [number, number] }));
    const items: ImportItem[] = [];
    if (references.length > 0) {
        items.push({
            id: "references", group: "Job", label: "References", value: `${references.length} of ${job.placements.length} placements match the board job's parts`, keep: true,
            note: "where OpenPnP's job puts each part: they map the board on the machine",
            apply: () => undefined,
        });
    }
    if (job.boardZ !== null) {
        const z = job.boardZ - nozzleOffset.z;
        items.push({ id: "place_z", group: "Job", label: "Place Z from the board's height", value: fixed(z), keep: true, note: "the board's top: parts go down to it", apply: (data) => { data.placeZ = z; } });
    }
    const byPart = new Map<string, string[]>();
    for (const placement of job.placements) {
        if (placement.enabled && !placement.fiducial && placement.partId) {
            byPart.set(placement.partId, [...(byPart.get(placement.partId) ?? []), placement.ref]);
        }
    }
    const told = feeders.filter((feeder) => byPart.has(feeder.partId)).length;
    if (told > 0) {
        items.push({
            id: "feeder_refs", group: "Job", label: "Feeders' parts by reference", value: `${told} feeders told which placements they hold`, keep: true,
            apply: (data) => {
                for (const entry of data.feeders) {
                    const refs = byPart.get(entry.partId);
                    if (refs) {
                        entry.refs = refs;
                    }
                }
            },
        });
    }
    return { items, references };
}

// --- parts and packages ---------------------------------------------------------------------

/** A part as OpenPnP's parts.xml keeps it, its package's body from packages.xml. */
export interface OpenPnpPart {
    id: string;
    /** Its height over the board, mm. */
    height: number;
    packageId: string;
    /** The package's body along X and Y as packages.xml draws it, mm; null where it gives none. */
    body: [number, number] | null;
}

/**
 * OpenPnP's parts by their ids, from parts.xml (`<openpnp-parts>`, a
 * `<part>` each: id, height and its units, package-id) with each part's
 * package body from packages.xml (`<openpnp-packages>`, a `<package>` each
 * with a `<footprint>` of body-width along X and body-height along Y) when
 * that file is given.
 */
export function readParts(partsText: string, packagesText: string | null): { parts: Map<string, OpenPnpPart>; warnings: string[] } {
    const root = parseXml(partsText);
    if (root.name !== "openpnp-parts") {
        throw new Error(`not OpenPnP's parts.xml: its root is <${root.name}>`);
    }
    const bodies = new Map<string, [number, number]>();
    if (packagesText !== null) {
        const packages = parseXml(packagesText);
        if (packages.name !== "openpnp-packages") {
            throw new Error(`not OpenPnP's packages.xml: its root is <${packages.name}>`);
        }
        for (const node of kids(packages, "package")) {
            const footprint = child(node, "footprint");
            const scale = unitScale(footprint?.attrs["units"]);
            const width = number(footprint?.attrs["body-width"]) * scale;
            const height = number(footprint?.attrs["body-height"]) * scale;
            if (width > 0 && height > 0) {
                bodies.set(node.attrs["id"] ?? "", [width, height]);
            }
        }
    }
    const parts = new Map<string, OpenPnpPart>();
    const warnings: string[] = [];
    for (const node of kids(root, "part")) {
        const id = node.attrs["id"] ?? "";
        if (id === "") {
            continue;
        }
        const packageId = node.attrs["package-id"] ?? "";
        const body = bodies.get(packageId) ?? null;
        if (packagesText !== null && body === null) {
            warnings.push(`part ${id}: its package ${packageId || "(none)"} has no body size in packages.xml`);
        }
        parts.set(id, { id, height: number(node.attrs["height"]) * unitScale(node.attrs["height-units"]), packageId, body });
    }
    return { parts, warnings };
}

/**
 * The item OpenPnP's parts give against the feeders read: each feeder's
 * parts their package's body as their size, and their height over the
 * board added to the place Z the job's board gives, as their place height.
 */
export function partItems(parts: Map<string, OpenPnpPart>, feeders: OpenPnpFeeder[]): ImportItem[] {
    const held = feeders.filter((feeder) => parts.has(feeder.partId));
    if (held.length === 0) {
        return [];
    }
    const sized = held.filter((feeder) => parts.get(feeder.partId)?.body).length;
    const tall = held.filter((feeder) => (parts.get(feeder.partId)?.height ?? 0) > 0).length;
    return [{
        id: "parts", group: "Parts", label: "The feeders' parts",
        value: `${held.length} feeders' parts: ${sized} with a body size, ${tall} with a height`,
        keep: true,
        note: "a body is the size the bottom camera checks; a height is added to the board's place Z, from the job",
        apply: (data) => {
            for (const entry of data.feeders) {
                const part = parts.get(entry.partId);
                if (!part) {
                    continue;
                }
                const body = part.body ? `, body ${fixed(part.body[0])} x ${fixed(part.body[1])} mm` : "";
                entry.note = `OpenPnP's part ${part.id}: package ${part.packageId || "none"}, ${fixed(part.height)} mm tall${body}`;
                if (part.body) {
                    entry.size = [part.body[0], part.body[1]];
                }
                // The board's top, as the job gives it, plus the part.
                if (data.placeZ !== null && part.height > 0) {
                    entry.placeZ = data.placeZ + part.height;
                }
            }
        },
    }];
}

/** The machine file of the items kept, over the defaults. */
export function buildProfile(name: string, items: ImportItem[], kept: Set<string>): string {
    const data = defaultProfile(name);
    // The feeders first, so the job's items can tell them their parts, and
    // the parts' last, so they see the board's height the job gave.
    const rank = (item: ImportItem): number => (item.group === "Parts" ? 2 : item.group === "Job" ? 1 : 0);
    const order = [...items].sort((a, b) => rank(a) - rank(b));
    for (const item of order) {
        if (item.needed || kept.has(item.id)) {
            item.apply(data);
        }
    }
    return profileText(data);
}
