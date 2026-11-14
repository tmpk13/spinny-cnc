# Questions

## Q1. Should a press outside a pop-up also press what is under it?
Why it matters: the new circle-with-x pointer says a press there only closes the menu or sheet; before, the same press also pressed the button under it (Run, a jog, Test beam).
- A. Only close it (recommended): the pointer tells the truth and nothing starts by accident; the buttons that stop something (Stop, Hold, Abort, Cancel, Reset, Laser off, Stop spindle) still take the press.
- B. Close and press, as before: one press saved, but the x pointer then says less than happens.
Applied: A, in 63473f8 and f310200.
Answer:

## Q2. Which fonts should the page use?
Why it matters: "Better fonts" is taste; the page must also read the same with no network.
- A. Inter for text and JetBrains Mono for numbers, served with the page (recommended): made for screens, clear digits, offline.
- B. IBM Plex Sans and Plex Mono, served with the page: a more technical look.
- C. The system's fonts, as before (also a switch in the page settings' Look).
Applied: A, in 63473f8.
Answer:

## Q3. Which parts of panels start as stacked panels of their own?
Why it matters: "Break off more submenus into stacked panels by default" could reach much further.
- A. The folds inside panels (recommended): each camera's Picture controls and Lens and colors beside its camera, the centering and calibration tests as a Tests panel beside Align.
- B. A, and whole panels stacked by default too (Job JSON with Console, Laser with Markers, Camera view with Find board).
Applied: A, in beb971e and c48af5a.
Answer:

## Q4. May Auto turn on a plugin it wrote?
Why it matters: a plugin runs with the page's full power, the machine's moves included.
- A. No (recommended): Auto writes plugins off; only the operator's press in the Plugins tab, after a warning, turns one on, and a rewrite turns it off again.
- B. Auto may turn on its own plugins: one step less, and the model then reaches every route the page does.
Applied: A, in e1944d5.
Answer:

## Q5. "Draw circle around know point on" what?
Why it matters: the line in TODO.md was cut off.
- A. The camera pictures (recommended): a ring and a label around each point whose place is known (Align marks, fiducials, markers, corners, the homing fiducial, the nozzle over the bottom camera).
- B. The board preview: the same points ringed on the Jobs page's preview.
Applied: A, in be4bf97.
Answer:

## Q6. How many servos should the board drive?
Why it matters: each slot is seven firmware settings and a bar in the jog panel; a PCA9685 has sixteen channels.
- A. Four (recommended): servo.1 to servo.4, enough for a pen, a shutter, a probe and a gate; the settings list stays short.
- B. Eight: twice the settings (59 more instead of 31) and a longer stored blob version.
- C. Sixteen, a whole PCA9685: suits a bank of servo feeders, at 112 servo settings.
Applied: A, in b318e42.
Answer:

## Q7. What should a reset, an alarm or a disconnect do to a servo?
Why it matters: a servo holding a tool clear of the work drops it if its pulse stops; one mid-move keeps going if it does not.
- A. Leave it where it is (recommended): only a `servo` line or Off moves it; a reset stops motion and the beam, not the servos.
- B. Let it go: no pulse after a reset, so it can be turned by hand, and a gravity-loaded arm falls.
- C. Send it to its start angle, as at power on.
Applied: A, in b318e42.
Answer:

## Q8. Should the laser and tool outputs refuse the STOP headers' pins too?
Why it matters: GP3, GP4, GP16 and GP25 reach the chip through a 74LVC2G34 input buffer; `[output] pin = 4` would drive the laser PWM against that buffer's output. The servos and the I2C bus now refuse them; the laser and tool pins never did.
- A. Refuse them in machine files only (recommended): a file naming one is refused with the reason; the firmware keeps reading a stored setting that has one, so nothing already saved is thrown away.
- B. Refuse them in the firmware as well: also catches the console, but a board with such a setting stored would come up with every setting at its default, wiring included.
- C. Leave them as they are.
Applied: A, in 16bce86.
Answer:

