// Typed wrappers over the backend routes.

import type {
    AlignFit,
    AlignMarkRequest,
    AlignState,
    AutoConversation,
    AutoSettings,
    AutoSettingsUpdate,
    BusFeeder,
    CalibrateRequest,
    CalibrateResponse,
    CameraControls,
    CameraPose,
    CameraSettings,
    CamerasResponse,
    CameraState,
    CamGcodeResponse,
    CamJobResponse,
    CamLogEntry,
    CamLogState,
    CamPath,
    CamProfileResponse,
    CamProfilesResponse,
    CamValue,
    CenterRequest,
    CenterResponse,
    ColorItem,
    CommandResponse,
    Compensate,
    ComponentsResponse,
    ControlledCamera,
    CornerName,
    GotoRequest,
    HeightMap,
    HeightMapState,
    Job,
    JobPatch,
    JobsResponse,
    JobSummary,
    JogRequest,
    LensMeasured,
    LogFile,
    LoggedCamera,
    LogResponse,
    MachineCheck,
    MachineFromBoard,
    MachineResponse,
    MachinesResponse,
    Marker,
    MarkersResponse,
    MarkRequest,
    MillJobRequest,
    MillResponse,
    Mode,
    PadProbePlan,
    PadProbeRequest,
    PartsFilter,
    PartsFilterState,
    PlacingPlan,
    PlacingState,
    PnpGotoRequest,
    PnpSettings,
    PnpState,
    Port,
    PortsResponse,
    PositionRequest,
    ProbeEstimate,
    ProbeRequest,
    ProbeSettings,
    Progress,
    RealtimeAction,
    RefineUse,
    ResumePlan,
    ResumeRecord,
    ResumeRequest,
    SearchCamera,
    SearchLogState,
    SettingsResponse,
    SettingsUpdate,
    Snapshot,
    SpotPolarity,
    StopAnswer,
    TopSettings,
    TouchPlan,
    TouchRequest,
    UpdateState,
    UploadOptions,
} from "./types.ts";
import type { PluginInfo, PluginWithSource } from "./plugins.ts";
import type { BugReport, ReportAnswer, ReportSettings } from "./reports.ts";
import type { TodoItem, TodoList } from "./todo.ts";

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

export interface Api {
    /** Plot page operations as a job, not stored, to be seen before it is made; with `job`, placed where that job is. */
    planMill(body: MillJobRequest): Promise<MillResponse>;
    /** Plot page operations made into a stored job, or with `job` put in that Plot page job's place. */
    makeMill(body: MillJobRequest): Promise<MillResponse>;
    /** The markers, kept by the backend for every page. */
    markers(): Promise<Marker[]>;
    /** Puts the whole list of markers in place of the one kept; answers it as kept. */
    setMarkers(markers: Marker[]): Promise<Marker[]>;
    /** The top bar's to-do list, as the backend keeps it for every browser. */
    todo(): Promise<TodoList>;
    /** Puts the whole to-do list in place of the one kept, made on `revision` (409 when the list moved on since; null puts it anyway); answers it as kept. */
    setTodo(items: TodoItem[], revision: number | null): Promise<TodoList>;
    /** Keeps a bug report on the backend (var/reports/<time>/) and hands it on as the report link says; answers where it went. */
    saveReport(report: BugReport): Promise<ReportAnswer>;
    /** Where bug reports are handed on: a GitHub repository, another address, or nowhere. */
    reportSettings(): Promise<ReportSettings>;
    /** Keeps the report link (empty for none); answers the settings as kept. */
    setReportLink(link: string): Promise<ReportSettings>;
    /** The page's plugins, as the backend keeps them (var/plugins). */
    plugins(): Promise<PluginInfo[]>;
    /** A plugin with its source. */
    plugin(id: string): Promise<PluginWithSource>;
    /** Turns a plugin on as the text whose hash is `hash` (409 when it changed since it was shown), or off. */
    setPluginEnabled(id: string, enabled: boolean, hash: string | null): Promise<PluginInfo>;
    deletePlugin(id: string): Promise<void>;
    /** Where the module of a plugin turned on is imported from: served only while it is on as `info.hash`. */
    pluginModuleUrl(info: PluginInfo): string;
    ports(): Promise<Port[]>;
    /** Opens the machine on a port: a G-code machine when `machine` names its file or a G-code machine file claims the port, else this project's firmware. */
    connect(url: string, machine?: string | null): Promise<Snapshot>;
    disconnect(): Promise<Snapshot>;
    state(): Promise<Snapshot>;

    jog(request: JogRequest): Promise<void>;
    goto(request: GotoRequest): Promise<void>;
    jogCancel(): Promise<void>;
    setPosition(request: PositionRequest): Promise<void>;
    motors(enabled: boolean): Promise<void>;
    unlock(): Promise<void>;
    /** Homes the axes named (letters, each with an optional - or + for the end), or every axis with an endstop; answers when the home ends. */
    home(axes?: string): Promise<void>;
    realtime(action: RealtimeAction): Promise<void>;
    /** The big Stop: a run or probing stopped, else a routine ended, motion cancelled and the output off; a G-code machine's own stop. */
    stopAll(): Promise<StopAnswer>;
    command(line: string): Promise<string[]>;

    laser(power: number, ms: number): Promise<void>;
    laserOff(): Promise<void>;
    /** Starts the spindle at `S`, or changes its speed. */
    spindle(power: number): Promise<void>;
    spindleOff(): Promise<void>;
    mode(mode: Mode): Promise<void>;

    settings(): Promise<SettingsResponse>;
    updateSettings(patch: SettingsUpdate): Promise<void>;
    saveSettings(): Promise<void>;
    machines(): Promise<MachinesResponse>;
    /** Writes a machine file's every setting, and saves them to flash when asked; answers the settings as they are then. */
    applyMachine(id: string, save?: boolean): Promise<SettingsResponse>;

