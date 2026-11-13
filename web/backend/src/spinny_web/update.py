"""Updating an installed release from the project's GitHub releases.

A release (deploy/release.py) is one directory, `spinny-<label>-<platform>`,
that the backend runs from: this package sits in its
`python/lib/python3.12/site-packages/`, and its `VERSION` file names the
label (`spinny: 0.2.0`, or `0.2.0-g4a67b63` for an untagged build) and the
platform (`platform: x86_64-linux`). A checkout has none of this: it is
updated with git.

A check asks GitHub's API for the latest release of tmpk13/spinny-cnc: its
tag is the version (`v0.2.0`), and among its files are the archives,
`spinny-<label>-<platform>.tar.gz`, and `SHA256SUMS`, which release.py
writes beside them. GitHub's latest release is never a pre-release; when
pre-releases are followed, the check lists the releases instead and takes
the newest by version (a draft skipped) that carries this platform's
archive and SHA256SUMS, a pre-release or not. An update downloads the archive for this platform
next to the install, checks it against SHA256SUMS, unpacks it into its
own directory beside the running one, and points the link `spinny` in that
directory at it, atomically (a new link renamed over the old one); the
link `spinny.previous` points at the release it replaced, which stays as
it was, for a rollback. Nothing in the user's home (machine files, CAM
profiles, jobs: ~/.local/share/spinny) is touched. The running backend
goes on with the code it started with; `spinny/bin/spinny-web` starts the
new one.

The check matches GitHub's integrity, not its authenticity: SHA256SUMS
comes from the same release as the archive, so it catches a broken
download, not a release someone else published.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import __version__

REPOSITORY = "tmpk13/spinny-cnc"
LATEST_URL = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
# The releases a check that follows pre-releases looks through, newest first.
LISTED = 100
# What the requests call themselves: GitHub's API refuses a request with none.
USER_AGENT = "spinny-update"
# How long a request may wait for an answer, s.
TIMEOUT = 15.0
# The most of the API's answer read, bytes, and the largest archive taken.
MAX_ANSWER = 1024 * 1024
MAX_ARCHIVE = 1024 * 1024 * 1024
CHUNK = 256 * 1024
# The link that names the current release, and the one that names the one before.
LINK = "spinny"
PREVIOUS = "spinny.previous"
SUMS = "SHA256SUMS"
# A target triple as the VERSION file of an older release names it, and its platform.
PLATFORMS = {"x86_64-unknown-linux-gnu": "x86_64-linux", "aarch64-unknown-linux-gnu": "aarch64-linux"}
LABEL = re.compile(r"^v?(\d+(?:\.\d+)*)(.*)$")
# What release.py adds to the version of a build from a commit with no tag
# of its own, or with changes not committed.
BUILD = re.compile(r"(-g[0-9a-f]+)?(-dirty)?$")
# What marks a version as one before its release: 0.3.0rc1, 0.3.0-beta.2, 0.3.0.dev1.
PRE = re.compile(r"^[-.]?(dev|a|alpha|b|beta|c|rc|pre|preview)(?![a-z])", re.IGNORECASE)


class UpdateError(Exception):
    """A check or an update that could not be made; the text says why."""


def read_version_file(text: str) -> dict[str, str]:
    """A release's VERSION file as its `key: value` lines."""
    found = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            found[key.strip()] = value.strip()
    return found


def release_root(package: Path = Path(__file__).resolve().parent) -> Path | None:
    """The release directory this package runs from, or None for one that
    is not a release's (a checkout, a wheel installed elsewhere)."""
    # <root>/python/lib/python3.12/site-packages/spinny_web
    if package.parent.name != "site-packages" or len(package.parents) < 5:
        return None
    root = package.parents[4]
    marked = (root / "VERSION").is_file() and (root / "bin" / "spinny-web").is_file()
    return root if marked else None


def version_key(label: str) -> tuple[tuple[int, ...], str]:
    """A release label or tag split into its numbers and what follows them
    (`-g4a67b63`, `-dirty`); a label with no numbers sorts first."""
    found = LABEL.match(label.strip())
    if not found:
        return ((), label)
    return (tuple(int(part) for part in found.group(1).split(".")), found.group(2))


