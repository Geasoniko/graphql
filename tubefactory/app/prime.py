"""Prime video: a 9:16 historical stickman Short (6 x 10-second clips) made the
"Google Flow" way from the owner's instruction sheet.

The team writes the whole production package — fact brief with sources,
storyboard and narration, characters with reference-sheet prompts, a
standalone consistency-agent block, and a scene-image + animation prompt for
every clip. The app then draws the character sheets and start frames, voices
the narration, takes the clips the owner animated in Google Flow (or falls
back to animating the start frame), and assembles and uploads the Short.

Stages reuse the project's stage slots:
script = package, characters = reference sheets, images = start frames,
audio = narration, render = assembly, upload = YouTube.
"""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
import contextvars

from . import images, llm, video
from .config import load_settings
from .storage import edit_project, get_project, log, project_dir, set_stage

STAGES = ["script", "characters", "images", "audio", "render", "upload"]
SKIPPED = ["review", "art", "seo", "thumbnail"]  # the classic pipeline's steps a prime video doesn't use
CLIP_SECONDS = 10
ASPECT = "9:16"
FLOW_DIR = "flow"  # clips animated by the owner in Google Flow: flow/C01.mp4 ...

STYLE_LOCK = (
    "Clean 2D flat stickman animation: round heads, consistent black outlines, slim stick limbs, simple hands "
    "and feet, dot eyes, expressive eyebrows and mouths; compact period-appropriate costume shapes with 2-3 fixed "
    "identity cues per named character; warm off-white background, muted period-inspired scenery, a small set of "
    "accent colours; background lines lighter or thinner than character outlines. No photorealism, no 3D, no "
    "detailed anatomy, no heavy textures, no gradients, no clutter."
)

RULES = """You are the historical researcher, stickman animation director, scriptwriter, character designer,
storyboard artist and prompt engineer of a YouTube Shorts channel. Videos are vertical 9:16, English narration
as a separate voice-over (no lip sync, no character speech), made of 10-second clips generated in Google Flow.

Facts: never invent quotations, motives, casualty figures, named witnesses or decisive actions. Use narration,
not dialogue. Mark any dramatization. No anachronistic clothing, technology, flags, maps or architecture.
Real suffering is shown respectfully and non-graphically. If unsure, write conservatively.

Story: hook in the first 2 seconds (a concrete visual problem or surprising fact, no greeting) -> escalation ->
turning point -> real outcome or memorable fact. Every clip advances the story. 18-24 spoken words per clip.

Visual style (locked): """ + STYLE_LOCK + """

Pacing: anticipation -> action -> reaction; 2-3 readable beats per clip, a pose/prop/framing change every
2-4 seconds; one dominant action and at most one motivated camera move per clip.
Write actual prompts, never placeholders or "same as before". Reply with JSON only."""


# ---------- topics ----------

def topics(channel=None, hint="", count=8):
    """Eight specific historical events with a recommended one."""
    brief = ""
    if channel:
        brief = f"Channel: {channel.get('name')}. Niche: {channel.get('niche') or 'history'}.\n"
    user = f"""{brief}{f"Owner's wish: {hint}" if hint else ""}
Offer {count} SPECIFIC historical events (not broad categories) for 60-second stickman Shorts. Mix eras and
regions, include lesser-known events with strong visual storytelling.
JSON: {{"topics": [{{"title": "...", "date_place": "...", "premise": "one factual sentence",
"opening_visual": "what we see in the first 2 seconds", "conflict": "...", "outcome": "...",
"clips": 6, "difficulty": "easy|medium|hard"}}], "recommended": 0, "why": "почему эта тема сильнее (по-русски)"}}"""
    try:
        return llm.chat_json(RULES, user, role="researcher", cache_hours=6)
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        return {"topics": [{"title": "The Night the Library of Alexandria Burned?", "date_place": "48 BC, Alexandria",
                            "premise": "Caesar's fire in the harbour may have reached book warehouses.",
                            "opening_visual": "A stickman scholar runs with an armful of scrolls past flames.",
                            "conflict": "War in the city", "outcome": "The library declined over centuries",
                            "clips": 6, "difficulty": "medium"}], "recommended": 0, "why": "демо"}


# ---------- package ----------

