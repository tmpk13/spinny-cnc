"""Pictures of a board taken where the head's place is known, and pcbv
graded on them: how often a picture locks, how often the lock is right,
how close the right ones are.

- `sweep`: the top camera of a G-code machine (a LumenPnP) goes over a
  grid of head places through a running backend; at each stop the
  picture is kept with the place the machine reads back, in a survey
  folder (var/surveys/NAME: NNNN.jpg, stops.jsonl, survey.json, and the
  board file when given).
- `grade`: `pcbv locate --json` on every picture of a survey, the options
  after `--` passed to pcbv, the answers kept per pcbv build and options
  so a second grade costs nothing. One rigid map from the board to the
  head's places is fitted through every lock's picture center, robust to
  wrong locks; a lock within 1 mm of it is right, any other wrong.
- `baseline`: the battery card sweep of 2026-11-14 graded with the
  numbers kept in survey_baseline.json beside this file (the truth and,
  per set of pcbv options, locked, right, wrong and the right ones' rms);
  the exit status is 1 when the pcbv build does worse on any of them.
- `searches`: the backend's own board search from several start places,
  each followed to its end and graded against a survey's truth or a
  place given.

    spinny-survey sweep X0,Y0,X1,Y1 [--step SX,SY] [--name NAME] [--board FILE]
                        [--settle S] [--width PX] [--url URL]
    spinny-survey grade SURVEY [--board FILE] [--pcbv PROGRAM] [--jobs N]
                        [--cache DIR] [--fresh] [--json] [-- PCBV OPTIONS ...]
    spinny-survey baseline [--survey DIR] [--case NAME|all] [--pcbv PROGRAM]
                           [--jobs N] [--write] [--json]
    spinny-survey searches X,Y [X,Y ...] [--box X0,Y0,X1,Y1] [--method vote|posterior]
                           [--survey SURVEY | --truth X,Y,DEG] [--out FILE] [--url URL]
    spinny-survey searches --from FILE [--survey SURVEY | --truth X,Y,DEG] [--json]

Places are the machine's X and Y as the machine file counts them (the
G-code machine's joints r and z). A survey's truth maps a KiCad board
point (x, y) to the head's place over it: head = R(turn) (x, -y) + shift,
the camera's offset from the head folded into the shift.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .boardlook import match_of

Point = tuple[float, float]

# The backend the sweep and the searches drive when none is named.
DEFAULT_URL = "http://127.0.0.1:8000"
# A lock whose picture center lies this far from the truth or farther is
# wrong, mm.
RIGHT_MM = 1.0
# The robust fit: two locks whose head places lie this far apart or more
# propose a map, mm; the proposal the most locks agree with within VOTE_MM
# wins; it is refitted on the locks within RIGHT_MM of it, REFITS times.
APART_MM = 5.0
VOTE_MM = 0.5
REFITS = 3
# How long one `pcbv locate` may take, s.
LOCATE_SECONDS = 300.0
# How long one search may take before it is given up on, s.
SEARCH_SECONDS = 600.0
# Wrong locks listed at most in the text report.
LISTED = 15
# The baseline's numbers, kept beside this file.
BASELINE = Path(__file__).with_name("survey_baseline.json")
# Where pcbv is looked for when neither --pcbv nor PCBV names it: the
# sibling pcb-vision repository's builds, release first.
PCBV_SIBLING = Path(__file__).resolve().parents[5] / "pcb-vision" / "target"
# How long a sweep waits at a stop for a picture taken after the head came
# to rest there, s, before it keeps the old one and marks the stop stale.
FRESH_SECONDS = 5.0
# What is kept in a survey folder.
STOPS = "stops.jsonl"
HEADER = "survey.json"
BOARD = "board.kicad_pcb"
TRUTH = "truth.json"
GRADES = "grades"


# --- the fit ---------------------------------------------------------------------------------


def fit_rigid(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """The turn (radians), its matrix and the shift with dst = R src + t,
    least squares over the rows of src and dst (Kabsch in two dimensions)."""
    sc = src.mean(axis=0)
    dc = dst.mean(axis=0)
    h = (src - sc).T @ (dst - dc)
    theta = math.atan2(h[0, 1] - h[1, 0], h[0, 0] + h[1, 1])
    rot = rotation(theta)
    return theta, rot, dc - rot @ sc


def rotation(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s], [s, c]])


def distances(src: np.ndarray, dst: np.ndarray, rot: np.ndarray, shift: np.ndarray) -> np.ndarray:
    """How far each src point mapped by R and t lies from its dst point."""
    return np.hypot(*((src @ rot.T + shift) - dst).T)


@dataclass
class Fit:
    """A map from board points (x, -y) to head places, and how far each
    point it was fitted to lies from it, mm."""

    theta: float
    shift: np.ndarray
    errors: np.ndarray

    @property
    def turn_deg(self) -> float:
        return math.degrees(self.theta)


def robust_fit(src: np.ndarray, dst: np.ndarray, apart: float = APART_MM, vote: float = VOTE_MM, keep: float = RIGHT_MM, refits: int = REFITS) -> Fit:
    """One rigid map through points of which many may be wrong: every pair
    of points whose places lie `apart` or more proposes the map its two
    points fix; the proposal the most points agree with within `vote` wins
    and is refitted on the points within `keep` of the fit before, `refits`
    times. With no pair far enough apart every point starts the fit."""
    n = len(src)
    if n < 2:
        raise ValueError("a fit needs two points at least")
    best_count, use = -1, np.ones(n, dtype=bool)
    for a in range(n):
        for b in range(a + 1, n):
            if math.dist(dst[a], dst[b]) < apart:
                continue
            _, rot, shift = fit_rigid(src[[a, b]], dst[[a, b]])
            agree = distances(src, dst, rot, shift) < vote
            count = int(agree.sum())
            if count > best_count:
                best_count, use = count, agree
    if use.sum() < 2:
        use = np.ones(n, dtype=bool)
    theta, rot, shift = fit_rigid(src[use], dst[use])
    errors = distances(src, dst, rot, shift)
    for _ in range(refits - 1):
        near = errors < keep
        if near.sum() < 2:
            break
        theta, rot, shift = fit_rigid(src[near], dst[near])
        errors = distances(src, dst, rot, shift)
    return Fit(theta, shift, errors)


def fixed_fit(src: np.ndarray, dst: np.ndarray, turn_deg: float, shift: Point) -> Fit:
    """The errors of points against a map given, not fitted."""
    theta = math.radians(turn_deg)
    t = np.array(shift, dtype=float)
    return Fit(theta, t, distances(src, dst, rotation(theta), t))


# --- one picture -----------------------------------------------------------------------------


def board_point(h: list[float], u: float, v: float) -> Point:
    """The board point a row major 3 by 3 map from picture pixels puts
    under pixel (u, v)."""
    w = h[6] * u + h[7] * v + h[8]
    return ((h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w)


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def head_of(stop: dict) -> Point:
    """Where the head stood for a stop: the place read back, else the one
    asked for."""
    joint = stop.get("joint") or {}
    if _number(joint.get("r")) and _number(joint.get("z")):
        return (float(joint["r"]), float(joint["z"]))
    asked = stop.get("asked") or []
    if len(asked) == 2 and all(_number(v) for v in asked):
        return (float(asked[0]), float(asked[1]))
    raise ValueError(f"stop {stop.get('index')} says neither where the head was nor where it was sent")


def row_of(stop: dict, answer: dict) -> dict:
    """A stop and pcbv's answer for its picture as one row of the grade:
    the board point under the picture's center as (x, -y) when locked."""
    row = {"index": stop["index"], "head": list(head_of(stop)), "state": str(answer.get("state", "")).lower(), "seconds": answer.get("seconds")}
    if answer.get("error"):
        row["error"] = answer["error"]
    pose = answer.get("pose") if isinstance(answer.get("pose"), dict) else None
    h = pose.get("image_to_board") if pose else None
    if isinstance(h, list) and len(h) == 9 and all(_number(v) for v in h):
        width = answer.get("width") if _number(answer.get("width")) else 1280.0
        height = answer.get("height") if _number(answer.get("height")) else 720.0
        bx, by = board_point(h, float(width) / 2.0, float(height) / 2.0)
        row.update(
            board=[bx, -by], inliers=pose.get("inliers"), expected=pose.get("expected"), match=round(match_of(pose), 4),
            mm_per_px=pose.get("mm_per_px"), angle=pose.get("angle_deg"), rms=pose.get("rms_mm"),
        )
    return row


