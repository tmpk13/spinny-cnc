"""A table added to a machine file from the page: POST
/api/machines/{id}/tables puts a [[feeder]] or [[slot]] at the file's end,
its comments kept, and saves it only once the whole file reads."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin
from gcode_rig import rig_backend
from test_feederbus import PROFILE

from spinny_web.app import create_app

NEW_ID = "5350494E4E59000000000001"


@pytest.fixture
def client(tmp_path):
    backend = rig_backend(tmp_path, {"lumen": "# the test LumenPnP\n" + PROFILE}, lambda url, baud: FakeMarlin())
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        yield client


def test_a_feeder_is_added_at_the_files_end_and_reads_back(client):
    path = client.backend.machine_store.path("lumen")
    before = path.read_text(encoding="utf-8")
    values = {"id": "r-10k-r0603", "match": "10k R_0603", "bus_id": NEW_ID, "advance": 4}
    response = client.post("/api/machines/lumen/tables", json={"table": "feeder", "values": values})
    assert response.status_code == 200, response.text
    after = path.read_text(encoding="utf-8")
    assert after == before.rstrip("\n") + f'\n\n[[feeder]]\nid = "r-10k-r0603"\nmatch = "10k R_0603"\nbus_id = "{NEW_ID}"\nadvance = 4\n'
    assert "# the test LumenPnP" in after
    # Answered as a save is, the file read whole; the placing machine has it.
    answer = response.json()
    assert answer["text"] == after and answer["problems"] == []
    assert [feeder["id"] for feeder in answer["document"]["gcode"]["feeders"]] == ["c-100n", "c-1u", "r-10k-r0603"]
    placing = client.get("/api/pnp/placing").json()["document"]
    assert placing["feeders"][-1]["bus_id"] == NEW_ID and placing["feeders"][-1]["advance"] == 4.0
    # A feeder by the parts picked takes their references.
    picked = client.post("/api/machines/lumen/tables", json={"table": "feeder", "values": {"id": "picked", "refs": ["R1", "R2"], "at": [1.0, 2.0, 3.0]}})
    assert picked.status_code == 200 and picked.json()["document"]["gcode"]["feeders"][-1]["refs"] == ["R1", "R2"]


@pytest.mark.parametrize(
    "body, words",
    [
        ({"table": "feeder", "values": {"id": "c-100n", "match": "4k7"}}, "[feeder 3] id 'c-100n' is another feeder's too"),
        ({"table": "feeder", "values": {"id": "r-4k7", "match": "4k7", "at": [1.0, 2.0, 3.0], "speed": 3}}, "[feeder 3] speed is not a key here"),
        ({"table": "feeder", "values": {"id": "r-4k7", "match": "4k7", "bus_id": NEW_ID, "slot": None}}, "slot has no value, and TOML has no null"),
        ({"table": "Feeder", "values": {"id": "r-4k7"}}, "a table's name is lower case letters, digits and _"),
        ({"table": "slot", "values": {"address": 3, "at": [1.0, 2.0, 3.0]}}, "[slot 3] address 3 is another slot's too"),
        ({"table": "motion", "values": {"safe_z": 30}}, "does not read as TOML"),
    ],
)
def test_a_table_the_file_does_not_take_is_refused_and_the_file_left_as_it_was(client, body, words):
    path = client.backend.machine_store.path("lumen")
    before = path.read_text(encoding="utf-8")
    response = client.post("/api/machines/lumen/tables", json=body)
    assert response.status_code == 400, response.text
    assert words in response.json()["detail"]
    assert path.read_text(encoding="utf-8") == before


def test_a_table_for_a_machine_that_is_not_there_is_not_found(client):
    response = client.post("/api/machines/nope/tables", json={"table": "feeder", "values": {"id": "a", "match": "b"}})
    assert response.status_code == 404