def _facts(topic):
    user = f"""Event: {json.dumps(topic, ensure_ascii=False)}
Research it (prefer museums, archives, scholarly and reputable institutions). JSON:
{{"brief": "concise paragraph", "date": "...", "location": "...", "people": "...", "cause": "...",
"turning_point": "...", "outcome": "...", "sources": [{{"title": "...", "url": "https://..."}}],
"uncertain": "what sources disagree on, or empty", "verified": true}}
Give at least two reliable sources with real URLs. If you cannot browse, set "verified": false and keep only
well-established facts."""
    return llm.chat_json(RULES, user, role="researcher", max_tokens=4000)


def _story(topic, facts, clips):
    user = f"""Event: {json.dumps(topic, ensure_ascii=False)}
Verified facts: {json.dumps(facts, ensure_ascii=False)}
Write a {clips * CLIP_SECONDS}-second Short of exactly {clips} clips of {CLIP_SECONDS} seconds.
Smallest cast possible (1-3 recurring characters).
JSON:
{{"title": "...", "scope": "...", "tone": "...",
"storyboard": [{{"clip": 1, "time": "0:00-0:10", "narration": "18-24 words", "action": "main visual action",
  "purpose": "hook|context|escalation|turning point|outcome"}}],
"characters": [{{"id": "CHR_01_NAME", "name": "...", "role": "...", "age": "...",
  "head": "head shape", "height_heads": "e.g. 4", "proportions": "...", "face": "eyes, brows, mouth",
  "hair_headwear": "...", "clothing": "layers and footwear", "palette": ["#RRGGBB", "#RRGGBB"],
  "prop": "signature prop", "feature": "permanent distinguishing feature",
  "immutable": "traits that never change", "changeable": "expression, pose, planned damage state",
  "identity": "ONE complete identity paragraph reused word for word in every prompt",
  "reference_sheet_prompt": "complete copy-ready image prompt for a clean reference sheet of ONE character on a
   plain light background: full-body front, three-quarter, side and back views at the same scale; expressions
   neutral, happy, worried, shocked, angry, determined; close-up of the hair/headwear; separate view of the
   prop; identical anatomy, outline thickness, costume, proportions and colours in every panel; no other
   characters, no alternate costumes, no realistic shading, no extra limbs; include the identity paragraph and
   the locked style"}}],
"dramatization": "what is staged or simplified (production note)",
"youtube": {{"title": "Shorts title under 70 chars", "description": "2-3 sentences + sources line",
  "hashtags": ["#history", "#shorts"]}}}}"""
    return llm.chat_json(RULES, user, role="writer", max_tokens=12000)


def _clip_prompts(topic, story):
    chars = [{"id": c["id"], "identity": c["identity"]} for c in story["characters"]]
    user = f"""Event: {topic.get('title')} ({topic.get('date_place', '')}).
Locked style: {STYLE_LOCK}
Characters (identity paragraphs, reuse verbatim): {json.dumps(chars, ensure_ascii=False)}
Storyboard: {json.dumps(story['storyboard'], ensure_ascii=False)}

For EVERY clip write a complete, independently copyable package. JSON:
{{"clips": [{{"clip": 1, "characters": ["CHR_01_NAME"],
"scene_prompt": "150-250 words: 9:16 vertical; locked 2D style; full identity paragraph of every visible
  character; date and place; period-correct scenery; framing and camera angle; foreground/middle/background
  layout; each character's position, facing, pose, expression, clothing state, prop grip; palette; the START of
  the clip only (no sequence of moments); negative constraints (no redesign, no style drift, no extra limbs, no
  modern objects, no text, no logos, no watermarks)",
"animation_prompt": "200-350 words: the scene image is the starting frame; same style and identities; opening
  state; timing 0.0-2.0 s hook, 2.0-5.0 s main action, 5.0-8.0 s reaction or reveal, 8.0-10.0 s outcome with an
  explicitly described final pose; camera behaviour (at most one motivated move); motion limits; prop
  interaction; transition to the next clip; negative constraints (no flicker, no unplanned cuts, no redesign,
  no costume or colour change, no extra limbs, no prop duplication, no text, no speech or lip sync)",
"sound": "a few motivated sound effects + music direction",
"outgoing_state": "last frame: positions, facing, held objects (which hand), emotion",
"cut": "match cut | intentional cut — and why"}}]}}
Never write "same as before" — repeat the full identities in every prompt."""
    return llm.chat_json(RULES, user, role="writer", max_tokens=24000)