def release_order(label: str) -> tuple:
    """A key that sorts release labels as they were released: by their
    numbers, and for the same numbers a pre-release (0.3.0rc1) before the
    release (0.3.0) before anything after it (0.3.0.post1), the rest of the
    label compared with its numbers as numbers (rc2 before rc10)."""
    numbers, rest = version_key(label)
    rank = 1 if rest == "" else 0 if PRE.match(rest) else 2
    words = tuple((0, int(token), "") if token.isdigit() else (1, 0, token.lower()) for token in re.findall(r"\d+|\D+", rest))
    return (numbers, rank, words)


def compare(installed: str, latest: str) -> str:
    """How the latest release stands against the one installed: `newer`,
    `same`, `older`, or `other` for the same version built from another
    commit (an untagged or changed build, which the tagged release
    replaces). A pre-release stands before the release of its numbers."""
    have, want = version_key(installed), version_key(latest)
    if have == want:
        return "same"
    if want[0] != have[0]:
        return "newer" if want[0] > have[0] else "older"
    base = BUILD.sub("", installed.strip())
    if version_key(base) == want:
        return "other"
    return "newer" if release_order(latest) > release_order(base) else "older"


@dataclass
class Release:
    """The latest release as GitHub lists it: its version, its page, and
    the archive for this platform with the checksums beside it, and
    whether GitHub marks it a pre-release."""

    version: str
    tag: str
    page: str
    published: str
    archive: str | None
    archive_url: str | None
    size: int
    sums_url: str | None
    prerelease: bool = False

    def to_dict(self) -> dict:
        return {
            "version": self.version, "tag": self.tag, "page": self.page, "published": self.published, "archive": self.archive, "size": self.size,
            "prerelease": self.prerelease,
        }


def _get(url: str, timeout: float, limit: int = MAX_ANSWER) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            data = answer.read(limit + 1)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise UpdateError(f"no release is published at github.com/{REPOSITORY} yet") from exc
        if exc.code in (403, 429):
            raise UpdateError(f"GitHub refused the request ({exc.code}): it allows 60 an hour from one address; try again later") from exc
        raise UpdateError(f"GitHub answered {exc.code} {exc.reason}") from exc
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpdateError(f"could not reach {url.split('/')[2]}: {reason}") from exc
    if len(data) > limit:
        raise UpdateError(f"{url} answered more than {limit} bytes")
    return data


def _release_of(listed: dict, platform: str) -> Release:
    """A release as GitHub's API lists it, with its archive for `platform`."""
    tag = listed["tag_name"]
    assets = [asset for asset in listed.get("assets") or [] if isinstance(asset, dict) and isinstance(asset.get("name"), str)]
    pattern = re.compile(rf"^spinny-(?P<label>[0-9A-Za-z.+-]+)-{re.escape(platform)}\.tar\.gz$")
    archive = next((asset for asset in assets if pattern.match(asset["name"])), None)
    sums = next((asset for asset in assets if asset["name"] == SUMS), None)
    label = pattern.match(archive["name"]).group("label") if archive is not None else tag.removeprefix("v")
    return Release(
        version=label,
        tag=tag,
        page=str(listed.get("html_url") or f"https://github.com/{REPOSITORY}/releases"),
        published=str(listed.get("published_at") or ""),
        archive=archive["name"] if archive is not None else None,
        archive_url=str(archive.get("browser_download_url")) if archive is not None else None,
        size=int(archive.get("size") or 0) if archive is not None else 0,
        sums_url=str(sums.get("browser_download_url")) if sums is not None else None,
        prerelease=listed.get("prerelease") is True,
    )


def _answer(url: str, timeout: float):
    try:
        return json.loads(_get(url, timeout))
    except ValueError as exc:
        raise UpdateError(f"GitHub's answer is not JSON: {exc}") from exc


def latest_release(platform: str, url: str = LATEST_URL, timeout: float = TIMEOUT) -> Release:
    """The latest release GitHub lists, with its archive for `platform`."""
    listed = _answer(url, timeout)
    if not isinstance(listed, dict) or not isinstance(listed.get("tag_name"), str):
        raise UpdateError("GitHub's answer names no release")
    return _release_of(listed, platform)


