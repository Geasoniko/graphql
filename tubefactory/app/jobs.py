"""Background job queue and the company autopilot.

One worker runs projects one after another (image generation inside a
project is parallel). Once a minute the autopilot: lets the channel analyst
refresh stats of every connected channel (every 6 h), and for channels with
autopilot on that made fewer videos today than videos_per_day holds a
planning meeting — the researcher brings trending ideas, the director picks
one, and the full pipeline is queued with an upload at the best hour.
"""
import threading
import time
import traceback
import uuid

from . import analytics, company, pipeline, scenarist, storage, team, youtube

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
                with _lock:
                    # Later jobs of this project build on this one (re-voice, then re-render): drop them.
                    _queue[:] = [j for j in _queue if j["project_id"] != job["project_id"]]
            job["finished_at"] = storage.now()
            with _lock:
                _current = None
                _history.insert(0, job)
                del _history[200:]


# ---------- director + autopilot ----------

def plan_video(channel_id, start=True, ideas=None, scene_count=None):
    """Planning meeting: researcher brings ideas, director picks one, the team starts.
    What the meeting cost is booked to the project it creates."""
    spent = []
    with company.booking(lambda role, cost: spent.append((role, cost))):
        project = _plan_video(channel_id, ideas, scene_count)
    for role, cost in spent:
        storage.add_cost(project["id"], role, cost)
    if start:
        enqueue(project["id"])
    return storage.get_project(project["id"])


def _plan_video(channel_id, ideas, scene_count=None):
    ch = storage.get_channel(channel_id)
    projects = [p for p in storage.list_projects() if p["channel_id"] == channel_id]
    titles = [p["title"] for p in projects]
    if not ideas:
        company.feed("researcher", f"ищу тренды для «{ch['name']}»…", channel_id=channel_id)
        found = scenarist.ideas_for_niche(ch.get("niche") or ch["name"], count=6, avoid=titles,
                                          brief=team.channel_brief(ch, company.report(channel_id)))
        ideas = [i for i in found.get("ideas", []) if i.get("title") not in titles]
        company.feed("researcher", "идеи: " + "; ".join(i.get("title", "") for i in ideas[:6]),
                     channel_id=channel_id)
    if not ideas:
        raise RuntimeError("Исследователь не нашёл новых идей")
    company.feed("director", f"выбираю, что снимать на «{ch['name']}»…", channel_id=channel_id)
    plan = team.director_plan(ch, ideas, company.report(channel_id), analytics.recent_for_director(channel_id))
    company.set_decision(channel_id, plan)
    company.feed("director", f"снимаем «{plan.get('title')}». {plan.get('decision', '')}", channel_id=channel_id)
    idea = f"{plan.get('title')}. {plan.get('idea', '')}"
    if plan.get("notes_for_team"):
        idea += f"\n\nDirector's notes: {plan['notes_for_team']}"
    connected = youtube.is_connected(channel_id)
    hours = ch.get("best_hours") or ch.get("publish_hours") or [15]
    made_today = len([p for p in projects if p["created_at"].startswith(time.strftime("%Y-%m-%d"))])
    project = pipeline.create_from_idea(
        idea, channel_id, title=plan.get("title"),
        scene_count=scene_count or plan.get("scene_count") or ch.get("scene_count"),
        auto_upload=connected and bool(ch.get("autopilot")),
        publish_at=company.next_publish_time(hours, made_today) if connected and ch.get("autopilot") else None)
    with storage.edit_project(project["id"]) as p:
        p["director"] = plan
    return project


_last_analysis = {}
ANALYZE_EVERY = 6 * 3600


def autopilot_tick():
    today = time.strftime("%Y-%m-%d")
    projects = storage.list_projects()
    for ch in storage.list_channels():
        cid = ch["id"]
        if youtube.is_connected(cid) and time.time() - _last_analysis.get(cid, 0) > ANALYZE_EVERY:
            _last_analysis[cid] = time.time()
            try:
                analytics.analyze_channel(cid)
            except Exception as e:
                company.feed("analyst", f"не смог собрать статистику: {e}", channel_id=cid)
        if not ch.get("autopilot") or not ch.get("niche"):
            continue
        mine = [p for p in projects if p["channel_id"] == cid]
        made_today = [p for p in mine if p["created_at"].startswith(today)]
        if len(made_today) >= int(ch.get("videos_per_day") or 1):
            continue
        if any(is_busy(p["id"]) for p in mine):
            continue  # one video per channel at a time
        try:
            plan_video(cid)
        except Exception as e:
            company.feed("director", f"планёрка по «{ch['name']}» сорвалась: {e}", channel_id=cid)


def _autopilot():
    while True:
        try:
            autopilot_tick()
        except Exception:
            traceback.print_exc()
        time.sleep(60)


def reset_interrupted():
    """Stages left "running" by a previous run that was closed mid-work.
    Nothing is running yet at startup, so mark them interrupted; the next
    "Продолжить генерацию" resumes from there."""
    for p in storage.list_projects():
        stuck = [k for k, st in p["stages"].items() if st["status"] == "running"]
        if not stuck:
            continue
        with storage.edit_project(p["id"]) as pp:
            for k in stuck:
                pp["stages"][k].update(status="error", error="прервано: софт был закрыт во время работы. "
                                                               "Нажмите «Продолжить генерацию».")
            for s in (pp.get("script") or {}).get("scenes", []):
                if s.get("status") == "running":
                    s["status"] = "idle"
        storage.log(p["id"], f"Этап прерван закрытием софта: {', '.join(stuck)}")


def start():
    reset_interrupted()
    threading.Thread(target=_worker, daemon=True, name="worker").start()
    threading.Thread(target=_autopilot, daemon=True, name="autopilot").start()
