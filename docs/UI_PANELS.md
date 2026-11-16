# Rearranging the panels

[UI_REDESIGN.md](UI_REDESIGN.md) says where each panel goes in a new frame
(rail, steps, dock). This plan sorts what is inside the panels, so that each
control has one home and a panel is about one thing. Every step below can
ship inside today's tabs, before any of the frame, and is work the redesign
needs anyway: once the contents are sorted, its phases mostly move finished
panels. Nothing here is built; the open choices are in
[QUESTIONS.md](../QUESTIONS.md) (Q51 to Q53), and the plan applies the
recommended answer to each.

The contents were read on 2026-11-16 over the mock, connected to the polar
laser (and to the LumenPnP for the PNP page), with
`mise run shots -- docs/ui/panels.json var/ui-panels`, which prints every
panel's headings, fields, buttons and text in page order.

## What is scattered

The page has 61 panels: 52 on the Use side (18 on Jobs, 21 on PNP with a
LumenPnP) and 9 on the Setup side. One concern is often spread over several
of them:

| Concern | Where it is today | Homes |
|---|---|---:|
| Power, speed, spot | Jobs (fields for the next import), the selected job's group table and Spot width, Laser (test beam's Power S), Plot's Operation | 4 |
| Where the board sits | Jobs (Anchor, Offset x and y for the next import), the selected job (Offset, Move, Turn), Find board (look, corners, features), Align (marks), Board on the machine (references, fiducials), Machine view (board area) | 6 |
| Which side is up, the finish | Jobs (Layer, Mirror), Camera (Side, Finish), Top camera (Side, Finish, Paste), Parts (Side filter) | 4 |
| Going somewhere | Jog (board Go, joint Go, Center), Markers (Go), Parts (Go to part), Head (Park, Nozzle over camera, Nozzle to camera spot, Camera to nozzle spot), Nozzle (Nozzle over camera) | 5 |
| Zero, position, homing | Jog (Set R=0 here and three more, Here is with Set position and Last known, Home), Height map (Probe here: set H 0), Top camera (Home by fiducial, Find home fiducial) | 3 |
| Height and focus | Jog (Travel H), Height map (map, Focus offset, Focus here, Rayleigh), Run (the map's mode), Setup steps 3 to 6 | 4 |
| Run, hold, stop | Run, Plot's Run, Placing, Console (Hold !, Resume ~, Reset) | 4 |
| Starting a camera | Camera (Start, Stop, device), Camera view (the picture, "start it in the Camera panel"), Find board (which camera, "start it in its panel") | 3 per camera |
| Calibrating a camera | Camera (offset, roll, mm per px, Find mark), Top camera (Measure camera, Nozzle on mark, Measure offset), Bottom camera (its place, Center nozzle, Measure runout), Nozzle (mm per px, roll, mirrored, Center nozzle, Look at part), Head (nozzle and camera moves) | 5 |
| Logging looks | Log every look, Photo and Clear log, marked "all cameras", in each of the three camera panels | 3 copies |
| Machine file values on Use pages | Head (Tune the machine file: heights, feeds, dwells, vacuum), Find board (Write skew to machine file), Camera (offsets to "copy into the machine file"), Machine view (board area, picture, model), Feeders ("add tables on the Config page") | 5 |
| Opening a board | Jobs (drop, pick a file), Parts (Board job, Upload board), Board (Open a board), CAM (pick files), Plot (New job) | 5 |
| Whole panels copied | Position, Jog and Markers on Jobs and Plot, Jog again on PNP; Preview on Jobs, Plot and CAM; Find board on Jobs and PNP; Run on Jobs and Plot | 10 copies |
| Page things among machine things | Version and Bug reports sit on Config beside the machine file; Use this machine (Config) and the port (Connection) are two pages apart | 2 |

Two of these mislead rather than just crowd:

- **The Jobs panel's fields are for the next import.** Power S, Speed,
  Spot, Anchor, Offset, Layer, Mirror, Board and Clear copper sit between
  the drop area and the job list and look like the selected job's
  settings, but only an upload reads them (`uploadOptions` in
  web/frontend/src/views/jobs.ts). The selected job's own power, speed,
  spot and offset are further down, under other names.
- **"Power S" means three things**: the test beam's power (Laser), the next
  import's power (Jobs), and a group's power (the selected job's table).

Instructions crowd the rest: Find board shows 285 words before any press
plus a 255-word fold, Height map 191, the Camera panel 133 plus a 200-word
fold, Lens and colors a 172-word fold. The setup steps send the reader
elsewhere ("Upload or pick a job in the Jobs panel"; "Press Home in the Jog
panel, or Home by fiducial in the Top camera panel") instead of holding the
action.

The largest panels, in controls and words in view:

| Panel | Controls | Words |
|---|---:|---:|
| Settings (Config) | 325 | 3,074 |
| Jog (and its copies) | 66 | 159 |
| CAM | 43 | 186 |
| Height map | 33 | 191 |
| Camera | 26 | 133 |
| Plot's Operation (63 with its hidden fields) | 21 | 64 |
| Find board | 20 | 285 |
| Head | 20 | 30 |

## Rules for what goes in a panel

1. **One home per control.** A control or a value is in exactly one panel.
   Anywhere else it is one line of state with a link to its home, as the
   Setup links do today ([UI_SPLIT.md](UI_SPLIT.md#links)).
2. **With the thing it changes.** A control lives in the panel of the thing
   it changes, not of the routine that happens to use it: the board's side
   belongs to the job, not to a camera; Home by fiducial is a way to home,
   not a camera feature; logging looks belongs to all cameras, so it is
   one switch.
3. **Set once per machine: the Setup side**
   ([principle 14](UI_PRINCIPLES.md#14-use-and-setup-are-two-sides)). A
   Use panel shows such a value as a line with a link, and the Checklist
   says where it came from.
4. **One component, mounted where needed.** A panel shown on two pages is
   the same panel with one state, not a copy with its own fields
   ([principle 10](UI_PRINCIPLES.md#10-one-set-of-machine-controls)).
5. **One shape.** Title (a noun, one or two words); one line of state;
   an action row with the one next action dark
   ([principle 3](UI_PRINCIPLES.md#3-one-next-action)); the main fields;
   More for the rest, in place. No paragraphs: meanings on hover, how-to
   in the guide ([principle 8](UI_PRINCIPLES.md#8-one-line-of-state-meaning-on-hover-how-to-in-the-guide)).
6. **A budget per panel.** At most 10 controls and 40 words in view before
   any press, so three panels and the folded machine bar fit a screen's 40
   controls and 200 words ([principle 13](UI_PRINCIPLES.md#13-a-budget-measured)).

## The panels after

### Use side: 13 panels in place of 52

| Panel | Holds, in order | Takes from today |
|---|---|---|
| **Machine** | position in this machine's axes, motors, queue; the jog pad and one step level; quick bar (Test beam, Laser off, Spindle, Light, Vacuum, from the machine file's `[controls]`); More: Go to (a point, a marker, a part, a camera, Park), markers, Set here (zero per axis, Last known), Home (switches, by fiducial), Motors, Unlock, feed | Position, Jog, Laser, Spindle, Markers, PNP jog, Head (Light, Park, Vacuum, the moves), Top camera (Home by fiducial) |
| **Jobs** | the list with thumbnails; Open (a file), Draw, Combine; each job's menu: Save, Duplicate, Delete, Edit as JSON, Export G-code | Jobs (list, drop), Job JSON, CAM (Make a job, Export gcode), Plot (New job), Parts (Board job, Upload board), Board (Open a board) |
| **Job** | the selected job: length, time, size; its groups (power, least power, speed, passes, focus, on), the one place for power and speed; Board (mode, clear copper, layer, side, finish, paste); More: paths (move to group, array, delete), another width, stencil margin, laser mode | the selected job's part of Jobs, Camera and Top camera (Side, Finish, Paste), Laser (mode), Plot's Operation as the editor of a drawn group |
| **Preview** | the canvas; 2D or 3D, Fit, View menu (heights, grid, box select, speed, top view, turns, reset, trail, lock rotation); the cut order slider | Preview, Plot's and CAM's copies |
| **Board place** | where the board, and so the job, sits on the machine: its place and how it was found ("by camera, two agree", "by 3 marks, 0.04 mm"); Look for board, Stop search; sections from rough to exact: by hand (anchor, offset, turn), by camera (search, full scan, threshold and method in More), by corners, by features, by marks, by references and fiducials | Find board (both copies), Align, Board on the machine, the next import's Anchor and Offset, the selected job's Offset, Move and Turn |
| **Height** | travel height; the map (area, points, Fit to job, Probe, Probe pads, tie by Probe here or Probe nearest); focus (Focus here, offset, Rayleigh); how the run uses the map; More: probe settings, Save, Load, Clear | Height map, Jog (Travel H), Run (the map's mode) |
| **Camera** | which camera, Start and Stop on the picture, Look once; the picture; its View menu (zoom, turn, upright, overlay, edges, marks, crops, views, search box); picture controls in a pop-up; the Undo row | Camera view and its PNP twins, Camera, Bottom and Top camera (Start, Stop, Look once), Picture controls |
| **Run** | the job, time left, and the run's modes in words (map, laser mode, travel height, focus); Run, Hold, Resume, Stop, the same for every machine; More: pick up at a line, Plan, Download; for pick and place: run the rest, run a window, repeat, find fiducials first, count feeders again | Run, Plot's Run, Placing, Console (Hold, Resume) |
| **Parts** | the board from above with its parts (picked, placed, to place); one search by reference or value; the side filter; the table; More: leave out, group, parts kept out | Parts, Board |
| **Feeders** | what is loaded, low or missing; Scan bus | Feeders (its slots move to Setup, Bed) |
| **Steps** | the machine's steps; each line's button does the step or opens its panel | Setup steps, PNP steps |
| **Console** | folded: the lines, a command line, Status, Reset, Clear, Log, Wire, polls | Console without Hold and Resume |
| **Assistant** | the chat; what it can do as a hover and a guide page | Auto, What it can do (provider and model to Setup, Page) |

### Setup side: 9 panels, sorted

| Panel | Holds | Takes from today |
|---|---|---|
| **Checklist** | as built, each value with its source and a link | Checklist |
| **Tests** | the centering and calibration test burns | Tests |
| **Machines** | the machine files, Use this machine, the port and Connect, Add a machine (new, copy, from OpenPnP), the file editor | Machine file, Connection, Import from OpenPnP |
| **Firmware** | the settings table (differences only by default), Write to board, Read from board, Save to flash | Settings, Machine file (Write, Read, Save to flash) |
| **Cameras** | for each camera of this machine: device, size, fps, Detect; place and scale (offset, roll, mm per px, mirrored, the bottom camera's place); spots (nozzle, part, mark); lens and colors; crops; the routines (Find mark, Make mark, Mark is here, Measure camera, Nozzle on mark, Measure offset, Center nozzle, Measure runout, Look at part); changes with Undo. Once for all cameras: Log every look, Photo, Clear log, the search records | Camera, Bottom camera, Top camera, Nozzle, Lens and colors, Camera changes |
| **Head** | Safe Z, Place Z, feeds, dwells, vacuum thresholds, Read vacuum | Head (Tune the machine file, Read vacuum) |
| **Bed** | the board area, the machine's picture and model, the home fiducial, the axes' skew, the feeder slots | Machine view, Top camera (Find home fiducial), Find board (Write skew), Feeders' slots |
| **CAM profiles** | a profile's axes, tools and operations, and its file | CAM, Profile file |
| **Page** | look, layouts, Version and updates, Bug reports, Plugins, the assistant's provider and model | Version, Bug reports, Plugins, Auto (provider, model), the gear's sheet past its quick options |

### Names

Panels that stay keep their name. The new and changed names, chosen to say
what the panel is about in one or two words:

| Today | After |
|---|---|
| Position, Jog, PNP jog, Laser, Spindle, Markers | Machine |
| Setup steps, PNP steps | Steps |
| Job JSON | Edit as JSON, in a job's menu |
| Camera view, Bottom camera view, Top camera view | Camera |
| Camera, Bottom camera, Top camera, Nozzle, Lens and colors, Camera changes | Cameras (Setup) |
| Find board, Find board on the PNP page, Align, Board on the machine | Board place |
| Height map | Height |
| Placing | Run |
| Operation (Plot) | Draw, a job's editor for drawn groups |
| Board (PNP) | part of Parts |
| Head | quick bar, and Head (Setup) |
| Machine view | Bed (Setup) |
| Machine file, Connection, Import from OpenPnP | Machines (Setup) |
| Settings | Firmware (Setup) |
| Version, Bug reports, Plugins | Page (Setup) |
| CAM, Profile file | CAM profiles (Setup) |
| Auto, What it can do | Assistant |

## Order of work

Each step ships on its own, inside today's tabs, and leaves the page better.

1. **Words out, names in.** Rename the panels that stay and keep their
   contents; paragraphs become hover meanings and guide pages (the
   "What the words mean" folds go, as TODO.md asks); each step's line in
   Steps becomes a button that does the step or opens its panel. This is
   the redesign's phase 1 for words.
2. **One copy of each shared panel.** One Machine panel mounted on Jobs,
   Plot and PNP in place of Position, Jog, Laser, Spindle, Markers and PNP
   jog; one Preview; one Run for the laser, the mill and pick and place.
   This is the redesign's phase 2 (one dock, Q46).
3. **Setup values to the Setup side.** Camera settings, calibrations and
   routines to Cameras; the head's tuning to Head; Machine view, the home
   fiducial and Write skew to Bed; firmware keys split from the machine
   file; Version, Bug reports and Plugins to Page. Each value left behind
   on the Use side becomes a line with a link (a rule in FACT_RULES,
   web/frontend/src/facts.ts).
4. **The picture owns its camera.** Start, Stop, Look once and the camera's
   choice on the Camera panel; Board place and the steps stop saying
   "start it in its panel".
5. **Imports in the import dialog; the Job panel.** The next import's
   fields move into the dialog a dropped file already opens (the layer
   chooser), so the Jobs panel is the list; the selected job's groups,
   board and place become the Job panel, with side, finish and paste from
   the camera panels (Q53).
6. **Board place.** Find board, Align, Board on the machine and the
   placing by hand become one panel, its state line saying where the board
   is and by what (Q52).
7. **Height.** Travel height, the map, focus and the run's use of the map
   in one panel; Run shows the mode in words.
8. **One way to open a board.** Open on Jobs; Parts and the CAM profiles
   pick from the job list; Plot's New job becomes Draw.

After step 8 the Use side has 13 kinds of panel. The redesign's areas
(Q43) then group them: Job holds Jobs, Job and Preview; Run holds Steps,
Board place, Height, Camera, Parts, Feeders, Run and Console; the dock is
Machine.

## Checking it

- The contents: `mise run shots -- docs/ui/panels.json var/ui-panels`
  prints every panel's headings, fields, buttons and text with its
  controls and words in view; a control found in two panels breaks rule 1.
- The budget: `mise run shots -- docs/ui/budget.json var/ui-budget` per
  page, against the 40 controls and 200 words.
- The page still works: `mise run test-layout` and the end to end tests
  after each step, since every move changes selectors they use.
