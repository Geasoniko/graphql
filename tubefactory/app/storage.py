"""JSON-on-disk storage for projects and channels.

Each project is a folder data/projects/<id>/ holding project.json plus its
images, audio and rendered video. Channels are one file, channels.json.
"""
import json
import shutil
import threading
import time
import uuid
from contextlib import contextmanager

from .config import CHANNELS_DIR, DATA, PROJECTS

_lock = threading.RLock()
_CHANNELS_FILE = DATA / "channels.json"

STAGES = ["script", "characters", "audio", "images", "thumbnail", "render", "upload"]


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def new_id():
    return time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]


def _read(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text("utf-8"))


def _write(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


# ---------- projects ----------

def project_dir(pid):
    return PROJECTS / pid


def create_project(**fields):
    pid = new_id()
    d = project_dir(pid)
    for sub in ("images", "audio", "clips", "characters", "output"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    project = {
        "id": pid,
        "title": fields.get("title") or fields.get("idea", "")[:80] or "Новый проект",
        "channel_id": fields.get("channel_id"),
        "idea": fields.get("idea", ""),
        "reference": fields.get("reference", ""),
        "language": fields.get("language", "English"),
        "style": fields.get("style", ""),
        "voice": fields.get("voice", "en-US-AndrewNeural"),
        "scene_count": int(fields.get("scene_count") or 20),
        "pacing": fields.get("pacing", "calm"),
        "aspect": fields.get("aspect", "16:9"),
        "auto_upload": bool(fields.get("auto_upload", False)),
        "privacy": fields.get("privacy", "private"),
        "publish_at": fields.get("publish_at"),
        "script": None,
        "stages": {s: {"status": "idle", "progress": 0, "error": None} for s in STAGES},
        "output": None,
        "thumbnail": None,
        "youtube": None,
        "log": [],
        "created_at": now(),
        "updated_at": now(),
    }
    _write(d / "project.json", project)
    return project


def get_project(pid):
    with _lock:
        p = _read(project_dir(pid) / "project.json", None)
    if p is None:
        raise KeyError(pid)
    return p


def save_project(project):
    with _lock:
        project["updated_at"] = now()
        _write(project_dir(project["id"]) / "project.json", project)
    return project


@contextmanager
def edit_project(pid):
    """Read-modify-write a project under the lock."""
    with _lock:
        p = get_project(pid)
        yield p
        save_project(p)


def list_projects():
    out = []
    for d in PROJECTS.iterdir():
        f = d / "project.json"
        if f.exists():
            try:
                out.append(_read(f, None))
            except json.JSONDecodeError:
                continue
    out.sort(key=lambda p: p["created_at"], reverse=True)
    return out


def delete_project(pid):
    shutil.rmtree(project_dir(pid), ignore_errors=True)


def log(pid, message):
    with edit_project(pid) as p:
        p["log"].append(f"{time.strftime('%H:%M:%S')} {message}")
        p["log"] = p["log"][-300:]


def set_stage(pid, stage, **fields):
    with edit_project(pid) as p:
        p["stages"][stage].update(fields)


# ---------- channels ----------

CHANNEL_DEFAULTS = {
    "name": "Мой канал",
    "niche": "",
    "language": "English",
    "voice": "en-US-AndrewNeural",
    "style": "",
    "scene_count": 20,
    "pacing": "calm",
    "aspect": "16:9",
    "privacy": "private",
    "autopilot": False,
    "videos_per_day": 1,
    "publish_hours": [15],
    "connected": False,
}


def list_channels():
    with _lock:
        return _read(_CHANNELS_FILE, [])


def get_channel(cid):
    for c in list_channels():
        if c["id"] == cid:
            return c
    raise KeyError(cid)


def save_channel(channel):
    with _lock:
        channels = _read(_CHANNELS_FILE, [])
        if not channel.get("id"):
            channel = {**CHANNEL_DEFAULTS, **channel, "id": uuid.uuid4().hex[:8]}
            channels.append(channel)
        else:
            for i, c in enumerate(channels):
                if c["id"] == channel["id"]:
                    channels[i] = {**c, **channel}
                    channel = channels[i]
                    break
            else:
                raise KeyError(channel["id"])
        _write(_CHANNELS_FILE, channels)
        (CHANNELS_DIR / channel["id"]).mkdir(exist_ok=True)
        return channel


def delete_channel(cid):
    with _lock:
        channels = [c for c in _read(_CHANNELS_FILE, []) if c["id"] != cid]
        _write(_CHANNELS_FILE, channels)