## Q9. Should the page's in-page mock backend be retired?
Why it matters: `web/frontend/src/mock/` is 19.2k lines, a third of the page's source. It reimplements the backend and the firmware in TypeScript, so every backend change is made twice, five fixture tasks exist only to check the copies, and 40 of the 79 page test files run on it. Retiring it changes how `?mock=1`, the layout checks and the screenshots run.
- A. Retire it (recommended): `mise run demo` serves the real backend with the virtual firmware and the virtual LumenPnP, which the layout checks and screenshots then use; view tests use typed fake answers; `src/mock/` and the five fixture tasks are deleted.
- B. Freeze it: it keeps what it does today but gets nothing new, and newer routes answer "not in the mock".
- C. Keep it in step with the backend, as now.
Applied: nothing yet. docs/RESTRUCTURE.md assumes A in phase 3; phases 0 to 2 are the same either way.
Answer:

## Q10. How should Upright turn a camera's picture?
Why it matters: a camera mounted upside down showed its picture upside down, and drags went against what the eye expects. Upright is on by default, so its rule changes every camera's view, the bottom camera's included (it looks up, so the backend counts it mirrored).
- A. By the roll to the nearest quarter turn, flipped when mirrored (recommended): no new setting; screen right is +X and up is +Y on every camera, as on the jog pad; the bottom camera's picture shows a part as from above.
- B. By the roll only, never flipped: the bottom camera keeps showing what it sees from below.
- C. A turn of its own per camera (0, 90, 180, 270), apart from the roll: free to differ from the machine's directions.
Applied: A, in ff3183b.
Answer:

## Q11. What should a panel folder be?
Why it matters: stacks were already drawn as folders, so "Panel folders" may have meant something else.
- A. A named group of panels in a box whose head folds, renames and moves it as one; panels go in or out from their menu or by a drop (recommended): stacks stay as they are.
- B. A per-page list of named folders, like a sidebar, showing a folder's panels when opened: another way of moving around, more work.
Applied: A, in 2987645.
Answer:

## Q12. Is the new default arrangement of panels the one you want?
Why it matters: a layout already kept in a browser stays as it was until Reset in the page settings.
- A. A Camera folder on Jobs; Bottom camera, Top camera and Machine folders on PNP; the Placing panel under the steps (recommended): camera panels fold away in one press and little else moves.
- B. A bigger change, for example the Console in the left column and Height map, Align and Tests in a folder of their own.
Applied: A, in bdd512a.
Answer:

## Q13. Colors: one per page, or one per panel?
Why it matters: "colors for panels" may mean each panel has its own color.
- A. One Solarized color per page, on its tab's underline and along the top edge of its panels and folders, with a page setting to turn it off (recommended): a tab and its panels match.
- B. Each panel or folder gets its own color, picked from its menu.
Applied: A, in 136e99a.
Answer:

## Q14. Which hidden content should the page point out?
Why it matters: the marks add a little to every held panel and every long column.
- A. A fade with "more below" at the foot of a held panel or a column with panels below, a shadow under a head with content scrolled under it, "folded" beside a folded panel's name, a count on the eye of hidden panels (recommended).
- B. All of A, plus a thin placeholder with Show where a hidden panel sits.
Applied: A, in 25fc3a8.
Answer:

## Q15. Which - and + should be part of the box?
Why it matters: number fields have no stepper buttons; the camera zoom's were the only - and + beside a field.
- A. The zoom's - and + become the ends of its box, through a reusable stepperBox helper (recommended).
- B. Every number field gets - and + inside its box: this takes width in every row.
Applied: A, in a6f8dca.
Answer:

## Q16. Should PageUp and PageDown ever scroll the page?
Why it matters: the page can no longer be paged through with the keyboard.
- A. Never, except in a text area or a dropdown (recommended).
- B. Blocked only while the shown page's jog panel uses them as jog keys.
Applied: A, in c3a86d8.
Answer:

## Q17. Which version should the top bar show?
Why it matters: the long text it showed was most likely a G-code machine's answer to M115, which was not seen on the real machine.
- A. The firmware's first word and version number (Marlin 2.1.2), the whole answer on hover (recommended).
- B. Also this program's own release version in the top bar.
Applied: A, in 214c76f.
Answer:
