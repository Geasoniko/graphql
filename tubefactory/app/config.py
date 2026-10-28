"""Paths and user settings.

Settings live in data/settings.json (edited from the UI) and can be
overridden with environment variables of the same name in upper case,
e.g. OPENROUTER_API_KEY.
"""
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("TUBEFACTORY_DATA", ROOT / "data"))
PROJECTS = DATA / "projects"
CHANNELS_DIR = DATA / "channels"
WEB = ROOT / "web"

for _d in (DATA, PROJECTS, CHANNELS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DEFAULTS = {
    # OpenRouter: one key for every text and image model.
    "openrouter_api_key": "",
    "text_model": "anthropic/claude-sonnet-5.5",
    "fast_text_model": "google/gemini-3.8-flash",
    "image_model": "google/gemini-3.1-flash-image",
    # Voice: edge (free Microsoft voices), openrouter, openai, elevenlabs.
    "tts_provider": "edge",
    "openrouter_tts_model": "openai/gpt-4o-mini-tts-2025-12-15",
    "openai_api_key": "",
    "openai_tts_model": "gpt-4o-mini-tts",
    "elevenlabs_api_key": "",
    "elevenlabs_model": "eleven_multilingual_v2",
    # Rendering.
    "image_workers": 4,
    "fps": 30,
    "subtitles": True,
    "ken_burns": True,
    "hero_check": True,  # a vision model checks the mascot on every frame (~$0.001 per frame)
    # Chief editor: the script must score at least this to go on; rewrites allowed to get there.
    "min_script_score": 8,
    "max_rewrites": 3,
    # Stop a video when its OpenRouter spend passes this many dollars (0 = no limit).
    "video_budget": 1.0,
    "background_music": "",  # path to an mp3 mixed under the voice
    "music_volume": 0.12,
    # YouTube: OAuth client from Google Cloud Console (Desktop app).
    "youtube_client_secret": str(DATA / "client_secret.json"),
    # Without any API key the app runs in demo mode with placeholder
    # script, images and voice so the whole pipeline can be tried offline.
    "demo_mode": False,
    # Per-agent model overrides from the "Компания" page: {role: {"model": "..."}}.
    "agents": {},
}

_lock = threading.Lock()
_SETTINGS_FILE = DATA / "settings.json"


def load_settings():
    with _lock:
        data = dict(DEFAULTS)
        if _SETTINGS_FILE.exists():
            data.update(json.loads(_SETTINGS_FILE.read_text("utf-8")))
    for key in DEFAULTS:
        env = os.environ.get(key.upper())
        if env is not None and not isinstance(DEFAULTS[key], dict):
            default = DEFAULTS[key]
            if isinstance(default, bool):
                env = env.lower() in ("1", "true", "yes")
            elif isinstance(default, int) and not isinstance(default, bool):
                env = int(env)
            elif isinstance(default, float):
                env = float(env)
            data[key] = env
    return data


def save_settings(patch):
    with _lock:
        data = {}
        if _SETTINGS_FILE.exists():
            data = json.loads(_SETTINGS_FILE.read_text("utf-8"))
        for key, value in patch.items():
            if key in DEFAULTS:
                data[key] = value
        _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    return load_settings()


def is_demo(settings=None):
    s = settings or load_settings()
    return bool(s.get("demo_mode")) or not s.get("openrouter_api_key")


def public_settings():
    """Settings for the UI with secrets masked."""
    s = load_settings()
    out = {}
    for key, value in s.items():
        if key.endswith("_api_key"):
            out[key] = ("•" * 8 + value[-4:]) if value else ""
        else:
            out[key] = value
    out["demo_active"] = is_demo(s)
    return out
