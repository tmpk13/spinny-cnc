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

## Q18. Should the cameras' `roll` key be renamed?
Why it matters: operators look for "rotation" or "turn", but `rotation` already names a feeder's part angle and the G-code rotation axis letter.
- A. Keep `roll`, found by rotation, turn and angle in the settings search (recommended): no file changes, no clash between names.
- B. Rename it to `turn`, still reading `roll`: the file uses the operator's word, but old files carry two names for one key.
Applied: A, in b261de4.
Answer:

## Q19. When should a G-code machine file's camera keys reach the cameras?
Why it matters: the PNP tab can also change a camera's device, and the file's value wins at whatever moment is chosen.
- A. When the machine connects (recommended): the cameras come with the machine, as Write to board does for `[camera]`; a device picked on the PNP tab lasts until the next connect unless written into the file.
- B. Only when Use this machine is pressed: a reconnect keeps what the PNP tab set.
- C. As defaults where the tab has set nothing: once the tab sets a value, later edits to the file do nothing.
Applied: A, in b84c583.
Answer:

## Q20. What should Use this machine do for a board file when nothing is connected?
Why it matters: the button can connect the board itself, or only remember the choice.
- A. Connect the board's port when it is listed, then Write to board, which asks first (recommended): one press reaches the machine and nothing is written unasked.
- B. Only remember the file as the one in use; connecting and writing stay with the Connection tab and Write to board.
Applied: A, in 78eda0d.
Answer:

## Q21. Should a release's CAM profiles be offered the way its machine files are?
Why it matters: copies of `cam/*.toml` never get a newer release's changes either.
- A. Machine files only for now (recommended): the item named configs; the merge module can take CAM profiles later.
- B. CAM profiles too, offered on the CAM tab.
Applied: A, in 7739e33.
Answer:

## Q22. How should an OpenPnP part's height go into the machine file?
Why it matters: OpenPnP places a part at the board height plus the part height; these files have one `place_z` per machine or per feeder.
- A. Set a feeder's `place_z` to the job's board height plus the part height, only when a job is imported with it (recommended): no new key; without a job only the size and a comment come in.
- B. A new feeder key `height` that a run adds to `[motion] place_z`: works without a job, but `place_z` then means the bare board top.
Applied: A, in 106a2a8.
Answer:

## Q23. What should a G-code machine file that does not say `seesaw` do?
Why it matters: on a seesaw Z (the LumenPnP) a nozzle above the safe height is the other one hanging down; on a plain Z it is just a nozzle held up, which "Nozzle is going down for most operations" asked to keep up.
- A. As before: moves across come to the safe height from either side, jogs go where sent (recommended, safe for a seesaw nobody marked); a plain Z says `seesaw = false` to keep a high nozzle up, a seesaw says `true` to also stop Z jogs at the safe height (the shipped LumenPnP and virtual files do).
- B. Plain by default: a high nozzle stays up unless the file says `seesaw = true`; a hand-made seesaw file that leaves it out crosses with its other nozzle down.
Applied: A, in 8143332 (the PNP agent had applied B in bd8ff6c).
Answer:

## Q24. On a seesaw, should a Z jog stop at the safe height?
Why it matters: "N1 up" pressed past 31.5 lowers N2, which is why every move across then brought Z back down.
- A. Stop at it; a goto to a height above it still lowers N2 (recommended).
- B. Let jogs pass it as before.
Applied: A, in bd8ff6c.
Answer:

## Q25. Where should the picked part's shape be drawn on the top camera's picture?
Why it matters: about the crosshair it is a stencil for Camera here; where the board's place puts the part, it shows how far that place is off.
- A. About the crosshair (recommended): jog until the part fills it, then Camera here.
- B. Where the board's place puts the part.
- C. Both, in two colors.
Applied: A, in a39a849.
Answer:

## Q26. What should Shift and Ctrl picks in the Feeders panel act on?
Why it matters: the item could mean the feeder list or the scan's results.
- A. The feeder list: Scan looks for just the picked feeders by id (recommended).
- B. The scan's results: Keep slot and Slot here act on several at once.
Applied: A, in 33001e0.
Answer:

