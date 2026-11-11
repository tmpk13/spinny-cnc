import { describe, expect, test } from "bun:test";

import { buildProfile, branch, jobItems, machineItems, parseXml, readJob, readMachine } from "../src/openpnp.ts";
import { parseDevice } from "../src/mock/openpnp.ts";
import type { Component } from "../src/types.ts";

// A machine.xml in OpenPnP's shape, cut down from a LumenPnP's: a seesaw Z
// (N2's mapped from N1's), two nozzles, VAC1's pump and valve, an I2C
// vacuum read, the ring light, both cameras, a tray and a strip.
const MACHINE = `<?xml version="1.0" encoding="UTF-8"?>
<openpnp-machine>
   <machine class="org.openpnp.machine.reference.ReferenceMachine">
      <axes>
         <axis class="org.openpnp.machine.reference.axis.ReferenceControllerAxis" id="AX" name="x" type="X" letter="X">
            <feedrate-per-second value="200.0" units="Millimeters"/>
         </axis>
         <axis class="org.openpnp.machine.reference.axis.ReferenceControllerAxis" id="AY" name="y" type="Y" letter="Y">
            <feedrate-per-second value="250.0" units="Millimeters"/>
         </axis>
         <axis class="org.openpnp.machine.reference.axis.ReferenceControllerAxis" id="AZ" name="z1" type="Z" letter="Z" safe-zone-low-enabled="true" safe-zone-high-enabled="true">
            <home-coordinate value="31.5" units="Millimeters"/>
            <safe-zone-low value="26.5" units="Millimeters"/>
            <safe-zone-high value="36.5" units="Millimeters"/>
         </axis>
         <axis class="org.openpnp.machine.reference.axis.ReferenceMappedAxis" id="AZ2" name="z2" type="Z" input-axis-id="AZ"/>
         <axis class="org.openpnp.machine.reference.axis.ReferenceControllerAxis" id="AA" name="a" type="Rotation" letter="A"/>
         <axis class="org.openpnp.machine.reference.axis.ReferenceControllerAxis" id="AB" name="b" type="Rotation" letter="B"/>
      </axes>
      <heads>
         <head class="org.openpnp.machine.reference.ReferenceHead" id="H1" name="H1">
            <nozzles>
               <nozzle class="org.openpnp.machine.reference.ReferenceNozzle" axis-X-id="AX" axis-Y-id="AY" axis-Z-id="AZ" axis-rotation-id="AA" id="N1" name="N1">
                  <compatible-nozzle-tip-ids class="java.util.ArrayList"><string>NT1</string></compatible-nozzle-tip-ids>
                  <head-offsets units="Millimeters" x="-23.544" y="-65.188" z="0.0" rotation="0.0"/>
                  <vacuum-sense-actuator-name>VAC1</vacuum-sense-actuator-name>
                  <vacuum-actuator-name>VAC1</vacuum-actuator-name>
               </nozzle>
               <nozzle class="org.openpnp.machine.reference.ReferenceNozzle" axis-X-id="AX" axis-Y-id="AY" axis-Z-id="AZ2" axis-rotation-id="AB" id="N2X" name="N2">
                  <head-offsets units="Millimeters" x="23.922" y="-64.393" z="0.9" rotation="0.0"/>
               </nozzle>
            </nozzles>
            <actuators>
               <actuator class="org.openpnp.machine.reference.ReferenceActuator" id="ACTV1" name="VAC1" value-type="Boolean"/>
            </actuators>
            <cameras>
               <camera class="org.openpnp.machine.reference.camera.OpenPnpCaptureCamera" id="CT" name="Top" looking="Down" light-actuator-id="ACTL">
                  <units-per-pixel units="Millimeters" x="0.013" y="0.013" z="0.0" rotation="0.0"/>
                  <head-offsets units="Millimeters" x="0.0" y="0.0" z="0.0" rotation="0.0"/>
               </camera>
            </cameras>
            <park-location units="Millimeters" x="42.328" y="411.916" z="0.0" rotation="0.0"/>
         </head>
      </heads>
      <feeders>
         <feeder class="org.openpnp.machine.reference.feeder.ReferenceTrayFeeder" id="F1" name="MCU tray" enabled="true" part-id="STM32F030" tray-count-x="3" tray-count-y="2" feed-count="0">
            <location units="Millimeters" x="100.0" y="50.0" z="12.0" rotation="90.0"/>
            <offsets units="Millimeters" x="12.0" y="10.0" z="0.0" rotation="0.0"/>
         </feeder>
         <feeder class="org.openpnp.machine.reference.feeder.ReferenceStripFeeder" id="F2" name="10k strip" enabled="true" part-id="R0603-10k" feed-count="3">
            <location units="Millimeters" x="0" y="0" z="0" rotation="0"/>
            <reference-hole-location units="Millimeters" x="200.0" y="100.0" z="11.0" rotation="0.0"/>
            <last-hole-location units="Millimeters" x="240.0" y="100.0" z="11.0" rotation="0.0"/>
            <part-pitch value="4.0" units="Millimeters"/>
            <tape-width value="8.0" units="Millimeters"/>
         </feeder>
      </feeders>
      <cameras>
         <camera class="org.openpnp.machine.reference.camera.OpenPnpCaptureCamera" id="CB" name="Bottom" looking="Up" light-actuator-id="ACTL">
            <units-per-pixel units="Millimeters" x="0.0367" y="0.037" z="0.0" rotation="0.0"/>
            <head-offsets units="Millimeters" x="38.376" y="154.632" z="4.0" rotation="0.0"/>
         </camera>
      </cameras>
      <actuators>
         <actuator class="org.openpnp.machine.reference.ReferenceActuator" id="ACTL" name="LED" value-type="Boolean"/>
      </actuators>
      <drivers>
         <driver class="org.openpnp.machine.reference.driver.GcodeDriver" id="DRV" name="GcodeDriver" communications="serial">
            <serial port-name="ttyACM0" baud="115200"/>
            <command type="CONNECT_COMMAND">
               <text><![CDATA[G21 ; Set millimeters mode ]]></text>
               <text><![CDATA[G90 ; Set absolute positioning mode]]></text>
            </command>
            <command type="HOME_COMMAND">
               <text><![CDATA[{Acceleration:M204 S%.2f ; Initialize acceleration}]]></text>
               <text><![CDATA[G28 ; Home all axes]]></text>
            </command>
            <command type="MOVE_TO_COMMAND">
               <text><![CDATA[{Acceleration:M204 S%.0f } ]]></text>
               <text><![CDATA[G1 {X:X%.4f} {Y:Y%.4f} {Z:Z%.4f} {A:A%.4f} {FeedRate:F%.0f} ; move to target]]></text>
            </command>
            <command type="MOVE_TO_COMPLETE_COMMAND"><text><![CDATA[M400 ; Wait]]></text></command>
            <command type="GET_POSITION_COMMAND"><text><![CDATA[M114 ; get position]]></text></command>
            <command type="DELAY_COMMAND"><text><![CDATA[{TimeMS:G4 P%d} ; Delay]]></text></command>
            <command head-mountable-id="ACTV1" type="ACTUATE_BOOLEAN_COMMAND">
               <text><![CDATA[{True:M106 P1 S180}{False:M107 P1};]]></text>
               <text><![CDATA[{True:M106}{False:M107};]]></text>
            </command>
            <command head-mountable-id="ACTV1" type="ACTUATOR_READ_COMMAND">
               <text><![CDATA[M260 A112 B1 S1 ; Select vac1 through multiplexer]]></text>
               <text><![CDATA[M261 A109 B1 S2 ; Request one byte]]></text>
            </command>
            <command head-mountable-id="ACTV1" type="ACTUATOR_READ_REGEX"><text><![CDATA[^.*data:(?<Value>.*)]]></text></command>
            <command head-mountable-id="ACTL" type="ACTUATE_BOOLEAN_COMMAND"><text><![CDATA[{True:M150 P255 R255 U255 B255}{False:M150 P0}]]></text></command>
         </driver>
      </drivers>
      <nozzle-tips>
         <nozzle-tip class="org.openpnp.machine.reference.ReferenceNozzleTip" id="NT1" name="N045" pick-dwell-milliseconds="200" place-dwell-milliseconds="100">
            <vacuum-level-part-on-low>220.0</vacuum-level-part-on-low>
            <vacuum-level-part-on-high>241.0</vacuum-level-part-on-high>
            <vacuum-level-part-off-low>248.0</vacuum-level-part-off-low>
            <vacuum-level-part-off-high>255.0</vacuum-level-part-off-high>
         </nozzle-tip>
      </nozzle-tips>
      <discard-location units="Millimeters" x="82.452" y="156.394" z="5.5" rotation="0.0"/>
   </machine>
</openpnp-machine>
`;

