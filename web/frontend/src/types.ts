// Shapes of the backend's JSON, one type per route body or response.

export interface Port {
    url: string;
    description: string;
    /** The device node behind a stable by-id url; the url itself for a port without one. */
    device?: string;
    product?: string;
    manufacturer?: string;
    serial?: string;
    vid?: number | null;
    pid?: number | null;
    /** `usb` for a device with a vendor id, `system` for a built-in port (never the controller), `last` for the url last used. */
    kind?: "usb" | "system" | "last";
    /** The device announces itself as the spinny controller. */
    spinny?: boolean;
}

export interface PortsResponse {
    ports: Port[];
}

export interface Firmware {
    version: string;
    lines: number;
    blocks: number;
}

export type MachineState = "Idle" | "Run" | "Jog" | "Hold" | "Home" | "Alarm";

export type Mode = "dyn" | "const";

/** Joint position: radius in mm, table angle in degrees. */
export interface Joint {
    r: number;
    a: number;
}

/** What the machine reports: the joint pair, the cross slide and the focus axis. */
export interface JointPosition extends Joint {
    /** Cross slide in mm: the setup axis that carries the rail across the rotation axis. */
    z: number;
    /** Focus axis in mm, up positive; null on a machine without one. */
    h?: number | null;
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
    /** Laser duty in permille, as driven on the pin: an active-low output (laser_invert) reads 1000 dark. */
    laser: number;
    mode: Mode;
    enabled: boolean;
    queue: Queue;
    /** The touch probe is down; null on a machine without a focus axis. */
    probe?: boolean | null;
    /** The letters of the joints homed since the position was last lost (R, A, H, Z); null on a machine with no endstop. */
    homed?: string | null;
    /** How old the report is, s: a machine that has gone quiet shows here before the link gives it up. */
    age?: number;
}

/** How the head moves over the board: the rail and the table, or the rail and the cross slide. */
export type Kinematics = "polar" | "cartesian";

/** What the output drives, or what takes the table's driver: a paste dispenser's plunger. */
export type Tool = "laser" | "spindle" | "dispenser";

/** What the machine is, from its settings as last read. */
export interface Profile {
    kinematics: Kinematics;
    tool: Tool;
    /** A focus axis is fitted: the depth axis of a spindle. */
    h_axis: boolean;
    r_max: number;
    z_max: number;
}

export interface Snapshot {
    connected: boolean;
    url: string | null;
    firmware: Firmware | null;
    machine: Machine | null;
    /** Missing from a backend that predates it: a polar laser. */
    profile?: Profile;
    run: Progress | null;
    /** How far the last run got and the plan it was made from, kept across sessions; null when none ran. */
    resume?: ResumeRecord | null;
    /** The last position the machine reported, kept across sessions: where a controller that counts from zero again was. */
    position?: LastPosition | null;
}

/** The machine's last reported joints, with its state and when. */
export interface LastPosition {
    r: number;
    a: number;
    z: number;
    h: number | null;
    state: string;
    at: string;
}

/** The last run's progress with what a later session needs to pick the job up where it stopped. */
export interface ResumeRecord extends Progress {
    /** Where the plan began: the joint the head was at, [r, a] or [r, z] on a cartesian machine. */
    start?: [number, number] | null;
    compensate?: Compensate;
    cartesian?: boolean;
    angle?: number;
    spindle?: boolean;
    started?: string;
    updated?: string;
    /** The machine's last reported position. */
    position?: { r: number; a: number; z: number; h: number | null } | null;
    /** A note left by whoever wrote the record by hand. */
    note?: string;
}

export interface ResumeRequest {
    /** The count of lines done, as the progress reports it. */
    line: number;
    /** Start over at the first line of the path that line belongs to, so a count a line off cannot leave a gap. */
    rewind?: boolean;
    /** Left out, the way the run being picked up followed the board. */
    compensate?: Compensate | null;
}

