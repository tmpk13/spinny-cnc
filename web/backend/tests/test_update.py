"""An installed release updating itself from GitHub's releases
(spinny_web.update), against a fake GitHub on this computer: the check,
the download checked against SHA256SUMS, the new release unpacked beside
the old one and the link switched, the rollback, and the routes."""

from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web import update
from spinny_web.app import Backend, create_app
from spinny_web.update import Updater, UpdateError, compare, expected_sum, release_root, rollback

PLATFORM = "x86_64-linux"


def release_tree(root: Path, label: str) -> Path:
    """A release directory as release.py lays one out, with only what the update looks at."""
    (root / "bin").mkdir(parents=True)
    (root / "bin" / "spinny-web").write_text("#!/bin/sh\n", encoding="utf-8")
    site = root / "python" / "lib" / "python3.12" / "site-packages" / "spinny_web"
    site.mkdir(parents=True)
    (root / "VERSION").write_text(f"spinny: {label}\ntarget: x86_64-unknown-linux-gnu\nplatform: {PLATFORM}\n", encoding="utf-8")
    return root


def archive_of(tree: Path) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tar:
        tar.add(tree, arcname=tree.name)
    return data.getvalue()


class FakeGitHub:
    """The latest release's listing and its files, served on this computer:
    `files` maps a name to its bytes, `status` overrides the listing's."""

    def __init__(self, tag: str, files: dict[str, bytes]) -> None:
        self.tag = tag
        self.files = files
        self.status = 200
        self.asked: list[str] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fake.asked.append(self.path)
                assert self.headers["User-Agent"] == update.USER_AGENT
                if self.path == "/repos/tmpk13/spinny-cnc/releases/latest":
                    if fake.status != 200:
                        self.send_error(fake.status)
                        return
                    body = json.dumps(fake.listing()).encode()
                elif self.path.startswith("/download/") and self.path[10:] in fake.files:
                    body = fake.files[self.path[10:]]
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"{self.base}/repos/tmpk13/spinny-cnc/releases/latest"

    def listing(self) -> dict:
        return {
            "tag_name": self.tag,
            "html_url": f"https://github.com/tmpk13/spinny-cnc/releases/tag/{self.tag}",
            "published_at": "2026-11-12T10:00:00Z",
            "assets": [{"name": name, "size": len(data), "browser_download_url": f"{self.base}/download/{name}"} for name, data in self.files.items()],
        }

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def installed(tmp_path):
    """Release 0.1.0 unpacked in apps/, a home beside it, and a fake GitHub
    with 0.2.0 for this platform and another, and their SHA256SUMS."""
    apps = tmp_path / "apps"
    root = release_tree(apps / f"spinny-0.1.0-{PLATFORM}", "0.1.0")
    built = release_tree(tmp_path / "build" / f"spinny-0.2.0-{PLATFORM}", "0.2.0")
    archive = archive_of(built)
    other = b"not this platform's"
    names = {f"spinny-0.2.0-{PLATFORM}.tar.gz": archive, "spinny-0.2.0-aarch64-linux.tar.gz": other}
    sums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in names.items()).encode()
    github = FakeGitHub("v0.2.0", {**names, "SHA256SUMS": sums})
    home = tmp_path / "home"
    (home / "machines").mkdir(parents=True)
    (home / "machines" / "mine.toml").write_text("name = 'mine'\n", encoding="utf-8")
    yield Updater(root, url=github.url), github, home
    github.close()


def tree(path: Path) -> dict[str, bytes]:
    return {str(item.relative_to(path)): item.read_bytes() for item in sorted(path.rglob("*")) if item.is_file()}


def test_versions_compare_by_their_numbers_then_their_build():
    assert compare("0.1.0", "0.2.0") == "newer" and compare("0.2.0", "v0.10.0") == "newer"
    assert compare("0.2.0", "0.1.9") == "older" and compare("0.2.0", "0.2.0") == "same"
    # An untagged build of the same version is not the release.
    assert compare("0.2.0-g4a67b63", "0.2.0") == "other" and compare("0.2.0-g4a67b63-dirty", "0.2.0") == "other"


def test_a_sums_file_gives_the_line_for_the_file():
    digest = "ab" * 32
    assert expected_sum(f"{digest}  spinny-0.2.0-x86_64-linux.tar.gz\n{'cd' * 32}  other\n", "spinny-0.2.0-x86_64-linux.tar.gz") == digest
    assert expected_sum(f"{digest} *spinny.tar.gz\n", "spinny.tar.gz") == digest
    assert expected_sum("nonsense line\n", "spinny.tar.gz") is None


def test_the_release_root_is_found_from_the_package_inside_it(tmp_path):
    root = release_tree(tmp_path / f"spinny-0.1.0-{PLATFORM}", "0.1.0")
    package = root / "python" / "lib" / "python3.12" / "site-packages" / "spinny_web"
    assert release_root(package) == root
    # A checkout's package is not in a release.
    assert release_root(Path(update.__file__).resolve().parent) is None


