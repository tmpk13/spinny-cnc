// Typed wrappers over the backend routes.

import type {
    AlignFit,
    CamLogEntry,
    CamLogState,
    LoggedCamera,
    AlignMarkRequest,
    AlignState,
    CamerasResponse,
    CameraSettings,
    CameraState,
    CamGcodeResponse,
    CamJobResponse,
    CamPath,
    CamProfileResponse,
    CamProfilesResponse,
    CamValue,
    CalibrateRequest,
    CalibrateResponse,
    CenterRequest,
    CenterResponse,
    CommandResponse,
    Compensate,
    GotoRequest,
    HeightMap,
    HeightMapState,
    Job,
    JobPatch,
    JobSummary,
    JobsResponse,
    JogRequest,
    LogFile,
    LogResponse,
    MachinesResponse,
    MarkRequest,
    Mode,
    PadProbePlan,
    PadProbeRequest,
    Port,
    PortsResponse,
    PositionRequest,
    ProbeEstimate,
    ProbeRequest,
    ProbeSettings,
    Progress,
    RealtimeAction,
    ResumePlan,
    ResumeRecord,
    ResumeRequest,
    TouchPlan,
    TouchRequest,
    SettingsResponse,
    SettingsUpdate,
    Snapshot,
    UploadOptions,
} from "./types.ts";

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

import type { Marker, MarkersResponse, MillJobRequest, MillResponse } from "./types.ts";
import type {
    CameraPose,
    ComponentsResponse,
    DeviceCheck,
    DeviceFile,
    DevicePlan,
    DeviceState,
    DevicesResponse,
    MachineCheck,
    MachineFromBoard,
    MachineResponse,
    PnpGotoRequest,
    PnpSettings,
    PnpState,
} from "./types.ts";

export interface Api {
    /** Plot page operations as a job, not stored, to be seen before it is made; with `job`, placed where that job is. */
    planMill(body: MillJobRequest): Promise<MillResponse>;
    /** Plot page operations made into a stored job, or with `job` put in that Plot page job's place. */
    makeMill(body: MillJobRequest): Promise<MillResponse>;
    /** The markers, kept by the backend for every page. */
    markers(): Promise<Marker[]>;
    /** Puts the whole list of markers in place of the one kept; answers it as kept. */
    setMarkers(markers: Marker[]): Promise<Marker[]>;
    ports(): Promise<Port[]>;
    connect(url: string): Promise<Snapshot>;
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

    /** The CAM profiles in cam/, and the files that could not be read. */
    /** A machine file as written, with what it reads as or why it does not. */
    machineFile(id: string): Promise<MachineResponse>;
    /** Writes a text as the file once it reads as a machine; refused with what is wrong otherwise. */
    saveMachineFile(id: string, text: string): Promise<MachineResponse>;
    /** What a text would read as, and what is wrong with it, without writing it. */
    checkMachineFile(id: string, text: string): Promise<MachineCheck>;
    /** The text with the connected board's values written into it, not saved. */
    machineFromBoard(id: string, text: string): Promise<MachineFromBoard>;
    deleteMachineFile(id: string): Promise<void>;
    camProfiles(): Promise<CamProfilesResponse>;
    camProfile(id: string): Promise<CamProfileResponse>;
    /** Writes the text as the profile once it reads as one; creates the profile when it is new. */
    saveCamProfile(id: string, text: string): Promise<CamProfileResponse>;
    /** Changes one value in the file and keeps the rest, comments included. */
    patchCamProfile(id: string, path: CamPath, value: CamValue): Promise<CamProfileResponse>;
    deleteCamProfile(id: string): Promise<void>;
    /** The design files (a board with its outline and drill file, an SVG, gcode or a job) through the profile into a stored job. */
    camJob(id: string, files: File[], name?: string): Promise<CamJobResponse>;
    /** A stored job as gcode for the profile's controller. */
    camGcode(id: string, jobId: string): Promise<CamGcodeResponse>;

