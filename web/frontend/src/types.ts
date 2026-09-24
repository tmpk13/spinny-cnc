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

/** What the machine reports: the joint pair and the cross slide. */
export interface JointPosition extends Joint {
    /** Cross slide in mm: the setup axis that carries the rail across the rotation axis. */
    z: number;
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
    joint: JointPosition;
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

// The cross slide is a setup axis: it moves alone, so `dz` and `z` are their
// own shape and the never members keep them off a request that carries the
// radius or the angle.
export type JogRequest =
    | { kind: "joint"; dr?: number; da?: number; dz?: never; feed?: number | null }
    | { kind: "joint"; dz: number; dr?: never; da?: never; feed?: number | null }
    | { kind: "board"; dx?: number; dy?: number; feed?: number | null };

export type GotoRequest =
    | { kind: "joint"; r?: number; a?: number; z?: never; feed?: number | null }
    | { kind: "joint"; z: number; r?: never; a?: never; feed?: number | null }
    | { kind: "board"; x?: number; y?: number; feed?: number | null };

export interface PositionRequest {
    r?: number;
    a?: number;
    z?: number;
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
    /** The least power in the firmware's dynamic mode; above `power` it counts as `power`, 0 is none. */
    min_power: number;
    speed: number;
    enabled: boolean;
    paths: Path[];
    /**
     * Joint-space polylines, radius mm and angle degrees, streamed as they
     * are; a negative radius is the far side of the axis. When present,
     * `paths` is only what is drawn.
     */
    joints?: [number, number][][];
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
    min_power: number;
    speed: number;
    enabled: boolean;
    paths: number;
    joints?: number;
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
    label?: string;
    power?: number;
    min_power?: number;
    speed?: number;
    enabled?: boolean;
}

export interface JobPatch {
    name?: string;
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

/** The options of the centering test burn; a missing reach or ring takes the pattern's default. */
export interface CenterRequest {
    fine?: boolean;
    lines?: number;
    reach?: number;
    ring?: number;
    angle?: number;
    cross?: number;
    arm?: number;
    spiral?: number;
    /** Fine only: draw the preview as burnt with the radius zero E mm out and the rail Z mm off the axis. */
    show_error?: [number, number];
    spot?: number;
    power?: number;
    speed?: number;
}

/** The stored centering job, what the pattern reads as, and how to read it. */
export interface CenterResponse {
    job: Job;
    summary: string[];
    notes: string[];
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
