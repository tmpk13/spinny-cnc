"""Plugins: JavaScript modules for the page, one file each,
var/plugins/<id>.js, that add panels and readouts to it (docs/PLUGINS.md).

A plugin runs in the page with the page's whole power, the machine's moves
included, so it is off until the operator turns it on in the Plugins tab,
and a plugin whose file changed since is off again: what was turned on is
the file's SHA-256, kept in var/plugins/plugins.json with the one a plugin
was last written with through these routes (which the Auto tools use).
A file whose text is not the one written there was put in place by hand.

A plugin's module exports `name` and `description` as plain string
literals, read here from its text without running it, and
`activate(host)`. The page imports the module of each plugin turned on
from `module.js`, naming the SHA-256 it was told was turned on: a plugin
written again in between is not served, so a page never runs text the
operator did not turn on.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .files import write_whole

PLUGIN_ID = r"^[a-z0-9][a-z0-9_-]{0,63}$"
MAX_SOURCE = 256 * 1024
MAX_NAME = 80
MAX_DESCRIPTION = 500
REGISTRY = "plugins.json"
# Who made a plugin: written through these routes (the Auto tools), or put
# in the folder by hand.
AUTO, FILE = "auto", "file"
EXPORT = re.compile(r"""export\s+const\s+(name|description)\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\\$]*)`)""")
ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "0": "\0"}


class PluginError(Exception):
    """A plugin that cannot be written, or an id that is not one."""


class PluginNotFound(Exception):
    pass


class PluginStale(Exception):
    """The plugin's file is not the one the request was made on."""


def exported(source: str) -> dict[str, str]:
    """The `name` and `description` a module exports as plain string
    literals, the first of each; a value made any other way is not read."""
    found: dict[str, str] = {}
    for match in EXPORT.finditer(source):
        key = match.group(1)
        if key in found:
            continue
        raw = next(group for group in match.groups()[1:] if group is not None)
        found[key] = re.sub(r"\\(.)", lambda m: ESCAPES.get(m.group(1), m.group(1)), raw)
    return found


def _one_line(text: str, most: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= most else text[: most - 3].rstrip() + "..."


def check_id(plugin_id: str) -> str:
    if not re.match(PLUGIN_ID, plugin_id):
        raise PluginError("a plugin's id is 1 to 64 lower-case letters, digits, _ or -, starting with a letter or digit")
    return plugin_id


class PluginBody(BaseModel):
    source: str


class EnabledBody(BaseModel):
    enabled: bool
    # The SHA-256 of the text shown when it was turned on; needed to turn
    # one on, so that a plugin rewritten in between is not.
    hash: str | None = None


class PluginStore:
    """The folder of plugins and what was written and turned on there."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self._lock = threading.Lock()

    def _registry(self) -> dict[str, dict]:
        try:
            data = json.loads((self.folder / REGISTRY).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {key: value for key, value in data.items() if isinstance(value, dict)} if isinstance(data, dict) else {}

    def _keep(self, registry: dict[str, dict]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        write_whole(self.folder / REGISTRY, json.dumps(registry, indent=4, sort_keys=True) + "\n")

    def _file(self, plugin_id: str) -> Path:
        return self.folder / f"{check_id(plugin_id)}.js"

    def _read(self, plugin_id: str) -> bytes:
        try:
            return self._file(plugin_id).read_bytes()
        except FileNotFoundError as exc:
            raise PluginNotFound(f"no plugin {plugin_id}") from exc

    def _info(self, plugin_id: str, data: bytes, entry: dict, modified: float) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        said = exported(data.decode("utf-8", errors="replace"))
        turned_on = entry.get("enabled")
        return {
            "id": plugin_id,
            "name": _one_line(said.get("name", ""), MAX_NAME) or plugin_id,
            "description": _one_line(said.get("description", ""), MAX_DESCRIPTION),
            "made_by": AUTO if entry.get("written") == digest else FILE,
            "enabled": turned_on == digest,
            # Turned on, and its file changed since (written again, or
            # edited by hand): off again.
            "changed": (isinstance(turned_on, str) and turned_on != digest) or entry.get("rewritten") is True,
            "hash": digest,
            "size": len(data),
            "modified": datetime.fromtimestamp(modified, timezone.utc).isoformat(timespec="seconds"),
        }

    def _one(self, plugin_id: str, registry: dict[str, dict]) -> tuple[dict, bytes]:
        data = self._read(plugin_id)
        modified = self._file(plugin_id).stat().st_mtime
        return self._info(plugin_id, data, registry.get(plugin_id, {}), modified), data

    def list(self) -> list[dict]:
        with self._lock:
            registry = self._registry()
            out = []
            for path in sorted(self.folder.glob("*.js")) if self.folder.is_dir() else []:
                if re.match(PLUGIN_ID, path.stem):
                    try:
                        out.append(self._one(path.stem, registry)[0])
                    except (OSError, PluginNotFound):
                        continue
            return out

    def read(self, plugin_id: str) -> dict:
        with self._lock:
            info, data = self._one(plugin_id, self._registry())
            return {**info, "source": data.decode("utf-8", errors="replace")}

    def module(self, plugin_id: str, digest: str) -> bytes:
        """The module's text, only while it is turned on as `digest`."""
        with self._lock:
            info, data = self._one(plugin_id, self._registry())
            if not info["enabled"] or info["hash"] != digest:
                raise PluginStale(f"plugin {plugin_id} is not turned on as that text")
            return data

    def write(self, plugin_id: str, source: str) -> dict:
        """Keeps `source` as the plugin, turned off, made by a tool."""
        data = source.encode("utf-8")
        if not data.strip():
            raise PluginError("a plugin's source is empty")
        if len(data) > MAX_SOURCE:
            raise PluginError(f"a plugin is at most {MAX_SOURCE // 1024} KB")
        path = self._file(plugin_id)
        with self._lock:
            self.folder.mkdir(parents=True, exist_ok=True)
            write_whole(path, data)
            registry = self._registry()
            before = registry.get(plugin_id, {})
            # On when written, or written again since it was on: off now,
            # and said so until the operator turns it on or off.
            was_on = isinstance(before.get("enabled"), str) or before.get("rewritten") is True
            registry[plugin_id] = {"written": hashlib.sha256(data).hexdigest(), "enabled": None, "rewritten": was_on}
            self._keep(registry)
            return self._one(plugin_id, registry)[0]

    def set_enabled(self, plugin_id: str, enabled: bool, digest: str | None) -> dict:
        """Turns the plugin on as the text whose SHA-256 is `digest`, or off."""
        with self._lock:
            registry = self._registry()
            info, _ = self._one(plugin_id, registry)
            if enabled and digest != info["hash"]:
                raise PluginStale("the plugin changed since it was shown: read it again before turning it on")
            entry = dict(registry.get(plugin_id, {}))
            entry["enabled"] = info["hash"] if enabled else None
            entry.pop("rewritten", None)
            registry[plugin_id] = entry
            self._keep(registry)
            return self._one(plugin_id, registry)[0]

    def delete(self, plugin_id: str) -> None:
        path = self._file(plugin_id)
        with self._lock:
            try:
                path.unlink()
            except FileNotFoundError as exc:
                raise PluginNotFound(f"no plugin {plugin_id}") from exc
            registry = self._registry()
            if registry.pop(plugin_id, None) is not None:
                self._keep(registry)


def add_routes(app: FastAPI, store: PluginStore) -> None:
    """The plugins' routes, put on the app itself: FastAPI 0.142 keeps the
    routes of an included router out of `app.routes`, where the check of
    the routes the Auto tools may call looks for every route."""

    def answer(call):
        try:
            return call()
        except PluginError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except PluginNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except PluginStale as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/plugins")
    def list_plugins():
        return {"plugins": store.list()}

    @app.get("/api/plugins/{plugin_id}")
    def read_plugin(plugin_id: str):
        return answer(lambda: store.read(plugin_id))

    @app.put("/api/plugins/{plugin_id}")
    def write_plugin(plugin_id: str, body: PluginBody):
        return answer(lambda: store.write(plugin_id, body.source))

    @app.delete("/api/plugins/{plugin_id}")
    def delete_plugin(plugin_id: str):
        answer(lambda: store.delete(plugin_id))
        return {"deleted": plugin_id}

    @app.put("/api/plugins/{plugin_id}/enabled")
    def enable_plugin(plugin_id: str, body: EnabledBody):
        return answer(lambda: store.set_enabled(plugin_id, body.enabled, body.hash))

    @app.get("/api/plugins/{plugin_id}/module.js")
    def plugin_module(plugin_id: str, v: str = ""):
        data = answer(lambda: store.module(plugin_id, v))
        return Response(content=data, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-store"})
