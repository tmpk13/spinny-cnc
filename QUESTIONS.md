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
