"""AI scriptwriter: reference analysis, ideas, full scripts, niche search."""
import json

from . import llm

SCRIPT_SYSTEM = """You are a senior YouTube scriptwriter for faceless animated storytelling channels
that get millions of views (styles like "what if", history explained, "how X survived",
money/psychology explainers with a simple cartoon hero).

Write scripts that:
- open with a 1-2 sentence hook that creates curiosity in the first 5 seconds;
- keep retention with open loops, concrete details, second person ("you") where it fits;
- are factually careful, never invent fake statistics as facts;
- are split into scenes; every scene = narration + one still image.

Image prompts are in English, describe ONE frame: subject, action, setting, camera angle,
lighting, mood. Do not put any text/letters in images. Reference recurring characters by
their id and keep their look consistent; never re-describe them differently.

Reply with JSON only."""

SCRIPT_FORMAT = """JSON format:
{
  "title": "clickable YouTube title (<= 70 chars)",
  "description": "YouTube description, 2 short paragraphs + 3 hashtags",
  "tags": ["10-15 tags"],
  "style": "global visual style for every image, English, 1-2 sentences",
  "thumbnail_prompt": "English prompt for an eye-catching 16:9 thumbnail, no text",
  "thumbnail_text": "2-4 word overlay text for the thumbnail",
  "characters": [
    {"id": "hero", "name": "Name", "description": "detailed visual description in English: age, body, face, hair, clothes, colors"}
  ],
  "scenes": [
    {"narration": "voice-over text in the video language", "image_prompt": "English frame description", "characters": ["hero"]}
  ]
}"""

PACING = {
    "calm": "Each scene narration is 2-4 sentences (about 8-15 seconds of speech).",
    "dynamic": "Each scene narration is ONE short sentence or phrase (about 2-5 seconds). Many fast cuts.",
}


def write_script(idea, language="English", scene_count=20, pacing="calm", style="", reference="",
                 feedback="", previous=None):
    user = f"""Video idea: {idea}

Video language (narration): {language}
Number of scenes: exactly {scene_count}
Pacing: {PACING.get(pacing, PACING['calm'])}
"""
    if style:
        user += f"Visual style to use: {style}\n"
    if reference:
        user += f"\nCompetitor reference to learn structure/tone from (do not copy text):\n{reference[:12000]}\n"
    if previous and feedback:
        user += (f"\nYour previous draft:\n{json.dumps(previous, ensure_ascii=False)[:30000]}\n"
                 f"\nChief editor feedback — fix all of it in the new version:\n{feedback}\n")
    user += "\n" + SCRIPT_FORMAT
    try:
        script = llm.chat_json(SCRIPT_SYSTEM, user, temperature=0.9, role="writer", max_tokens=16000)
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        script = demo_script(idea, scene_count)
    return normalize_script(script)


def normalize_script(script):
    chars = []
    for i, c in enumerate(script.get("characters") or []):
        chars.append({
            "id": str(c.get("id") or f"char{i + 1}"),
            "name": c.get("name") or f"Персонаж {i + 1}",
            "description": c.get("description", ""),
            "image": None,
        })
    ids = {c["id"] for c in chars}
    scenes = []
    for i, s in enumerate(script.get("scenes") or []):
        scenes.append({
            "idx": i,
            "narration": (s.get("narration") or "").strip(),
            "image_prompt": (s.get("image_prompt") or "").strip(),
            "characters": [c for c in (s.get("characters") or []) if c in ids],
            "image": None,
            "audio": None,
            "words": [],
            "duration": None,
            "status": "idle",
            "error": None,
        })
    return {
        "title": script.get("title", "Untitled"),
        "description": script.get("description", ""),
        "tags": script.get("tags", []),
        "style": script.get("style", ""),
        "thumbnail_prompt": script.get("thumbnail_prompt", ""),
        "thumbnail_text": script.get("thumbnail_text", ""),
        "characters": chars,
        "scenes": scenes,
    }


ANALYZE_SYSTEM = """You analyze viral YouTube videos for a faceless channel creator.
Explain in Russian why the reference works (hook, structure, visual style, pacing, audience)
and propose new video ideas in the same format that could get similar views without copying.
Reply with JSON only."""