def list_url(url: str) -> str:
    """Where the releases are listed, from where the latest is asked: the
    same address without its `/latest`."""
    base = url.split("?", 1)[0].removesuffix("/")
    return f"{base.removesuffix('/latest')}?per_page={LISTED}"


def newest_release(platform: str, url: str = LATEST_URL, timeout: float = TIMEOUT) -> Release:
    """The newest release by version, a pre-release or not, that carries
    an archive for `platform` and SHA256SUMS; drafts are passed over. `url`
    is where the latest release is asked, the list beside it."""
    listed = _answer(list_url(url), timeout)
    if not isinstance(listed, list):
        raise UpdateError("GitHub's answer is no list of releases")
    releases = [
        _release_of(entry, platform) for entry in listed
        if isinstance(entry, dict) and isinstance(entry.get("tag_name"), str) and entry.get("draft") is not True
    ]
    if not releases:
        raise UpdateError(f"no release is published at github.com/{REPOSITORY} yet")
    complete = [release for release in releases if release.archive is not None and release.sums_url is not None]
    if not complete:
        raise UpdateError(f"no release at github.com/{REPOSITORY} has an archive for {platform} with {SUMS} beside it")
    return max(complete, key=lambda release: release_order(release.version))


def expected_sum(sums: str, name: str) -> str | None:
    """The SHA256 a SHA256SUMS text gives for the file `name`."""
    for line in sums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == name and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            return parts[0].lower()
    return None


def point(parent: Path, name: str, target: str) -> None:
    """Points the link `parent/name` at `target` (a name beside it) at
    once: a new link is made and renamed over the old one, so the name
    always reaches one release or the other."""
    fresh = parent / f".{name}.new"
    if fresh.is_symlink() or fresh.exists():
        fresh.unlink()
    os.symlink(target, fresh)
    os.replace(fresh, parent / name)


