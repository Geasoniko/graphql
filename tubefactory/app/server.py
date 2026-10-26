"""HTTP API + static web UI."""
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import agents, analytics, company, config, jobs, llm, pipeline, scenarist, storage, tts, youtube
from .config import WEB


@asynccontextmanager
async def lifespan(_app):
    jobs.start()
    yield


app = FastAPI(title="TubeFactory", lifespan=lifespan)


def _project(pid):
    try:
        return storage.get_project(pid)
    except KeyError:
        raise HTTPException(404, "Проект не найден")


def _fail(e):
    raise HTTPException(400, str(e))


# ---------- settings ----------

@app.get("/api/settings")
def get_settings():
    return config.public_settings()


@app.put("/api/settings")
def put_settings(patch: dict = Body(...)):
    # Masked secrets coming back from the UI must not overwrite real ones.
    patch = {k: v for k, v in patch.items() if not (isinstance(v, str) and v.startswith("•"))}
    config.save_settings(patch)
    return config.public_settings()


@app.get("/api/models")
def models():
    try:
        return llm.list_models()
    except Exception as e:
        _fail(f"Не удалось получить список моделей OpenRouter: {e}")


@app.get("/api/voices")
def voices():
    return {"edge": [{"id": v, "name": n} for v, n in tts.EDGE_VOICES],
            "openai": [{"id": v, "name": v} for v in tts.OPENAI_VOICES]}


# ---------- channels ----------

@app.get("/api/channels")
def channels():
    out = []
    for c in storage.list_channels():
        c["connected"] = youtube.is_connected(c["id"])
        out.append(c)
    return out


@app.post("/api/channels")
def save_channel(channel: dict = Body(...)):
    try:
        return storage.save_channel(channel)
    except KeyError:
        raise HTTPException(404, "Канал не найден")


@app.delete("/api/channels/{cid}")
def delete_channel(cid: str):
    storage.delete_channel(cid)
    return {"ok": True}


@app.post("/api/channels/{cid}/connect")
def connect_channel(cid: str):
    secret = Path(config.load_settings()["youtube_client_secret"])
    if not secret.exists():
        _fail(f"Нет файла OAuth-клиента Google: {secret}. Инструкция в README, раздел «YouTube».")
    # Opens a browser tab for Google sign-in; runs in the background.
    def auth():
        try:
            info = youtube.authorize(cid)
            if info:
                storage.save_channel({"id": cid, "youtube": info})
        except Exception as e:
            print("YouTube auth failed:", e)
    threading.Thread(target=auth, daemon=True).start()
    return {"ok": True, "message": "Откройте окно браузера и войдите в аккаунт канала"}


# ---------- company ----------

@app.get("/api/company")
def company_state():
    data = company.get()
    staff = agents.staff()
    for a in staff:
        a["cost"] = data["costs"].get(a["role"], 0)
        a["calls"] = data["calls"].get(a["role"], 0)
        last = next((f for f in data["feed"] if f["role"] == a["role"]), None)
        a["last"] = last
    return {"staff": staff, "feed": data["feed"][:150], "reports": data["reports"],
            "decisions": data["decisions"], "total_cost": round(sum(data["costs"].values()), 4)}


@app.put("/api/agents")
def put_agents(body: dict = Body(...)):
    current = config.load_settings().get("agents") or {}
    for role, model in body.items():
        if role in agents.ROLES:
            model = (model or "").strip()
            if model and model != agents.ROLES[role]["default_model"]:
                current[role] = {"model": model}
            else:
                current.pop(role, None)  # back to the default, follows future default updates
    config.save_settings({"agents": current})
    return agents.staff()


@app.post("/api/channels/{cid}/plan")
def plan(cid: str, body: dict = Body(default={})):
    try:
        storage.get_channel(cid)
    except KeyError:
        raise HTTPException(404, "Канал не найден")
    try:
        return jobs.plan_video(cid, start=body.get("start", True))
    except Exception as e:
        _fail(e)


@app.post("/api/channels/{cid}/analyze")
def analyze_channel(cid: str):
    try:
        return analytics.analyze_channel(cid)
    except Exception as e:
        _fail(e)


# ---------- scenarist ----------

