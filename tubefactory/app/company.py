"""Company office: activity feed of the agents, spending per agent, the
analyst's reports and the director's decisions (data/company.json)."""
import contextvars
import datetime as dt
import json
import threading
import time
from contextlib import contextmanager

from .config import DATA

_lock = threading.RLock()
# Where the cost of the current work is also booked (e.g. the project being made).
_sink = contextvars.ContextVar("cost_sink", default=None)
_FILE = DATA / "company.json"


def _load():
    if _FILE.exists():
        try:
            return json.loads(_FILE.read_text("utf-8"))
        except json.JSONDecodeError:
            pass
    return {"feed": [], "costs": {}, "calls": {}, "reports": {}, "decisions": {}}


def _save(data):
    tmp = _FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(_FILE)


def feed(role, text, project_id=None, channel_id=None):
    with _lock:
        data = _load()
        data["feed"].insert(0, {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "role": role, "text": text,
                                "project_id": project_id, "channel_id": channel_id})
        del data["feed"][500:]
        _save(data)


def add_cost(role, cost):
    with _lock:
        data = _load()
        data["costs"][role] = round(data["costs"].get(role, 0) + (cost or 0), 6)
        data["calls"][role] = data["calls"].get(role, 0) + 1
        _save(data)
    sink = _sink.get()
    if sink:
        sink(role, cost or 0)


@contextmanager
def booking(sink):
    """Inside this block every OpenRouter cost is also passed to sink(role, cost).
    Worker threads need contextvars.copy_context().run to inherit it."""
    token = _sink.set(sink)
    try:
        yield
    finally:
        _sink.reset(token)


def set_report(channel_id, report):
    with _lock:
        data = _load()
        data["reports"][channel_id] = {**report, "time": time.strftime("%Y-%m-%d %H:%M:%S")}
        _save(data)


def set_decision(channel_id, decision):
    with _lock:
        data = _load()
        data["decisions"].setdefault(channel_id, []).insert(0, {**decision, "time": time.strftime("%Y-%m-%d %H:%M:%S")})
        del data["decisions"][channel_id][30:]
        _save(data)


def get():
    with _lock:
        return _load()


def report(channel_id):
    return get()["reports"].get(channel_id)


def next_publish_time(hours, already_today=0):
    """UTC RFC3339 time of the next free slot among local `hours`."""
    hours = sorted(int(h) for h in (hours or [15]))
    now = dt.datetime.now().astimezone()
    slot = hours[already_today % len(hours)]
    when = now.replace(hour=slot, minute=0, second=0, microsecond=0) + \
        dt.timedelta(days=already_today // len(hours))
    if when <= now + dt.timedelta(minutes=30):
        when += dt.timedelta(days=1)
    return when.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
