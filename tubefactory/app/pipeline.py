"""The one-click pipeline, run by the company staff:
writer -> chief editor -> art director -> marketer + SEO tagger -> illustrator
(characters, frames) -> voice -> banner designer -> editor-animator -> publisher.
Every stage can also be re-run alone, and scenes that are already done are
skipped, so a failed run resumes."""
import contextvars
import random
import re
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import agents, company, images, pricing, scenarist, storage, team, tts, video, youtube
from pathlib import Path

from .config import load_settings
from .storage import edit_project, get_project, log, project_dir, set_stage


class Cancelled(Exception):
    pass


_cancel = set()
_over_budget = set()


def cancel(pid):
    _cancel.add(pid)


def _check(pid):
    if pid in _cancel:
        _cancel.discard(pid)
        raise Cancelled()
    if pid in _over_budget:
        _over_budget.discard(pid)
        p = get_project(pid)
        raise RuntimeError(f"Лимит расходов на видео: потрачено ${(p.get('cost') or {}).get('total', 0):.2f} "
                           f"при лимите ${_budget(p):.2f}. Поднимите лимит в «Настройки проекта» "
                           "(0 — без лимита) и нажмите «Продолжить генерацию».")


def _budget(p):
    b = p.get("budget")
    return float(load_settings().get("video_budget") or 0) if b in (None, "") else float(b)


def _book(pid):
    """Cost sink for a project: books the spend and trips the budget stop."""
    def sink(role, cost):
        storage.add_cost(pid, role, cost)
        p = get_project(pid)
        limit = _budget(p)
        if limit and (p.get("cost") or {}).get("total", 0) > limit:
            _over_budget.add(pid)
    return sink


def _brand(p):
    """The channel identity made by the stylist, or None."""
    if not p.get("channel_id"):
        return None
    try:
        return storage.get_channel(p["channel_id"]).get("brand")
    except KeyError:
        return None


def _avatar(p):
    from .config import CHANNELS_DIR
    path = CHANNELS_DIR / str(p.get("channel_id")) / "avatar.jpg"
    return path if _brand(p) and path.exists() else None


def _hero_master(p):
    """The channel's approved drawing of its mascot, shared by all videos (made by the first one)."""
    from .config import CHANNELS_DIR
    return CHANNELS_DIR / str(p.get("channel_id")) / "hero.png"


def _lock_hero(pid):
    """Make the stylist's mascot the script's main character, word for word.
    The writer may rename or re-describe it; here the matching character (or the one
    in most scenes) becomes the brand hero with the stylist's exact name and look."""
    p = get_project(pid)
    hero = (_brand(p) or {}).get("hero") or {}
    if not hero.get("name") or not p.get("script"):
        return
    name, desc = hero["name"], hero.get("description", "")
    with edit_project(pid) as p2:
        sc = p2["script"]
        chars = sc["characters"]
        key = name.lower()
        match = next((c for c in chars if c.get("brand_hero")), None) or next(
            (c for c in chars if key in c["name"].lower() or key in c["id"].lower()
             or (c["name"].lower() and c["name"].lower() in key)), None)
        if match is None and chars:
            counts = {c["id"]: sum(c["id"] in s["characters"] for s in sc["scenes"]) for c in chars}
            match = max(chars, key=lambda c: counts[c["id"]])
        if match is None:
            match = {"id": "hero", "name": name, "description": desc, "image": None}
            chars.append(match)
            for s in sc["scenes"]:
                if not s["characters"]:
                    s["characters"].append("hero")
        old_name = match.get("name") or ""
        changed = match.get("description") != desc or old_name != name
        match.update(name=name, description=desc, brand_hero=True)
        if changed:
            match["image"] = None  # redraw with the locked look
        if old_name and old_name != name:
            # The writer called the mascot differently: use the brand name everywhere.
            pattern = re.compile(rf"\b{re.escape(old_name)}\b")
            for s in sc["scenes"]:
                s["image_prompt"] = pattern.sub(name, s["image_prompt"])
                if pattern.search(s["narration"]):
                    s.update(narration=pattern.sub(name, s["narration"]), audio=None, words=[], duration=None)


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
    _lock_hero(pid)


def _keep_media(old, new):
    """Rewrites keep the scene list shape; drop media that no longer matches."""
    for s in new["scenes"]:
        if s["idx"] < len(old["scenes"]) and old["scenes"][s["idx"]]["narration"] == s["narration"]:
            o = old["scenes"][s["idx"]]
            s.update(audio=o["audio"], words=o["words"], duration=o["duration"])
    return new