@app.post("/api/scenarist/analyze")
def analyze(body: dict = Body(...)):
    url, text, niche = body.get("url", "").strip(), body.get("text", "").strip(), body.get("niche", "")
    ref = None
    try:
        if url:
            ref = youtube.fetch_reference(url)
            text = youtube.reference_text(ref) + ("\n\n" + text if text else "")
        if text:
            result = scenarist.analyze_reference(text, niche, int(body.get("count", 8)))
        elif niche:
            result = scenarist.ideas_for_niche(niche, int(body.get("count", 8)))
        else:
            _fail("Укажите ссылку на видео, текст или нишу")
    except HTTPException:
        raise
    except Exception as e:
        _fail(e)
    result["reference"] = ref
    result["reference_text"] = text
    return result


@app.post("/api/niches")
def niches(body: dict = Body(...)):
    try:
        return scenarist.find_niches(body.get("query", ""), int(body.get("count", 10)))
    except Exception as e:
        _fail(e)


# ---------- projects ----------

@app.get("/api/projects")
def projects():
    out = []
    for p in storage.list_projects():
        sc = p.get("script") or {}
        out.append({k: p.get(k) for k in ("id", "title", "channel_id", "stages", "output",
                                          "thumbnail", "youtube", "created_at", "duration")}
                   | {"scenes": len(sc.get("scenes", [])), "busy": jobs.is_busy(p["id"])})
    return out


@app.post("/api/projects")
def create_project(body: dict = Body(...)):
    if not body.get("idea"):
        _fail("Нужна идея видео")
    p = pipeline.create_from_idea(body.pop("idea"), body.pop("channel_id", None),
                                  body.pop("reference", ""), **body)
    if body.get("start"):
        jobs.enqueue(p["id"])
    return p


@app.get("/api/projects/{pid}")
def project(pid: str):
    p = _project(pid)
    p["busy"] = jobs.is_busy(pid)
    return p


EDITABLE = {"title", "idea", "channel_id", "language", "style", "voice", "scene_count",
            "pacing", "aspect", "auto_upload", "privacy", "publish_at"}


@app.put("/api/projects/{pid}")
def update_project(pid: str, body: dict = Body(...)):
    _project(pid)
    with storage.edit_project(pid) as p:
        for k, v in body.items():
            if k in EDITABLE:
                p[k] = v
        if "script" in body and p["script"]:
            sc = body["script"]
            for k in ("title", "description", "tags", "thumbnail_text", "thumbnail_prompt"):
                if k in sc:
                    p["script"][k] = sc[k]
            for i, s in enumerate(sc.get("scenes", [])):
                if i < len(p["script"]["scenes"]):
                    cur = p["script"]["scenes"][i]
                    if s.get("narration") is not None and s["narration"] != cur["narration"]:
                        cur.update(narration=s["narration"], audio=None, words=[], duration=None)
                    if s.get("image_prompt") is not None and s["image_prompt"] != cur["image_prompt"]:
                        cur["image_prompt"] = s["image_prompt"]
            for i, c in enumerate(sc.get("characters", [])):
                if i < len(p["script"]["characters"]) and c.get("description"):
                    p["script"]["characters"][i]["description"] = c["description"]
    return project(pid)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    jobs.cancel(pid)
    storage.delete_project(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/run")
def run_project(pid: str, body: dict = Body(default={})):
    _project(pid)
    stage = body.get("stage", "all")
    if stage != "all" and stage not in pipeline.STAGE_FUNCS:
        _fail("Неизвестный этап")
    return jobs.enqueue(pid, stage, bool(body.get("force")))


@app.post("/api/projects/{pid}/stop")
def stop_project(pid: str):
    jobs.cancel(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/scenes/{idx}/regenerate")
def regenerate(pid: str, idx: int, body: dict = Body(default={})):
    p = _project(pid)
    if not p["script"] or idx >= len(p["script"]["scenes"]):
        raise HTTPException(404, "Сцена не найдена")
    try:
        pipeline.regenerate_scene(pid, idx, body.get("what", "image"))
    except Exception as e:
        _fail(e)
    return project(pid)


@app.get("/api/queue")
def queue():
    return jobs.snapshot()


@app.get("/media/{pid}/{path:path}")
def media(pid: str, path: str):
    base = storage.project_dir(pid).resolve()
    f = (base / path).resolve()
    if not f.is_file() or base not in f.parents:
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