/** What picking a job up would do, without moving anything. */
export interface ResumePlan {
    job: string;
    line: number;
    /** The line the run starts at: `line`, or the start of its path. */
    skip: number;
    total: number;
    compensate: Compensate;
    /** The plan was made from where the recorded run began, so its lines are the ones counted. */
    planned_from_record: boolean;
    /** The job's line the run starts with; null past the end. */
    next: string | null;
    group: number | null;
    /** The lines that bring the head from rest to where `next` begins. */
    approach: string[];
}

// On the polar machine the cross slide is a setup axis: it moves alone, so
// `dz` and `z` are their own shape and the never members keep them off a
// request that carries the radius or the angle. On a cartesian machine it
// is a joint beside the radius and the focus axis, which the third shape is.
export type JogRequest =
    | { kind: "joint"; dr?: number; da?: number; dh?: number; dz?: never; feed?: number | null }
    | { kind: "joint"; dz: number; dr?: never; da?: never; dh?: never; feed?: number | null }
    | { kind: "joint"; dr?: number; dz?: number; dh?: number; da?: never; feed?: number | null }
    | { kind: "board"; dx?: number; dy?: number; feed?: number | null };

export type GotoRequest =
    | { kind: "joint"; r?: number; a?: number; h?: number; z?: never; feed?: number | null }
    | { kind: "joint"; z: number; r?: never; a?: never; h?: never; feed?: number | null }
    | { kind: "joint"; r?: number; z?: number; h?: number; a?: never; feed?: number | null }
    | { kind: "board"; x?: number; y?: number; feed?: number | null };

export interface PositionRequest {
    r?: number;
    a?: number;
    z?: number;
    h?: number;
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
    /** Milling: travel height over the surface, mm. */
    clearance?: number;
    /** Milling: dwell after the spindle starts, s. */
    spinup?: number;
    /** Milling: the host sets the spindle's speed from the groups; off, the spindle runs full on whenever it runs. */
    speed_control?: boolean;
    /** Dispensing: the needle's height over the pad while a dot is laid, mm, (0, 10]. */
    gap?: number;
    /** Dispensing: how far the plunger is pulled back after each dot, mm, [0, 50]. */
    retract?: number;
    /** Dispensing: mm^3 of paste per mm of plunger travel, (0, 100000]. */
    output?: number;
    /** Dispensing: plunger speed while a dot is pushed out, mm/min, (0, 10000]. */
    extrude_rate?: number;
    /** Dispensing: wait after the push, before the retract, whole ms, [0, 60000]. */
    dwell_ms?: number;
}

export interface LogResponse {
    lines: string[];
}

/** The backend's log files: its own, or every line over the wire. */
export type LogFile = "spinny" | "wire";

export interface SettingsResponse {
    values: Record<string, number>;
    schema: SettingSchema[];
    host: HostSettings;
    /** The machine file these settings are, every one of them; null for settings of no file's. */
    machine?: string | null;
    /**
     * The file the controls are drawn from: that one, or for settings of no
     * file's the file last loaded from this host or the one file for this
     * kind of machine; null for the defaults. Missing from an older backend.
     */
    controls_from?: string | null;
    /** The page's controls: the file's, or the defaults for what the settings say the machine is. Missing from a backend that predates it. */
    controls?: Controls;
}

/** The firmware's joint letters: the radius, the table angle, the cross slide and the focus axis. */
export type JointAxis = "r" | "a" | "z" | "h";

/** One joint's control in the jog panel and the readout, as the machine file lays it out. */
export interface AxisControl {
    axis: JointAxis;
    /** In the readout and in "Set R=0 here". */
    letter: string;
    label: string;
    /** The step choices (degrees for the table, mm otherwise); null: the pad's step. */
    steps: number[] | null;
    /** The step picked at the start; null with the pad's steps. */
    step: number | null;
    /** The minus and the plus button. */
    buttons: [string, string];
    /** The feed field applies; false: the firmware's own jog rate for the axis. */
    feed: boolean;
    /** A field in the joint goto row. */
    goto: boolean;
    /** A "Set R=0 here" button, which asks with the hint. */
    zero: boolean;
    zero_hint: string;
    /** Two key names for minus and plus, or none. */
    keys: string[];
    /** Under the bar's title. */
    note: string;
}