const JOB = `<openpnp-job version="1.0">
   <board-locations>
      <board-location board-file="board.board.xml" side="Top" check-fiducials="false" enabled="true">
         <location units="Millimeters" x="150.0" y="200.0" z="10.6" rotation="90.0"/>
      </board-location>
   </board-locations>
</openpnp-job>`;

const BOARD = `<openpnp-board version="1.1" name="board">
   <placements>
      <placement version="1.4" id="R1" side="Top" part-id="R0603-10k" type="Placement" enabled="true">
         <location units="Millimeters" x="10.0" y="0.0" z="0.0" rotation="0.0"/>
      </placement>
      <placement version="1.4" id="R2" side="Top" part-id="R0603-10k" type="Placement" enabled="true">
         <location units="Millimeters" x="20.0" y="5.0" z="0.0" rotation="90.0"/>
      </placement>
      <placement version="1.4" id="FID1" side="Top" part-id="FID" type="Fiducial" enabled="true">
         <location units="Millimeters" x="0.0" y="0.0" z="0.0" rotation="0.0"/>
      </placement>
   </placements>
</openpnp-board>`;

function part(ref: string, x: number, y: number): Component {
    return { ref, value: "10k", footprint: "R_0603", side: "front", x, y, rotation: 0, pads: 2, smd: true, dnp: false };
}

