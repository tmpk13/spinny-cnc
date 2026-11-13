"""Bug reports: kept under var/reports/<time>/, and handed on as the report
link says (a GitHub new-issue page, or a JSON post), off by default."""

from __future__ import annotations

import base64
import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.reports import MAX_ISSUE_URL, MAX_TEXT, action_line, checked_link, github_repository, link_kind, title_of

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
ACTIONS = [
    {"at": "2026-11-13T12:00:00.000Z", "kind": "page", "page": "jobs"},
    {"at": "2026-11-13T12:00:01.000Z", "kind": "press", "label": "Run", "panel": "Run", "page": "jobs"},
    {"at": "2026-11-13T12:00:01.100Z", "kind": "request", "method": "POST", "path": "/api/jobs/a1/run", "status": 409, "ms": 12, "count": 2},
    {"at": "2026-11-13T12:00:01.200Z", "kind": "toast", "level": "error", "text": "connect first"},
]


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        yield client


def report(client, text="Run did nothing\nI pressed Run with a job picked.", shot=PNG, actions=ACTIONS, **headers):
    data = {"text": text, "page": "jobs", "address": "http://spinny.local:8000/?page=jobs", "browser": "Test/1.0", "window": "1440 x 900"}
    if actions is not None:
        data["actions"] = json.dumps(actions)
    files = {"screenshot": ("screenshot.png", shot, "image/png")} if shot is not None else None
    return client.post("/api/reports", data=data, files=files, headers=headers)


def test_a_report_is_kept_in_a_folder_of_its_own_and_sent_nowhere_with_no_link(client, tmp_path):
    answer = report(client)
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["link"] is None and body["files"] == ["report.txt", "screenshot.png", "actions.json"]
    folder = tmp_path / "reports" / body["id"]
    assert body["folder"] == str(folder)
    assert (folder / "screenshot.png").read_bytes() == PNG
    assert json.loads((folder / "actions.json").read_text()) == ACTIONS
    text = (folder / "report.txt").read_text()
    assert text.startswith("Run did nothing\nI pressed Run with a job picked.\n\n")
    for fact in ("Page: jobs", "Address: http://spinny.local:8000/?page=jobs", "Browser: Test/1.0", "Window: 1440 x 900", "Screenshot: screenshot.png", "What was done lately: actions.json (4)", "Version: "):
        assert fact in text
    # A second one in the same second gets a folder of its own.
    again = report(client, shot=None, actions=None).json()
    assert again["id"] != body["id"] and again["files"] == ["report.txt"]
    assert "Screenshot: none" in (tmp_path / "reports" / again["id"] / "report.txt").read_text()


@pytest.mark.parametrize(
    ("change", "said"),
    [
        ({"text": "   "}, "say what happened"),
        ({"text": "x" * (MAX_TEXT + 1)}, f"what happened is at most {MAX_TEXT} characters"),
        ({"shot": b"GIF89a"}, "the screenshot is not a PNG picture"),
        ({"actions": {"not": "a list"}}, "what was done lately is not a JSON list"),
    ],
)
def test_a_report_that_does_not_hold_is_refused(client, tmp_path, change, said):
    answer = report(client, **change)
    assert answer.status_code == 400 and answer.json()["detail"] == said
    assert not (tmp_path / "reports").exists() or not any((tmp_path / "reports").iterdir())


def test_the_link_is_off_until_set_and_kept_in_the_config(client, tmp_path):
    assert client.get("/api/reports/settings").json() == {"link": "", "kind": None}
    put = client.put("/api/reports/settings", json={"link": " https://github.com/tmpk13/spinny-cnc "})
    assert put.json() == {"link": "https://github.com/tmpk13/spinny-cnc", "kind": "github"}
    assert json.loads((tmp_path / "config.json").read_text())["reports"] == {"link": "https://github.com/tmpk13/spinny-cnc"}
    assert client.put("/api/reports/settings", json={"link": "https://reports.example/bugs"}).json()["kind"] == "post"
    refused = client.put("/api/reports/settings", json={"link": "ftp://example.com/x"})
    assert refused.status_code == 400 and "http or https" in refused.json()["detail"]
    assert client.get("/api/reports/settings").json()["link"] == "https://reports.example/bugs"
    assert client.put("/api/reports/settings", json={"link": ""}).json() == {"link": "", "kind": None}