# --- the grade -------------------------------------------------------------------------------


def _stats(values) -> dict | None:
    values = np.asarray([float(v) for v in values if _number(v)], dtype=float)
    if not len(values):
        return None
    return {
        "median": float(np.median(values)), "p90": float(np.percentile(values, 90)),
        "min": float(values.min()), "max": float(values.max()),
    }


def grade(rows: list[dict], truth: dict | None = None) -> dict:
    """The numbers of a survey's rows: pictures, locked, right, wrong, the
    right ones' distances from the truth (rms, median, 90%, max), the map
    taken as the truth (fitted, or `truth`'s turn_deg and shift), pcbv's
    own angle, scale, pairs and match share, and each lock's error."""
    locked = [row for row in rows if "board" in row]
    seconds = [row.get("seconds") for row in rows]
    answer: dict = {
        "pictures": len(rows), "locked": len(locked), "right": 0, "wrong": len(locked),
        "errors": sum(1 for row in rows if row.get("error")),
        "seconds_median": (_stats(seconds) or {}).get("median"),
    }
    if truth is not None and len(locked) >= 1:
        src = np.array([row["board"] for row in locked], dtype=float)
        dst = np.array([row["head"] for row in locked], dtype=float)
        fit = fixed_fit(src, dst, float(truth["turn_deg"]), tuple(truth["shift"]))
        answer["truth"] = "given"
    elif len(locked) >= 3:
        src = np.array([row["board"] for row in locked], dtype=float)
        dst = np.array([row["head"] for row in locked], dtype=float)
        fit = robust_fit(src, dst)
        answer["truth"] = "fitted"
    else:
        answer["truth"] = None
        return answer
    for row, error in zip(locked, fit.errors):
        row["error_mm"] = round(float(error), 4)
    right = [row for row in locked if row["error_mm"] < RIGHT_MM]
    wrong = [row for row in locked if row["error_mm"] >= RIGHT_MM]
    errors = np.array([row["error_mm"] for row in right], dtype=float)
    answer.update(
        right=len(right), wrong=len(wrong),
        turn_deg=fit.turn_deg, shift=[float(fit.shift[0]), float(fit.shift[1])],
        right_rms_mm=float(np.sqrt((errors ** 2).mean())) if len(errors) else None,
        right_error=_stats(errors),
    )
    angles = [row["angle"] for row in right if _number(row.get("angle"))]
    if angles:
        # Unwrapped about the first, so 179 and -179 average to 180.
        a = (np.array(angles) - angles[0] + 180.0) % 360.0 - 180.0 + angles[0]
        answer["angle_deg"] = {"mean": float(a.mean()), "sd": float(a.std())}
    scales = [row["mm_per_px"] for row in right if _number(row.get("mm_per_px"))]
    if scales:
        answer["mm_per_px"] = {"mean": float(np.mean(scales)), "sd": float(np.std(scales))}
    answer["inliers_right"] = _stats(row.get("inliers") for row in right)
    answer["match_right"] = _stats(row.get("match") for row in right)
    answer["match_wrong"] = _stats(row.get("match") for row in wrong)
    answer["wrong_locks"] = [
        {k: row.get(k) for k in ("index", "head", "error_mm", "inliers", "expected", "match", "angle", "mm_per_px")}
        for row in sorted(wrong, key=lambda row: -row["error_mm"])
    ]
    return answer


def _f(value, digits: int = 3, unit: str = "") -> str:
    return f"{value:.{digits}f}{unit}" if _number(value) else "-"


