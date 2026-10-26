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
    slim = {k: script.get(k) for k in ("title", "characters", "style")}
    slim["scenes"] = [{"n": s["idx"] + 1, "narration": s["narration"], "image_prompt": s["image_prompt"],
                       "characters": s["characters"]} for s in script["scenes"]]
    for c in slim["characters"] or []:
        c.pop("image", None)
    return json.dumps(slim, ensure_ascii=False)[:limit]


# ---------- chief editor ----------

def review_script(script, idea, language):
    system = """You are the chief editor of a YouTube studio whose faceless videos get millions of views.
Review the script brutally but fairly: the hook in the first 5 seconds, open loops and retention,
pacing, clarity, factual accuracy (flag invented statistics), emotional payoff, ending with a reason to
watch the next video. Reply in JSON only; feedback text in Russian, fixes in English."""
    user = f"""Video idea: {idea}
Narration language: {language}
Script:
{_script_text(script)}

JSON: {{"score": 1-10, "verdict": "коротко на русском", "strengths": ["..."], "problems": ["..."],
"fixes": "concrete instructions for the writer in English"}}"""
    return _ask("editor", system, user,
                {"score": 9, "verdict": "Демо: сценарий принят без проверки.", "strengths": [], "problems": [], "fixes": ""})


# ---------- art director ----------

def art_direction(script, channel_style, aspect):
    system = """You are the art director of an animated YouTube channel. You write a style bible and
production-ready image prompts for an image model (Gemini image / similar). Keep the same characters
looking identical in every frame. Each frame must be a single clear composition that illustrates the
narration literally, with readable emotion, no text in the image. Choose a camera move for each still
so the video feels animated: zoom_in (tension, focus), zoom_out (reveal), pan_left / pan_right
(travel, landscapes), static (dialogue, simple moments). Reply with JSON only."""
    user = f"""Channel visual style (must follow): {channel_style or 'decide yourself, fitting the topic'}
Frame aspect: {aspect}
Script:
{_script_text(script)}

JSON: {{
 "style": "style bible in one paragraph: medium, line, palette, lighting, mood (English)",
 "characters": [{{"id": "same id as in script", "description": "precise visual description to keep identical"}}],
 "scenes": [{{"n": 1, "image_prompt": "detailed English prompt", "camera": "zoom_in|zoom_out|pan_left|pan_right|static"}}]
}}
Return exactly {len(script['scenes'])} scenes in order."""
    return _ask("art_director", system, user, {"style": channel_style, "characters": [], "scenes": []},
                max_tokens=16000)


# ---------- marketing ----------

def marketing(script, idea, language):
    system = """You are a YouTube growth marketer. You maximise CTR without clickbait lies: curiosity gap,
specific numbers, emotion, short punchy titles, thumbnail with ONE clear subject and 2-4 words.
Reply with JSON only."""
    user = f"""Idea: {idea}
Language of the video: {language} (title, description and comment in this language)
Script summary: {_script_text(script, 12000)}

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


# ---------- director ----------

def director_plan(channel, ideas, report, recent):
    system = """You are the director of a YouTube media company that runs several faceless channels.
You decide what the team produces next to grow views and revenue. Be decisive, data-driven, think about
what already worked on this channel. Reply in JSON only; reasoning in Russian."""
    user = f"""Channel: {channel.get('name')}
Niche: {channel.get('niche')}
Visual style: {channel.get('style')}
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
