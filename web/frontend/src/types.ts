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
    /**
     * `usb` for a device with a vendor id, `system` for a built-in port
     * (never the controller), `last` for the url last used, `machine` for a
     * G-code machine whose file names a url no port is listed under.
     */
    kind?: "usb" | "system" | "last" | "machine";
    /** The device announces itself as the spinny controller. */
    spinny?: boolean;
    /** The G-code machine file that claims the port, which Connect opens it as; null or missing for this project's firmware. */
    machine?: string | null;
    machine_name?: string | null;
}

export interface PortsResponse {
    ports: Port[];
}

export interface Firmware {
    version: string;
    lines: number;
    blocks: number;
    /** What a G-code machine's firmware says it is (its answer to M115), or the machine's name. */
    name?: string;
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

/** A saved position on the board: its name and where it is, board mm. */
export interface Marker {
    name: string;
    x: number;
    y: number;
}

export interface MarkersResponse {
    markers: Marker[];
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

/** What the output drives, or what takes the table's driver: a paste dispenser's plunger; or a G-code machine's vacuum nozzle. */
export type Tool = "laser" | "spindle" | "dispenser" | "nozzle";

/** Who drives the machine: this project's firmware, or a controller of the machine's own taking G-code. */
export type Controller = "spinny" | "gcode";

/** What the machine is, from its settings as last read, or a G-code machine's file. */
export interface Profile {
    kinematics: Kinematics;
    tool: Tool;
    /** A focus axis is fitted: the depth axis of a spindle; a G-code machine's Z. */
    h_axis: boolean;
    r_max: number;
    z_max: number;
    /** Missing from a backend that predates G-code machines: this project's firmware. */
    controller?: Controller;
    /** A G-code machine's file: its id and its name. */
    machine?: string | null;
    name?: string;
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
    /**
     * Since when the position is held: the board was connected again, or
     * started over, and its reports are not taken until it shows it kept
     * its count or the position is declared. Missing while they are taken.
     */
    held?: string;
}

/** The last run's progress with what a later session needs to pick the job up where it stopped. */
export interface ResumeRecord extends Progress {
    /** Where the plan began: the joint the head was at, [r, a] or [r, z] on a cartesian machine. */
    start?: [number, number] | null;
    /** How the run followed the height map, an auto settled. */
    compensate?: MapMode;
    /** The height a laser group's own focus counted from; null when no group had one. */
    start_h?: number | null;
    /** The focus axis frame `start_h` was read in: a pickup counts from it only in the same frame. */
    frame?: string | null;
    /** A print of the plan's lines: a pickup whose plan prints otherwise counts other lines, and is refused. */
    fingerprint?: string | null;
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
    /**
     * The operator's word that the head is at focus where it stands: a laser
     * group's own focus counts from here, not from where the run picked up
     * began, which the focus axis may no longer count the same.
     */
    focus_here?: boolean;
    /**
     * The operator's word that `line` is counted in the job as it is now,
     * though the job changed since the run being picked up stopped.
     */
    changed?: boolean;
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

export interface SettingSchema {
    name: string;
    unit: string;
    help: string;
}

export interface HostSettings {
    tolerance: number;
    /** Milling: travel height over the surface, mm. */
    clearance?: number;
    /** The H the page's moves, probing and the camera routines rise to before going across, mm; null leaves the head at the height it has. */
    travel?: number | null;
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
    /** The settings written since the controller's were last saved to flash or read from it (a connect knows of none); missing from an older backend. */
    unsaved?: string[];
    /**
     * The file the controls are drawn from: that one, or for settings of no
     * file's the file last loaded from this host or the one file for this
     * kind of machine; null for the defaults. Missing from an older backend.
     */
    controls_from?: string | null;
    /** The page's controls: the file's, or the defaults for what the settings say the machine is. Missing from a backend that predates it. */
    controls?: Controls;
    /** `gcode` for a G-code machine, which has none of the firmware's settings. */
    controller?: Controller;
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
    /** The Centering test panel, which finds where the rail crosses a polar machine's rotation axis. */
    centering: boolean;
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
    /** This project's firmware, or a G-code controller of the machine's own; missing from an older backend: spinny. */
    controller?: Controller;
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
    /** A G-code machine's own tables, read. */
    gcode?: GcodeDocument;
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

/** A text with the connected board's values read into it, not saved. */
export interface MachineFromBoard extends MachineCheck {
    text: string;
    /** One line per key written: `[rail] max_rate = 900 (was 560)`. */
    changes: string[];
    /** Settings the text still does not give the board's value for. */
    left: string[];
}

export interface SettingsUpdate {
    values?: Record<string, number>;
    /** The host values to change; one left out keeps its value, and a null travel turns it off. */
    host?: Partial<HostSettings>;
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
    /** The CAM profile's tool the group was made with: the gcode stops to change the bit between two, a run refuses more than one. Missing or null cuts with whatever is fitted. */
    tool_id?: string | null;
    /** That tool's name, for the stop's comment and the refusal. */
    tool_name?: string | null;
    /** A CAM laser group's height over the surface, mm, where the gcode holds a depth axis for focus; missing or null leaves it at the safe height. A run does not read it. */
    height?: number | null;
    /** Dispensing: mm of paste over every pad of the group. */
    thickness?: number;
    /** A laser with a focus axis: mm the head is raised above focus for the group, negative lowers it; missing or null leaves it where the run puts it. */
    focus?: number | null;
    /** Dispensing: each dot's pad area in mm^2, in the order of `paths`; empty or missing on a group of cuts. */
    areas?: number[];
    paths: Path[];
    /**
     * Joint-space polylines, radius mm and angle degrees, streamed as they
     * are; a negative radius is the far side of the axis. When present,
     * `paths` is only what is drawn.
     */
    joints?: [number, number][][];
    /**
     * A 3D model's toolpaths from a CAM profile: every path's moves. The
     * first move of a path is where the tool comes down to from the travel
     * height; `paths` is then empty, and `depth` is the deepest it goes.
     */
    moves?: Move[][];
}

/** How the tool gets to a model's move: 0 a rapid, 1 a feed at the group's speed, 2 a plunge at its plunge rate. */
export type MoveKind = 0 | 1 | 2;

/** x, y and z over the stock's top in mm, and how the tool gets there. */
export type Move = [number, number, number, MoveKind];

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

/** What a board import makes: cuts around the copper, taking it away; the copper itself, for a process that lays it down; a cut round the inside of every paste opening, for a stencil; or a paste dot on every pad. */
export type BoardMode = "isolate" | "deposit" | "stencil" | "dispense" | "lines";

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
    /** Degrees the job has been turned counterclockwise since import, by Turn and by alignment; missing from a backend that predates it. */
    rotation?: number;
    /** The centroid and area (mm^2) of every pad of the layer, in the job's frame; empty for a drawing or a gcode file. */
    pads?: PadPoint[];
    /** The drill file's holes with their diameters, in the job's frame. */
    holes?: HolePoint[];
    /** How the design's gerber frame maps to the job's: job = turn(rotation) * gerber + shift; null for a job without one. */
    design?: DesignMap | null;
    /** How the job was made, for making it again for another width; null when its paths do not follow the width, or nothing is kept. */
    recipe?: Recipe | null;
    groups: Group[];
    outline: Path[];
    copper: Path[];
    stats: Stats;
}

/** How a job was made: a board upload's file and options, or the Plot page operations (`ops`; a job made before a job could hold several keeps its one in `mill`). */
export interface Recipe {
    file?: string | null;
    options?: Record<string, unknown> | null;
    mill?: MillOperation | null;
    ops?: MillOperation[] | null;
}

/** What the Plot page cuts: points drilled, a board job's holes, a line through points, a face, a pocket or a profile. */
export type MillKind = "drill" | "holes" | "line" | "face" | "pocket" | "profile";

/** The shape a pocket or a profile is of. */
export type MillShape = "rect" | "circle";

/** Where a profile cuts: around the outside of the shape, inside it, or with the bit's center on its line. */
export type MillSide = "outside" | "inside" | "on";

/** One Plot page operation; which of the shape's fields count follows the kind and the shape. */
export interface MillOperation {
    kind: MillKind;
    /** What cuts: a spindle's bit, or a laser's beam; left out, the spindle. */
    cutter?: "spindle" | "laser";
    /** The job's name; left out, one is made from the operation. */
    name?: string | null;
    /** The bit's diameter, or the beam's spot, mm. */
    tool: number;
    /** How deep under the surface the cut ends, and how far each pass goes down, mm. */
    depth: number;
    step_down: number;
    /** A face's rows or a pocket's loops apart, as a share of the bit. */
    stepover: number;
    /** Feed along the cut and down into it, mm/min, and the spindle's S. */
    speed: number;
    plunge: number;
    spindle: number;
    /** A laser: its power, and how many times each path is burnt. */
    power?: number;
    passes?: number;
    /** Climb milling, with the spindle turning clockwise; else conventional. */
    climb: boolean;
    /** A drill's or a line's points, board mm; a line may close. */
    points: Point[];
    closed: boolean;
    shape: MillShape;
    /** A rectangle by two corners, and for a pocket or a profile the radius its corners are rounded to (0 square). */
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    corner?: number;
    /** A circle by its center and diameter. */
    cx: number;
    cy: number;
    diameter: number;
    side: MillSide;
    /** Holes: the job they are taken from, the diameters to take (all when null), and whether one wider than the bit is bored out. */
    job?: string | null;
    sizes?: number[] | null;
    bore: boolean;
    /** The holes themselves, filled in when the operation is made and kept with it, so it is made again without the job they came from. */
    holes?: HolePoint[] | null;
}

/**
 * A job of one operation or several as the page sends it: `job` names the
 * Plot page job they replace, null for a new job; `like` names a job a new
 * one is put as, its operations typed in that job's frame from before its
 * move.
 */
export interface MillJobRequest {
    ops: MillOperation[];
    name?: string | null;
    job?: string | null;
    like?: string | null;
}

/** An operation's job and what to know about it. */
export interface MillResponse {
    job: Job;
    notes: string[];
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
    /** How the layer was flipped before the turn, for a layer cut with the board turned over; missing on older jobs, none. */
    mirror?: Mirror;
}

/** How a board layer is flipped: x negates X (the board turned over left to right), y negates Y. */
export type Mirror = "none" | "x" | "y";

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
    focus?: number | null;
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
    /** The job can be made again for another width from what it was made of. */
    remake?: boolean;
    /** How many drill holes the job has. */
    holes?: number;
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
    /** A laser's mm over focus for the group, within 50 either way; null takes it away. */
    focus?: number | null;
}

/** What a job is turned about: the middle of the box round what it cuts, or the origin. */
export type TurnAbout = "center" | "origin";

export interface JobPatch {
    name?: string;
    groups?: GroupPatch[];
    offset?: Board;
    /** Degrees to turn the job counterclockwise, -360 to 360, after the offset. */
    turn?: number;
    /** What `turn` turns about; left out, the middle. */
    about?: TurnAbout;
}

export interface UploadOptions {
    power?: number;
    speed?: number;
    spot?: number;
    anchor?: Anchor;
    offset_x?: number;
    offset_y?: number;
    /** The layer a KiCad board is read from, a KiCad layer name; left out, F.Cu, or F.Paste for a stencil or a dispense. */
    layer?: string;
    /** Gerber and KiCad boards only; left out, the board is isolated. */
    mode?: BoardMode;
    /** A stencil only: mm every opening is shrunk by on every side, 0 to 10; left out, none. */
    margin?: number;
    /** A dispense only: mm of paste over every pad, 0.01 to 5; left out, 0.12. */
    thickness?: number;
    /** Isolation only; left out, no copper is cleared. */
    clear?: ClearPattern;
    /** A deposit only; left out, the loops go on in to the middle. */
    fill?: DepositFill;
    /** Gerber and KiCad boards; left out, x for a layer on the back (B.Cu, B.Paste) and none for the front. */
    mirror?: Mirror;
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

/** A calibration test; a ladder is [first, last, steps], both ends included, and what is left out takes the backend's default. */
export interface CalibrateRequest {
    /** A laser's grid of squares at a power and a speed each, its row of lines a step over focus each (on a focus axis), or a mill's row of slots a step deeper each. */
    kind?: "material" | "depth" | "focus";
    powers?: [number, number, number];
    speeds?: [number, number, number];
    size?: number;
    gap?: number;
    /** Filled squares a spot apart (an engraving test), or outlines (a cut). */
    fill?: boolean;
    spot?: number;
    depths?: [number, number, number];
    length?: number;
    feed?: number;
    plunge?: number;
    /** The spindle's S for every slot. */
    spindle?: number;
    /** The focus ladder: mm over focus from the first line to the last, and the one power and speed of every line. */
    focuses?: [number, number, number];
    power?: number;
    speed?: number;
    /** The lower left corner, board mm. */
    x?: number;
    y?: number;
}

export type CalibrateResponse = CenterResponse;

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
    /** How the run follows the height map, an auto settled: missing from a backend that predates it. */
    compensate?: MapMode;
}

/** How a run follows the height map: not at all, the focus axis where fitted, else power, or one of the two. */
export type Compensate = "off" | "auto" | "focus" | "power";

/** How a run follows the height map once an auto is settled. */
export type MapMode = Exclude<Compensate, "auto">;

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
    /** The focus axis height probing travels at, mm: where the head was when it began; going on rises to it first. */
    travel?: number | null;
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
    | { type: "align"; data: AlignState }
    | { type: "pnp"; data: PnpState }
    | { type: "placing"; data: PlacingState }
    | { type: "markers"; data: MarkersResponse }
    | { type: "camlog"; data: CamLogState }
    | { type: "auto"; data: AutoEvent };

// --- The Auto tab ----------------------------------------------------------------

/** Who a line of the conversation is from: the operator, the model, a tool call, or the backend's own notice or error. */
export type AutoRole = "user" | "assistant" | "tool" | "notice" | "error";

/** One line of the Auto tab's conversation, as the backend keeps it. */
export interface AutoEntry {
    /** Counts up for the backend's life; an update to a line comes under its id. */
    id: number;
    role: AutoRole;
    text: string;
    /** False while an answer is being written or a tool call runs. */
    done: boolean;
    /** A tool call only: the tool, what it was given and what it answered. */
    name?: string;
    arguments?: unknown;
    result?: string | null;
    error?: boolean;
    /** What the call changed that the page shows: `jobs` has the page list the jobs again. */
    changed?: string[];
}

export interface AutoConversation {
    entries: AutoEntry[];
    /** A turn is under way. */
    busy: boolean;
}

/** An `auto` event: a line added or changed, or none when only `busy` changed; `cleared` empties the conversation. */
export interface AutoEvent {
    entry: AutoEntry | null;
    busy: boolean;
    cleared: boolean;
}

export type AutoProviderId = "anthropic" | "openai" | "claude-code" | "mock";

export interface AutoProvider {
    id: AutoProviderId;
    label: string;
    /** What a blank model means for this provider; empty when the provider has none of its own. */
    default_model: string;
    /** The environment variable the key is read from where the backend runs; null for a provider with none. */
    key_name: string | null;
    /** Whether that key is set; the key itself never comes to the page. Null for a provider with none. */
    key_present: boolean | null;
    /** False when a turn with it cannot start, such as Claude Code not installed. */
    ready: boolean;
    note: string | null;
}

export interface AutoSettings {
    provider: AutoProviderId;
    /** The provider's model as typed; empty takes its `default_model`. */
    model: string;
    /** The OpenAI-compatible provider's address. */
    base_url: string;
    /** Each provider's model as typed, kept apart. */
    models: Partial<Record<AutoProviderId, string>>;
    providers: AutoProvider[];
    /** Tool calls in one turn at most. */
    max_tool_calls: number;
}

export interface AutoSettingsUpdate {
    provider?: AutoProviderId;
    model?: string;
    base_url?: string;
}

// --- The camera log ------------------------------------------------------------

/** Which camera a log entry is from: the one on the head, the up camera, or a G-code machine's top camera. */
export type LoggedCamera = "head" | "up" | "top";

/** A spot finder's answer, as pcbv gives it. */
export interface SpotReply {
    found: boolean;
    x?: number;
    y?: number;
    dx?: number;
    dy?: number;
    area?: number;
    major?: number;
    minor?: number;
    /** The equivalent ellipse's major axis, degrees from the picture's +x toward its +y (down). */
    angle?: number;
    contrast?: number;
    /** The smallest rectangle around the spot's pixels: its sides, px, and its long side's direction as `angle`. */
    rect?: { length: number; width: number; angle: number };
}

/** One picture a camera's routine looked at, or a photo taken by hand. */
export interface CamLogEntry {
    /** Sorts by time: the second taken and a count within it. */
    id: string;
    time: string;
    camera: LoggedCamera;
    /** What was looking: a routine's name, or `photo`. */
    routine: string;
    step: string;
    note: string;
    width: number;
    height: number;
    /** What the finder answered for this look; null for a photo without one. */
    spot: SpotReply | null;
    /** The files: the picture as it was, the same with the marks (an SVG holding it), and pcbv's picture with the board's pose when the camera had a board. */
    files: { photo: string; overlay: string; pose?: string };
}

export interface CamLogState {
    /** Whether the routines' looks are kept. */
    enabled: boolean;
    /** Entries kept, of the camera asked for when one was. */
    count: number;
    /** The newest first. */
    entries: CamLogEntry[];
}

// --- Pick and place -----------------------------------------------------------

/** What the spot finder looks for: a dark spot, or a bright one. */
export type SpotPolarity = "dark" | "bright";

/** The up camera, fixed to the machine and looking up at what the head holds. */
export interface PnpSettings {
    device: string;
    size: string;
    fps: number;
    pcbv: string;
    /** The spot the nozzle shows (its bore), and the one a part on it shows. */
    nozzle_spot: SpotPolarity;
    part_spot: SpotPolarity;
    /** The rail and cross slide joints that put the nozzle over the picture's center; null until measured or typed. */
    position: [number, number] | null;
    /** The H the nozzle is seen sharp at over the camera; null keeps the travel height. */
    height: number | null;
    mm_per_px: number;
    roll: number;
    /** Looking up turns the picture over: the routine measures it. */
    mirror: boolean;
}

export type PnpStep = "lifting" | "moving" | "lowering" | "scale" | "centering" | "looking" | "turning" | "done";

/** The nozzle routine (center the nozzle over the camera), the part routine (see where a part sits on it), or the runout routine (the tip at six turns of the nozzle). */
export interface PnpRoutine {
    kind: "nozzle" | "part" | "runout";
    /** The machine it moves: one on this project's firmware, or a G-code machine. */
    target?: "machine" | "gcode";
    state: RoutineState;
    step: PnpStep;
    done: number;
    total: number;
    error: string | null;
    spot: RoutineSpot | null;
    seconds?: number;
}

/** Where the last part looked at sits against the nozzle's center, mm in the machine's frame, how big it looked, and its long side's direction in the machine's frame, degrees (null when the picture gave none). */
export interface PartOffset {
    dx: number;
    dy: number;
    mm: number;
    length: number;
    width: number;
    angle?: number | null;
}

export interface PnpState extends PnpSettings {
    running: boolean;
    frame: { width: number; height: number; age_ms: number | null; fps: number | null } | null;
    routine: PnpRoutine | null;
    part_offset: PartOffset | null;
}

/** A part of a board job: its footprint's place and angle in the job's frame. */
export interface Component {
    ref: string;
    value: string;
    footprint: string;
    side: "front" | "back";
    x: number;
    y: number;
    rotation: number;
    pads: number;
    smd: boolean;
    dnp: boolean;
    /** A fiducial (reference FID*, or a footprint named for one): the top camera finds it, nothing places it. */
    fiducial?: boolean;
    /** Its footprint's F.Fab extent, longer side first, mm; null without one. */
    body?: [number, number] | null;
    /** A fiducial's largest pad, mm. */
    diameter?: number | null;
}

export interface ComponentsResponse {
    job: string;
    components: Component[];
    /** Why there are none: the job keeps no board file. */
    note: string | null;
}

/** The nozzle over a part's place; with `correct`, the part's center as last seen on the nozzle instead. */
export interface PnpGotoRequest {
    job: string;
    ref: string;
    /** On this project's firmware: the part's center as the up camera last saw it on the nozzle over the place. */
    correct?: boolean;
    /** On a G-code machine: the top camera's picture center over the part, not the nozzle. */
    camera?: boolean;
}

// --- A G-code pick and place machine ---------------------------------------------

export interface FeederSummary {
    id: string;
    /** Words a part's value and footprint must all hold, any case. */
    match: string;
    /** The first part's place; null for a feeder on the bus whose slot is found when a run starts. */
    at: [number, number, number] | null;
    pitch: [number, number];
    count: number;
    /** A tray's columns; 0 for a strip. */
    columns: number;
    rotation: number;
    /** Each part is looked at over the up camera before it is placed. */
    vision: boolean;
    /** The part's length and width as the cameras see it; null takes the footprint's body. */
    size: [number, number] | null;
    /** The shade of a part in its pocket to the top camera, which then looks before each pick; null picks at the place. */
    pocket: SpotPolarity | null;
    /** Marks on the feeder the top camera finds once a run; its places follow them. */
    marks: [number, number][];
    mark: SpotPolarity;
    /** How far from the up camera's center its parts are looked for, mm; null takes the profile's. */
    crop?: number | null;
    /** The parts it holds by reference, which outdo the words. */
    refs?: string[];
    /** On the feeder bus: its id there, its address when the profile gives it, and its advance per part, mm. */
    bus_id?: string | null;
    slot?: number | null;
    advance?: number;
}

/** A feeder that answered a scan of the bus: its address, its id, and the profile's feeder of that id. */
export interface BusFeeder {
    address: number;
    id: string;
    feeder: string | null;
    /** The profile has a [[slot]] place for its address. */
    slot: boolean;
}

/** The vacuum sensor: the lines that read it, the pattern whose group is the reading, the readings with a part held and empty (none: read by hand only). */
export interface GcodeVacuum {
    read: string[];
    pattern: string;
    part_on: [number, number] | null;
    part_off: [number, number] | null;
}

/** The camera on a G-code machine's head looking down, as its file has it. */
export interface GcodeTopCamera {
    z: number | null;
    offset: [number, number] | null;
    fiducial: SpotPolarity;
    within: number;
}

/** A G-code machine's own tables as its file reads: port, dialect, heights, cameras, feeders. */
export interface GcodeDocument {
    id: string;
    name: string;
    description: string;
    url: string;
    /** Words in a port's USB names that make it this machine's. */
    match?: string[];
    baud: number;
    wait_ms: number;
    timeout: number;
    axes: string[];
    /** A positive rotation turns the nozzle clockwise seen from above. */
    rotation_cw: boolean;
    /** mm/min across and up or down. */
    feed_xy: number;
    feed_z: number;
    safe_z: number;
    place_z: number;
    pick_dwell_ms: number;
    place_dwell_ms: number;
    /** Where the head waits out of the way; null when the file has none. */
    park: [number, number] | null;
    /** Where the up camera is as designed, before centering measures it. */
    camera_position: [number, number] | null;
    /** The file switches lights for the cameras. */
    light: boolean;
    /** Where a part that failed a check is let go; null puts it back in its pocket. */
    discard: [number, number, number] | null;
    pick_tries: number;
    /** The height the nozzle is seen sharp at over the up camera, when it sits on this machine. */
    camera_z: number | null;
    /** A jog taking the nozzle from within this many mm of the up camera to farther, off the safe height, rises to it first; null never. */
    leave?: number | null;
    /** How far from the up camera's center a part is looked for, mm; null: as far as pcbv does. */
    crop?: number | null;
    /** The file has a feeder bus, and these slots' places. */
    bus?: boolean;
    slots?: { address: number; at: [number, number, number]; rotation: number }[];
    max_offset: number;
    max_turn: number;
    size_tolerance: number;
    vacuum: GcodeVacuum | null;
    top: GcodeTopCamera | null;
    feeders: FeederSummary[];
}

/** A part's place in the job paired with where it is on the machine, and how it was taken: the nozzle over it, the top camera over it, or a fiducial the top camera found. */
export interface PnpReference {
    job: string;
    ref: string;
    at: [number, number];
    by?: "nozzle" | "camera" | "fiducial";
}

export interface PlacingRun {
    state: "running" | "done" | "stopped" | "error";
    sent: number;
    total: number;
    part: string | null;
    placed: string[];
    /** Parts left out under way, with why. */
    failed: { ref: string; reason: string }[];
    /** What the run is doing now, in words. */
    doing: string | null;
    /** The board job the run places. */
    job: string | null;
    error: string | null;
    seconds: number;
    /** What the run did, a line per step: seconds from its start, the part, and how it went. */
    steps?: PlacingStep[];
}

export interface PlacingStep {
    t: number;
    ref: string | null;
    text: string;
    level: "info" | "warning" | "error";
}

/** The top camera's settings: the capture, the mark the offset is measured from, and what it measured. */
export interface TopSettings {
    device: string;
    size: string;
    fps: number;
    pcbv: string;
    mark_spot: SpotPolarity;
    /** The head's place with the nozzle's tip over the mark. */
    mark_at: [number, number] | null;
    /** Where the picture's center is from the nozzle's tip, mm; null until measured. */
    offset: [number, number] | null;
    mm_per_px: number;
    roll: number;
    mirror: boolean;
}

export type TopStep = "lifting" | "moving" | "lowering" | "scale" | "centering" | "fitting" | "done" | string;

/** The top camera's routine: its offset measured, or the board's fiducials found (a step per fiducial). */
export interface TopRoutine {
    kind: "offset" | "fiducials";
    target?: "machine" | "gcode";
    state: RoutineState;
    step: TopStep;
    done: number;
    total: number;
    error: string | null;
    spot: RoutineSpot | null;
    seconds?: number;
}

export interface TopState extends TopSettings {
    running: boolean;
    frame: { width: number; height: number; age_ms: number | null; fps: number | null } | null;
    routine: TopRoutine | null;
    /** The fiducials last found: the job, where each is on the machine, and the fit made of them. */
    fiducials: { job: string; found: { ref: string; at: [number, number] }[]; fit: AlignFit } | null;
}

/**
 * What the PNP tab keeps of the G-code machine it places with (the one
 * connected, else the one last connected), with that machine's link.
 */
export interface PlacingState {
    /** The machine file's id, or null with no G-code machine to place with. */
    machine: string | null;
    name: string | null;
    /** Its file's own tables, read; null with none. */
    document: GcodeDocument | null;
    /** Boards a run finished since the count was reset. */
    boards?: number;
    /** Whether the lights were last switched on; null until switched. */
    light?: boolean | null;
    /** The vacuum as last switched and the sensor's last reading. */
    vacuum?: { on: boolean | null; reading: number | null };
    /** Degrees the board is turned on the machine, for a fit from one reference. */
    angle: number | null;
    references: PnpReference[];
    /** How many parts each feeder has given. */
    taken: Record<string, number>;
    /** Where the up camera sits on the machine and how its picture lies, as centering the nozzle over it measured, and the nozzle tip's runout off its turning axis at 0, mm. */
    camera: { position: [number, number] | null; height: number | null; mm_per_px: number; roll: number; mirror: boolean; runout?: [number, number] | null; measured?: boolean };
    /** The top camera on the machine's head. */
    top?: TopState;
    /** This machine is the one connected. */
    connected: boolean;
    url: string | null;
    /** Why the link was lost, or null. */
    lost: string | null;
    running: boolean;
    homed: boolean;
    position: { x?: number; y?: number; z?: number; rotation?: number } | null;
    progress: PlacingRun | null;
    log: { dir: string; text: string }[];
}

/** A placement program: the parts it places, from which feeder, the parts it leaves, the board's fit and the G-code. */
export interface PlacingPlan {
    /** `vision`: the part is looked at over the up camera between its pick and its place. */
    parts: { ref: string; feeder: string; index: number; vision: boolean }[];
    skipped: { ref: string; reason: string }[];
    fit: AlignFit;
    lines: number;
    text: string;
}

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

/** A size a camera captures at, with the best rate it gives there. */
export interface CameraMode {
    /** WIDTHxHEIGHT. */
    size: string;
    /** Frames a second; 0 when the camera does not say. */
    fps: number;
}

/** A camera the backend found attached, for a camera's device to be picked from. */
export interface DetectedCamera {
    /** What the device setting is given: a stable /dev/v4l name, a stream's URL, or socket://host:port. */
    device: string;
    /** Every name that reaches the camera (its node, its links), so a device set by any of them is known as it. */
    names: string[];
    /** What the camera calls itself, or what it is. */
    name: string;
    /** `v4l2` a camera on the backend's computer, `stream` a stream on a forwarded port, `pcbv` a pcbv serving on one. */
    kind: "v4l2" | "stream" | "pcbv";
    /** Largest first; empty when the camera does not say. */
    modes: CameraMode[];
    /** A stream: whether its camera gives pictures; null when not known. */
    online: boolean | null;
}

export interface CamerasResponse {
    cameras: DetectedCamera[];
    /** Why some cameras could not be looked for (pcbv not built, for one). */
    problems: string[];
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

export type CamShape = "flat" | "ball" | "bull" | "vee";

export interface CamTool {
    id: string;
    kind: Tool;
    name: string;
    /** The width of the cut: a bit's diameter or a beam's spot, mm. */
    width: number;
    /** The cutting settings the file gives the tool, by key. */
    settings: Record<string, number>;
    /** A V bit: its included angle, degrees, its tip's width and its shank, mm. */
    angle?: number;
    tip?: number;
    shank?: number;
    /** A mill's end, as a model is cut with it. */
    shape?: CamShape;
    /** A bull nose's corner radius, mm. */
    corner?: number;
    flutes?: number;
    /** How deep under the stock's top it reaches, mm. */
    length?: number;
}

/** What a 3D model goes through: cleared level by level, its walls followed, its surfaces combed. */
export type CamModelSource = "rough" | "waterline" | "parallel";

export type CamSource = "isolation" | "clearing" | "outline" | "drills" | "deposit" | "paths" | CamModelSource;

/** What a mill cuts, and how hard it can be pushed. */
export interface CamMaterial {
    id: string;
    name: string;
    /** The cutting edge's speed, m/min. */
    speed: number;
    /** [diameter mm, mm per tooth], by diameter. */
    chip_load: [number, number][];
    /** Of the tool's diameter: a rough's step down and stepover. */
    depth: number;
    stepover: number;
    /** The steepest entry, degrees. */
    ramp: number;
    /** The plunge rate, of the feed. */
    plunge: number;
    /** mm a rough leaves for the finish. */
    leave: number;
    note: string;
}

/** The block a model is cut from. */
export interface CamStock {
    /** A material's id; null for none. */
    material: string | null;
    margin: number;
    top: number;
    size: [number, number, number] | null;
}

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
    /** Where the speed and feed came from when a material worked them out; empty when the file gave them. */
    feeds?: string;
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
    mirror: Mirror;
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
    /** The stock's material by name, when the profile has one. */
    material?: string | null;
    /** Whether the profile cuts a 3D model: it has a rough, waterline or parallel operation. */
    model?: boolean;
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
    material?: string | null;
    model?: boolean;
    materials?: CamMaterial[];
    stock?: CamStock;
    /** How a model is stood up: turned about X, then Y, then Z by degrees, and scaled. */
    model_setup?: { turn: [number, number, number]; scale: number };
    /** The spindle's speed range a material's rpm is held to. */
    spindle?: { min: number; max: number };
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
export type CamValue = number | string | boolean | string[] | number[] | null;

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