/** What the jog panel and the readout draw, from the machine file or the defaults for the profile. */
export interface Controls {
    /** Board X and Y bars, on the arrow keys. */
    pad: boolean;
    /** mm; an axis without steps of its own uses the pad's. */
    pad_steps: number[];
    pad_step: number;
    /** A feed field for the pad and the axes that take it. */
    feed: boolean;
    /** Where Center sends the joints; null: no button. */
    center: Partial<Record<JointAxis, number>> | null;
    axes: AxisControl[];
}

/** A machine file in machines/, as the backend lists it: the axes, their scales and limits, the kinematics and the tool. */
export interface MachineSummary {
    id: string;
    name: string;
    description: string;
    kinematics: Kinematics;
    tool: Tool;
    /** The file fits a focus axis. */
    focus: boolean;
}

export interface MachinesResponse {
    machines: MachineSummary[];
    /** The file the connected machine's settings are; null with no machine connected, or settings of no file's. */
    current: string | null;
    /** Files that could not be read, each with what is wrong; they can still be opened to be mended. */
    problems: MachineProblem[];
}

export interface MachineProblem {
    id: string;
    problem: string;
}

/** A machine file read: its summary, every firmware setting, the host's values, the camera and the page's controls. */
export interface MachineDocument extends MachineSummary {
    settings: Record<string, number>;
    host: Partial<HostSettings>;
    /** The file's [camera], filled in from the defaults. */
    camera: CameraSettings;
    controls: Controls;
}

/** A machine file as the backend sends it: what it reads as, or why it does not, and the text as written. */
export interface MachineResponse {
    document: MachineDocument | null;
    problems: string[];
    text: string;
}

