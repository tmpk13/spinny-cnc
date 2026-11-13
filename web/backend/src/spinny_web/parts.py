"""The parts filter: a regular expression the operator types to leave
parts out of the PNP page's list and out of placing, such as connectors
fitted by hand or test points nobody places. It is tested against each
part's reference, its value, its footprint, or any of the three, as
chosen, in any case; a part it matches is listed by the parts route
marked `filtered`, and a placing plan leaves it out. The backend keeps it
in its config under `parts_filter`, so a run started from anywhere
honors it."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict

# The longest expression taken, characters.
MAX_PATTERN = 200
KEY = "parts_filter"


class PartsFilter(BaseModel):
    """The expression (empty leaves no part out) and what it is tested
    against: the reference, the value, the footprint, or any of them."""

    model_config = ConfigDict(extra="forbid")

    pattern: str = ""
    field: Literal["ref", "value", "footprint", "any"] = "ref"

    def compiled(self) -> re.Pattern[str] | None:
        """The expression, any case; None for an empty one. ValueError,
        saying what is wrong and where, for one that does not compile."""
        if len(self.pattern) > MAX_PATTERN:
            raise ValueError(f"the parts filter is longer than {MAX_PATTERN} characters")
        if self.pattern.strip() == "":
            return None
        try:
            return re.compile(self.pattern, re.IGNORECASE)
        except re.error as exc:
            where = f" at character {exc.pos + 1}" if exc.pos is not None else ""
            raise ValueError(f"the parts filter is not a regular expression: {exc.msg}{where}") from exc

    def texts(self, part: dict) -> list[str]:
        """What the expression is tested against in a part."""
        fields = ("ref", "value", "footprint") if self.field == "any" else (self.field,)
        return [str(part.get(name) or "") for name in fields]


def filter_of(config: dict) -> PartsFilter:
    """The filter the config keeps; the empty one when it keeps none, or
    one that does not read."""
    try:
        return PartsFilter.model_validate(config.get(KEY) or {})
    except ValueError:
        return PartsFilter()


def state(kept: PartsFilter) -> dict:
    """The filter as the page shows it, with why it leaves nothing out when
    its expression does not compile (a config written by hand)."""
    try:
        kept.compiled()
        error = None
    except ValueError as exc:
        error = str(exc)
    return {**kept.model_dump(), "error": error}


def mark(parts: list[dict], kept: PartsFilter) -> list[dict]:
    """Each part with `filtered` set when the filter matches it; nothing is
    filtered by an empty filter or one that does not compile."""
    try:
        compiled = kept.compiled()
    except ValueError:
        compiled = None
    for part in parts:
        part["filtered"] = compiled is not None and any(compiled.search(text) for text in kept.texts(part))
    return parts
