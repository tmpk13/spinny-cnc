import { describe, expect, test } from "bun:test";

import { ApiError } from "../src/api.ts";
import { DEG } from "../src/kinematics.ts";
import { MockBackend, MockMachine, formatMove, statusLine } from "../src/mock.ts";
import type { WsEvent } from "../src/types.ts";

function stepped(machine: MockMachine, seconds: number, dt = 0.01): void {
    let left = seconds;
    while (left > 1e-12) {
        const step = Math.min(dt, left);
        machine.advance(step);
        left -= step;
    }
}

describe("mock machine motion", () => {
    test("a radial jog runs at jog_r", () => {
        const machine = new MockMachine();
        machine.jog(10, 0, null);
        expect(machine.state).toBe("Jog");
        // 10 mm at 300 mm/min is two seconds.
        stepped(machine, 1);
        expect(machine.joint.r).toBeCloseTo(5, 6);
        expect(machine.state).toBe("Jog");
        stepped(machine, 1);
        expect(machine.joint.r).toBeCloseTo(10, 6);
        machine.advance(0.01);
        expect(machine.state).toBe("Idle");
        expect(machine.enabled).toBe(true);
    });

    test("a turn alone moves only the table at jog_a", () => {
        const machine = new MockMachine();
        machine.setPosition({ r: 10 });
        machine.jog(0, 90, null);
        stepped(machine, 90 / 200 * 60);
        expect(machine.joint.a).toBeCloseTo(90, 6);
        expect(machine.joint.r).toBeCloseTo(10, 9);
    });

    test("a rapid has both axes arrive together", () => {
        const machine = new MockMachine();
        machine.go(50, 180);
        const seconds = Math.max(50 / 560, 180 / 400) * 60;
        stepped(machine, seconds / 2);
        expect(machine.joint.r).toBeCloseTo(25, 6);
        expect(machine.joint.a).toBeCloseTo(90, 6);
        expect(machine.state).toBe("Run");
        stepped(machine, seconds / 2 + 0.01);
        expect(machine.state).toBe("Idle");
    });

    test("a cut is held to the table rate and dyn mode scales the power", () => {
        const machine = new MockMachine();
        machine.setPosition({ r: 10 });
        machine.cut(10, 90, 400, 500);
        stepped(machine, 1);
        const cap = 10 * 400 * DEG;
        expect(machine.rate).toBeCloseTo(cap, 3);
        expect(machine.laser).toBeCloseTo((500 * cap / 400) / 1000 * 1000, 3);
        expect(machine.state).toBe("Run");
        machine.mode = "const";
        stepped(machine, 0.5);
        expect(machine.laser).toBeCloseTo(500, 6);
        stepped(machine, 90 / 400 * 60);
        expect(machine.state).toBe("Idle");
        expect(machine.laser).toBe(0);
        expect(machine.joint.a).toBeCloseTo(90, 6);
    });

    test("a cut with the table fast enough runs at the feed", () => {
        const machine = new MockMachine();
        // At 60 mm the table's 400 deg/min gives 419 mm/min, over the feed.
        machine.setPosition({ r: 60 });
        machine.cut(60, 10, 400, 500);
        stepped(machine, 0.2);
        expect(machine.rate).toBeCloseTo(400, 6);
        expect(machine.laser).toBeCloseTo(500, 6);
    });

    test("a turn on the axis runs with the beam off in either mode", () => {
        const machine = new MockMachine();
        machine.mode = "const";
        machine.setPosition({ r: 5 });
        machine.cut(0, 0, 400, 500);
        machine.cut(0, 180, 400, 500);
        machine.cut(5, 180, 400, 500);
        // The move in: 5 mm at 400 mm/min.
        stepped(machine, 0.4);
        expect(machine.laser).toBeCloseTo(500, 6);
        stepped(machine, 0.4);
        // The turn: half a turn at a_rate, 27 s, with nothing under the beam.
        expect(machine.joint.r).toBeCloseTo(0, 6);
        expect(machine.joint.a).toBeGreaterThan(0);
        expect(machine.laser).toBe(0);
        stepped(machine, 27);
        expect(machine.joint.r).toBeGreaterThan(0);
        expect(machine.laser).toBeCloseTo(500, 6);
    });

    test("hold stops, resume continues, reset while moving alarms", () => {
        const machine = new MockMachine();
        machine.jog(10, 0, null);
        stepped(machine, 0.3);
        machine.hold();
        expect(machine.state).toBe("Hold");
        const r = machine.joint.r;
        stepped(machine, 1);
        expect(machine.joint.r).toBe(r);
        machine.resume();
        expect(machine.state).toBe("Jog");
        stepped(machine, 0.2);
        expect(machine.joint.r).toBeCloseTo(2.5, 6);
        machine.reset();
        expect(machine.state).toBe("Alarm");
        expect(machine.alarm).toBe(1);
        expect(() => machine.jog(1, 0, null)).toThrow();
        machine.unlock();
        expect(machine.state).toBe("Idle");
    });

    test("a reset from a hold loses no steps and raises no alarm", () => {
        const machine = new MockMachine();
        machine.cut(10, 0, 300, 500);
        stepped(machine, 0.5);
        machine.hold();
        expect(machine.state).toBe("Hold");
        machine.mode = "const";
        machine.reset();
        expect(machine.state).toBe("Idle");
        expect(machine.alarm).toBeNull();
        expect(machine.queue.length).toBe(0);
        expect(machine.active).toBeNull();
        expect(machine.joint.r).toBeCloseTo(2.5, 6);
        // The modal words go with it.
        expect(machine.status().mode).toBe("dyn");
        expect(machine.feed).toBeNull();
        expect(machine.power).toBe(0);
    });

    test("jog cancel drops the rest of the jog", () => {
        const machine = new MockMachine();
        machine.jog(10, 0, null);
        machine.jog(10, 0, null);
        stepped(machine, 0.5);
        machine.jogCancel();
        expect(machine.state).toBe("Idle");
        expect(machine.queue.length).toBe(0);
        expect(machine.joint.r).toBeCloseTo(2.5, 6);
    });

    test("limits: the far side of the axis is reachable and r_max holds on both sides", () => {
        const machine = new MockMachine();
        machine.jog(-1, 0, null);
        expect(machine.endpoint().r).toBe(-1);
        stepped(machine, 0.3);
        expect(machine.joint.r).toBeCloseTo(-1, 6);
        expect(machine.status().board.x).toBeCloseTo(-1, 6);
        machine.reset();
        machine.unlock();
        machine.setPosition({ r: -2 });
        expect(machine.joint.r).toBe(-2);
        machine.setSetting("r_max", 20);
        expect(() => machine.go(25, 0)).toThrow();
        expect(() => machine.go(-25, 0)).toThrow();
        expect(() => machine.setPosition({ r: -21 })).toThrow();
        machine.go(20, 0);
        machine.go(-20, 0);
        expect(machine.queue.length).toBe(2);
    });

    test("a feed under the minimum and a negative power are refused", () => {
        const machine = new MockMachine();
        expect(() => machine.cut(5, 0, 0, 100)).toThrow("error:4");
        expect(() => machine.cut(5, 0, 0.0005, 100)).toThrow("error:4");
        expect(() => machine.cut(5, 0, Number.NaN, 100)).toThrow("error:4");
        expect(() => machine.cut(5, 0, 100, -1)).toThrow("error:4");
        expect(() => machine.jog(1, 0, 0)).toThrow("error:4");
        expect(() => machine.slideJog(0.1, 0)).toThrow("error:4");
        expect(machine.queue.length).toBe(0);
        machine.cut(5, 0, 0.001, 0);
        expect(machine.queue.length).toBe(1);
    });

    test("constant beam times out", () => {
        const machine = new MockMachine();
        machine.beam(250, 500);
        expect(machine.laser).toBe(250);
        machine.advance(0.3);
        expect(machine.laser).toBe(250);
        machine.advance(0.3);
        expect(machine.laser).toBe(0);
        machine.beam(100, 1000);
        machine.beamOff();
        expect(machine.laser).toBe(0);
    });

    test("laser test: S over s_max is full duty, T over the maximum is refused, hold closes it", () => {
        const machine = new MockMachine();
        machine.beam(2000, 60000);
        expect(machine.laser).toBe(1000);
        expect(machine.state).toBe("Idle");
        machine.hold();
        expect(machine.laser).toBe(0);
        expect(machine.beamSeconds).toBe(0);
        expect(machine.state).toBe("Idle");
        machine.resume();
        expect(machine.laser).toBe(0);
        expect(() => machine.beam(100, 60001)).toThrow("error:4");
        expect(() => machine.beam(100, -1)).toThrow("error:4");
        expect(() => machine.beam(-1, 100)).toThrow("error:4");
        expect(machine.laser).toBe(0);
        machine.beam(100, 0);
        expect(machine.beamSeconds).toBeCloseTo(5, 9);
    });

    test("the cross slide runs at jog_z with nothing else moving", () => {
        const machine = new MockMachine();
        machine.slideJog(0.5, null);
        expect(machine.state).toBe("Jog");
        // 0.5 mm at jog_z, 120 mm/min, is a quarter second.
        stepped(machine, 0.125);
        expect(machine.z).toBeCloseTo(0.25, 6);
        expect(machine.joint).toEqual({ r: 0, a: 0 });
        expect(machine.laser).toBe(0);
        // Nothing joins it while it runs.
        expect(() => machine.jog(1, 0, null)).toThrow();
        stepped(machine, 0.125);
        machine.advance(0.01);
        expect(machine.z).toBeCloseTo(0.5, 9);
        expect(machine.state).toBe("Idle");
        expect(machine.enabled).toBe(true);
        // A feed is capped by z_rate; half a mm at 60 mm/min is half a second.
        machine.slideTo(0, 60);
        stepped(machine, 0.25);
        expect(machine.z).toBeCloseTo(0.25, 6);
        stepped(machine, 0.26);
        expect(machine.z).toBeCloseTo(0, 9);
        // And it is taken in Idle only.
        machine.jog(10, 0, null);
        expect(() => machine.slideJog(0.5, null)).toThrow();
    });

    test("a slide jog is cancelable and the status carries Z", () => {
        const machine = new MockMachine();
        machine.slideJog(1, null);
        stepped(machine, 0.25);
        machine.jogCancel();
        expect(machine.state).toBe("Idle");
        expect(machine.z).toBeCloseTo(0.5, 6);
        expect(statusLine(machine)).toBe("<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.500>");
        machine.setPosition({ z: 0 });
        expect(machine.z).toBe(0);
        expect(machine.status().joint).toEqual({ r: 0, a: 0, z: 0 });
    });

    test("a hold ends a slide move where it is, with nothing to resume", () => {
        const machine = new MockMachine();
        machine.slideJog(1, null);
        stepped(machine, 0.25);
        machine.hold();
        expect(machine.state).toBe("Idle");
        expect(machine.slide).toBeNull();
        stepped(machine, 1);
        expect(machine.z).toBeCloseTo(0.5, 6);
        machine.resume();
        expect(machine.state).toBe("Idle");
        stepped(machine, 1);
        expect(machine.z).toBeCloseTo(0.5, 6);
    });

    test("a reset during a slide move stops it and raises no alarm", () => {
        const machine = new MockMachine();
        machine.slideJog(1, null);
        stepped(machine, 0.25);
        machine.reset();
        expect(machine.state).toBe("Idle");
        expect(machine.alarm).toBeNull();
        expect(machine.slide).toBeNull();
        expect(machine.z).toBeCloseTo(0.5, 6);
        machine.slideJog(0.1, null);
        expect(machine.state).toBe("Jog");
    });

    test("queue accounting matches the status line", () => {
        const machine = new MockMachine();
        for (let i = 0; i < 40; i++) {
            machine.cut(1 + i, 0, 100, 10);
        }
        expect(machine.queueFree()).toEqual({ planner: 0, lines: 8 });
        expect(machine.waitingLines()).toBe(8);
        expect(statusLine(machine)).toBe("<Run|J:0.000,0.0000|V:0|L:0|Q:0,8|M:dyn|E:1|Z:0.000>");
        for (let i = 0; i < 8; i++) {
            machine.cut(50 + i, 0, 100, 10);
        }
        expect(machine.canQueue()).toBe(false);
        expect(() => machine.cut(99, 0, 100, 10)).toThrow();
    });

    test("move lines", () => {
        expect(formatMove({ kind: "cut", target: { r: 1, a: 2 }, feed: 300, power: 200, group: 0 })).toBe("cut R1.000 A2.0000 F300 S200");
        expect(formatMove({ kind: "go", target: { r: 0, a: 0 }, feed: null, power: 0, group: 0 })).toBe("go R0.000 A0.0000");
        expect(formatMove({ kind: "jog", target: { r: 1, a: 0 }, feed: null, power: 0, group: 0 })).toBe("jogto R1.000 A0.0000");
    });
});

