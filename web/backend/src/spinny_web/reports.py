"""Bug reports from the page: what happened in the operator's words, a
picture of the page and what was done lately, kept under
var/reports/<time>/ (report.txt, screenshot.png, actions.json) and handed
on when a report link is set (`reports.link` in config.json; empty, the
default, sends nothing anywhere):

- the address of a GitHub repository: the answer carries that
  repository's new-issue page filled in with a title and the text (the
  version, the page, and what was done lately, the oldest left out until
  the address is short enough). A picture cannot ride in an address, so
  the text names the saved file to attach; the page opens the address.
- any other http or https address: the report is posted there as JSON,
  the picture in base64, and the answer says whether it was taken.
"""

from __future__ import annotations

import base64
import json
import re
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlsplit

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from .files import write_whole

MAX_TEXT = 20000
# The longest of the short fields (page, address, browser, window); more is cut.
MAX_FIELD = 500
MAX_SHOT = 16 * 1024 * 1024
MAX_ACTIONS = 1000
MAX_ACTIONS_BYTES = 1024 * 1024
MAX_LINK = 500
# GitHub answers 414 for an address much past 8 KB, and some browsers cut
# shorter ones: the new-issue address stays under this.
MAX_ISSUE_URL = 6000
POST_TIMEOUT = 10.0
PNG = b"\x89PNG\r\n\x1a\n"
OWNER = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})"
REPO = r"[A-Za-z0-9._-]{1,100}"
GITHUB = re.compile(rf"^https?://(?:www\.)?github\.com/({OWNER})/({REPO}?)(?:\.git)?(?:/issues(?:/new)?)?/?$")


def github_repository(link: str) -> tuple[str, str] | None:
    """The owner and the name of the GitHub repository a link names (its
    address, with or without .git, its issues or its new-issue page); None
    for any other link."""
    match = GITHUB.match(link)
    if not match or match.group(2) in ("", ".", ".."):
        return None
    return match.group(1), match.group(2)


def link_kind(link: str) -> str | None:
    """What a report is handed on as: `github`, `post`, or None for no link."""
    if not link:
        return None
    return "github" if github_repository(link) else "post"


def checked_link(link: str) -> str:
    """The link trimmed, or what is wrong with it: empty (off), or an http
    or https address with a host."""
    link = link.strip()
    if not link:
        return ""
    if len(link) > MAX_LINK or any(c.isspace() for c in link):
        raise ValueError(f"the report link is an http or https address of at most {MAX_LINK} characters, without spaces")
    parts = urlsplit(link)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("the report link is an http or https address, such as https://github.com/owner/repository")
    return link


def title_of(text: str) -> str:
    """An issue's title: the text's first line, cut to 80 characters."""
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if not first:
        return "Bug report"
    return first if len(first) <= 80 else first[:79].rstrip() + "..."


def _clock(at: Any) -> str:
    """An action's time as this machine's clock reads it, to the second."""
    if isinstance(at, str):
        try:
            return datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
        except ValueError:
            return at[:19]
    return "--:--:--"


def action_line(action: dict) -> str:
    """One action as a line of text: its time, what it was, and how many
    times it came in a row."""
    kind = action.get("kind")
    if kind == "press":
        what = f'press "{action.get("label", "")}" ({action.get("panel") or "-"}, {action.get("page") or "-"})'
    elif kind == "page":
        what = f"page {action.get('page', '')}"
    elif kind == "request":
        what = f"{action.get('method', '')} {action.get('path', '')} {action.get('status', '')} {action.get('ms', '')} ms"
    elif kind == "toast":
        what = f"toast {action.get('level', '')}: {action.get('text', '')}"
    elif kind == "error":
        what = f"error: {action.get('text', '')}"
    else:
        what = json.dumps({key: value for key, value in action.items() if key != "at"})
    count = action.get("count")
    times = f" (x{count})" if isinstance(count, int) and count > 1 else ""
    return f"{_clock(action.get('at'))} {what}{times}"


