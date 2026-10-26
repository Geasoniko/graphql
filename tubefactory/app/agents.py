"""The company staff: every role is an agent with its own OpenRouter model.

Defaults (checked October 2026): Claude Opus 5.5 for the director and the
writer (strongest long-form writing), GPT-5.5 as the chief editor (a second
model family catches what the writer misses), Gemini 3.1 Pro for long-context
analysis and art direction, Nano Banana 2 (Gemini 3.1 Flash Image) for frames
— the most used image model on OpenRouter, keeps characters consistent from a
reference — and Nano Banana Pro for thumbnails (sharper, better composition).
Researcher and tagger run with OpenRouter's web search plugin. Any model can
be swapped on the "Компания" page (stored in settings["agents"]), and the
"Проверить модели" button checks every id against the live OpenRouter list.
"""
from .config import load_settings

# kind: "llm" — text model, "image" — image model, "tool" — no model (ffmpeg, TTS, YouTube API).
STAFF = [
    # role, department, emoji, name, default model, kind, duty
    ("director", "Руководство", "👔", "Директор", "anthropic/claude-opus-5.5", "llm",
     "Ставит задачи команде: по отчёту аналитика и идеям исследователя решает, какое видео снимать на каждом канале."),
    ("researcher", "Контент", "🔎", "Исследователь ниш и трендов", "anthropic/claude-sonnet-5.5", "llm",
     "Ищет в интернете свежие тренды, ниши и темы, которые сейчас набирают просмотры."),
    ("ref_analyst", "Контент", "🧪", "Аналитик референсов", "google/gemini-3.1-pro-preview", "llm",
     "Разбирает видео конкурентов: хук, структура, темп, стиль — почему оно набрало миллионы."),
    ("writer", "Контент", "✍️", "Сценарист", "anthropic/claude-opus-5.5", "llm",
     "Пишет сценарий с сильным хуком и удержанием, делит на сцены."),
    ("editor", "Контент", "🧐", "Шеф-редактор", "openai/gpt-5.5", "llm",
     "Проверяет сценарий: факты, удержание, хук. Ставит оценку и отправляет на доработку."),
    ("art_director", "Продакшн", "🎨", "Арт-директор", "google/gemini-3.1-pro-preview", "llm",
     "Создаёт стиль-гайд, персонажей, пишет промпты кадров и выбирает движение камеры для анимации."),
    ("illustrator", "Продакшн", "🖌", "Художник", "google/gemini-3.1-flash-image", "image",
     "Рисует персонажей и кадры, сохраняя внешность героя во всех сценах."),
    ("voice", "Продакшн", "🎙", "Диктор", "", "tool",
     "Озвучивает текст (Edge TTS бесплатно, OpenRouter TTS, OpenAI или ElevenLabs — выбирается в Настройках)."),
    ("animator", "Продакшн", "🎬", "Монтажёр-аниматор", "", "tool",
     "Анимирует кадры (зум, панорамы), склеивает, накладывает субтитры и музыку."),
    ("thumbnail", "Продакшн", "🖼", "Дизайнер баннеров", "google/gemini-3-pro-image-preview", "image",
     "Рисует кликабельное превью по концепции маркетолога."),
    ("marketer", "Рост", "📣", "Маркетолог", "anthropic/claude-sonnet-5.5", "llm",
     "Придумывает заголовки, описание, концепцию превью и закреплённый комментарий под CTR."),
    ("tagger", "Рост", "🏷", "SEO-теггер", "anthropic/claude-sonnet-5.5", "llm",
     "Ищет актуальные поисковые запросы и подбирает теги и хэштеги."),
    ("publisher", "Рост", "🚀", "Публикатор", "", "tool",
     "Загружает видео на YouTube в лучшее время, ставит превью."),
    ("analyst", "Рост", "📊", "Аналитик канала", "google/gemini-3.1-pro-preview", "llm",
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
