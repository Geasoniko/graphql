"""The one-click pipeline, run by the company staff:
writer -> chief editor -> art director -> marketer + SEO tagger -> illustrator
(characters, frames) -> voice -> banner designer -> editor-animator -> publisher.
Every stage can also be re-run alone, and scenes that are already done are
skipped, so a failed run resumes."""
import contextvars
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import company, images, scenarist, storage, team, tts, video, youtube
from pathlib import Path

from .config import load_settings
from .storage import edit_project, get_project, log, project_dir, set_stage


class Cancelled(Exception):
    pass


_cancel = set()


def cancel(pid):
    _cancel.add(pid)


def _check(pid):
    if pid in _cancel:
        _cancel.discard(pid)
        raise Cancelled()


def _rel(pid, path):
    return str(path.relative_to(project_dir(pid))).replace("\\", "/")


def stage_script(pid, force=False):
    p = get_project(pid)
    if p["script"] and not force:
        return
    set_stage(pid, "script", status="running", progress=10, error=None)
    log(pid, "пишу сценарий…", "writer")
    script = scenarist.write_script(p["idea"], p["language"], p["scene_count"], p["pacing"],
                                    p["style"], p["reference"])
    with edit_project(pid) as p:
        p["script"] = script
        if not p["style"]:
            p["style"] = script["style"]
        p["title"] = script["title"]
    log(pid, f"сценарий готов: {len(script['scenes'])} сцен, {len(script['characters'])} персонажей", "writer")
    set_stage(pid, "script", status="done", progress=100)
    for later in ("review", "art", "seo"):
        set_stage(pid, later, status="idle", progress=0)


def _keep_media(old, new):
    """Rewrites keep the scene list shape; drop media that no longer matches."""
    for s in new["scenes"]:
        if s["idx"] < len(old["scenes"]) and old["scenes"][s["idx"]]["narration"] == s["narration"]:
            o = old["scenes"][s["idx"]]
            s.update(audio=o["audio"], words=o["words"], duration=o["duration"])
    return new


def stage_review(pid, force=False):
    p = get_project(pid)
    if p["stages"]["review"]["status"] == "done" and not force:
        return
    set_stage(pid, "review", status="running", progress=20, error=None)
    log(pid, "читаю сценарий…", "editor")
    history = [x["title"] for x in storage.list_projects()
               if x["channel_id"] and x["channel_id"] == p["channel_id"] and x["id"] != pid][:15]
    review = team.review_script(p["script"], p["idea"], p["language"], history)
    score = int(review.get("score") or 0)
    log(pid, f"оценка {score}/10, уникальность {review.get('originality', '—')}/10 — {review.get('verdict', '')}", "editor")
    original = int(review.get("originality") or 10)
    if (score < 8 or original < 7) and review.get("fixes"):
        set_stage(pid, "review", progress=60)
        log(pid, "дорабатываю по замечаниям редактора…", "writer")
        new = scenarist.write_script(p["idea"], p["language"], p["scene_count"], p["pacing"], p["style"],
                                     p["reference"], feedback=review["fixes"] + "\n" +
                                     "\n".join(review.get("problems") or []), previous=p["script"])
        with edit_project(pid) as p2:
            p2["script"] = _keep_media(p2["script"], new)
            p2["title"] = new["title"]
        review["rewritten"] = True
        log(pid, "новая версия сценария готова", "writer")
    with edit_project(pid) as p2:
        p2["review"] = review
    set_stage(pid, "review", status="done", progress=100)


def stage_art(pid, force=False):
    p = get_project(pid)
    if p["stages"]["art"]["status"] == "done" and not force:
        return
    set_stage(pid, "art", status="running", progress=20, error=None)
    log(pid, "готовлю стиль-гайд, промпты кадров и движения камеры…", "art_director")
    art = team.art_direction(p["script"], p["style"], p["aspect"])
    with edit_project(pid) as p2:
        sc = p2["script"]
        if art.get("style"):
            p2["style"] = art["style"]
        chars = {c["id"]: c for c in sc["characters"]}
        for c in art.get("characters") or []:
            if c.get("id") in chars and c.get("description"):
                chars[c["id"]]["description"] = c["description"]
        for i, a in enumerate(art.get("scenes") or []):
            idx = int(a.get("n", i + 1)) - 1
            if 0 <= idx < len(sc["scenes"]):
                if a.get("image_prompt"):
                    sc["scenes"][idx]["image_prompt"] = a["image_prompt"]
                if a.get("camera"):
                    sc["scenes"][idx]["camera"] = a["camera"]
    log(pid, f"готово: {len(art.get('scenes') or [])} кадров расписано", "art_director")
    set_stage(pid, "art", status="done", progress=100)


