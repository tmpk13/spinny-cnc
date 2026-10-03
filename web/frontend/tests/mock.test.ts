import { describe, expect, test } from "bun:test";

import { ApiError } from "../src/api.ts";
import { DEG } from "../src/kinematics.ts";
import { MockBackend, MockMachine, PROBE_POINT_SECONDS, boardSurface, formatMove, heightAt, statusLine } from "../src/mock/backend.ts";
import { outputDuty } from "../src/profile.ts";
import type { Compensate, GotoRequest, Grid, HeightMap, HeightMapState, Job, JogRequest, WsEvent } from "../src/types.ts";

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

    test("a cut's M word floors the dyn power and is capped at S", () => {
        const machine = new MockMachine();
        machine.setPosition({ r: 10 });
        // Held to the table rate, the scaled power would be about 87.
        machine.cut(10, 90, 400, 500, 150);
        stepped(machine, 1);
        expect(machine.laser).toBeCloseTo(150, 6);
        const capped = new MockMachine();
        capped.setPosition({ r: 10 });
        capped.cut(10, 90, 400, 500, 900);
        stepped(capped, 1);
        expect(capped.laser).toBeCloseTo(500, 6);
        expect(formatMove({ kind: "cut", target: { r: 1, a: 2 }, feed: 300, power: 200, minPower: 50, group: 0 })).toBe("cut R1.000 A2.0000 F300 S200 M50");
        expect(formatMove({ kind: "cut", target: { r: 1, a: 2 }, feed: 300, power: 200, minPower: 0, group: 0 })).toBe("cut R1.000 A2.0000 F300 S200");
    });

    test("the M word reaches the mock machine from a line", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("cut R5 F100 S100 M-1")).toEqual(["error:4 out of range"]);
        expect(await backend.command("cut R5 F100 S100 M20")).toEqual(["ok"]);
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
        // At rest a reset raises no alarm, and there is nothing to unlock.
        expect(machine.reset()).toBe(false);
        expect(() => machine.unlock()).toThrow("error:5 not now");
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
        // Without a focus axis its position is null, as the backend reports it.
        expect(machine.status().joint).toEqual({ r: 0, a: 0, z: 0, h: null });
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
        expect(consoleLines().slice(-2)).toEqual(["tx jog R1", "rx ok"]);
        await backend.jog({ kind: "joint", da: 90, feed: 100 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog A90 F100", "rx ok"]);
    });

    test("a cross slide move is one line of its own", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.jog({ kind: "joint", dz: 0.05 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog Z0.05", "rx ok"]);
        backend.step(0.1);
        expect(backend.machine.z).toBeCloseTo(0.05, 9);
        expect(backend.snapshot().machine?.joint.z).toBeCloseTo(0.05, 9);
        await backend.goto({ kind: "joint", z: -0.2 });
        expect(consoleLines().slice(-2)).toEqual(["tx jogto Z-0.2", "rx ok"]);
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
        expect(tx).toEqual(["tx jogto R0.000 A0.0000", "tx jogto A180.0000", "tx jogto R10.000 A180.0000"]);
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
        expect(backend.machine.reset()).toBe(true);
        // The firmware's refusal comes back as the backend's 400, naming the line.
        await expect(backend.goto({ kind: "joint", r: 1 })).rejects.toMatchObject({ status: 400, message: "'jogto R1': error:5 not now" });
        await backend.unlock();
        await backend.goto({ kind: "joint", r: 1 });
    });

    test("realtime, command line and settings", async () => {
        const { backend, events, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("version")).toEqual([`[spinny v0.1.0-mock lines:16 blocks:32]`, "ok"]);
        expect(await backend.command("$r_rate")).toEqual(["r_rate=560", "ok"]);
        // The drivers' report follows the ok, as they answer over their UART.
        expect(await backend.command("$tmc")).toEqual(["ok"]);
        expect(consoleLines().slice(-5)).toEqual([
            "rx ok",
            "rx [MSG:tmc R addr0 ifcnt=1 micro=256 status=0x00000000]",
            "rx [MSG:tmc A addr2 ifcnt=1 micro=256 status=0x00000000]",
            "rx [MSG:tmc Z addr1 ifcnt=1 micro=256 status=0x00000000]",
            "rx [MSG:tmc H addr3 ifcnt=1 micro=256 status=0x00000000]",
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
        await expect(backend.laser(100, 70000)).rejects.toMatchObject({ status: 400, message: "'laser S100 T70000': error:4 out of range" });
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
        await expect(backend.patchJob(id, { groups: [{ index: 0, min_power: -1 }] })).rejects.toMatchObject({ status: 400, message: "min power must be between 0 and 1e+06" });
        await expect(backend.patchJob(id, { groups: [{ index: 0, passes: 0 }] })).rejects.toMatchObject({ status: 400, message: "passes must be between 1 and 100" });
        await expect(backend.patchJob(id, { groups: [{ index: 0, passes: 1.5 }] })).rejects.toMatchObject({ status: 400 });
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
        expect(before.groups[0]!.passes).toBe(1);
        await backend.patchJob(id, { groups: [{ index: 0, power: 10, min_power: 4, speed: 50, passes: 2 }], offset: { x: 1, y: 14 } });
        const after = await backend.job(id);
        expect(after.groups[0]!.power).toBe(10);
        expect(after.groups[0]!.min_power).toBe(4);
        expect((await backend.jobs()).find((job) => job.id === id)!.groups[0]!.min_power).toBe(4);
        expect(after.groups[0]!.passes).toBe(2);
        expect((await backend.jobs()).find((job) => job.id === id)!.groups[0]!.passes).toBe(2);
        // The rapids depend on where the head starts; the cuts are the group's twice over.
        const cuts = (job: Job): number => backend.movesFor(job).filter((move) => move.group === 0 && move.kind === "cut").length;
        const single = { ...after, groups: after.groups.map((group, index) => (index === 0 ? { ...group, passes: 1 } : group)) };
        expect(cuts(after)).toBe(2 * cuts(single));
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

/** Steps the backend's clock by `seconds` in ticks of `dt`. */
function advance(backend: MockBackend, seconds: number, dt = 0.05): void {
    for (let left = seconds; left > 1e-9; left -= dt) {
        backend.step(Math.min(dt, left));
    }
}

function heightMapEvents(events: WsEvent[]): HeightMapState[] {
    return events.flatMap((e) => (e.type === "heightmap" ? [e.data] : []));
}

/** A complete 2 by 2 map over a board box. */
function flatMap(x0: number, y0: number, x1: number, y1: number, heights: number[][], focusSet = true): HeightMap {
    return {
        grid: { x0, y0, x1, y1, nx: 2, ny: 2 },
        heights,
        focus_offset: 1.5,
        focus_set: focusSet,
        probe_offset: [0, 0],
        created: "",
    };
}

/**
 * Puts a map back and focuses it over its middle, as an operator does after
 * loading one: a map put back needs focus here before a run follows it.
 * The head is brought to the map's own offset above the surface there.
 */
async function putFocused(backend: MockBackend, map: HeightMap): Promise<void> {
    await backend.putHeightMap(map);
    const x = (map.grid.x0 + map.grid.x1) / 2;
    const y = (map.grid.y0 + map.grid.y1) / 2;
    await backend.goto({ kind: "board", x, y });
    advance(backend, 30);
    if (backend.machine.hasFocusAxis()) {
        await backend.goto({ kind: "joint", h: round4(heightAt(map, x, y) + map.focus_offset) });
        advance(backend, 30);
    }
    await backend.focus(null);
}

function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

const SMALL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10"><path d="M0 0 L10 0 L10 10"/></svg>';

describe("mock focus axis", () => {
    test("without the axis an H word is refused and the status leaves it off", () => {
        const machine = new MockMachine();
        expect(() => machine.go(null, null, 1)).toThrow("error:2 bad word");
        expect(() => machine.setPosition({ h: 0 })).toThrow("error:2 bad word");
        expect(() => machine.probe(-1, null)).toThrow("error:2 bad word");
        expect(machine.status().probe).toBeNull();
        expect(statusLine(machine)).toBe("<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0|Z:0.000>");
    });

    test("a focus jog runs at its own feed and a cut carries the head along", () => {
        const machine = new MockMachine({ h_axis: 1 });
        expect(statusLine(machine)).toBe("<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0|Z:0.000|H:0.000|P:0>");
        // A move of the head alone takes F as its speed: 2 mm at 60 mm/min.
        machine.jog(0, 0, 60, 2);
        stepped(machine, 1);
        expect(machine.h).toBeCloseTo(1, 6);
        expect(machine.state).toBe("Jog");
        stepped(machine, 1.01);
        expect(machine.h).toBeCloseTo(2, 9);
        expect(machine.state).toBe("Idle");
        // Without F it is jog_h, 120 mm/min.
        machine.jogTo(null, null, null, 1);
        stepped(machine, 0.51);
        expect(machine.h).toBeCloseTo(1, 9);
        expect(machine.state).toBe("Idle");
        // F stays the board speed on a cut, 10 mm at 300 mm/min; the head follows it.
        machine.cut(10, null, 300, 100, 0, 0.5);
        stepped(machine, 1);
        expect(machine.h).toBeCloseTo(0.75, 6);
        expect(machine.joint.r).toBeCloseTo(5, 6);
        stepped(machine, 1.01);
        expect(machine.status().joint).toEqual({ r: 10, a: 0, z: 0, h: 0.5 });
        expect(machine.endpointH()).toBe(0.5);
        machine.setPosition({ h: 3 });
        expect(machine.h).toBe(3);
    });

    test("move lines carry the focus height", () => {
        expect(formatMove({ kind: "cut", target: { r: 1, a: 2 }, h: -0.5, feed: 300, power: 200, group: 0 })).toBe("cut R1.000 A2.0000 H-0.5000 F300 S200");
        expect(formatMove({ kind: "go", target: { r: 0, a: 0 }, h: 0, feed: null, power: 0, group: 0 })).toBe("go R0.000 A0.0000 H0.0000");
    });

    test("the console probe answers like the firmware", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(backend.snapshot().machine?.joint.h).toBe(0);
        expect(backend.snapshot().machine?.probe).toBe(false);
        expect(await backend.command("probe")).toEqual(["error:3 missing word"]);
        expect(await backend.command("probe H0")).toEqual(["error:4 out of range"]);
        expect(await backend.command("probe H-1 F0")).toEqual(["error:4 out of range"]);
        expect(await backend.command("probe R1 H-1")).toEqual(["error:2 bad word"]);

        // The board is 1.5 mm below the head's zero over the axis.
        expect(await backend.command("probe H-5 F60")).toEqual(["[PRB:-1.5000:1]", "ok"]);
        const h = backend.machine.h;
        expect(h).toBeLessThanOrEqual(-1.5);
        expect(h).toBeGreaterThan(-1.55);
        expect(backend.machine.state).toBe("Idle");
        expect(statusLine(backend.machine).endsWith("|P:1>")).toBe(true);
        expect(backend.snapshot().machine?.probe).toBe(true);
        expect(await backend.command("probe H-1")).toEqual(["error:10 probe active"]);

        expect(await backend.command("jogto H1")).toEqual(["ok"]);
        advance(backend, 2);
        expect(backend.machine.h).toBeCloseTo(1, 9);
        expect(statusLine(backend.machine).endsWith("|H:1.000|P:0>")).toBe(true);
        expect(await backend.command("probe H-1 F120")).toEqual([
            "[PRB:0.0000:0]",
            "ALARM:2 probe missed, check the head before moving",
            "error:11 probe missed",
        ]);
        expect(backend.machine.state).toBe("Alarm");
        expect(backend.machine.alarm).toBe(2);
        expect(await backend.command("go R1")).toEqual(["error:5 not now"]);
        expect(await backend.command("unlock")).toEqual(["ok"]);

        // An active-high input reads open as contact.
        expect(await backend.command("$probe_invert=1")).toEqual(["ok"]);
        expect(await backend.command("probe H-1")).toEqual(["error:10 probe active"]);
        expect(await backend.command("$probe_invert=0")).toEqual(["ok"]);

        expect(await backend.command("$h_axis=0")).toEqual(["ok"]);
        for (const line of ["go H1", "cut R1 H1 F100 S10", "jog H1", "jogto H1", "set H0", "probe H-1"]) {
            expect(await backend.command(line)).toEqual(["error:2 bad word"]);
        }
        expect(await backend.command("jog Z1 H1")).toEqual(["error:2 bad word"]);
        expect(statusLine(backend.machine).endsWith("|Z:0.000>")).toBe(true);
        expect(backend.snapshot().machine?.joint.h).toBeNull();
        expect(backend.snapshot().machine?.probe).toBeNull();
        expect(await backend.command("$load")).toEqual(["ok"]);
        expect(backend.machine.hasFocusAxis()).toBe(true);
    });

    test("jogs, gotos and position declarations take the focus axis", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.jog({ kind: "joint", dh: 0.5 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog H0.5", "rx ok"]);
        advance(backend, 0.5);
        expect(backend.snapshot().machine?.joint.h).toBeCloseTo(0.5, 9);
        await backend.goto({ kind: "joint", r: 5, h: -0.25 });
        expect(consoleLines().slice(-2)).toEqual(["tx jogto R5 H-0.25", "rx ok"]);
        advance(backend, 2);
        expect(backend.machine.joint.r).toBeCloseTo(5, 9);
        expect(backend.machine.h).toBeCloseTo(-0.25, 9);
        await backend.setPosition({ r: 0, h: 0 });
        expect(consoleLines().slice(-2)).toEqual(["tx set R0 H0", "rx ok"]);
        expect(backend.machine.h).toBe(0);
        await backend.updateSettings({ values: { h_axis: 0 } });
        await expect(backend.jog({ kind: "joint", dh: 1 })).rejects.toMatchObject({ status: 400, message: "'jog H1': error:2 bad word" });
    });
});

describe("mock height map", () => {
    const grid: Grid = { x0: 4, y0: 6, x1: 14, y1: 11, nx: 3, ny: 2 };

    async function probed(offset?: [number, number]) {
        const log = backendWithLog();
        await log.backend.connect("/dev/ttyACM0");
        if (offset) {
            await log.backend.probeSettings({ offset });
        }
        const started = await log.backend.probe(grid);
        advance(log.backend, grid.nx * grid.ny * PROBE_POINT_SECONDS + 0.2);
        return { ...log, started };
    }

    test("probing a grid fills the map with the board's heights", async () => {
        const { backend, events, consoleLines, started } = await probed();
        expect(started.probe).toMatchObject({ state: "running", done: 0, total: 6, point: [0, 0] });
        expect(started.map?.heights).toEqual([[null, null, null], [null, null, null]]);
        expect(started.map?.focus_set).toBe(false);
        const state = await backend.heightMap();
        expect(state.probe).toMatchObject({ state: "done", done: 6, total: 6, point: null, error: null });
        expect(state.probe!.seconds).toBeCloseTo(1.5, 0);
        const xs = [4, 9, 14];
        const ys = [6, 11];
        for (let iy = 0; iy < 2; iy++) {
            for (let ix = 0; ix < 3; ix++) {
                expect(state.map!.heights[iy]![ix]!).toBeCloseTo(boardSurface(xs[ix]!, ys[iy]!), 4);
            }
        }
        // Back at the travel height, over the last point of the serpentine.
        expect(backend.machine.h).toBe(0);
        expect(backend.machine.state).toBe("Idle");
        expect(backend.machine.status().board.x).toBeCloseTo(4, 6);
        expect(backend.machine.status().board.y).toBeCloseTo(11, 6);
        const lines = consoleLines();
        expect(lines).toContain("tx probe H-5 F60");
        expect(lines).toContain("tx probe H-0.6 F15");
        expect(lines).toContain("tx go H0.0000");
        expect(lines.some((line) => /^rx \[PRB:-1\.\d{4}:1\]$/.test(line))).toBe(true);
        // One event per point done, in order, and the last one says done.
        const seen = heightMapEvents(events);
        const counts = seen.map((s) => s.probe?.done ?? -1);
        expect(counts).toEqual([...counts].sort((a, b) => a - b));
        for (let done = 1; done <= 6; done++) {
            expect(counts).toContain(done);
        }
        expect(seen[seen.length - 1]?.probe?.state).toBe("done");
        expect(seen[seen.length - 1]?.map?.heights.flat().every((h) => h !== null)).toBe(true);
    });

    test("an offset probe tip is placed over each point", async () => {
        const { backend } = await probed([3, 1.5]);
        const state = await backend.heightMap();
        expect(state.map?.probe_offset).toEqual([3, 1.5]);
        expect(state.map!.heights[1]![2]!).toBeCloseTo(boardSurface(14, 11), 4);
        expect(state.map!.heights[0]![1]!).toBeCloseTo(boardSurface(9, 6), 4);
        // The beam is off the point by the tip's offset.
        const tip = backend.machine.tipBoard();
        expect(tip.x).toBeCloseTo(4, 6);
        expect(tip.y).toBeCloseTo(11, 6);
    });

    test("probing is refused like the backend refuses it", async () => {
        const { backend } = backendWithLog();
        await expect(backend.probe(grid)).rejects.toMatchObject({ status: 409, message: "not connected" });
        await backend.connect("/dev/ttyACM0");
        await expect(backend.probe({ ...grid, nx: 1 })).rejects.toMatchObject({ status: 400, message: "nx must be 2 to 50" });
        await expect(backend.probe({ ...grid, x1: grid.x0 })).rejects.toMatchObject({ status: 400, message: "the grid needs x1 above x0 and y1 above y0" });

        await backend.probeSettings({ offset: [0, 5] });
        await expect(backend.probe({ x0: -1, y0: -1, x1: 1, y1: 1, nx: 2, ny: 2 })).rejects.toMatchObject({
            status: 409,
            message:
                "the probe cannot reach (-1.00, -1.00): its tip is 5 mm off the rail, so it never comes nearer the axis than that;" +
                " move the grid off the axis or mount the probe in line with the rail",
        });
        await backend.probeSettings({ offset: [0, 0] });

        await backend.goto({ kind: "joint", h: -3 });
        await expect(backend.probe(grid)).rejects.toMatchObject({ status: 409 });
        await expect(backend.probe(grid)).rejects.toThrow(/^the machine is <Jog\|.*>, not Idle$/);
        advance(backend, 2);
        await expect(backend.probe(grid)).rejects.toMatchObject({
            status: 409,
            message: "the probe is already touching: raise the head clear of the board first",
        });
        await backend.setPosition({ h: 0 });

        await backend.updateSettings({ values: { h_axis: 0 } });
        await expect(backend.probe(grid)).rejects.toMatchObject({ status: 409, message: "the machine has no focus axis: set $h_axis=1 to probe" });
        expect((await backend.heightMap()).map).toBeNull();
    });

    test("nothing else moves the head while the board is probed", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        await backend.probe(grid);
        const probing = { status: 409, message: "the board is being probed" };
        await expect(backend.jog({ kind: "joint", dr: 1 })).rejects.toMatchObject(probing);
        await expect(backend.goto({ kind: "board", x: 1, y: 1 })).rejects.toMatchObject(probing);
        await expect(backend.setPosition({ r: 0 })).rejects.toMatchObject(probing);
        await expect(backend.runJob(job.id)).rejects.toMatchObject(probing);
        await expect(backend.focus(1)).rejects.toMatchObject(probing);
        await expect(backend.focus(null)).rejects.toMatchObject(probing);
        await expect(backend.clearHeightMap()).rejects.toMatchObject(probing);
        await expect(backend.probe(grid)).rejects.toMatchObject(probing);
        // Typed lines that change the machine wait for it too, as the backend's do.
        for (const line of ["set H1", "disable", "$h_steps=100", "spindle S100"]) {
            await expect(backend.command(line)).rejects.toMatchObject(probing);
        }
        advance(backend, 0.6);
        const stopped = await backend.probeStop();
        expect(stopped.probe).toMatchObject({ state: "stopped", done: 2, error: null });
        expect(stopped.map?.heights.flat().filter((h) => h !== null).length).toBe(2);
        expect(backend.machine.state).toBe("Idle");
        expect(backend.machine.alarm).toBeNull();
        await expect(backend.probeStop()).rejects.toMatchObject({ status: 409, message: "nothing is being probed" });
        // Stopped, it no longer counts time.
        advance(backend, 1);
        expect((await backend.heightMap()).probe?.seconds).toBe(stopped.probe?.seconds);
        await backend.jog({ kind: "joint", dr: 1 });

        advance(backend, 1);
        await backend.probe(grid);
        await backend.realtime("reset");
        expect((await backend.heightMap()).probe).toMatchObject({ state: "stopped", error: "reset by the operator" });
    });

    test("a probe that finds nothing ends the probing in error with the machine in Alarm:2", async () => {
        const { backend, events } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.probeSettings({ depth: 1 });
        await backend.probe(grid);
        advance(backend, 1);
        const state = await backend.heightMap();
        expect(state.probe).toMatchObject({ state: "error", done: 0, error: "'probe H-1 F60': error:11 probe missed" });
        expect(backend.machine.state).toBe("Alarm");
        expect(backend.machine.alarm).toBe(2);
        expect(events.some((e) => e.type === "message" && e.data.text === "probing failed: 'probe H-1 F60': error:11 probe missed")).toBe(true);
    });

    test("the probe settings merge, check and move the simulated tip", async () => {
        const { backend, events } = backendWithLog();
        expect((await backend.heightMap()).settings).toEqual({ depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0], rayleigh: 0.5 });
        const state = await backend.probeSettings({ slow: 0, offset: [2, -1] });
        expect(state.settings).toMatchObject({ depth: 5, slow: 0, offset: [2, -1] });
        expect(backend.machine.probeOffset).toEqual([2, -1]);
        expect(heightMapEvents(events).at(-1)?.settings.offset).toEqual([2, -1]);
        await expect(backend.probeSettings({ backoff: 6 })).rejects.toMatchObject({ status: 400, message: "backoff must be above 0 and at most the depth" });
        await expect(backend.probeSettings({ slow: 0.0001 })).rejects.toMatchObject({ status: 400, message: "slow must be 0 (one touch) or 0.001 to 10000 mm/min" });
        await expect(backend.probeSettings({ offset: [0, 2000] })).rejects.toMatchObject({ status: 400, message: "the probe offset must be within 1000 mm" });
        await expect(backend.probeSettings({ rayleigh: 0 })).rejects.toMatchObject({ status: 400, message: "rayleigh must be 0.001 to 100 mm" });
        expect((await backend.heightMap()).settings.slow).toBe(0);
    });

    test("a map is interpolated inside its grid and held at its edge outside", () => {
        const map = flatMap(0, 0, 10, 10, [[0, 1], [2, 3]]);
        expect(heightAt(map, 5, 5)).toBeCloseTo(1.5, 12);
        expect(heightAt(map, 10, 0)).toBeCloseTo(1, 12);
        expect(heightAt(map, -5, -5)).toBeCloseTo(0, 12);
        expect(heightAt(map, 20, 5)).toBeCloseTo(2, 12);
        expect(() => heightAt({ ...map, heights: [[0, null], [2, 3]] }, 5, 5)).toThrow("the height map is not complete");
    });

    test("focus takes the offset from the head over the board, or as given", async () => {
        const { backend } = backendWithLog();
        await expect(backend.focus(1)).rejects.toMatchObject({ status: 400, message: "there is no height map: probe the board first" });
        await backend.connect("/dev/ttyACM0");
        await backend.probe(grid);
        advance(backend, 2);
        await backend.goto({ kind: "board", x: 7, y: 8 });
        await expect(backend.focus(null)).rejects.toMatchObject({ status: 400, message: "the machine is Jog: focus with the head at rest" });
        advance(backend, 10);
        await backend.goto({ kind: "joint", h: -0.4 });
        advance(backend, 1);
        const map = (await backend.heightMap()).map!;
        const board = backend.machine.status().board;
        const expected = -0.4 - heightAt(map, board.x, board.y);
        const focused = await backend.focus(null);
        expect(focused.map?.focus_set).toBe(true);
        expect(focused.map!.focus_offset).toBeCloseTo(expected, 4);
        expect((await backend.focus(1.25)).map?.focus_offset).toBe(1.25);
        // A new probing with the same probe keeps the offset; another probe forgets it.
        const again = await backend.probe(grid);
        expect(again.map).toMatchObject({ focus_offset: 1.25, focus_set: true });
        await backend.probeStop();
        await backend.probeSettings({ offset: [1, 0] });
        await backend.setPosition({ h: 0 });
        const moved = await backend.probe(grid);
        expect(moved.map).toMatchObject({ focus_offset: 0, focus_set: false });
        await backend.probeStop();
        // Without a focus axis the head's height is called 0.
        await backend.updateSettings({ values: { h_axis: 0 } });
        await backend.putHeightMap(flatMap(-50, -50, 50, 50, [[-1, -1], [-1, -1]], false));
        expect((await backend.focus(null)).map?.focus_offset).toBe(1);
    });

    test("a map put back is checked for shape and cleared on request", async () => {
        const { backend, events } = backendWithLog();
        await expect(backend.putHeightMap(flatMap(0, 0, 10, 10, [[0, 1]]))).rejects.toMatchObject({ status: 400, message: "heights must be 2 rows of 2" });
        await expect(backend.putHeightMap(flatMap(0, 0, 0, 10, [[0, 1], [2, 3]]))).rejects.toMatchObject({ status: 400 });
        await expect(backend.putHeightMap(flatMap(0, 0, 10, 10, [[0, Number.NaN], [2, 3]]))).rejects.toMatchObject({ status: 422 });
        const put = await backend.putHeightMap(flatMap(0, 0, 10, 10, [[0, 1], [2, 3]]));
        expect(put.map?.heights).toEqual([[0, 1], [2, 3]]);
        expect(heightMapEvents(events).at(-1)?.map?.grid.x1).toBe(10);
        expect((await backend.clearHeightMap()).map).toBeNull();
        expect(heightMapEvents(events).at(-1)?.map).toBeNull();
    });

    test("a compensated run is checked like the backend checks it", async () => {
        const { backend, events, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = await backend.uploadJob(new File([SMALL_SVG], "small.svg"), { power: 400, speed: 300, offset_y: 20 });
        const refused = (message: string) => ({ status: 400, message });
        await expect(backend.runJob(job.id, "focus")).rejects.toMatchObject(refused("there is no height map: probe the board first"));
        await expect(backend.runJob(job.id, "bogus" as Compensate)).rejects.toMatchObject(refused("compensate must be one of off, auto, focus, power"));

        await backend.putHeightMap({ ...flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]]), heights: [[-1.5, null], [-1.6, -1.5]] });
        await expect(backend.runJob(job.id, "auto")).rejects.toMatchObject(refused("the height map is not complete: 3 of 4 points probed"));
        await backend.putHeightMap(flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]], false));
        await expect(backend.runJob(job.id, "auto")).rejects.toMatchObject(
            refused("the focus offset is not set: focus the beam by eye over the probed area and use focus here"),
        );
        // A map put back needs focus here, whatever it says of its offset.
        await backend.putHeightMap(flatMap(-10, 10, 10, 30, [[-4, 2], [-1.6, -1.5]]));
        await expect(backend.runJob(job.id, "power")).rejects.toMatchObject(
            refused("the focus offset is not set: focus the beam by eye over the probed area and use focus here"),
        );
        await putFocused(backend, flatMap(-10, 10, 10, 30, [[-4, 2], [-1.6, -1.5]]));
        await expect(backend.runJob(job.id, "power")).rejects.toMatchObject(
            refused("the height map spans 6.000 mm, more than 5 mm: probe again or flatten the board"),
        );
        await putFocused(backend, flatMap(-3, 16, 3, 24, [[-1.5, -1.4], [-1.6, -1.5]]));
        await expect(backend.runJob(job.id, "power")).rejects.toMatchObject(
            refused("the height map does not cover the job: probed X -3.0..3.0 Y 16.0..24.0, the job reaches X -5.0..5.0 Y 15.0..25.0"),
        );

        // Taking the focus axis out renumbers it, so the offset is taken back and set again.
        await putFocused(backend, flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]]));
        await backend.updateSettings({ values: { h_axis: 0 } });
        expect((await backend.heightMap()).map?.focus_set).toBe(false);
        await backend.focus(null);
        // So does a setting written at the console that may turn the axes;
        // a query does not.
        await backend.command("$h_steps");
        expect((await backend.heightMap()).map?.focus_set).toBe(true);
        expect(await backend.command("$dir_invert=0")).toEqual(["ok"]);
        expect((await backend.heightMap()).map?.focus_set).toBe(false);
        await backend.focus(null);
        await expect(backend.runJob(job.id, "focus")).rejects.toMatchObject(
            refused("the focus axis is not fitted ($h_axis=0): compensate by power instead"),
        );
        // Auto without the axis is power: the lines carry no H.
        await backend.runJob(job.id, "auto");
        expect(events.some((e) => e.type === "message" && e.data.text.endsWith("following the board by power"))).toBe(true);
        const tx = consoleLines().filter((line) => line.startsWith("tx go") || line.startsWith("tx cut"));
        expect(tx.length).toBeGreaterThan(0);
        expect(tx.some((line) => line.includes(" H"))).toBe(false);
        await backend.runStop();
        await backend.updateSettings({ values: { h_axis: 1 } });
    });

    test("a run by focus puts the head at the map's focus height at each move's end", async () => {
        const { backend, events, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = await backend.uploadJob(new File([SMALL_SVG], "small.svg"), { power: 400, speed: 300, offset_y: 20 });
        const map = flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]]);
        await putFocused(backend, map);
        expect((await backend.heightMap()).map?.focus_offset).toBe(1.5);
        await backend.runJob(job.id, "auto");
        expect(events.some((e) => e.type === "message" && e.data.text.endsWith("following the board by focus"))).toBe(true);
        const tx = consoleLines().filter((line) => line.startsWith("tx go") || line.startsWith("tx cut"));
        expect(tx.length).toBeGreaterThan(1);
        expect(tx.every((line) => / H-?\d+\.\d{4}( |$)/.test(line))).toBe(true);
        let guard = 0;
        while ((await backend.run())?.state === "running" && guard < 20000) {
            backend.step(0.05);
            guard += 1;
        }
        expect((await backend.run())?.state).toBe("done");
        const end = backend.machine.status().board;
        expect(backend.machine.h).toBeCloseTo(heightAt(map, end.x, end.y) + map.focus_offset, 4);
    });
});