describe("reading an OpenPnP setup", () => {
    test("the XML reader takes elements, attributes, text, CDATA and entities", () => {
        const root = parseXml('<?xml version="1.0"?><!-- a note --><a k="1 &amp; 2"><b>x &lt; y</b><c><![CDATA[a < b]]></c><d/></a>');
        expect(root.name).toBe("a");
        expect(root.attrs["k"]).toBe("1 & 2");
        expect(root.children.map((each) => each.name)).toEqual(["b", "c", "d"]);
        expect(root.children[0]!.text).toBe("x < y");
        expect(root.children[1]!.text).toBe("a < b");
        expect(() => parseXml("<a><b></a>")).toThrow("closes");
    });

    test("an actuator's command splits into its on and off lines", () => {
        expect(branch(["{True:M106 P1 S180}{False:M107 P1};", "{True:M106}{False:M107};"], true)).toEqual(["M106 P1 S180", "M106"]);
        expect(branch(["M10{True:6 P1 S255}{False:7 P1};"], false)).toEqual(["M107 P1"]);
    });

    test("the machine's values come back in the nozzle's frame", () => {
        const machine = readMachine(MACHINE);
        expect(machine.port).toBe("/dev/ttyACM0");
        const { items, warnings } = machineItems(machine);
        const value = (id: string): string | undefined => items.find((item) => item.id === id)?.value;
        expect(value("init")).toBe("G21 | G90");
        expect(value("move")).toBe("G1");
        expect(value("home")).toBe("G28");
        expect(value("dwell")).toBe("G4 P{ms}");
        expect(value("axes")).toBe("X Y Z A");
        expect(value("safe_z")).toBe("31.5");
        expect(value("vacuum")).toBe("M106 P1 S180 | M106  /  M107 P1 | M107");
        expect(value("up_camera")).toBe("X 61.92 Y 219.82, sharp at Z 4");
        expect(value("top_camera")).toBe("X 23.544 Y 65.188 from N1");
        expect(value("park")).toBe("X 42.328 Y 411.916");
        expect(warnings).toEqual([]);
        // N2's Z is a mapped axis: its letters cannot be read.
        expect(machineItems(machine, "N2").warnings[0]).toContain("seesaw");
    });

    test("the profile made reads, kept values in it and left ones out", () => {
        const machine = readMachine(MACHINE);
        const { items } = machineItems(machine);
        const kept = new Set(items.filter((item) => item.keep).map((item) => item.id));
        const text = buildProfile("lumen", items, kept);
        const device = parseDevice(text, "lumen");
        expect(device.safe_z).toBe(31.5);
        expect(device.pick).toEqual(["M106 P1 S180", "M106"]);
        expect(device.light_on).toEqual(["M150 P255 R255 U255 B255"]);
        expect(device.vacuum?.read).toEqual(["M260 A112 B1 S1", "M261 A109 B1 S2"]);
        expect(device.vacuum?.part_on).toBeNull();
        expect(device.camera_position).toEqual([61.92, 219.82]);
        expect(device.top?.offset).toEqual([23.544, 65.188]);
        expect(device.discard).toBeNull();
        // Place Z, never read, stays at the safe height until measured.
        expect(device.place_z).toBe(31.5);
        // The tray walks along Y first (3 by 2), from the first part less the nozzle's offset.
        const tray = device.feeders.find((feeder) => feeder.id === "mcu-tray")!;
        expect(tray.at).toEqual([123.544, 115.188, 12]);
        expect(tray.columns).toBe(2);
        expect(tray.pitch).toEqual([0, 10]);
        expect(tray.row_pitch).toEqual([12, 0]);
        expect(tray.count).toBe(6);
        // The strip runs along +X: its parts 3.5 mm beside the holes, 2 mm
        // past the first, and it starts at the part OpenPnP takes next (#4).
        const strip = device.feeders.find((feeder) => feeder.id === "10k-strip")!;
        expect(strip.at[0]).toBeCloseTo(225.544 + 3 * 4, 3);
        expect(strip.at[1]).toBeCloseTo(161.688, 3);
        expect(strip.pitch[0]).toBeCloseTo(4, 6);
        expect(strip.count).toBe(8);
        // The levels kept are checked.
        kept.add("levels");
        expect(parseDevice(buildProfile("lumen", items, kept), "lumen").vacuum?.part_on).toEqual([220, 241]);
    });

    test("a job's placements become references, the place Z, and the strip's parts", () => {
        const machine = readMachine(MACHINE);
        const job = readJob(JOB, new Map([["board.board.xml", BOARD]]));
        expect(job.placements.map((placement) => placement.ref)).toEqual(["R1", "R2", "FID1"]);
        // R1 at 10, 0 on a board turned 90 at 150, 200.
        expect(job.placements[0]!.at[0]).toBeCloseTo(150, 6);
        expect(job.placements[0]!.at[1]).toBeCloseTo(210, 6);
        const found = jobItems(job, [part("R1", 0, 0), part("R2", 5, 5)], machine.nozzles[0]!.offset, machine.feeders);
        expect(found.references.map((entry) => entry.ref)).toEqual(["R1", "R2"]);
        expect(found.references[0]!.at[0]).toBeCloseTo(173.544, 6);
        expect(found.references[0]!.at[1]).toBeCloseTo(275.188, 6);
        const { items } = machineItems(machine);
        const all = [...items, ...found.items];
        const kept = new Set(all.filter((item) => item.keep).map((item) => item.id));
        const device = parseDevice(buildProfile("lumen", all, kept), "lumen");
        expect(device.place_z).toBeCloseTo(10.6, 6);
        expect(device.feeders.find((feeder) => feeder.id === "10k-strip")?.refs).toEqual(["R1", "R2"]);
        expect(readJob(JOB, new Map()).warnings[0]).toContain("was not given");
    });
});

