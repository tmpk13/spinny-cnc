// Packets of a feeder bus, as the backend's feederbus.py makes and reads
// them: a header of named bytes (to, from, id, length, crc) and a payload,
// carried as hex; the check is CRC-8 with the polynomial 0x07 over every
// other header byte and the payload. The mock answers the bus's packets
// with it, and its run sends them.

export const HEADER_FIELDS = ["to", "from", "id", "length", "crc"];
export const ID_BYTES = 12;

/** CRC-8, polynomial 0x07, starting at 0: Photon's packet check. */
export function crc8(data: number[]): number {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte & 0xff;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

export interface BusPacket {
    to: number;
    sender: number;
    number: number;
    payload: number[];
}

/** A packet as the hex its send line carries, upper case. */
export function encodePacket(packet: BusPacket, header: string[] = HEADER_FIELDS): string {
    const values: Record<string, number> = { to: packet.to, from: packet.sender, id: packet.number, length: packet.payload.length };
    const checked = [...header.filter((name) => name !== "crc").map((name) => values[name]! & 0xff), ...packet.payload];
    values["crc"] = crc8(checked);
    return [...header.map((name) => values[name]! & 0xff), ...packet.payload].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** A packet from its hex, or null for one that does not read: odd hex, too short, a wrong length or check. */
export function decodePacket(text: string, header: string[] = HEADER_FIELDS): BusPacket | null {
    const hex = text.trim();
    if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) {
        return null;
    }
    const data: number[] = [];
    for (let at = 0; at < hex.length; at += 2) {
        data.push(parseInt(hex.slice(at, at + 2), 16));
    }
    if (data.length < header.length) {
        return null;
    }
    const values: Record<string, number> = {};
    header.forEach((name, index) => {
        values[name] = data[index]!;
    });
    const payload = data.slice(header.length);
    if ("length" in values && values["length"] !== payload.length) {
        return null;
    }
    if ("crc" in values) {
        const checked = [...header.filter((name) => name !== "crc").map((name) => values[name]!), ...payload];
        if (crc8(checked) !== values["crc"]) {
            return null;
        }
    }
    return { to: values["to"] ?? 0, sender: values["from"] ?? 0, number: values["id"] ?? 0, payload };
}

/** A feeder's id as bytes, from its 24 hex digits. */
export function idBytes(id: string): number[] {
    const bytes: number[] = [];
    for (let at = 0; at < id.length; at += 2) {
        bytes.push(parseInt(id.slice(at, at + 2), 16));
    }
    return bytes;
}

/** A feeder's pick place from its slot's: the offset turned by the slot's rotation and added. */
export function slotPlace(at: [number, number, number], rotation: number, offset: [number, number, number]): [number, number, number] {
    const radians = rotation * (Math.PI / 180);
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return [at[0] + offset[0] * c - offset[1] * s, at[1] + offset[0] * s + offset[1] * c, at[2] + offset[2]];
}
