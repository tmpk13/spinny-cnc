"""Where the programs keep their files: the checkout's directories, else a
spinny home, and the first start's copy of the shipped files."""

from __future__ import annotations

from pathlib import Path

from spinny_laser import home


def test_this_package_runs_from_a_checkout():
    found = home.checkout()
    assert found is not None and (found / "toolpath" / "src" / "spinny_laser" / "home.py").is_file()


def test_a_directory_that_is_not_the_repository_is_no_checkout(tmp_path):
    assert home.checkout(tmp_path) is None
    (tmp_path / "toolpath" / "src" / "spinny_laser").mkdir(parents=True)
    assert home.checkout(tmp_path) is None
    (tmp_path / "machines").mkdir()
    assert home.checkout(tmp_path) == tmp_path


def test_the_home_is_spinny_home_then_the_checkout_then_the_user_data(tmp_path):
    repo = tmp_path / "repo"
    (repo / "toolpath" / "src" / "spinny_laser").mkdir(parents=True)
    (repo / "machines").mkdir()
    users = {"HOME": str(tmp_path / "user")}
    assert home.root({**users, home.ENV: str(tmp_path / "named")}, repo=repo) == tmp_path / "named"
    assert home.root(users, repo=repo) == repo
    assert home.root(users, repo=tmp_path / "installed") == tmp_path / "user" / ".local" / "share" / "spinny"
    assert home.root({**users, home.ENV: "  "}, repo=tmp_path / "installed") == tmp_path / "user" / ".local" / "share" / "spinny"


def test_the_user_data_follows_the_platform():
    assert home.user_data({"HOME": "/h"}, "linux") == Path("/h/.local/share/spinny")
    assert home.user_data({"HOME": "/h", "XDG_DATA_HOME": "/data"}, "linux") == Path("/data/spinny")
    # A relative XDG_DATA_HOME is invalid by the spec and ignored.
    assert home.user_data({"HOME": "/h", "XDG_DATA_HOME": "data"}, "linux") == Path("/h/.local/share/spinny")
    assert home.user_data({"HOME": "/h"}, "darwin") == Path("/h/Library/Application Support/spinny")
    assert home.user_data({"HOME": "/h", "LOCALAPPDATA": "/l"}, "win32") == Path("/l/spinny")
    assert home.user_data({"HOME": "/h"}, "win32") == Path("/h/AppData/Local/spinny")


def test_a_missing_directory_is_filled_from_the_shipped_one_and_an_existing_one_is_left(tmp_path):
    shipped = tmp_path / "shipped"
    (shipped / "sub").mkdir(parents=True)
    (shipped / "polar.toml").write_text("shipped")
    (shipped / "sub" / "deep.toml").write_text("deep")
    target = tmp_path / "home" / "machines"
    assert home.seed(target, shipped)
    assert (target / "polar.toml").read_text() == "shipped" and (target / "sub" / "deep.toml").read_text() == "deep"

    (target / "polar.toml").write_text("mine")
    (target / "sub" / "deep.toml").unlink()
    assert not home.seed(target, shipped)
    assert (target / "polar.toml").read_text() == "mine" and not (target / "sub" / "deep.toml").exists()


def test_nothing_is_made_without_shipped_files(tmp_path):
    assert not home.seed(tmp_path / "machines", tmp_path / "nothing")
    assert not (tmp_path / "machines").exists()
