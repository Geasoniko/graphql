"""Cost estimate of one video before it is made.

Token budgets per agent scale with the number of scenes; prices come from
the live OpenRouter catalogue (cached for an hour) and fall back to the
October 2026 list prices below when the catalogue is unreachable.
"""
import threading
import time

from . import agents, llm
from .config import is_demo

# $ per token (input, output) — fallback when the catalogue can't be fetched.
FALLBACK = {
    "anthropic/claude-sonnet-5.5": (2e-6, 10e-6),
    "anthropic/claude-opus-5.5": (4e-6, 20e-6),
    "anthropic/claude-haiku-5.5": (0.1e-6, 0.5e-6),
    "google/gemini-3.8-flash": (0.75e-6, 3.75e-6),
    "google/gemini-3.1-pro-preview": (2e-6, 12e-6),
    "openai/gpt-5.5": (5e-6, 30e-6),
    "google/gemini-3.1-flash-image": (0.5e-6, 60e-6),
    "google/gemini-3.1-flash-image-preview": (0.5e-6, 60e-6),
    "google/gemini-3.1-flash-lite-image": (0.25e-6, 30e-6),
}
DEFAULT_PRICE = (2e-6, 10e-6)
# Image models billed per picture (≈1920x1080 output), from OpenRouter's model pages.
PER_IMAGE = {
    "qwen/qwen-image-3": 0.03,
    "qwen/qwen-image-2.1-turbo": 0.0184,
    "bytedance-seed/seedream-5-0-flash": 0.018,
    "bytedance-seed/seedream-4.5": 0.04,
    "black-forest-labs/flux.2-klein-4b": 0.015,
    "black-forest-labs/flux-3-image-klein": 0.009,
    "sourceful/riverflow-v2-fast": 0.02,
}
# When a video would go over its limit, the illustrator steps down this ladder (best first)
# to the first model whose pictures fit the money left.
IMAGE_LADDER = [
    "google/gemini-3.1-flash-image",
    "google/gemini-3.1-flash-lite-image",
    "qwen/qwen-image-2.1-turbo",
    "black-forest-labs/flux-3-image-klein",
]
HERO_CHECK = 0.003        # one vision comparison of a frame with the hero reference
IMAGE_TOKENS = 1290       # output tokens of one ~1K image on Gemini image models
WEB_SEARCH = 0.03         # OpenRouter web plugin, ~8 results per call
REWRITE_SHARE = 0.5       # how often the chief editor sends a script back

_cache = {"at": 0, "prices": {}, "failed_at": 0}
_lock = threading.Lock()


def _catalogue():
    with _lock:
        if time.time() - _cache["at"] < 3600:
            return _cache["prices"]
        if time.time() - _cache["failed_at"] < 600 or is_demo():
            return {}
    try:
        prices = {}
        for m in llm.list_models(timeout=8):
            try:
                prices[m["id"]] = (float(m.get("prompt_price") or 0), float(m.get("completion_price") or 0),
                                   float(m.get("image_price") or 0))
            except (TypeError, ValueError):
                continue
    except Exception:
        with _lock:
            _cache["failed_at"] = time.time()
        return {}
    with _lock:
        _cache.update(at=time.time(), prices=prices)
    return prices


def price(model):
    """(input $/token, output $/token, $ per image or 0)."""
    live = _catalogue()
    for m in agents.candidates(model):
        if m in live:
            return live[m]
    for m in agents.candidates(model):
        if m in FALLBACK:
            return (*FALLBACK[m], 0)
        if m in PER_IMAGE:
            return (0, 0, PER_IMAGE[m])
    return (*DEFAULT_PRICE, 0)


def _text(role, tokens_in, tokens_out):
    pin, pout, _ = price(agents.model_for(role))
    cost = tokens_in * pin + tokens_out * pout
    if agents.ROLES[role].get("web"):
        cost += WEB_SEARCH
    return cost


def per_image(model):
    pin, pout, flat = price(model)
    return flat or (IMAGE_TOKENS * pout + 1500 * pin)


def _images(role, count, model=None):
    return count * per_image(model or agents.model_for(role))


def fit_image_model(count, money, current):
    """The best image model whose `count` pictures cost at most `money`
    (the cheapest one if none fits). Never steps up from `current`."""
    top = per_image(current)
    ladder = [current] + sorted((m for m in IMAGE_LADDER if per_image(m) < top), key=per_image, reverse=True)
    for m in ladder:
        if count * per_image(m) <= money:
            return m
    return ladder[-1]


def estimate(scene_count, characters=2, planned=True, image_model=None):
    """Expected $ for a whole video, total and per agent."""
    n = max(int(scene_count or 1), 1)
    script_tokens = 220 * n + 600
    by_role = {
        "writer": _text("writer", 2500, script_tokens) * (1 + REWRITE_SHARE),
        "editor": _text("editor", script_tokens + 1200, 1200),
        "art_director": _text("art_director", script_tokens + 1500, 160 * n + 600),
        "marketer": _text("marketer", 120 * n + 1200, 900),
        "tagger": _text("tagger", 600, 500),
        "illustrator": _images("illustrator", n + characters, image_model),
        "thumbnail": _images("thumbnail", 1),
    }
    if planned:
        by_role["researcher"] = _text("researcher", 1500, 1500)
        by_role["director"] = _text("director", 4000, 700)
    by_role = {k: round(v, 4) for k, v in by_role.items()}
    return {"total": round(sum(by_role.values()), 2), "by_role": by_role,
            "live_prices": bool(_cache["prices"])}