/** A text checked as a machine file, without being written. */
export interface MachineCheck {
    document: MachineDocument | null;
    problems: string[];
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
    /** Times the group runs, all of its paths each time; 1 is once. Milled, each pass a step deeper. */
    passes: number;
    enabled: boolean;
    /** Milling: how deep under the surface the last pass cuts, mm. */
    depth?: number;
    /** Milling: how fast the tool goes down into the cut, mm/min. */
    plunge?: number;
    /** What a CAM profile or a dispense import made the group for; a run refuses a group made for another tool than the machine has. Missing or null runs on a laser or a spindle. */
    tool?: Tool | null;
    /** Dispensing: mm of paste over every pad of the group. */
    thickness?: number;
    /** Dispensing: each dot's pad area in mm^2, in the order of `paths`; empty or missing on a group of cuts. */
    areas?: number[];
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

/** How a board import clears the copper the isolation leaves: spokes from the axis, rings about it, or rows along X. */
export type ClearPattern = "radial" | "rings" | "lines";

/** What a board import makes: cuts around the copper, taking it away; the copper itself, for a process that lays it down; or a paste dot on every pad. */
export type BoardMode = "isolate" | "deposit" | "dispense";

/** How a deposit fills the copper inside its edge loops: loops on in to the middle, or one of the clearing fills. */
export type DepositFill = "contour" | ClearPattern;

export interface Job {
    id: string;
    name: string;
    source: string;
    /** The board layer a kicad or gerber job was cut from (F.Cu, or F.Paste for a stencil); missing or null otherwise. */
    layer?: string | null;
    spot: number;
    offset: Board;
    /** Degrees the job has been turned counterclockwise about the origin by alignment; missing from a backend that predates it. */
    rotation?: number;
    /** The centroid and area (mm^2) of every pad of the layer, in the job's frame; empty for a drawing or a gcode file. */
    pads?: PadPoint[];
    /** The drill file's holes with their diameters, in the job's frame. */
    holes?: HolePoint[];
    /** How the design's gerber frame maps to the job's: job = turn(rotation) * gerber + shift; null for a job without one. */
    design?: DesignMap | null;
    groups: Group[];
    outline: Path[];
    copper: Path[];
    stats: Stats;
}

/** A pad: its centroid and its area in mm^2. */
export type PadPoint = [number, number, number];

/** A hole: its center and its diameter. */
export type HolePoint = [number, number, number];

/** The map from the design's gerber frame (the KiCad file's X, its Y negated) to the job's frame. */
export interface DesignMap {
    shift: [number, number];
    rotation: number;
    /** The `.kicad_pcb` is kept beside the job, so the camera can look for it. */
    board: boolean;
}

/** A group as the job list shows it: the path count stands in for the paths. */
export interface GroupSummary {
    label: string;
    power: number;
    min_power: number;
    speed: number;
    passes: number;
    enabled: boolean;
    depth?: number;
    plunge?: number;
    thickness?: number;
    tool?: Tool | null;
    paths: number;
    joints?: number;
}

/** The list entry: the job without its coordinates. */
export interface JobSummary {
    id: string;
    name: string;
    source: string;
    layer?: string | null;
    spot: number;
    offset: Board;
    rotation?: number;
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
    passes?: number;
    enabled?: boolean;
    depth?: number;
    plunge?: number;
    /** Dispensing: mm of paste over a pad, 0.01 to 5. */
    thickness?: number;
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
    /** The layer a KiCad board is read from, a KiCad layer name; left out, F.Cu. F.Paste with a deposit is a stencil. */
    layer?: string;
    /** Gerber and KiCad boards only; left out, the board is isolated. */
    mode?: BoardMode;
    /** A dispense only: mm of paste over every pad, 0.01 to 5; left out, 0.12. */
    thickness?: number;
    /** Isolation only; left out, no copper is cleared. */
    clear?: ClearPattern;
    /** A deposit only; left out, the loops go on in to the middle. */
    fill?: DepositFill;
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
    /** The line the run picked the job up at; null or missing for a run from the top. */
    resumed_from?: number | null;
}

/** How a run follows the height map: not at all, the focus axis where fitted, else power, or one of the two. */
export type Compensate = "off" | "auto" | "focus" | "power";

/** Probe points `nx` by `ny` over a board rectangle, corners included. */
export interface Grid {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    nx: number;
    ny: number;
    /** mask[iy][ix]: which points are probed; missing or null probes them all. */
    mask?: boolean[][] | null;
}

/** What to probe: the grid, or only the points a job's cuts come near, or the rest of a map probed in part. */
export interface ProbeRequest extends Grid {
    /** Probe only the points within `margin` mm (plus half the spot) of this job's cuts. */
    job?: string | null;
    margin?: number | null;
    /** Go on with the stored map where it has no height yet. */
    resume?: boolean;
}

/** About how long probing would take, and the grid it would probe, mask included. */
export interface ProbeEstimate {
    seconds: number;
    points: number;
    grid: Grid;
}

/** What one probe under the head is for: tie the map to the focus axis frame in use, or make the contact height H 0. */
export type TouchMode = "map" | "zero";

/** Where the probe goes down: under the head as it stands, or at the probed point of the map nearest the tip that the job's cuts leave clear, which the head goes to first. */
export type TouchAt = "here" | "nearest";

export interface TouchRequest {
    mode: TouchMode;
    at?: TouchAt;
    /** The job whose cuts a nearest touch keeps clear of; left out, the last run's. */
    job?: string;
}

/** What a touch would do, without moving anything. */
export interface TouchPlan {
    /** The board point the probe goes down at. */
    point: [number, number];
    /** The map point picked, (ix, iy); null for a touch under the head. */
    index: [number, number] | null;
    /** How far the tip is from the point, mm. */
    distance: number;
    /** The lines that take the head there. */
    lines: string[];
}

export interface HeightMap {
    grid: Grid;
    /** heights[iy][ix]: the focus axis at contact, mm; null until probed. */
    heights: (number | null)[][];
    /** Focus height minus contact height, mm. */
    focus_offset: number;
    /** Someone has said what the focus offset is; a run needs it. */
    focus_set: boolean;
    /** The offset was set at some point in some frame, so a probe at one point can tie the map to a new one. */
    focus_known?: boolean;
    /** The offset's part that does not move with the frame: focus (or touch-off) over the probe's contact, mm; null until known. */
    focus_gap?: number | null;
    /** The probe tip from the beam when probed: along the rail, across it, mm, signed as ProbeSettings.offset. */
    probe_offset: [number, number];
    created: string;
    /** A pad map: the pads probed, board mm; null or missing on a grid map. */
    points?: [number, number][] | null;
    /** A pad map: each point's height in the order of `points`, null until probed. */
    point_heights?: (number | null)[] | null;
}

export type ProbeState = "running" | "done" | "stopped" | "error";

export interface ProbeProgress {
    state: ProbeState;
    done: number;
    total: number;
    /** The point being probed, [ix, iy]; null on a pad map. */
    point: [number, number] | null;
    /** A pad map: the index of the point being probed. */
    pad?: number | null;
    seconds: number;
    error: string | null;
    /** About how long the whole of it was to take, s; null when nobody guessed. */
    estimate?: number | null;
    /** Seconds left, at the pace so far once a few points are done. */
    remaining?: number | null;
}

/** The host's probing parameters. */
export interface ProbeSettings {
    /** The most the probe goes down from the travel height, mm. */
    depth: number;
    /** First touch, mm/min. */
    feed: number;
    /** Second, slower touch; 0 for one touch. */
    slow: number;
    /** Rise before the second touch, mm. */
    backoff: number;
    /**
     * The probe tip from the beam, mm: along the rail, positive outward, and
     * across it, positive to the left of outward seen from above (board +Y
     * at table angle 0, +Z on a cartesian machine).
     */
    offset: [number, number];
    /** The beam's Rayleigh length for power compensation, mm. */
    rayleigh: number;
}

export interface HeightMapState {
    map: HeightMap | null;
    probe: ProbeProgress | null;
    settings: ProbeSettings;
}

/** Probe the board at a job's pads rather than a grid, for a probe that must land on copper. */
export interface PadProbeRequest {
    job: string;
    /** Pads under this area in mm^2 are left out; 0.05 to 1000, default 0.5. */
    min_area?: number;
    /** Over this many pads, the most spread out of them are probed; 2 to 2500, default 100. */
    max_points?: number;
    /** Go on with the pad map in the store where it has no height yet. */
    resume?: boolean;
}

/** What probing the pads would do, without touching the machine. */
export interface PadProbePlan {
    /** The points that would be probed, in their order. */
    points: [number, number][];
    /** How many pads the job has. */
    pads: number;
    /** How many were under the area asked for. */
    skipped: number;
    seconds: number;
    /** How many points a resume would skip. */
    resume: number;
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
    | { type: "heightmap"; data: HeightMapState }
    | { type: "message"; data: Message }
    | { type: "camera"; data: CameraState }
    | { type: "align"; data: AlignState };

// --- Camera ---------------------------------------------------------------------

export type CameraSide = "front" | "back";

/** Whether solder mask hides the copper the camera looks for. */
export type CameraFinish = "masked" | "bare";

/** The camera on the head: what it is read with, and how it sits against the tool. */
export interface CameraSettings {
    /** A V4L2 device, socket://host:port of a pcbv serve elsewhere, or a picture or a directory to replay. */
    device: string;
    /** Capture size, WIDTHxHEIGHT. */
    size: string;
    fps: number;
    /** The pcbv program: a name on PATH or a path. */
    pcbv: string;
    side: CameraSide;
    finish: CameraFinish;
    /** The picture's center from the tool, board mm along X and Y; the camera offset routine measures it. */
    offset: [number, number];
    /** Degrees from the picture's x axis to board +X, counterclockwise seen from above. */
    roll: number;
    /** mm per picture pixel at the board; 0 until measured, or taken from a lock. */
    mm_per_px: number;
}

export interface CameraFrame {
    width: number;
    height: number;
    age_ms: number;
    fps: number;
}

/** What pcbv makes of the board: locked on it, coasting on the last lock, lost, or none loaded. */
export type PoseState = "locked" | "coasting" | "lost" | "none";

/** The newest pose; the measured fields only on `locked`. Poses are in the KiCad file's board frame (mm, x right, y down). */
export interface CameraPose {
    /** Null with the camera stopped. */
    state: PoseState | null;
    center?: [number, number] | null;
    angle_deg?: number | null;
    mm_per_px?: number | null;
    inliers?: number | null;
    expected?: number | null;
    rms_mm?: number | null;
    spots?: number | null;
    fps?: number | null;
    age_ms?: number | null;
    /** The picture's center in the loaded job's frame; null without a lock or a board. */
    job_center?: [number, number] | null;
}

export type RoutineState = "running" | "done" | "stopped" | "error";

/** Where the camera offset routine is: lifting, moving over the mark, measuring the scale, centering on it, or done. */
export type RoutineStep = "lifting" | "moving" | "scale" | "centering" | "done";

/** The last spot the routine found: its distance from the picture's center in pixels and in mm. */
export interface RoutineSpot {
    dx: number;
    dy: number;
    mm: number;
}

export interface CameraRoutine {
    state: RoutineState;
    step: RoutineStep;
    done: number;
    total: number;
    error: string | null;
    spot: RoutineSpot | null;
}

/** The camera state: the settings, whether it runs, the board it looks for, the mark, the newest picture and pose, and the find routine. */
export interface CameraState extends CameraSettings {
    running: boolean;
    /** The job whose board pcbv looks for, or null. */
    board: string | null;
    /** The recorded mark's board point, or null. */
    mark: [number, number] | null;
    /** Null with the camera stopped, and until its first picture. */
    frame: CameraFrame | null;
    /** Null with the camera stopped. */
    pose: CameraPose | null;
    /** The find routine's progress; null before any. */
    routine: CameraRoutine | null;
}

/** Make a mark with the tool where it stands (a spindle machine), or only record the tool's point as the mark. */
export interface MarkRequest {
    depth?: number;
    plunge?: number;
    here?: boolean;
}

// --- Alignment ------------------------------------------------------------------

export type MarkSource = "tool" | "camera";

/** What a mark's design point was taken from: a pad or a hole of the job, a point typed in, or the picture's center. */
export type MarkKind = "pad" | "hole" | "point" | "center";

/** A design point of the job paired with the board point the machine found it at. */
export interface AlignMark {
    design: [number, number];
    machine: [number, number];
    source: MarkSource;
    kind: MarkKind;
    /** How far the tool was from the pad or hole picked; 0 for a point given. */
    distance: number;
    /** The board's turn a camera mark saw, degrees; null for a tool mark. */
    angle: number | null;
    /** The mark's distance from where the last fit puts it; null before a fit. */
    residual: number | null;
}

/** The turn and shift the marks fit; the scale is reported, never applied. */
export interface AlignFit {
    /** Degrees counterclockwise about the origin, applied before the shift. */
    rotation: number;
    shift: [number, number];
    scale: number;
    rms: number;
    residuals: number[];
    marks: number;
}

export interface AlignState {
    /** The job the marks are for, or null. */
    job: string | null;
    marks: AlignMark[];
    fit: AlignFit | null;
}

/** A mark from the tool's point now, paired with a design point given or the nearest pad or hole within reach. */
export interface AlignMarkRequest {
    job: string;
    design?: [number, number] | null;
    nearest?: "pad" | "hole" | null;
    /** How far the nearest pad or hole may be, mm; 0.1 to 100, default 5. */
    within?: number;
}

// --- CAM profiles -----------------------------------------------------------

export type CamAxisKind = "linear" | "rotary";

/** What the CAM uses an axis for: the board plane, the depth, a polar pair, or a setup axis parked before the cuts. */
export type CamAxisRole = "x" | "y" | "depth" | "radius" | "angle" | "setup";

export interface CamAxis {
    letter: string;
    kind: CamAxisKind;
    role: CamAxisRole;
    min: number | null;
    max: number | null;
    /** The fastest feed, units per minute. */
    rate: number | null;
    rapid: number | null;
    /** Machine coordinate of board 0. */
    offset: number;
    home: number | null;
    /** Depth axis: travel height over the surface. */
    safe: number | null;
    /** Setup axis: where it is put first. */
    park: number | null;
}

export interface CamTool {
    id: string;
    kind: Tool;
    name: string;
    /** The width of the cut: a bit's diameter or a beam's spot, mm. */
    width: number;
    /** The cutting settings the file gives the tool, by key. */
    settings: Record<string, number>;
}

export type CamSource = "isolation" | "clearing" | "outline" | "drills" | "deposit" | "paths";

export type CamSettingValue = number | string | boolean;

export interface CamOperation {
    name: string;
    source: CamSource;
    tool: string;
    enabled: boolean;
    /** Every key the operation gives itself. */
    settings: Record<string, CamSettingValue>;
    /** What it cuts with: the tool's settings under its own, and the pass count. */
    cutting: Record<string, number>;
}

export interface CamPost {
    header: string[];
    footer: string[];
    spindle_on: string;
    laser_on: string;
    spinup: number;
    decimals: number;
    return_home: boolean;
}

export type CamAnchor = "center" | "corner" | "keep";

export interface CamPlacement {
    anchor: CamAnchor;
    offset: [number, number];
    layer: string;
    mirror: "none" | "x" | "y";
}

/** A profile as the list shows it. */
export interface CamSummary {
    id: string;
    name: string;
    description: string;
    /** The machines/ file whose firmware runs the profile's jobs; null for one that only takes the gcode. */
    machine: string | null;
    kinematics: Kinematics;
    /** The kinds of tool the enabled operations use. */
    tools: Tool[];
    /** The axis letters. */
    axes: string;
    /** Enabled operations. */
    operations: number;
}

export interface CamProfile {
    id: string;
    name: string;
    description: string;
    machine: string | null;
    kinematics: Kinematics;
    axes: CamAxis[];
    tools: CamTool[];
    operations: CamOperation[];
    post: CamPost;
    placement: CamPlacement;
}

export interface CamProfilesResponse {
    profiles: CamSummary[];
    /** Files that could not be read, one message each. */
    problems: string[];
}

export interface CamProfileResponse {
    document: CamProfile;
    /** The file as written. */
    text: string;
}

/** The table and the key of one value in a profile file: ["operations", 2, "depth"]. */
export type CamPath = (string | number)[];

/** A value to write; null takes the key out. */
export type CamValue = number | string | boolean | string[] | null;

export interface CamJobResponse {
    job: Job;
    /** What was left out or changed on the way. */
    notes: string[];
}

export interface CamGcodeReport {
    lines: number;
    cuts: number;
    length_mm: number;
    seconds: number;
    /** Machine coordinates reached, by axis letter. */
    extents: Record<string, [number, number]>;
    warnings: string[];
}

export interface CamGcodeResponse {
    text: string;
    report: CamGcodeReport;
    filename: string;
}
