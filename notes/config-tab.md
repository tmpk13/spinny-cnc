# The Config tab (moved from notes/frontend.md 2026-11-14)

## Config tab: the file as the one place (2026-11-02)

The firmware settings panel is gone: the user found two panels showing
the same machine in different names confusing. *Write to board* applies
with `save=true` (one step, saving an edited text first), *Read from
board* is `POST /api/machines/{id}/from-board`, and the right panel is a
read-only list of every key (`src/machinekeys.ts`, twin of
`spinny_laser.machine_keys`, checked against `machine-keys.json` from
`mise run keys-fixture`, made from texts in the module, not the shipped
files). Values are read-only on purpose: a click goes to the key in the
editor (added with the file's value when missing), so nothing is edited
in two places. The host fields that lived in the old panel (tolerance,
clearance, spin-up, dispensing) are the file's `[host]`; Travel H keeps
its jog panel field. The list subscribes to settings only: the snapshot
comes at 10 Hz and rebuilding 90 rows each time would eat the hover and
scroll. The File column follows the editor through a check 400 ms after
the last key.

## Every file key, Copy and Insert, find, the machine in use (2026-11-14)

Built by an agent in a worktree (todo-config), cherry-picked.

- File keys table: `src/filekeys.ts` lists every file key with no
  firmware setting, page-side only (the backend never needs it).
  tests/filekeys.test.ts ties it to two things: two sample files giving
  every key must read in the mock's readers, which refuse unknown keys,
  and every key in docs/MACHINES.md's toml blocks must be listed. A G-code
  file's list shows only its own tables (it refuses the firmware's).
- Live camera values: rows show them only for the machine shown, redrawn
  on camera, placing and pnp events only when a shown value changes (the
  events come often).
- Search ranking: fuzzyScore matched letters greedily from the left, so
  "camera turn" ranked `[camera] size` above `roll`; each word of a
  multi-word query found whole now adds a bonus. A camera's `roll` keeps
  its name (`rotation` already names a feeder's part angle and the G-code
  axis letter) and is found as rotation, turn or angle; vacuum keys by
  vacuum or suction.
- Copy: `navigator.clipboard` needs a secure context, which a Pi on the
  LAN over http is not; `copyText` falls back to `execCommand('copy')` on
  an unseen, still rendered textarea, then gives the focus back.
- Insert writes the board's or camera's value where the file differs, or
  adds a key the file leaves out; arrays of tables are only gone to, never
  added to. The File column follows the edit after the 400 ms check, so a
  Copy right after an Insert copies the old value.
- Find: a third `pre` layer under the colored one draws the matches; the
  focus stays in the find field (a textarea without focus draws no
  selection); Escape returns to the text at the match.
- Machines in the store: `AppState.machines` and `ctx.refreshMachines` are
  refreshed on connect/disconnect and after the page writes a file; the
  Config panel's `listChanged` re-reads the open file when it has no
  edits, a `listing` flag skipping that during its own refresh.
- The picker marks the file in use, so it was rebuilt from 10 Hz
  snapshots and a select whose options are replaced closes under the
  pointer: it is rebuilt only when its options change (9e5f663).
- Test trap: a click on a settings-list row leaves the editor focused,
  which took the arrow keys from views.test.ts's jog test when
  pending.test.ts ran first; the list tests blur at their end.
- Machine in use: config `machine_used` holds the file last written to a
  board, connected, or chosen with Use; only GET /api/machines (`used`)
  reads it and nothing depends on it. It is not `last_machine`: a G-code
  id there would make `controls_file` fall back to "the one file of the
  kind" for a board of settings no file has. `POST /api/machines/{id}/use`
  sets `last_machine` for a board file and `placing_machine` for a G-code
  file. connection.ts exports `connectTo`, `disconnectFrom` and
  `boardPort`; Use reuses them so the Connection tab's buttons remember
  the machine too.

## The board area keys (2026-11-14)

- src/filekeys.ts lists `[motion] travel` and `[top_camera] board_area`,
  `board_area_only` (cv-view branch); tests/filekeys.test.ts's G-code
  sample gives all three and docs/MACHINES.md's G-code block names them,
  which the test requires. The Machine view on the PNP tab writes the two
  area keys through PATCH, so the editor shows them after
  refreshMachines.
