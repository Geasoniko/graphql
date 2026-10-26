"""The company staff: every role is an agent with its own OpenRouter model.

Defaults are picked for quality per dollar (October 2026 prices, $ per 1M
input/output tokens):
- Claude Sonnet 5.5 ($2/$10) writes, directs and does marketing: it scores
  within ~1.5 points of Opus 5.5 ($4/$20) on the Artificial Analysis index
  at half the price, and Claude leads the creative writing benchmarks.
- Gemini 3.8 Flash ($0.75/$3.75, 1M context) does the analytic work: chief
  editor (a different model family than the writer catches more), art
  director, reference and channel analysis, trend research with web search.
- Claude Haiku 5.5 ($0.10/$0.50) tags with web search — short, simple job.
- Nano Banana 2 (Gemini 3.1 Flash Image, ~$0.07 per 1K image) draws frames
  and the thumbnail: documented character consistency from reference images,
  half the price of Nano Banana Pro.
Any model can be swapped on the "Компания" page (stored in settings["agents"]),
and the "Проверить модели" button checks every id against the live catalogue.
"""
from .config import load_settings

# kind: "llm" — text model, "image" — image model, "tool" — no model (ffmpeg, TTS, YouTube API).
STAFF = [
    # role, department, emoji, name, default model, kind, duty
    ("director", "Руководство", "👔", "Директор", "anthropic/claude-sonnet-5.5", "llm",
     "Ставит задачи команде: по отчёту аналитика и идеям исследователя решает, какое видео снимать на каждом канале."),
    ("researcher", "Контент", "🔎", "Исследователь ниш и трендов", "google/gemini-3.8-flash", "llm",
     "Ищет в интернете свежие тренды, ниши и темы, которые сейчас набирают просмотры."),
    ("ref_analyst", "Контент", "🧪", "Аналитик референсов", "google/gemini-3.8-flash", "llm",
     "Разбирает видео конкурентов: хук, структура, темп, стиль — почему оно набрало миллионы."),
    ("writer", "Контент", "✍️", "Сценарист", "anthropic/claude-sonnet-5.5", "llm",
     "Пишет сценарий с сильным хуком и удержанием, делит на сцены."),
    ("editor", "Контент", "🧐", "Шеф-редактор", "google/gemini-3.8-flash", "llm",
     "Проверяет сценарий: факты, удержание, хук. Ставит оценку и отправляет на доработку."),
    ("art_director", "Продакшн", "🎨", "Арт-директор", "google/gemini-3.8-flash", "llm",
     "Создаёт стиль-гайд, персонажей, пишет промпты кадров и выбирает движение камеры для анимации."),
    ("illustrator", "Продакшн", "🖌", "Художник", "google/gemini-3.1-flash-image", "image",
     "Рисует персонажей и кадры, сохраняя внешность героя во всех сценах."),
    ("voice", "Продакшн", "🎙", "Диктор", "", "tool",
     "Озвучивает текст (Edge TTS бесплатно, OpenRouter TTS, OpenAI или ElevenLabs — выбирается в Настройках)."),
    ("animator", "Продакшн", "🎬", "Монтажёр-аниматор", "", "tool",
     "Анимирует кадры (зум, панорамы), склеивает, накладывает субтитры и музыку."),
    ("thumbnail", "Продакшн", "🖼", "Дизайнер баннеров", "google/gemini-3.1-flash-image", "image",
     "Рисует кликабельное превью по концепции маркетолога."),
    ("marketer", "Рост", "📣", "Маркетолог", "anthropic/claude-sonnet-5.5", "llm",
     "Придумывает заголовки, описание, концепцию превью и закреплённый комментарий под CTR."),
    ("tagger", "Рост", "🏷", "SEO-теггер", "anthropic/claude-haiku-5.5", "llm",
     "Ищет актуальные поисковые запросы и подбирает теги и хэштеги."),
    ("publisher", "Рост", "🚀", "Публикатор", "", "tool",
     "Загружает видео на YouTube в лучшее время, ставит превью."),
    ("analyst", "Рост", "📊", "Аналитик канала", "google/gemini-3.8-flash", "llm",
     "Смотрит просмотры после публикации, находит лучшее время для заливки и что заходит аудитории."),
]

# Roles that get OpenRouter's web search plugin: they must see what is trending today.
WEB_ROLES = {"researcher", "tagger"}

ROLES = {r[0]: {"role": r[0], "department": r[1], "emoji": r[2], "name": r[3],
                "default_model": r[4], "kind": r[5], "duty": r[6], "web": r[0] in WEB_ROLES} for r in STAFF}


def model_for(role):
    custom = (load_settings().get("agents") or {}).get(role) or {}
    return custom.get("model") or ROLES[role]["default_model"]


def name(role):
    a = ROLES.get(role)
    return f"{a['emoji']} {a['name']}" if a else role


def staff():
    out = []
    for role, a in ROLES.items():
        out.append({**a, "model": model_for(role) if a["kind"] != "tool" else ""})
    return out