def stage_review(pid, force=False):
    """Chief editor loop: review -> writer fixes -> review again, until the script scores
    at least `min_script_score` (and originality >= 7), keeping the best version.
    If it never gets there the stage stops, so a weak script is never produced."""
    p = get_project(pid)
    if p["stages"]["review"]["status"] == "done" and not force:
        return
    settings = load_settings()
    target = int(settings.get("min_script_score") or 8)
    rounds = int(settings.get("max_rewrites") or 3)
    set_stage(pid, "review", status="running", progress=10, error=None)
    history = [x["title"] for x in storage.list_projects()
               if x["channel_id"] and x["channel_id"] == p["channel_id"] and x["id"] != pid][:15]
    trail = []  # every round, for the UI
    best = None  # (score, script, review)
    for rnd in range(rounds + 1):
        _check(pid)
        p = get_project(pid)
        log(pid, f"читаю сценарий{f' (версия {rnd + 1})' if rnd else ''}…", "editor")
        review = team.review_script(p["script"], p["idea"], p["language"], history)
        score = int(review.get("score") or 0)
        original = int(review.get("originality") or 10)
        trail.append({"round": rnd + 1, "score": score, "originality": original, "verdict": review.get("verdict", "")})
        log(pid, f"оценка {score}/10, уникальность {original}/10 — {review.get('verdict', '')}", "editor")
        if best is None or score > best[0]:
            best = (score, p["script"], review)
        if score >= target and original >= 7:
            break
        if rnd == rounds or not review.get("fixes"):
            break
        set_stage(pid, "review", progress=int(10 + 80 * (rnd + 1) / (rounds + 1)))
        log(pid, f"дорабатываю до {target}+/10 по замечаниям редактора…", "writer")
        new = scenarist.write_script(
            p["idea"], p["language"], p["scene_count"], p["pacing"], p["style"], p["reference"],
            feedback=(f"Target: at least {target}/10 from the chief editor.\n{review['fixes']}\n"
                      + "\n".join(f"- {x}" for x in review.get("problems") or [])
                      + ("\nKeep these strengths: " + "; ".join(review.get("strengths") or []))),
            previous=p["script"])
        with edit_project(pid) as p2:
            p2["script"] = _keep_media(p2["script"], new)
            p2["title"] = new["title"]
        _lock_hero(pid)
    score, script, review = best
    review.update(rounds=trail, rewritten=len(trail) > 1, target=target)
    with edit_project(pid) as p2:
        p2["script"] = script  # the best-scored version wins, even if a later rewrite was worse
        p2["title"] = script["title"]
        p2["review"] = review
    _lock_hero(pid)
    if score < target:
        log(pid, f"сценарий не дотянул до {target}/10 — видео остановлено до вашего решения", "editor")
        raise RuntimeError(f"Шеф-редактор: лучшая версия {score}/10 после {len(trail)} проверок, нужно {target}+. "
                           "Посмотрите замечания, поправьте сцены или снизьте порог в Настройках, "
                           "затем «Продолжить генерацию».")
    log(pid, f"сценарий принят: {score}/10 с {len(trail)}-й проверки", "editor")
    set_stage(pid, "review", status="done", progress=100)


def stage_art(pid, force=False):
    p = get_project(pid)
    if p["stages"]["art"]["status"] == "done" and not force:
        return
    set_stage(pid, "art", status="running", progress=20, error=None)
    log(pid, "готовлю стиль-гайд, промпты кадров и движения камеры…", "art_director")
    brand = _brand(p)
    art = team.art_direction(p["script"], p["style"], p["aspect"], brand)
    with edit_project(pid) as p2:
        sc = p2["script"]
        if art.get("style") and not brand:  # the stylist's style is locked for branded channels
            p2["style"] = art["style"]
        chars = {c["id"]: c for c in sc["characters"]}
        for c in art.get("characters") or []:
            if c.get("id") in chars and c.get("description") and not chars[c["id"]].get("brand_hero"):
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
    m = team.marketing(p["script"], p["idea"], p["language"], _brand(p))
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


def _fit_images_to_budget(pid):
    """Before the first picture: if the frames still to draw would push the video over its
    limit with the current image model, switch this video to the best cheaper one that fits."""
    p = get_project(pid)
    limit = _budget(p)
    if not limit or p.get("image_model"):
        return
    sc = p["script"]
    count = (sum(1 for s in sc["scenes"] if not s["image"])
             + sum(1 for c in sc["characters"] if not c["image"]))
    if not count:
        return
    hero = next((c for c in sc["characters"] if c.get("brand_hero")), None)
    checks = sum(1 for s in sc["scenes"] if hero and hero["id"] in s["characters"])
    thumb = 0 if p["thumbnail"] else pricing.per_image(agents.model_for("thumbnail"))
    left = limit - (p.get("cost") or {}).get("total", 0) - thumb - checks * pricing.HERO_CHECK
    current = agents.model_for("illustrator")
    # +15%: frames where the hero came out wrong are drawn a second time.
    model = pricing.fit_image_model(count * 1.15, left, current)
    if model == current:
        return
    with edit_project(pid) as p2:
        p2["image_model"] = model
    fits = count * 1.15 * pricing.per_image(model) <= left
    log(pid, f"под лимит ${limit:.2f} картинки ({count} шт.) рисует {model} "
             f"(~${pricing.per_image(model):.3f} за штуку вместо ~${pricing.per_image(current):.3f})"
             + ("" if fits else " — даже так лимита может не хватить"), "illustrator")


