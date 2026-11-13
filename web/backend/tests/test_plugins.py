"""Plugins for the page: kept in var/plugins, written switched off, turned
on only as the text the operator was shown, off again once changed, and
out of the tools' reach to turn on."""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.plugins import MAX_SOURCE, exported
from spinny_web.tools import ToolBox

SOURCE = """\
export const name = "Big position";
export const description = 'The head\\'s place in large digits.';

export function activate(host) {
    const body = host.panel({ title: "Big position" });
    return () => body.remove();
}
"""


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        yield client


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def test_a_plugin_written_is_kept_switched_off_with_its_name_and_description(client, tmp_path):
    assert client.get("/api/plugins").json() == {"plugins": []}
    written = client.put("/api/plugins/big-position", json={"source": SOURCE})
    assert written.status_code == 200, written.text
    info = written.json()
    assert info["id"] == "big-position" and info["name"] == "Big position"
    assert info["description"] == "The head's place in large digits."
    assert info["made_by"] == "auto" and info["enabled"] is False and info["changed"] is False
    assert info["hash"] == digest(SOURCE) and info["size"] == len(SOURCE.encode())
    assert (tmp_path / "plugins" / "big-position.js").read_text() == SOURCE
    assert client.get("/api/plugins").json() == {"plugins": [info]}
    assert client.get("/api/plugins/big-position").json() == {**info, "source": SOURCE}


def test_only_the_text_shown_is_turned_on_and_only_a_plugin_on_is_served(client):
    info = client.put("/api/plugins/big-position", json={"source": SOURCE}).json()
    assert client.get(f"/api/plugins/big-position/module.js?v={info['hash']}").status_code == 409
    refused = client.put("/api/plugins/big-position/enabled", json={"enabled": True})
    assert refused.status_code == 409 and "read it again" in refused.json()["detail"]
    on = client.put("/api/plugins/big-position/enabled", json={"enabled": True, "hash": info["hash"]}).json()
    assert on["enabled"] is True and on["made_by"] == "auto"
    module = client.get(f"/api/plugins/big-position/module.js?v={info['hash']}")
    assert module.status_code == 200 and module.text == SOURCE
    assert module.headers["content-type"].startswith("text/javascript") and module.headers["cache-control"] == "no-store"
    assert client.get("/api/plugins/big-position/module.js?v=0000").status_code == 409
    off = client.put("/api/plugins/big-position/enabled", json={"enabled": False}).json()
    assert off["enabled"] is False and off["changed"] is False
    assert client.get(f"/api/plugins/big-position/module.js?v={info['hash']}").status_code == 409


def test_a_plugin_written_again_or_edited_by_hand_is_off_again(client, tmp_path):
    info = client.put("/api/plugins/big-position", json={"source": SOURCE}).json()
    client.put("/api/plugins/big-position/enabled", json={"enabled": True, "hash": info["hash"]})
    again = client.put("/api/plugins/big-position", json={"source": SOURCE + "// more\n"}).json()
    assert again["enabled"] is False and again["changed"] is True and again["made_by"] == "auto"
    # Written again while off, it still says it changed since it was on.
    assert client.put("/api/plugins/big-position", json={"source": SOURCE}).json()["changed"] is True
    # The page that was told the old text cannot import the new one.
    assert client.get(f"/api/plugins/big-position/module.js?v={again['hash']}").status_code == 409
    on = client.put("/api/plugins/big-position/enabled", json={"enabled": True, "hash": info["hash"]}).json()
    assert on["enabled"] is True and on["changed"] is False
    (tmp_path / "plugins" / "big-position.js").write_text(SOURCE.replace("large", "huge"))
    edited = client.get("/api/plugins").json()["plugins"][0]
    assert edited["enabled"] is False and edited["changed"] is True and edited["made_by"] == "file"
    assert edited["description"] == "The head's place in huge digits."