function backendWithLog() {
    const backend = new MockBackend({ timers: false });
    const events: WsEvent[] = [];
    backend.onEvent((event) => events.push(event));
    const consoleLines = (): string[] => events.filter((e) => e.type === "console").map((e) => (e.type === "console" ? `${e.data.dir} ${e.data.text}` : ""));
    return { backend, events, consoleLines };
}

describe("mock backend", () => {
    test("refuses motion until connected, then answers like the backend", async () => {
        const { backend, consoleLines } = backendWithLog();
        await expect(backend.jog({ kind: "joint", dr: 1 })).rejects.toBeInstanceOf(ApiError);
        const ports = await backend.ports();
        expect(ports.length).toBeGreaterThan(0);
        const snapshot = await backend.connect(ports[0]!.url);
        expect(snapshot.connected).toBe(true);
        expect(snapshot.firmware?.lines).toBe(16);
        expect(consoleLines()[0]).toContain("rx [spinny v");
        await backend.jog({ kind: "joint", dr: 1 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog R1.000", "rx ok"]);
        await backend.jog({ kind: "joint", da: 90, feed: 100 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog A90.0000 F100", "rx ok"]);
    });

    test("a cross slide move is one line of its own", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.jog({ kind: "joint", dz: 0.05 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog Z0.050", "rx ok"]);
        backend.step(0.1);
        expect(backend.machine.z).toBeCloseTo(0.05, 9);
        expect(backend.snapshot().machine?.joint.z).toBeCloseTo(0.05, 9);
        await backend.goto({ kind: "joint", z: -0.2 });
        expect(consoleLines().slice(-2)).toEqual(["tx jogto Z-0.200", "rx ok"]);
        backend.step(0.5);
        expect(backend.machine.z).toBeCloseTo(-0.2, 9);
        // R and A still go together; Z is declared on a line of its own.
        await backend.setPosition({ r: 0, a: 0, z: 0 });
        expect(consoleLines().slice(-4)).toEqual(["tx set R0 A0", "rx ok", "tx set Z0", "rx ok"]);
        expect(backend.machine.z).toBe(0);
        // The command line refuses the axes on one line, as the firmware does.
        expect(await backend.command("jog Z1 R1")).toEqual(["error:2 bad word"]);
        expect(await backend.command("jog Z1")).toEqual(["ok"]);
        await backend.jogCancel();
        expect(backend.machine.state).toBe("Idle");
    });

    test("a board jog through the axis is radial in, turn, radial out", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.setPosition({ r: 10, a: 0 });
        await backend.jog({ kind: "board", dx: -20, dy: 0 });
        const tx = consoleLines().filter((line) => line.startsWith("tx jogto"));
        expect(tx).toEqual(["tx jogto R0.000 A0.0000", "tx jogto R0.000 A180.0000", "tx jogto R10.000 A180.0000"]);
        // 2 s in at jog_r, 54 s for the half turn at jog_a, 2 s out.
        for (let i = 0; i < 6000; i++) {
            backend.step(0.01);
        }
        expect(backend.machine.joint.r).toBeCloseTo(10, 6);
        expect(backend.machine.joint.a).toBeCloseTo(180, 6);
        expect(backend.machine.status().board.x).toBeCloseTo(-10, 6);
    });

    test("board goto keeps the chord tolerance and errors surface as ApiError", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.goto({ kind: "board", x: 20, y: 0 });
        expect(backend.machine.endpoint().r).toBeCloseTo(20, 9);
        await backend.goto({ kind: "board", x: 0, y: 20 });
        expect(backend.machine.queue.length).toBeGreaterThan(3);
        expect(backend.machine.canQueue()).toBe(false);
        backend.step(0.5);
        expect(backend.machine.canQueue()).toBe(false);
        await backend.jogCancel();
        expect(backend.machine.queue.length).toBe(0);
        backend.step(0.5);
        expect(backend.machine.queue.length).toBe(0);
        await backend.goto({ kind: "board", x: 0, y: 20 });
        backend.machine.reset();
        await expect(backend.goto({ kind: "joint", r: 1 })).rejects.toMatchObject({ status: 409 });
        await backend.unlock();
        await backend.goto({ kind: "joint", r: 1 });
    });

    test("realtime, command line and settings", async () => {
        const { backend, events } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("version")).toEqual([`[spinny v0.1.0-mock lines:16 blocks:32]`, "ok"]);
        expect(await backend.command("$r_rate")).toEqual(["r_rate=560", "ok"]);
        expect(await backend.command("$tmc")).toEqual([
            "[MSG:tmc R addr0 ifcnt=1 micro=256 status=0x00000000]",
            "[MSG:tmc A addr2 ifcnt=1 micro=256 status=0x00000000]",
            "[MSG:tmc Z addr1 ifcnt=1 micro=256 status=0x00000000]",
            "ok",
        ]);
        expect(await backend.command("$r_rate=800")).toEqual(["ok"]);
        expect(await backend.command("bogus")).toEqual(["error:1 unknown command"]);
        expect(await backend.command("cut R5 F100 S100")).toEqual(["ok"]);
        expect(backend.machine.state).toBe("Run");
        await backend.realtime("hold");
        expect(backend.machine.state).toBe("Hold");
        await backend.realtime("resume");
        expect(backend.machine.state).toBe("Run");
        await backend.realtime("reset");
        expect(backend.machine.state).toBe("Alarm");
        await backend.unlock();
        await backend.realtime("status");
        const settings = await backend.settings();
        expect(settings.values["r_rate"]).toBe(800);
        expect(settings.schema.length).toBe(Object.keys(settings.values).length);
        await backend.updateSettings({ values: { a_rate: 540 }, host: { tolerance: 0.01 } });
        expect(backend.tolerance).toBe(0.01);
        expect((await backend.settings()).values["a_rate"]).toBe(540);
        await expect(backend.updateSettings({ values: { nope: 1 } })).rejects.toBeInstanceOf(ApiError);
        await backend.saveSettings();
        expect(events.some((e) => e.type === "message" && e.data.text.includes("flash"))).toBe(true);
    });

    test("laser test and mode", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.laser(100, 200);
        expect(backend.machine.laser).toBe(100);
        backend.step(0.25);
        expect(backend.machine.laser).toBe(0);
        await backend.laser(100, 2000);
        await backend.laserOff();
        expect(backend.machine.laser).toBe(0);
        await backend.mode("const");
        expect(backend.machine.mode).toBe("const");
    });

    test("jobs: demo present, upload, patch, run to completion", async () => {
        const { backend, events } = backendWithLog();
        const list = await backend.jobs();
        expect(list.length).toBe(1);
        const demo = await backend.job(list[0]!.id);
        expect(demo.groups.length).toBe(4);
        // The outline's bottom edge runs 2 mm below the axis; its corners are 18 mm out.
        expect(demo.stats.min_radius).toBeCloseTo(2, 6);
        expect(list[0]!.groups[0]!.joints).toBe(0);

        const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10"><path d="M0 0 L10 0 L10 10"/></svg>'], "small.svg");
        const job = await backend.uploadJob(file, { power: 400, speed: 300, offset_y: 20 });
        expect((await backend.jobs()).length).toBe(2);
        await backend.patchJob(job.id, { groups: [{ index: 0, power: 100, enabled: true }], offset: { x: 0, y: 30 } });
        const patched = await backend.job(job.id);
        expect(patched.groups[0]!.power).toBe(100);
        expect(patched.offset.y).toBe(30);
        // Centered on upload, so the first point sits 5 mm above the offset.
        expect(patched.groups[0]!.paths[0]![0]![1]).toBeCloseTo(35, 6);

        await expect(backend.runJob(job.id)).rejects.toMatchObject({ status: 409 });
        await backend.connect("/dev/ttyACM0");
        await backend.runJob(job.id);
        const first = await backend.run();
        expect(first?.state).toBe("running");
        expect(first?.total).toBe(backend.movesFor(patched).length);
        expect(first!.sent).toBeGreaterThan(0);
        expect(first!.acked).toBeLessThanOrEqual(first!.sent);

        await backend.runHold();
        expect((await backend.run())?.state).toBe("hold");
        backend.step(0.5);
        await backend.runResume();

        let guard = 0;
        while (backend.run !== null && (await backend.run())?.state === "running" && guard < 100000) {
            backend.step(0.05);
            guard += 1;
        }
        const finished = await backend.run();
        expect(finished?.state).toBe("done");
        expect(finished?.acked).toBe(finished?.total);
        expect(finished?.seconds).toBeGreaterThan(0);
        expect(finished!.seconds).toBeCloseTo(patched.stats.seconds, -1);
        expect(events.filter((e) => e.type === "progress").length).toBeGreaterThan(1);
        expect(events.some((e) => e.type === "message" && e.data.text.includes("done"))).toBe(true);
        const end = backend.machine.status().board;
        const last = patched.groups[0]!.paths[0]!;
        expect(end.x).toBeCloseTo(last[last.length - 1]![0], 3);
        expect(end.y).toBeCloseTo(last[last.length - 1]![1], 3);

        await backend.deleteJob(job.id);
        expect((await backend.jobs()).length).toBe(1);
        await expect(backend.job(job.id)).rejects.toMatchObject({ status: 404 });
    });

    test("stop ends a run without an alarm", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const list = await backend.jobs();
        await backend.runJob(list[0]!.id);
        backend.step(0.5);
        await backend.runStop();
        expect(backend.machine.state).toBe("Idle");
        expect((await backend.run())?.state).toBe("stopped");
        expect(backend.machine.queue.length).toBe(0);
    });

    test("disconnecting during a run ends it as stopped and resets the machine", async () => {
        const { backend, events } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const list = await backend.jobs();
        await backend.runJob(list[0]!.id);
        backend.step(0.5);
        expect(backend.machine.state).toBe("Run");
        events.length = 0;
        const snapshot = await backend.disconnect();
        expect(snapshot.connected).toBe(false);
        expect(snapshot.run?.state).toBe("stopped");
        expect(snapshot.run?.sent).toBeGreaterThan(0);
        const progress = events.filter((e) => e.type === "progress");
        expect(progress.length).toBe(1);
        expect(progress[0]!.type === "progress" && progress[0]!.data.state).toBe("stopped");
        expect(events.some((e) => e.type === "message" && e.data.text.includes("stopped"))).toBe(true);
        // Like the firmware losing its USB host: a reset, so nothing keeps moving.
        expect(backend.machine.queue.length).toBe(0);
        expect(backend.machine.active).toBeNull();
        expect(backend.machine.laser).toBe(0);
        expect(backend.machine.state).toBe("Alarm");
        const r = backend.machine.joint.r;
        backend.step(1);
        expect(backend.machine.joint.r).toBe(r);
        const again = await backend.connect("/dev/ttyACM0");
        expect(again.run?.state).toBe("stopped");
        await expect(backend.runStop()).rejects.toMatchObject({ status: 409 });
        await backend.unlock();
        await backend.runJob(list[0]!.id);
        expect((await backend.run())?.state).toBe("running");
    });

    test("the console needs an F for the first cut and forgets it on a reset", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("cut R5 S100")).toEqual(["error:3 missing word"]);
        expect(await backend.command("cut F100 S100")).toEqual(["error:3 missing word"]);
        expect(await backend.command("go")).toEqual(["error:3 missing word"]);
        expect(await backend.command("jog F100")).toEqual(["error:3 missing word"]);
        expect(await backend.command("cut R5 F0 S100")).toEqual(["error:4 out of range"]);
        expect(await backend.command("cut R5 F0.0001 S100")).toEqual(["error:4 out of range"]);
        expect(backend.machine.queue.length).toBe(0);
        expect(await backend.command("cut R5 F100 S100")).toEqual(["ok"]);
        expect(await backend.command("cut A90")).toEqual(["ok"]);
        expect(backend.machine.queue[1]?.feed).toBe(100);
        expect(backend.machine.queue[1]?.power).toBe(100);
        expect(await backend.command("mode const")).toEqual(["ok"]);
        await backend.realtime("reset");
        await backend.unlock();
        expect(backend.machine.mode).toBe("dyn");
        expect(await backend.command("cut A90")).toEqual(["error:3 missing word"]);
        expect(await backend.command("cut A90 F50")).toEqual(["ok"]);
        expect(backend.machine.queue[0]?.power).toBe(0);
    });

    test("laser test from the API clamps and refuses like the firmware", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.laser(1200, 1000);
        expect(backend.machine.laser).toBe(1000);
        await expect(backend.laser(100, 70000)).rejects.toMatchObject({ status: 409 });
        expect(consoleLines().slice(-1)).toEqual(["rx error:4 out of range"]);
        await backend.realtime("hold");
        expect(backend.machine.laser).toBe(0);
        expect(backend.machine.state).toBe("Idle");
    });

    test("a job patch is checked whole, refused while running, and leaves a refused job unchanged", async () => {
        const { backend } = backendWithLog();
        const list = await backend.jobs();
        const id = list[0]!.id;
        const before = structuredClone(await backend.job(id));
        await expect(backend.patchJob(id, { groups: [{ index: 0, speed: 0 }] })).rejects.toMatchObject({ status: 400, message: "speed must be above 0 and at most 1e+06" });
        await expect(backend.patchJob(id, { groups: [{ index: 0, power: -1 }] })).rejects.toMatchObject({ status: 400, message: "power must be between 0 and 1e+06" });
        await expect(backend.patchJob(id, { groups: [{ index: 9, power: 1 }] })).rejects.toMatchObject({ status: 400 });
        await expect(backend.patchJob(id, { groups: [{ index: 0, power: 10 }, { index: 1, speed: Number.NaN }] })).rejects.toMatchObject({ status: 400 });
        await expect(backend.patchJob(id, { offset: { x: Number.POSITIVE_INFINITY, y: 0 } })).rejects.toMatchObject({ status: 400 });
        expect(await backend.job(id)).toEqual(before);
        await backend.connect("/dev/ttyACM0");
        await backend.runJob(id);
        await expect(backend.patchJob(id, { groups: [{ index: 0, enabled: false }] })).rejects.toMatchObject({ status: 409 });
        await expect(backend.patchJob(id, { offset: { x: 1, y: 14 } })).rejects.toMatchObject({ status: 409 });
        expect(await backend.job(id)).toEqual(before);
        await backend.runStop();
        await backend.patchJob(id, { groups: [{ index: 0, power: 10, speed: 50 }], offset: { x: 1, y: 14 } });
        const after = await backend.job(id);
        expect(after.groups[0]!.power).toBe(10);
        expect(after.groups[0]!.speed).toBe(50);
        expect(after.offset).toEqual({ x: 1, y: 14 });
        expect(after.groups[0]!.paths[0]![0]![0]).toBeCloseTo(before.groups[0]!.paths[0]![0]![0] + 1, 9);
        expect(before.groups[0]!.power).toBe(500);
    });

    test("a joint-space job previews, lists its joints, streams as written and cannot be moved", async () => {
        const { backend, consoleLines } = backendWithLog();
        const file = new File([JSON.stringify({ name: "far", groups: [{ label: "rail line", speed: 300, power: 200, joints: [[[5, 0], [-5, 0]]] }] })], "far.json");
        const job = await backend.uploadJob(file, {});
        expect(job.groups[0]!.joints).toEqual([[[5, 0], [-5, 0]]]);
        expect(job.groups[0]!.paths[0]!.length).toBeGreaterThan(50);
        expect(job.stats.min_radius).toBe(0);
        expect(job.stats.max_radius).toBe(5);
        expect(job.stats.moves).toBe(2);
        const summary = (await backend.jobs()).find((j) => j.id === job.id)!;
        expect(summary.groups[0]!.joints).toBe(1);
        await expect(backend.patchJob(job.id, { offset: { x: 1, y: 0 } })).rejects.toMatchObject({ status: 400 });
        await backend.patchJob(job.id, { offset: { x: 0, y: 0 }, groups: [{ index: 0, power: 250 }] });
        expect((await backend.job(job.id)).groups[0]!.power).toBe(250);
        await backend.connect("/dev/ttyACM0");
        await backend.setPosition({ r: 0, a: 720 });
        await backend.runJob(job.id);
        const tx = consoleLines().filter((line) => line.startsWith("tx go") || line.startsWith("tx cut"));
        expect(tx).toEqual(["tx go R5.000 A720.0000", "tx cut R-5.000 A720.0000 F300 S250"]);
        let guard = 0;
        while ((await backend.run())?.state === "running" && guard < 10000) {
            backend.step(0.05);
            guard += 1;
        }
        expect((await backend.run())?.state).toBe("done");
        expect(backend.machine.joint.r).toBeCloseTo(-5, 6);
        expect(backend.machine.status().board.x).toBeCloseTo(-5, 6);
    });

    test("state events tick faster while moving", async () => {
        const { backend, events } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        events.length = 0;
        for (let i = 0; i < 100; i++) {
            backend.step(0.01);
        }
        const idle = events.filter((e) => e.type === "state").length;
        events.length = 0;
        await backend.jog({ kind: "joint", dr: 20 });
        for (let i = 0; i < 100; i++) {
            backend.step(0.01);
        }
        const moving = events.filter((e) => e.type === "state").length;
        expect(idle).toBe(5);
        expect(moving).toBe(10);
    });
});