def stage_characters(pid, force=False):
    _lock_hero(pid)
    _fit_images_to_budget(pid)
    p = get_project(pid)
    chars = p["script"]["characters"]
    set_stage(pid, "characters", status="running", progress=0, error=None)
    for i, c in enumerate(chars):
        _check(pid)
        if c["image"] and not force:
            continue
        path = project_dir(pid) / "characters" / f"{c['id']}.png"
        if c.get("brand_hero"):
            _draw_brand_hero(pid, c, path, force)
        else:
            log(pid, f"рисую персонажа {c['name']}", "illustrator")
            images.generate(images.character_prompt(p["style"], c), path, "1:1",
                            label=f"{c['name']}\n{c['description']}", seed=i, model=p.get("image_model"))
        with edit_project(pid) as p2:
            p2["script"]["characters"][i]["image"] = _rel(pid, path)
        set_stage(pid, "characters", progress=int((i + 1) / len(chars) * 100))
    set_stage(pid, "characters", status="done", progress=100)


def _draw_brand_hero(pid, c, path, force=False):
    """The mascot is drawn once per channel and reused, so every video has the very same hero.
    The first drawing uses the channel avatar as reference and is checked against it."""
    p = get_project(pid)
    master = _hero_master(p)
    if master.exists() and not force:
        shutil.copyfile(master, path)
        log(pid, f"герой канала {c['name']} — беру утверждённый эталон", "illustrator")
        return
    avatar = _avatar(p)
    for attempt in range(2):
        log(pid, f"рисую героя канала {c['name']} по аватару канала", "illustrator")
        images.generate(images.character_prompt(p["style"], c), path, "1:1",
                        references=[avatar] if avatar else [], label=f"{c['name']}\n{c['description']}",
                        seed=attempt, model=p.get("image_model"))
        if not avatar:
            break
        check = team.compare_character(avatar, path, c["name"], c["description"])
        log(pid, f"сверка героя с аватаром: {check['score']}/10 {check.get('differences', '')}", "art_director")
        if check["score"] >= 7:
            break
    shutil.copyfile(path, master)


def _scene_audio(pid, idx, voice):
    p = get_project(pid)
    scene = p["script"]["scenes"][idx]
    path = project_dir(pid) / "audio" / f"scene_{idx:03d}.mp3"
    words, dur = tts.synthesize(scene["narration"], voice, path, p.get("voice_provider"))
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
                    label=f"Scene {idx + 1}: {scene['narration']}", seed=idx, model=p.get("image_model"))
    with edit_project(pid) as p2:
        p2["script"]["scenes"][idx].update(image=_rel(pid, path), status="done", error=None)


def compare_image_models(pid, idx, models):
    """Draw one scene with several image models side by side, with the real cost of each,
    so the owner can judge quality per dollar on their own content."""
    import time as _time
    from .config import DATA
    p = get_project(pid)
    scene = p["script"]["scenes"][idx]
    chars = p["script"]["characters"]
    refs = [project_dir(pid) / c["image"] for c in chars if c["id"] in scene["characters"] and c["image"]]
    prompt = images.scene_prompt(p["style"], scene, chars)
    hero = next((c for c in chars if c.get("brand_hero") and c.get("image")), None)
    out_dir = DATA / "compare"
    out_dir.mkdir(exist_ok=True)
    stamp = _time.strftime("%Y%m%d%H%M%S")

    def one(model):
        spent = []
        path = out_dir / f"{stamp}_{re.sub(r'[^A-Za-z0-9]+', '_', model)}.png"
        started = _time.time()
        try:
            with company.booking(lambda role, cost: spent.append((role, cost))):
                images.generate(prompt, path, p["aspect"], references=refs, seed=idx, model=model,
                                label=f"{model}\n{scene['narration']}")
                check = (team.compare_character(project_dir(pid) / hero["image"], path, hero["name"],
                                                hero["description"])
                         if hero and hero["id"] in scene["characters"] else None)
        except Exception as e:
            return {"model": model, "error": str(e)[:300]}
        return {"model": model, "url": f"/compare-media/{path.name}",
                "cost": round(sum(c for r, c in spent if r == "illustrator"), 4),
                "seconds": round(_time.time() - started, 1),
                "hero_score": check["score"] if check else None}

    with ThreadPoolExecutor(4) as pool:
        return list(pool.map(lambda m: contextvars.copy_context().run(one, m), models))


