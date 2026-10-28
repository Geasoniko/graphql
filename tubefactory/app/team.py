"""What each specialist agent does. Every function falls back to a simple
demo answer when there is no OpenRouter key."""
import json

from . import llm


def _ask(role, system, user, demo, **kw):
    try:
        return llm.chat_json(system, user, role=role, **kw)
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        return demo


def _script_text(script, limit=40000):
    slim = {k: script.get(k) for k in ("title", "style")}
    slim["characters"] = [{k: v for k, v in c.items() if k != "image"} for c in script.get("characters") or []]
    slim["scenes"] = [{"n": s["idx"] + 1, "narration": s["narration"], "image_prompt": s["image_prompt"],
                       "characters": s["characters"]} for s in script["scenes"]]
    return json.dumps(slim, ensure_ascii=False)[:limit]


# ---------- chief editor ----------

def review_script(script, idea, language, channel_titles=()):
    system = """You are the chief editor of a YouTube studio whose faceless videos get millions of views.
Review the script brutally but fairly: the hook in the first 5 seconds, open loops and retention,
pacing, clarity, factual accuracy (flag invented statistics), emotional payoff, ending with a reason to
watch the next video.
Also guard monetization. Since July 2026 YouTube does not pay for "inauthentic content": videos that
feel templated or interchangeable with the channel's other videos (only topic/title/names change),
and AI personas giving health, finance or legal advice. Score originality against the channel's
previous videos and demand real substance: specific facts, a unique angle, a story only this video tells.
Reply in JSON only; feedback text in Russian, fixes in English."""
    history = "\n".join(f"- {t}" for t in channel_titles) or "(first video of the channel)"
    user = f"""Video idea: {idea}
Narration language: {language}
Channel's previous videos:
{history}
Script:
{_script_text(script)}

JSON: {{"score": 1-10, "originality": 1-10, "verdict": "коротко на русском", "strengths": ["..."],
"problems": ["..."], "monetization_risk": "нет / низкий / высокий — почему (рус.)",
"fixes": "concrete instructions for the writer in English"}}"""
    return _ask("editor", system, user,
                {"score": 9, "originality": 9, "verdict": "Демо: сценарий принят без проверки.", "strengths": [],
                 "problems": [], "monetization_risk": "", "fixes": ""})


# ---------- art director ----------

def _brand_text(brand):
    if not brand:
        return ""
    hero = brand.get("hero") or {}
    return (f"\nChannel brand (from the channel stylist) — follow it strictly:\n"
            f"- Style is LOCKED, do not change it: {brand.get('style_prompt', '')}\n"
            f"- Palette: {', '.join(brand.get('palette') or [])}\n"
            f"- Mascot: {hero.get('name', '')} — {hero.get('description', '')}\n"
            f"- Thumbnail rules: {'; '.join(brand.get('thumbnail_rules') or [])}\n")


def art_direction(script, channel_style, aspect, brand=None):
    system = """You are the art director of an animated YouTube channel. You write a style bible and
production-ready image prompts for an image model (Gemini image / similar). Keep the same characters
looking identical in every frame. Each frame must be a single clear composition that illustrates the
narration literally, with readable emotion, no text in the image. Choose a camera move for each still
so the video feels animated: zoom_in (tension, focus), zoom_out (reveal), pan_left / pan_right
(travel, landscapes), static (dialogue, simple moments). Reply with JSON only."""
    user = f"""Channel visual style (must follow): {channel_style or 'decide yourself, fitting the topic'}
{_brand_text(brand)}Frame aspect: {aspect}
Script:
{_script_text(script)}

JSON: {{
 "style": "style bible in one paragraph: medium, line, palette, lighting, mood (English)",
 "characters": [{{"id": "same id as in script", "description": "precise visual description to keep identical"}}],
 "scenes": [{{"n": 1, "image_prompt": "detailed English prompt", "camera": "zoom_in|zoom_out|pan_left|pan_right|static"}}]
}}
Return exactly {len(script['scenes'])} scenes in order."""
    return _ask("art_director", system, user, {"style": channel_style, "characters": [], "scenes": []},
                max_tokens=32000)


# ---------- marketing ----------