## Q27. Should Clear corners also forget the corners kept as references?
Why it matters: after Clear corners, Go to part loses the place they gave.
- A. Yes, a corner is forgotten everywhere; Use as board place makes references that outlast it (recommended).
- B. No: they stay until dropped in Board on the machine.
Applied: A, in 2109862.
Answer:

## Q28. Should a machine file name more bed fiducials than the homing one?
Why it matters: "Machine Fiducial finding on machines that support it": several would let a fiducial home also check the axes' scale and squareness.
- A. No, one homing fiducial, as OpenPnP and the LumenPnP have; Home by fiducial now works on the virtual LumenPnP and Find home fiducial corrects without homing (recommended).
- B. Yes: `[top_camera] fiducials = [...]`, found after the home fiducial, the fit's turn and scale reported (not built).
Applied: A, in ab08d9c.
Answer:

## Q29. How should the crosshair's size be set?
Why it matters: "Resize crosshair" names no unit.
- A. A share of the view, from a menu: a fortieth, a tenth or a quarter of the view, or across it; one size on screen at any zoom, before the scale is measured too (recommended).
- B. Millimeters on the machine: a circle the size of a nozzle tip or fiducial; needs the scale and grows with zoom.
Applied: A, in 0a7054f.
Answer:

## Q30. Should a routine's marks follow the machine by default?
Why it matters: the TODO line asks for a toggle but not where it starts.
- A. Follow: a found spot stays over what it marked as the head jogs (recommended).
- B. Stay fixed to the picture, as before.
Applied: A, in d6a2eb7.
Answer:

## Q31. What should the edge view show?
Why it matters: "Edge view" could mean the lines Corner by edges uses, or a whole edge-detected picture.
- A. pcbv's straight edges drawn over the picture: what Corner by edges reads, no pcbv change (recommended).
- B. An edge-detected picture, every edge pixel: pcbv would have to send such a frame.
Applied: A, in e3c59b9.
Answer:

## Q32. Should Corner by edges be logged even with the camera log off?
Why it matters: other routines are logged only while it is on; search records always are.
- A. Only while the log is on, like the other routines (recommended).
- B. Always, like search records.
Applied: A, in 8943444.
Answer:

## Q33. What is the top camera's nozzle box for?
Why it matters: the TODO line asks for a box but not what uses it.
- A. A hand-drawn mark of where the nozzle shows in the picture, drawn over it; nothing else reads it (recommended).
- B. A region the vision ignores (a nozzle in view confusing the finder): pcbv would have to skip a box.
- C. A rough nozzle offset for Measure offset's first look.
Applied: A, in 476acb2.
Answer:

## Q34. Where should part size classes be defined, and is a circle crop enough?
Why it matters: classes set the crop every run uses, and pcbv's spot finder takes only a radius about the picture's center.
- A. `[[part_class]]` in the G-code machine file, each with a circular crop in mm (recommended): beside the feeders and `[up_camera] crop`, edited in the Config tab, works with pcbv as it is.
- B. In the bottom camera's settings, a table on the page; or crops as boxes drawn on the picture (pcbv would have to take a box).
Applied: A, in 5f0cfed.
Answer:

## Q41. What shape should a camera's crop for a task be?
Why it matters: each task (board look, spots, edges, Measure camera; nozzle, part) looks only inside its crop, kept in the machine file and drawn on the picture.
- A. A box in shares of the picture, x0 y0 x1 y1 from its top left (recommended): any part of the picture, drawn by a drag, kept across capture sizes; pcbv clips its spots, edges and board features to it.
- B. A circle about the picture's center, in mm, as the bottom camera's part crops are: simpler, but a task can only look at the middle.
Applied: A, in 7bc130c and fdaa98c (pcbv d75f4c0).
Answer:

## Q44. Should color mean only a state?
Why it matters: a stale height map or an alarm stands out only if little else is colored (docs/UI_PRINCIPLES.md, principle 6).
- A. Color only for states (recommended): "Colors for tabs and panels" off by default, the next action's button dark, blue only while working, yellow needs you, red danger, green done.
- B. Keep each page's color on its tab and panel edges by default, with the state colors on top.
Applied: A, built in 947e6f3: the pages' colors are off unless turned on in the page settings, the next action is ink, a choice that is on is drawn pressed, red fills only what stops the machine.
Answer:

## Q45. Should Plot, CAM's profile pick and Auto become ways to make a job inside Job?
Why it matters: four tabs make jobs today, each with its own preview, and Plot its own run.
- A. One New job: Open a file, Draw it (the Plot operations), Describe it (the assistant); profiles edited on the Setup side; Auto a drawer on any screen (recommended).
- B. Keep Plot, CAM and Auto as areas of their own on the rail.
Applied: A, in part, in 947e6f3: Jobs, Draw, Assistant and JSON are views of the Job area, one shown at a time beside the one preview; the CAM profiles stay a Setup page.
Answer:

## Q46. One step level (Fine, Normal, Coarse) for every axis, mapped per axis in the machine file?
Why it matters: the jog panel holds six step choosers today, one per axis, repeated on Plot and PNP.
- A. One level for every axis, each axis's step for it set in [controls]; a custom step per axis in the dock's More (recommended).
- B. Keep a chooser per axis, folded into the dock's More.
Applied: A, built in 947e6f3 without new keys: Fine is an axis's smallest step choice in its file, Normal the one it starts on, Coarse its largest; a step typed for one axis is under the jog's More.
Answer:

## Q47. What should the panel layout layer become once each step shows only its own panels?
Why it matters: folders, stacks, side by side, named layouts and peeking are code to keep and things to learn, built while every panel showed at once.
- A. Keep it behind Edit panels in Settings, for arranging a step's panels by hand (recommended): nothing lost, out of the way.
- B. Retire it once the screens fit their budget: less code, and every page looks as the docs say.
Applied: A, in 947e6f3: the layout tools arrange an area's All panels view; a step or another view has its panels in set places.
Answer:

## Q49. When the Setup side is open in another tab behind this one, where should a Setup link go?
Why it matters: with both sides in tabs of one window, the other tab is out of sight, and a browser rarely lets a page bring itself to the front (docs/UI_SPLIT.md, Links).
- A. To that tab, with a toast here saying so and a Show here button (recommended): the tab kept for setup stays the one setup happens in; a press on the toast brings it here instead.
- B. Here, unless the other tab is in view (a second window beside this one): no tab to go looking for, but both tabs can end up on the Setup side.
Applied: A, in 46611f5.
Answer:

## Q50. May a routine measure a Setup value again by itself, moving the machine to do it?
Why it matters: keeping values checked is the last step to a machine that sets itself up (docs/UI_SPLIT.md, Toward a machine that sets itself up), but a routine that moves the machine on its own can hit a clamp or a part left on the bed.
- A. Only on a press; checks that move nothing (a look, the firmware's answer at connect) may run by themselves and mark a value stale (recommended): nothing moves unasked.
- B. Quick moving checks too (Find mark over the camera's mark) at connect or before a run, after a confirm that names them.
- C. Each value's own setting, in its machine file.
Applied: none yet; nothing built re-measures by itself, and a moving check waits for an answer.
Answer:

## Q53. Where should the next import's settings (power, speed, spot, anchor, offset, layer, mirror, board mode, clear copper) go?
Why it matters: they sit above the job list and look like the selected job's settings, but only an upload reads them; the selected job's own power, speed and offset are further down under other names.
- A. Into the dialog a dropped file opens (the layer chooser), filled from the last import, so the Jobs panel is only the list (recommended).
- B. Keep them in the Jobs panel under a heading "For the next import".
Applied: A, in the plan (docs/UI_PANELS.md); nothing built yet.
Answer:

## Q54. Where should the firmware repository live on GitHub?
Why it matters: the firmware moved to its own repository, spinny-firmware, checked out beside this one; this repository's docs link its protocol and pin table by web address, and those links work only once it is pushed there.
- A. github.com/tmpk13/spinny-firmware, public like spinny-cnc (recommended): the links as written work after the first push.
- B. Another name or owner: the links and the checkout's origin change to it.
- C. Private: readers of spinny-cnc on GitHub get a 404 on the protocol; it would then be better back in this repository as a copy.
Applied: A: origin set to git@github.com:tmpk13/spinny-firmware.git in the new checkout; nothing pushed.
Answer:

## Q55. Should the Run area open on its steps, or on all its panels?
Why it matters: a step shows the work and one panel; someone who knows the page may want every panel at once, as before (docs/UI_VISUAL.md).
- A. On its steps (recommended): a screen holds one thing to do; All panels is one press away and stays once pressed.
- B. On all panels, the steps one press away.
Applied: A, in 947e6f3.
Answer:

## Q56. Should the rail list both sides' areas, or swap between the sides?
Why it matters: on 2026-11-15 the sides were built to swap, the other side's areas folded away behind its name; listed, every area is in sight and one press away, for five more lines in the rail.
- A. List both under their names (recommended): no navigation is hidden; `\` and Side by side work as before, and a side's name is a heading there, a button only on a narrow window.
- B. Swap as before: a shorter rail while working on one side.
Applied: A, in 947e6f3 (the names as headings in d4dee4e).
Answer:

## Q57. Should a run wait until the board's place is confirmed?
Why it matters: the page cannot tell whether the board was placed (a job's offset always has a value), so the Board step is never ticked and Run does not wait for it; a job run at the wrong place cuts the wrong copper.
- A. No wait (recommended): the Run panel says where the job sits, with a link to Board; nothing more to press on every run.
- B. A press of "The board is placed" on the Board step for each job picked, which ticks the step and unlocks Run.
Applied: A, in 947e6f3.
Answer:

## Q58. Should buttons and fields be smaller with a mouse?
Why it matters: every control was 2.75rem tall, a finger's size; at that size six number fields took a quarter of a column.
- A. 2.25rem with a mouse, 2.75rem on a touch screen (recommended): more of a step fits without a scroll; the jog's moves stay 2.5rem.
- B. 2.75rem everywhere: larger targets at the machine with a mouse too.
Applied: A, in 947e6f3.
Answer:

## Q59. Where should a job's icon be set from?
Why it matters: a press on a job's drawing used to open the icon picker, which made every row of the list three buttons and a box; a row is now one button (the job) and Delete.
- A. From Icon under the list's More, for the picked job (recommended): the list reads as a list; the picker is two presses away.
- B. By a press on the picked job's drawing: one press, and the picked row has a button the others do not.
Applied: A, in d4dee4e.
Answer:

## Q60. Should the firmware key list open on the keys that differ, or on every key?
Why it matters: the Machines page's Keys view listed 160 keys with their help, 17 screens long; where the file and the board differ is what asks for a decision.
- A. On the differences (recommended): three rows instead of 160; "only differences" unticked shows them all, and a search looks through every key either way.
- B. On every key, as before: the whole reference at once, the differences marked among them.
Applied: A, in d4dee4e.
Answer:

## Q61. May the next session on the LumenPnP lower N1 over the bottom camera to take pictures for the nozzle finder?
Why it matters: finding the nozzle's center is bad (TODO.md) and no picture of a tip is kept, so nothing can be graded or built against; it needs about 30 pictures (three head places a few millimeters apart, six turns, two heights) at the place found on 2026-11-14 (241.98, 217.10), Z 4, where N1 was lowered once with your approval.
- A. Yes, at that place and height, after the top camera has looked at it (recommended): the same move as before, and the look first is the rule since the tape incident.
- B. Yes, but I lower the nozzle myself and say when: no Z move by the program.
- C. No: the finder stays as it is.
Applied: nothing; no Z move is made without an answer.
Answer: yes

## Q62. Which of the jog's rows should stay folded under More?
Why it matters: you asked for Home's items out of that fold; Home, Unlock and Motors came out, and each row shown takes height from the work while the dock is open.
- A. Zero here, go to, set position and the feed stay under More (recommended): they are used now and then, and the open dock stays about a third of the window.
- B. Everything out, no More in the jog: all in sight once Jog is pressed, and the dock scrolls on a small window.
Applied: A, in ba0f813.
Answer:
