#!/usr/bin/env python3
"""Figures for docs/UI_PRINCIPLES.md and docs/UI_REDESIGN.md.

Concept drawings and mockups of the proposed screens, drawn as SVG in the
page's Solarized light palette. Places are set by hand; the helpers size
buttons and wrap text from an estimate of the font's widths, so a long
label may need a wider box. `mise run ui-figures` rewrites every
docs/ui/*.svg from this file. Standard library only, ASCII text only.

Colors follow the proposal itself: neutral for everything normal, and a
hue only for a state (blue working, yellow needs you, red danger or
stopped, green done). Magenta numbered circles are notes on a figure, not
part of the page; the documents explain each number.
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent

SANS = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "'JetBrains Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace"

C = {
    "page": "#eee8d5",    # base2, behind the panels
    "panel": "#fdf6e3",   # base3, panels and bars
    "line": "#dcd5bf",    # borders
    "field": "#f6f0dc",   # input fill
    "tint": "#e8e1ca",    # the selected row or area
    "ink": "#073642",     # base02, text and the next action's button
    "muted": "#586e75",   # base01, secondary text
    "faint": "#93a1a1",   # base1, locked text
    "pale": "#d8d1bb",    # placeholder lines
    "blue": "#268bd2",    # working: running, moving, in progress
    "red": "#dc322f",     # danger and stopped
    "yellow": "#b58900",  # needs you
    "green": "#859900",   # done
    "orange": "#cb4b16",
    "violet": "#6c71c4",
    "cyan": "#2aa198",
    "magenta": "#d33682",
    "note": "#d33682",    # numbered notes on a figure
}

# Soft backgrounds for the state chips and messages.
SOFT = {"neutral": C["panel"], "ok": "#eef0d2", "warn": "#f6e9c3", "alarm": "#f9dcd5", "run": "#dbe9f3"}
DOT = {"neutral": C["faint"], "ok": C["green"], "warn": C["yellow"], "alarm": C["red"], "run": C["blue"]}


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def fmt(value):
    if isinstance(value, float):
        out = f"{value:.1f}"
        return out[:-2] if out.endswith(".0") else out
    return str(value)


def tw(text, size, bold=False):
    """Estimated width of a line of the sans font, in pixels."""
    total = 0.0
    for ch in text:
        if ch in "il.,:;'|!":
            total += 0.27
        elif ch == " ":
            total += 0.28
        elif ch in "()[]{}/-":
            total += 0.36
        elif ch in "mwMW":
            total += 0.84
        elif ch.isupper():
            total += 0.67
        elif ch.isdigit():
            total += 0.58
        else:
            total += 0.54
    return total * size * (1.06 if bold else 1.0)


def mw(text, size):
    """Width of a line of the mono font."""
    return len(text) * size * 0.6


def wrap(text, width, size, bold=False):
    lines, current = [], ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if not current or tw(trial, size, bold) <= width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


class Svg:
    def __init__(self, width, height, label):
        self.width, self.height, self.label = width, height, label
        self.parts = []

    def el(self, tag, attrs, body=None):
        pairs = []
        for key, value in attrs.items():
            if value is None:
                continue
            name = key.rstrip("_").replace("_", "-")
            pairs.append(f'{name}="{esc(value) if isinstance(value, str) else fmt(value)}"')
        head = f"<{tag} {' '.join(pairs)}"
        self.parts.append(f"{head}/>" if body is None else f"{head}>{body}</{tag}>")

    def rect(self, x, y, w, h, fill="none", stroke=None, sw=1.0, r=0.0, dash=None, opacity=None):
        self.el("rect", dict(x=x, y=y, width=w, height=h, rx=r or None, fill=fill, stroke=stroke,
                             stroke_width=sw if stroke else None, stroke_dasharray=dash, opacity=opacity))

    def text(self, x, y, text, size=12.0, fill=None, weight=None, anchor=None, mono=False, spacing=None,
             italic=False, decoration=None, halo=None):
        self.el("text", dict(x=x, y=y, font_family=MONO if mono else SANS, font_size=size,
                             font_weight=weight, fill=fill or C["ink"], text_anchor=anchor,
                             letter_spacing=spacing, font_style="italic" if italic else None,
                             text_decoration=decoration, stroke=halo, stroke_width=4 if halo else None,
                             stroke_linejoin="round" if halo else None,
                             paint_order="stroke" if halo else None), esc(text))

    def spans(self, x, y, parts, size=12.0, fill=None):
        """One line of text in pieces; a piece's dict adds attributes to its tspan."""
        body = "".join(f"<tspan{''.join(f' {k}=\"{esc(v)}\"' for k, v in attrs.items())}>{esc(t)}</tspan>"
                       for t, attrs in parts)
        self.el("text", dict(x=x, y=y, font_family=SANS, font_size=size, fill=fill or C["ink"]), body)

    def line(self, x1, y1, x2, y2, stroke, sw=1.0, dash=None):
        self.el("line", dict(x1=x1, y1=y1, x2=x2, y2=y2, stroke=stroke, stroke_width=sw,
                             stroke_dasharray=dash, stroke_linecap="round"))

    def path(self, d, fill="none", stroke=None, sw=1.5, dash=None, opacity=None):
        self.el("path", dict(d=d, fill=fill, stroke=stroke, stroke_width=sw if stroke else None,
                             stroke_linecap="round", stroke_linejoin="round", stroke_dasharray=dash,
                             opacity=opacity))

    def circle(self, cx, cy, r, fill="none", stroke=None, sw=1.0, dash=None):
        self.el("circle", dict(cx=cx, cy=cy, r=r, fill=fill, stroke=stroke,
                               stroke_width=sw if stroke else None, stroke_dasharray=dash))

    def save(self, name):
        body = "\n".join(self.parts)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
               f'viewBox="0 0 {self.width} {self.height}" role="img" aria-label="{esc(self.label)}">\n'
               f"<title>{esc(self.label)}</title>\n"
               f'<rect width="{self.width}" height="{self.height}" rx="14" fill="#f7f2e2"/>\n'
               f"{body}\n</svg>\n")
        (OUT / name).write_text(svg)
        return name


# ---------------------------------------------------------------- pieces


def para(s, x, y, width, text, size=12.0, fill=None, lh=1.42, weight=None):
    """Wrapped text from the first baseline at y; returns the next baseline."""
    for line in wrap(text, width, size, weight == 700):
        s.text(x, y, line, size=size, fill=fill, weight=weight)
        y += size * lh
    return y


def chev(s, x, y, way="right", color=None, size=4.5, sw=1.6):
    color = color or C["muted"]
    if way == "right":
        d = f"M{x - size / 2:.1f},{y - size:.1f} L{x + size / 2:.1f},{y:.1f} L{x - size / 2:.1f},{y + size:.1f}"
    elif way == "left":
        d = f"M{x + size / 2:.1f},{y - size:.1f} L{x - size / 2:.1f},{y:.1f} L{x + size / 2:.1f},{y + size:.1f}"
    elif way == "down":
        d = f"M{x - size:.1f},{y - size / 2:.1f} L{x:.1f},{y + size / 2:.1f} L{x + size:.1f},{y - size / 2:.1f}"
    else:
        d = f"M{x - size:.1f},{y + size / 2:.1f} L{x:.1f},{y - size / 2:.1f} L{x + size:.1f},{y + size / 2:.1f}"
    s.path(d, stroke=color, sw=sw)


BUTTON = {
    # kind: fill, border, text, bold
    "plain": (C["panel"], C["line"], C["ink"], False),
    "primary": (C["ink"], None, "#ffffff", True),
    "danger": (C["red"], None, "#ffffff", True),
    "off": (C["field"], C["line"], C["faint"], False),
    "ghost": (None, None, C["ink"], False),
    # the page today
    "blue": ("#268bd2", None, "#ffffff", True),
    "paleblue": ("#9cc3e0", None, "#ffffff", True),
    "palered": ("#eba49b", None, "#ffffff", True),
}


def button(s, x, y, label, kind="plain", w=None, h=28.0, size=12.5):
    fill, border, color, bold = BUTTON[kind]
    w = w or round(tw(label, size, bold) + 24)
    if fill or border:
        s.rect(x, y, w, h, fill=fill or "none", stroke=border, r=6)
    s.text(x + w / 2, y + h / 2 + size * 0.36, label, size=size, fill=color, weight=600 if bold else None,
           anchor="middle", decoration="underline" if kind == "ghost" else None)
    return w


def buttons(s, x, y, specs, gap=7.0, h=28.0, size=12.5):
    for spec in specs:
        label, kind = spec if isinstance(spec, tuple) else (spec, "plain")
        x += button(s, x, y, label, kind, h=h, size=size) + gap
    return x


def field(s, x, y, w, value="", label=None, h=28.0, mono=True, faint=False, unit=None, size=12.0):
    if label:
        s.text(x, y - 6, label, size=10.5, fill=C["muted"])
    s.rect(x, y, w, h, fill=C["field"], stroke=C["line"], r=6)
    s.text(x + 9, y + h / 2 + size * 0.36, value, size=size, fill=C["faint"] if faint else C["ink"], mono=mono)
    if unit:
        s.text(x + w - 8, y + h / 2 + 4, unit, size=10.5, fill=C["muted"], anchor="end")


def select(s, x, y, w, value, label=None, h=28.0, faint=False, size=12.0):
    field(s, x, y, w, value, label, h, mono=False, faint=faint, size=size)
    chev(s, x + w - 14, y + h / 2, "down", C["muted"], 4)


def segmented(s, x, y, labels, chosen, h=28.0, size=12.0, each=None):
    widths = [each or round(tw(label, size) + 24) for label in labels]
    s.rect(x, y, sum(widths), h, fill=C["panel"], stroke=C["line"], r=6)
    cx = x
    for i, (label, w) in enumerate(zip(labels, widths)):
        if i == chosen:
            s.rect(cx + 2, y + 2, w - 4, h - 4, fill=C["muted"], r=4.5)
        elif i > 0 and i - 1 != chosen:
            s.line(cx, y + 6, cx, y + h - 6, C["line"])
        s.text(cx + w / 2, y + h / 2 + size * 0.36, label, size=size, anchor="middle",
               fill="#ffffff" if i == chosen else C["ink"], weight=600 if i == chosen else None)
        cx += w
    return sum(widths)


def toggle(s, x, y, on):
    s.rect(x, y, 30, 17, fill=C["muted"] if on else C["pale"], r=8.5)
    s.circle(x + (21.5 if on else 8.5), y + 8.5, 6.2, fill="#ffffff")


def checkbox(s, x, y, on, label=None, size=12.0, faint=False):
    if on:
        s.rect(x, y, 14, 14, fill=C["muted"], r=3.5)
        s.path(f"M{x + 3.3},{y + 7.3} L{x + 6.1},{y + 10.1} L{x + 11},{y + 4.2}", stroke="#ffffff", sw=1.9)
    else:
        s.rect(x, y, 14, 14, fill=C["panel"], stroke=C["faint"], r=3.5)
    if label:
        s.text(x + 21, y + 11.5, label, size=size, fill=C["faint"] if faint else C["ink"])


def mark(s, x, y, kind, r=9.0):
    """A state drawn in a circle: ok, warn, alarm, todo, current, info, run."""
    if kind == "ok":
        s.circle(x, y, r, fill=C["green"])
        s.path(f"M{x - 4},{y + 0.4} L{x - 1.2},{y + 3.3} L{x + 4.2},{y - 3.2}", stroke="#ffffff", sw=2)
    elif kind == "warn":
        s.circle(x, y, r, fill=C["yellow"])
        s.line(x, y - 4.6, x, y + 1.0, "#ffffff", 2.2)
        s.circle(x, y + 4.2, 1.35, fill="#ffffff")
    elif kind == "alarm":
        s.circle(x, y, r, fill=C["red"])
        s.path(f"M{x - 3.4},{y - 3.4} L{x + 3.4},{y + 3.4} M{x + 3.4},{y - 3.4} L{x - 3.4},{y + 3.4}",
               stroke="#ffffff", sw=2.1)
    elif kind == "todo":
        s.circle(x, y, r - 0.8, fill=C["panel"], stroke=C["faint"], sw=1.6)
    elif kind == "current":
        s.circle(x, y, r - 0.6, fill=C["panel"], stroke=C["ink"], sw=2.4)
        s.circle(x, y, 3.3, fill=C["ink"])
    elif kind == "run":
        s.circle(x, y, r - 0.6, fill=C["panel"], stroke=C["blue"], sw=2.4)
        s.path(f"M{x - 2.2},{y - 3.6} L{x + 3.8},{y} L{x - 2.2},{y + 3.6} Z", fill=C["blue"])
    elif kind == "info":
        s.circle(x, y, r - 0.8, fill=C["panel"], stroke=C["muted"], sw=1.4)
        s.circle(x, y - 3.7, 1.25, fill=C["muted"])
        s.line(x, y - 0.8, x, y + 4.3, C["muted"], 1.8)


def chip(s, x, y, label, kind="neutral", h=22.0, size=11.5):
    w = tw(label, size, True) + 30
    s.rect(x, y, w, h, fill=SOFT[kind], stroke=C["line"] if kind == "neutral" else None, r=h / 2)
    s.circle(x + 12, y + h / 2, 3.6, fill=DOT[kind])
    s.text(x + 21, y + h / 2 + size * 0.36, label, size=size, weight=600)
    return w


def panel(s, x, y, w, h, title=None, edge=None, fold=True, size=11.0):
    s.rect(x, y, w, h, fill=C["panel"], stroke=C["line"], r=10)
    if edge:
        s.path(f"M{x + 9},{y + 1.5} H{x + w - 9}", stroke=edge, sw=3)
    if title:
        tx = x + 14
        if fold:
            chev(s, x + 18, y + 20, "down", C["muted"], 3.6)
            tx = x + 29
        s.text(tx, y + 24, title.upper(), size=size, weight=700, spacing=1.1)
    return y + 42


def hr(s, x, y, w):
    s.line(x, y, x + w, y, C["line"])


def badge(s, x, y, n):
    s.circle(x, y, 11.5, fill=C["note"], stroke="#ffffff", sw=2)
    s.text(x, y + 4.4, str(n), size=12.5, weight=700, fill="#ffffff", anchor="middle")


def heading(s, x, y, label, now):
    s.text(x, y, label.upper(), size=12.5, weight=700, spacing=1.5, fill=C["muted"] if now else C["ink"])
    s.rect(x, y + 6, tw(label.upper(), 12.5, True) + 1.5 * len(label), 2.5,
           fill=C["faint"] if now else C["ink"], r=1)


def greylines(s, x, y, w, n, gap=9.0, height=4.0):
    for i in range(n):
        width = w * (0.55 if i == n - 1 else 1.0 - 0.07 * (i % 3))
        s.rect(x, y + i * gap, width, height, fill=C["pale"], r=2)


def more(s, x, y, label, size=12.0):
    chev(s, x + 3, y - 4, "right", C["muted"], 4)
    s.text(x + 13, y, label, size=size, fill=C["muted"])


def icon(s, name, x, y, color, size=20.0):
    """Line icons for the rail, centered on x, y."""
    h = size / 2
    sw = 1.7
    if name == "home":
        s.path(f"M{x - h * 0.8},{y - h * 0.05} L{x},{y - h * 0.8} L{x + h * 0.8},{y - h * 0.05} "
               f"M{x - h * 0.6},{y - h * 0.25} V{y + h * 0.75} H{x + h * 0.6} V{y - h * 0.25}", stroke=color, sw=sw)
    elif name == "job":
        s.rect(x - h * 0.85, y - h * 0.65, h * 1.7, h * 1.3, stroke=color, sw=sw, r=2.5)
        s.path(f"M{x - h * 0.5},{y + h * 0.25} L{x - h * 0.1},{y + h * 0.25} L{x + h * 0.15},{y - h * 0.2} "
               f"L{x + h * 0.5},{y - h * 0.2}", stroke=color, sw=sw)
    elif name == "run":
        s.circle(x, y, h * 0.85, stroke=color, sw=sw)
        s.path(f"M{x - h * 0.25},{y - h * 0.4} L{x + h * 0.45},{y} L{x - h * 0.25},{y + h * 0.4} Z",
               fill=color, stroke=color, sw=1)
    elif name == "machines":
        for i, k in enumerate((-0.5, 0, 0.5)):
            yy = y + k * h * 1.2
            s.line(x - h * 0.85, yy, x + h * 0.85, yy, color, sw)
            kx = x + (-0.35, 0.35, -0.05)[i] * h * 1.4
            s.circle(kx, yy, h * 0.22, fill=C["panel"], stroke=color, sw=sw)
    elif name == "search":
        s.circle(x - h * 0.15, y - h * 0.15, h * 0.5, stroke=color, sw=sw)
        s.line(x + h * 0.22, y + h * 0.22, x + h * 0.7, y + h * 0.7, color, sw + 0.4)
    elif name == "chat":
        s.path(f"M{x - h * 0.8},{y - h * 0.6} H{x + h * 0.8} V{y + h * 0.35} H{x - h * 0.15} L{x - h * 0.55},"
               f"{y + h * 0.75} V{y + h * 0.35} H{x - h * 0.8} Z", stroke=color, sw=sw)
    elif name == "todo":
        for k in (-0.45, 0.05, 0.55):
            s.line(x - h * 0.25, y + k * h, x + h * 0.8, y + k * h, color, sw)
            s.circle(x - h * 0.65, y + k * h, 1.4, fill=color)
    elif name == "gear":
        s.circle(x, y, h * 0.62, stroke=color, sw=h * 0.42, dash="2.2 2.4")
        s.circle(x, y, h * 0.45, fill=C["panel"], stroke=color, sw=sw)
    elif name == "camera":
        s.rect(x - h * 0.9, y - h * 0.5, h * 1.8, h * 1.2, stroke=color, sw=sw, r=2.5)
        s.circle(x, y + h * 0.1, h * 0.35, stroke=color, sw=sw)
        s.path(f"M{x - h * 0.35},{y - h * 0.5} L{x - h * 0.15},{y - h * 0.8} H{x + h * 0.15} L{x + h * 0.35},"
               f"{y - h * 0.5}", stroke=color, sw=sw)


# ---------------------------------------------------------------- frame

RAIL_TOP = [("home", "Home"), ("job", "Job"), ("run", "Run"), ("machines", "Machines")]
RAIL_BOTTOM = [("search", "Search"), ("chat", "Assistant"), ("todo", "To-do"), ("gear", "Settings")]


def statusbar(s, x, y, w, machine, state, kind="neutral", message=None, progress=None, action=None, h=48.0,
              pill_x=None, r=0.0):
    """The top bar: the machine and its state (a press switches machine), what it is doing, and Stop."""
    if kind == "alarm":
        s.rect(x, y, w, h, fill=SOFT["alarm"], r=r)
    px, py = (x + 112 if pill_x is None else pill_x), y + (h - 28) / 2
    name_w = tw(machine, 13, True)
    state_w = tw(state, 13)
    pill_w = 24 + name_w + 22 + state_w + 28
    s.rect(px, py, pill_w, 28, fill=C["panel"], stroke=C["line"], r=14)
    s.circle(px + 13, py + 14, 4, fill=DOT[kind])
    s.text(px + 24, py + 18.6, machine, size=13, weight=700)
    s.line(px + 24 + name_w + 11, py + 7, px + 24 + name_w + 11, py + 21, C["line"])
    s.text(px + 24 + name_w + 22, py + 18.6, state, size=13, fill=C["muted"])
    chev(s, px + pill_w - 14, py + 14, "down", C["muted"], 3.6)
    mx = px + pill_w + 18
    if progress is not None:
        s.rect(mx, y + h / 2 - 3, 110, 6, fill=C["pale"], r=3)
        s.rect(mx, y + h / 2 - 3, 110 * progress, 6, fill=C["blue"], r=3)
        mx += 122
    if message:
        if kind == "warn":
            mw_ = tw(message, 12.5) + 34 + (tw(action, 12, False) + 34 if action else 0)
            s.rect(mx - 6, py, mw_, 28, fill=SOFT["warn"], r=6)
            mark(s, mx + 8, py + 14, "warn", 7.5)
            s.text(mx + 22, py + 18.4, message, size=12.5)
            if action:
                button(s, mx + 22 + tw(message, 12.5) + 10, py + 3, action, "plain", h=22, size=11.5)
        elif kind == "alarm":
            mark(s, mx + 8, py + 14, "alarm", 8)
            s.text(mx + 24, py + 18.4, message, size=12.5, weight=600)
            if action:
                button(s, mx + 24 + tw(message, 12.5, True) + 12, py + 1, action, "plain", h=26, size=12)
        else:
            s.text(mx, py + 18.4, message, size=12.5, fill=C["muted"])
    button(s, x + w - 104, y + (h - 32) / 2, "STOP", "danger", w=92, h=32, size=14)


def window(s, X, Y, W, H, active, machine="Polar laser", state="Idle", kind="neutral", message=None,
           progress=None, action=None):
    """The proposed frame: status bar, rail of areas; returns the work area."""
    s.rect(X, Y, W, H, fill=C["page"], r=12)
    s.path(f"M{X},{Y + 12} A12,12 0 0 1 {X + 12},{Y} H{X + W - 12} A12,12 0 0 1 {X + W},{Y + 12} V{Y + 48} "
           f"H{X} Z", fill=C["panel"])
    statusbar(s, X, Y, W, machine, state, kind, message, progress, action)
    s.line(X, Y + 48, X + W, Y + 48, C["line"])
    s.circle(X + 24, Y + 24, 8.5, stroke=C["muted"], sw=1.6)
    s.circle(X + 24, Y + 24, 3, fill=C["red"])
    s.text(X + 40, Y + 29, "Spinny", size=14.5, weight=700)
    s.path(f"M{X},{Y + 48} H{X + 78} V{Y + H} H{X + 12} A12,12 0 0 1 {X},{Y + H - 12} Z", fill=C["panel"])
    s.line(X + 78, Y + 48, X + 78, Y + H, C["line"])
    yy = Y + 60
    for name, label in RAIL_TOP:
        on = label == active
        if on:
            s.rect(X + 8, yy - 4, 62, 52, fill=C["tint"], r=8)
            s.rect(X + 2, yy + 8, 3.5, 28, fill=C["ink"], r=1.5)
        icon(s, name, X + 39, yy + 14, C["ink"] if on else C["muted"])
        s.text(X + 39, yy + 39, label, size=10.5, anchor="middle", fill=C["ink"] if on else C["muted"],
               weight=700 if on else None)
        yy += 60
    yb = Y + H - len(RAIL_BOTTOM) * 48 - 8
    for name, label in RAIL_BOTTOM:
        icon(s, name, X + 39, yb + 13, C["muted"], 17)
        s.text(X + 39, yb + 35, label, size=9.5, anchor="middle", fill=C["muted"])
        yb += 48
    return X + 78, Y + 48, W - 78, H - 48


def end_window(s, X, Y, W, H):
    s.rect(X, Y, W, H, stroke=C["line"], r=12, sw=1.2)


def stepstrip(s, x, y, w, names, current, running=False):
    s.rect(x, y, w, 46, fill=C["panel"], stroke=C["line"], r=10)
    seg = (w - 28) / len(names)
    for i, name in enumerate(names):
        cx = x + 26 + i * seg
        if i < current:
            kind = "ok"
        elif i == current:
            kind = "run" if running else "current"
        else:
            kind = "todo"
        mark(s, cx, y + 23, kind)
        bold = i == current
        s.text(cx + 15, y + 27.5, name, size=12.5, weight=700 if bold else None,
               fill=C["ink"] if i <= current else C["muted"])
        if i < len(names) - 1:
            start = cx + 15 + tw(name, 12.5, bold) + 10
            end = cx + seg - 14
            if end > start + 6:
                s.line(start, y + 23, end, y + 23, C["green"] if i < current else C["line"], 1.6)


def dock(s, x, y, w, axes, quick, note=None, jog=True):
    """The machine dock folded to one line: position, Jog, the quick bar."""
    s.rect(x, y, w, 50, fill=C["panel"], stroke=C["line"], r=10)
    xx = x + 16
    for name, value in axes:
        s.text(xx, y + 31, name, size=12, weight=700, fill=C["muted"])
        s.text(xx + 15, y + 31, value, size=14, mono=True)
        xx += 15 + mw(value, 14) + 22
    if jog:
        s.rect(xx, y + 11, 72, 28, fill=C["panel"], stroke=C["line"], r=6)
        s.text(xx + 16, y + 29.5, "Jog", size=12.5)
        chev(s, xx + 55, y + 25, "up", C["muted"], 3.6)
        xx += 84
    if note:
        s.text(xx, y + 30, note, size=12, fill=C["muted"])
    widths = [round(tw(q, 12.5) + 24) for q in quick]
    qx = x + w - 14 - sum(widths) - 7 * (len(quick) - 1)
    if quick:
        s.text(qx - 10, y + 30, "Quick", size=11, fill=C["muted"], anchor="end")
    for q, qw in zip(quick, widths):
        button(s, qx, y + 11, q, "plain", w=qw)
        qx += qw + 7


# ---------------------------------------------------------------- art

TRACES = [
    [(0.07, 0.18), (0.30, 0.18), (0.38, 0.30), (0.62, 0.30)],
    [(0.07, 0.42), (0.20, 0.42), (0.28, 0.54), (0.52, 0.54), (0.60, 0.46), (0.93, 0.46)],
    [(0.07, 0.80), (0.38, 0.80), (0.46, 0.70), (0.74, 0.70)],
    [(0.62, 0.14), (0.86, 0.14), (0.93, 0.24), (0.93, 0.34)],
    [(0.70, 0.86), (0.93, 0.86)],
    [(0.46, 0.08), (0.46, 0.22)],
    [(0.80, 0.56), (0.80, 0.66), (0.86, 0.74)],
]
HOLES = [(0.13, 0.62), (0.88, 0.60), (0.30, 0.66), (0.62, 0.86)]


def trace_d(points, x, y, w, h):
    return " ".join(f"{'M' if i == 0 else 'L'}{x + px * w:.1f},{y + py * h:.1f}" for i, (px, py) in enumerate(points))


def board_preview(s, x, y, w, h, bg, done=None, color=None, holes=True):
    """A job's isolation cuts as outlines around the copper; `done` traces drawn as cut.
    Below 120 px wide (a thumbnail) the cuts are single lines."""
    small = w < 120
    s.rect(x, y, w, h, stroke=C["muted"], sw=1.0 if small else 1.4, r=3 if small else 8)
    for i, points in enumerate(TRACES):
        if done is None:
            col = color or C["cyan"]
        else:
            col = C["ink"] if i < done else "#c3bca6"
        d = trace_d(points, x, y, w, h)
        if small:
            s.path(d, stroke=col, sw=1.3)
            for px, py in (points[0], points[-1]):
                s.circle(x + px * w, y + py * h, 1.7, fill=col)
            continue
        s.path(d, stroke=col, sw=7.5)
        s.path(d, stroke=bg, sw=4)
        for px, py in (points[0], points[-1]):
            s.circle(x + px * w, y + py * h, 6.5, fill=bg, stroke=col, sw=1.7)
    if holes and not small:
        for px, py in HOLES:
            s.circle(x + px * w, y + py * h, 4.2, stroke=C["violet"], sw=1.8)


def board_photo(s, x, y, w, h, guess=True, crosshair=True, label="94%"):
    """A camera picture of a board on the bed, with a guess drawn over it."""
    s.rect(x, y, w, h, fill="#262b2a", r=10)
    for i in range(1, 8):
        s.line(x + i * w / 8, y + 6, x + i * w / 8, y + h - 6, "#2e3433", 1)
    bx, by, bw, bh = x + w * 0.16, y + h * 0.17, w * 0.64, h * 0.6
    s.rect(bx + 4, by + 5, bw, bh, fill="#1b1f1e", r=7)
    s.rect(bx, by, bw, bh, fill="#2f6141", r=7)
    for points in TRACES:
        d = trace_d(points, bx, by, bw, bh)
        s.path(d, stroke="#c79c46", sw=4.5)
        for px, py in (points[0], points[-1]):
            s.circle(bx + px * bw, by + py * bh, 5.5, fill="#dcb766")
    for px, py in HOLES:
        s.circle(bx + px * bw, by + py * bh, 3.6, fill="#1b1f1e", stroke="#dcb766", sw=1.4)
    s.text(bx + bw * 0.16, by + bh * 0.33, "R7", size=10, fill="#e9eee6", mono=True)
    s.text(bx + bw * 0.70, by + bh * 0.62, "C12", size=10, fill="#e9eee6", mono=True)
    s.text(bx + bw * 0.08, by + bh * 0.95, "U1", size=10, fill="#e9eee6", mono=True)
    if guess:
        s.rect(bx - 3, by - 4, bw + 7, bh + 6, stroke="#7cc4f2", sw=2, r=8, dash="8 5")
        s.rect(bx - 3, by - 26, 44, 18, fill="#7cc4f2", r=9)
        s.text(bx + 19, by - 13, label, size=11, weight=700, fill="#0b2a3a", anchor="middle")
    if crosshair:
        cx, cy = x + w / 2, y + h / 2
        s.line(cx - 22, cy, cx - 6, cy, "#ffffff", 1.6)
        s.line(cx + 6, cy, cx + 22, cy, "#ffffff", 1.6)
        s.line(cx, cy - 22, cx, cy - 6, "#ffffff", 1.6)
        s.line(cx, cy + 6, cx, cy + 22, "#ffffff", 1.6)
        s.circle(cx, cy, 13, stroke="#ffffff", sw=1.2)


# ---------------------------------------------------------------- concept figures


def fig_budget():
    data = [("Config", 374, 3599), ("Jobs", 264, 1153), ("PNP", 260, 1292), ("Plot", 143, 383),
            ("CAM", 79, 532), ("Auto", 27, 176), ("Overview", 27, 58), ("Connection", 25, 52),
            ("Plugins", 22, 62)]
    s = Svg(960, 468, "Controls and words in view on each page today, against the proposed budget")

    def chart(x0, title, index, vmax, ticks, budget, budget_label, unit_note):
        s.text(x0, 38, title, size=14.5, weight=700)
        s.text(x0, 57, unit_note, size=11.5, fill=C["muted"])
        left, width, top, row = x0 + 84, 330, 96, 34
        for t in ticks:
            tx = left + width * t / vmax
            s.line(tx, top - 6, tx, top + row * len(data) - 6, C["line"], 1)
            s.text(tx, top + row * len(data) + 10, f"{t:,}", size=10.5, fill=C["muted"], anchor="middle")
        bx = left + width * budget / vmax
        s.line(bx, top - 14, bx, top + row * len(data) - 4, C["ink"], 1.8, dash="5 4")
        s.text(bx + 5, top - 18, budget_label, size=11.5, weight=700)
        for i, item in enumerate(data):
            value = item[index]
            y = top + i * row
            s.text(left - 10, y + 13, item[0], size=12.5, anchor="end")
            bw = max(3, width * value / vmax)
            s.el("rect", dict(x=left, y=y, width=bw, height=19, rx=3.5, fill=C["muted"]),
                 f"<title>{item[0]}: {value:,}</title>")
            s.text(left + bw + 6, y + 14, f"{value:,}", size=12, fill=C["ink"], halo="#f7f2e2")

    chart(28, "Controls in view", 1, 400, [0, 100, 200, 300, 400], 40, "budget 40",
          "buttons, fields and boxes a page shows without a press")
    chart(500, "Words in view", 2, 3600, [0, 1000, 2000, 3000], 200, "budget 200",
          "words a page shows without a press, frame left out")
    para(s, 28, 432, 900, "Counted over the page's mock in Chromium at 1440 x 900, connected (the PNP page with a "
         "LumenPnP), inside each page and its frame. Config counts its 160 settings rows as buttons. The budget is "
         "this proposal's rule, met by every proposed screen below; it is not a number from the research.",
         size=11.5, fill=C["muted"])
    return s.save("budget.svg")


def fig_layers():
    s = Svg(960, 502, "Three layers of controls, sorted by how often they are used, all reachable by search")
    bands = [
        ("Layer 1: in view", "used on every run", 2.0, C["ink"], C["panel"],
         ["Stop", "machine and its state", "the step you are on", "its one next action", "position",
          "Hold", "time left"]),
        ("Layer 2: one press, in place", "used on some runs", 1.2, C["muted"], C["panel"],
         ["jog step sizes", "height map grid", "how the board is looked for", "view options", "console",
          "markers", "an operation's details"]),
        ("Layer 3: Machines and Settings", "set once, checked now and then", 1.2, C["faint"], "#f3edd9",
         ["camera device, size, fps", "lens and colors", "camera offset", "nozzle runout", "firmware settings",
          "machine file", "CAM profiles", "plugins", "panel layouts"]),
    ]
    y = 40
    for i, (title, sub, sw, border, fill, items) in enumerate(bands):
        h = 128
        s.rect(96, y, 640, h, fill=fill, stroke=border, sw=sw, r=12, dash="6 4" if i == 2 else None)
        s.text(116, y + 30, title, size=15, weight=700, fill=C["ink"] if i < 2 else C["muted"])
        s.text(116, y + 49, sub, size=12, fill=C["muted"])
        cx, cy = 116, y + 66
        for item in items:
            w = tw(item, 12) + 22
            if cx + w > 720:
                cx, cy = 116, cy + 30
            s.rect(cx, cy, w, 24, fill=C["panel"] if i < 2 else "#faf4e2", stroke=C["line"], r=12)
            s.text(cx + w / 2, cy + 16.2, item, size=12, anchor="middle", fill=C["ink"] if i < 2 else C["muted"])
            cx += w + 8
        y += h + 22
    # how often, down the left: from every run to once per machine
    s.line(62, 52, 62, 452, C["muted"], 2)
    s.path("M56,444 L62,456 L68,444", stroke=C["muted"], sw=2)
    s.el("text", dict(x=44, y=252, font_family=SANS, font_size=12.5, fill=C["muted"], text_anchor="middle",
                      transform="rotate(-90 44 252)"), "less and less often")
    # search reaches every layer
    s.rect(764, 40, 170, 428, fill=C["panel"], stroke=C["line"], r=12)
    icon(s, "search", 849, 80, C["ink"], 30)
    s.text(849, 124, "Search", size=15, weight=700, anchor="middle")
    s.text(849, 142, "Ctrl+K or /", size=12, fill=C["muted"], anchor="middle", mono=True)
    para(s, 780, 176, 140, "finds any control in any layer by a few letters, opens what holds it and puts the "
         "focus on it", size=12.5, fill=C["ink"])
    for yy in (104, 254, 404):
        s.path(f"M738,{yy} H760", stroke=C["faint"], sw=1.6, dash="3 3")
    return s.save("layers.svg")


def fig_regions():
    s = Svg(960, 486, "The proposed screen's six regions, each with one job")
    X, Y, W, H = 24, 24, 600, 440
    s.rect(X, Y, W, H, fill=C["page"], r=12)
    s.path(f"M{X},{Y + 12} A12,12 0 0 1 {X + 12},{Y} H{X + W - 12} A12,12 0 0 1 {X + W},{Y + 12} V{Y + 44} "
           f"H{X} Z", fill=C["panel"])
    s.line(X, Y + 44, X + W, Y + 44, C["line"])
    s.circle(X + 20, Y + 22, 7, stroke=C["muted"], sw=1.5)
    s.circle(X + 20, Y + 22, 2.6, fill=C["red"])
    s.rect(X + 90, Y + 9, 170, 26, fill=C["panel"], stroke=C["line"], r=13)
    s.circle(X + 102, Y + 22, 3.6, fill=C["faint"])
    s.rect(X + 112, Y + 18, 120, 8, fill=C["pale"], r=4)
    s.rect(X + W - 86, Y + 8, 74, 28, fill=C["red"], r=6)
    s.text(X + W - 49, Y + 27, "STOP", size=12.5, weight=700, fill="#ffffff", anchor="middle")
    s.path(f"M{X},{Y + 44} H{X + 64} V{Y + H} H{X + 12} A12,12 0 0 1 {X},{Y + H - 12} Z", fill=C["panel"])
    s.line(X + 64, Y + 44, X + 64, Y + H, C["line"])
    for i in range(4):
        s.rect(X + 18, Y + 62 + i * 46, 28, 28, fill=C["tint"] if i == 2 else C["page"], r=7)
    for i in range(3):
        s.circle(X + 32, Y + H - 110 + i * 34, 9, fill=C["page"])
    # steps
    s.rect(X + 76, Y + 56, W - 88, 38, fill=C["panel"], stroke=C["line"], r=9)
    for i in range(6):
        cx = X + 100 + i * 84
        mark(s, cx, Y + 75, "ok" if i < 2 else ("current" if i == 2 else "todo"), 8)
        s.rect(cx + 13, Y + 72, 44, 6, fill=C["pale"], r=3)
    # canvas
    s.rect(X + 76, Y + 106, 320, 266, fill="#fbf7ea", stroke=C["line"], r=10)
    board_preview(s, X + 110, Y + 140, 250, 190, "#fbf7ea", holes=False)
    # step panel
    s.rect(X + 408, Y + 106, W - 420, 266, fill=C["panel"], stroke=C["line"], r=10)
    s.rect(X + 424, Y + 124, 90, 8, fill=C["faint"], r=4)
    s.rect(X + 424, Y + 148, 140, 12, fill=C["muted"], r=4)
    greylines(s, X + 424, Y + 172, 130, 2)
    s.rect(X + 424, Y + 204, W - 452, 32, fill=C["ink"], r=6)
    s.rect(X + 424, Y + 246, 80, 26, stroke=C["line"], r=6, fill=C["panel"])
    more(s, X + 424, Y + 300, "More", 11.5)
    # dock
    s.rect(X + 76, Y + 384, W - 88, 42, fill=C["panel"], stroke=C["line"], r=10)
    for i in range(3):
        s.rect(X + 92 + i * 80, Y + 400, 62, 10, fill=C["faint"], r=4)
    for i in range(4):
        s.rect(X + W - 70 - i * 58, Y + 394, 50, 22, stroke=C["line"], fill=C["panel"], r=6)
    s.rect(X, Y, W, H, stroke=C["line"], r=12, sw=1.2)
    for n, (bx, by) in enumerate([(X + 300, Y + 22), (X + 32, Y + 290), (X + W - 22, Y + 58), (X + 92, Y + 122),
                                  (X + 560, Y + 124), (X + 330, Y + 405)], 1):
        badge(s, bx, by, n)
    legend = [
        ("Machine and Stop", "Which machine, what it is doing, and Stop: the same on every screen."),
        ("Areas", "Home, Job, Run, Machines: where you are, and nothing else."),
        ("Steps", "The steps of this machine's work, from its machine file: done, now, next."),
        ("The work", "The preview or the camera's picture, as large as the screen allows."),
        ("This step", "The step's few controls and its one next action; More holds the rest."),
        ("Dock", "Position, jog and the quick bar: one set of machine controls everywhere."),
    ]
    y = 50
    for n, (title, text) in enumerate(legend, 1):
        badge(s, 660, y - 4, n)
        s.text(680, y + 1, title, size=13.5, weight=700)
        y = para(s, 680, y + 20, 255, text, size=12, fill=C["muted"]) + 16
    return s.save("regions.svg")


def heightmap_now(s, x, y, w):
    """The Height map panel as the page draws it today, compressed."""
    h = 600
    panel(s, x, y, w, h, "Height map", edge=C["orange"])
    chip(s, x + w - 82, y + 12, "no map")
    cy = y + 60
    half = (w - 38) / 2
    for left, right, lv, rv in (("X from mm", "X to mm", "-20", "20"), ("Y from mm", "Y to mm", "-20", "20"),
                                ("Points X", "Points Y", "5", "5")):
        field(s, x + 14, cy, half, lv, left, h=24, size=11)
        field(s, x + 24 + half, cy, half, rv, right, h=24, size=11)
        cy += 44
    more(s, x + 14, cy - 6, "Probe", 11.5)
    select(s, x + 14, cy + 4, w - 28, "the whole grid", h=24, size=11)
    cy += 36
    bw = button(s, x + 14, cy, "Fit to job", h=24, size=11)
    s.text(x + 24 + bw, cy + 16, "25 points, about 0:06", size=11, fill=C["muted"])
    cy += 32
    buttons(s, x + 14, cy, [("Probe", "blue"), ("Stop", "palered")], h=24, size=11)
    cy += 32
    greylines(s, x + 14, cy, w - 40, 2, gap=8, height=3.5)
    cy += 22
    s.text(x + 14, cy + 12, "Pads", size=11, fill=C["muted"])
    s.text(x + 52, cy + 12, "Min area mm^2", size=10.5, fill=C["muted"])
    field(s, x + 140, cy, 50, "0.5", h=22, size=10.5)
    cy += 30
    s.text(x + 14, cy + 12, "Max points", size=10.5, fill=C["muted"])
    field(s, x + 80, cy, 50, "100", h=22, size=10.5)
    button(s, x + 138, cy, "Plan", "off", h=22, size=10.5)
    cy += 30
    button(s, x + 14, cy, "Probe pads", "paleblue", h=24, size=11)
    cy += 32
    greylines(s, x + 14, cy, w - 40, 3, gap=8, height=3.5)
    cy += 30
    buttons(s, x + 14, cy, [("Probe here: tie map", "off"), ("Probe nearest: tie map", "off")], h=24, size=10.5)
    cy += 30
    button(s, x + 14, cy, "Probe here: set H 0", h=24, size=10.5)
    cy += 32
    greylines(s, x + 14, cy, w - 40, 3, gap=8, height=3.5)
    cy += 30
    s.text(x + 14, cy + 12, "Focus offset mm", size=10.5, fill=C["muted"])
    field(s, x + 110, cy, 56, "", h=22, size=10.5)
    button(s, x + 172, cy, "Set", "off", h=22, size=10.5)
    button(s, x + 214, cy, "Focus here", "off", h=22, size=10.5)
    cy += 30
    s.text(x + 14, cy + 12, "Rayleigh mm", size=10.5, fill=C["muted"])
    field(s, x + 90, cy, 50, "0.5", h=22, size=10.5)
    buttons(s, x + 148, cy, [("Save map", "off"), ("Load map", "plain"), ("Clear", "off")], h=22, size=10.5, gap=5)
    return y + h


def fig_next_action():
    s = Svg(960, 724, "The Height map panel today next to the proposed Height map step, folded and with More "
                      "opened")
    heading(s, 30, 34, "Now", True)
    heading(s, 520, 34, "Proposed", False)
    end = heightmap_now(s, 30, 54, 410)
    para(s, 30, end + 28, 420, "12 buttons and 9 fields of the same weight; the order to use them in, and what "
         "Probe will do, are left to you.", size=12.5, fill=C["muted"])
    # proposed
    x, y, w = 520, 54, 410
    more_opened(s, x, y + 364, w)
    panel(s, x, y, w, 330, "Height map", fold=False)
    s.text(x + w - 14, y + 24, "step 4 of 6", size=11.5, fill=C["muted"], anchor="end")
    s.text(x + 16, y + 68, "25 points over the job", size=17, weight=700)
    s.text(x + 16, y + 90, "about 0:06; the probe touches each point once", size=12.5, fill=C["muted"])
    # what will happen
    gx, gy, gw, gh = x + 16, y + 108, 150, 96
    s.rect(gx, gy, gw, gh, fill="#fbf7ea", stroke=C["line"], r=8)
    s.rect(gx + 16, gy + 14, gw - 32, gh - 28, stroke=C["muted"], sw=1.2, r=4, dash="4 3")
    for i in range(5):
        for j in range(5):
            s.circle(gx + 22 + i * (gw - 44) / 4, gy + 20 + j * (gh - 40) / 4, 2.6, fill=C["ink"])
    s.text(gx + gw + 14, gy + 30, "Area", size=11.5, fill=C["muted"])
    s.text(gx + gw + 14, gy + 48, "fits the job, 2 mm out", size=12.5)
    button(s, gx + gw + 10, gy + 60, "Change", "ghost", h=24, size=12.5)
    button(s, x + 16, y + 222, "Probe 25 points", "primary", w=w - 32, h=38, size=14)
    hr(s, x + 16, y + 278, w - 32)
    more(s, x + 16, y + 306, "More: pads only, tie the map, focus offset, save and load", 12)
    para(s, 520, end + 28, 410, "What will happen, how long it takes, and the one action; the rest one press away "
         "in the same place, grouped and named.", size=12.5, fill=C["muted"])
    badge(s, x + w - 20, y + 74, 1)
    badge(s, gx + gw - 4, gy + 6, 2)
    badge(s, x + w - 20, y + 241, 3)
    badge(s, x + w - 20, y + 302, 4)
    return s.save("next-action.svg")


def more_opened(s, x, y, w):
    """The proposed Height map step's More, opened: the same controls as today, grouped under names."""
    s.text(x, y - 12, "More, opened", size=12, weight=700, fill=C["muted"])
    s.rect(x, y, w, 236, fill=C["panel"], stroke=C["line"], r=10)
    chev(s, x + 19, y + 22, "down", C["muted"], 4)
    s.text(x + 30, y + 26, "More", size=12.5, fill=C["muted"])
    rows = [
        ("Probe the pads instead of a grid", None),
        ("Tie the map after a restart", ["Probe here", "Probe nearest"]),
        ("Focus offset", None),
        ("The map", ["Save", "Load", "Clear"]),
    ]
    ry = y + 52
    for name, actions in rows:
        s.text(x + 16, ry, name, size=12.5, weight=700)
        if name.startswith("Probe the pads"):
            toggle(s, x + w - 46, ry - 13, False)
            s.text(x + 16, ry + 18, "pads over 0.5 mm^2, at most 100 points", size=11.5, fill=C["muted"])
            ry += 44
        elif name == "Focus offset":
            field(s, x + w - 150, ry - 17, 84, "0.00", unit="mm", h=26)
            button(s, x + w - 58, ry - 17, "Set", "plain", w=42, h=26)
            ry += 36
        else:
            buttons(s, x + 16, ry + 8, actions, h=26, size=12)
            ry += 58
    badge(s, x + w - 14, y + 4, 5)


def findboard_now(s, x, y, w):
    h = 546
    panel(s, x, y, w, h, "Find board", edge=C["violet"])
    chip(s, x + w - 92, y + 12, "stopped")
    cy = y + 52
    s.text(x + 14, cy + 17, "Camera", size=11, fill=C["muted"])
    select(s, x + 64, cy, w - 140, "Head camera (/dev/video0), stopped", h=26, size=11)
    cy += 40
    s.text(x + 14, cy + 4, "The head camera is not running: start it in its panel.", size=11.5)
    cy += 16
    buttons(s, x + 14, cy, [("Look for board", "off"), ("Search", "off"), ("Full scan", "off")], h=24, size=11)
    cy += 30
    buttons(s, x + 14, cy, [("Use as board place", "off"), ("Clear guesses", "off"), ("Unload", "off")], h=24,
            size=11)
    cy += 30
    s.text(x + 14, cy + 15, "Scan", size=11, fill=C["muted"])
    select(s, x + 48, cy, 110, "At rest", h=24, size=11)
    cy += 40
    s.text(x + 14, cy, "No board loaded: pick a board job and press Look for board.", size=11.5,
           decoration="underline")
    cy += 24
    s.text(x + 14, cy, "Guesses", size=11.5, weight=700, decoration="underline")
    cy += 10
    s.rect(x + 14, cy, w - 28, 64, fill="#fbf7ea", stroke=C["line"], r=6)
    s.line(x + 40, cy + 32, x + w - 40, cy + 32, C["muted"], 1.2)
    s.text(x + w - 46, cy + 26, "threshold 50%", size=10, fill=C["muted"], anchor="end")
    s.text(x + (w) / 2, cy + 52, "no guesses yet", size=10, fill=C["faint"], anchor="middle")
    cy += 78
    s.text(x + 14, cy + 12, "Threshold", size=11, fill=C["muted"], decoration="underline")
    s.rect(x + 80, cy + 6, 140, 4, fill=C["pale"], r=2)
    s.circle(x + 150, cy + 8, 6, fill="#268bd2")
    s.text(x + 230, cy + 12, "50%", size=11)
    cy += 26
    s.text(x + 14, cy + 15, "Method", size=11, fill=C["muted"], decoration="underline")
    select(s, x + 64, cy, 150, "Vote among guesses", h=24, size=11)
    checkbox(s, x + 224, cy + 5, False, "Board stretch", size=11, faint=True)
    cy += 36
    s.text(x + 14, cy + 4, "Rough place by corners", size=11.5, weight=700)
    cy += 12
    s.text(x + 14, cy + 15, "Corner", size=11, fill=C["muted"])
    select(s, x + 60, cy, 100, "bottom left", h=24, size=11)
    buttons(s, x + 168, cy, [("Corner here", "off"), ("Corner by edges", "off")], h=24, size=10.5, gap=5)
    cy += 30
    button(s, x + 14, cy, "Clear corners", "off", h=24, size=10.5)
    s.text(x + 120, cy + 16, "Within mm", size=11, fill=C["muted"])
    field(s, x + 184, cy, 44, "2", h=24, size=11)
    cy += 36
    greylines(s, x + 14, cy, w - 34, 7, gap=8, height=3.5)
    cy += 64
    more(s, x + 14, cy, "What the words mean", 11.5)
    return y + h


def fig_disabled_wall():
    s = Svg(960, 664, "The Find board panel with its camera off, today and proposed, and the proposed panel "
                      "once the board is found")
    heading(s, 30, 34, "Now", True)
    heading(s, 520, 34, "Proposed", False)
    end = findboard_now(s, 30, 54, 420)
    para(s, 30, end + 26, 430, "Nine locked buttons, a chart with nothing in it and a paragraph; the one thing to "
         "do is in another panel.", size=12.5, fill=C["muted"])
    x, w = 520, 410
    s.text(x, 74, "The camera is off", size=12, fill=C["muted"], weight=700)
    y = 84
    panel(s, x, y, w, 150, "Find board", fold=False)
    icon(s, "camera", x + 34, y + 72, C["muted"], 30)
    s.text(x + 62, y + 70, "The camera is off.", size=16, weight=700)
    s.text(x + 62, y + 90, "Then the page looks for the board by itself.", size=12.5, fill=C["muted"])
    button(s, x + 16, y + 104, "Start the camera", "primary", w=w - 32, h=34, size=13.5)
    badge(s, x + w - 18, y + 121, 1)
    s.text(x, 284, "A moment later: the board is found", size=12, fill=C["muted"], weight=700)
    y = 294
    panel(s, x, y, w, 196, "Find board", fold=False)
    mark(s, x + 28, y + 66, "ok", 11)
    s.text(x + 48, y + 72, "Board found", size=16, weight=700)
    s.text(x + 48, y + 92, "94% sure: two places agree, 0.04 mm apart", size=12.5, fill=C["muted"])
    button(s, x + 16, y + 108, "Use this place", "primary", w=w - 140, h=34, size=13.5)
    button(s, x + w - 116, y + 108, "Look again", "plain", w=100, h=34)
    hr(s, x + 16, y + 156, w - 32)
    more(s, x + 16, y + 180, "More: method, threshold, full scan, corners by hand", 12)
    badge(s, x + w - 18, y + 70, 2)
    badge(s, x + w - 18, y + 176, 3)
    para(s, x, 528, 410, "The step shows the action that unlocks it, then its result and the action the result "
         "allows. Nothing locked is shown.", size=12.5, fill=C["muted"])
    return s.save("disabled-wall.svg")


def fig_dark_cockpit():
    s = Svg(960, 660, "Color today marks pages and buttons; proposed, color marks only a state, shown in the "
                      "status bar's four states")
    heading(s, 30, 34, "Now", True)
    heading(s, 500, 34, "Proposed", False)
    # now: three mini panels in page colors
    tabs = [("Jobs", C["orange"]), ("Plot", C["green"]), ("CAM", C["cyan"]), ("PNP", C["violet"]),
            ("Auto", C["magenta"]), ("Config", C["yellow"])]
    tx = 30
    for name, color in tabs:
        tw_ = tw(name, 12.5) + 18
        s.text(tx + tw_ / 2, 70, name, size=12.5, anchor="middle", weight=700 if name == "Jobs" else None)
        s.rect(tx, 78, tw_ - 3, 3, fill=color, r=1.5)
        tx += tw_
    y = 96
    panel(s, 30, y, 200, 140, "Setup", edge=C["orange"])
    chip(s, 140, y + 12, "0 of 7", "run")
    for i in range(4):
        mark(s, 52 + i * 44, y + 70, "current" if i == 0 else "todo", 9)
    s.text(44, y + 106, "Next, Connect: Pick the port", size=11, fill=C["muted"])
    panel(s, 240, y, 210, 140, "Run", edge=C["orange"])
    buttons(s, 254, y + 50, [("Run", "paleblue"), ("Hold", "off")], h=28)
    chip(s, 254, y + 92, "map off")
    panel(s, 30, y + 152, 420, 104, "Laser", edge=C["orange"])
    buttons(s, 44, y + 196, [("Test beam", "danger"), ("Laser off", "plain")], h=30)
    segmented(s, 250, y + 197, ["dyn", "const"], 0)
    para(s, 30, y + 290, 420, "Six page colors, blue, pale blue and red buttons, colored chips: when the map goes "
         "stale, nothing about it stands out.", size=12.5, fill=C["muted"])
    # proposed
    x = 500
    s.text(x, 70, "Areas are told apart by name and place, not color", size=12.5, fill=C["muted"])
    panel(s, x, y, 200, 140, "Setup", fold=False)
    for i in range(4):
        mark(s, x + 22 + i * 44, y + 70, "ok" if i < 2 else ("current" if i == 2 else "todo"), 9)
    s.text(x + 14, y + 106, "Next: Height map", size=12)
    panel(s, x + 210, y, 220, 140, "Run", fold=False)
    button(s, x + 224, y + 50, "Run", "primary", w=80)
    s.rect(x + 224, y + 90, 192, 30, fill=SOFT["warn"], r=6)
    mark(s, x + 238, y + 105, "warn", 7.5)
    s.text(x + 252, y + 109.5, "Map older than the board", size=11.5)
    panel(s, x, y + 152, 430, 104, "Laser", fold=False)
    buttons(s, x + 14, y + 196, [("Test beam", "danger"), ("Laser off", "plain")], h=30)
    chip(s, x + 220, y + 200, "Laser on", "alarm")
    para(s, x, y + 290, 430, "Neutral when normal. The stale map is the only yellow and the beam the only red, "
         "so both are found at a glance.", size=12.5, fill=C["muted"])
    # status bar states
    y0 = 432
    s.text(30, y0, "The status bar in its four states", size=14, weight=700)
    rows = [
        ("Normal", dict(machine="Polar laser", state="Idle", kind="neutral", message="Ready: demo coupon, step 4 of 6")),
        ("Working", dict(machine="Polar laser", state="Running", kind="run", progress=0.62,
                         message="demo coupon 62%, 2:10 left")),
        ("Needs you", dict(machine="Polar laser", state="Idle", kind="warn",
                           message="The height map is older than the board's place", action="Probe again")),
        ("Alarm", dict(machine="Polar laser", state="Alarm", kind="alarm", message="Endstop hit on R: Unlock, then Home",
                       action="Unlock")),
    ]
    yy = y0 + 16
    for label, kw in rows:
        s.text(30, yy + 27, label, size=12.5, weight=700, fill=C["muted"])
        s.rect(118, yy, 812, 44, fill=C["panel"], r=8)
        statusbar(s, 118, yy, 812, h=44, pill_x=132, r=8, **kw)
        s.rect(118, yy, 812, 44, stroke=C["line"], r=8)
        yy += 52
    return s.save("dark-cockpit.svg")


def fig_modes():
    s = Svg(960, 560, "The settings that change what a run does, scattered over five panels today and gathered "
                      "in one Ready card")
    heading(s, 30, 34, "Now", True)
    heading(s, 500, 34, "Proposed", False)
    # five small panels, the mode bit ringed in each
    spots = [
        (30, 56, 200, 92, "Jog", "Travel H", "off"),
        (240, 56, 200, 92, "Laser", "Mode", "dyn"),
        (30, 160, 200, 92, "Height map", "", "no map"),
        (240, 160, 200, 92, "Run", "", "map off"),
        (30, 264, 410, 92, "Setup", "", "Focus"),
    ]
    for x, y, w, h, title, label, value in spots:
        panel(s, x, y, w, h, title, edge=C["orange"])
        vx = x + w - 96
        if label:
            s.text(x + 14, y + 67.5, label, size=12, fill=C["muted"])
        else:
            greylines(s, x + 14, y + 50, w - 130, 3, gap=10, height=4)
        s.rect(vx, y + 50, 80, 26, fill=C["field"], stroke=C["line"], r=6)
        s.text(vx + 40, y + 67.5, value, size=12, anchor="middle")
        s.rect(vx - 5, y + 45, 90, 36, stroke=C["note"], sw=2, r=9, dash="5 3")
    s.text(30, 390, "Five places to check before every run, two of them", size=12.5, fill=C["muted"])
    s.text(30, 408, "in panels that may be folded or scrolled away.", size=12.5, fill=C["muted"])
    # ready card
    x, y, w = 500, 56, 430
    panel(s, x, y, w, 436, "Ready to run", fold=False)
    s.text(x + w - 14, y + 24, "about 6 min", size=12.5, fill=C["muted"], anchor="end")
    rows = [
        ("ok", "Job", "demo coupon, F.Cu: isolate and drill", None),
        ("ok", "Board", "found and lined up by 2 marks", None),
        ("ok", "Height map", "on: 25 points, probed 3 min ago", None),
        ("warn", "Focus", "not taken since the map", "Focus here"),
        ("ok", "Travel height", "5 mm over the board", None),
        ("info", "Laser", "dynamic power, S 600 at 600 mm/min", None),
    ]
    ry = y + 62
    for kind, name, value, action in rows:
        mark(s, x + 28, ry + 2, kind, 10)
        s.text(x + 48, ry + 7, name, size=13.5, weight=700)
        s.text(x + 150, ry + 7, value, size=12.5, fill=C["muted"])
        if action:
            button(s, x + 150, ry + 18, action, "plain", h=26, size=12)
            ry += 30
        ry += 42
        hr(s, x + 16, ry - 18, w - 32)
    button(s, x + 16, y + 372, "Run", "primary", w=w - 32, h=44, size=16)
    s.text(x + w / 2, y + 362, "Each line opens the step that sets it", size=11.5, fill=C["muted"], anchor="middle")
    badge(s, x + w - 20, y + 64, 1)
    badge(s, x + w - 20, y + 64 + 3 * 42, 2)
    badge(s, x + w - 20, y + 394, 3)
    para(s, 500, 520, 430, "Every mode the run depends on, in one card, in words, with the one that needs you "
         "marked and its fix beside it.", size=12.5, fill=C["muted"])
    return s.save("modes.svg")


def fig_words():
    s = Svg(960, 470, "Instructions written into a panel today, and the proposed one line of state with the "
                      "meaning on hover")
    heading(s, 30, 34, "Now", True)
    heading(s, 500, 34, "Proposed", False)
    text = ("Each column is a place the look puts the board, as tall as its share of the evidence (looks weighed "
            "by how well they matched); the most likely is found once it has enough looks and reaches the "
            "threshold line. Put the picture's center on a corner of the board (jog, or double-click it in the "
            "camera's picture), pick which corner it is and press Corner here: two give the board's place and "
            "turn, Search keeps to it, and a guess putting a corner further than Within is ruled out. With the "
            "top camera a corner is also one of the board's references, so Go to part and Find fiducials work "
            "from it at once; Use as board place takes a place found instead. With Probability over the pose "
            "each column is a place's probability, the last (?) what no place holds yet, where nothing has "
            "looked; Full scan, once a rough place is known, covers the whole board and lays its pictures out "
            "below.")
    panel(s, 30, 54, 420, 320, "Find board", edge=C["violet"])
    para(s, 44, 104, 392, text, size=11.2, fill=C["muted"], lh=1.38)
    more(s, 44, 352, "What the words mean", 11.5)
    para(s, 30, 404, 420, "About 150 words in one panel, read once if at all; the same words greet you on every "
         "run after.", size=12.5, fill=C["muted"])
    # proposed: chart with labels and a hover
    x, y, w = 500, 54, 430
    panel(s, x, y, w, 320, "Find board", fold=False)
    s.text(x + 16, y + 66, "Board found", size=16, weight=700)
    s.spans(x + 16, y + 88, [("94% sure: its ", {"fill": C["muted"]}),
                             ("share", {"text-decoration": "underline"}),
                             (" of the looks; two places agree", {"fill": C["muted"]})], size=12.5)
    # bars of guesses, to the right of where the hover opens
    bx, by = x + 16, y + 108
    s.rect(bx, by, w - 32, 100, fill="#fbf7ea", stroke=C["line"], r=8)
    for i, v in enumerate((0.94, 0.04, 0.02)):
        s.rect(bx + 290 + i * 34, by + 88 - 66 * v, 24, 66 * v, fill=C["muted"] if i == 0 else C["faint"], r=3)
    s.text(bx + 302, by + 88 - 66 * 0.94 - 6, "94%", size=11, anchor="middle")
    # the hover box under the word
    hx, hy = x + 26, y + 102
    s.path(f"M{x + 88},{hy} L{x + 96},{hy - 8} L{x + 104},{hy} Z", fill=C["ink"])
    s.rect(hx, hy, 258, 76, fill=C["ink"], r=8)
    para(s, hx + 12, hy + 21, 236, "Share: how much of what the camera saw points to this place. The board "
         "counts as found past the threshold, 50%.", size=11.5, fill="#fdf6e3")
    s.text(x + 16, y + 238, "Threshold 50%  |  Method: vote", size=12, fill=C["muted"])
    button(s, x + 16, y + 254, "Use this place", "primary", h=32)
    button(s, x + 150, y + 254, "Look again", "plain", h=32)
    s.circle(x + w - 30, y + 270, 12, stroke=C["muted"], sw=1.4)
    s.text(x + w - 30, y + 274.5, "?", size=13, weight=700, fill=C["muted"], anchor="middle")
    badge(s, x + w - 20, y + 64, 1)
    badge(s, hx + 258, hy + 4, 2)
    badge(s, x + w - 54, y + 252, 3)
    para(s, x, 404, 430, "One line of state in the panel; a word's meaning on hover; the how-to behind the "
         "question mark, which opens the guide at its section.", size=12.5, fill=C["muted"])
    return s.save("words.svg")


def fig_undo():
    s = Svg(960, 380, "A confirm dialog for an undoable action today, the proposed Undo, and the confirm kept "
                      "for a hazard")
    heading(s, 30, 34, "Now", True)
    heading(s, 340, 34, "Proposed", False)
    heading(s, 650, 34, "Kept: a hazard", False)
    # now: modal over a dimmed panel
    s.rect(30, 56, 280, 230, fill=C["pale"], r=10)
    s.rect(50, 96, 240, 140, fill=C["panel"], stroke=C["line"], r=10)
    s.text(66, 126, "Clear the guesses?", size=14, weight=700)
    para(s, 66, 148, 210, "This forgets every guess and its share.", size=12, fill=C["muted"])
    buttons(s, 128, 190, [("Cancel", "plain"), ("Clear", "blue")])
    para(s, 30, 316, 280, "Asked every time, answered without reading by the third.", size=12.5, fill=C["muted"])
    # proposed: toast with undo
    s.rect(340, 56, 280, 230, fill=C["panel"], stroke=C["line"], r=10)
    greylines(s, 356, 80, 200, 4, gap=14, height=5)
    s.rect(356, 214, 248, 46, fill=C["ink"], r=8)
    s.text(372, 242, "Guesses cleared.", size=13, fill="#fdf6e3")
    s.text(560, 242, "Undo", size=13, weight=700, fill="#fdf6e3", decoration="underline")
    para(s, 340, 316, 280, "It happens at once; Undo stays for a while and in the log.", size=12.5, fill=C["muted"])
    # hazard confirm
    s.rect(650, 56, 280, 230, fill=C["pale"], r=10)
    s.rect(666, 86, 248, 170, fill=C["panel"], stroke=C["line"], r=10)
    mark(s, 690, 118, "alarm", 11)
    s.text(708, 123, "Fire the beam?", size=14, weight=700)
    para(s, 682, 148, 220, "S 1000 for 1000 ms at the head's place. Wear the glasses.", size=12, fill=C["muted"])
    buttons(s, 722, 208, [("Cancel", "plain"), ("Fire the beam", "danger")])
    para(s, 650, 316, 280, "Only for what cannot be undone and can hurt; the button says what it does.",
         size=12.5, fill=C["muted"])
    return s.save("undo.svg")


def jog_now(s, x, y, w):
    h = 524
    panel(s, x, y, w, h, "Jog", edge=C["orange"])
    buttons(s, x + 12, y + 40, [("Fine", "plain"), ("Hold to move", "plain"), ("Cancel", "palered")], h=22,
            size=10.5, gap=5)
    gx, gy = x + 12, y + 70
    for i in range(3):
        for j in range(3):
            s.rect(gx + i * 56, gy + j * 30, 52, 26, fill=C["field"], stroke=C["line"], r=5)
    s.text(gx + 82, gy + 46, "x  y", size=10, fill=C["muted"], anchor="middle")
    cy = gy + 98
    rows = [("BOARD X", ["0.1 mm", "1 mm", "10 mm"]), ("BOARD Y", ["0.1 mm", "1 mm", "10 mm"]),
            ("RADIUS", ["0.1 mm", "1 mm", "10 mm"]), ("TABLE", ["1 deg", "10 deg", "90 deg"]),
            ("CROSS SLIDE", ["0.05 mm", "0.1 mm", "0.5 mm"]), ("FOCUS AXIS", ["0.05 mm", "0.1 mm", "1 mm"])]
    for name, steps in rows:
        s.text(x + 12, cy + 9, name, size=9.5, weight=700, spacing=0.8)
        segmented(s, x + 12, cy + 14, steps, 1, h=20, size=9.5, each=50)
        s.rect(x + 166, cy + 14, 38, 20, fill=C["field"], stroke=C["line"], r=4)
        if name not in ("BOARD X", "BOARD Y"):
            s.rect(x + 210, cy + 14, 30, 20, fill=C["panel"], stroke=C["line"], r=4)
            s.rect(x + 244, cy + 14, 30, 20, fill=C["panel"], stroke=C["line"], r=4)
        cy += 42
    for label in ("Feed  Board go  Joint go  Center", "Here is R A Z H  Set position", "Travel H  Motors on  Unlock"):
        s.text(x + 12, cy + 10, label, size=9.5, fill=C["muted"])
        greylines(s, x + 12, cy + 16, w - 24, 1, height=6)
        cy += 30
    return y + h


def fig_dock():
    s = Svg(960, 650, "Six step choosers in the jog panel today, and one step level for every axis in the "
                      "proposed dock")
    heading(s, 30, 34, "Now", True)
    heading(s, 380, 34, "Proposed", False)
    end = jog_now(s, 30, 54, 300)
    para(s, 30, end + 26, 300, "Six step choosers, one per axis, and 15 more buttons; the same panel again on "
         "the Plot and PNP pages.", size=12.5, fill=C["muted"])
    x, y, w = 380, 56, 550
    s.text(x, y + 14, "The dock, opened by Jog or a held arrow key", size=12, fill=C["muted"], weight=700)
    y += 28
    s.rect(x, y, w, 330, fill=C["panel"], stroke=C["line"], r=12)
    # position
    cx = x + 18
    for name, value in (("X", "12.300"), ("Y", "45.000"), ("H", "2.100"), ("A", "90.00")):
        s.text(cx, y + 36, name, size=13, weight=700, fill=C["muted"])
        s.text(cx + 16, y + 36, value, size=17, mono=True)
        cx += 16 + mw(value, 17) + 26
    hr(s, x + 16, y + 54, w - 32)
    s.text(x + 18, y + 84, "Step", size=12.5, fill=C["muted"])
    segmented(s, x + 60, y + 66, ["Fine", "Normal", "Coarse"], 1, h=30, size=13, each=86)
    s.text(x + 352, y + 80, "Normal: X Y 1 mm, A 10 deg,", size=11.5, fill=C["muted"])
    s.text(x + 352, y + 96, "H 0.1 mm (from the machine file)", size=11.5, fill=C["muted"])
    # pad
    px, py = x + 18, y + 118
    arrows = [(-1, -1, ""), (0, -1, "Y+"), (1, -1, ""), (-1, 0, "X-"), (0, 0, ""), (1, 0, "X+"), (-1, 1, ""),
              (0, 1, "Y-"), (1, 1, "")]
    for dx, dy, label in arrows:
        bx, by = px + (dx + 1) * 62, py + (dy + 1) * 44
        s.rect(bx, by, 56, 38, fill=C["field"] if label else C["panel"], stroke=C["line"], r=7)
        if label:
            s.text(bx + 28, by + 24, label, size=13, anchor="middle", weight=600)
    s.circle(px + 90, py + 63, 5, fill=C["faint"])
    hx = px + 210
    s.text(hx, py + 12, "Focus H", size=11.5, fill=C["muted"])
    s.rect(hx, py + 20, 70, 38, fill=C["field"], stroke=C["line"], r=7)
    s.text(hx + 35, py + 44, "Up", size=13, anchor="middle", weight=600)
    s.rect(hx, py + 64, 70, 38, fill=C["field"], stroke=C["line"], r=7)
    s.text(hx + 35, py + 88, "Down", size=13, anchor="middle", weight=600)
    tx = hx + 90
    s.text(tx, py + 12, "Table A", size=11.5, fill=C["muted"])
    s.rect(tx, py + 20, 76, 38, fill=C["field"], stroke=C["line"], r=7)
    s.text(tx + 38, py + 44, "Turn +", size=13, anchor="middle", weight=600)
    s.rect(tx, py + 64, 76, 38, fill=C["field"], stroke=C["line"], r=7)
    s.text(tx + 38, py + 88, "Turn -", size=13, anchor="middle", weight=600)
    s.text(px, py + 160, "Arrows move X Y, PageUp and PageDown move H, Shift moves one Fine step.",
           size=12, fill=C["muted"])
    hr(s, x + 16, y + 292, w - 32)
    more(s, x + 18, y + 316, "More: go to a place or marker, set position, motors, unlock", 12)
    badge(s, x + w - 18, y + 30, 1)
    badge(s, x + 335, y + 81, 2)
    badge(s, x + w - 18, y + 150, 3)
    badge(s, x + w - 18, y + 312, 4)
    # folded dock
    s.text(x, y + 368, "Folded, on every screen of the Run area", size=12, fill=C["muted"], weight=700)
    dock(s, x, y + 380, w, [("X", "12.300"), ("Y", "45.000"), ("H", "2.100")], ["Home", "Laser off"])
    para(s, x, y + 466, w, "One step level for every axis, mapped per axis by the machine file; the same dock "
         "on every screen and every machine.", size=12.5, fill=C["muted"])
    return s.save("dock.svg")


# ---------------------------------------------------------------- screens

FRAME = (10, 10, 1000, 620)
STEPS_LASER = ["Connect", "Home", "Find board", "Height map", "Focus", "Run"]


def screen_home():
    s = Svg(1020, 640, "Proposed Home: where you left off, the machine, what needs you, recent jobs")
    X, Y, W, H = FRAME
    x0, y0, ww, wh = window(s, X, Y, W, H, "Home", message="Ready: demo coupon, step 3 of 6")
    # continue card
    x, y, w = x0 + 14, y0 + 14, ww - 28
    s.rect(x, y, w, 170, fill=C["panel"], stroke=C["line"], r=12)
    s.rect(x + 18, y + 18, 190, 134, fill="#fbf7ea", stroke=C["line"], r=8)
    board_preview(s, x + 34, y + 32, 158, 106, "#fbf7ea")
    s.text(x + 232, y + 44, "CONTINUE", size=11, weight=700, spacing=1.2, fill=C["muted"])
    s.text(x + 232, y + 74, "demo coupon on the Polar laser", size=21, weight=700)
    s.text(x + 232, y + 98, "Set up 2 of 6 steps. Next: find the board with the camera.", size=13.5,
           fill=C["muted"])
    for i in range(6):
        mark(s, x + 242 + i * 30, y + 122, "ok" if i < 2 else ("current" if i == 2 else "todo"), 8.5)
    button(s, x + w - 222, y + 106, "Continue: Find board", "primary", w=200, h=40, size=14)
    badge(s, x + w - 14, y + 18, 1)
    # three cards
    cw, ch, cy = (w - 28) / 3, 344, y0 + 198
    cards = [x0 + 14, x0 + 14 + cw + 14, x0 + 14 + 2 * (cw + 14)]
    # machine
    cx = cards[0]
    s.rect(cx, cy, cw, ch, fill=C["panel"], stroke=C["line"], r=12)
    s.text(cx + 18, cy + 30, "MACHINE", size=11, weight=700, spacing=1.2, fill=C["muted"])
    s.text(cx + 18, cy + 60, "Polar laser", size=17, weight=700)
    chip(s, cx + 18, cy + 74, "Connected, idle", "neutral")
    s.text(cx + 18, cy + 124, "Others", size=11.5, fill=C["muted"])
    for i, name in enumerate(("Cartesian mill", "K40", "LumenPnP")):
        s.text(cx + 18, cy + 148 + i * 26, name, size=13)
        s.text(cx + cw - 18, cy + 148 + i * 26, "Switch", size=12.5, anchor="end", decoration="underline")
    badge(s, cx + cw - 14, cy + 18, 2)
    # needs you
    cx = cards[1]
    s.rect(cx, cy, cw, ch, fill=C["panel"], stroke=C["line"], r=12)
    s.text(cx + 18, cy + 30, "NEEDS YOU", size=11, weight=700, spacing=1.2, fill=C["muted"])
    items = [("warn", "Camera offset not measured", "Machines"), ("warn", "1 edit not saved", "polar-laser.toml"),
             ("info", "Update 0.2.0 ready", "Settings")]
    for i, (kind, text, where) in enumerate(items):
        iy = cy + 62 + i * 56
        mark(s, cx + 28, iy, kind, 9.5)
        s.text(cx + 46, iy + 4, text, size=13)
        s.text(cx + 46, iy + 22, where, size=11.5, fill=C["muted"], decoration="underline")
    badge(s, cx + cw - 14, cy + 18, 3)
    # recent jobs
    cx = cards[2]
    s.rect(cx, cy, cw, ch, fill=C["panel"], stroke=C["line"], r=12)
    s.text(cx + 18, cy + 30, "RECENT JOBS", size=11, weight=700, spacing=1.2, fill=C["muted"])
    for i, (name, sub) in enumerate((("demo coupon", "Gerber, 2:33"), ("battery card", "KiCad, 6:10"),
                                     ("logo test", "SVG, 0:48"), ("paste stencil", "KiCad, 3:05"))):
        iy = cy + 50 + i * 66
        s.rect(cx + 18, iy, 64, 48, fill="#fbf7ea", stroke=C["line"], r=6)
        board_preview(s, cx + 24, iy + 6, 52, 36, "#fbf7ea", holes=False)
        s.text(cx + 94, iy + 20, name, size=13, weight=700 if i == 0 else None)
        s.text(cx + 94, iy + 38, sub, size=11.5, fill=C["muted"])
    badge(s, cx + cw - 14, cy + 18, 4)
    end_window(s, X, Y, W, H)
    return s.save("screen-home.svg")