describe("the mock machine answers as the firmware does", () => {
    test("a setting the firmware refuses is refused, and a refused one changes nothing", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const refused = [
            "$jog_z=0",
            "$jog_r=-1",
            "$s_min=2000",
            "$dir_invert=16",
            "$en_invert=2",
            "$step_us=0",
            "$step_us=21",
            "$laser_hz=5000.5",
            "$laser_hz=5000.0",
            "$laser_hz=99",
            "$laser_ms=0",
            "$tmc_r_micro=3",
            "$tmc_a_ma=5000",
            "$tmc_hold_pct=101",
            "$probe_ms=161",
            "$r_rate=1e3",
            "$r_rate=20000000",
            "$r_max=-1",
            "$idle_ms=4294967296",
            "$r_rate=",
        ];
        for (const line of refused) {
            expect([line, await backend.command(line)]).toEqual([line, ["error:7 bad setting value"]]);
        }
        expect(backend.machine.settings["jog_z"]).toBe(120);
        // A limit that spans two settings holds from either side.
        expect(await backend.command("$s_min=500")).toEqual(["ok"]);
        expect(await backend.command("$s_max=100")).toEqual(["error:7 bad setting value"]);
        expect(backend.machine.settings["s_max"]).toBe(1000);
        expect(await backend.command("$idle_ms=4294967295")).toEqual(["ok"]);
        expect(await backend.command("$R_RATE=500")).toEqual(["ok"]);
        expect(backend.machine.settings["r_rate"]).toBe(500);
        // With the jog rate refused the jog still ends.
        expect(await backend.command("jog Z1")).toEqual(["ok"]);
        advance(backend, 1);
        expect(backend.machine.state).toBe("Idle");
        expect(backend.machine.z).toBeCloseTo(1, 9);

        // A refused value is checked before the spindle it would stop.
        const machine = new MockMachine({ spindle: 1 });
        machine.spin(500);
        expect(() => machine.setSetting("spindle", 2)).toThrow("error:7 bad setting value");
        expect(machine.spindle).toBe(500);
        machine.setSetting("spindle", 0);
        expect(machine.spindle).toBe(0);
    });

    test("the spindle's words, and the laser's refused on a spindle machine", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        // A laser machine has no spindle.
        expect(await backend.command("spindle S800")).toEqual(["error:2 bad word"]);
        expect(await backend.command("spindle off")).toEqual(["error:2 bad word"]);
        expect(await backend.command("spindle")).toEqual(["error:3 missing word"]);
        expect(await backend.command("$spindle=1")).toEqual(["ok"]);
        // A cut drags the tool through the work: not with the spindle stopped.
        expect(await backend.command("cut R1 F100")).toEqual(["error:5 not now"]);
        expect(await backend.command("spindle S-1")).toEqual(["error:4 out of range"]);
        expect(await backend.command("spindle off x")).toEqual(["error:2 bad word"]);
        expect(await backend.command("spindle S800")).toEqual(["ok"]);
        expect(backend.machine.spindle).toBe(800);
        expect(statusLine(backend.machine)).toContain("|L:800|");
        // S and M belong to a laser: a laser job sent here fails on its first cut.
        for (const line of ["cut R1 F100 S100", "cut R1 F100 S0", "cut R1 F100 M5", "dwell T10 S5", "laser S100", "laser S100 T10"]) {
            expect([line, await backend.command(line)]).toEqual([line, ["error:2 bad word"]]);
        }
        expect(await backend.command("cut R1 F100")).toEqual(["ok"]);
        expect(backend.machine.queue[0]?.power).toBe(0);
        advance(backend, 1);
        expect(backend.machine.joint.r).toBeCloseTo(1, 9);
        // `laser off` is the output off, the spindle's included.
        expect(await backend.command("laser off")).toEqual(["ok"]);
        expect(backend.machine.spindle).toBe(0);
        expect(backend.snapshot().machine?.laser).toBe(0);
        expect(await backend.command("spindle S300")).toEqual(["ok"]);
        expect(await backend.command("spindle off")).toEqual(["ok"]);
        expect(backend.machine.spindle).toBe(0);
    });

    test("the API's laser off and a probe stop the spindle's output or refuse to run beside it", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { spindle: 1 } });
        await backend.spindle(500);
        expect(backend.snapshot().machine?.laser).toBe(500);
        await backend.laserOff();
        expect(backend.machine.spindle).toBe(0);
        expect(backend.snapshot().machine?.laser).toBe(0);
        // The probe may be the tool itself: not while it turns.
        await backend.spindle(500);
        expect(await backend.command("probe H-5")).toEqual(["error:5 not now"]);
        await expect(backend.probe({ x0: 4, y0: 6, x1: 14, y1: 11, nx: 2, ny: 2 })).rejects.toMatchObject({
            status: 409,
            message: "the spindle is turning: stop it before probing",
        });
        await backend.spindleOff();
        await backend.probe({ x0: 4, y0: 6, x1: 14, y1: 11, nx: 2, ny: 2 });
        // And a spindle does not start while the board is probed.
        await expect(backend.spindle(500)).rejects.toMatchObject({ status: 409, message: "the board is being probed" });
    });

    test("a laser machine's spindle stop is the beam's", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await expect(backend.spindle(300)).rejects.toMatchObject({ status: 400, message: "the output drives a laser ($spindle=0)" });
        await backend.laser(100, 2000);
        await backend.spindleOff();
        expect(consoleLines().slice(-2)).toEqual(["tx laser off", "rx ok"]);
        expect(backend.machine.laser).toBe(0);
    });

    test("board words: Z only on a cartesian machine, A only on a polar one", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        for (const line of ["go Z5", "cut Z5 F100", "go R1 Z1", "cut R1 A2 Z3 F100 S1"]) {
            expect([line, await backend.command(line)]).toEqual([line, ["error:2 bad word"]]);
        }
        expect(backend.machine.queue.length).toBe(0);
        expect(backend.machine.state).toBe("Idle");
        expect(await backend.command("$cartesian=1")).toEqual(["ok"]);
        expect(await backend.command("go A5")).toEqual(["error:2 bad word"]);
        expect(await backend.command("cut R1 A5 F100 S1")).toEqual(["error:2 bad word"]);
        expect(await backend.command("go R3 Z4")).toEqual(["ok"]);
        advance(backend, 2);
        expect(backend.machine.joint.r).toBeCloseTo(3, 9);
        expect(backend.machine.z).toBeCloseTo(4, 9);
        expect(backend.snapshot().machine?.board.x).toBeCloseTo(3, 9);
        expect(backend.snapshot().machine?.board.y).toBeCloseTo(4, 9);
        // A Z jog is a joint jog there, beside the others.
        expect(await backend.command("jog R1 Z-1")).toEqual(["ok"]);
        advance(backend, 2);
        expect(backend.machine.joint.r).toBeCloseTo(4, 9);
        expect(backend.machine.z).toBeCloseTo(3, 9);
    });

    test("unlock outside an alarm, disable while moving, and extra words are refused", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("unlock")).toEqual(["error:5 not now"]);
        await expect(backend.unlock()).rejects.toMatchObject({ status: 400, message: "'unlock': error:5 not now" });
        expect(await backend.command("jog R5")).toEqual(["ok"]);
        expect(await backend.command("disable")).toEqual(["error:5 not now"]);
        await expect(backend.motors(false)).rejects.toMatchObject({ status: 400, message: "'disable': error:5 not now" });
        expect(backend.machine.enabled).toBe(true);
        for (const line of ["status x", "version x", "help me", "enable 1"]) {
            expect([line, await backend.command(line)]).toEqual([line, ["error:2 bad word"]]);
        }
        advance(backend, 2);
        expect(await backend.command("disable")).toEqual(["ok"]);
        expect(backend.machine.enabled).toBe(false);
    });

    test("help lists what the firmware lists, in its order", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const help = await backend.command("help");
        expect(help.at(-1)).toBe("ok");
        expect(help[2]).toBe("cartesian=1: Z is a joint with R, H: go, cut, jog, jogto, set take Z; go, cut take no A");
        expect(help[5]).toBe("spindle=1: spindle S | spindle off; no S or M on cut and dwell, no laser S");
        expect(help.length).toBe(10);
    });

    test("the status line has no negative zero", () => {
        const machine = new MockMachine({ h_axis: 1 });
        machine.joint = { r: -0.0001, a: -0.00001 };
        machine.z = -0.0002;
        machine.h = -0.0003;
        expect(statusLine(machine)).toBe("<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0|Z:0.000|H:0.000|P:0>");
    });

    test("an active-low output reports the duty driven on the pin: 1000 dark", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { laser_invert: 1 } });
        expect(backend.snapshot().machine?.laser).toBe(1000);
        expect((await backend.command("status"))[0]).toContain("|L:1000|");
        await backend.laser(250, 1000);
        const lit = backend.snapshot().machine!;
        expect(lit.laser).toBe(750);
        expect((await backend.command("status"))[0]).toContain("|L:750|");
        expect(outputDuty(lit.laser, await backend.settings())).toBe(250);
        await backend.laserOff();
        expect(backend.snapshot().machine?.laser).toBe(1000);
        // A spindle's duty is driven the same way round.
        await backend.updateSettings({ values: { spindle: 1 } });
        expect(backend.snapshot().machine?.laser).toBe(1000);
        await backend.spindle(400);
        expect(backend.snapshot().machine?.laser).toBe(600);
        expect(outputDuty(backend.snapshot().machine!.laser, await backend.settings())).toBe(400);
        await backend.spindleOff();
        expect(backend.snapshot().machine?.laser).toBe(1000);
    });

    test("lines are spelled as the backend spells them", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.goto({ kind: "joint", r: 1.23456, a: 12.345678, feed: 150.5 });
        expect(consoleLines().slice(-2)).toEqual(["tx jogto R1.235 A12.3457 F150.5", "rx ok"]);
        await backend.jog({ kind: "joint", dr: -0.5, da: 0, feed: 200 });
        expect(consoleLines().slice(-2)).toEqual(["tx jog R-0.5 F200", "rx ok"]);
        advance(backend, 10);
        await backend.setPosition({ r: 2.5, a: 0.00001, z: 0.1 });
        expect(consoleLines().slice(-4)).toEqual(["tx set R2.5 A0", "rx ok", "tx set Z0.1", "rx ok"]);
        // A board move is fixed decimals, a turn on the axis only the angle.
        await backend.setPosition({ r: 0, a: 0 });
        await backend.goto({ kind: "board", x: 0, y: 3, feed: 120 });
        expect(consoleLines().filter((line) => line.startsWith("tx jogto")).slice(-2)).toEqual(["tx jogto A90.0000 F120", "tx jogto R3.000 A90.0000 F120"]);
        advance(backend, 30);
        // A refusal names the line as it went out.
        await backend.updateSettings({ values: { r_max: 5 } });
        await expect(backend.goto({ kind: "joint", r: 6.5 })).rejects.toMatchObject({ status: 400, message: "'jogto R6.5': error:4 out of range" });
    });

    test("a realtime byte typed at the console is the realtime byte", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        await backend.runJob(job.id);
        backend.step(0.5);
        expect(await backend.command("!")).toEqual([]);
        expect(backend.machine.state).toBe("Hold");
        backend.step(0.1);
        expect((await backend.run())?.state).toBe("hold");
        expect(await backend.command("~")).toEqual([]);
        backend.step(0.1);
        expect((await backend.run())?.state).toBe("running");
        expect(await backend.command("?")).toEqual([]);
        expect(consoleLines().at(-2)).toBe("tx ?");
        expect(consoleLines().at(-1)).toMatch(/^rx <Run\|/);
        expect(await backend.command("status")).toEqual([expect.stringMatching(/^<Run\|/), "ok"]);
        // Typed during a run, turning the output off stops the run the way its stop does.
        expect(await backend.command("laser off")).toEqual([]);
        expect((await backend.run())?.state).toBe("stopped");
        expect(backend.machine.state).toBe("Idle");
    });

    test("a reset prints the alarm only when it raised one", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("jogto H1")).toEqual(["ok"]);
        advance(backend, 2);
        expect(await backend.command("probe H-1 F120")).toContain("error:11 probe missed");
        expect(backend.machine.alarm).toBe(2);
        await backend.realtime("reset");
        expect(consoleLines().slice(-3)).toEqual(["tx <0x18>", "rx [MSG:reset]", "rx [spinny v0.1.0-mock lines:16 blocks:32]"]);
        expect(statusLine(backend.machine)).toMatch(/^<Alarm:2\|/);
        await backend.unlock();
        await backend.jog({ kind: "joint", dr: 5 });
        await backend.realtime("reset");
        expect(consoleLines().slice(-3)).toEqual(["rx [MSG:reset]", "rx ALARM:1 reset while moving, position may be off", "rx [spinny v0.1.0-mock lines:16 blocks:32]"]);
        expect(backend.machine.alarm).toBe(1);
    });

    test("motion is taken in a hold of a run and waits for the resume, a jog is not", async () => {
        const machine = new MockMachine();
        machine.cut(10, null, 300, 100);
        stepped(machine, 0.2);
        machine.hold();
        expect(machine.state).toBe("Hold");
        machine.go(0, 0);
        machine.dwell(10, 0);
        expect(machine.queue.length).toBe(2);
        expect(() => machine.jog(1, 0, null)).toThrow("error:5 not now");
        stepped(machine, 1);
        expect(machine.state).toBe("Hold");
        machine.resume();
        stepped(machine, 5);
        expect(machine.state).toBe("Idle");
        expect(machine.joint.r).toBeCloseTo(0, 9);
        // A hold of a jog takes no motion in.
        machine.jog(5, 0, null);
        stepped(machine, 0.2);
        machine.hold();
        expect(() => machine.go(1, 0)).toThrow("error:5 not now");
        machine.jogCancel();
        expect(machine.state).toBe("Idle");
    });
});