def grade_text(answer: dict) -> str:
    """A grade as lines for a terminal or an agent."""
    n, locked = answer["pictures"], answer["locked"]
    lines = [
        f"{n} pictures, {locked} locked ({100.0 * locked / max(n, 1):.0f}%), pcbv median {_f(answer.get('seconds_median'), 2, ' s')} a picture"
        + (f", {answer['errors']} pcbv errors" if answer.get("errors") else "")
    ]
    if answer.get("truth") is None:
        lines.append("too few locks to fit the board to the head's places")
        return "\n".join(lines) + "\n"
    lines.append(f"truth ({answer['truth']}): board turned {answer['turn_deg']:+.3f} deg on the machine, shift ({answer['shift'][0]:.3f}, {answer['shift'][1]:.3f})")
    e = answer.get("right_error") or {}
    lines.append(
        f"right locks {answer['right']} (within {RIGHT_MM:g} mm): rms {_f(answer.get('right_rms_mm'))} mm, median {_f(e.get('median'))},"
        f" 90% {_f(e.get('p90'))}, max {_f(e.get('max'))}"
    )
    lines.append(f"wrong locks {answer['wrong']}")
    if answer.get("angle_deg"):
        lines.append(f"pose angle of the right ones: mean {answer['angle_deg']['mean']:+.3f} deg, sd {answer['angle_deg']['sd']:.3f}")
    if answer.get("mm_per_px"):
        lines.append(f"pose scale of the right ones: mean {answer['mm_per_px']['mean']:.5f} mm/px, sd {answer['mm_per_px']['sd']:.5f}")
    if answer.get("inliers_right"):
        lines.append(f"pairs of the right ones: median {answer['inliers_right']['median']:.0f}, min {answer['inliers_right']['min']:.0f}")
    right, wrong = answer.get("match_right") or {}, answer.get("match_wrong") or {}
    if right or wrong:
        lines.append(
            f"share of the expected features paired: right {_f(right.get('min'), 2)} to {_f(right.get('max'), 2)} (median {_f(right.get('median'), 2)}),"
            f" wrong median {_f(wrong.get('median'), 2)} (90% under {_f(wrong.get('p90'), 2)})"
        )
    for row in answer["wrong_locks"][:LISTED]:
        lines.append(
            f"  {row['index']:4d} head ({row['head'][0]:.1f}, {row['head'][1]:.1f}) off {row['error_mm']:.2f} mm,"
            f" {row.get('inliers')} of {row.get('expected')} paired, angle {_f(row.get('angle'), 1)}"
        )
    if len(answer["wrong_locks"]) > LISTED:
        lines.append(f"  and {len(answer['wrong_locks']) - LISTED} more")
    return "\n".join(lines) + "\n"


# --- pcbv on a survey ------------------------------------------------------------------------


def find_pcbv(program: str | None = None) -> str:
    """The pcbv to grade: the one named, else PCBV, else the sibling
    pcb-vision repository's release build, then its debug build."""
    named = program or os.environ.get("PCBV", "").strip()
    if named:
        if not Path(named).is_file():
            raise ValueError(f"pcbv is not at {named}")
        return named
    for build in ("release", "debug"):
        candidate = PCBV_SIBLING / build / "pcbv"
        if candidate.is_file():
            return str(candidate)
    raise ValueError(f"no pcbv built in {PCBV_SIBLING}: build pcb-vision (mise run build-pcbv), or name one with --pcbv or PCBV")