def stage_seo(pid, force=False):
    p = get_project(pid)
    if p["stages"]["seo"]["status"] == "done" and not force:
        return
    set_stage(pid, "seo", status="running", progress=20, error=None)
    log(pid, "придумываю заголовки и концепцию превью…", "marketer")
    m = team.marketing(p["script"], p["idea"], p["language"])
    title = m.get("best_title") or p["script"]["title"]
    set_stage(pid, "seo", progress=60)
    log(pid, "подбираю теги по поисковым запросам…", "tagger")
    t = team.tagging(title, p["idea"], p["language"])
    with edit_project(pid) as p2:
        sc = p2["script"]
        sc["title"] = p2["title"] = title
        sc["title_variants"] = m.get("titles") or []
        for k in ("description", "thumbnail_prompt", "thumbnail_text", "pinned_comment"):
            if m.get(k):
                sc[k] = m[k]
        if t.get("tags"):
            sc["tags"] = t["tags"]
        tags = " ".join(h for h in t.get("hashtags") or [] if h.startswith("#"))
        if tags and tags not in sc["description"]:
            sc["description"] = sc["description"].rstrip() + "\n\n" + tags
    log(pid, f"заголовок: «{title}»", "marketer")
    log(pid, f"тегов: {len(t.get('tags') or [])}", "tagger")
    set_stage(pid, "seo", status="done", progress=100)


def stage_characters(pid, force=False):
    p = get_project(pid)
    chars = p["script"]["characters"]
    set_stage(pid, "characters", status="running", progress=0, error=None)
    for i, c in enumerate(chars):
        _check(pid)
        if c["image"] and not force:
            continue
        log(pid, f"рисую персонажа {c['name']}", "illustrator")
        path = project_dir(pid) / "characters" / f"{c['id']}.png"
        images.generate(images.character_prompt(p["style"], c), path, "1:1",
                        label=f"{c['name']}\n{c['description']}", seed=i)
        with edit_project(pid) as p2:
            p2["script"]["characters"][i]["image"] = _rel(pid, path)
        set_stage(pid, "characters", progress=int((i + 1) / len(chars) * 100))
    set_stage(pid, "characters", status="done", progress=100)


def _scene_audio(pid, idx, voice):
    p = get_project(pid)
    scene = p["script"]["scenes"][idx]
    path = project_dir(pid) / "audio" / f"scene_{idx:03d}.mp3"
    words, dur = tts.synthesize(scene["narration"], voice, path)
    with edit_project(pid) as p2:
        s = p2["script"]["scenes"][idx]
        s.update(audio=_rel(pid, path), words=words, duration=dur)


def stage_audio(pid, force=False):
    p = get_project(pid)
    scenes = p["script"]["scenes"]
    set_stage(pid, "audio", status="running", progress=0, error=None)
    log(pid, "озвучиваю…", "voice")
    for i, s in enumerate(scenes):
        _check(pid)
        if s["audio"] and not force:
            continue
        _scene_audio(pid, i, p["voice"])
        set_stage(pid, "audio", progress=int((i + 1) / len(scenes) * 100))
    set_stage(pid, "audio", status="done", progress=100)


def _scene_image(pid, idx):
    p = get_project(pid)
    scene = p["script"]["scenes"][idx]
    chars = p["script"]["characters"]
    refs = [project_dir(pid) / c["image"] for c in chars
            if c["id"] in scene["characters"] and c["image"]]
    path = project_dir(pid) / "images" / f"scene_{idx:03d}.png"
    prompt = images.scene_prompt(p["style"], scene, chars)
    images.generate(prompt, path, p["aspect"], references=refs,
                    label=f"Scene {idx + 1}: {scene['narration']}", seed=idx)
    with edit_project(pid) as p2:
        p2["script"]["scenes"][idx].update(image=_rel(pid, path), status="done", error=None)