    /** A machine file as written, with what it reads as or why it does not. */
    machineFile(id: string): Promise<MachineResponse>;
    /** Writes a text as the file once it reads as a machine; refused with what is wrong otherwise. */
    saveMachineFile(id: string, text: string): Promise<MachineResponse>;
    /** What a text would read as, and what is wrong with it, without writing it. */
    checkMachineFile(id: string, text: string): Promise<MachineCheck>;
    /** The text with the connected board's values written into it, not saved. */
    machineFromBoard(id: string, text: string): Promise<MachineFromBoard>;
    deleteMachineFile(id: string): Promise<void>;
    /** One value of a machine file changed in its text, comments and all; a plain table not there yet is added. */
    patchMachineFile(id: string, path: CamPath, value: CamValue): Promise<MachineResponse>;
    /** The CAM profiles in cam/, and the files that could not be read. */
    camProfiles(): Promise<CamProfilesResponse>;
    camProfile(id: string): Promise<CamProfileResponse>;
    /** Writes the text as the profile once it reads as one; creates the profile when it is new. */
    saveCamProfile(id: string, text: string): Promise<CamProfileResponse>;
    /** Changes one value in the file and keeps the rest, comments included. */
    patchCamProfile(id: string, path: CamPath, value: CamValue): Promise<CamProfileResponse>;
    deleteCamProfile(id: string): Promise<void>;
    /** The design files (a board with its outline and drill file, an SVG, a DXF drawing, gcode, a job or a model) through the profile into a stored job. */
    camJob(id: string, files: File[], name?: string): Promise<CamJobResponse>;
    /** A stored job as gcode for the profile's controller. */
    camGcode(id: string, jobId: string): Promise<CamGcodeResponse>;

    uploadJob(file: File, options: UploadOptions): Promise<Job>;
    /** Builds and stores the centering test burn. */
    centerJob(request: CenterRequest): Promise<CenterResponse>;
    /** A calibration test made into a job: the material test on a laser, the depth test on a mill. */
    calibrateJob(request: CalibrateRequest): Promise<CalibrateResponse>;
    /** The installed release and its update from GitHub. */
    updateState(): Promise<UpdateState>;
    /** Asks GitHub for the latest release. */
    updateCheck(): Promise<UpdateState>;
    /** Starts the update to the release last checked. */
    updateInstall(): Promise<UpdateState>;
    /** Takes pre-releases into a check, or leaves them out; kept on the backend, and a check made the other way forgotten. */
    updatePrereleases(follow: boolean): Promise<UpdateState>;
    jobs(): Promise<JobSummary[]>;
    job(id: string): Promise<Job>;
    patchJob(id: string, patch: JobPatch): Promise<void>;
    /** The job made again for a bit or a spot `width` mm across; a drawing takes the width with its paths as they are. */
    setJobWidth(id: string, width: number): Promise<Job>;
    /** The job made what `job` says, its id kept, as the JSON editor or a regrouping of paths sends it; answers the job as kept. */
    replaceJob(id: string, job: Job): Promise<Job>;
    /** A new job of the jobs named, cut in that order, each group's label led by its job's name. */
    combineJobs(ids: string[], name?: string | null): Promise<Job>;
    /** Where the job's small drawing for the list is: the address changes with what the drawing shows. */
    jobThumbUrl(job: JobSummary): string;
    /** A stencil made again with every opening shrunk by `margin` mm. */
    setJobMargin(id: string, margin: number): Promise<Job>;
    deleteJob(id: string): Promise<void>;
    /** Removes every job but the one running; answers their ids. */
    deleteAllJobs(): Promise<string[]>;
    /**
     * `compensate` follows the height map; left out, the run does not.
     * `focusHere` is the operator's word that the head is at focus where it
     * stands, for a laser group's own focus to count from.
     */
    runJob(id: string, compensate?: Compensate, focusHere?: boolean): Promise<void>;
    /** Picks the job up at a line: the lines before it count as done, the head is brought to where it begins. */
    resumeJob(id: string, request: ResumeRequest): Promise<Progress>;
    /** What `resumeJob` would do, without moving anything. */
    planResume(id: string, request: ResumeRequest): Promise<ResumePlan>;
    /** The last run's record; null when none ran. */
    resumeRecord(): Promise<ResumeRecord | null>;
    runHold(): Promise<void>;
    runResume(): Promise<void>;
    runStop(): Promise<void>;
    run(): Promise<Progress | null>;
    /** The tail of the backend's log, oldest first. */
    log(lines?: number, file?: LogFile): Promise<string[]>;

    heightMap(): Promise<HeightMapState>;
    /** Probes the grid, replacing the map; the head's height now is the travel height. */
    probe(request: ProbeRequest): Promise<HeightMapState>;
    /** About how long probing would take, and the points it would probe. */
    probeEstimate(request: ProbeRequest): Promise<ProbeEstimate>;
    /** One probe down, under the head or at the nearest clear map point: ties the map to the frame in use, or makes the contact height H 0. */
    probeHere(request: TouchRequest): Promise<HeightMapState>;
    /** Where `probeHere` would go down and how the head gets there, without moving anything. */
    planTouch(request: TouchRequest): Promise<TouchPlan>;
    probeStop(): Promise<HeightMapState>;
    /** Sets the focus offset; null takes it from the head over the board now. */
    focus(offset: number | null): Promise<HeightMapState>;
    /** Takes back the offset a connect or a restart dropped, on the operator's word that the focus axis has not moved. */
    keepFocus(): Promise<HeightMapState>;
    probeSettings(patch: Partial<ProbeSettings>): Promise<HeightMapState>;
    putHeightMap(map: HeightMap): Promise<HeightMapState>;
    clearHeightMap(): Promise<HeightMapState>;
    /** Probes the board at a job's pads, replacing the map with a pad map; `resume` goes on with the one in the store. */
    probePads(request: PadProbeRequest): Promise<HeightMapState>;
    /** The points probing the pads would visit, how many pads were under the area and about how long, without moving anything. */
    planPads(request: PadProbeRequest): Promise<PadProbePlan>;

