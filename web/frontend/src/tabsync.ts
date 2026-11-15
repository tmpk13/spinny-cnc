// The page's browser tabs, known to each other. Each tab says which side
// it shows (or both, side by side), its pages, whether it is in view and
// when it last had the focus, on a BroadcastChannel only pages of this
// origin hear; a tab opening asks the others to say theirs. A link to the
// other side then goes to a tab already showing that side, by name and
// target (`go`), which answers once it has gone there (`went`), so two
// tabs or two windows side by side work as one page: the Use side in
// one, the Setup side in the other. The machine's state needs none of
// this; every tab has it from the backend's events.
//
// Pages that reach another backend (`?api=`), or the mock, keep to a
// channel of their own.

import type { Side } from "./sides.ts";

/** What a tab says of itself. */
export interface PeerInfo {
    id: string;
    /** The side in front. */
    side: Side;
    /** Both sides show, side by side. */
    split: boolean;
    /** The page each side shows. */
    pages: Record<Side, string>;
    /** The tab is in view (its window not hidden, the tab in front in it). */
    visible: boolean;
    /** When it last had the focus, ms since the epoch; 0 for never. */
    focused: number;
    /** When this tab last heard from it, ms since the epoch. */
    seen: number;
}

export type SyncMessage =
    | { kind: "hello"; from: string; info: Omit<PeerInfo, "id" | "seen">; reply: boolean }
    | { kind: "bye"; from: string }
    | { kind: "go"; from: string; to: string; target: string; nonce: number }
    | { kind: "went"; from: string; to: string; nonce: number };

/** The part of a BroadcastChannel the sync uses, so a test can stand one in. */
export interface ChannelLike {
    postMessage(message: unknown): void;
    onmessage: ((event: { data: unknown }) => void) | null;
    close(): void;
}

/** How long a tab asked to go somewhere has to answer before the link goes here instead, ms. */
export const GO_WAIT_MS = 400;

/** The channel's name: one per backend, the mock's apart. */
export function channelName(apiBase: string, mock: boolean): string {
    return `spinny-page ${mock ? "mock" : "live"} ${apiBase}`;
}

/** Whether a peer shows a side now. */
export function shows(peer: PeerInfo, side: Side): boolean {
    return peer.split || peer.side === side;
}

/**
 * The tab to send a target of `side` to: one that shows that side, a tab
 * in view before one behind others, then the one focused last; null for
 * none.
 */
export function peerFor(peers: Iterable<PeerInfo>, side: Side): PeerInfo | null {
    let best: PeerInfo | null = null;
    for (const peer of peers) {
        if (!shows(peer, side)) {
            continue;
        }
        if (best === null || (peer.visible && !best.visible) || (peer.visible === best.visible && peer.focused > best.focused)) {
            best = peer;
        }
    }
    return best;
}

function isMessage(value: unknown): value is SyncMessage {
    if (!value || typeof value !== "object") {
        return false;
    }
    const kind = (value as { kind?: unknown }).kind;
    const from = (value as { from?: unknown }).from;
    return typeof from === "string" && (kind === "hello" || kind === "bye" || kind === "go" || kind === "went");
}

export class TabSync {
    readonly id: string;
    readonly peers = new Map<string, PeerInfo>();
    private nonce = 0;
    private readonly waiting = new Map<number, (went: boolean) => void>();
    private readonly listeners = new Set<() => void>();

    /**
     * `info` says what this tab shows now; `onGo` takes it to a target
     * another tab sent, and says whether it found it.
     */
    constructor(
        private readonly channel: ChannelLike | null,
        private readonly info: () => Omit<PeerInfo, "id" | "seen">,
        private readonly onGo: (target: string) => boolean,
        private readonly now: () => number = () => Date.now(),
        id?: string,
    ) {
        this.id = id ?? Math.random().toString(36).slice(2, 10);
        if (channel) {
            channel.onmessage = (event) => this.hear(event.data);
        }
    }

    /** Says what this tab shows; `reply` marks an answer to another's hello, which is not answered again. */
    announce(reply = false): void {
        this.post({ kind: "hello", from: this.id, info: this.info(), reply });
    }

    /** Says this tab is going away, so no link waits on it. */
    leave(): void {
        this.post({ kind: "bye", from: this.id });
    }

    /** Hears each change in the tabs known. */
    onPeers(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The tab to send a target of `side` to, or null. */
    peerFor(side: Side): PeerInfo | null {
        return peerFor(this.peers.values(), side);
    }

    /**
     * Asks a tab to go to a target; true once it says it went there, false
     * when it does not answer in time (closed without a word, or hung), in
     * which case it is forgotten.
     */
    send(peer: string, target: string, wait = GO_WAIT_MS): Promise<boolean> {
        if (!this.channel) {
            return Promise.resolve(false);
        }
        const nonce = ++this.nonce;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.waiting.delete(nonce);
                this.forget(peer);
                resolve(false);
            }, wait);
            this.waiting.set(nonce, (went) => {
                clearTimeout(timer);
                resolve(went);
            });
            this.post({ kind: "go", from: this.id, to: peer, target, nonce });
        });
    }

    /** One message from another tab. */
    hear(data: unknown): void {
        if (!isMessage(data) || data.from === this.id) {
            return;
        }
        switch (data.kind) {
            case "hello":
                this.peers.set(data.from, { ...data.info, id: data.from, seen: this.now() });
                this.changed();
                if (!data.reply) {
                    this.announce(true);
                }
                break;
            case "bye":
                this.forget(data.from);
                break;
            case "go":
                if (data.to === this.id && this.onGo(data.target)) {
                    this.post({ kind: "went", from: this.id, to: data.from, nonce: data.nonce });
                }
                break;
            case "went":
                if (data.to === this.id) {
                    this.waiting.get(data.nonce)?.(true);
                    this.waiting.delete(data.nonce);
                }
                break;
        }
    }

    close(): void {
        this.leave();
        this.channel?.close();
    }

    private forget(peer: string): void {
        if (this.peers.delete(peer)) {
            this.changed();
        }
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    private post(message: SyncMessage): void {
        try {
            this.channel?.postMessage(message);
        } catch {
            // A closed channel: this tab is going away.
        }
    }
}