def stage_images(pid, force=False):
    _fit_images_to_budget(pid)
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
            if pid in _cancel or pid in _over_budget:
                for other in futures:
                    other.cancel()
    _check(pid)
    if errors:
        raise RuntimeError(f"Не удалось сгенерировать кадры: {', '.join(str(i + 1) for i in errors)}")
    _check_hero_frames(pid, only=None if force else set(todo))
    set_stage(pid, "images", status="done", progress=100)


def _check_hero_frames(pid, only=None):
    """Look at every frame with the mascot: is it really the same hero? Redraw mismatches once."""
    p = get_project(pid)
    hero = next((c for c in p["script"]["characters"] if c.get("brand_hero") and c.get("image")), None)
    if not hero or not load_settings().get("hero_check", True):
        return
    ref = project_dir(pid) / hero["image"]
    targets = [s["idx"] for s in p["script"]["scenes"]
               if hero["id"] in s["characters"] and s["image"] and (only is None or s["idx"] in only)]
    if not targets:
        return
    log(pid, f"проверяю героя на {len(targets)} кадрах", "art_director")

    def check(i):
        scene = get_project(pid)["script"]["scenes"][i]
        r = team.compare_character(ref, project_dir(pid) / scene["image"], hero["name"], hero["description"])
        fixed = False
        if r["score"] < 6:
            _scene_image(pid, i)
            r = team.compare_character(ref, project_dir(pid) / get_project(pid)["script"]["scenes"][i]["image"],
                                       hero["name"], hero["description"])
            fixed = True
        with edit_project(pid) as p2:
            p2["script"]["scenes"][i]["hero_check"] = {"score": r["score"], "redrawn": fixed,
                                                      "differences": r.get("differences", "")}
        return r["score"], fixed

    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda i: contextvars.copy_context().run(check, i), targets))
    ok = sum(1 for score, _ in results if score >= 6)
    redrawn = sum(1 for _, fixed in results if fixed)
    summary = {"checked": len(results), "ok": ok, "redrawn": redrawn,
               "avg": round(sum(score for score, _ in results) / len(results), 1)}
    with edit_project(pid) as p2:
        p2["hero_check"] = summary
    log(pid, f"герой совпадает на {ok} из {len(results)} кадров (перерисовано {redrawn}), "
             f"средняя оценка {summary['avg']}/10", "art_director")


def stage_thumbnail(pid, force=False):
    p = get_project(pid)
    if p["thumbnail"] and not force:
        return
    set_stage(pid, "thumbnail", status="running", progress=30, error=None)
    sc = p["script"]
    raw = project_dir(pid) / "output" / "thumbnail_raw.png"
    brand = _brand(p) or {}
    rules = " ".join(brand.get("thumbnail_rules") or [])
    prompt = (f"YouTube thumbnail, bold, high contrast, expressive, clear focal point, "
              f"no text. Style: {p['style']}. {sc['thumbnail_prompt']}"
              + (f" Channel thumbnail rules: {rules}" if rules else ""))
    refs = [project_dir(pid) / c["image"] for c in sc["characters"][:1] if c["image"]]
    if _avatar(p):
        refs.append(_avatar(p))
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
                                   p["aspect"], settings["fps"], settings["ken_burns"], s.get("camera"),
                                   shots=2 if p.get("pacing") == "economy" else 1)
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
    _over_budget.discard(pid)
    p = get_project(pid)
    if _budget(p) and (p.get("cost") or {}).get("total", 0) > _budget(p) and stage == "all":
        _over_budget.add(pid)  # already over the limit: stop before spending more
    with company.booking(_book(pid)):
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
        for key in ("language", "voice", "voice_provider", "style", "scene_count", "pacing", "aspect", "privacy"):
            fields[key] = ch.get(key)
        palette = (ch.get("brand") or {}).get("palette") or []
        if palette and fields.get("style"):
            fields["style"] = f"{fields['style']} Color palette: {', '.join(palette)}."
        hero = (ch.get("brand") or {}).get("hero") or {}
        if hero.get("description"):
            # The stylist's mascot stars in every video, so the channel is recognisable.
            fields["idea"] = (f"{idea}\n\nChannel mascot — use as the main character: "
                              f"{hero.get('name', 'Hero')} — {hero['description']}")
    fields.update({k: v for k, v in overrides.items() if v not in (None, "")})
    return storage.create_project(**fields)