    /** The cameras attached, for the head camera's, the up camera's or a G-code machine's top camera's device to be picked from. */
    cameras(): Promise<CamerasResponse>;
    /** The camera state: its settings, whether it runs, the board it looks for, the mark, the newest pose and the find routine. */
    camera(): Promise<CameraState>;
    /** Keeps settings; a running camera given another device, size, fps or program starts again on them. */
    cameraSettings(patch: Partial<CameraSettings>): Promise<CameraState>;
    cameraStart(): Promise<CameraState>;
    cameraStop(): Promise<CameraState>;
    /**
     * Where the newest picture is, as an image source: a URL that asks for
     * a fresh picture every time it is made, shrunk to at most `width`
     * pixels, with the spots and the pose drawn on it when `overlay`.
     */
    cameraFrameUrl(width: number, overlay: boolean): string;
    /** The camera log: whether looks are kept, and the newest entries, of one camera when named. */
    camLog(camera?: LoggedCamera): Promise<CamLogState>;
    /** Logging the routines' looks on or off. */
    setCamLog(enabled: boolean): Promise<CamLogState>;
    /** A photo now with a camera, kept whether logging is on or not; with `find`, what its finder sees drawn on it. */
    takePhoto(camera: LoggedCamera, find: boolean): Promise<CamLogEntry>;
    /** Forgets every entry and its pictures; the count removed. */
    clearCamLog(): Promise<number>;
    /** A logged picture as an image source. */
    camLogFileUrl(name: string): string;
    /** The newest search records of the cameras' looks for a board, of one camera when named. */
    searchLog(camera?: SearchCamera): Promise<SearchLogState>;
    /** A search record's page (`report`) or one of its files, by name. */
    searchLogUrl(id: string, name: string): string;
    cameraPose(): Promise<CameraPose>;
    /** pcbv looks for the job's board in the pictures; null unloads it. */
    cameraBoard(jobId: string | null): Promise<CameraState>;
    /** Makes a mark with the tool where it stands, or with `here` only records the tool's point as the mark. */
    cameraMark(request: MarkRequest): Promise<CameraState>;
    /** Finds the mark in the picture and centers the picture on it, measuring the offset, the scale and the roll; on its own thread. */
    cameraFind(step: number): Promise<CameraState>;
    cameraAbort(): Promise<CameraState>;
    /** Moves the head camera over a box (board frame mm; null: where the corners taken put the board, else the board's size about where it looks now) until a guess of the board loaded is likely enough. */
    cameraSearch(box: [number, number, number, number] | null): Promise<CameraState>;
    /** The head camera's picture's center is on this corner of the job's board: its place is kept. */
    cameraCorner(jobId: string, corner: CornerName): Promise<CameraState>;
    /** The head camera's corners taken are forgotten. */
    cameraCornersClear(): Promise<CameraState>;
    /** The head camera sees a corner of the job's blank board on the bed: where its edges meet is kept as that corner, with the board's turn. */
    cameraEdgeCorner(jobId: string, corner: CornerName): Promise<CameraState>;
    /** The head camera centers features far apart on the board found (fiducials, holes or pads) and makes them the job's camera marks in Align. */
    cameraRefine(jobId: string, use: RefineUse, count: number): Promise<CameraState>;
    /** A camera's lens measured from the dot grid in its picture now, kept and applied. */
    cameraLens(camera: ControlledCamera, polarity: SpotPolarity, pitch: number): Promise<{ camera: ControlledCamera; measured: LensMeasured | null }>;
    /** A camera's lens correction forgotten. */
    cameraLensClear(camera: ControlledCamera): Promise<{ camera: ControlledCamera; measured: null }>;
    /** A color read off a camera's picture at a point of the full size picture, kept for what it looks for; null point: the color forgotten. */
    cameraColor(camera: ControlledCamera, item: ColorItem, point: [number, number] | null): Promise<{ camera: ControlledCamera; item: ColorItem; rgb: [number, number, number] | null }>;
    /** A camera's V4L2 controls as its device has them now, with the values it keeps. */
    cameraControls(camera: ControlledCamera): Promise<CameraControls>;
    /** Sets control values now and keeps them, to be set at each start; null forgets a kept one. */
    setCameraControls(camera: ControlledCamera, values: Record<string, number | null>): Promise<CameraControls>;

    align(): Promise<AlignState>;
    /** A mark from the tool's point now. */
    alignMark(request: AlignMarkRequest): Promise<AlignState>;
    /** A mark from the camera: the picture's center in the job's frame against the tool's point plus the camera offset. */
    alignCapture(jobId: string): Promise<AlignState>;
    alignDeleteMark(index: number): Promise<AlignState>;
    alignClear(): Promise<AlignState>;
    /** The fit the marks give, without moving anything. */
    alignFit(jobId: string): Promise<AlignFit>;
    /** Fits, turns and shifts the job, and clears the marks. */
    alignApply(jobId: string): Promise<{ job: Job; fit: AlignFit }>;

    /** The up camera: its settings, whether it runs, the routine and the part last looked at. */
    pnp(): Promise<PnpState>;
    /** Keeps settings; `clear` takes the position or the height back to none. A running up camera given another device, size, fps or program starts again on them. */
    pnpSettings(patch: Partial<PnpSettings> & { clear?: ("position" | "height")[] }): Promise<PnpState>;
    pnpStart(): Promise<PnpState>;
    pnpStop(): Promise<PnpState>;
    /** The up camera's newest picture as an image source, as `cameraFrameUrl` is the head camera's. */
    pnpFrameUrl(width: number, overlay: boolean): string;
    /** Centers the nozzle over the up camera, measuring where it is and how its picture lies; `step` 0 keeps the scale. */
    pnpNozzle(step: number): Promise<PnpState>;
    /** Looks at the part on the nozzle over the up camera. */
    pnpPart(): Promise<PnpState>;
    pnpAbort(): Promise<PnpState>;
    /** The nozzle's or a part's spot found once over the up camera, no move: kept as the state's look. */
    pnpLook(spot: "nozzle" | "part"): Promise<PnpState>;
    /** The nozzle over a part's place at the travel height. */
    pnpGoto(request: PnpGotoRequest): Promise<void>;
    /** The parts of a board job; none for a job that keeps no board file. */
    components(jobId: string): Promise<ComponentsResponse>;
    /** The parts filter kept on the backend, which a placing run honors. */
    partsFilter(): Promise<PartsFilterState>;
    /** Keeps the parts filter; an expression that does not compile is refused (400). */
    setPartsFilter(filter: PartsFilter): Promise<PartsFilterState>;

