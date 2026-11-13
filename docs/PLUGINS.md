# Plugins

A plugin is a JavaScript module that adds to the page: a panel, a
readout, a button that calls the backend. Each is one file on the
machine the backend runs on, `var/plugins/<id>.js`, and the *Plugins*
tab lists them with a switch each.

A plugin runs in the page with the page's whole power: what the page can
do, a plugin can do, moving the machine and firing the laser included.
So every plugin is off until the operator turns it on in the Plugins
tab, which asks first, and a plugin whose file changes after that is off
again until it is turned on anew. Read a plugin's source (its *Source*
fold) before turning it on.

## Where plugins come from

- The Auto tab: ask for one ("a panel with the head's place in big
  digits"). Its `write_plugin` tool writes the file, switched off, and
  the list says *Auto*. The tools can list, read, write and delete
  plugins; none can turn one on.
- By hand: put a file `<id>.js` in `var/plugins`, the id 1 to 64
  lower-case letters, digits, `_` or `-`, starting with a letter or a
  digit. The list says *file*.

## Turning one on and off

The switch turns a plugin on in this page at once, after a question that
names what a plugin can do, and the backend keeps it on, so every browser
starts it when it loads (or when it shows the Plugins tab). Off stops it
at once: its own undo runs (see below), then the panels it added go and
its listeners stop. Anything else it did without the host (a timer it did
not clear) goes with a reload. A plugin that fails to load or start says
why under its name, and so does one that failed while it ran (it is
stopped then).

The backend keeps what was turned on as the SHA-256 of the file's text,
and serves a plugin's module to the page only while it is on as that
text: a plugin written again, by a tool or by hand, is off and not served
until it is turned on again. The routes are in
[WEB_API.md](WEB_API.md#plugins).

## The module

A plugin is an ES module with no imports, using the page's DOM:

- `export const name = "...";` and `export const description = "...";`,
  plain string literals: the backend reads them from the text without
  running it (a name or description made any other way is not read; the
  list then shows the id).
- `export function activate(host)` (or `async`), run when the plugin is
  turned on and each time the page loads with it on. It may return a
  function that undoes what it did.

The host it is given:

| | |
| --- | --- |
| `host.id` | the plugin's id |
| `host.panel({ title, page })` | adds a panel at the end of a page's last column (above a panel docked at its foot, as the Run panel is) and answers its body, an element to fill; `page` is `jobs` (when left out), `plot`, `cam`, `pnp`, `auto`, `config`, `connection` or `plugins`, `title` the plugin's name when left out. The panel takes part in the page's layout like any other (fold, hide, move, stack) and goes when the plugin is turned off |
| `host.api` | the page's API object: every call the page itself makes to the backend, such as `host.api.state()`, `host.api.jobs()`, `host.api.jog(...)` (`web/frontend/src/api.ts`) |
| `host.state()` | the page's state now (`web/frontend/src/state.ts`): `state.snapshot.machine` is null with no machine connected, else its `board.x` and `board.y` are the head's place in mm and `state` the machine's state; `state.jobs` the jobs listed, `state.job` the one picked |
| `host.subscribe(listener, keys)` | calls `listener(state)` whenever one of `keys` of the state changes (any key with none given); answers a function that stops it. Stopped when the plugin is turned off |
| `host.toast(level, text)` | shows a message, `level` `info` or `error` |
| `host.onPage(listener)` | calls `listener(page)` with each page shown; answers a function that stops it. Stopped when the plugin is turned off |
| `host.page()` | the page shown now |

A listener that throws stops its plugin, which then says why. Elements
may take the page's classes (`btn`, `field`, `hint`, `muted`,
`button-row`) and its colors (`var(--strong)`, `var(--muted)`,
`var(--accent)`, and the rest of `web/frontend/src/style.css`).

## An example

The head's place in large digits, in a panel on the Jobs page (the
mock's page, `?mock=1`, has it, switched off):

```js
// A panel on the Jobs page with the head's place on the board in large
// digits, drawn again whenever the machine reports.
export const name = "Big position";
export const description = "The head's place on the board in large digits, in a panel on the Jobs page.";

export function activate(host) {
    const body = host.panel({ title: "Big position", page: "jobs" });
    const readout = document.createElement("div");
    readout.style.font = "600 2.5rem/1.2 var(--mono)";
    readout.style.color = "var(--strong)";
    readout.style.whiteSpace = "pre";
    body.append(readout);
    const draw = (state) => {
        const machine = state.snapshot.machine;
        readout.textContent = machine
            ? `X ${machine.board.x.toFixed(2)}\nY ${machine.board.y.toFixed(2)}`
            : "no machine";
    };
    draw(host.state());
    // Stopped by the host when the plugin is turned off, as its panel is taken away.
    host.subscribe(draw, ["snapshot"]);
}
```

### Undoing what the host does not

A plugin that adds something other than through the host, such as a key
listener on the document or a timer, returns a function that takes it
away:

```js
export const name = "Space to hold";
export const description = "The space bar holds the run under way.";

export function activate(host) {
    const onKey = (event) => {
        if (event.key === " " && event.target === document.body) {
            event.preventDefault();
            void host.api.runHold();
        }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
}
```