    uploadJob(file: File, options: UploadOptions): Promise<Job>;
    /** Builds and stores the centering test burn. */
    centerJob(request: CenterRequest): Promise<CenterResponse>;
    /** A calibration test made into a job: the material test on a laser, the depth test on a mill. */
    calibrateJob(request: CalibrateRequest): Promise<CalibrateResponse>;
    jobs(): Promise<JobSummary[]>;
    job(id: string): Promise<Job>;
    patchJob(id: string, patch: JobPatch): Promise<void>;
    /** The job made again for a bit or a spot `width` mm across; a drawing takes the width with its paths as they are. */
    setJobWidth(id: string, width: number): Promise<Job>;
    /** The job made what `job` says, its id kept, as the JSON editor or a regrouping of paths sends it; answers the job as kept. */
    replaceJob(id: string, job: Job): Promise<Job>;
    /** A stencil made again with every opening shrunk by `margin` mm. */
    setJobMargin(id: string, margin: number): Promise<Job>;
    deleteJob(id: string): Promise<void>;
    /** Removes every job but the one running; answers their ids. */
    deleteAllJobs(): Promise<string[]>;
    /** `compensate` follows the height map; left out, the run does not. */
    runJob(id: string, compensate?: Compensate): Promise<void>;
    /** Picks the job up at a line: the lines before it count as done, the head is brought to where it begins. */
    resumeJob(id: string, request: ResumeRequest): Promise<Progress>;
    /** What `resumeJob` would do, without moving anything. */
    planResume(id: string, request: ResumeRequest): Promise<ResumePlan>;
    /** The last run's record; null when none ran. */
    resumeRecord(): Promise<ResumeRecord | null>;
    forgetResume(): Promise<void>;
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

    /** The cameras attached, for the camera's or the up camera's device to be picked from. */
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
    cameraPose(): Promise<CameraPose>;
    /** pcbv looks for the job's board in the pictures; null unloads it. */
    cameraBoard(jobId: string | null): Promise<CameraState>;
    /** Makes a mark with the tool where it stands, or with `here` only records the tool's point as the mark. */
    cameraMark(request: MarkRequest): Promise<CameraState>;
    /** Finds the mark in the picture and centers the picture on it, measuring the offset, the scale and the roll; on its own thread. */
    cameraFind(step: number): Promise<CameraState>;
    cameraAbort(): Promise<CameraState>;

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
    /** The nozzle over a part's place at the travel height. */
    pnpGoto(request: PnpGotoRequest): Promise<void>;
    /** The parts of a board job; none for a job that keeps no board file. */
    components(jobId: string): Promise<ComponentsResponse>;

    /** The G-code device profiles in `pnp/`, and the ones that do not read. */
    devices(): Promise<DevicesResponse>;
    deviceFile(id: string): Promise<DeviceFile>;
    saveDeviceFile(id: string, text: string): Promise<DeviceFile>;
    checkDeviceFile(id: string, text: string): Promise<DeviceCheck>;
    /** The G-code device: the profile picked, the board's references, the feeders' counts, the link and a program being sent. */
    deviceState(): Promise<DeviceState>;
    deviceSelect(patch: { profile?: string; angle?: number; clear_angle?: boolean }): Promise<DeviceState>;
    deviceConnect(): Promise<DeviceState>;
    deviceDisconnect(): Promise<DeviceState>;
    deviceCommand(line: string): Promise<DeviceState & { reply: string[] }>;
    deviceHome(): Promise<DeviceState>;
    devicePosition(): Promise<DeviceState>;
    /** A reference for a part: where it is on the device, read off it when `at` is left out. */
    deviceReference(request: { job: string; ref: string; at?: [number, number] }): Promise<DeviceState>;
    deviceDropReferences(job: string, ref?: string): Promise<DeviceState>;
    devicePlan(job: string, refs?: string[]): Promise<DevicePlan>;
    /** Where the program's G-code downloads from. */
    deviceProgramUrl(job: string, refs?: string[]): string;
    deviceRun(job: string, refs?: string[]): Promise<DevicePlan & DeviceState>;
    deviceStop(): Promise<DeviceState>;
    deviceGoto(job: string, ref: string): Promise<DeviceState>;
    /** Counts a feeder (or every one) from its first part again. */
    deviceResetFeeders(feeder?: string): Promise<DeviceState>;
    /** Centers the device's nozzle over the up camera, measuring where the camera is on the device; `step` 0 keeps the scale. */
    deviceNozzle(step: number): Promise<DeviceState>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
            const reason = error instanceof Error ? error.message : String(error);
            throw new ApiError(0, `backend unreachable: ${reason}`);
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