    /** What the PNP tab keeps of the G-code machine it places with: the board's references, the feeders' counts, the machine's link and a run. */
    placingState(): Promise<PlacingState>;
    /** The board's typed turn on the machine, for a fit from one reference. */
    placingAngle(patch: { angle?: number; clear_angle?: boolean }): Promise<PlacingState>;
    pnpPark(): Promise<PlacingState>;
    /** The nozzle over the up camera, turned to 0, at the height it is sharp at. */
    pnpOverCamera(): Promise<PlacingState>;
    /** The nozzle over the point the top camera looks at, or the camera over the nozzle's. */
    pnpSwap(to: "nozzle" | "camera"): Promise<PlacingState>;
    /** The up camera's place on the machine: typed, the head's now, or forgotten. */
    pnpCameraPlace(request: { position?: [number, number]; here?: boolean; clear?: boolean }): Promise<PlacingState>;
    pnpLight(on: boolean): Promise<PlacingState>;
    /** The vacuum switched, and/or the sensor read. */
    pnpVacuum(request: { on?: boolean; read?: boolean }): Promise<PlacingState & { reply: string[] }>;
    /** The count of boards finished back to 0. */
    pnpBoardsReset(): Promise<PlacingState>;
    /** The feeders that answer on the feeder bus, with their ids. */
    pnpBusScan(): Promise<PlacingState & { feeders: BusFeeder[] }>;
    /** One advance of a feeder on the bus. */
    pnpBusFeed(feeder: string): Promise<PlacingState>;
    /** A reference for a part: where it is on the machine, read off it when `at` is left out. */
    pnpReference(request: { job: string; ref: string; at?: [number, number]; camera?: boolean }): Promise<PlacingState>;
    pnpDropReferences(job: string, ref?: string): Promise<PlacingState>;
    pnpPlan(job: string, refs?: string[]): Promise<PlacingPlan>;
    /** Where the program's G-code downloads from. */
    pnpProgramUrl(job: string, refs?: string[]): string;
    /** Places the parts; with `fiducials` the top camera finds the board's fiducials first. */
    pnpRun(job: string, refs?: string[], fiducials?: boolean): Promise<PlacingPlan & PlacingState>;
    pnpRunStop(): Promise<PlacingState>;
    /** Counts a feeder (or every one) from its first part again. */
    pnpResetFeeders(feeder?: string): Promise<PlacingState>;
    /** Measures how far the nozzle tip runs off its turning axis, over the up camera. */
    pnpRunout(): Promise<PlacingState>;
    /** The top camera finds the job's fiducials where the references put them, and keeps them as its references. */
    pnpFiducials(job: string): Promise<PlacingState>;
    /** Keeps the top camera's settings; `clear` takes the mark's place or the offset back to none. */
    topSettings(patch: Partial<TopSettings> & { clear?: ("mark_at" | "offset")[] }): Promise<PlacingState>;
    topStart(): Promise<PlacingState>;
    topStop(): Promise<PlacingState>;
    /** The top camera's picture. */
    topFrameUrl(width: number, overlay: boolean): string;
    /** The nozzle's tip is over a mark: the head's place is kept for Measure offset. */
    topMark(): Promise<PlacingState>;
    /** Measures where the top camera looks from the nozzle, from the mark; `step` 0 keeps the scale. */
    topOffset(step: number): Promise<PlacingState>;
    /** Homes, then finds the bed's homing fiducial with the top camera and declares where the head is from it. */
    topHome(): Promise<PlacingState>;
    topAbort(): Promise<PlacingState>;
    /** The top camera's mark spot found once, no move. */
    topLook(): Promise<PlacingState>;
    /** The job's board loaded into the top camera's pcbv, its poses read into `top.board_look`; null unloads it. */
    topBoard(jobId: string | null): Promise<PlacingState>;
    /** Moves the top camera over a box (machine X Y; null: where the corners taken put the board, else the board's size about where it looks now) until a guess is likely enough. */
    topSearch(box: [number, number, number, number] | null): Promise<PlacingState>;
    /** The board's place the look found, else the one its corners give, kept as the job's references. */
    topPlace(jobId: string): Promise<PlacingState>;
    /** The top camera's picture's center is on this corner of the job's board: its place is kept. */
    topCorner(jobId: string, corner: CornerName): Promise<PlacingState>;
    /** The top camera's corners taken are forgotten. */
    topCornersClear(): Promise<PlacingState>;
    /** The top camera sees a corner of the job's blank board on the bed: where its edges meet is kept as that corner, with the board's turn. */
    topEdgeCorner(jobId: string, corner: CornerName): Promise<PlacingState>;