def pcbv_version(program: str) -> str | None:
    """`pcb-vision <commit>` for a pcbv inside a pcb-vision checkout's
    target folder (git describe, -dirty with changes not committed); None
    for one elsewhere or without git."""
    path = Path(program).resolve()
    if len(path.parents) < 3 or path.parents[1].name != "target":
        return None
    repo = path.parents[2]
    try:
        done = subprocess.run(["git", "-C", str(repo), "describe", "--always", "--dirty"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return f"{repo.name} {done.stdout.strip()}" if done.returncode == 0 and done.stdout.strip() else None


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def cache_key(program_sha: str, board_sha: str, options: list[str]) -> str:
    """A name for the answers of one pcbv build on one board with one set of
    options: a change to any of them grades afresh."""
    text = "\n".join([program_sha, board_sha, *options])
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def locate(program: str, board: Path, picture: Path, options: list[str], timeout: float = LOCATE_SECONDS) -> dict:
    """pcbv's answer for one picture, the spots it found left out, with the
    seconds it took; {"state": "error", "error": ...} when it gave none."""
    started = time.time()
    try:
        done = subprocess.run([program, "locate", str(board), str(picture), "--json", *options], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"state": "error", "error": str(exc), "seconds": round(time.time() - started, 3)}
    try:
        answer = json.loads(done.stdout)
        if not isinstance(answer, dict):
            raise ValueError("not an object")
    except ValueError:
        lines = done.stderr.strip().splitlines()
        answer = {"state": "error", "error": lines[-1] if lines else f"exit {done.returncode}"}
    answer.pop("spots", None)
    answer["seconds"] = round(time.time() - started, 3)
    return answer


def read_stops(folder: Path) -> list[dict]:
    path = folder / STOPS
    if not path.is_file():
        raise ValueError(f"{folder} is not a survey: it has no {STOPS}")
    stops = []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            stop = json.loads(line)
        except ValueError as exc:
            raise ValueError(f"{path} line {number}: {exc}") from exc
        if isinstance(stop, dict) and isinstance(stop.get("index"), int):
            stops.append(stop)
    return stops


def picture_of(folder: Path, index: int) -> Path:
    return folder / f"{index:04d}.jpg"


def answers(folder: Path, board: Path, program: str, options: list[str], cache: Path | None, jobs: int = 1, fresh: bool = False,
            skip: frozenset[int] = frozenset()) -> list[dict]:
    """pcbv on every stop's picture, the answers kept in `cache` as
    locate-NNNN.json and read from there when present (unless `fresh`).
    Stops whose picture is not of their place are left out: the ones the
    sweep marked stale, and those `skip` names by their index."""
    stops = [stop for stop in read_stops(folder) if stop["index"] not in skip and not stop.get("stale")]
    if cache is not None:
        cache.mkdir(parents=True, exist_ok=True)

    def one(stop: dict) -> dict:
        kept = cache / f"locate-{stop['index']:04d}.json" if cache is not None else None
        if kept is not None and kept.is_file() and not fresh:
            try:
                return json.loads(kept.read_text())
            except ValueError:
                pass
        picture = picture_of(folder, stop["index"])
        if not picture.is_file():
            return {"state": "error", "error": f"{picture.name} is missing"}
        answer = locate(program, board, picture, options)
        if kept is not None and answer.get("state") != "error":
            kept.write_text(json.dumps(answer))
        return answer

    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        found = list(pool.map(one, stops))
    return [row_of(stop, answer) for stop, answer in zip(stops, found)]


def default_jobs() -> int:
    return max(1, (os.cpu_count() or 2) // 2)


def survey_folder(reference: str | Path, root: Path) -> Path:
    """A survey by its folder, or by its name under `root`."""
    path = Path(reference)
    if (path / STOPS).is_file():
        return path
    if (root / str(reference) / STOPS).is_file():
        return root / str(reference)
    raise ValueError(f"no survey {reference}: neither a folder holding {STOPS} nor a survey in {root}")


def graded(folder: Path, options: list[str], board: Path | None = None, program: str | None = None, cache: Path | None = None,
           jobs: int = 1, fresh: bool = False, truth: dict | None = None, skip: frozenset[int] = frozenset()) -> dict:
    """A survey graded: pcbv's answers (from the cache for this build, board
    and options when kept) through `grade`; the pcbv and options with it.
    `skip` leaves stops out by their index (pictures known to be stale)."""
    board = board or folder / BOARD
    if not board.is_file():
        raise ValueError(f"{board} is missing: name the survey's board with --board")
    program = find_pcbv(program)
    program_sha, board_sha = sha256_of(Path(program)), sha256_of(board)
    if cache is None:
        cache = folder / GRADES / cache_key(program_sha, board_sha, options)
    rows = answers(folder, board, program, options, cache, jobs, fresh, skip)
    answer = grade(rows, truth)
    answer.update(pcbv=program, pcbv_sha256=program_sha, board_sha256=board_sha, options=options, cache=str(cache))
    (cache / "summary.json").write_text(json.dumps({**answer, "rows": rows}, indent=1))
    return answer


def keep_truth(folder: Path, answer: dict) -> bool:
    """Keeps a fitted grade's map as the survey's truth when more locks
    agree with it than with the truth kept before; says whether it did."""
    if answer.get("truth") != "fitted":
        return False
    path = folder / TRUTH
    try:
        before = json.loads(path.read_text()) if path.is_file() else None
    except ValueError:
        before = None
    if isinstance(before, dict) and isinstance(before.get("right"), int) and before["right"] >= answer["right"]:
        return False
    path.write_text(json.dumps({
        "turn_deg": answer["turn_deg"], "shift": answer["shift"], "right": answer["right"], "locked": answer["locked"],
        "right_rms_mm": answer["right_rms_mm"], "options": answer["options"], "pcbv_sha256": answer["pcbv_sha256"],
        "answers": answer["cache"], "graded": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }, indent=1) + "\n")
    return True


# --- the baseline ----------------------------------------------------------------------------


def read_baseline(path: Path = BASELINE) -> dict:
    return json.loads(path.read_text())


def worse(now: dict, kept: dict, rms_slack: float) -> list[str]:
    """How a grade falls short of the numbers kept: fewer right locks, more
    wrong ones, or the right ones' rms higher by more than `rms_slack`."""
    problems = []
    if now["right"] < kept["right"]:
        problems.append(f"right {now['right']} < {kept['right']}")
    if now["wrong"] > kept["wrong"]:
        problems.append(f"wrong {now['wrong']} > {kept['wrong']}")
    rms = now.get("right_rms_mm")
    if rms is None or rms > kept["right_rms_mm"] + rms_slack:
        problems.append(f"right rms {_f(rms)} > {kept['right_rms_mm']:.3f} + {rms_slack:g} mm")
    return problems


def better(now: dict, kept: dict) -> bool:
    return now["right"] > kept["right"] or now["wrong"] < kept["wrong"] or (now.get("right_rms_mm") or 1e9) < kept["right_rms_mm"] - 1e-4


NUMBERS = ("pictures", "locked", "right", "wrong", "right_rms_mm")


def run_baseline(data: dict, folder: Path, cases: list[str], program: str | None, jobs: int) -> list[dict]:
    """Each case of the baseline graded against the baseline's truth."""
    board = folder / BOARD
    if not board.is_file():
        raise ValueError(f"{board} is missing")
    if sha256_of(board) != data["board_sha256"]:
        raise ValueError(f"{board} is not the board the baseline was measured on")
    count = len(read_stops(folder))
    if count != data["pictures"]:
        raise ValueError(f"{folder} holds {count} stops, the baseline {data['pictures']}")
    results = []
    # Stops whose picture is the stop before's (the camera gave no new one).
    stale = frozenset(int(index) for index in data.get("stale", {}).get("stops", []))
    for name in cases:
        case = data["cases"][name]
        answer = graded(folder, list(case["options"]), board, program, jobs=jobs, truth=data["truth"], skip=stale)
        kept = {k: case[k] for k in NUMBERS}
        problems = worse(answer, kept, float(data.get("rms_slack_mm", 0.0)))
        results.append({
            "case": name, "options": case["options"], "kept": kept, "now": {k: answer.get(k) for k in NUMBERS},
            "worse": problems, "better": not problems and better(answer, kept), "pcbv": answer["pcbv"], "pcbv_sha256": answer["pcbv_sha256"],
            "pcbv_version": pcbv_version(answer["pcbv"]),
        })
    return results


def baseline_text(results: list[dict]) -> str:
    lines = []
    for r in results:
        k, n = r["kept"], r["now"]
        verdict = "WORSE: " + "; ".join(r["worse"]) if r["worse"] else ("better" if r["better"] else "as good")
        lines.append(f"{r['case']} ({' '.join(r['options'])}):")
        lines.append(f"  baseline locked {k['locked']}, right {k['right']}, wrong {k['wrong']}, right rms {k['right_rms_mm']:.3f} mm")
        lines.append(f"  now      locked {n['locked']}, right {n['right']}, wrong {n['wrong']}, right rms {_f(n['right_rms_mm'])} mm: {verdict}")
    if results:
        version = results[0]["pcbv_version"]
        lines.append(f"pcbv {results[0]['pcbv']}" + (f" ({version})" if version else ""))
    if any(r["better"] for r in results) and not any(r["worse"] for r in results):
        lines.append("better than the baseline: --write keeps these numbers as the new one")
    return "\n".join(lines) + "\n"


def write_baseline(path: Path, data: dict, results: list[dict]) -> None:
    for r in results:
        case = data["cases"][r["case"]]
        case.update(r["now"])
        case["right_rms_mm"] = round(case["right_rms_mm"], 4)
        # The build by its commit, or its file's hash: never its path, which
        # means nothing on another machine.
        case["pcbv"] = r["pcbv_version"] or f"a pcbv whose sha256 is {r['pcbv_sha256'][:16]}"
        case["measured"] = time.strftime("%Y-%m-%d")
    path.write_text(json.dumps(data, indent=1) + "\n")


# --- the backend -----------------------------------------------------------------------------


class Backend:
    """A running spinny-web, over its HTTP API."""

    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def raw(self, method: str, path: str, body=None, timeout: float = 120.0) -> bytes:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("detail", detail)
            except (ValueError, AttributeError):
                pass
            raise ValueError(f"{method} {path}: {exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            raise ValueError(f"no backend at {self.url}: {exc.reason}") from exc

    def call(self, method: str, path: str, body=None, timeout: float = 120.0):
        return json.loads(self.raw(method, path, body, timeout) or b"null")

    def picture(self, path: str, timeout: float = 120.0) -> tuple[bytes, float | None]:
        """A camera's picture and its age, s, as the backend's X-Frame-Age-Ms
        header says it; None from a backend that sends none."""
        request = urllib.request.Request(self.url + path, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                age = response.headers.get("X-Frame-Age-Ms")
                data = response.read()
        except urllib.error.HTTPError as exc:
            raise ValueError(f"GET {path}: {exc.code} {exc.read().decode(errors='replace')}") from exc
        except urllib.error.URLError as exc:
            raise ValueError(f"no backend at {self.url}: {exc.reason}") from exc
        try:
            return data, float(age) / 1000.0 if age is not None else None
        except ValueError:
            return data, None

    def goto(self, place: Point) -> None:
        self.call("POST", "/api/goto", {"kind": "joint", "r": round(place[0], 3), "z": round(place[1], 3)})

    def joint(self) -> dict:
        return (self.call("GET", "/api/state").get("machine") or {}).get("joint") or {}

    def placing(self) -> dict:
        return self.call("GET", "/api/pnp/placing")


def grid(box: tuple[float, float, float, float], step: Point) -> list[Point]:
    """The head places of a sweep over the box x0, y0, x1, y1 at the step in
    X and Y, row by row along X, every other row backward so the head never
    runs back across the box."""
    x0, y0, x1, y1 = box
    sx, sy = step
    if sx <= 0 or sy <= 0:
        raise ValueError("the steps must be over 0")
    if x1 < x0 or y1 < y0:
        raise ValueError("the box is x0,y0,x1,y1 with x0 <= x1 and y0 <= y1")
    xs = [x0 + i * sx for i in range(int(round((x1 - x0) / sx)) + 1)]
    ys = [y0 + j * sy for j in range(int(round((y1 - y0) / sy)) + 1)]
    places = []
    for j, y in enumerate(ys):
        places.extend((x, y) for x in (xs if j % 2 == 0 else reversed(xs)))
    return places


def sweep(backend: Backend, folder: Path, places: list[Point], settle: float, width: int, header: dict, say=print) -> int:
    """The top camera's picture at each place, kept with the place read
    back; the stops kept."""
    placing = backend.placing()
    if not placing.get("connected"):
        raise ValueError(f"the backend at {backend.url} has no G-code machine connected")
    top = {k: v for k, v in (placing.get("top") or {}).items() if k != "board_look"}
    folder.mkdir(parents=True, exist_ok=True)
    (folder / HEADER).write_text(json.dumps({**header, "machine": placing.get("name"), "top": top, "stops": len(places)}, indent=1) + "\n")
    done = 0
    with open(folder / STOPS, "a") as log:
        for index, place in enumerate(places):
            started = time.time()
            backend.goto(place)
            joint = backend.joint()
            rested = time.monotonic()
            time.sleep(settle)
            # The picture must have been taken here: a camera that delivers
            # nothing for a moment answers its last picture again (the
            # first survey kept the stop before's picture at 2 of its 169
            # stops, and both were graded as wrong locks).
            path = f"/api/pnp/top/frame.jpg?width={width}&overlay=0"
            picture, age = backend.picture(path)
            while age is not None and time.monotonic() - age < rested and time.monotonic() - rested < settle + FRESH_SECONDS:
                time.sleep(0.1)
                picture, age = backend.picture(path)
            stale = age is not None and time.monotonic() - age < rested
            picture_of(folder, index).write_bytes(picture)
            placing = backend.placing()
            look = (placing.get("top") or {}).get("board_look") or {}
            line = {
                "index": index, "asked": list(place), "joint": joint, "position": placing.get("position") or {},
                "time": time.time(), "move_s": round(time.time() - started, 3),
                "look": {k: look.get(k) for k in ("pose", "locked", "looks", "found", "estimate")},
            }
            if age is not None:
                line["age_ms"] = round(age * 1000.0, 1)
            if stale:
                line["stale"] = True
                say(f"{index:4d}: no picture taken after the head came to rest within {FRESH_SECONDS:g} s; the old one is kept and the stop marked stale")
            log.write(json.dumps(line) + "\n")
            log.flush()
            done += 1
            say(f"{index:4d} at ({place[0]:7.2f}, {place[1]:7.2f}) read {joint.get('r')}, {joint.get('z')}, look {look.get('pose')}")
    return done


# --- the searches ----------------------------------------------------------------------------


@dataclass
class Truth:
    """Where a board lies, as a search's estimate says it: the machine
    place of the board's middle and its turn, degrees."""

    center: Point
    turn_deg: float


def middle_truth(survey_truth: dict, header: dict) -> Truth | None:
    """A survey's truth (board to head) as the place of the board's middle
    that a search record's header says: its map from board points to the
    job's frame, the middle in that frame and the camera's offset from the
    head, which takes head places to the machine places of the pictures'
    centers. None when the header lacks any of them."""
    rows, middle = header.get("board_to_job"), header.get("middle")
    offset = (header.get("picture") or {}).get("offset") or [0.0, 0.0]
    try:
        (a, b, c), (d, e, f) = rows
        mx, my = float(middle[0]), float(middle[1])
        ox, oy = float(offset[0]), float(offset[1])
    except (TypeError, ValueError):
        return None
    det = a * e - b * d
    if abs(det) < 1e-12:
        return None
    # The middle back in KiCad board points, then as the truth's (x, -y).
    x, y = mx - c, my - f
    bx, by = (e * x - b * y) / det, (-d * x + a * y) / det
    theta = math.radians(float(survey_truth["turn_deg"]))
    hx, hy = rotation(theta) @ np.array([bx, -by]) + np.array(survey_truth["shift"], dtype=float)
    # The job frame's x axis in the truth's frame turns the job by as much
    # again (none for a front side, whose job frame is (x, -y) shifted).
    ux, uy = e / det, -d / det
    turn = math.degrees(theta) + math.degrees(math.atan2(-uy, ux))
    return Truth((float(hx) + ox, float(hy) + oy), (turn + 180.0) % 360.0 - 180.0)


def header_of(line: dict, records: Path | None) -> dict:
    """A search line's record header: kept in the line, else read from the
    search records' folder by the record's id ({} when neither has it)."""
    header = line.get("header") or {}
    if header.get("board_to_job") is not None or records is None:
        return header
    record_id = (line.get("record") or {}).get("id")
    path = records / str(record_id) / "record.json" if record_id else None
    if path is None or not path.is_file():
        return header
    try:
        return json.loads(path.read_text())
    except ValueError:
        return header


def given_truth(text: str) -> Truth:
    try:
        x, y, degrees = (float(part) for part in text.split(","))
    except ValueError as exc:
        raise ValueError("the truth is X,Y,DEG: the board's middle on the machine, mm, and its turn, degrees") from exc
    return Truth((x, y), degrees)


def grade_search(line: dict, truth: Truth | None) -> dict:
    """One search's line: how it ended, its time and stops, where it put the
    board and how far that is from the truth (mm, degrees)."""
    record = line.get("record") or {}
    estimate = record.get("estimate") or {}
    center = estimate.get("center")
    row = {
        "start": line.get("start"), "result": record.get("result"), "state": (line.get("routine") or {}).get("state"),
        "seconds": line.get("seconds"), "visited": record.get("visited"), "stops": record.get("stops"),
        "center": center, "turn_deg": estimate.get("rotation"), "match": estimate.get("match"), "rival": estimate.get("rival"),
        "rms": estimate.get("rms"), "record": record.get("id"),
    }
    if truth is not None and isinstance(center, list) and len(center) == 2:
        row["off_mm"] = round(math.dist(center, truth.center), 4)
        if _number(estimate.get("rotation")):
            row["off_deg"] = round((float(estimate["rotation"]) - truth.turn_deg + 180.0) % 360.0 - 180.0, 4)
    return row


def searches_summary(rows: list[dict]) -> dict:
    found = [row for row in rows if row["result"] == "found"]
    right = [row for row in found if _number(row.get("off_mm")) and row["off_mm"] < RIGHT_MM]
    wrong = [row for row in found if _number(row.get("off_mm")) and row["off_mm"] >= RIGHT_MM]
    return {
        "searches": len(rows), "found": len(found), "right": len(right), "wrong": len(wrong),
        "seconds": _stats(row.get("seconds") for row in rows), "off_mm": _stats(row.get("off_mm") for row in right),
        "off_deg": _stats(abs(row["off_deg"]) for row in right if _number(row.get("off_deg"))),
    }


def searches_text(rows: list[dict], summary: dict, truth: Truth | None) -> str:
    lines = []
    if truth is not None:
        lines.append(f"truth: the board's middle at ({truth.center[0]:.3f}, {truth.center[1]:.3f}), turned {truth.turn_deg:+.3f} deg")
    for row in rows:
        start = row["start"] or ["?", "?"]
        where = f", center ({row['center'][0]:.3f}, {row['center'][1]:.3f}) turned {_f(row['turn_deg'], 3)}" if row.get("center") else ""
        off = f", off {_f(row.get('off_mm'))} mm {_f(row.get('off_deg'), 3)} deg" if "off_mm" in row else ""
        lines.append(
            f"start ({start[0]}, {start[1]}): {row['result']} ({row['state']}) in {_f(row['seconds'], 1, ' s')},"
            f" {row['visited']}/{row['stops']} stops{where}{off}, match {_f(row['match'], 2)}, rival {_f(row['rival'], 2)}, record {row['record']}"
        )
    s = summary
    lines.append(
        f"{s['searches']} searches, {s['found']} found: {s['right']} right (within {RIGHT_MM:g} mm), {s['wrong']} wrong;"
        f" median {_f((s['seconds'] or {}).get('median'), 1, ' s')}, right ones median {_f((s['off_mm'] or {}).get('median'))} mm"
        f" and {_f((s['off_deg'] or {}).get('median'), 3)} deg off"
    )
    return "\n".join(lines) + "\n"


def search_once(backend: Backend, start: Point, box: list[float] | None, timeout: float = SEARCH_SECONDS) -> dict:
    """One search from `start`: the head goes there, the look's guesses are
    forgotten, the search runs to its end; its line, with the record's map
    from the board to the job's frame, middle and camera offset."""
    backend.goto(start)
    before = {line["id"] for line in backend.call("GET", "/api/searchlog?limit=50&camera=top")["records"]}
    backend.call("POST", "/api/pnp/top/board/forget")
    time.sleep(1.0)
    started = time.time()
    backend.call("POST", "/api/pnp/top/search", {"box": box} if box is not None else {})
    routine, top = {}, {}
    while time.time() - started < timeout:
        time.sleep(1.0)
        top = backend.placing().get("top") or {}
        routine = top.get("routine") or {}
        if routine.get("state") in ("done", "error", "stopped"):
            break
    look = top.get("board_look") or {}
    record, header = None, {}
    for line in backend.call("GET", "/api/searchlog?limit=50&camera=top")["records"]:
        if line["id"] not in before and line.get("kind") in ("search", "scan"):
            record = line
            header = backend.call("GET", f"/api/searchlog/{line['id']}").get("record") or {}
            break
    return {
        "start": list(start), "box": box, "seconds": round(time.time() - started, 1), "routine": routine, "record": record,
        "header": {k: header.get(k) for k in ("board_to_job", "middle", "picture", "board")},
        "look": {k: look.get(k) for k in ("found", "estimate", "ambiguous", "sessions", "guesses", "method")},
        "end": backend.joint(),
    }


# --- the command line ------------------------------------------------------------------------


def default_dir() -> Path:
    """The surveys: var/surveys under the spinny home."""
    from spinny_laser import home

    return home.root() / "var" / "surveys"


def _numbers(text: str, count: int | None = None) -> tuple[float, ...]:
    try:
        values = tuple(float(part) for part in text.split(","))
    except ValueError as exc:
        raise ValueError(f"{text!r} is not numbers separated by commas") from exc
    if count is not None and len(values) != count:
        raise ValueError(f"{text!r} is not {count} numbers")
    return values


def _truth_for(args, folder_root: Path) -> dict | None:
    """--survey's truth.json, None without --survey."""
    if not args.survey:
        return None
    folder = survey_folder(args.survey, folder_root)
    path = folder / TRUTH
    if not path.is_file():
        raise ValueError(f"{folder} has no {TRUTH} yet: grade it first (spinny-survey grade {folder.name})")
    return json.loads(path.read_text())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spinny-survey", description="Pictures of a board where the head's place is known: take them, grade pcbv on them, keep pcbv above the baseline, grade the backend's searches.")
    parser.add_argument("--dir", type=Path, default=None, help="the surveys' folder (default: var/surveys under the spinny home)")
    commands = parser.add_subparsers(dest="command", required=True)

    sweeping = commands.add_parser("sweep", help="the top camera over a grid of head places through a running backend, a picture at each")
    sweeping.add_argument("box", help="X0,Y0,X1,Y1: the head places the grid spans, mm")
    sweeping.add_argument("--step", default="8,7.5", help="SX,SY or S: the grid's steps, mm (default %(default)s)")
    sweeping.add_argument("--name", help="the survey's folder under --dir (default: the date and time)")
    sweeping.add_argument("--board", type=Path, help="the board's .kicad_pcb, kept in the survey for grading")
    sweeping.add_argument("--settle", type=float, default=0.5, help="seconds from the move's end to the picture (default %(default)s)")
    sweeping.add_argument("--width", type=int, default=1280, help="the pictures' width at most, px (default %(default)s): the camera's own size when smaller")
    sweeping.add_argument("--url", default=DEFAULT_URL, help="the backend (default %(default)s)")

    grading = commands.add_parser(
        "grade", help="pcbv on every picture of a survey, graded by one robust fit of the board to the head's places",
        epilog="Options for pcbv locate go last, after --: spinny-survey grade NAME -- --finish masked --scale 0.0129:0.0194",
    )
    grading.add_argument("survey", help="a survey's name under --dir, or its folder")
    grading.add_argument("--board", type=Path, help="the board (default: the survey's board.kicad_pcb)")
    grading.add_argument("--pcbv", metavar="PROGRAM", help="the pcbv to grade (default: PCBV, else the sibling pcb-vision's release build)")
    grading.add_argument("--jobs", type=int, default=default_jobs(), help="pictures located at once (default %(default)s)")
    grading.add_argument("--cache", type=Path, help="where pcbv's answers are kept and read (default: grades/KEY in the survey, KEY from the pcbv build, the board and the options)")
    grading.add_argument("--fresh", action="store_true", help="run pcbv on every picture even when its answer is kept")
    grading.add_argument("--json", action="store_true", help="print the grade as JSON")

    base = commands.add_parser("baseline", help="the battery card sweep graded against the numbers kept; exit 1 when pcbv does worse")
    base.add_argument("--survey", type=Path, help="the sweep's folder (default: the baseline's survey under --dir)")
    base.add_argument("--case", default="scale", help="which of the baseline's option sets, or all (default %(default)s)")
    base.add_argument("--pcbv", metavar="PROGRAM", help="the pcbv to grade (default: PCBV, else the sibling pcb-vision's release build)")
    base.add_argument("--jobs", type=int, default=default_jobs(), help="pictures located at once (default %(default)s)")
    base.add_argument("--file", type=Path, default=BASELINE, help="the baseline's numbers (default: survey_baseline.json beside this program)")
    base.add_argument("--write", action="store_true", help="keep the numbers measured now as the baseline, worse ones too (a trade-off taken on purpose); the exit status is then 0")
    base.add_argument("--json", action="store_true", help="print the comparison as JSON")

    searching = commands.add_parser("searches", help="the backend's board search from several start places, graded against a survey's truth")
    searching.add_argument("starts", nargs="*", help="X,Y head places to start from")
    searching.add_argument("--box", help="X0,Y0,X1,Y1: where the picture's center searches (default: the backend's, about the start)")
    searching.add_argument("--method", choices=("vote", "posterior"), help="set the top camera's look method first (it stays set)")
    searching.add_argument("--survey", help="grade against this survey's truth.json (written by grade)")
    searching.add_argument("--truth", help="X,Y,DEG: grade against the board's middle at X,Y on the machine turned DEG")
    searching.add_argument("--from", dest="source", type=Path, help="grade the searches kept in this file instead of running any")
    searching.add_argument("--records", type=Path, help="the search records' folder, for searches kept without their record's frame (default: var/searchlog under the spinny home)")
    searching.add_argument("--out", type=Path, help="where the searches are kept (default: searches-DATE-TIME.jsonl under --dir)")
    searching.add_argument("--timeout", type=float, default=SEARCH_SECONDS, help="seconds one search may take (default %(default)s)")
    searching.add_argument("--url", default=DEFAULT_URL, help="the backend (default %(default)s)")
    searching.add_argument("--json", action="store_true", help="print the grade as JSON")

    # Everything after -- is pcbv's: split off before argparse, which would
    # not give positionals after options to a list taken before them.
    argv = list(sys.argv[1:] if argv is None else argv)
    passed: list[str] = []
    if "--" in argv:
        cut = argv.index("--")
        argv, passed = argv[:cut], argv[cut + 1:]
    args = parser.parse_args(argv)
    if passed and args.command != "grade":
        parser.error("only grade takes options for pcbv, after --")
    root = args.dir if args.dir is not None else default_dir()
    try:
        if args.command == "sweep":
            box = _numbers(args.box, 4)
            step = _numbers(args.step)
            if len(step) == 1:
                step = (step[0], step[0])
            if len(step) != 2:
                raise ValueError("the step is SX,SY or S")
            places = grid(box, (step[0], step[1]))  # type: ignore[arg-type]
            folder = root / (args.name or time.strftime("%Y%m%d-%H%M%S"))
            if (folder / STOPS).exists():
                raise ValueError(f"{folder} already holds a survey: give another --name")
            if args.board is not None and not args.board.is_file():
                raise ValueError(f"no board at {args.board}")
            print(f"{len(places)} stops into {folder}", flush=True)
            header = {
                "version": 1, "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "url": args.url, "box": list(box), "step": list(step),
                "settle": args.settle, "width": args.width, "board": args.board.name if args.board else None,
            }
            if args.board is not None:
                folder.mkdir(parents=True, exist_ok=True)
                (folder / BOARD).write_bytes(args.board.read_bytes())
            try:
                done = sweep(Backend(args.url), folder, places, args.settle, args.width, header, lambda text: print(text, flush=True))
            except KeyboardInterrupt:
                print("stopped: the stops so far are kept", file=sys.stderr)
                return 130
            print(f"{done} pictures in {folder}")
            return 0

        if args.command == "grade":
            folder = survey_folder(args.survey, root)
            answer = graded(folder, passed, args.board, args.pcbv, args.cache, args.jobs, args.fresh)
            kept = keep_truth(folder, answer)
            if args.json:
                print(json.dumps(answer, indent=1))
            else:
                sys.stdout.write(grade_text(answer))
                print(f"answers in {answer['cache']}" + (f"; the fit kept as {folder / TRUTH}" if kept else ""))
            return 0

        if args.command == "baseline":
            data = read_baseline(args.file)
            folder = args.survey if args.survey is not None else root / data["survey"]
            if not (folder / STOPS).is_file():
                raise ValueError(f"the baseline's pictures are not in {folder}: copy the survey folder {data['survey']} there from the machine that took it, or give --survey")
            cases = list(data["cases"]) if args.case == "all" else [args.case]
            for name in cases:
                if name not in data["cases"]:
                    raise ValueError(f"no case {name!r}: the baseline has {', '.join(data['cases'])}")
            results = run_baseline(data, folder, cases, args.pcbv, args.jobs)
            if args.write:
                write_baseline(args.file, data, results)
            if args.json:
                print(json.dumps(results, indent=1))
            else:
                sys.stdout.write(baseline_text(results))
                if args.write:
                    print(f"kept in {args.file}")
            return 1 if any(r["worse"] for r in results) and not args.write else 0

        # searches
        if args.survey and args.truth:
            raise ValueError("--survey or --truth, not both")
        survey_truth = _truth_for(args, root)
        given = given_truth(args.truth) if args.truth else None
        if args.source is not None:
            if args.starts:
                raise ValueError("--from grades searches kept; it takes no start places")
            lines = [json.loads(line) for line in args.source.read_text().splitlines() if line.strip()]
        else:
            if not args.starts:
                raise ValueError("give the start places, X,Y each, or --from FILE")
            starts = [_numbers(text, 2) for text in args.starts]
            box = list(_numbers(args.box, 4)) if args.box else None
            backend = Backend(args.url)
            if not backend.placing().get("connected"):
                raise ValueError(f"the backend at {args.url} has no G-code machine connected")
            if args.method:
                backend.call("PUT", "/api/pnp/top", {"look_method": args.method})
            out = args.out or root / f"searches-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
            out.parent.mkdir(parents=True, exist_ok=True)
            lines = []
            with open(out, "a") as log:
                for start in starts:
                    line = search_once(backend, (start[0], start[1]), box, args.timeout)
                    log.write(json.dumps(line) + "\n")
                    log.flush()
                    lines.append(line)
                    record = line["record"] or {}
                    print(f"start ({start[0]:.1f}, {start[1]:.1f}): {line['routine'].get('state')} in {line['seconds']} s, {record.get('result')}, record {record.get('id')}", flush=True)
            print(f"kept in {out}")
        rows = []
        truth = given
        records = args.records if args.records is not None else root.parent / "searchlog"
        for line in lines:
            if survey_truth is not None:
                truth = middle_truth(survey_truth, header_of(line, records))
            rows.append(grade_search(line, truth))
        summary = searches_summary(rows)
        if args.json:
            print(json.dumps({"rows": rows, "summary": summary}, indent=1))
        else:
            sys.stdout.write(searches_text(rows, summary, truth))
        return 0
    except ValueError as exc:
        print(f"spinny-survey: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
