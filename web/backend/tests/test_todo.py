"""The top bar's to-do list: kept in var/todo.json, put whole with the
revision it was changed on."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.todo import MAX_ITEMS, MAX_TEXT, TodoItem, TodoStore, checked


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        yield client


def test_an_empty_list_until_one_is_put_then_every_reader_gets_it(client, tmp_path):
    assert client.get("/api/todo").json() == {"revision": 0, "items": []}
    items = [{"id": "a1", "text": "  clean   the\nlens ", "done": False}, {"id": "b2", "text": "order bits", "done": True}]
    put = client.put("/api/todo", json={"items": items, "revision": 0})
    assert put.status_code == 200, put.text
    assert put.json() == {"revision": 1, "items": [{"id": "a1", "text": "clean the lens", "done": False}, {"id": "b2", "text": "order bits", "done": True}]}
    assert client.get("/api/todo").json() == put.json()
    assert json.loads((tmp_path / "todo.json").read_text()) == put.json()


def test_a_put_made_on_an_older_revision_is_refused_and_changes_nothing(client):
    client.put("/api/todo", json={"items": [{"id": "a", "text": "one"}], "revision": 0})
    client.put("/api/todo", json={"items": [{"id": "a", "text": "one"}, {"id": "b", "text": "two"}], "revision": 1})
    stale = client.put("/api/todo", json={"items": [], "revision": 1})
    assert stale.status_code == 409 and "read it again" in stale.json()["detail"]
    assert [item["id"] for item in client.get("/api/todo").json()["items"]] == ["a", "b"]
    # Without a revision the list is put whatever the kept one's is.
    assert client.put("/api/todo", json={"items": []}).json() == {"revision": 3, "items": []}


@pytest.mark.parametrize(
    ("items", "said"),
    [
        ([{"id": "a", "text": "   "}], f"a to-do is 1 to {MAX_TEXT} characters"),
        ([{"id": "a", "text": "x" * (MAX_TEXT + 1)}], f"a to-do is 1 to {MAX_TEXT} characters"),
        ([{"id": "a", "text": "x"}, {"id": "a", "text": "y"}], "two to-dos have the id 'a'"),
        ([{"id": "../x", "text": "x"}], "a to-do's id is 1 to 40 letters, digits, _ or -"),
        ([{"id": f"i{n}", "text": "x"} for n in range(MAX_ITEMS + 1)], f"at most {MAX_ITEMS} to-dos"),
    ],
)
def test_a_list_that_does_not_hold_is_refused_with_the_reason(client, items, said):
    response = client.put("/api/todo", json={"items": items})
    assert response.status_code == 400 and response.json()["detail"] == said
    assert client.get("/api/todo").json() == {"revision": 0, "items": []}


def test_a_page_from_another_origin_cannot_put_the_list(client):
    refused = client.put("/api/todo", json={"items": []}, headers={"Origin": "http://evil.example"})
    assert refused.status_code == 403
    assert client.put("/api/todo", json={"items": []}, headers={"Origin": "http://testserver"}).status_code == 200


def test_a_file_that_does_not_read_is_an_empty_list_and_bad_items_are_dropped(tmp_path):
    path = tmp_path / "todo.json"
    store = TodoStore(path)
    path.write_text("{not json")
    assert store.state() == {"revision": 0, "items": []}
    path.write_text(json.dumps({"revision": 7, "items": [{"id": "a", "text": "ok"}, {"text": "no id"}, 5]}))
    assert store.state() == {"revision": 7, "items": [{"id": "a", "text": "ok", "done": False}]}
    assert store.put([TodoItem(id="b", text="next")], 7)["revision"] == 8
    assert checked([TodoItem(id="c", text=" a\tb ")])[0].text == "a b"
