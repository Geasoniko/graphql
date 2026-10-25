"""The one-click pipeline: script -> characters -> voice -> images ->
thumbnail -> render -> upload. Every stage can also be re-run alone, and
scenes that are already done are skipped, so a failed run resumes."""
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import images, scenarist, storage, tts, video, youtube
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
    log(pid, "Сценарист пишет сценарий…")
    script = scenarist.write_script(p["idea"], p["language"], p["scene_count"], p["pacing"],
                                    p["style"], p["reference"])
    with edit_project(pid) as p:
        p["script"] = script
        if not p["style"]:
            p["style"] = script["style"]
        p["title"] = script["title"]
    log(pid, f"Сценарий готов: {len(script['scenes'])} сцен, {len(script['characters'])} персонажей")
    set_stage(pid, "script", status="done", progress=100)


def stage_characters(pid, force=False):
    p = get_project(pid)
    chars = p["script"]["characters"]
    set_stage(pid, "characters", status="running", progress=0, error=None)
    for i, c in enumerate(chars):
        _check(pid)
        if c["image"] and not force:
            continue
        log(pid, f"Персонаж: {c['name']}")
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
    log(pid, "Озвучка…")
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
    log(pid, f"Картинки: {len(todo)} кадров")
    workers = max(1, int(load_settings()["image_workers"]))
    errors = []
    with ThreadPoolExecutor(workers) as pool:
        futures = {}
        for i in todo:
            with edit_project(pid) as p2:
                p2["script"]["scenes"][i]["status"] = "running"
            futures[pool.submit(_scene_image, pid, i)] = i
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
    images.generate(prompt, raw, "16:9", references=refs, label=sc["title"], seed=7)
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
    log(pid, "Сборка видео…")
    d = project_dir(pid)
    clips, timeline, offset = [], [], 0.0
    for i, s in enumerate(scenes):
        _check(pid)
        clip = d / "clips" / f"clip_{i:03d}.mp4"
        length = video.render_clip(d / s["image"], d / s["audio"], clip, s["duration"], i,
                                   p["aspect"], settings["fps"], settings["ken_burns"])
        clips.append(clip)
        timeline.append((offset, s["words"]))
        offset += length
        set_stage(pid, "render", progress=int((i + 1) / len(scenes) * 90))
    ass = None
    if settings["subtitles"]:
        ass = d / "output" / "subs.ass"
        video.write_ass(timeline, ass, p["aspect"])
    out = d / "output" / "video.mp4"
    music = settings.get("background_music") or None
    video.assemble(clips, out, d / "output", ass, music, settings["music_volume"])
    for c in clips:
        c.unlink(missing_ok=True)
    with edit_project(pid) as p2:
        p2["output"] = _rel(pid, out)
        p2["duration"] = round(offset, 1)
    log(pid, f"Видео готово: {offset / 60:.1f} мин")
    set_stage(pid, "render", status="done", progress=100)


def stage_upload(pid, force=False):
    p = get_project(pid)
    if p["youtube"] and not force:
        return
    if not p["channel_id"]:
        raise RuntimeError("У проекта не выбран канал")
    set_stage(pid, "upload", status="running", progress=0, error=None)
    log(pid, "Загрузка на YouTube…")
    sc = p["script"]
    lang = {"English": "en", "Русский": "ru", "Қазақша": "kk"}.get(p["language"], "en")

    def progress(pct, note=None):
        set_stage(pid, "upload", progress=pct)
        if note:
            log(pid, note)

    result = youtube.upload(p["channel_id"], project_dir(pid) / p["output"], sc["title"],
                            sc["description"], sc["tags"], p["privacy"], p.get("publish_at"),
                            project_dir(pid) / p["thumbnail"] if p["thumbnail"] else None,
                            lang, progress)
    with edit_project(pid) as p2:
        p2["youtube"] = result
    log(pid, f"Загружено: {result['url']}")
    set_stage(pid, "upload", status="done", progress=100)


STAGE_FUNCS = {
    "script": stage_script,
    "characters": stage_characters,
    "audio": stage_audio,
    "images": stage_images,
    "thumbnail": stage_thumbnail,
    "render": stage_render,
    "upload": stage_upload,
}


def run(pid, stage="all", force=False):
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