def marketing(script, idea, language, brand=None):
    system = """You are a YouTube growth marketer. You maximise CTR without clickbait lies: curiosity gap,
specific numbers, emotion, short punchy titles, thumbnail with ONE clear subject and 2-4 words.
Reply with JSON only."""
    user = f"""Idea: {idea}
Language of the video: {language} (title, description and comment in this language)
Script summary: {_script_text(script, 12000)}
{_brand_text(brand)}
JSON: {{
 "titles": ["5 title variants, <= 70 chars"],
 "best_title": "the one you'd ship",
 "description": "first 2 lines hook the viewer, then a short summary, chapters are not needed",
 "thumbnail_prompt": "English prompt for the thumbnail image: one subject, strong emotion, contrast, no text",
 "thumbnail_text": "2-4 words",
 "pinned_comment": "question that makes people comment"
}}"""
    return _ask("marketer", system, user, {})


def tagging(title, idea, language):
    system = """You are a YouTube SEO specialist. Search the web for what people currently search on
YouTube/Google around this topic and pick tags that real people type. Reply with JSON only."""
    user = f"""Video title: {title}
Idea: {idea}
Language: {language}
JSON: {{"tags": ["15-25 tags, mix of broad and long-tail, total under 450 characters"],
        "hashtags": ["3 hashtags starting with #"]}}"""
    return _ask("tagger", system, user, {})


# ---------- channel brief (shared by researcher and director) ----------

def channel_brief(channel, report=None):
    """Everything the planning team should know about a channel, as plain text."""
    brand = channel.get("brand") or {}
    hero = brand.get("hero") or {}
    seconds = {"calm": 11, "dynamic": 4}.get(channel.get("pacing"), 11)
    minutes = round((channel.get("scene_count") or 20) * seconds / 60)
    lines = [
        f"Channel: {channel.get('name')}",
        f"Niche: {channel.get('niche') or channel.get('name')}",
        f"Video language / audience: {channel.get('language') or 'English'}",
        f"Format: {channel.get('aspect', '16:9')} video, about {minutes} min, faceless animated explainer",
    ]
    if brand:
        lines.append(f"Visual brand: {brand.get('style_name', '')} — {brand.get('style_prompt', '')[:300]}")
    if hero.get("name"):
        lines.append(f"Recurring mascot (stars in every video): {hero['name']} — {hero.get('description', '')}")
    if report:
        if report.get("what_works"):
            lines.append("What works on this channel: " + "; ".join(report["what_works"]))
        if report.get("what_fails"):
            lines.append("What fails: " + "; ".join(report["what_fails"]))
        if report.get("next_topics"):
            lines.append("Analyst's suggested next topics: " + "; ".join(report["next_topics"]))
    return "\n".join(lines)


# ---------- director ----------

def director_plan(channel, ideas, report, recent):
    system = """You are the director of a YouTube media company that runs several faceless channels.
You decide what the team produces next to grow views and revenue. Be decisive, data-driven, think about
what already worked on this channel. Reply in JSON only; reasoning in Russian."""
    user = f"""{channel_brief(channel)}
Recent videos with stats (title, views, age): {json.dumps(recent, ensure_ascii=False)[:6000]}
Channel analyst report: {json.dumps(report or {}, ensure_ascii=False)[:6000]}
Ideas proposed by the trend researcher: {json.dumps(ideas, ensure_ascii=False)[:8000]}

Pick the single best idea (you may improve it). JSON:
{{"decision": "почему это видео (рус.)", "title": "English title", "idea": "English premise, 2-3 sentences",
  "notes_for_team": "English instructions for writer/art director: angle, hook, tone, what to avoid",
  "scene_count": number or null}}"""
    first = (ideas or [{}])[0]
    return _ask("director", system, user, {
        "decision": "Демо: беру первую идею исследователя.", "title": first.get("title", "Demo video"),
        "idea": first.get("idea", ""), "notes_for_team": "", "scene_count": None})


# ---------- channel analyst ----------

