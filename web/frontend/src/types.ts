// Shapes of the backend's JSON, one type per route body or response.

export interface Port {
    url: string;
    description: string;
}

export interface PortsResponse {
    ports: Port[];
}

export interface Firmware {
    version: string;
    lines: number;
    blocks: number;
}

export type MachineState = "Idle" | "Run" | "Jog" | "Hold" | "Alarm";

export type Mode = "dyn" | "const";

/** Joint position: radius in mm, table angle in degrees. */
export interface Joint {
    r: number;
    a: number;
}

/** Board position in mm with the rotation axis at the origin. */
export interface Board {
    x: number;
    y: number;
}

export interface Queue {
    planner: number;
    lines: number;
}

export interface Machine {
    state: MachineState;
    alarm: number | null;
    joint: Joint;
    board: Board;
    /** Surface speed of the move in progress, mm/min. */
    rate: number;
    /** Laser duty in permille, as driven. */
    laser: number;
    mode: Mode;
    enabled: boolean;
    queue: Queue;
}

export interface Snapshot {
    connected: boolean;
    url: string | null;
    firmware: Firmware | null;
    machine: Machine | null;
    run: Progress | null;
}

export type JogRequest =
    | { kind: "joint"; dr?: number; da?: number; feed?: number | null }
    | { kind: "board"; dx?: number; dy?: number; feed?: number | null };

export type GotoRequest =
    | { kind: "joint"; r?: number; a?: number; feed?: number | null }
    | { kind: "board"; x?: number; y?: number; feed?: number | null };

export interface PositionRequest {
    r?: number;
    a?: number;
}

export type RealtimeAction = "hold" | "resume" | "reset" | "cancel" | "status";

export interface CommandResponse {
    lines: string[];
}

export interface LaserRequest {
    power: number;
    ms: number;
}

export interface SettingSchema {
    name: string;
    unit: string;
    help: string;
}

export interface HostSettings {
    tolerance: number;
}

export interface SettingsResponse {
    values: Record<string, number>;
    schema: SettingSchema[];
    host: HostSettings;
}

export interface SettingsUpdate {
    values?: Record<string, number>;
    host?: HostSettings;
}

export type Point = [number, number];

export type Path = Point[];

export interface Group {
    label: string;
    power: number;
    speed: number;
    enabled: boolean;
    paths: Path[];
}

export interface Stats {
    length_mm: number;
    seconds: number;
    max_radius: number;
    min_radius: number;
    /** Share of the cut length held back by the table's rate limit. */
    limited_fraction: number;
    moves: number;
}

export type Anchor = "center" | "keep";

export interface Job {
    id: string;
    name: string;
    source: string;
    spot: number;
    offset: Board;
    groups: Group[];
    outline: Path[];
    copper: Path[];
    stats: Stats;
}

/** A group as the job list shows it: the path count stands in for the paths. */
export interface GroupSummary {
    label: string;
    power: number;
    speed: number;
    enabled: boolean;
    paths: number;
}

/** The list entry: the job without its coordinates. */
export interface JobSummary {
    id: string;
    name: string;
    source: string;
    spot: number;
    offset: Board;
    groups: GroupSummary[];
    stats: Stats;
}

export interface JobsResponse {
    jobs: JobSummary[];
}

export interface GroupPatch {
    index: number;
    power?: number;
    speed?: number;
    enabled?: boolean;
}

export interface JobPatch {
    groups?: GroupPatch[];
    offset?: Board;
}

export interface UploadOptions {
    power?: number;
    speed?: number;
    spot?: number;
    anchor?: Anchor;
    offset_x?: number;
    offset_y?: number;
}

export type RunState = "running" | "hold" | "done" | "stopped" | "error";

export interface Progress {
    job: string;
    state: RunState;
    sent: number;
    acked: number;
    total: number;
    seconds: number;
    estimate: number;
    /** Index of the group being streamed; null before the first line. */
    group: number | null;
    /** Why the state is error. */
    error?: string | null;
}

export type ConsoleDir = "rx" | "tx";

export interface ConsoleLine {
    dir: ConsoleDir;
    text: string;
    /** The link's own status poll, or its report: heartbeat, not traffic. */
    poll?: boolean;
}

export type MessageLevel = "info" | "error";

export interface Message {
    level: MessageLevel;
    text: string;
}

export type WsEvent =
    | { type: "state"; data: Snapshot }
    | { type: "console"; data: ConsoleLine }
    | { type: "progress"; data: Progress }
    | { type: "message"; data: Message };