def test_a_file_put_in_the_folder_by_hand_is_listed_off_as_a_file(client, tmp_path):
    folder = tmp_path / "plugins"
    folder.mkdir()
    (folder / "clock.js").write_text("export function activate(host) {}\n")
    (folder / "Not-An-Id.js").write_text("x")
    (folder / "notes.txt").write_text("x")
    listed = client.get("/api/plugins").json()["plugins"]
    assert [(entry["id"], entry["name"], entry["description"], entry["made_by"], entry["enabled"]) for entry in listed] == [
        ("clock", "clock", "", "file", False),
    ]


def test_deleting_takes_the_file_and_whether_it_was_on(client, tmp_path):
    info = client.put("/api/plugins/big-position", json={"source": SOURCE}).json()
    client.put("/api/plugins/big-position/enabled", json={"enabled": True, "hash": info["hash"]})
    assert client.delete("/api/plugins/big-position").json() == {"deleted": "big-position"}
    assert client.get("/api/plugins").json() == {"plugins": []}
    assert client.delete("/api/plugins/big-position").status_code == 404
    assert client.get("/api/plugins/big-position").status_code == 404
    assert "big-position" not in json.loads((tmp_path / "plugins" / "plugins.json").read_text())
    # Written anew under the same id, it is off.
    assert client.put("/api/plugins/big-position", json={"source": SOURCE}).json()["enabled"] is False


@pytest.mark.parametrize(
    ("plugin_id", "source", "status", "said"),
    [
        ("Big", SOURCE, 400, "a plugin's id is 1 to 64 lower-case letters"),
        ("-big", SOURCE, 400, "a plugin's id is 1 to 64 lower-case letters"),
        ("big", "   \n", 400, "a plugin's source is empty"),
        ("big", "x" * (MAX_SOURCE + 1), 400, "a plugin is at most 256 KB"),
    ],
)
def test_a_plugin_that_cannot_be_kept_is_refused(client, plugin_id, source, status, said):
    answer = client.put(f"/api/plugins/{plugin_id}", json={"source": source})
    assert answer.status_code == status and answer.json()["detail"].startswith(said)
    assert client.get("/api/plugins").json() == {"plugins": []}


def test_a_page_from_another_origin_can_neither_write_nor_turn_on_nor_delete(client):
    info = client.put("/api/plugins/big-position", json={"source": SOURCE}).json()
    evil = {"Origin": "http://evil.example"}
    assert client.put("/api/plugins/other", json={"source": SOURCE}, headers=evil).status_code == 403
    assert client.put("/api/plugins/big-position/enabled", json={"enabled": True, "hash": info["hash"]}, headers=evil).status_code == 403
    assert client.delete("/api/plugins/big-position", headers=evil).status_code == 403
    assert client.get("/api/plugins/big-position").json()["enabled"] is False


def test_the_tools_write_a_plugin_switched_off_and_cannot_turn_it_on(client):
    app = client.app

    async def go():
        async with ToolBox.in_process(app) as box:
            written = await box.call("write_plugin", {"plugin_id": "big-position", "source": SOURCE})
            assert not written.error, written.text
            assert written.changed == ("plugins",)
            said = json.loads(written.text)
            assert said["plugin"]["enabled"] is False and "turns it on in the Plugins tab" in said["note"]
            listed = json.loads((await box.call("list_plugins", {})).text)["plugins"]
            assert [entry["made_by"] for entry in listed] == ["auto"]
            read = json.loads((await box.call("read_plugin", {"plugin_id": "big-position"})).text)
            assert read["source"] == SOURCE
            refused = await box.client.put("/api/plugins/big-position/enabled", json={"enabled": True, "hash": read["hash"]})
            assert refused.status_code == 403 and "not a route a tool may call" in refused.json()["detail"]
            assert (await box.call("write_plugin", {"plugin_id": "../x", "source": SOURCE})).error
            assert not (await box.call("delete_plugin", {"plugin_id": "big-position"})).error

    asyncio.run(go())
    assert client.get("/api/plugins").json() == {"plugins": []}


def test_name_and_description_are_read_from_plain_literals_only():
    assert exported('export const name = "A \\"quoted\\" name";\nexport const description = `two words`;') == {"name": 'A "quoted" name', "description": "two words"}
    assert exported("export const name = 'first';\nexport const name = 'second';") == {"name": "first"}
    assert exported("export const name = `made ${here}`;\nexport const description = make();") == {}