def checked_actions(text: str) -> list[dict] | None:
    """The actions the page sent (a JSON list of objects): None for none,
    the newest MAX_ACTIONS of them, each string cut to MAX_FIELD."""
    if not text.strip():
        return None
    if len(text) > MAX_ACTIONS_BYTES:
        raise ValueError(f"what was done lately is over {MAX_ACTIONS_BYTES >> 10} KB")
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ValueError("what was done lately is not a JSON list") from exc
    if not isinstance(data, list):
        raise ValueError("what was done lately is not a JSON list")
    out: list[dict] = []
    for item in data[-MAX_ACTIONS:]:
        if not isinstance(item, dict):
            continue
        out.append({
            str(key)[:40]: value[:MAX_FIELD] if isinstance(value, str) else value
            for key, value in item.items()
            if isinstance(value, (str, int, float, bool)) or value is None
        })
    return out


@dataclass
class Report:
    text: str
    page: str = ""
    address: str = ""
    browser: str = ""
    window: str = ""


def issue_url(owner: str, repo: str, title: str, text: str, facts: list[str], actions: list[dict] | None) -> str:
    """The repository's new-issue page with the title and the body filled
    in: the text, the facts, and as many of the newest actions as keep the
    address under MAX_ISSUE_URL; a text too long for it is cut, with a word
    that the whole of it is in the saved report."""
    base = f"https://github.com/{owner}/{repo}/issues/new?title={quote(title, safe='')}&body="
    lines = [action_line(action) for action in actions or []]

    def body(text: str, kept: list[str]) -> str:
        parts = [text, "", "---", *facts]
        if kept:
            parts += ["", f"What was done lately, oldest first ({len(kept)} of {len(lines)}; all of them in actions.json):", "```", *kept, "```"]
        return "\n".join(parts)

    def fits(text: str, kept: list[str]) -> bool:
        return len(base) + len(quote(body(text, kept), safe="")) <= MAX_ISSUE_URL

    # The fewest actions dropped that fit, found by halving.
    low, high = 0, len(lines)
    while low < high:
        middle = (low + high) // 2
        if fits(text, lines[middle:]):
            high = middle
        else:
            low = middle + 1
    kept = lines[low:]
    if not fits(text, kept):
        kept = []
        note = "\n\n(cut here: the whole text is in report.txt)"
        low, high = 0, len(text)
        while low < high:
            middle = (low + high + 1) // 2
            if fits(text[:middle] + note, kept):
                low = middle
            else:
                high = middle - 1
        text = text[:low] + note
    return base + quote(body(text, kept), safe="")


class ReportSettingsBody(BaseModel):
    link: str