def screen_job():
    s = Svg(1020, 640, "Proposed Job area: jobs on the left, the preview in the middle, the job's operations "
                       "and one next action on the right")
    X, Y, W, H = FRAME
    x0, y0, ww, wh = window(s, X, Y, W, H, "Job")
    # list
    lx, ly, lw, lh = x0 + 14, y0 + 14, 214, wh - 28
    s.rect(lx, ly, lw, lh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(lx + 14, ly + 26, "JOBS", size=11, weight=700, spacing=1.2)
    button(s, lx + lw - 102, ly + 10, "New job", "plain", w=88)
    chev(s, lx + lw - 26, ly + 24, "down", C["muted"], 3.4)
    jobs = [("demo coupon", "Gerber, 2:33", "cut"), ("battery card", "KiCad, 6:10", "cut"),
            ("battery card parts", "52 parts", "place"), ("logo test", "SVG, 0:48", "cut")]
    for i, (name, sub, kind) in enumerate(jobs):
        jy = ly + 50 + i * 64
        if i == 0:
            s.rect(lx + 6, jy - 4, lw - 12, 58, fill=C["tint"], r=8)
        s.rect(lx + 14, jy + 2, 52, 40, fill="#fbf7ea", stroke=C["line"], r=5)
        board_preview(s, lx + 19, jy + 7, 42, 30, "#fbf7ea", holes=False,
                      color=C["violet"] if kind == "place" else None)
        s.text(lx + 76, jy + 20, name, size=12.5, weight=700 if i == 0 else None)
        s.text(lx + 76, jy + 37, sub, size=11, fill=C["muted"])
    # canvas
    cx, cy, cw, chh = lx + lw + 12, ly, 404, lh
    s.rect(cx, cy, cw, chh, fill="#fbf7ea", stroke=C["line"], r=10)
    board_preview(s, cx + 40, cy + 120, cw - 80, 250, "#fbf7ea")
    segmented(s, cx + 12, cy + 12, ["2D", "3D"], 0, h=28, size=12)
    vx = buttons(s, cx + 100, cy + 12, ["Fit"])
    s.rect(vx, cy + 12, 72, 28, fill=C["panel"], stroke=C["line"], r=6)
    s.text(vx + 14, cy + 30.5, "View", size=12.5)
    chev(s, vx + 56, cy + 26, "down", C["muted"], 3.4)
    s.text(cx + cw - 14, cy + chh - 14, "drag moves the job; wheel zooms", size=11, fill=C["muted"], anchor="end")
    badge(s, cx + cw - 16, cy + 16, 2)
    # job panel
    px, py, pw = cx + cw + 12, ly, x0 + ww - 14 - (cx + cw + 12)
    s.rect(px, py, pw, lh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(px + 16, py + 32, "demo coupon", size=17, weight=700)
    s.text(px + 16, py + 52, "Gerber, F.Cu, 180 mm of cuts, 2:33", size=11.5, fill=C["muted"])
    s.text(px + 16, py + 84, "OPERATIONS", size=10.5, weight=700, spacing=1.1, fill=C["muted"])
    ops = [(True, "Isolate", "S 600, 600 mm/min, 2 loops"), (False, "Clear copper", "off"),
           (True, "Drill", "4 holes, 0.8 mm"), (False, "Outline", "off")]
    oy = py + 98
    for on, name, sub in ops:
        toggle(s, px + 16, oy + 6, on)
        s.text(px + 56, oy + 14, name, size=13, weight=700 if on else None, fill=C["ink"] if on else C["muted"])
        s.text(px + 56, oy + 31, sub, size=11, fill=C["muted"])
        chev(s, px + pw - 20, oy + 16, "right", C["muted"], 4)
        oy += 46
        hr(s, px + 16, oy - 6, pw - 32)
    badge(s, px + pw - 14, py + 92, 3)
    s.text(px + 16, oy + 22, "ON THE BOARD", size=10.5, weight=700, spacing=1.1, fill=C["muted"])
    s.text(px + 16, oy + 44, "F.Cu, not mirrored, centered", size=12.5)
    button(s, px + 10, oy + 52, "Change", "ghost", h=24, size=12.5)
    badge(s, px + pw - 14, oy + 38, 4)
    button(s, px + 16, py + lh - 96, "Run on the Polar laser", "primary", w=pw - 32, h=40, size=14)
    buttons(s, px + 16, py + lh - 46, ["Export G-code", "..."], h=30)
    badge(s, px + pw - 14, py + lh - 96, 5)
    # the New job menu, open over the list and the canvas
    mx, my = lx + lw - 104, ly + 44
    s.rect(mx + 2, my + 3, 250, 138, fill="#d9d2bc", r=10, opacity=0.6)
    s.rect(mx, my, 250, 138, fill=C["panel"], stroke=C["line"], r=10)
    for i, (title, sub) in enumerate((("Open a file", "KiCad, Gerber, SVG, DXF, STL, G-code"),
                                      ("Draw it", "drill, holes, line, face, pocket, profile"),
                                      ("Describe it", "the assistant makes the job"))):
        iy = my + 14 + i * 42
        s.text(mx + 16, iy + 14, title, size=13, weight=700)
        s.text(mx + 16, iy + 31, sub, size=11, fill=C["muted"])
    badge(s, mx + 250, my + 4, 1)
    end_window(s, X, Y, W, H)
    return s.save("screen-job.svg")


def screen_run_find():
    s = Svg(1020, 640, "Proposed Run area at the Find board step: the camera's picture large, the step's "
                       "result and action on the right, the dock folded below")
    X, Y, W, H = FRAME
    x0, y0, ww, wh = window(s, X, Y, W, H, "Run", message="demo coupon: step 3 of 6")
    stepstrip(s, x0 + 14, y0 + 12, ww - 28, STEPS_LASER, 2)
    badge(s, x0 + ww - 18, y0 + 16, 1)
    cx, cy, cw, chh = x0 + 14, y0 + 70, 560, 420
    board_photo(s, cx, cy, cw, chh)
    s.text(cx + 14, cy + chh - 14, "drag moves the head; a double-click goes there", size=11, fill="#c9d1cc")
    buttons(s, cx + cw - 132, cy + 12, [("Picture", "plain"), ("Zoom", "plain")], h=26, size=11.5, gap=6)
    badge(s, cx + 18, cy + 18, 2)
    px, py, pw = cx + cw + 12, cy, x0 + ww - 14 - (cx + cw + 12)
    s.rect(px, py, pw, chh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(px + 16, py + 28, "FIND BOARD", size=11, weight=700, spacing=1.2)
    mark(s, px + 28, py + 68, "ok", 11)
    s.text(px + 48, py + 74, "Board found", size=17, weight=700)
    s.text(px + 48, py + 95, "94% sure; two places agree", size=12.5, fill=C["muted"])
    s.text(px + 48, py + 113, "0.04 mm apart, turned 0.3 deg", size=12.5, fill=C["muted"])
    badge(s, px + pw - 14, py + 66, 3)
    button(s, px + 16, py + 138, "Use this place", "primary", w=pw - 32, h=40, size=14)
    button(s, px + 16, py + 188, "Look again", "plain", w=pw - 32, h=32)
    hr(s, px + 16, py + 240, pw - 32)
    s.text(px + 16, py + 266, "If it is wrong:", size=12.5, fill=C["muted"])
    button(s, px + 10, py + 274, "Take two corners by hand", "ghost", h=26, size=12.5)
    hr(s, px + 16, py + 318, pw - 32)
    more(s, px + 16, py + 344, "More: method, threshold, full scan", 12)
    badge(s, px + pw - 14, py + 340, 4)
    s.text(px + 16, py + chh - 18, "Next: Height map", size=12.5, fill=C["muted"])
    dock(s, x0 + 14, y0 + wh - 64, ww - 28, [("X", "12.300"), ("Y", "45.000"), ("H", "2.100")],
         ["Home", "Light", "Laser off"])
    badge(s, x0 + 30, y0 + wh - 64, 5)
    end_window(s, X, Y, W, H)
    return s.save("screen-run-find.svg")


def screen_running():
    s = Svg(1020, 640, "Proposed Run area while a job runs: progress on the preview, time left, Hold and Stop "
                       "large, the run's modes in words")
    X, Y, W, H = FRAME
    x0, y0, ww, wh = window(s, X, Y, W, H, "Run", state="Running", kind="run", progress=0.62,
                            message="demo coupon 62%, 2:10 left")
    stepstrip(s, x0 + 14, y0 + 12, ww - 28, STEPS_LASER, 5, running=True)
    cx, cy, cw, chh = x0 + 14, y0 + 70, 560, 420
    s.rect(cx, cy, cw, chh, fill="#fbf7ea", stroke=C["line"], r=10)
    board_preview(s, cx + 50, cy + 60, cw - 100, chh - 120, "#fbf7ea", done=4)
    hx, hy = cx + 50 + 0.74 * (cw - 100), cy + 60 + 0.70 * (chh - 120)
    s.circle(hx, hy, 9, stroke=C["red"], sw=2)
    s.circle(hx, hy, 3.5, fill=C["red"])
    s.text(cx + 14, cy + chh - 14, "dark: cut; light: still to cut; red: the beam, on", size=11, fill=C["muted"])
    badge(s, cx + 18, cy + 18, 1)
    px, py, pw = cx + cw + 12, cy, x0 + ww - 14 - (cx + cw + 12)
    s.rect(px, py, pw, chh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(px + 16, py + 28, "RUNNING", size=11, weight=700, spacing=1.2)
    s.text(px + 16, py + 76, "62%", size=38, weight=700)
    s.text(px + 104, py + 64, "2:10 left", size=15, weight=700)
    s.text(px + 104, py + 82, "of about 5:40", size=12.5, fill=C["muted"])
    s.rect(px + 16, py + 96, pw - 32, 8, fill=C["pale"], r=4)
    s.rect(px + 16, py + 96, (pw - 32) * 0.62, 8, fill=C["blue"], r=4)
    s.text(px + 16, py + 126, "Isolate, loop 2 of 2; line 3121 of 5033", size=12, fill=C["muted"])
    badge(s, px + pw - 14, py + 66, 2)
    button(s, px + 16, py + 144, "Hold", "plain", w=(pw - 42) / 2, h=48, size=16)
    button(s, px + 26 + (pw - 42) / 2, py + 144, "Stop", "danger", w=(pw - 42) / 2, h=48, size=16)
    badge(s, px + pw - 14, py + 150, 3)
    hr(s, px + 16, py + 212, pw - 32)
    s.text(px + 16, py + 238, "THIS RUN", size=10.5, weight=700, spacing=1.1, fill=C["muted"])
    for i, (name, value) in enumerate((("Height map", "on, 25 points"), ("Focus", "2.10 mm"),
                                       ("Laser", "dynamic, S 600"), ("Travel", "5 mm over the board"))):
        s.text(px + 16, py + 264 + i * 24, name, size=12.5, fill=C["muted"])
        s.text(px + 112, py + 264 + i * 24, value, size=12.5)
    badge(s, px + pw - 14, py + 234, 4)
    hr(s, px + 16, py + 360, pw - 32)
    more(s, px + 16, py + 388, "Console", 12)
    s.text(px + pw - 16, py + 388, "no errors", size=12, fill=C["muted"], anchor="end")
    dock(s, x0 + 14, y0 + wh - 64, ww - 28, [("X", "18.410"), ("Y", "40.120"), ("H", "2.100")], [],
         note="Jog is off while the job runs", jog=False)
    end_window(s, X, Y, W, H)
    return s.save("screen-running.svg")


def screen_place():
    s = Svg(1020, 640, "Proposed Run area with a pick and place machine: the same frame and steps, the board "
                       "map with each part's state, one issue at a time")
    X, Y, W, H = FRAME
    x0, y0, ww, wh = window(s, X, Y, W, H, "Run", machine="LumenPnP", state="Placing", kind="run",
                            progress=34 / 52, message="34 of 52 parts placed")
    stepstrip(s, x0 + 14, y0 + 12, ww - 28, ["Connect", "Home", "Find board", "Fiducials", "Feeders", "Place"], 5,
              running=True)
    badge(s, x0 + ww - 18, y0 + 16, 1)
    cx, cy, cw, chh = x0 + 14, y0 + 70, 560, 420
    s.rect(cx, cy, cw, chh, fill="#fbf7ea", stroke=C["line"], r=10)
    bx, by, bw, bh = cx + 36, cy + 50, cw - 250, chh - 110
    s.rect(bx, by, bw, bh, stroke=C["muted"], sw=1.4, r=8)
    n = 0
    for row in range(6):
        for col in range(7):
            if (row, col) in ((2, 3), (0, 0), (5, 6)):
                continue
            px_ = bx + 24 + col * (bw - 48) / 6.6
            py_ = by + 26 + row * (bh - 52) / 5.4
            pw_, ph_ = (24, 13) if (row + col) % 3 else (15, 9)
            n += 1
            if n <= 30:
                s.rect(px_, py_, pw_, ph_, fill=C["muted"], r=2)
            elif n == 31:
                s.rect(px_ - 4, py_ - 4, pw_ + 8, ph_ + 8, stroke=C["blue"], sw=2.4, r=4)
                s.rect(px_, py_, pw_, ph_, fill=C["panel"], stroke=C["blue"], sw=1.4, r=2)
            elif n == 34:
                s.rect(px_, py_, pw_, ph_, fill=SOFT["warn"], stroke=C["yellow"], sw=1.8, r=2)
            else:
                s.rect(px_, py_, pw_, ph_, stroke=C["faint"], sw=1.2, r=2)
    for fx, fy in ((bx + 12, by + 12), (bx + bw - 12, by + bh - 12)):
        s.circle(fx, fy, 5, stroke=C["green"], sw=2)
    # the bottom camera's picture, shown while it has something to show
    ix, iy = cx + cw - 196, cy + 60
    s.rect(ix, iy, 180, 132, fill="#262b2a", r=8)
    s.rect(ix + 70, iy + 52, 40, 24, fill="#c9b78d", r=3)
    s.rect(ix + 63, iy + 52, 9, 24, fill="#d6d6d6", r=1.5)
    s.rect(ix + 108, iy + 52, 9, 24, fill="#d6d6d6", r=1.5)
    s.circle(ix + 90, iy + 64, 30, stroke="#7cc4f2", sw=1.4, dash="4 4")
    s.text(ix, iy + 152, "Bottom camera: C12 on the nozzle,", size=11, fill=C["muted"])
    s.text(ix, iy + 168, "0.03 mm off, turned 0.4 deg", size=11, fill=C["muted"])
    s.text(cx + 14, cy + chh - 14, "dark: placed; ringed: now; yellow: needs you", size=11, fill=C["muted"])
    badge(s, cx + 18, cy + 18, 2)
    badge(s, ix + 180, iy, 4)
    px, py, pw = cx + cw + 12, cy, x0 + ww - 14 - (cx + cw + 12)
    s.rect(px, py, pw, chh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(px + 16, py + 28, "PLACING", size=11, weight=700, spacing=1.2)
    s.text(px + 16, py + 72, "34 of 52", size=30, weight=700)
    s.text(px + 160, py + 66, "about 4 min left", size=12.5, fill=C["muted"])
    s.rect(px + 16, py + 86, pw - 32, 8, fill=C["pale"], r=4)
    s.rect(px + 16, py + 86, (pw - 32) * 34 / 52, 8, fill=C["blue"], r=4)
    s.text(px + 16, py + 118, "Now: C12, 100n 0402, from feeder 3", size=12.5)
    buttons(s, px + 16, py + 132, [("Pause", "plain"), ("Stop", "danger")], h=36, size=14)
    hr(s, px + 16, py + 186, pw - 32)
    s.rect(px + 16, py + 200, pw - 32, 104, fill=SOFT["warn"], r=8)
    mark(s, px + 34, py + 222, "warn", 9)
    s.text(px + 52, py + 227, "R7: the pick failed twice", size=13, weight=700)
    s.text(px + 52, py + 246, "feeder 5 may be empty", size=12, fill=C["muted"])
    buttons(s, px + 52, py + 262, [("Retry", "plain"), ("Skip R7", "plain")], h=28)
    badge(s, px + pw - 14, py + 206, 3)
    s.text(px + 16, py + 334, "Feeders: 2 low", size=12.5, fill=C["muted"])
    more(s, px + 16, py + 362, "Parts list, feeders, vacuum readings", 12)
    dock(s, x0 + 14, y0 + wh - 64, ww - 28, [("X", "120.40"), ("Y", "88.20"), ("Z", "4.00")], ["Vacuum", "Light",
                                                                                              "Park"])
    end_window(s, X, Y, W, H)
    return s.save("screen-place.svg")


def screen_machines():
    s = Svg(1020, 640, "Proposed Machines area: the machines on the left, the chosen machine's setup as a "
                       "checklist with dates, its cameras, file and firmware a tab away")
    X, Y, W, H = FRAME
    x0, y0, ww, wh = window(s, X, Y, W, H, "Machines")
    lx, ly, lw, lh = x0 + 14, y0 + 14, 220, wh - 28
    s.rect(lx, ly, lw, lh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(lx + 14, ly + 26, "MACHINES", size=11, weight=700, spacing=1.2)
    machines = [("Polar laser", "connected, idle", "ok"), ("Cartesian mill", "file only", None),
                ("K40", "file only", None), ("LumenPnP Rev05", "file only", None)]
    for i, (name, sub, state) in enumerate(machines):
        my = ly + 48 + i * 54
        if i == 0:
            s.rect(lx + 6, my - 6, lw - 12, 48, fill=C["tint"], r=8)
        s.circle(lx + 22, my + 11, 4.5, fill=C["green"] if state else C["pale"])
        s.text(lx + 36, my + 15, name, size=13, weight=700 if i == 0 else None)
        s.text(lx + 36, my + 32, sub, size=11, fill=C["muted"])
    button(s, lx + 14, ly + 274, "Add a machine", "plain", w=lw - 28)
    s.text(lx + 14, ly + 324, "new, a copy, or from OpenPnP", size=11, fill=C["muted"])
    badge(s, lx + lw - 14, ly + 16, 1)
    mx, my, mw_, mh = lx + lw + 12, ly, x0 + ww - 14 - (lx + lw + 12), lh
    s.rect(mx, my, mw_, mh, fill=C["panel"], stroke=C["line"], r=10)
    s.text(mx + 18, my + 36, "Polar laser", size=20, weight=700)
    chip(s, mx + 140, my + 20, "Connected: /dev/ttyACM0", "neutral")
    button(s, mx + mw_ - 120, my + 18, "Disconnect", "plain", w=104)
    tabs_w = segmented(s, mx + 18, my + 56, ["Setup", "Cameras", "Machine file", "Firmware"], 0, h=30, size=12.5)
    badge(s, mx + 18 + tabs_w + 18, my + 71, 4)
    checks = [
        ("ok", "Directions and endstops", "checked 11-02", "Check again"),
        ("ok", "Centering: the rail over the axis", "0.02 mm, 11-02", "Redo"),
        ("warn", "Camera offset", "not measured", "Measure"),
        ("ok", "Focus and the probe", "2.10 mm, 11-12", "Redo"),
        ("ok", "Firmware matches the file", "160 of 160 keys", "Review"),
        ("warn", "Edits not saved", "1 in polar-laser.toml", "Review"),
    ]
    cy = my + 112
    for kind, name, value, action in checks:
        mark(s, mx + 32, cy + 14, kind, 10)
        s.text(mx + 54, cy + 19, name, size=13.5, weight=700 if kind == "warn" else None)
        s.text(mx + 330, cy + 19, value, size=12.5, fill=C["muted"])
        if kind == "warn" and action == "Measure":
            button(s, mx + mw_ - 120, cy + 2, action, "primary", w=104)
        else:
            button(s, mx + mw_ - 120, cy + 2, action, "plain", w=104)
        cy += 50
        hr(s, mx + 18, cy - 8, mw_ - 36)
    badge(s, mx + 300, my + 126, 2)
    para(s, mx + 18, cy + 22, mw_ - 60, "Each routine opens step by step in this place, with the camera or the "
         "jog it needs, and writes its result and date here.", size=12.5, fill=C["muted"])
    badge(s, mx + mw_ - 14, cy + 16, 3)
    end_window(s, X, Y, W, H)
    return s.save("screen-machines.svg")


FIGURES = [fig_budget, fig_layers, fig_regions, fig_next_action, fig_disabled_wall, fig_dark_cockpit, fig_modes,
           fig_words, fig_undo, fig_dock, screen_home, screen_job, screen_run_find, screen_running, screen_place,
           screen_machines]


def main():
    for figure in FIGURES:
        print(OUT / figure())


if __name__ == "__main__":
    main()
