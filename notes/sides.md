# The Use and Setup sides (2026-11-15)

The design is docs/UI_SPLIT.md; this file holds what was not obvious
while building it (46611f5, the backend's `changed` event 5272338).

## One document with two panes, not an iframe

Side by side is one document showing two `main.page` elements, each in
its side's `.pane`. An iframe for the Setup side would have doubled the
event feed and the in-page mock (two mocks that never agree), and going
side by side would have reloaded the Setup side every time. One document
shares the store, the feed and the mock, and a link inside the split is a
plain `goToPanel`. Two browser tabs are two documents, which is what the
BroadcastChannel and the `changed` event are for.

## Pages lay out by their pane's width

Every `@media (min-width: 64rem)` rule that styles something inside a
page became `@container pane (...)`; `.pane` is `container: pane /
inline-size`. Only `#app`'s height (one screen tall on a wide window)
and the `:root` gaps stay media queries, since they are not inside a
pane. Chromium 156 does not make the container the containing block of
`position: fixed` popups (checked: a fixed child stayed at the window's
origin), so tooltips and menus inside panels are not trapped. JS cannot
ask a container query, so the stylesheet sets `--wide: 1` on a page its
pane lays out in columns and `wide(node)` in src/views/panels.ts reads
it; where no stylesheet says (happy-dom), it falls back to the window's
`matchMedia`, which is what the tests expect.

## Tests

- happy-dom's `PopStateEvent` drops `state`; the popstate handler reads
  `history.state` too, which a browser sets to the same object.
- Some test file leaves the window at `about:blank`, where
  `history.replaceState` to `/?...` silently does nothing; `at()` in
  tests/harness.ts puts the window back on `http://localhost/` first.
- The layout check and the shot tool waited for the first `.tabs .tab`
  to be visible; with the Setup side in front that tab is folded away,
  so they wait for the selected tab instead.
- Under another session's load (load average 15 to 23) the views tests
  of the Config panel take 7 to 10 s and hit bun's 5 s timeout. The base
  commit in a worktree was as slow, so it was the load; compare against
  a worktree before blaming a change.

## Tabs that know of each other

- The channel's name carries the `api` base and mock or live, so a mock
  tab never sends a target to a real one.
- `send` waits 0.4 s for `went`; a tab that does not answer is forgotten
  and the link goes here. A tab answers `went` only once it found the
  target, so a peer on an older page (no such panel) falls back too.
- A tab cannot bring itself to the front: `window.focus()` from a
  background tab is ignored by browsers, so the sender's toast says where
  the target went and offers Show here (Q49 in QUESTIONS.md).
- Every tab of the mock runs its own mock: two mock tabs do not share a
  machine file saved in one. Over a real backend the `changed` event
  keeps them in step.

## The Checklist's sources

A camera value is "measured" when the newest findings entry that changed
it applied the value there now; an undo as the newest entry, an entry
undone since, or a value that differs (typed over) is no measurement.
The findings log is loaded by the cameras' change folds at mount, which
the Checklist relies on; a page with none of those panels would show
every camera value as "in the file".
