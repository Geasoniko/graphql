"""OpenRouter client: text (scripts, ideas) and image generation.

OpenRouter exposes an OpenAI-compatible /chat/completions endpoint for
hundreds of models. Image models (e.g. google/gemini-2.5-flash-image) are
called through the same endpoint with modalities=["image", "text"] and
return the picture as a base64 data URL in message.images.
"""
import base64
import hashlib
import json
import mimetypes
import re
import time

import requests

from . import agents, company
from .config import DATA, is_demo, load_settings

API = "https://openrouter.ai/api/v1"
CACHE_DIR = DATA / "llm_cache"


class LLMError(RuntimeError):
    pass


# Set once OpenRouter refuses the web search plugin (account/workspace policy);
# from then on agents that would search the web answer from their own knowledge.
_web_blocked = False


def _headers(settings):
    return {
        "Authorization": f"Bearer {settings['openrouter_api_key']}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/tubefactory",
        "X-Title": "TubeFactory",
    }


def _post(payload, settings, timeout=180, role=None):
    payload = {**payload, "usage": {"include": True}}
    backups = agents.candidates(payload["model"])
    if len(backups) > 1:
        payload["models"] = backups
    last = None
    for attempt in range(3):
        try:
            r = requests.post(f"{API}/chat/completions", headers=_headers(settings),
                              json=payload, timeout=timeout)
        except requests.RequestException as e:
            last = str(e)
            time.sleep(2 ** attempt)
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            last = f"HTTP {r.status_code}: {r.text[:300]}"
            time.sleep(2 ** (attempt + 1))
            continue
        if r.status_code == 402:
            raise LLMError("Не хватает денег на OpenRouter: для картинок нужно минимум $1 на балансе. "
                           "Пополните https://openrouter.ai/credits или поднимите/снимите лимит ключа "
                           "на https://openrouter.ai/settings/keys, затем «Продолжить генерацию». "
                           f"(HTTP 402: {r.text[:200]})")
        if r.status_code == 401:
            raise LLMError("OpenRouter не принял ключ: проверьте его в Настройках "
                           f"(HTTP 401: {r.text[:200]})")
        if r.status_code != 200:
            raise LLMError(f"OpenRouter HTTP {r.status_code}: {r.text[:500]}")
        data = r.json()
        if data.get("error"):
            raise LLMError(f"OpenRouter: {data['error']}")
        if role:
            company.add_cost(role, (data.get("usage") or {}).get("cost", 0))
        return data
    raise LLMError(f"OpenRouter недоступен: {last}")


def _cache_file(payload):
    key = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return CACHE_DIR / f"{key[:40]}.json"


def _cached(payload, hours):
    path = _cache_file(payload)
    try:
        hit = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return hit["content"] if time.time() - hit["at"] < hours * 3600 else None


def _remember(payload, content):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_file(payload).write_text(json.dumps({"at": time.time(), "content": content}, ensure_ascii=False),
                                    encoding="utf-8")


def chat(messages, model=None, temperature=0.8, max_tokens=None, fast=False, role=None, cache_hours=0,
         valid=None):
    """role: agent from agents.ROLES — picks its model and books the cost to it.
    cache_hours: answer the very same request from the disk cache for that long, for free
    (trend research, competitor analysis — clicking twice should not pay twice).
    valid: a reply is cached only if valid(reply) is true."""
    settings = load_settings()
    if is_demo(settings):
        raise LLMError("demo")
    if role and not model:
        model = agents.model_for(role)
    model = model or settings["fast_text_model" if fast else "text_model"]
    payload = {"model": model, "messages": messages, "temperature": temperature}
    if cache_hours:
        hit = _cached(payload, cache_hours)
        if hit is not None:
            if role:
                company.feed(role, "ответ из кэша — $0")
            return hit
    key_payload = dict(payload)
    global _web_blocked
    if role in agents.EFFORT:
        payload["reasoning"] = {"effort": agents.EFFORT[role]}
    if role and agents.ROLES.get(role, {}).get("web") and not _web_blocked:
        payload["plugins"] = [{"id": "web", "max_results": 8}]
    if max_tokens:
        payload["max_tokens"] = max_tokens
    started = time.time()
    while True:
        try:
            data = _post(payload, settings, role=role)
            break
        except LLMError as e:
            text = str(e).lower()
            if "reasoning" in payload and "reasoning" in text:
                payload.pop("reasoning")  # this model rejects the effort setting
            elif "plugins" in payload and ("plugin" in text or "'web'" in text or "server tool" in text):
                _web_blocked = True
                company.feed(role, "веб-поиск запрещён в настройках OpenRouter — работаю без него")
                payload.pop("plugins")
            else:
                raise
    took = time.time() - started
    if role and took > 60:
        company.feed(role, f"долго думал: {took:.0f} с ({model})")
    content = data["choices"][0]["message"].get("content") or ""
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content)
    if cache_hours and content and (valid is None or valid(content)):
        _remember(key_payload, content)
    return content