def analyst_report(channel, videos, hour_stats, best_hours):
    system = """You are a YouTube channel analyst. From the stats find what works (topics, titles,
length), what fails, and when to publish. Reply in JSON only, text in Russian."""
    user = f"""Channel: {channel.get('name')} — niche: {channel.get('niche')}
Videos (title, views, likes, comments, hours since publish, views per day, local publish hour, weekday):
{json.dumps(videos, ensure_ascii=False)[:12000]}
Average views/day by local publish hour: {json.dumps(hour_stats)}
Best hours by the numbers: {best_hours}

JSON: {{"summary": "...", "what_works": ["..."], "what_fails": ["..."], "recommendations": ["..."],
"best_hours": [local hours 0-23, 1-3 items], "next_topics": ["English topic ideas based on winners"]}}"""
    return _ask("analyst", system, user, {
        "summary": "Демо: данных нет.", "what_works": [], "what_fails": [], "recommendations": [],
        "best_hours": best_hours, "next_topics": []})


# ---------- channel stylist ----------

def channel_style(channel, wish="", preset=None):
    system = """You are the brand stylist of a faceless YouTube channel. You design one consistent visual
identity so every video, thumbnail, banner and avatar instantly reads as the same channel. Be concrete:
image models need precise prompts. Reply in JSON only; explanations in Russian, prompts in English."""
    user = f"""Channel: {channel.get('name')}
Niche: {channel.get('niche')}
Language of videos: {channel.get('language')}
Owner's wish / reference description: {wish or '(none)'}
Base style to build on: {(preset or {}).get('prompt') or channel.get('style') or '(choose the best for the niche)'}

JSON: {{
 "style_name": "short name of the style",
 "why": "почему этот стиль подходит нише (рус.)",
 "style_prompt": "English style prompt used for EVERY video frame (medium, line, palette, lighting, mood)",
 "palette": ["#hex", "#hex", "#hex", "#hex"],
 "hero": {{"name": "...", "description": "English visual description of the recurring mascot character; if the owner wants no character (e.g. a music or ambience channel), the channel's visual symbol instead"}},
 "thumbnail_rules": ["правила превью канала (рус.), 4-6 пунктов"],
 "channel_names": ["5 English channel name ideas"],
 "description": "English channel description for the About section, 2 short paragraphs",
 "keywords": ["10 channel keywords"],
 "banner_prompt": "English prompt for a 16:9 channel banner in this style; important content centered, no text",
 "avatar_prompt": "English prompt for a square channel avatar: the hero's face (or the channel symbol if there is no character), bold, readable when tiny, no text"
}}"""
    demo = {
        "style_name": (preset or {}).get("name", "Demo style"), "why": "Демо-режим.",
        "style_prompt": (preset or {}).get("prompt") or channel.get("style") or "flat 2D cartoon",
        "palette": ["#FAF6E6", "#1B1B1B", "#8B5A2B", "#D7263D"],
        "hero": {"name": "Ug", "description": "stick-figure caveman with messy brown hair and a fur tunic"},
        "thumbnail_rules": ["Один герой крупно", "2–3 слова красным маркером"], "channel_names": ["Stick History"],
        "description": "Demo description", "keywords": ["history"],
        "banner_prompt": "caveman by a fire, wide landscape", "avatar_prompt": "caveman face",
    }
    return _ask("stylist", system, user, demo)


# ---------- hero check (vision) ----------

def compare_character(reference_path, candidate_path, name, description):
    """Is the character in the candidate image the same as in the reference? -> {"score", "same", "differences"}"""
    from . import images
    content = [
        {"type": "text", "text": (
            f"Image 1 is the official reference of the channel mascot {name}: {description}.\n"
            f"Image 2 is a new picture. Is {name} in image 2 the same character as in image 1 "
            "(same face shape, hair, clothes, colors, proportions and drawing style)? Ignore pose, "
            "angle, background and other characters. If {name} is not in image 2 at all, score 0.\n"
            # A short verdict, no reasoning: the answer is a handful of tokens, the cost is the two images.
            'Reply with JSON only, no explanation: {"score": 0-10, "differences": "до 8 слов на русском, '
            'пусто если похож"}')},
        {"type": "image_url", "image_url": {"url": images.small_data_url(reference_path)}},
        {"type": "image_url", "image_url": {"url": images.small_data_url(candidate_path)}},
    ]
    try:
        reply = llm.chat([{"role": "user", "content": content}], role="art_director", temperature=0,
                         max_tokens=300, effort="minimal")
        out = llm.extract_json(reply)
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        return {"score": 10, "same": True, "differences": "демо"}
    out["score"] = int(out.get("score") or 0)
    out["same"] = out["score"] >= 6
    return out
