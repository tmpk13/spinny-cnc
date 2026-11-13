"""The to-do list behind the top bar's drawer: things to do, each with a
check, kept in var/todo.json so every browser shows the same list.

The page puts the whole list back after each change, with the revision it
made the change on. A list another browser changed in between has moved
on to a newer revision, and that put is refused (409): the page reads the
list again and makes its change on that, rather than putting its older
copy over the other browser's change.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .files import write_whole

MAX_ITEMS = 500
MAX_TEXT = 500
ITEM_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class TodoItem(BaseModel):
    id: str
    text: str
    done: bool = False


class TodoPut(BaseModel):
    items: list[TodoItem] = Field(default_factory=list)
    # The revision the change was made on; left out, the list is put
    # whatever the kept one's revision is.
    revision: int | None = None


class Stale(Exception):
    """The list changed since the revision a put was made on."""


def checked(items: list[TodoItem]) -> list[TodoItem]:
    """The items with their text trimmed (and any run of spaces or line
    breaks made one space), or what is wrong with them: each id once, and
    every text 1 to MAX_TEXT characters."""
    if len(items) > MAX_ITEMS:
        raise ValueError(f"at most {MAX_ITEMS} to-dos")
    ids: set[str] = set()
    out: list[TodoItem] = []
    for item in items:
        if not ITEM_ID.match(item.id):
            raise ValueError("a to-do's id is 1 to 40 letters, digits, _ or -")
        if item.id in ids:
            raise ValueError(f"two to-dos have the id {item.id!r}")
        text = " ".join(item.text.split())
        if not text or len(text) > MAX_TEXT:
            raise ValueError(f"a to-do is 1 to {MAX_TEXT} characters")
        ids.add(item.id)
        out.append(TodoItem(id=item.id, text=text, done=item.done))
    return out


class TodoStore:
    """The list in one file, written whole: a reader never sees half of it,
    and puts take turns, each checking the revision it was made on."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> tuple[int, list[TodoItem]]:
        """The revision and the items kept; a missing file is an empty list,
        and a file that does not read is one too (the next put replaces it)."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return 0, []
        if not isinstance(data, dict):
            return 0, []
        revision = data.get("revision")
        revision = revision if isinstance(revision, int) and revision >= 0 else 0
        items: list[TodoItem] = []
        for raw in data.get("items") or []:
            try:
                items.append(TodoItem.model_validate(raw))
            except ValueError:
                continue
        try:
            return revision, checked(items)
        except ValueError:
            return revision, []

    @staticmethod
    def _state(revision: int, items: list[TodoItem]) -> dict:
        return {"revision": revision, "items": [item.model_dump() for item in items]}

    def state(self) -> dict:
        with self._lock:
            return self._state(*self._read())

    def put(self, items: list[TodoItem], revision: int | None = None) -> dict:
        """Keeps `items` in place of the list; the list as kept, its revision
        one on. Raises Stale when `revision` is not the kept one's."""
        kept = checked(items)
        with self._lock:
            current, _ = self._read()
            if revision is not None and revision != current:
                raise Stale("the list changed in another window: read it again")
            state = self._state(current + 1, kept)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_whole(self.path, json.dumps(state, indent=4) + "\n")
            return state


def router(store: TodoStore) -> APIRouter:
    routes = APIRouter()

    @routes.get("/api/todo")
    def get_todo():
        return store.state()

    @routes.put("/api/todo")
    def put_todo(body: TodoPut):
        try:
            return store.put(body.items, body.revision)
        except Stale as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return routes
