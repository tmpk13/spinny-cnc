"""A routine's finding held for the operator: kept, discarded, replaced."""

from __future__ import annotations

import pytest

from spinny_web.findings import Finding, Findings


def test_a_finding_is_held_until_kept_or_discarded_and_a_newer_one_takes_its_place():
    kept: list[str] = []
    findings = Findings()
    assert findings.state() is None
    with pytest.raises(ValueError, match="nothing found"):
        findings.answer(True)
    findings.hold(Finding("corner", "first", lambda: kept.append("first") or "kept the first", {"points": []}))
    findings.hold(Finding("corner", "second", lambda: kept.append("second") or "kept the second", {"corner": [1.0, 2.0]}))
    assert findings.state() == {"kind": "corner", "text": "second", "corner": [1.0, 2.0]}
    # Keep waits while a routine of the camera runs; the finding stays.
    with pytest.raises(ValueError, match="under way"):
        findings.answer(True, busy=True)
    assert findings.state() is not None
    assert findings.answer(True) == "kept the second" and kept == ["second"]
    assert findings.state() is None
    # Discard keeps nothing, busy or not.
    findings.hold(Finding("offset", "third", lambda: kept.append("third") or "kept"))
    assert findings.answer(False, busy=True) is None and kept == ["second"] and findings.state() is None
