"""The TOML store's parse kept between reads (spinny_web.stores)."""

from __future__ import annotations

import os
import tomllib

from spinny_web.stores import TomlStore


class Plain(TomlStore):
    """A store of any TOML file, read as its table."""

    def check_id(self, item_id: str) -> None:
        if not item_id.isalnum():
            raise ValueError(f"{item_id!r} is not an id")

    def parse(self, text: str, item_id: str, where: str | None = None) -> dict:
        return tomllib.loads(text)

    def describe(self, parsed: dict) -> dict:
        return parsed


def test_a_file_saved_again_within_one_tick_of_the_clock_reads_as_saved(tmp_path):
    store = Plain(tmp_path)
    store.save("a", "x = 1\n")
    assert store.get("a") == {"x": 1}
    stamp = (tmp_path / "a.toml").stat().st_mtime_ns
    store.save("a", "x = 2\n")
    # A file system whose clock ticks coarser than the two saves are apart
    # (FAT, NFS, a kernel without fine-grained file times) gives the second
    # file the first one's time.
    os.utime(tmp_path / "a.toml", ns=(stamp, stamp))
    assert store.get("a") == {"x": 2}
    store.patch("a", ["x"], 3)
    os.utime(tmp_path / "a.toml", ns=(stamp, stamp))
    assert store.get("a") == {"x": 3}


def test_a_file_edited_by_hand_within_one_tick_of_the_clock_reads_as_edited(tmp_path):
    store = Plain(tmp_path)
    store.save("a", "x = 1\n")
    assert store.get("a") == {"x": 1}
    path = tmp_path / "a.toml"
    stamp = path.stat().st_mtime_ns
    # Written in place, as some editors do, within the same tick.
    with path.open("w", encoding="utf-8") as handle:
        handle.write("x = 22\n")
    os.utime(path, ns=(stamp, stamp))
    assert store.get("a") == {"x": 22}