def analyze_reference(reference_text, niche="", count=8):
    user = f"""Reference video (title, description, transcript):
{reference_text[:15000]}

Channel niche (optional): {niche}

JSON format:
{{
  "analysis": "разбор на русском: почему видео набрало просмотры, структура, хук, стиль картинок, темп",
  "style": "English visual style prompt that reproduces the reference look",
  "ideas": [
    {{"title": "English YouTube title", "idea": "1-2 sentence English premise", "hook": "first line of narration", "why": "почему зайдёт (рус.)"}}
  ]
}}
Give {count} ideas."""
    try:
        return llm.chat_json(ANALYZE_SYSTEM, user, role="ref_analyst")
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        return demo_ideas(niche or "history")


def ideas_for_niche(niche, count=8, avoid=()):
    avoid_txt = "\n".join(f"- {t}" for t in list(avoid)[-60:])
    user = f"""Niche: {niche}
Search the web for what is trending right now in this niche on YouTube (recent viral videos,
rising search queries, news hooks). Propose {count} new viral video ideas for an English-speaking (US) audience.
Do not repeat these existing titles:
{avoid_txt or '(none)'}

JSON format:
{{"analysis": "кратко про нишу (рус.)", "style": "English visual style prompt",
  "ideas": [{{"title": "...", "idea": "...", "hook": "...", "why": "почему зайдёт (рус.)"}}]}}"""
    try:
        return llm.chat_json(ANALYZE_SYSTEM, user, role="researcher")
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        return demo_ideas(niche)


NICHE_SYSTEM = """You are a YouTube market researcher for faceless AI-generated channels
targeting high-RPM audiences (US, UK, CA, AU). Reply in Russian, JSON only."""


def find_niches(query, count=10):
    user = f"""Запрос: {query or 'лучшие ниши для faceless-каналов с AI-анимацией'}
Предложи {count} ниш. JSON:
{{"niches": [{{
  "name": "название", "description": "о чём каналы", "audience": "кто смотрит",
  "rpm": "примерный RPM в $", "competition": "низкая/средняя/высокая",
  "format": "длина и формат видео", "style": "English visual style prompt",
  "example_titles": ["3 примера заголовков на английском"]
}}]}}"""
    try:
        return llm.chat_json(NICHE_SYSTEM, user, role="researcher")
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        return {"niches": [{
            "name": "История выживания древних людей", "description": "Как жили люди без технологий",
            "audience": "мужчины 18-45, США", "rpm": "$4-8", "competition": "средняя",
            "format": "8-15 минут, мультяшный герой", "style": "flat 2D cartoon, soft colors",
            "example_titles": ["How Ancient People Survived Winter", "How Cavemen Found Water",
                               "Why Ancient People Never Got Lost"],
        }]}


# ---------- demo mode (no API key) ----------

def demo_ideas(niche):
    titles = [
        "How Ancient People Navigated Without Maps",
        "What If You Woke Up in 10,000 BC?",
        "How Much You Need Invested to Never Work Again",
        "The Debt That Grows While You Sleep",
        "How Cavemen Survived Their First Winter",
    ]
    return {
        "analysis": "Демо-режим: добавьте ключ OpenRouter в Настройках, чтобы получить настоящий разбор.",
        "style": "simple flat 2D cartoon, thick outlines, warm muted colors, soft lighting",
        "ideas": [{"title": t, "idea": t, "hook": "Imagine this...", "why": "демо"} for t in titles],
    }


def demo_script(idea, scene_count):
    lines = [
        "Imagine waking up in a world with no maps, no roads and no signs.",
        "Yet ancient people crossed deserts, forests and oceans without getting lost.",
        "Their secret was not magic. It was attention.",
        "They read the sun, the stars and even the wind.",
        "And the most surprising tool of all was memory.",
    ]
    scenes = []
    for i in range(scene_count):
        scenes.append({
            "narration": lines[i % len(lines)],
            "image_prompt": f"Scene {i + 1}: a caveman walking through a wide landscape",
            "characters": ["hero"],
        })
    return {
        "title": idea[:70] or "Demo video",
        "description": "Demo description",
        "tags": ["demo"],
        "style": "flat 2D cartoon",
        "thumbnail_prompt": "caveman looking at the stars",
        "thumbnail_text": "NO MAPS?",
        "characters": [{"id": "hero", "name": "Grok", "description": "bearded caveman in orange fur"}],
        "scenes": scenes,
    }