class ReportDesk:
    """Where reports are kept and handed on. `config` is the backend's
    config, kept by `save_config`; `version` names the running release;
    `transport` is what posts go through (None for the network)."""

    def __init__(
        self,
        folder: Path,
        config: dict,
        save_config: Callable[[], None],
        version: Callable[[], str],
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.folder = folder
        self.config = config
        self.save_config = save_config
        self.version = version
        self.transport = transport
        self._lock = threading.Lock()
        self._last_stamp = ""
        self._serial = 0

    @property
    def link(self) -> str:
        kept = self.config.get("reports")
        link = kept.get("link") if isinstance(kept, dict) else None
        try:
            return checked_link(link) if isinstance(link, str) else ""
        except ValueError:
            return ""

    def settings(self) -> dict:
        return {"link": self.link, "kind": link_kind(self.link)}

    def set_link(self, link: str) -> dict:
        kept = checked_link(link)
        reports = self.config.get("reports")
        self.config["reports"] = {**(reports if isinstance(reports, dict) else {}), "link": kept}
        self.save_config()
        return self.settings()

    def _new_folder(self, now: datetime) -> tuple[str, Path]:
        """A folder of its own, named for when the report came; a count
        within that second keeps two apart."""
        with self._lock:
            stamp = now.strftime("%Y%m%d-%H%M%S")
            if stamp == self._last_stamp:
                self._serial += 1
            else:
                self._last_stamp = stamp
                self._serial = 0
            while (self.folder / f"{stamp}-{self._serial:03d}").exists():
                self._serial += 1
            name = f"{stamp}-{self._serial:03d}"
            path = self.folder / name
            path.mkdir(parents=True)
            return name, path

    def submit(self, report: Report, shot: bytes | None, actions: list[dict] | None) -> dict:
        """Keeps the report, hands it on as the link says, and answers where
        it went: its id and folder, the files written, and the link's outcome."""
        text = report.text.strip()
        if not text:
            raise ValueError("say what happened")
        if len(text) > MAX_TEXT:
            raise ValueError(f"what happened is at most {MAX_TEXT} characters")
        if shot is not None and not shot.startswith(PNG):
            raise ValueError("the screenshot is not a PNG picture")
        now = datetime.now().astimezone()
        name, folder = self._new_folder(now)
        version = self.version()
        files = ["report.txt"]
        if shot is not None:
            write_whole(folder / "screenshot.png", shot)
            files.append("screenshot.png")
        if actions is not None:
            write_whole(folder / "actions.json", json.dumps(actions, indent=1) + "\n")
            files.append("actions.json")
        facts = [
            f"Time: {now.strftime('%Y-%m-%d %H:%M:%S %z')}",
            f"Version: {version}",
            f"Page: {report.page or '-'}",
            f"Address: {report.address or '-'}",
            f"Browser: {report.browser or '-'}",
            f"Window: {report.window or '-'}",
            f"Screenshot: {'screenshot.png' if shot is not None else 'none'}",
            f"What was done lately: {f'actions.json ({len(actions)})' if actions is not None else 'not included'}",
        ]
        write_whole(folder / "report.txt", text + "\n\n" + "\n".join(facts) + "\n")
        answer: dict[str, Any] = {"id": name, "folder": str(folder), "files": files, "link": None}
        link = self.link
        repository = github_repository(link) if link else None
        if repository:
            # The page's address names the operator's network: it stays in report.txt.
            shown = [line for line in facts if not line.startswith(("Time:", "Address:", "Screenshot:", "What was done"))]
            if shot is not None:
                shown.append(f"Screenshot: saved on the machine the backend runs on, as {folder / 'screenshot.png'}: attach it here.")
            answer["link"] = {"kind": "github", "url": issue_url(*repository, title_of(text), text, shown, actions)}
        elif link:
            payload = {
                "id": name,
                "title": title_of(text),
                "text": text,
                "time": now.isoformat(timespec="seconds"),
                "version": version,
                "page": report.page,
                "address": report.address,
                "browser": report.browser,
                "window": report.window,
                "actions": actions,
                "screenshot_png": base64.b64encode(shot).decode("ascii") if shot is not None else None,
                "saved": str(folder),
            }
            answer["link"] = {"kind": "post", "url": link, **self.post(link, payload)}
        return answer

    def post(self, link: str, payload: dict) -> dict:
        """Posts the report; whether it was taken (an answer in the 200s),
        the status, and what the answer or the failure said, short."""
        try:
            with httpx.Client(transport=self.transport, timeout=POST_TIMEOUT, follow_redirects=False) as client:
                response = client.post(link, json=payload)
        except httpx.HTTPError as exc:
            return {"taken": False, "status": None, "detail": f"could not reach it: {exc}"[:300]}
        said = " ".join(response.text.split())[:300]
        return {"taken": 200 <= response.status_code < 300, "status": response.status_code, "detail": said}


def _field(value: str) -> str:
    return " ".join(value.split())[:MAX_FIELD]


def add_routes(app: FastAPI, desk: ReportDesk) -> None:
    """The reports' routes, put on the app itself: FastAPI 0.142 keeps the routes
    of an included router out of `app.routes`, where the check of the
    routes the Auto tools may call looks for every route."""

    @app.get("/api/reports/settings")
    def report_settings():
        return desk.settings()

    @app.put("/api/reports/settings")
    def put_report_settings(body: ReportSettingsBody):
        try:
            return desk.set_link(body.link)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/reports")
    async def post_report(
        text: str = Form(""),
        page: str = Form(""),
        address: str = Form(""),
        browser: str = Form(""),
        window: str = Form(""),
        actions: str = Form(""),
        screenshot: UploadFile | None = File(None),
    ):
        shot = None
        if screenshot is not None:
            shot = await screenshot.read(MAX_SHOT + 1)
            if len(shot) > MAX_SHOT:
                raise HTTPException(status_code=413, detail=f"the screenshot is over {MAX_SHOT >> 20} MB")
        report = Report(text=text, page=_field(page), address=_field(address), browser=_field(browser), window=_field(window))
        try:
            return await run_in_threadpool(desk.submit, report, shot, checked_actions(actions))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