describe("the import on the Config page", () => {
    test("reads the files picked, shows each value with its box, and makes the profile", async () => {
        const { mountDeviceProfiles } = await import("../src/views/deviceprofiles.ts");
        const { setup, settle, click } = await import("./harness.ts");
        const { ctx, backend } = setup();
        const root = document.createElement("section");
        document.body.append(root);
        mountDeviceProfiles(root, ctx);
        await settle();
        const input = root.querySelector('input[aria-label="OpenPnP files"]') as HTMLInputElement;
        Object.defineProperty(input, "files", { configurable: true, value: [new File([MACHINE], "machine.xml")] });
        input.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        const labels = Array.from(root.querySelectorAll(".openpnp-item .openpnp-label")).map((node) => node.textContent);
        expect(labels).toContain("Safe Z");
        expect(labels).toContain("VAC1 on and off");
        // Safe Z cannot be left out; the levels start left out.
        expect((root.querySelector('input[aria-label="Safe Z"]') as HTMLInputElement).disabled).toBe(true);
        const levels = Array.from(root.querySelectorAll<HTMLInputElement>(".openpnp-item input")).find((box) => box.getAttribute("aria-label")?.endsWith("vacuum levels"));
        expect(levels?.checked).toBe(false);
        expect(root.querySelector(".openpnp-preview")?.textContent).toContain("safe_z = 31.5");
        click(root, "Make profile");
        await settle();
        await settle();
        await settle();
        const listing = await backend.devices();
        expect(listing.devices.map((device) => device.id)).toContain("openpnp-import");
        const file = await backend.deviceFile("openpnp-import");
        expect(file.document.safe_z).toBe(31.5);
        expect(file.document.top?.offset).toEqual([23.544, 65.188]);
        root.remove();
    });
});
