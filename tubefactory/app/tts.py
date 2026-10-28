"""Voice-over: edge-tts (free), Kokoro (free, local), OpenRouter, OpenAI or ElevenLabs.

synthesize() writes an mp3 and returns word timings
[{"start": s, "end": s, "text": w}] used for subtitles. Providers without
timings get them from Whisper when that module is installed, otherwise
they are estimated from word length.
"""
import asyncio
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

import requests

from . import align, system
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
KOKORO_VOICES = [
    ("am_michael", "Kokoro — Michael, мужской (US)"),
    ("am_fenrir", "Kokoro — Fenrir, мужской, низкий (US)"),
    ("am_puck", "Kokoro — Puck, мужской, живой (US)"),
    ("bm_george", "Kokoro — George, мужской (UK)"),
    ("bm_fable", "Kokoro — Fable, мужской, рассказчик (UK)"),
    ("af_heart", "Kokoro — Heart, женский (US), лучший"),
    ("af_bella", "Kokoro — Bella, женский (US)"),
    ("bf_emma", "Kokoro — Emma, женский (UK)"),
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


_kokoro = {}
_kokoro_worker = {"proc": None, "lock": threading.Lock()}


def _kokoro_in_worker(text, voice, wav):
    """Kokoro in a separate Python 3.10-3.12 process, started once and reused."""
    w = _kokoro_worker
    with w["lock"]:
        if w["proc"] is None or w["proc"].poll() is not None:
            cmd = system.kokoro_python()
            if not cmd:
                raise RuntimeError("Kokoro не установлен: Настройки → Ноутбук и модули → Установить")
            worker = Path(__file__).with_name("kokoro_worker.py")
            w["proc"] = subprocess.Popen([*cmd, str(worker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
            hello = w["proc"].stdout.readline()
            if "ready" not in hello:
                w["proc"] = None
                raise RuntimeError("Kokoro не запустился — переустановите его в Настройках")
        w["seq"] = job_id = w.get("seq", 0) + 1
        w["proc"].stdin.write(json.dumps({"id": job_id, "text": text, "voice": voice, "out": str(wav)}) + "\n")
        w["proc"].stdin.flush()
        while True:  # skip anything that isn't the answer to this very job
            line = w["proc"].stdout.readline()
            if not line:
                w["proc"] = None
                raise RuntimeError("Kokoro остановился — нажмите «Продолжить генерацию»")
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if isinstance(reply, dict) and reply.get("id") == job_id:
                break
    if "error" in reply:
        raise RuntimeError(f"Kokoro: {reply['error']}")
    if not os.path.exists(wav):
        raise RuntimeError("Kokoro не записал файл озвучки — нажмите «Продолжить генерацию»")


def _kokoro_tts(text, voice, path):
    """Local Kokoro-82M: in this Python when it can import kokoro, else in the worker."""
    if voice not in dict(KOKORO_VOICES):
        voice = "am_michael"
    wav = str(path) + ".wav"
    if system.has("kokoro"):
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline

        lang = voice[0]
        if lang not in _kokoro:
            _kokoro[lang] = KPipeline(lang_code=lang)
        chunks = [np.asarray(audio) for _, _, audio in _kokoro[lang](text, voice=voice, speed=1.0)]
        sf.write(wav, np.concatenate(chunks), 24000)
    else:
        _kokoro_in_worker(text, voice, wav)
    done = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, "-c:a", "libmp3lame", "-q:a", "2", str(path)],
                          capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"ffmpeg не смог сохранить озвучку: {done.stderr.strip()[-300:]}")
    os.remove(wav)
    return None


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


# Premade ElevenLabs voices, used when the account's list can't be fetched.
ELEVEN_DEFAULT = [
    ("JBFqnCBsd6RMkjVDRZzb", "George — британский рассказчик"),
    ("onwK4e9ZLuTAKqWW03F9", "Daniel — британский, новостной"),
    ("nPczCjzI2devNBz1zQrb", "Brian — американский, глубокий"),
    ("pNInz6obpgDQGcFmaJgB", "Adam — американский, низкий"),
    ("21m00Tcm4TlvDq8ikWAM", "Rachel — американский, женский"),
]
_eleven_cache = {"at": 0, "key": None, "voices": None}


def elevenlabs_voices(settings):
    """Voices of the user's ElevenLabs account (cached 10 min), or the premade list."""
    key = settings.get("elevenlabs_api_key")
    c = _eleven_cache
    if key and (c["key"] != key or time.time() - c["at"] > 600):
        try:
            r = requests.get("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": key}, timeout=15)
            r.raise_for_status()
            out = []
            for v in r.json().get("voices", []):
                labels = v.get("labels") or {}
                extra = ", ".join(x for x in (labels.get("accent"), labels.get("gender"), labels.get("description")) if x)
                out.append((v["voice_id"], f"{v['name']}" + (f" — {extra}" if extra else "")))
            c.update(at=time.time(), key=key, voices=out or None)
        except (requests.RequestException, KeyError, ValueError):
            c.update(at=time.time(), key=key, voices=None)
    return c["voices"] or ELEVEN_DEFAULT


def _elevenlabs(text, voice, path, settings):
    import base64
    known = dict(elevenlabs_voices(settings))
    if voice not in known and not re.fullmatch(r"[A-Za-z0-9]{20}", voice or ""):
        voice = next(iter(known))  # e.g. an Edge voice name left from another service
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


def synthesize(text, voice, path, provider=None):
    """provider: the channel's voice service; empty means the one chosen in Settings."""
    settings = load_settings()
    provider = provider or settings["tts_provider"]
    text = re.sub(r"\s+", " ", text).strip()
    words = None
    if is_demo(settings) and provider == "edge" and settings.get("demo_mode"):
        _demo(text, path)
    elif provider == "kokoro":
        words = _kokoro_tts(text, voice, path)
    elif provider == "openrouter" and settings.get("openrouter_api_key"):
        words = _openrouter(text, voice, path, settings)
    elif provider == "openai" and settings.get("openai_api_key"):
        words = _openai(text, voice, path, settings)
    elif provider == "elevenlabs" and settings.get("elevenlabs_api_key"):
        words = _elevenlabs(text, voice, path, settings)
    else:
        if not re.fullmatch(r"[a-z]{2,3}-[A-Z]{2}-\w+Neural", voice or ""):
            voice = "en-US-AndrewNeural"  # a voice id from another service
        try:
            words = _edge(text, voice, path)
        except Exception:
            if not is_demo(settings):
                raise
            _demo(text, path)
    total = duration(path)
    if not words and align.available():
        try:
            words = align.word_timings(path, text)
        except Exception:
            words = None  # alignment is a bonus; never fail the voice-over over it
    if not words:
        words = estimate_words(text, total)
    return words, total


def available_providers(settings):
    """Voice services usable right now, for the voice gallery."""
    from . import system
    out = ["edge"]
    if system.installed("kokoro"):
        out.append("kokoro")
    if settings.get("elevenlabs_api_key"):
        out.append("elevenlabs")
    if settings.get("openrouter_api_key"):
        out.append("openrouter")
    if settings.get("openai_api_key"):
        out.append("openai")
    return out