def agent_block(pk):
    """The standalone CHARACTER CONSISTENCY AGENT INSTRUCTIONS, filled with this project."""
    chars = "\n\n".join(
        f"{c['id']} — {c.get('name', '')} ({c.get('role', '')})\nPalette: {', '.join(c.get('palette') or [])}\n"
        f"Identity: {c.get('identity', '')}\nImmutable: {c.get('immutable', '')}\nMay change: {c.get('changeable', '')}"
        for c in pk["characters"])
    refs = ", ".join(f"{c['id']}_sheet.png" for c in pk["characters"] if c.get("sheet")) or \
        "none approved yet — rely on the written designs and say so"
    return f"""CHARACTER CONSISTENCY AGENT INSTRUCTIONS

You are the character and visual continuity supervisor for this historical stickman video. Apply the fixed designs below to every scene prompt and every image you are able to inspect. Preserve character identity across changes in pose, expression, camera angle, and location. When asked to generate or revise a scene, use its approved references as well as the written specifications.

PROJECT: {pk['title']}
HISTORICAL SETTING: {pk['topic'].get('date_place', '')} — {pk['facts'].get('brief', '')}
FORMAT: vertical 9:16, {len(pk['clips'])} clips x {CLIP_SECONDS} s, English voice-over (no lip sync).
VISUAL STYLE: {STYLE_LOCK}

CHARACTERS:
{chars}

APPROVED REFERENCE IMAGES: {refs}

ENVIRONMENT RULES: period-correct scenery, clothing, technology, flags, maps and architecture only; generic background people stay visually subordinate and never duplicate a lead; no modern objects, logos, watermarks or generated text.

CONTINUITY RULES:
- Lock head shape, proportions, line weight, facial feature spacing, hair or headwear, costume shapes, accent colours and signature accessories.
- Never transfer one character's features or clothing to another. Preserve scale relative to recurring props and other characters. Keep left/right accessories consistent in the character's own orientation.
- No costume variants, missing props, extra fingers or limbs, merged bodies or duplicate leads.
- Keep a continuity record per clip: clip ID, characters present, location, time of day, costume state, expression, pose, position in frame, direction of movement, prop owner and holding hand, persistent physical changes; outgoing state -> next clip's incoming state. Never silently reset a dropped object, damaged costume, opened door or changed location. At an intentional cut or time jump, state what changes and what stays fixed.
- Attach the approved references where the tool supports them. If an image is unavailable, say so and use the written design. If design and reference conflict, report the mismatch and ask only the necessary question. A seed, a repeated name or text alone never guarantees identity.
- Before returning a scene prompt, check it against the style, identities and continuity record. For an uploaded output report PASS or REVISE only for features you can see, with a precise corrective prompt. Never change the approved design to match a flawed generation.

OUTPUT CONTRACT: return (1) the requested scene prompt or correction, (2) a brief continuity check, (3) the updated outgoing state — keep the notes outside the image or animation prompt."""


