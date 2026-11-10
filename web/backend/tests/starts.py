"""Starting a run or a probing the way the backend does: the machine is
claimed first, a run's restart count taken with the claim, and the claim
given back once the start has taken it over or refused."""

from __future__ import annotations

from spinny_web.prober import Prober
from spinny_web.runner import Runner


def start_run(runner: Runner, job, link, streamer, compensation=None, **options) -> dict:
    runner.reserve(link)
    try:
        return runner.start(job, link, streamer, compensation, link.restarts if link is not None else None, **options)
    finally:
        runner.release()


def start_probe(prober: Prober, settings, link, streamer, **options) -> dict:
    prober.reserve(link)
    try:
        return prober.start(settings, link, streamer, **options)
    finally:
        prober.release()