def extract_json(text):
    """Pull the first JSON object/array out of a model reply."""
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise LLMError(f"В ответе нет JSON: {text[:300]}")
    start = min(starts)
    closer = "}" if text[start] == "{" else "]"
    end = text.rfind(closer)
    raw = text[start:end + 1]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Common model slip: trailing commas.
        return json.loads(re.sub(r",\s*([}\]])", r"\1", raw))


def _is_json(text):
    try:
        extract_json(text)
        return True
    except (LLMError, ValueError):
        return False


def chat_json(system, user, **kw):
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    reply = chat(messages, valid=_is_json, **kw)
    try:
        return extract_json(reply)
    except (LLMError, json.JSONDecodeError):
        kw.pop("cache_hours", None)
        messages += [{"role": "assistant", "content": reply},
                     {"role": "user", "content": "Ответ должен быть только валидным JSON без пояснений. Повтори."}]
        return extract_json(chat(messages, **kw))


def _data_url(path):
    mime = mimetypes.guess_type(str(path))[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(open(path, 'rb').read()).decode()}"


# Image-only models (FLUX, Seedream, Qwen Image) refuse modalities ["image", "text"].
_image_only = set()


def _post_image(payload, settings, role):
    """Image models differ in what they accept: adapt the request to the model's complaint and retry."""
    while True:
        try:
            return _post(payload, settings, role=role)
        except LLMError as e:
            text = str(e)
            if "output modalities" in text and payload["modalities"] != ["image"]:
                payload["modalities"] = ["image"]
                _image_only.add(payload["model"])
            elif "image_size" in text and "image_size" in payload["image_config"]:
                payload["image_config"].pop("image_size")  # a model that doesn't take the size hint
            else:
                raise


def generate_image(prompt, references=(), aspect="16:9", model=None, role="illustrator"):
    """Return PNG/JPEG bytes. references: image paths used for character consistency."""
    settings = load_settings()
    if is_demo(settings):
        raise LLMError("demo")
    content = [{"type": "text", "text": prompt}]
    for ref in references:
        content.append({"type": "image_url", "image_url": {"url": _data_url(ref)}})
    model = model or agents.model_for(role) or settings["image_model"]
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "modalities": ["image"] if model in _image_only else ["image", "text"],
        # 1K is plenty for a 1080p video; per-image models bill by resolution tier.
        "image_config": {"aspect_ratio": aspect, "image_size": "1K"},
    }
    for attempt in range(3):
        data = _post_image(payload, settings, role)
        msg = data["choices"][0]["message"]
        for img in msg.get("images") or []:
            url = img.get("image_url", {}).get("url", "")
            if url.startswith("data:"):
                return base64.b64decode(url.split(",", 1)[1])
            if url.startswith("http"):
                return requests.get(url, timeout=120).content
        # Some models occasionally answer with text only; ask again.
        time.sleep(1 + attempt)
    raise LLMError(f"Модель не вернула картинку: {str(msg.get('content'))[:300]}")


def list_models(timeout=30):
    r = requests.get(f"{API}/models", timeout=timeout)
    r.raise_for_status()
    out = []
    for m in r.json()["data"]:
        arch = m.get("architecture", {})
        out.append({
            "id": m["id"],
            "name": m.get("name", m["id"]),
            "input": arch.get("input_modalities", []),
            "output": arch.get("output_modalities", []),
            "prompt_price": m.get("pricing", {}).get("prompt"),
            "completion_price": m.get("pricing", {}).get("completion"),
            "image_price": m.get("pricing", {}).get("image"),
        })
    return out