def stage_package(pid, force=False):
    p = get_project(pid)
    if p.get("prime", {}).get("package") and not force:
        return
    topic = p["prime"]["topic"]
    clips = int(p["prime"].get("clips") or 6)
    set_stage(pid, "script", status="running", progress=5, error=None)
    log(pid, "исследую факты и источники…", "researcher")
    try:
        facts = _facts(topic)
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        facts = {"brief": topic.get("premise", ""), "sources": [], "verified": False}
    set_stage(pid, "script", progress=30)
    log(pid, "пишу историю, раскадровку и героев…", "writer")
    try:
        story = _story(topic, facts, clips)
        set_stage(pid, "script", progress=60)
        log(pid, f"пишу промпты кадров и анимации для {clips} клипов…", "writer")
        clip_pack = _clip_prompts(topic, story)["clips"]
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        story, clip_pack = _demo_story(topic, clips), []
    by_no = {int(c.get("clip", i + 1)): c for i, c in enumerate(clip_pack)}
    clips_out = []
    for i, sb in enumerate(story["storyboard"][:clips]):
        c = by_no.get(int(sb.get("clip", i + 1)), {})
        clips_out.append({**sb, "clip": i + 1, "characters": c.get("characters") or [],
                          "scene_prompt": c.get("scene_prompt", ""), "animation_prompt": c.get("animation_prompt", ""),
                          "sound": c.get("sound", ""), "outgoing_state": c.get("outgoing_state", ""),
                          "cut": c.get("cut", "")})
    pk = {"topic": topic, "facts": facts, "title": story.get("title") or topic.get("title"),
          "scope": story.get("scope", ""), "tone": story.get("tone", ""),
          "dramatization": story.get("dramatization", ""),
          "characters": [dict(c, sheet=None) for c in story.get("characters") or []],
          "clips": clips_out, "youtube": story.get("youtube") or {}}
    yt = pk["youtube"]
    sources = "\n".join(f"• {s.get('title')}: {s.get('url')}" for s in facts.get("sources") or [])
    with edit_project(pid) as p2:
        p2["prime"]["package"] = pk
        p2["title"] = pk["title"]
        p2["script"] = {
            "title": yt.get("title") or pk["title"],
            "description": (yt.get("description", "") + (f"\n\nSources:\n{sources}" if sources else "")
                            + "\n\n" + " ".join(yt.get("hashtags") or [])).strip(),
            "tags": [h.lstrip("#") for h in yt.get("hashtags") or []][:15],
            "style": STYLE_LOCK, "thumbnail_prompt": "", "thumbnail_text": "",
            "characters": [{"id": c["id"], "name": c.get("name", c["id"]), "description": c.get("identity", ""),
                            "image": None} for c in pk["characters"]],
            "scenes": [{"idx": i, "narration": c.get("narration", ""), "image_prompt": c["scene_prompt"],
                        "characters": c["characters"], "image": None, "audio": None, "words": [],
                        "duration": None, "status": "idle", "error": None, "camera": "zoom_in"}
                       for i, c in enumerate(clips_out)],
        }
    log(pid, f"пакет готов: «{pk['title']}», {len(clips_out)} клипов, {len(pk['characters'])} героя", "writer")
    set_stage(pid, "script", status="done", progress=100)


def _demo_story(topic, clips):
    return {"title": topic.get("title", "Demo"), "characters": [
        {"id": "CHR_01_HERO", "name": "Hero", "role": "witness", "palette": ["#B23A2E"],
         "identity": "A stickman with a round head and a red scarf.", "immutable": "red scarf",
         "changeable": "expression", "reference_sheet_prompt": "Reference sheet of the stickman with a red scarf."}],
        "storyboard": [{"clip": i + 1, "time": f"0:{i * 10:02d}-0:{i * 10 + 10:02d}",
                        "narration": f"Demo narration for clip {i + 1}.", "action": "...", "purpose": "..."}
                       for i in range(clips)], "youtube": {"title": topic.get("title", "Demo")}}


# ---------- pictures ----------

def _sheet_path(pid, cid):
    return project_dir(pid) / "characters" / f"{cid}_sheet.png"


def draw_sheet(pid, cid):
    p = get_project(pid)
    c = next(c for c in p["prime"]["package"]["characters"] if c["id"] == cid)
    path = _sheet_path(pid, cid)
    images.generate(c["reference_sheet_prompt"] or c["identity"], path, "16:9", label=f"{cid}\n{c.get('name', '')}")
    rel = str(path.relative_to(project_dir(pid))).replace("\\", "/")
    with edit_project(pid) as p2:
        for x in p2["prime"]["package"]["characters"]:
            if x["id"] == cid:
                x["sheet"] = rel
        for x in p2["script"]["characters"]:
            if x["id"] == cid:
                x["image"] = rel


def stage_sheets(pid, force=False):
    chars = get_project(pid)["prime"]["package"]["characters"]
    todo = [c["id"] for c in chars if force or not c.get("sheet")]
    set_stage(pid, "characters", status="running", progress=0, error=None)
    for n, cid in enumerate(todo, 1):
        log(pid, f"рисую лист героя {cid}", "illustrator")
        draw_sheet(pid, cid)
        set_stage(pid, "characters", progress=int(n / len(todo) * 100))
    set_stage(pid, "characters", status="done", progress=100)


def draw_frame(pid, idx):
    """Start frame of a clip with the reference sheets of its characters attached."""
    p = get_project(pid)
    clip = p["prime"]["package"]["clips"][idx]
    d = project_dir(pid)
    refs = [d / c["sheet"] for c in p["prime"]["package"]["characters"]
            if c.get("sheet") and (c["id"] in clip["characters"] or not clip["characters"])]
    path = d / "images" / f"C{idx + 1:02d}_scene.png"
    images.generate(clip["scene_prompt"] or clip.get("action", ""), path, ASPECT, references=refs[:3],
                    label=f"C{idx + 1:02d}\n{clip.get('narration', '')}", seed=idx)
    with edit_project(pid) as p2:
        p2["script"]["scenes"][idx].update(image=str(path.relative_to(d)).replace("\\", "/"),
                                            status="done", error=None)


