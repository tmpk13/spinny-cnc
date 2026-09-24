// Typed wrappers over the backend routes.

import type {
    CenterRequest,
    CenterResponse,
    CommandResponse,
    Compensate,
    GotoRequest,
    Grid,
    HeightMap,
    HeightMapState,
    Job,
    JobPatch,
    JobSummary,
    JobsResponse,
    JogRequest,
    Mode,
    Port,
    PortsResponse,
    PositionRequest,
    ProbeSettings,
    Progress,
    RealtimeAction,
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

export interface Api {
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
    realtime(action: RealtimeAction): Promise<void>;
    command(line: string): Promise<string[]>;

    laser(power: number, ms: number): Promise<void>;
    laserOff(): Promise<void>;
    mode(mode: Mode): Promise<void>;

    settings(): Promise<SettingsResponse>;
    updateSettings(patch: SettingsUpdate): Promise<void>;
    saveSettings(): Promise<void>;

    uploadJob(file: File, options: UploadOptions): Promise<Job>;
    /** Builds and stores the centering test burn. */
    centerJob(request: CenterRequest): Promise<CenterResponse>;
    jobs(): Promise<JobSummary[]>;
    job(id: string): Promise<Job>;
    patchJob(id: string, patch: JobPatch): Promise<void>;
    deleteJob(id: string): Promise<void>;
    /** `compensate` follows the height map; left out, the run does not. */
    runJob(id: string, compensate?: Compensate): Promise<void>;
    runHold(): Promise<void>;
    runResume(): Promise<void>;
    runStop(): Promise<void>;
    run(): Promise<Progress | null>;

    heightMap(): Promise<HeightMapState>;
    /** Probes the grid, replacing the map; the head's height now is the travel height. */
    probe(grid: Grid): Promise<HeightMapState>;
    probeStop(): Promise<HeightMapState>;
    /** Sets the focus offset; null takes it from the head over the board now. */
    focus(offset: number | null): Promise<HeightMapState>;
    probeSettings(patch: Partial<ProbeSettings>): Promise<HeightMapState>;
    putHeightMap(map: HeightMap): Promise<HeightMapState>;
    clearHeightMap(): Promise<HeightMapState>;
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

    async deleteJob(id: string): Promise<void> {
        await this.request("DELETE", `/api/jobs/${encodeURIComponent(id)}`);
    }

    async runJob(id: string, compensate: Compensate = "off"): Promise<void> {
        await this.request("POST", `/api/jobs/${encodeURIComponent(id)}/run`, { compensate });
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

    probe(grid: Grid): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/probe", grid);
    }

    probeStop(): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/stop");
    }

    focus(offset: number | null): Promise<HeightMapState> {
        return this.request<HeightMapState>("POST", "/api/heightmap/focus", offset === null ? {} : { offset });
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
}