    connect(url: string): Promise<Snapshot> {
        return this.request<Snapshot>("POST", "/api/connect", { url });
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

    async markers(): Promise<Marker[]> {
        const response = await this.request<MarkersResponse>("GET", "/api/markers");
        return response.markers ?? [];
    }

    async setMarkers(markers: Marker[]): Promise<Marker[]> {
        const response = await this.request<MarkersResponse>("PUT", "/api/markers", { markers });
        return response.markers ?? [];
    }

    async deleteAllJobs(): Promise<string[]> {
        const response = await this.request<{ deleted: string[] }>("DELETE", "/api/jobs");
        return response.deleted ?? [];
    }

    async runJob(id: string, compensate: Compensate = "off"): Promise<void> {
        await this.request("POST", `/api/jobs/${encodeURIComponent(id)}/run`, { compensate });
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

    async forgetResume(): Promise<void> {
        await this.request("DELETE", "/api/resume");
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

    cameraFrameUrl(width: number, overlay: boolean): string {
        // The backend sends every picture with no-store; the time on the
        // query keeps a browser that ignores it from showing an old one.
        const size = Math.max(160, Math.min(4096, Math.round(width)));
        return `${this.base}/api/camera/frame.jpg?width=${size}&overlay=${overlay ? 1 : 0}&t=${Date.now()}`;
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
        const size = Math.max(160, Math.min(4096, Math.round(width)));
        return `${this.base}/api/pnp/frame.jpg?width=${size}&overlay=${overlay ? 1 : 0}&t=${Date.now()}`;
    }

    pnpNozzle(step: number): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/nozzle", { step });
    }

    pnpPart(): Promise<PnpState> {
        return this.request<PnpState>("POST", "/api/pnp/part");
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

    devices(): Promise<DevicesResponse> {
        return this.request<DevicesResponse>("GET", "/api/pnp/devices");
    }

    deviceFile(id: string): Promise<DeviceFile> {
        return this.request<DeviceFile>("GET", `/api/pnp/devices/${encodeURIComponent(id)}`);
    }

    saveDeviceFile(id: string, text: string): Promise<DeviceFile> {
        return this.request<DeviceFile>("PUT", `/api/pnp/devices/${encodeURIComponent(id)}`, { text });
    }

    checkDeviceFile(id: string, text: string): Promise<DeviceCheck> {
        return this.request<DeviceCheck>("POST", `/api/pnp/devices/${encodeURIComponent(id)}/check`, { text });
    }

    deviceState(): Promise<DeviceState> {
        return this.request<DeviceState>("GET", "/api/pnp/device");
    }

    deviceSelect(patch: { profile?: string; angle?: number; clear_angle?: boolean }): Promise<DeviceState> {
        return this.request<DeviceState>("PUT", "/api/pnp/device", patch);
    }

    deviceConnect(): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/connect");
    }

    deviceDisconnect(): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/disconnect");
    }

    deviceCommand(line: string): Promise<DeviceState & { reply: string[] }> {
        return this.request<DeviceState & { reply: string[] }>("POST", "/api/pnp/device/command", { line });
    }

    deviceHome(): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/home");
    }

    devicePosition(): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/position");
    }

    deviceReference(request: { job: string; ref: string; at?: [number, number] }): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/references", request);
    }

    deviceDropReferences(job: string, ref?: string): Promise<DeviceState> {
        const query = `job=${encodeURIComponent(job)}${ref !== undefined ? `&ref=${encodeURIComponent(ref)}` : ""}`;
        return this.request<DeviceState>("DELETE", `/api/pnp/device/references?${query}`);
    }

    devicePlan(job: string, refs?: string[]): Promise<DevicePlan> {
        return this.request<DevicePlan>("POST", "/api/pnp/device/plan", refs !== undefined ? { job, refs } : { job });
    }

    deviceProgramUrl(job: string, refs?: string[]): string {
        const query = `job=${encodeURIComponent(job)}${refs !== undefined ? `&refs=${encodeURIComponent(refs.join(","))}` : ""}`;
        return `${this.base}/api/pnp/device/program.gcode?${query}`;
    }

    deviceRun(job: string, refs?: string[]): Promise<DevicePlan & DeviceState> {
        return this.request<DevicePlan & DeviceState>("POST", "/api/pnp/device/run", refs !== undefined ? { job, refs } : { job });
    }

    deviceStop(): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/stop");
    }

    deviceGoto(job: string, ref: string): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/goto", { job, ref });
    }

    deviceResetFeeders(feeder?: string): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/feeders/reset", feeder !== undefined ? { feeder } : {});
    }

    deviceNozzle(step: number): Promise<DeviceState> {
        return this.request<DeviceState>("POST", "/api/pnp/device/nozzle", { step });
    }
}