    /** The Auto tab's provider, its model and address, and whether each provider's key is set where the backend runs. */
    autoSettings(): Promise<AutoSettings>;
    /** Keeps the provider, a model or the base URL for the next turn; answers the settings as kept. */
    setAutoSettings(patch: AutoSettingsUpdate): Promise<AutoSettings>;
    /** The conversation so far, and whether a turn is under way. */
    autoConversation(): Promise<AutoConversation>;
    /** Starts a turn with the operator's message; answers at once, the turn coming as `auto` events. */
    autoSend(text: string): Promise<AutoConversation>;
    /** Stops the turn under way. */
    autoStop(): Promise<AutoConversation>;
    /** A new chat: the turn under way stopped and the conversation forgotten. */
    autoClear(): Promise<AutoConversation>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What a caught error says: its message, or the value thrown as text. */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The width a camera's picture is asked for at: the width given, whole, from 160 to 4096 pixels. */
export function frameWidth(width: number): number {
    return Math.max(160, Math.min(4096, Math.round(width)));
}

/**
 * A short key of what a job's thumbnail depends on, put in the address it
 * is asked at, so the browser keeps an unchanged drawing and asks again
 * for a changed one.
 */
export function thumbKey(summary: { stats: { length_mm: number; moves: number }; offset: { x: number; y: number }; rotation?: number; groups: { enabled: boolean; paths: number }[] }): string {
    const text = JSON.stringify([summary.stats.length_mm, summary.stats.moves, summary.offset.x, summary.offset.y, summary.rotation ?? 0, summary.groups.map((group) => [group.enabled ? 1 : 0, group.paths])]);
    let hash = 5381;
    for (let index = 0; index < text.length; index++) {
        hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}

/** Pulls a readable message out of an error body: FastAPI's detail, or the text. */
export function errorMessage(data: unknown, status: number, statusText: string): string {
    if (typeof data === "string" && data.trim() !== "") {
        return data.trim();
    }
    if (data && typeof data === "object") {
        const body = data as Record<string, unknown>;
        for (const key of ["detail", "error", "message"]) {
            const value = body[key];
            if (typeof value === "string" && value !== "") {
                return value;
            }
            if (value !== undefined && value !== null) {
                return JSON.stringify(value);
            }
        }
    }
    return statusText ? `${status} ${statusText}` : `HTTP ${status}`;
}

export class HttpApi implements Api {
    private readonly base: string;
    private readonly fetchFn: FetchLike;

    constructor(base = "", fetchFn?: FetchLike) {
        this.base = base.replace(/\/+$/, "");
        this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const init: RequestInit = { method };
        if (body instanceof FormData) {
            init.body = body;
        } else if (body !== undefined) {
            init.headers = { "content-type": "application/json" };
            init.body = JSON.stringify(body);
        }
        let response: Response;
        try {
            response = await this.fetchFn(this.base + path, init);
        } catch (error) {
            throw new ApiError(0, `backend unreachable: ${errorText(error)}`);
        }
        const text = await response.text();
        let data: unknown = null;
        if (text !== "") {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }
        if (!response.ok) {
            throw new ApiError(response.status, errorMessage(data, response.status, response.statusText));
        }
        return data as T;
    }

    async ports(): Promise<Port[]> {
        const response = await this.request<PortsResponse>("GET", "/api/ports");
        return response.ports ?? [];
    }

    connect(url: string, machine: string | null = null): Promise<Snapshot> {
        return this.request<Snapshot>("POST", "/api/connect", machine ? { url, machine } : { url });
    }

    disconnect(): Promise<Snapshot> {
        return this.request<Snapshot>("POST", "/api/disconnect");
    }

    state(): Promise<Snapshot> {
        return this.request<Snapshot>("GET", "/api/state");
    }

    async jog(request: JogRequest): Promise<void> {
        await this.request("POST", "/api/jog", request);
    }

    async goto(request: GotoRequest): Promise<void> {
        await this.request("POST", "/api/goto", request);
    }

    async jogCancel(): Promise<void> {
        await this.request("POST", "/api/jog/cancel");
    }

    async setPosition(request: PositionRequest): Promise<void> {
        await this.request("POST", "/api/position", request);
    }

    async motors(enabled: boolean): Promise<void> {
        await this.request("POST", "/api/motors", { enabled });
    }

    async unlock(): Promise<void> {
        await this.request("POST", "/api/unlock");
    }

    async home(axes = ""): Promise<void> {
        await this.request("POST", "/api/home", { axes });
    }

    async realtime(action: RealtimeAction): Promise<void> {
        await this.request("POST", "/api/realtime", { action });
    }

    async stopAll(): Promise<StopAnswer> {
        return this.request<StopAnswer>("POST", "/api/stop");
    }

    async command(line: string): Promise<string[]> {
        const response = await this.request<CommandResponse>("POST", "/api/command", { line });
        return response.lines ?? [];
    }

    async laser(power: number, ms: number): Promise<void> {
        await this.request("POST", "/api/laser", { power, ms });
    }

    async laserOff(): Promise<void> {
        await this.request("POST", "/api/laser/off");
    }

    async spindle(power: number): Promise<void> {
        await this.request("POST", "/api/spindle", { power });
    }

    async spindleOff(): Promise<void> {
        await this.request("POST", "/api/spindle/off");
    }

    async mode(mode: Mode): Promise<void> {
        await this.request("POST", "/api/mode", { mode });
    }

    settings(): Promise<SettingsResponse> {
        return this.request<SettingsResponse>("GET", "/api/settings");
    }

    async updateSettings(patch: SettingsUpdate): Promise<void> {
        await this.request("PUT", "/api/settings", patch);
    }

    async saveSettings(): Promise<void> {
        await this.request("POST", "/api/settings/save");
    }

    machines(): Promise<MachinesResponse> {
        return this.request<MachinesResponse>("GET", "/api/machines");
    }

    applyMachine(id: string, save = false): Promise<SettingsResponse> {
        return this.request<SettingsResponse>("POST", `/api/machines/${encodeURIComponent(id)}/apply`, { save });
    }

    machineFile(id: string): Promise<MachineResponse> {
        return this.request<MachineResponse>("GET", `/api/machines/${encodeURIComponent(id)}`);
    }

    saveMachineFile(id: string, text: string): Promise<MachineResponse> {
        return this.request<MachineResponse>("PUT", `/api/machines/${encodeURIComponent(id)}`, { text });
    }

    checkMachineFile(id: string, text: string): Promise<MachineCheck> {
        return this.request<MachineCheck>("POST", `/api/machines/${encodeURIComponent(id)}/check`, { text });
    }

    machineFromBoard(id: string, text: string): Promise<MachineFromBoard> {
        return this.request<MachineFromBoard>("POST", `/api/machines/${encodeURIComponent(id)}/from-board`, { text });
    }

    async deleteMachineFile(id: string): Promise<void> {
        await this.request("DELETE", `/api/machines/${encodeURIComponent(id)}`);
    }

    patchMachineFile(id: string, path: CamPath, value: CamValue): Promise<MachineResponse> {
        return this.request<MachineResponse>("PATCH", `/api/machines/${encodeURIComponent(id)}`, { path, value });
    }

    camProfiles(): Promise<CamProfilesResponse> {
        return this.request<CamProfilesResponse>("GET", "/api/cam");
    }

    camProfile(id: string): Promise<CamProfileResponse> {
        return this.request<CamProfileResponse>("GET", `/api/cam/${encodeURIComponent(id)}`);
    }

    saveCamProfile(id: string, text: string): Promise<CamProfileResponse> {
        return this.request<CamProfileResponse>("PUT", `/api/cam/${encodeURIComponent(id)}`, { text });
    }

    patchCamProfile(id: string, path: CamPath, value: CamValue): Promise<CamProfileResponse> {
        return this.request<CamProfileResponse>("PATCH", `/api/cam/${encodeURIComponent(id)}`, { path, value });
    }

    async deleteCamProfile(id: string): Promise<void> {
        await this.request("DELETE", `/api/cam/${encodeURIComponent(id)}`);
    }

    camJob(id: string, files: File[], name?: string): Promise<CamJobResponse> {
        const form = new FormData();
        for (const file of files) {
            form.append("files", file, file.name);
        }
        if (name && name.trim() !== "") {
            form.append("name", name.trim());
        }
        return this.request<CamJobResponse>("POST", `/api/cam/${encodeURIComponent(id)}/jobs`, form);
    }

    camGcode(id: string, jobId: string): Promise<CamGcodeResponse> {
        return this.request<CamGcodeResponse>("POST", `/api/cam/${encodeURIComponent(id)}/gcode`, { job: jobId });
    }

    uploadJob(file: File, options: UploadOptions): Promise<Job> {
        const form = new FormData();
        form.append("file", file, file.name);
        for (const [key, value] of Object.entries(options)) {
            if (value !== undefined && value !== null && value !== "") {
                form.append(key, String(value));
            }
        }
        return this.request<Job>("POST", "/api/jobs", form);
    }

    centerJob(request: CenterRequest): Promise<CenterResponse> {
        return this.request<CenterResponse>("POST", "/api/center", request);
    }

    calibrateJob(request: CalibrateRequest): Promise<CalibrateResponse> {
        return this.request<CalibrateResponse>("POST", "/api/calibrate", request);
    }

    updateState(): Promise<UpdateState> {
        return this.request<UpdateState>("GET", "/api/update");
    }

    updateCheck(): Promise<UpdateState> {
        return this.request<UpdateState>("POST", "/api/update/check");
    }

    updatePrereleases(follow: boolean): Promise<UpdateState> {
        return this.request<UpdateState>("PUT", "/api/update/settings", { prereleases: follow });
    }

    updateInstall(): Promise<UpdateState> {
        return this.request<UpdateState>("POST", "/api/update/install");
    }

    async jobs(): Promise<JobSummary[]> {
        const response = await this.request<JobsResponse>("GET", "/api/jobs");
        return response.jobs ?? [];
    }

    job(id: string): Promise<Job> {
        return this.request<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`);
    }

    async patchJob(id: string, patch: JobPatch): Promise<void> {
        await this.request("PATCH", `/api/jobs/${encodeURIComponent(id)}`, patch);
    }

    setJobWidth(id: string, width: number): Promise<Job> {
        return this.request<Job>("POST", `/api/jobs/${encodeURIComponent(id)}/width`, { width });
    }

    replaceJob(id: string, job: Job): Promise<Job> {
        return this.request<Job>("PUT", `/api/jobs/${encodeURIComponent(id)}`, job);
    }

    combineJobs(ids: string[], name: string | null = null): Promise<Job> {
        return this.request<Job>("POST", "/api/jobs/combine", { ids, name });
    }

    jobThumbUrl(job: JobSummary): string {
        return `${this.base}/api/jobs/${encodeURIComponent(job.id)}/thumb.svg?v=${thumbKey(job)}`;
    }

    setJobMargin(id: string, margin: number): Promise<Job> {
        return this.request<Job>("POST", `/api/jobs/${encodeURIComponent(id)}/margin`, { margin });
    }

    async deleteJob(id: string): Promise<void> {
        await this.request("DELETE", `/api/jobs/${encodeURIComponent(id)}`);
    }

    planMill(body: MillJobRequest): Promise<MillResponse> {
        return this.request<MillResponse>("POST", "/api/mill/plan", body);
    }

    makeMill(body: MillJobRequest): Promise<MillResponse> {
        return this.request<MillResponse>("POST", "/api/mill", body);
    }

    camLog(camera?: LoggedCamera): Promise<CamLogState> {
        return this.request<CamLogState>("GET", camera ? `/api/camlog?camera=${camera}` : "/api/camlog");
    }

    setCamLog(enabled: boolean): Promise<CamLogState> {
        return this.request<CamLogState>("PUT", "/api/camlog", { enabled });
    }

    takePhoto(camera: LoggedCamera, find: boolean): Promise<CamLogEntry> {
        return this.request<CamLogEntry>("POST", "/api/camlog/photo", { camera, find });
    }

    async clearCamLog(): Promise<number> {
        const response = await this.request<{ deleted: number }>("DELETE", "/api/camlog");
        return response.deleted ?? 0;
    }

    camLogFileUrl(name: string): string {
        return `${this.base}/api/camlog/${encodeURIComponent(name)}`;
    }

    searchLog(camera?: SearchCamera): Promise<SearchLogState> {
        return this.request<SearchLogState>("GET", camera ? `/api/searchlog?camera=${camera}` : "/api/searchlog");
    }

    searchLogUrl(id: string, name: string): string {
        return `${this.base}/api/searchlog/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
    }

    async markers(): Promise<Marker[]> {
        const response = await this.request<MarkersResponse>("GET", "/api/markers");
        return response.markers ?? [];
    }

    async setMarkers(markers: Marker[]): Promise<Marker[]> {
        const response = await this.request<MarkersResponse>("PUT", "/api/markers", { markers });
        return response.markers ?? [];
    }

    todo(): Promise<TodoList> {
        return this.request<TodoList>("GET", "/api/todo");
    }

    setTodo(items: TodoItem[], revision: number | null): Promise<TodoList> {
        return this.request<TodoList>("PUT", "/api/todo", revision === null ? { items } : { items, revision });
    }

    saveReport(report: BugReport): Promise<ReportAnswer> {
        const form = new FormData();
        form.append("text", report.text);
        form.append("page", report.page);
        form.append("address", report.address);
        form.append("browser", report.browser);
        form.append("window", report.window);
        if (report.actions !== null) {
            form.append("actions", JSON.stringify(report.actions));
        }
        if (report.screenshot !== null) {
            form.append("screenshot", new File([report.screenshot], "screenshot.png", { type: "image/png" }));
        }
        return this.request<ReportAnswer>("POST", "/api/reports", form);
    }

    reportSettings(): Promise<ReportSettings> {
        return this.request<ReportSettings>("GET", "/api/reports/settings");
    }

    setReportLink(link: string): Promise<ReportSettings> {
        return this.request<ReportSettings>("PUT", "/api/reports/settings", { link });
    }

    async plugins(): Promise<PluginInfo[]> {
        const response = await this.request<{ plugins: PluginInfo[] }>("GET", "/api/plugins");
        return response.plugins ?? [];
    }

    plugin(id: string): Promise<PluginWithSource> {
        return this.request<PluginWithSource>("GET", `/api/plugins/${encodeURIComponent(id)}`);
    }

    setPluginEnabled(id: string, enabled: boolean, hash: string | null): Promise<PluginInfo> {
        return this.request<PluginInfo>("PUT", `/api/plugins/${encodeURIComponent(id)}/enabled`, hash === null ? { enabled } : { enabled, hash });
    }

    async deletePlugin(id: string): Promise<void> {
        await this.request("DELETE", `/api/plugins/${encodeURIComponent(id)}`);
    }

    pluginModuleUrl(info: PluginInfo): string {
        const path = `${this.base}/api/plugins/${encodeURIComponent(info.id)}/module.js?v=${encodeURIComponent(info.hash)}`;
        // Made whole against the page's address: an import resolves a bare
        // path against the script's own, which Bun's dev server makes a file path.
        try {
            return new URL(path, globalThis.location?.href).href;
        } catch {
            return path;
        }
    }

    async deleteAllJobs(): Promise<string[]> {
        const response = await this.request<{ deleted: string[] }>("DELETE", "/api/jobs");
        return response.deleted ?? [];
    }

    async runJob(id: string, compensate: Compensate = "off", focusHere = false): Promise<void> {
        await this.request("POST", `/api/jobs/${encodeURIComponent(id)}/run`, focusHere ? { compensate, focus_here: true } : { compensate });
    }

    resumeJob(id: string, request: ResumeRequest): Promise<Progress> {
        return this.request<Progress>("POST", `/api/jobs/${encodeURIComponent(id)}/resume`, request);
    }

    planResume(id: string, request: ResumeRequest): Promise<ResumePlan> {
        return this.request<ResumePlan>("POST", `/api/jobs/${encodeURIComponent(id)}/resume/plan`, request);
    }

    async resumeRecord(): Promise<ResumeRecord | null> {
        const response = await this.request<{ resume: ResumeRecord | null }>("GET", "/api/resume");
        return response.resume ?? null;
    }

    async log(lines = 200, file: LogFile = "spinny"): Promise<string[]> {
        const response = await this.request<LogResponse>(
            "GET",
            `/api/log?lines=${encodeURIComponent(String(lines))}&file=${encodeURIComponent(file)}`,
        );
        return response.lines ?? [];
    }

    async runHold(): Promise<void> {
        await this.request("POST", "/api/run/hold");
    }

    async runResume(): Promise<void> {
        await this.request("POST", "/api/run/resume");
    }

    async runStop(): Promise<void> {
        await this.request("POST", "/api/run/stop");
    }

    async run(): Promise<Progress | null> {
        const data = await this.request<Progress | null | Record<string, never>>("GET", "/api/run");
        if (!data || typeof data !== "object" || !("state" in data)) {
            return null;
        }
        return data as Progress;
    }

    heightMap(): Promise<HeightMapState> {
        return this.request<HeightMapState>("GET", "/api/heightmap");
    }

    probe(request: ProbeRequest): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/probe", request);
    }

    probeEstimate(request: ProbeRequest): Promise<ProbeEstimate> {
        return this.request<ProbeEstimate>("POST", "/api/heightmap/estimate", request);
    }

    probeHere(request: TouchRequest): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/touch", request);
    }