def stage_images(pid, force=False):
    p = get_project(pid)
    scenes = p["script"]["scenes"]
    todo = [s["idx"] for s in scenes if force or not s["image"]]
    set_stage(pid, "images", status="running", error=None,
              progress=int((len(scenes) - len(todo)) / max(len(scenes), 1) * 100))
    log(pid, f"рисую {len(todo)} кадров", "illustrator")
    workers = max(1, int(load_settings()["image_workers"]))
    errors = []
    with ThreadPoolExecutor(workers) as pool:
        futures = {}
        for i in todo:
            with edit_project(pid) as p2:
                p2["script"]["scenes"][i]["status"] = "running"
            # copy_context: the worker thread books its cost to this project too.
            futures[pool.submit(contextvars.copy_context().run, _scene_image, pid, i)] = i
        for f in as_completed(futures):
            i = futures[f]
            try:
                f.result()
            except Exception as e:
                errors.append(i)
                with edit_project(pid) as p2:
                    p2["script"]["scenes"][i].update(status="error", error=str(e)[:300])
                log(pid, f"Ошибка кадра {i + 1}: {e}")
            done = sum(1 for s in get_project(pid)["script"]["scenes"] if s["image"])
            set_stage(pid, "images", progress=int(done / len(scenes) * 100))
            if pid in _cancel:
                for other in futures:
                    other.cancel()
    _check(pid)
    if errors:
        raise RuntimeError(f"Не удалось сгенерировать кадры: {', '.join(str(i + 1) for i in errors)}")
    set_stage(pid, "images", status="done", progress=100)


def stage_thumbnail(pid, force=False):
    p = get_project(pid)
    if p["thumbnail"] and not force:
        return
    set_stage(pid, "thumbnail", status="running", progress=30, error=None)
    sc = p["script"]
    raw = project_dir(pid) / "output" / "thumbnail_raw.png"
    prompt = (f"YouTube thumbnail, bold, high contrast, expressive, clear focal point, "
              f"no text. Style: {p['style']}. {sc['thumbnail_prompt']}")
    refs = [project_dir(pid) / c["image"] for c in sc["characters"][:1] if c["image"]]
    log(pid, "рисую превью…", "thumbnail")
    images.generate(prompt, raw, "16:9", references=refs, label=sc["title"], seed=7, role="thumbnail")
    out = project_dir(pid) / "output" / "thumbnail.jpg"
    images.compose_thumbnail(raw, out, sc.get("thumbnail_text", ""))
    with edit_project(pid) as p2:
        p2["thumbnail"] = _rel(pid, out)
    set_stage(pid, "thumbnail", status="done", progress=100)


def stage_render(pid, force=False):
    settings = load_settings()
    p = get_project(pid)
    scenes = p["script"]["scenes"]
    missing = [s["idx"] + 1 for s in scenes if not s["image"] or not s["audio"]]
    if missing:
        raise RuntimeError(f"Нет картинки или озвучки у сцен: {missing}")
    set_stage(pid, "render", status="running", progress=0, error=None)
    log(pid, "анимирую кадры и монтирую…", "animator")
    d = project_dir(pid)
    clips, timeline, offset = [], [], 0.0
    for i, s in enumerate(scenes):
        _check(pid)
        clip = d / "clips" / f"clip_{i:03d}.mp4"
        length = video.render_clip(d / s["image"], d / s["audio"], clip, s["duration"], i,
                                   p["aspect"], settings["fps"], settings["ken_burns"], s.get("camera"))
        clips.append(clip)
        timeline.append((offset, s["words"]))
        offset += length
        set_stage(pid, "render", progress=int((i + 1) / len(scenes) * 90))
    ass = None
    if settings["subtitles"]:
        ass = d / "output" / "subs.ass"
        video.write_ass(timeline, ass, p["aspect"])
    out = d / "output" / "video.mp4"
    music = pick_music(settings.get("background_music"))
    video.assemble(clips, out, d / "output", ass, music, settings["music_volume"])
    for c in clips:
        c.unlink(missing_ok=True)
    with edit_project(pid) as p2:
        p2["output"] = _rel(pid, out)
        p2["duration"] = round(offset, 1)
    log(pid, f"видео готово: {offset / 60:.1f} мин", "animator")
    set_stage(pid, "render", status="done", progress=100)