def test_a_page_from_another_origin_can_neither_report_nor_set_the_link(client):
    assert report(client, Origin="http://evil.example").status_code == 403
    assert client.put("/api/reports/settings", json={"link": "https://evil.example"}, headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.get("/api/reports/settings").json()["link"] == ""


def test_a_github_link_answers_its_new_issue_page_with_the_newest_actions_that_fit(client):
    client.put("/api/reports/settings", json={"link": "https://github.com/tmpk13/spinny-cnc.git"})
    many = [{"at": "2026-11-13T12:00:00Z", "kind": "request", "method": "GET", "path": f"/api/jobs/{n:04d}", "status": 200, "ms": 3} for n in range(400)]
    body = report(client, actions=many).json()
    link = body["link"]
    assert link["kind"] == "github"
    url = link["url"]
    assert url.startswith("https://github.com/tmpk13/spinny-cnc/issues/new?title=Run%20did%20nothing&body=")
    assert len(url) <= MAX_ISSUE_URL
    text = parse_qs(urlsplit(url).query)["body"][0]
    assert text.startswith("Run did nothing\nI pressed Run with a job picked.\n\n---\n")
    assert "Page: jobs" in text and "Browser: Test/1.0" in text and "spinny.local" not in text
    assert f"{body['folder']}/screenshot.png: attach it here." in text
    # The newest action is there, the oldest dropped to keep the address short.
    assert "/api/jobs/0399" in text and "/api/jobs/0000" not in text
    assert "of 400; all of them in actions.json" in text


def test_a_text_too_long_for_an_address_is_cut_and_says_where_the_rest_is(client):
    client.put("/api/reports/settings", json={"link": "https://github.com/tmpk13/spinny-cnc"})
    url = report(client, text="first line\n" + "word " * 3000).json()["link"]["url"]
    assert len(url) <= MAX_ISSUE_URL
    text = parse_qs(urlsplit(url).query)["body"][0]
    assert "(cut here: the whole text is in report.txt)" in text and "What was done lately" not in text


def test_any_other_link_gets_the_report_posted_as_json_and_says_whether_it_was_taken(client):
    client.put("/api/reports/settings", json={"link": "https://reports.example/bugs?key=k1"})
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, text="filed as #12")

    client.app.state.reports.transport = httpx.MockTransport(answer)
    link = report(client).json()["link"]
    assert link == {"kind": "post", "url": "https://reports.example/bugs?key=k1", "taken": True, "status": 201, "detail": "filed as #12"}
    payload = json.loads(seen[0].content)
    assert str(seen[0].url) == "https://reports.example/bugs?key=k1"
    assert payload["title"] == "Run did nothing" and payload["page"] == "jobs" and payload["actions"] == ACTIONS
    assert base64.b64decode(payload["screenshot_png"]) == PNG

    client.app.state.reports.transport = httpx.MockTransport(lambda request: httpx.Response(500, text="  down\nfor   upkeep "))
    assert report(client).json()["link"] == {"kind": "post", "url": "https://reports.example/bugs?key=k1", "taken": False, "status": 500, "detail": "down for upkeep"}

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host", request=request)

    client.app.state.reports.transport = httpx.MockTransport(unreachable)
    refused = report(client).json()
    assert refused["link"]["taken"] is False and refused["link"]["status"] is None
    assert refused["link"]["detail"].startswith("could not reach it: no route to host")
    # Kept all the same.
    assert (client.app.state.reports.folder / refused["id"] / "report.txt").exists()


def test_github_addresses_and_other_links():
    for link in (
        "https://github.com/tmpk13/spinny-cnc",
        "https://github.com/tmpk13/spinny-cnc/",
        "https://github.com/tmpk13/spinny-cnc.git",
        "https://www.github.com/tmpk13/spinny-cnc/issues",
        "http://github.com/tmpk13/spinny-cnc/issues/new",
    ):
        assert github_repository(link) == ("tmpk13", "spinny-cnc"), link
    assert github_repository("https://github.com/tmpk13") is None
    assert github_repository("https://github.com/tmpk13/spinny-cnc/pulls") is None
    assert github_repository("https://gitlab.com/tmpk13/spinny-cnc") is None
    assert link_kind("") is None and link_kind("https://example.com/hook") == "post"
    for bad in ("github.com/a/b", "https://", "https://example.com/a b", "javascript:alert(1)"):
        with pytest.raises(ValueError):
            checked_link(bad)


def test_titles_and_action_lines():
    assert title_of("\n  Run did nothing  \nmore") == "Run did nothing"
    assert title_of("   ") == "Bug report"
    assert len(title_of("x" * 200)) == 82 and title_of("x" * 200).endswith("...")
    lines = [action_line(action)[9:] for action in ACTIONS]
    assert lines == [
        "page jobs",
        'press "Run" (Run, jobs)',
        "POST /api/jobs/a1/run 409 12 ms (x2)",
        "toast error: connect first",
    ]
    assert action_line({"kind": "error", "text": "TypeError: x is undefined"}) == "--:--:-- error: TypeError: x is undefined"
