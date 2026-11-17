// The budget of a screen, as a check: `mise run test-budget`. Every screen
// in its first view, as it opens with nothing folded open or scrolled,
// holds at most 40 controls and 200 words, the frame included (principle
// 13 of docs/UI_PRINCIPLES.md). The screens are the shots of a JSON list
// (docs/ui/budget.json unless another is named; shots.ts says what a shot
// may hold): every area, every view of it, with each kind of machine. A
// screen over the budget fails the check, with where its load is, panel by
// panel: what to move into another layer.
//
// A shot may carry its own ceiling with the reason it is allowed one:
//
//     { "name": "...", "budget": { "controls": 48, "why": "..." } }
//
// which is then the most it may hold, so a screen let over does not grow.

import { isAbsolute, resolve } from "node:path";
import { takeShots, type Shot } from "./shots.ts";

/** The most a screen's first view holds, frame included. */
export const CONTROLS = 40;
export const WORDS = 200;

type Budgeted = Shot & { budget?: { controls?: number; words?: number; why: string } };

const here = process.env["MISE_ORIGINAL_CWD"] ?? process.cwd();
const specArg = process.argv[2] ?? "../../docs/ui/budget.json";
const specPath = isAbsolute(specArg) ? specArg : resolve(process.argv[2] ? here : process.cwd(), specArg);
const shots: Budgeted[] = JSON.parse(await Bun.file(specPath).text());
const measured = await takeShots(shots.map((shot) => ({ ...shot, measure: true })), null, () => {});
const over: string[] = [];
console.log("| Screen | Controls | Words |");
console.log("|---|---:|---:|");
for (const { name, said } of measured) {
    const own = shots.find((shot) => shot.name === name)?.budget;
    const controls = own?.controls ?? CONTROLS;
    const words = own?.words ?? WORDS;
    console.log(`| ${name} | ${said.controls} | ${said.words} |`);
    if (said.controls > controls) {
        over.push(`${name}: ${said.controls} controls in its first view, over ${controls}: ${said.controlsBy}`);
    }
    if (said.words > words) {
        over.push(`${name}: ${said.words} words in its first view, over ${words}: ${said.wordsBy}`);
    }
}
if (measured.length !== shots.length) {
    over.push(`${shots.length - measured.length} of ${shots.length} screens were not measured`);
}
if (over.length > 0) {
    console.error(`\nover the budget (docs/UI_PRINCIPLES.md, principle 13):\n${over.join("\n")}`);
    process.exit(1);
}
console.log(`\nbudget: ok, ${measured.length} screens within ${CONTROLS} controls and ${WORDS} words`);