def stage_frames(pid, force=False):
    scenes = get_project(pid)["script"]["scenes"]
    todo = [s["idx"] for s in scenes if force or not s["image"]]
    set_stage(pid, "images", status="running", error=None, note=f"0/{len(todo)}",
              progress=int((len(scenes) - len(todo)) / max(len(scenes), 1) * 100))
    log(pid, f"рисую {len(todo)} стартовых кадров", "illustrator")
    workers = max(1, int(load_settings()["image_workers"]))
    errors = []

    def one(i):
        try:
            draw_frame(pid, i)
        except Exception as e:
            errors.append(i)
            with edit_project(pid) as p2:
                p2["script"]["scenes"][i].update(status="error", error=str(e)[:300])
        done = sum(1 for s in get_project(pid)["script"]["scenes"] if s["image"])
        set_stage(pid, "images", progress=int(done / len(scenes) * 100), note=f"{done}/{len(scenes)}")

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(lambda i: contextvars.copy_context().run(one, i), todo))
    if errors:
        raise RuntimeError(f"Не удалось нарисовать кадры: {', '.join(f'C{i + 1:02d}' for i in sorted(errors))}")
    set_stage(pid, "images", status="done", progress=100, note=None)


# ---------- assembly ----------

def flow_path(pid, idx):
    return project_dir(pid) / FLOW_DIR / f"C{idx + 1:02d}.mp4"


def _has_audio(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return bool(out.stdout.strip())


def _flow_clip(src, voice, out, seconds, fps, clip_volume=0.3):
    """The owner's Google Flow clip, fitted to 1080x1920 and to the narration length
    (trimmed, or its last frame held), voice on top of the clip's own sound."""
    w, h = images.SIZES[ASPECT]
    fit = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps},"
           f"format=yuv420p,tpad=stop_mode=clone:stop_duration={seconds}")
    if _has_audio(src):
        audio = (f"[1:a]aresample=44100,apad[vo];[0:a]aresample=44100,volume={clip_volume},apad[fx];"
                 f"[vo][fx]amix=inputs=2:duration=first:normalize=0[a]")
    else:
        audio = "[1:a]aresample=44100,apad[a]"
    video.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-i", str(voice),
               "-filter_complex", f"[0:v]{fit}[v];{audio}", "-map", "[v]", "-map", "[a]",
               "-t", f"{seconds:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(fps),
               "-c:a", "aac", "-b:a", "192k", "-ac", "2", str(out)])


def stage_assemble(pid, force=False):
    from .pipeline import pick_music

    settings = load_settings()
    p = get_project(pid)
    scenes = p["script"]["scenes"]
    missing = [f"C{s['idx'] + 1:02d}" for s in scenes if not s["audio"]]
    if missing:
        raise RuntimeError(f"Нет озвучки у клипов: {', '.join(missing)}")
    set_stage(pid, "render", status="running", progress=0, error=None)
    d = project_dir(pid)
    clips, timeline, offset, from_flow = [], [], 0.0, 0
    for i, s in enumerate(scenes):
        # A clip lasts 10 s, longer only when the narration needs it.
        seconds = max(CLIP_SECONDS, (s["duration"] or 0) + video.PAD)
        out = d / "clips" / f"C{i + 1:02d}_final.mp4"
        flow = flow_path(pid, i)
        if flow.exists():
            _flow_clip(flow, d / s["audio"], out, seconds, settings["fps"])
            from_flow += 1
        elif s["image"]:
            seconds = video.render_clip(d / s["image"], d / s["audio"], out, seconds - video.PAD, i, ASPECT,
                                        settings["fps"], True, "zoom_in")
        else:
            raise RuntimeError(f"У клипа C{i + 1:02d} нет ни видео из Flow, ни стартового кадра")
        clips.append(out)
        timeline.append((offset, s["words"]))
        offset += seconds
        set_stage(pid, "render", progress=int((i + 1) / len(scenes) * 90))
    ass = None
    if settings["subtitles"]:
        ass = d / "output" / "subs.ass"
        video.write_ass(timeline, ass, ASPECT)
    out = d / "output" / "video.mp4"
    video.assemble(clips, out, d / "output", ass, pick_music(settings.get("background_music")),
                   settings["music_volume"])
    for c in clips:
        c.unlink(missing_ok=True)
    with edit_project(pid) as p2:
        p2["output"] = str(out.relative_to(d)).replace("\\", "/")
        p2["duration"] = round(offset, 1)
    log(pid, f"Shorts собран: {offset:.0f} с, клипов из Google Flow: {from_flow} из {len(scenes)}"
             + ("" if from_flow == len(scenes) else " (остальные — анимированные стартовые кадры)"), "animator")
    set_stage(pid, "render", status="done", progress=100)


