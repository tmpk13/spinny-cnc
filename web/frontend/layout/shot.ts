// Screenshots of the page over its in-page mock in Chromium, to see a
// change as it looks: `mise run shots -- SPEC.json OUTDIR`. The spec is a
// JSON list of shots (shots.ts says what a shot may hold); each is
// OUTDIR/NAME.png. A shot that asks to be measured has what its first view
// holds printed (with the controls and words panel by panel), and all of
// them as one table at the end. Paths are taken from where mise was run.

import { isAbsolute, resolve } from "node:path";
import { measureTable, takeShots, type Shot } from "./shots.ts";

const here = process.env["MISE_ORIGINAL_CWD"] ?? process.cwd();
const [specArg, outArg] = process.argv.slice(2);
if (!specArg || !outArg) {
    console.error("usage: shots SPEC.json OUTDIR");
    process.exit(2);
}
const specPath = isAbsolute(specArg) ? specArg : resolve(here, specArg);
const outDir = isAbsolute(outArg) ? outArg : resolve(here, outArg);
const shots: Shot[] = JSON.parse(await Bun.file(specPath).text());
const measured = await takeShots(shots, outDir);
for (const { name, said } of measured) {
    // Where the first view's load is, panel by panel: what to thin when a screen is over its budget.
    console.log(`${name}: controls: ${said.controlsBy}`);
    console.log(`${name}: words: ${said.wordsBy}`);
}
if (measured.length > 0) {
    console.log(`\n${measureTable(measured)}`);
}