describe("the mock backend answers as the backend does", () => {
    /** Steps until the run has ended, or gives up. */
    async function runOut(backend: MockBackend): Promise<void> {
        let guard = 0;
        while ((await backend.run())?.state === "running" && guard < 40000) {
            backend.step(0.05);
            guard += 1;
        }
    }

    test("a spindle machine mills a job: lift, spindle, spin-up, plunge, cuts at depth with no S, lift, spindle off", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = await backend.uploadJob(new File([SMALL_SVG], "small.svg"), { power: 400, speed: 300, offset_y: 20 });
        await backend.updateSettings({ values: { spindle: 1, h_axis: 0 } });
        await expect(backend.runJob(job.id)).rejects.toMatchObject({ status: 400, message: "a spindle needs the focus axis as its depth axis: set $h_axis=1" });
        // Auto without the focus axis would be power, but that refusal comes first.
        await expect(backend.runJob(job.id, "auto")).rejects.toMatchObject({ status: 400, message: "a spindle needs the focus axis as its depth axis: set $h_axis=1" });
        await backend.updateSettings({ values: { h_axis: 1 } });
        await backend.patchJob(job.id, { groups: [{ index: 0, depth: 0.2, plunge: 50 }] });
        const before = consoleLines().length;
        await backend.runJob(job.id);
        const tx = (): string[] => consoleLines().slice(before).filter((line) => line.startsWith("tx ")).map((line) => line.slice(3));
        const lines = tx();
        expect(lines.slice(0, 5)).toEqual(["go H2.0000", "spindle S400", "dwell T2000", "go R25.495 A101.3099", "cut H-0.2000 F50"]);
        const cuts = lines.filter((line) => line.startsWith("cut R"));
        expect(cuts.length).toBeGreaterThan(1);
        expect(cuts.every((line) => / H-0\.2000 F300$/.test(line))).toBe(true);
        await runOut(backend);
        expect((await backend.run())?.state).toBe("done");
        expect(tx().slice(-2)).toEqual(["go H2.0000", "spindle off"]);
        expect(backend.machine.spindle).toBe(0);
        expect(backend.machine.h).toBeCloseTo(2, 9);
        expect(backend.machine.laser).toBe(0);
    });

    test("a milled run turns the spindle while it cuts, and refuses what the backend refuses", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { spindle: 1 } });
        const job = await backend.uploadJob(new File([SMALL_SVG], "small.svg"), { power: 400, speed: 300, offset_y: 20 });
        await backend.runJob(job.id);
        advance(backend, 3);
        expect(backend.machine.spindle).toBe(400);
        expect(backend.snapshot().machine?.laser).toBe(400);
        await backend.runStop();
        expect(backend.machine.spindle).toBe(0);

        await backend.patchJob(job.id, { groups: [{ index: 0, power: 0 }] });
        await expect(backend.runJob(job.id)).rejects.toMatchObject({ status: 400, message: `${job.groups[0]!.label}: a spindle needs a speed above 0` });
        const far = new File([JSON.stringify({ groups: [{ label: "rail line", speed: 300, power: 200, joints: [[[5, 0], [-5, 0]]] }] })], "far.json");
        const joints = await backend.uploadJob(far, {});
        await expect(backend.runJob(joints.id)).rejects.toMatchObject({ status: 400, message: "rail line: a joint-space group cannot be milled" });
        // The mock machine refuses a laser's S on a cut here too.
        expect(() => backend.machine.cut(1, 0, 100, 50)).toThrow("error:2 bad word");
    });

    test("a spindle follows the board with its depth axis, not by power", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { spindle: 1 } });
        const job = await backend.uploadJob(new File([SMALL_SVG], "small.svg"), { power: 400, speed: 300, offset_y: 20 });
        const map = flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]]);
        await putFocused(backend, map);
        await expect(backend.runJob(job.id, "power")).rejects.toMatchObject({
            status: 400,
            message: "a spindle follows the board with its depth axis: compensate by focus",
        });
        const before = consoleLines().length;
        await backend.runJob(job.id, "auto");
        const tx = consoleLines().slice(before).filter((line) => line.startsWith("tx ")).map((line) => line.slice(3));
        // The travel is over the map's highest point, the depth under the surface it gives.
        expect(tx[0]).toBe("go H2.1000");
        const [x, y] = job.groups[0]!.paths[0]![0]!;
        expect(tx[4]).toBe(`cut H${(heightAt(map, x, y) + 1.5 - 0.1).toFixed(4)} F60`);
        await backend.runStop();
    });

    test("a laser machine's focus run lights at focus when it starts over its first point", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = await backend.uploadJob(new File([SMALL_SVG], "small.svg"), { power: 400, speed: 300, offset_y: 20 });
        const map = flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]]);
        await putFocused(backend, map);
        const first = job.groups[0]!.paths[0]![0]!;
        await backend.goto({ kind: "board", x: first[0], y: first[1] });
        advance(backend, 30);
        const moves = backend.movesFor(job, (await backend.heightMap()).map);
        expect(formatMove(moves[0]!)).toBe(`go H${(heightAt(map, first[0], first[1]) + 1.5).toFixed(4)}`);
        expect(moves[1]?.kind).toBe("cut");
    });

    test("probing refuses a grid past the soft limit before anything moves", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { r_max: 10 } });
        await expect(backend.probe({ x0: 5, y0: -1, x1: 30, y1: 1, nx: 2, ny: 2 })).rejects.toMatchObject({
            status: 409,
            message: "the probe cannot reach (30.00, -1.00): the head would go to R30.017, past the soft limit r_max=10",
        });
        expect((await backend.heightMap()).map).toBeNull();
        expect(backend.machine.joint).toEqual({ r: 0, a: 0 });
    });

    test("a joint move with the cross slide beside the others: refused on a polar machine, one line on a cartesian one", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await expect(backend.goto({ kind: "joint", r: 5, z: -2 } as GotoRequest)).rejects.toMatchObject({
            status: 400,
            message: "the cross slide moves on its own: z cannot be sent with r, a or h",
        });
        await expect(backend.jog({ kind: "joint", dr: 3, dz: 1 } as JogRequest)).rejects.toMatchObject({
            status: 400,
            message: "the cross slide moves on its own: dz cannot be sent with dr, da or dh",
        });
        await expect(backend.jog({ kind: "joint" })).rejects.toMatchObject({ status: 400 });
        await expect(backend.jog({ kind: "joint", dr: 1, feed: 0 })).rejects.toMatchObject({ status: 400, message: "feed must be at least 0.001 mm/min" });
        expect(backend.machine.queue.length).toBe(0);

        await backend.updateSettings({ values: { cartesian: 1, z_max: 8 } });
        await backend.goto({ kind: "joint", r: 5, z: -2 });
        expect(consoleLines().slice(-2)).toEqual(["tx jogto R5 Z-2", "rx ok"]);
        advance(backend, 3);
        expect(backend.machine.joint.r).toBeCloseTo(5, 9);
        expect(backend.machine.z).toBeCloseTo(-2, 9);
        await backend.jog({ kind: "joint", dr: 3, dz: 1 });
        advance(backend, 3);
        expect(backend.machine.joint.r).toBeCloseTo(8, 9);
        expect(backend.machine.z).toBeCloseTo(-1, 9);
        await expect(backend.goto({ kind: "joint", z: 9 })).rejects.toMatchObject({ status: 400, message: "'jogto Z9': error:4 out of range" });
    });

    test("a cartesian board move is one line in the table's frame, and waits for a turn to end", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { cartesian: 1, z_max: 8 } });
        await backend.setPosition({ a: 90 });
        await backend.goto({ kind: "board", x: -3, y: 4 });
        // Turned back by the table's 90 degrees: R 4 along the rail, Z 3 across it.
        expect(consoleLines().slice(-2)).toEqual(["tx jogto R4.000 Z3.000", "rx ok"]);
        advance(backend, 5);
        expect(backend.snapshot().machine?.board.x).toBeCloseTo(-3, 9);
        expect(backend.snapshot().machine?.board.y).toBeCloseTo(4, 9);
        // Board (-10, 0) is 10 mm across the rail with the table at 90 degrees.
        await expect(backend.goto({ kind: "board", x: -10, y: 0 })).rejects.toMatchObject({
            status: 400,
            message: "out of reach: Z10.000 is past the soft limit z_max=8",
        });
        // A turn of the table leaves the end of the move unknown until it stops.
        await backend.jog({ kind: "joint", da: 10 });
        await expect(backend.jog({ kind: "board", dx: 1 })).rejects.toMatchObject({
            status: 409,
            message: "the table may still be turning: wait for the machine to stop before a board move",
        });
        advance(backend, 5);
        await backend.jog({ kind: "board", dx: 1 });
    });

    test("a board move past r_max is refused whole before any line goes out", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { r_max: 12 } });
        await backend.setPosition({ r: 10, a: 0 });
        const before = consoleLines().length;
        await expect(backend.goto({ kind: "board", x: 10, y: 10 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^out of reach: R1\d\.\d{3} is past the soft limit r_max=12$/) });
        expect(consoleLines().length).toBe(before);
        expect(backend.machine.queue.length).toBe(0);
        expect(backend.machine.state).toBe("Idle");
    });

    test("a board goto with one axis waits for a start it knows", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        expect(await backend.command("jog R20")).toEqual(["ok"]);
        await expect(backend.goto({ kind: "board", x: 5 })).rejects.toMatchObject({ status: 400, message: "give both x and y: where the head will stop is not known" });
        await backend.goto({ kind: "board", x: 5, y: 0 });
        // Behind a jog sent here the end is known.
        await backend.goto({ kind: "board", y: 3 });
        advance(backend, 30);
        expect(backend.machine.status().board.x).toBeCloseTo(5, 3);
        expect(backend.machine.status().board.y).toBeCloseTo(3, 3);
    });

    test("a settings write is all or nothing and checked like the backend's", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        const stats = (await backend.job(job.id)).stats;
        await expect(backend.updateSettings({ host: { tolerance: 0.02, clearance: 0 } })).rejects.toMatchObject({
            status: 400,
            message: "the clearance must be above 0 and at most 100 mm",
        });
        expect(backend.tolerance).toBe(0.005);
        await expect(backend.updateSettings({ host: { tolerance: 50 } })).rejects.toMatchObject({ status: 400, message: "tolerance must be above 0 and at most 10 mm" });
        await expect(backend.updateSettings({ values: { r_rate: 5e9 } })).rejects.toMatchObject({ status: 400, message: "r_rate must be within 4294967295" });
        await expect(backend.updateSettings({ values: { r_rate: 1e7 + 0.5 } })).rejects.toMatchObject({ status: 400, message: "r_rate must be within 1e+07" });
        await expect(backend.updateSettings({ values: { nope: 1 } })).rejects.toMatchObject({ status: 400, message: "unknown setting 'nope'" });
        // A value the machine refuses puts back the ones sent before it, and the host's are not stored.
        await expect(backend.updateSettings({ values: { r_rate: 700, jog_z: 0 }, host: { tolerance: 0.02, clearance: 3 } })).rejects.toMatchObject({
            status: 400,
            message: "'$jog_z=0': error:7 bad setting value",
        });
        expect(backend.machine.settings["r_rate"]).toBe(560);
        expect(backend.tolerance).toBe(0.005);
        expect(backend.clearance).toBe(2);
        // A tolerance alone reprices the jobs.
        await backend.updateSettings({ host: { tolerance: 0.5 } });
        expect((await backend.job(job.id)).stats.moves).toBeLessThan(stats.moves);
        // Nothing of the machine changes under a run.
        await backend.runJob(job.id);
        await expect(backend.updateSettings({ values: { r_rate: 700 } })).rejects.toMatchObject({ status: 409, message: "a job is running" });
        await expect(backend.motors(false)).rejects.toMatchObject({ status: 409, message: "a job is running" });
        await expect(backend.mode("const")).rejects.toMatchObject({ status: 409, message: "a job is running" });
        await backend.runStop();
    });

    test("laser off during a run is the run's hold, and nothing while it is held", async () => {
        const { backend, consoleLines } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        await backend.runJob(job.id);
        advance(backend, 2);
        await backend.laserOff();
        expect((await backend.run())?.state).toBe("hold");
        expect(backend.machine.state).toBe("Hold");
        advance(backend, 0.5);
        expect(backend.machine.laser).toBe(0);
        expect(consoleLines().filter((line) => line === "tx laser off").length).toBe(0);
        await backend.laserOff();
        expect(consoleLines().filter((line) => line === "tx laser off").length).toBe(0);
        await backend.runResume();
        expect((await backend.run())?.state).toBe("running");
        await backend.runStop();
    });

    test("the centering test is the polar laser's, and its power stays under s_max", async () => {
        const backend = new MockBackend({ timers: false });
        await expect(backend.centerJob({ power: 1200 })).rejects.toMatchObject({ status: 400, message: "power 1200 is over s_max 1000" });
        await expect(backend.centerJob({ power: 1200, fine: true })).rejects.toMatchObject({ status: 400, message: "power 1200 is over s_max 1000" });
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { spindle: 1 } });
        await expect(backend.centerJob({ lines: 4 })).rejects.toMatchObject({
            status: 400,
            message: "the centering test is a burn on the polar laser machine ($cartesian=0, $spindle=0)",
        });
    });

    test("the focus offset is tied to the focus axis frame", async () => {
        const { backend, events } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        const map = flatMap(-10, 10, 10, 30, [[-1.5, -1.4], [-1.6, -1.5]]);
        await backend.putHeightMap({ ...map, focus_set: true });
        expect((await backend.heightMap()).map?.focus_set).toBe(false);
        // Heights from another session are tied to this one only by focus here.
        await expect(backend.focus(1.5)).rejects.toMatchObject({
            status: 400,
            message:
                "the map was probed before the focus axis was last renumbered (a connect, a restart," +
                " a position set or a map put back): use focus here over the map, or probe again",
        });
        await expect(backend.focus(null)).rejects.toMatchObject({
            status: 400,
            message: "focus over the probed area: the beam is at X 0.0 Y 0.0, the map covers X -10.0..10.0 Y 10.0..30.0",
        });
        await putFocused(backend, map);
        expect((await backend.heightMap()).map?.focus_set).toBe(true);
        await backend.setPosition({ h: 0 });
        expect((await backend.heightMap()).map?.focus_set).toBe(false);
        expect(events.some((e) => e.type === "message" && e.data.text === "the position was set: focus here again before a run follows the height map")).toBe(true);
        await putFocused(backend, map);
        await backend.updateSettings({ values: { h_steps: 3200 } });
        expect((await backend.heightMap()).map?.focus_set).toBe(false);
        await putFocused(backend, map);
        await backend.connect("/dev/ttyACM0");
        expect((await backend.heightMap()).map?.focus_set).toBe(false);
        // A probing in this frame keeps its offset, and a number given then holds.
        await backend.setPosition({ h: 0 });
        await backend.probe({ x0: 4, y0: 6, x1: 14, y1: 11, nx: 2, ny: 2 });
        advance(backend, 2);
        expect((await backend.focus(1.25)).map?.focus_offset).toBe(1.25);
    });

    test("a job that turns the table is checked against the map along its moves", async () => {
        const { backend } = backendWithLog();
        await backend.connect("/dev/ttyACM0");
        // A turn from -45 to 45 degrees at 10 mm has its ends at X 7.07 but passes X 10 on the way.
        const arc = new File([JSON.stringify({ groups: [{ label: "arc", speed: 300, power: 200, joints: [[[10, -45], [10, 45]]] }] })], "arc.json");
        const job = await backend.uploadJob(arc, {});
        await putFocused(backend, flatMap(-1, -8, 8.5, 8, [[-1.5, -1.5], [-1.5, -1.5]]));
        await expect(backend.runJob(job.id, "focus")).rejects.toMatchObject({
            status: 400,
            message: "the height map does not cover the job: probed X -1.0..8.5 Y -8.0..8.0, the job reaches X 7.1..10.0 Y -7.1..7.1",
        });
        await putFocused(backend, flatMap(-1, -8, 10, 8, [[-1.5, -1.5], [-1.5, -1.5]]));
        await backend.runJob(job.id, "focus");
        await backend.runStop();
    });
});