# ---------- package as a document ----------

def markdown(p):
    pk = p["prime"]["package"]
    f = pk["facts"]
    out = [f"# {pk['title']}", "",
           f"**Event:** {pk['topic'].get('title', '')} — {pk['topic'].get('date_place', '')}  ",
           f"**Format:** 9:16 · {len(pk['clips'])} clips × {CLIP_SECONDS} s · English voice-over  ",
           f"**Scope:** {pk.get('scope', '')} · **Tone:** {pk.get('tone', '')}", "",
           "## 1. Historical fact brief", "", f.get("brief", ""), ""]
    for k in ("date", "location", "people", "cause", "turning_point", "outcome", "uncertain"):
        if f.get(k):
            out.append(f"- **{k.replace('_', ' ').capitalize()}:** {f[k]}")
    out += ["", "**Sources:**"] + [f"- [{s.get('title')}]({s.get('url')})" for s in f.get("sources") or []]
    if not f.get("verified", True):
        out.append("- ⚠ Verification pending — check the facts before publishing.")
    if pk.get("dramatization"):
        out += ["", f"**Dramatization note:** {pk['dramatization']}"]
    out += ["", "## 2. Storyboard and narration", "", "| Clip | Time | Narration | Visual action | Purpose |",
            "|---|---|---|---|---|"]
    out += [f"| C{c['clip']:02d} | {c.get('time', '')} | {c.get('narration', '')} | {c.get('action', '')} | "
            f"{c.get('purpose', '')} |" for c in pk["clips"]]
    out += ["", "## 3. Visual style", "", STYLE_LOCK, "", "## 4. Characters", ""]
    for c in pk["characters"]:
        out += [f"### {c['id']} — {c.get('name', '')}", "",
                f"Role: {c.get('role', '')} · Palette: {', '.join(c.get('palette') or [])} · Prop: {c.get('prop', '')}",
                "", f"**Identity paragraph:** {c.get('identity', '')}", "",
                f"**Immutable:** {c.get('immutable', '')} · **May change:** {c.get('changeable', '')}", "",
                "**CHARACTER REFERENCE SHEET PROMPT**", "", "```", c.get("reference_sheet_prompt", ""), "```", ""]
    out += ["## 5. Character consistency agent", "", "```", agent_block(pk), "```", "", "## 6. Clip packages", ""]
    for c in pk["clips"]:
        out += [f"### C{c['clip']:02d} · {c.get('time', '')} · {c.get('purpose', '')}", "",
                f"**Narration:** {c.get('narration', '')}", "",
                f"**Characters / references:** {', '.join(c.get('characters') or []) or '—'}", "",
                "**Scene-image prompt (start frame)**", "", "```", c.get("scene_prompt", ""), "```", "",
                "**Animation prompt (10 s)**", "", "```", c.get("animation_prompt", ""), "```", "",
                f"**Sound:** {c.get('sound', '')}", "", f"**Outgoing state:** {c.get('outgoing_state', '')} "
                f"({c.get('cut', '')})", ""]
    out += ["## 7. Assembly guide", "",
            "1. Generate the character reference sheets; review and correct them.",
            "2. Generate each start frame with the reference attached (C01_scene … ).",
            "3. Animate each start frame in Google Flow (C01_video …); regenerate only clips with real problems.",
            "4. Upload the clips to TubeFactory (Prime video → Clips) — it adds narration, subtitles and music, "
            "fits every clip to 10 s (trim or hold the last frame) and exports 1080×1920.",
            "5. Check the final quality list, then upload to YouTube.", "",
            "**Naming:** C01_scene.png · C01_video.mp4 · C01_voice.mp3"]
    return "\n".join(out)