def pick_music(setting):
    """A file is used as is; a folder gives each video a random track from it."""
    if not setting:
        return None
    path = Path(setting)
    if path.is_dir():
        tracks = [f for f in path.iterdir() if f.suffix.lower() in (".mp3", ".wav", ".m4a", ".ogg")]
        return str(random.choice(tracks)) if tracks else None
    return str(path) if path.exists() else None


def stage_upload(pid, force=False):
    p = get_project(pid)
    if p["youtube"] and not force:
        return
    if not p["channel_id"]:
        raise RuntimeError("У проекта не выбран канал")
    set_stage(pid, "upload", status="running", progress=0, error=None)
    publish_at = p.get("publish_at")
    ch = storage.get_channel(p["channel_id"])
    if not publish_at and p["privacy"] == "public" and ch.get("best_hours"):
        # Publisher waits for the analyst's best hour instead of going live right away.
        publish_at = company.next_publish_time(ch["best_hours"])
        log(pid, f"ставлю публикацию на лучшее время: {publish_at} (UTC)", "publisher")
    log(pid, "загружаю на YouTube…", "publisher")
    sc = p["script"]
    lang = {"English": "en", "Русский": "ru", "Қазақша": "kk"}.get(p["language"], "en")

    def progress(pct, note=None):
        set_stage(pid, "upload", progress=pct)
        if note:
            log(pid, note)

    result = youtube.upload(p["channel_id"], project_dir(pid) / p["output"], sc["title"],
                            sc["description"], sc["tags"], p["privacy"], publish_at,
                            project_dir(pid) / p["thumbnail"] if p["thumbnail"] else None,
                            lang, progress)
    with edit_project(pid) as p2:
        p2["youtube"] = result
    log(pid, f"загружено: {result['url']}", "publisher")
    if sc.get("pinned_comment"):
        log(pid, f"закреплённый комментарий (вставьте вручную): {sc['pinned_comment']}", "marketer")
    set_stage(pid, "upload", status="done", progress=100)


STAGE_FUNCS = {
    "script": stage_script,
    "review": stage_review,
    "art": stage_art,
    "seo": stage_seo,
    "characters": stage_characters,
    "audio": stage_audio,
    "images": stage_images,
    "thumbnail": stage_thumbnail,
    "render": stage_render,
    "upload": stage_upload,
}


def run(pid, stage="all", force=False):
    with company.booking(lambda role, cost: storage.add_cost(pid, role, cost)):
        _run(pid, stage, force)


def _run(pid, stage, force):
    order = list(STAGE_FUNCS) if stage == "all" else [stage]
    p = get_project(pid)
    if stage == "all" and not p["auto_upload"]:
        order.remove("upload")
    current = None
    try:
        for current in order:
            _check(pid)
            STAGE_FUNCS[current](pid, force=force and stage != "all")
    except Cancelled:
        set_stage(pid, current, status="idle", error="остановлено")
        log(pid, "Остановлено")
    except Exception as e:
        set_stage(pid, current, status="error", error=str(e)[:500])
        log(pid, f"Ошибка на этапе {current}: {e}")
        raise


def regenerate_scene(pid, idx, what):
    with company.booking(lambda role, cost: storage.add_cost(pid, role, cost)):
        if what in ("image", "both"):
            _scene_image(pid, idx)
        if what in ("audio", "both"):
            _scene_audio(pid, idx, get_project(pid)["voice"])
    with edit_project(pid) as p:
        # The rendered video no longer matches the scenes.
        if p["stages"]["render"]["status"] == "done":
            p["stages"]["render"]["status"] = "stale"


def create_from_idea(idea, channel_id=None, reference="", **overrides):
    """New project with the channel's defaults."""
    fields = {"idea": idea, "reference": reference, "channel_id": channel_id}
    if channel_id:
        ch = storage.get_channel(channel_id)
        for key in ("language", "voice", "style", "scene_count", "pacing", "aspect", "privacy"):
            fields[key] = ch.get(key)
    fields.update({k: v for k, v in overrides.items() if v not in (None, "")})
    return storage.create_project(**fields)
