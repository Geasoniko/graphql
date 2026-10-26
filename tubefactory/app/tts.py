"""Voice-over: edge-tts (free), OpenAI TTS or ElevenLabs.

synthesize() writes an mp3 and returns word timings
[{"start": s, "end": s, "text": w}] used for subtitles. Providers without
timings get them estimated from word length.
"""
import asyncio
import os
import re
import subprocess

import requests

from .config import is_demo, load_settings

EDGE_VOICES = [
    ("en-US-AndrewNeural", "English (US) — Andrew, мужской, тёплый"),
    ("en-US-ChristopherNeural", "English (US) — Christopher, мужской, документальный"),
    ("en-US-GuyNeural", "English (US) — Guy, мужской"),
    ("en-US-BrianNeural", "English (US) — Brian, мужской, спокойный"),
    ("en-US-AriaNeural", "English (US) — Aria, женский"),
    ("en-US-JennyNeural", "English (US) — Jenny, женский"),
    ("en-GB-RyanNeural", "English (UK) — Ryan, мужской"),
    ("ru-RU-DmitryNeural", "Русский — Дмитрий"),
    ("ru-RU-SvetlanaNeural", "Русский — Светлана"),
    ("kk-KZ-DauletNeural", "Қазақша — Дәулет"),
    ("kk-KZ-AigulNeural", "Қазақша — Айгүл"),
    ("es-MX-JorgeNeural", "Español — Jorge"),
    ("de-DE-ConradNeural", "Deutsch — Conrad"),
]
OPENAI_VOICES = ["onyx", "echo", "alloy", "ash", "ballad", "coral", "fable", "nova", "sage", "shimmer"]


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def estimate_words(text, total):
    words = text.split()
    if not words:
        return []
    weights = [len(w) + 2 for w in words]
    scale = total / sum(weights)
    t, out = 0.0, []
    for w, k in zip(words, weights):
        out.append({"start": round(t, 3), "end": round(t + k * scale, 3), "text": w})
        t += k * scale
    return out


def _edge(text, voice, path, rate="+0%"):
    import edge_tts

    async def run():
        words = []
        comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary",
                                    proxy=os.environ.get("HTTPS_PROXY") or None)
        with open(path, "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start = chunk["offset"] / 1e7
                    words.append({"start": round(start, 3),
                                  "end": round(start + chunk["duration"] / 1e7, 3),
                                  "text": chunk["text"]})
        return words

    return asyncio.run(run())


def _openrouter(text, voice, path, settings):
    """OpenRouter's OpenAI-compatible /audio/speech: same key as the rest of the company."""
    if voice not in OPENAI_VOICES:
        voice = "onyx"
    r = requests.post(
        "https://openrouter.ai/api/v1/audio/speech",
        headers={"Authorization": f"Bearer {settings['openrouter_api_key']}"},
        json={"model": settings["openrouter_tts_model"], "voice": voice, "input": text,
              "response_format": "mp3"},
        timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"OpenRouter TTS HTTP {r.status_code}: {r.text[:300]}")
    open(path, "wb").write(r.content)
    return None


def _openai(text, voice, path, settings):
    if voice not in OPENAI_VOICES:
        voice = "onyx"
    r = requests.post(
        "https://api.openai.com/v1/audio/speech",
        headers={"Authorization": f"Bearer {settings['openai_api_key']}"},
        json={"model": settings["openai_tts_model"], "voice": voice, "input": text,
              "response_format": "mp3"},
        timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI TTS HTTP {r.status_code}: {r.text[:300]}")
    open(path, "wb").write(r.content)
    return None


def _elevenlabs(text, voice, path, settings):
    import base64
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps",
        headers={"xi-api-key": settings["elevenlabs_api_key"]},
        json={"text": text, "model_id": settings["elevenlabs_model"]},
        timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    open(path, "wb").write(base64.b64decode(data["audio_base64"]))
    # Character timings -> word timings.
    al = data.get("alignment") or {}
    chars, starts, ends = al.get("characters", []), al.get("character_start_times_seconds", []), \
        al.get("character_end_times_seconds", [])
    words, cur, cur_start, last_end = [], "", None, 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if cur:
                words.append({"start": cur_start, "end": last_end, "text": cur})
            cur, cur_start = "", None
            continue
        if not cur:
            cur_start = s
        cur += ch
        last_end = e
    if cur:
        words.append({"start": cur_start, "end": last_end, "text": cur})
    return words or None


def _demo(text, path):
    # Silent-ish tone with a length proportional to the text.
    secs = max(2.0, len(text.split()) / 2.6)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"sine=frequency=180:duration={secs:.2f}", "-af", "volume=0.05",
                    "-c:a", "libmp3lame", "-q:a", "6", str(path)], check=True)


def synthesize(text, voice, path):
    settings = load_settings()
    provider = settings["tts_provider"]
    text = re.sub(r"\s+", " ", text).strip()
    words = None
    if is_demo(settings) and provider == "edge" and settings.get("demo_mode"):
        _demo(text, path)
    elif provider == "openrouter" and settings.get("openrouter_api_key"):
        words = _openrouter(text, voice, path, settings)
    elif provider == "openai" and settings.get("openai_api_key"):
        words = _openai(text, voice, path, settings)
    elif provider == "elevenlabs" and settings.get("elevenlabs_api_key"):
        words = _elevenlabs(text, voice, path, settings)
    else:
        try:
            words = _edge(text, voice, path)
        except Exception:
            if not is_demo(settings):
                raise
            _demo(text, path)
    total = duration(path)
    if not words:
        words = estimate_words(text, total)
    return words, total
