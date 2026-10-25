"""Background job queue and the multi-channel autopilot.

One worker runs projects one after another (image generation inside a
project is parallel). The autopilot checks every channel with autopilot on
once a minute and, when the channel has fewer videos today than
videos_per_day, picks a fresh idea for its niche, creates a project and
queues the full pipeline including a scheduled YouTube upload.
"""
import datetime as dt
import threading
import time
import traceback
import uuid

from . import pipeline, scenarist, storage, youtube

_lock = threading.Lock()
_queue = []      # pending jobs
_history = []    # finished jobs, newest first
_current = None
_wake = threading.Event()


def enqueue(project_id, stage="all", force=False):
    job = {"id": uuid.uuid4().hex[:8], "project_id": project_id, "stage": stage,
           "force": force, "status": "queued", "error": None,
           "queued_at": storage.now(), "started_at": None, "finished_at": None}
    with _lock:
        _queue.append(job)
    _wake.set()
    return job


def cancel(project_id):
    with _lock:
        _queue[:] = [j for j in _queue if j["project_id"] != project_id]
        running = _current and _current["project_id"] == project_id
    if running:
        pipeline.cancel(project_id)


def is_busy(project_id):
    with _lock:
        return any(j["project_id"] == project_id for j in _queue) or \
            bool(_current and _current["project_id"] == project_id)


def snapshot():
    with _lock:
        return {"current": _current, "queued": list(_queue), "history": _history[:50]}


def _worker():
    global _current
    while True:
        _wake.wait(5)
        _wake.clear()
        while True:
            with _lock:
                if not _queue:
                    break
                job = _queue.pop(0)
                job.update(status="running", started_at=storage.now())
                _current = job
            pipeline._cancel.discard(job["project_id"])
            try:
                pipeline.run(job["project_id"], job["stage"], job["force"])
                job["status"] = "done"
            except Exception as e:
                job.update(status="error", error=str(e)[:500])
                traceback.print_exc()
            job["finished_at"] = storage.now()
            with _lock:
                _current = None
                _history.insert(0, job)
                del _history[200:]


# ---------- autopilot ----------

def _next_publish_time(channel, already_today):
    """UTC RFC3339 time for the next free slot in channel['publish_hours'] (local hours)."""
    hours = sorted(channel.get("publish_hours") or [15])
    now = dt.datetime.now().astimezone()
    slot = hours[already_today % len(hours)]
    day_offset = already_today // len(hours)
    when = now.replace(hour=int(slot), minute=0, second=0, microsecond=0) + dt.timedelta(days=day_offset)
    if when <= now + dt.timedelta(minutes=30):
        when += dt.timedelta(days=1)
    return when.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def autopilot_tick():
    today = time.strftime("%Y-%m-%d")
    projects = storage.list_projects()
    for ch in storage.list_channels():
        if not ch.get("autopilot") or not ch.get("niche"):
            continue
        mine = [p for p in projects if p["channel_id"] == ch["id"]]
        made_today = [p for p in mine if p["created_at"].startswith(today)]
        if len(made_today) >= int(ch.get("videos_per_day") or 1):
            continue
        if any(is_busy(p["id"]) for p in mine):
            continue  # one video per channel at a time
        titles = [p["title"] for p in mine]
        result = scenarist.ideas_for_niche(ch["niche"], count=3, avoid=titles)
        ideas = [i for i in result.get("ideas", []) if i.get("title") not in titles]
        if not ideas:
            continue
        idea = ideas[0]
        connected = youtube.is_connected(ch["id"])
        project = pipeline.create_from_idea(
            f"{idea['title']}. {idea.get('idea', '')}", ch["id"],
            title=idea["title"], style=ch.get("style") or result.get("style", ""),
            auto_upload=connected,
            publish_at=_next_publish_time(ch, len(made_today)) if connected else None)
        storage.log(project["id"], f"Автопилот: идея «{idea['title']}»")
        enqueue(project["id"])


def _autopilot():
    while True:
        try:
            autopilot_tick()
        except Exception:
            traceback.print_exc()
        time.sleep(60)


def start():
    threading.Thread(target=_worker, daemon=True, name="worker").start()
    threading.Thread(target=_autopilot, daemon=True, name="autopilot").start()