def test_a_check_finds_the_newer_release_and_its_archive_for_this_platform(installed):
    updater, github, _ = installed
    state = updater.check()
    assert state["kind"] == "release" and state["version"] == "0.1.0" and state["platform"] == PLATFORM
    assert state["status"] == "newer" and state["error"] is None
    assert state["latest"]["version"] == "0.2.0" and state["latest"]["archive"] == f"spinny-0.2.0-{PLATFORM}.tar.gz"
    assert github.asked == ["/repos/tmpk13/spinny-cnc/releases/latest"]


def test_an_update_unpacks_beside_and_switches_the_link_leaving_the_old_release_and_the_home(installed):
    updater, _, home = installed
    root = updater.root
    old = tree(root)
    kept = tree(home)
    updater.check()
    seen: list[tuple[int, int]] = []
    target = updater.install(lambda done, total: seen.append((done, total)))
    parent = root.parent
    assert target == parent / f"spinny-0.2.0-{PLATFORM}"
    assert (target / "VERSION").read_text(encoding="utf-8").startswith("spinny: 0.2.0")
    assert os.readlink(parent / "spinny") == target.name and os.readlink(parent / "spinny.previous") == root.name
    assert (parent / "spinny" / "bin" / "spinny-web").is_file()
    # The old release and the home are as they were, and nothing is left over.
    assert tree(root) == old and tree(home) == kept
    assert sorted(entry.name for entry in parent.iterdir()) == ["spinny", "spinny-0.1.0-x86_64-linux", "spinny-0.2.0-x86_64-linux", "spinny.previous"]
    assert seen and seen[-1][0] == seen[-1][1]
    assert updater.snapshot()["state"] == "done" and updater.snapshot()["installed"] == target.name
    # Back to the one before, and forward again.
    assert rollback(root) == root.name
    assert os.readlink(parent / "spinny") == root.name and os.readlink(parent / "spinny.previous") == target.name
    rollback(root)
    assert os.readlink(parent / "spinny") == target.name


def test_an_archive_that_does_not_match_its_sum_changes_nothing(installed):
    updater, github, _ = installed
    name = f"spinny-0.2.0-{PLATFORM}.tar.gz"
    github.files[name] = github.files[name][:-10] + b"0123456789"
    updater.check()
    with pytest.raises(UpdateError, match="does not match SHA256SUMS"):
        updater.install()
    assert sorted(entry.name for entry in updater.root.parent.iterdir()) == [updater.root.name]


def test_a_release_without_sums_or_an_archive_for_this_platform_is_refused(installed):
    updater, github, _ = installed
    sums = github.files.pop("SHA256SUMS")
    updater.check()
    with pytest.raises(UpdateError, match="no SHA256SUMS"):
        updater.install()
    github.files["SHA256SUMS"] = sums
    github.files.pop(f"spinny-0.2.0-{PLATFORM}.tar.gz")
    state = updater.check()
    assert state["error"] == f"the release v0.2.0 has no archive for {PLATFORM}"
    with pytest.raises(UpdateError, match="no archive for"):
        updater.install()


def test_nothing_published_or_nothing_newer_is_said(installed):
    updater, github, _ = installed
    github.status = 404
    with pytest.raises(UpdateError, match="no release is published at github.com/tmpk13/spinny-cnc yet"):
        updater.check()
    github.status = 200
    github.tag = "v0.1.0"
    github.files = {"SHA256SUMS": b""}
    assert updater.check()["status"] == "same"
    with pytest.raises(UpdateError, match="is not newer than this one"):
        updater.install()


def test_a_checkout_updates_with_git():
    updater = Updater(None)
    assert updater.snapshot()["kind"] == "checkout"
    with pytest.raises(UpdateError, match="git pull"):
        updater.check()
    lines: list[str] = []
    assert update.command("check", updater, lines.append) == 1
    assert "git pull" in lines[0]


def test_the_command_line_checks_updates_and_says_how_to_finish(installed):
    updater, _, _ = installed
    lines: list[str] = []
    assert update.command("check", updater, lines.append) == 0
    assert lines[1].startswith("latest: 0.2.0") and lines[2] == "a newer release: update with --update"
    lines.clear()
    assert update.command("update", updater, lines.append) == 0
    link = updater.root.parent / "spinny"
    assert lines[-1] == f"restart from {link / 'bin' / 'spinny-web'} to finish"


def test_the_routes_check_and_install_and_show_the_state(installed, tmp_path):
    updater, _, _ = installed
    backend = Backend(root=tmp_path / "var", jobs_dir=tmp_path / "var" / "jobs", config_path=tmp_path / "var" / "config.json")
    backend.updater = updater
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        assert client.get("/api/update").json()["status"] is None
        refused = client.post("/api/update/install")
        assert refused.status_code == 400 and refused.json()["detail"] == "check for a release first"
        assert client.post("/api/update/check").json()["status"] == "newer"
        started = client.post("/api/update/install")
        assert started.status_code == 200 and started.json()["state"] in ("downloading", "unpacking", "done")
        updater._thread.join(timeout=10.0)
        state = client.get("/api/update").json()
        assert state["state"] == "done" and state["installed"] == f"spinny-0.2.0-{PLATFORM}" and state["previous"] == f"spinny-0.1.0-{PLATFORM}"
        # Until a restart runs it, the update is not made again.
        again = client.post("/api/update/install")
        assert again.status_code == 400 and again.json()["detail"].startswith(f"spinny-0.2.0-{PLATFORM} is installed beside this one: restart from")
