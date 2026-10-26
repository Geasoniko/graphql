"""The company staff: every role is an agent with its own OpenRouter model.

Defaults pick the model that is strongest at each job; any of them can be
swapped on the "Компания" page (stored in settings["agents"]).
"""
from .config import load_settings

# kind: "llm" — text model, "image" — image model, "tool" — no model (ffmpeg, TTS, YouTube API).
STAFF = [
    # role, department, emoji, name, default model, kind, duty
    ("director", "Руководство", "👔", "Директор", "anthropic/claude-sonnet-4.5", "llm",
     "Ставит задачи команде: по отчёту аналитика и идеям исследователя решает, какое видео снимать на каждом канале."),
    ("researcher", "Контент", "🔎", "Исследователь ниш и трендов", "perplexity/sonar-pro", "llm",
     "Ищет в интернете свежие тренды, ниши и темы, которые сейчас набирают просмотры."),
    ("ref_analyst", "Контент", "🧪", "Аналитик референсов", "google/gemini-2.5-pro", "llm",
     "Разбирает видео конкурентов: хук, структура, темп, стиль — почему оно набрало миллионы."),
    ("writer", "Контент", "✍️", "Сценарист", "anthropic/claude-sonnet-4.5", "llm",
     "Пишет сценарий с сильным хуком и удержанием, делит на сцены."),
    ("editor", "Контент", "🧐", "Шеф-редактор", "openai/gpt-5", "llm",
     "Проверяет сценарий: факты, удержание, хук. Ставит оценку и отправляет на доработку."),
    ("art_director", "Продакшн", "🎨", "Арт-директор", "google/gemini-2.5-pro", "llm",
     "Создаёт стиль-гайд, персонажей, пишет промпты кадров и выбирает движение камеры для анимации."),
    ("illustrator", "Продакшн", "🖌", "Художник", "google/gemini-2.5-flash-image", "image",
     "Рисует персонажей и кадры, сохраняя внешность героя во всех сценах."),
    ("voice", "Продакшн", "🎙", "Диктор", "", "tool",
     "Озвучивает текст (Edge TTS / OpenAI / ElevenLabs — выбирается в Настройках)."),
    ("animator", "Продакшн", "🎬", "Монтажёр-аниматор", "", "tool",
     "Анимирует кадры (зум, панорамы), склеивает, накладывает субтитры и музыку."),
    ("thumbnail", "Продакшн", "🖼", "Дизайнер баннеров", "google/gemini-2.5-flash-image", "image",
     "Рисует кликабельное превью по концепции маркетолога."),
    ("marketer", "Рост", "📣", "Маркетолог", "anthropic/claude-sonnet-4.5", "llm",
     "Придумывает заголовки, описание, концепцию превью и закреплённый комментарий под CTR."),
    ("tagger", "Рост", "🏷", "SEO-теггер", "perplexity/sonar", "llm",
     "Ищет актуальные поисковые запросы и подбирает теги и хэштеги."),
    ("publisher", "Рост", "🚀", "Публикатор", "", "tool",
     "Загружает видео на YouTube в лучшее время, ставит превью."),
    ("analyst", "Рост", "📊", "Аналитик канала", "google/gemini-2.5-flash", "llm",
     "Смотрит просмотры после публикации, находит лучшее время для заливки и что заходит аудитории."),
]

ROLES = {r[0]: {"role": r[0], "department": r[1], "emoji": r[2], "name": r[3],
                "default_model": r[4], "kind": r[5], "duty": r[6]} for r in STAFF}


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