@dataclass
class Updater:
    """The installed release (`root`, None for a checkout) and the check
    and the update made from it; `url` is where the latest release is
    asked for. The state is what the page shows."""

    root: Path | None
    url: str = LATEST_URL
    on_change: Callable[[], None] = lambda: None
    state: dict = field(default_factory=dict)
    # Whether a check takes pre-releases too: the newest release by
    # version, not GitHub's latest.
    prereleases: bool = False

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.release: Release | None = None
        info = read_version_file((self.root / "VERSION").read_text(encoding="utf-8")) if self.root is not None else {}
        self.version = info.get("spinny", __version__)
        self.platform = info.get("platform") or PLATFORMS.get(info.get("target", ""))
        self.state = {
            "kind": "release" if self.root is not None else "checkout",
            "version": self.version,
            "platform": self.platform,
            "root": str(self.root) if self.root is not None else None,
            "link": str(self.root.parent / LINK) if self.root is not None else None,
            "latest": None,
            "status": None,
            "checked": None,
            "state": "idle",
            "done": 0,
            "total": 0,
            "error": None,
            "installed": None,
            "previous": None,
            "prereleases": self.prereleases,
        }

    @classmethod
    def here(cls, on_change: Callable[[], None] = lambda: None) -> Updater:
        """The updater of the release this backend runs from (a checkout's
        when it runs from none); SPINNY_UPDATE_URL names another place to
        ask for the latest release."""
        return cls(release_root(), url=os.environ.get("SPINNY_UPDATE_URL") or LATEST_URL, on_change=on_change)

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def _set(self, **changes) -> None:
        with self._lock:
            self.state.update(changes)
        self.on_change()

    def _release_only(self) -> Path:
        if self.root is None:
            raise UpdateError("this is a checkout of the repository, not an installed release: it updates with git (git pull)")
        if self.platform is None:
            raise UpdateError(f"{self.root / 'VERSION'} names no platform")
        return self.root

    @property
    def busy(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # --- the check ---------------------------------------------------------------

    def follow_prereleases(self, follow: bool) -> dict:
        """Takes pre-releases into a check, or leaves them out again; a check
        made the other way is forgotten, since its answer may differ."""
        if self.busy:
            raise UpdateError("an update is under way")
        if follow != self.prereleases:
            self.prereleases = follow
            self.release = None
            self._set(prereleases=follow, latest=None, status=None, checked=None, error=None)
        return self.snapshot()

    def check(self) -> dict:
        """Asks for the latest release, or with pre-releases followed the
        newest, and how it stands against this one."""
        self._release_only()
        if self.busy:
            raise UpdateError("an update is under way")
        try:
            release = newest_release(self.platform, self.url) if self.prereleases else latest_release(self.platform, self.url)
        except UpdateError as exc:
            self._set(error=str(exc), checked=time.strftime("%Y-%m-%dT%H:%M:%S"))
            raise
        self.release = release
        self._set(
            latest=release.to_dict(),
            status=compare(self.version, release.version),
            checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
            error=None if release.archive is not None else f"the release {release.tag} has no archive for {self.platform}",
        )
        return self.snapshot()

    # --- the update -------------------------------------------------------------------

    def start(self) -> dict:
        """Starts the update to the release last checked, on its own thread."""
        self._ready()
        self._set(state="downloading", done=0, total=self.release.size if self.release else 0, error=None)
        self._thread = threading.Thread(target=self._run, name="update", daemon=True)
        self._thread.start()
        return self.snapshot()

    def _ready(self) -> Release:
        self._release_only()
        if self.busy:
            raise UpdateError("an update is under way")
        installed = self.state.get("installed")
        if installed:
            raise UpdateError(f"{installed} is installed beside this one: restart from {self.root.parent / LINK / 'bin' / 'spinny-web'} to run it")
        release = self.release
        if release is None:
            raise UpdateError("check for a release first")
        if self.state.get("status") not in ("newer", "other"):
            raise UpdateError(f"the latest release, {release.version}, is not newer than this one ({self.version})")
        if release.archive is None or release.archive_url is None:
            raise UpdateError(f"the release {release.tag} has no archive for {self.platform}")
        if release.sums_url is None:
            raise UpdateError(f"the release {release.tag} has no {SUMS} to check its archive against: upload the one release.py wrote beside the archives")
        return release

    def _run(self) -> None:
        try:
            assert self.release is not None
            self._install(self.release, None)
        except UpdateError as exc:
            self._set(state="error", error=str(exc))
        except Exception as exc:
            self._set(state="error", error=f"{type(exc).__name__}: {exc}")

    def install(self, progress: Callable[[int, int], None] | None = None) -> Path:
        """Downloads, checks, unpacks and switches to the release last
        checked; the new release's directory. `progress` is told the bytes
        downloaded and the archive's size as they come."""
        return self._install(self._ready(), progress)

    def _install(self, release: Release, progress: Callable[[int, int], None] | None) -> Path:
        assert release.archive is not None and release.archive_url is not None and release.sums_url is not None
        root = self._release_only()
        parent = root.parent
        name = release.archive.removesuffix(".tar.gz")
        target = parent / name
        if target.exists():
            raise UpdateError(f"{target} is there already: remove it, or point {parent / LINK} at it by hand")
        link = parent / LINK
        if link.exists() and not link.is_symlink():
            raise UpdateError(f"{link} is not a link: move it away, and the update makes it one")
        if not os.access(parent, os.W_OK):
            raise UpdateError(f"{parent} cannot be written: the release is unpacked beside the one running")
        self._set(state="downloading", done=0, total=release.size)
        sums = _get(release.sums_url, TIMEOUT).decode("utf-8", errors="replace")
        want = expected_sum(sums, release.archive)
        if want is None:
            raise UpdateError(f"{SUMS} of {release.tag} has no line for {release.archive}")
        work = Path(tempfile.mkdtemp(prefix=".spinny-update-", dir=parent))
        try:
            archive = work / release.archive
            digest = self._download(release.archive_url, archive, release.size, progress)
            if digest != want:
                raise UpdateError(f"{release.archive} does not match {SUMS}: sha256 {digest}, {want} published; nothing was changed")
            self._set(state="unpacking")
            unpacked = work / "unpacked"
            unpacked.mkdir()
            try:
                with tarfile.open(archive, "r:gz") as tar:
                    tar.extractall(unpacked, filter="data")
            except (tarfile.TarError, OSError) as exc:
                raise UpdateError(f"{release.archive} does not unpack: {exc}") from exc
            inside = list(unpacked.iterdir())
            if [entry.name for entry in inside] != [name] or not (inside[0] / "bin" / "spinny-web").is_file() or not (inside[0] / "VERSION").is_file():
                raise UpdateError(f"{release.archive} does not hold one release directory {name} with bin/spinny-web and VERSION")
            os.replace(inside[0], target)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        before = os.readlink(link) if link.is_symlink() else root.name
        point(parent, LINK, name)
        point(parent, PREVIOUS, before)
        self._set(state="done", installed=name, previous=before)
        return target

    def _download(self, url: str, path: Path, size: int, progress: Callable[[int, int], None] | None) -> str:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"})
        digest = hashlib.sha256()
        done = 0
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as answer, path.open("wb") as out:
                total = int(answer.headers.get("Content-Length") or size or 0)
                while True:
                    chunk = answer.read(CHUNK)
                    if not chunk:
                        break
                    done += len(chunk)
                    if done > MAX_ARCHIVE:
                        raise UpdateError(f"{url} is larger than {MAX_ARCHIVE // (1024 * 1024)} MB")
                    digest.update(chunk)
                    out.write(chunk)
                    self._set(done=done, total=total)
                    if progress is not None:
                        progress(done, total)
        except urllib.error.HTTPError as exc:
            raise UpdateError(f"the archive's download answered {exc.code} {exc.reason}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise UpdateError(f"the archive's download failed: {getattr(exc, 'reason', exc)}") from exc
        return digest.hexdigest()


def rollback(root: Path) -> str:
    """Points `spinny` back at the release `spinny.previous` names, and
    `spinny.previous` at the one it named; the release now named."""
    parent = root.parent
    link, previous = parent / LINK, parent / PREVIOUS
    if not previous.is_symlink():
        raise UpdateError(f"no {previous}: there is no earlier release to go back to")
    before = os.readlink(previous)
    if not (parent / before).is_dir():
        raise UpdateError(f"{previous} names {before}, which is gone")
    now = os.readlink(link) if link.is_symlink() else root.name
    point(parent, LINK, before)
    point(parent, PREVIOUS, now)
    return before


def command(action: str, updater: Updater | None = None, out: Callable[[str], None] = print, prereleases: bool = False) -> int:
    """`spinny-web --check-update`, `--update` and `--rollback`: what was
    found or done, in words; 0 when it went as asked. With `prereleases`
    (`--pre`) the check takes the newest release, a pre-release or not."""
    updater = updater or Updater.here()
    try:
        updater.follow_prereleases(prereleases)
        if updater.root is None:
            raise UpdateError("this is a checkout of the repository, not an installed release: it updates with git (git pull)")
        if action == "rollback":
            name = rollback(updater.root)
            out(f"{updater.root.parent / LINK} now points at {name}: start {updater.root.parent / LINK / 'bin' / 'spinny-web'}")
            return 0
        state = updater.check()
        latest = state["latest"]
        out(f"installed: {updater.version} ({updater.platform}) in {updater.root}")
        out(f"latest: {latest['version']}{', a pre-release' if latest['prerelease'] else ''}, {latest['page']}")
        status = state["status"]
        if action == "check":
            words = {"newer": "a newer release: update with --update", "same": "up to date", "older": "the installed one is newer", "other": "the same version from another build: --update installs the release"}
            out(words.get(status, status))
            if state["error"]:
                out(state["error"])
            return 0
        if status not in ("newer", "other"):
            out("up to date: nothing to update")
            return 0
        shown = {"step": -1}

        def progress(done: int, total: int) -> None:
            step = done * 10 // total if total else 0
            if step != shown["step"]:
                shown["step"] = step
                out(f"downloading {latest['archive']}: {done / 1e6:.1f} of {total / 1e6:.1f} MB")

        target = updater.install(progress)
        link = updater.root.parent / LINK
        out(f"installed {target.name}; {link} points at it and {updater.root.parent / PREVIOUS} at the one before")
        out(f"restart from {link / 'bin' / 'spinny-web'} to finish")
        return 0
    except UpdateError as exc:
        out(f"update: {exc}")
        return 1