    planTouch(request: TouchRequest): Promise<TouchPlan> {
        return this.request<TouchPlan>("POST", "/api/heightmap/touch/plan", request);
    }

    probeStop(): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/stop");
    }

    focus(offset: number | null): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/focus", offset === null ? {} : { offset });
    }

    keepFocus(): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/focus/keep");
    }

    probeSettings(patch: Partial<ProbeSettings>): Promise<HeightMapState> {
        return this.request<HeightMapState>("PUT", "/api/heightmap/settings", patch);
    }

    putHeightMap(map: HeightMap): Promise<HeightMapState> {
        return this.request<HeightMapState>("PUT", "/api/heightmap", map);
    }

    clearHeightMap(): Promise<HeightMapState> {
        return this.request<HeightMapState>("DELETE", "/api/heightmap");
    }

    probePads(request: PadProbeRequest): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/pads", request);
    }

    planPads(request: PadProbeRequest): Promise<PadProbePlan> {
        return this.request<PadProbePlan>("POST", "/api/heightmap/pads/plan", request);
    }

    cameras(): Promise<CamerasResponse> {
        return this.request<CamerasResponse>("GET", "/api/cameras");
    }

    camera(): Promise<CameraState> {
        return this.request<CameraState>("GET", "/api/camera");
    }

    cameraSettings(patch: Partial<CameraSettings>): Promise<CameraState> {
        return this.request<CameraState>("PUT", "/api/camera/settings", patch);
    }

    cameraStart(): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/start");
    }

    cameraStop(): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/stop");
    }

    /** A camera's picture at `path`, at `frameWidth(width)`, with the marks drawn on it when `overlay`. */
    private frameUrl(path: string, width: number, overlay: boolean): string {
        // The backend sends every picture with no-store; the time on the
        // query keeps a browser that ignores it from showing an old one.
        return `${this.base}${path}?width=${frameWidth(width)}&overlay=${overlay ? 1 : 0}&t=${Date.now()}`;
    }

    cameraFrameUrl(width: number, overlay: boolean): string {
        return this.frameUrl("/api/camera/frame.jpg", width, overlay);
    }

    cameraPose(): Promise<CameraPose> {
        return this.request<CameraPose>("GET", "/api/camera/pose");
    }

    cameraBoard(jobId: string | null): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/board", { job: jobId });
    }

    cameraMark(request: MarkRequest): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/mark", request);
    }

    cameraFind(step: number): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/find", { step });
    }

    cameraAbort(): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/abort");
    }

    cameraSearch(box: [number, number, number, number] | null): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/search", box ? { box } : {});
    }

    cameraCorner(jobId: string, corner: CornerName): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/corner", { job: jobId, corner });
    }

    cameraCornersClear(): Promise<CameraState> {
        return this.request<CameraState>("DELETE", "/api/camera/corners");
    }

    cameraEdgeCorner(jobId: string, corner: CornerName): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/edge-corner", { job: jobId, corner });
    }

    cameraRefine(jobId: string, use: RefineUse, count: number): Promise<CameraState> {
        return this.request<CameraState>("POST", "/api/camera/refine", { job: jobId, use, count });
    }

    cameraLens(camera: ControlledCamera, polarity: SpotPolarity, pitch: number): Promise<{ camera: ControlledCamera; measured: LensMeasured | null }> {
        return this.request("POST", "/api/cameras/lens", { camera, polarity, pitch });
    }

    cameraLensClear(camera: ControlledCamera): Promise<{ camera: ControlledCamera; measured: null }> {
        return this.request("DELETE", `/api/cameras/lens?camera=${encodeURIComponent(camera)}`);
    }

    cameraColor(camera: ControlledCamera, item: ColorItem, point: [number, number] | null): Promise<{ camera: ControlledCamera; item: ColorItem; rgb: [number, number, number] | null }> {
        return this.request("POST", "/api/cameras/color", point === null ? { camera, item, clear: true } : { camera, item, x: point[0], y: point[1] });
    }

    cameraControls(camera: ControlledCamera): Promise<CameraControls> {
        return this.request<CameraControls>("GET", `/api/cameras/controls?camera=${encodeURIComponent(camera)}`);
    }

    setCameraControls(camera: ControlledCamera, values: Record<string, number | null>): Promise<CameraControls> {
        return this.request<CameraControls>("PUT", "/api/cameras/controls", { camera, values });
    }

    align(): Promise<AlignState> {
        return this.request<AlignState>("GET", "/api/align");
    }

    alignMark(request: AlignMarkRequest): Promise<AlignState> {
        return this.request<AlignState>("POST", "/api/align/mark", request);
    }

    alignCapture(jobId: string): Promise<AlignState> {
        return this.request<AlignState>("POST", "/api/align/capture", { job: jobId });
    }

    alignDeleteMark(index: number): Promise<AlignState> {
        return this.request<AlignState>("DELETE", `/api/align/marks/${encodeURIComponent(String(index))}`);
    }

    alignClear(): Promise<AlignState> {
        return this.request<AlignState>("DELETE", "/api/align");
    }

    alignFit(jobId: string): Promise<AlignFit> {
        return this.request<AlignFit>("POST", "/api/align/fit", { job: jobId });
    }

    alignApply(jobId: string): Promise<{ job: Job; fit: AlignFit }> {
        return this.request<{ job: Job; fit: AlignFit }>("POST", "/api/align/apply", { job: jobId });
    }

    pnp(): Promise<PnpState> {
        return this.request<PnpState>("GET", "/api/pnp");
    }

    pnpSettings(patch: Partial<PnpSettings> & { clear?: ("position" | "height")[] }): Promise<PnpState> {
        return this.request<PnpState>("PUT", "/api/pnp/settings", patch);
    }

    pnpStart(): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/start");
    }

    pnpStop(): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/stop");
    }

    pnpFrameUrl(width: number, overlay: boolean): string {
        return this.frameUrl("/api/pnp/frame.jpg", width, overlay);
    }

    pnpNozzle(step: number): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/nozzle", { step });
    }

    pnpPart(): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/part");
    }

    pnpLook(spot: "nozzle" | "part"): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/look", { spot });
    }

    pnpAbort(): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/abort");
    }

    async pnpGoto(request: PnpGotoRequest): Promise<void> {
        await this.request("POST", "/api/pnp/goto", request);
    }

    components(jobId: string): Promise<ComponentsResponse> {
        return this.request<ComponentsResponse>("GET", `/api/jobs/${encodeURIComponent(jobId)}/components`);
    }

    partsFilter(): Promise<PartsFilterState> {
        return this.request<PartsFilterState>("GET", "/api/pnp/parts-filter");
    }

    setPartsFilter(filter: PartsFilter): Promise<PartsFilterState> {
        return this.request<PartsFilterState>("PUT", "/api/pnp/parts-filter", filter);
    }

    placingState(): Promise<PlacingState> {
        return this.request<PlacingState>("GET", "/api/pnp/placing");
    }

    placingAngle(patch: { angle?: number; clear_angle?: boolean }): Promise<PlacingState> {
        return this.request<PlacingState>("PUT", "/api/pnp/placing", patch);
    }

    pnpPark(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/park");
    }

    pnpOverCamera(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/over-camera");
    }

    pnpSwap(to: "nozzle" | "camera"): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/swap", { to });
    }

    pnpCameraPlace(request: { position?: [number, number]; here?: boolean; clear?: boolean }): Promise<PlacingState> {
        return this.request<PlacingState>("PUT", "/api/pnp/camera", request);
    }

    pnpLight(on: boolean): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/light", { on });
    }

    pnpVacuum(request: { on?: boolean; read?: boolean }): Promise<PlacingState & { reply: string[] }> {
        return this.request<PlacingState & { reply: string[] }>("POST", "/api/pnp/vacuum", request);
    }

    pnpBoardsReset(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/boards/reset");
    }

    pnpBusScan(): Promise<PlacingState & { feeders: BusFeeder[] }> {
        return this.request<PlacingState & { feeders: BusFeeder[] }>("POST", "/api/pnp/bus/scan");
    }

    pnpBusFeed(feeder: string): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/bus/feed", { feeder });
    }

    pnpReference(request: { job: string; ref: string; at?: [number, number]; camera?: boolean }): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/references", request);
    }

    pnpDropReferences(job: string, ref?: string): Promise<PlacingState> {
        const query = `job=${encodeURIComponent(job)}${ref !== undefined ? `&ref=${encodeURIComponent(ref)}` : ""}`;
        return this.request<PlacingState>("DELETE", `/api/pnp/references?${query}`);
    }

    pnpPlan(job: string, refs?: string[]): Promise<PlacingPlan> {
        return this.request<PlacingPlan>("POST", "/api/pnp/plan", refs !== undefined ? { job, refs } : { job });
    }

    pnpProgramUrl(job: string, refs?: string[]): string {
        const query = `job=${encodeURIComponent(job)}${refs !== undefined ? `&refs=${encodeURIComponent(refs.join(","))}` : ""}`;
        return `${this.base}/api/pnp/program.gcode?${query}`;
    }

    pnpRun(job: string, refs?: string[], fiducials = false): Promise<PlacingPlan & PlacingState> {
        return this.request<PlacingPlan & PlacingState>("POST", "/api/pnp/run", { job, ...(refs !== undefined ? { refs } : {}), fiducials });
    }

    pnpRunStop(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/run/stop");
    }

    pnpResetFeeders(feeder?: string): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/feeders/reset", feeder !== undefined ? { feeder } : {});
    }

    pnpRunout(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/runout");
    }

    pnpFiducials(job: string): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/fiducials", { job });
    }

    topSettings(patch: Partial<TopSettings> & { clear?: ("mark_at" | "offset")[] }): Promise<PlacingState> {
        return this.request<PlacingState>("PUT", "/api/pnp/top", patch);
    }

    topStart(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/start");
    }

    topStop(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/stop");
    }

    topFrameUrl(width: number, overlay: boolean): string {
        return this.frameUrl("/api/pnp/top/frame.jpg", width, overlay);
    }

    topMark(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/mark");
    }

    topOffset(step: number): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/offset", { step });
    }

    topHome(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/home");
    }

    topAbort(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/abort");
    }

    topLook(): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/look");
    }

    topBoard(jobId: string | null): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/board", { job: jobId });
    }

    topSearch(box: [number, number, number, number] | null): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/search", box ? { box } : {});
    }

    topPlace(jobId: string): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/place", { job: jobId });
    }

    topCorner(jobId: string, corner: CornerName): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/corner", { job: jobId, corner });
    }

    topCornersClear(): Promise<PlacingState> {
        return this.request<PlacingState>("DELETE", "/api/pnp/top/corners");
    }

    topEdgeCorner(jobId: string, corner: CornerName): Promise<PlacingState> {
        return this.request<PlacingState>("POST", "/api/pnp/top/edge-corner", { job: jobId, corner });
    }

    autoSettings(): Promise<AutoSettings> {
        return this.request<AutoSettings>("GET", "/api/auto/settings");
    }

    setAutoSettings(patch: AutoSettingsUpdate): Promise<AutoSettings> {
        return this.request<AutoSettings>("PUT", "/api/auto/settings", patch);
    }

    autoConversation(): Promise<AutoConversation> {
        return this.request<AutoConversation>("GET", "/api/auto/conversation");
    }

    autoSend(text: string): Promise<AutoConversation> {
        return this.request<AutoConversation>("POST", "/api/auto/messages", { text });
    }

    autoStop(): Promise<AutoConversation> {
        return this.request<AutoConversation>("POST", "/api/auto/stop");
    }

    autoClear(): Promise<AutoConversation> {
        return this.request<AutoConversation>("DELETE", "/api/auto/conversation");
    }
}
