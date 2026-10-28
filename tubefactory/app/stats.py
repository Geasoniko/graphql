"""Channel statistics straight from the YouTube Analytics API: countries, age and
gender, traffic sources, devices, retention and the best videos. Free (YouTube
API quota only) and without any AI: the conclusions are plain rules.

Needs the "YouTube Analytics API" enabled in the same Google Cloud project as
the upload client, and the channel connected after this feature appeared
(the sign-in asks for the yt-analytics.readonly permission).
"""
import datetime as dt
import json
import time

from . import youtube
from .config import CHANNELS_DIR

COUNTRIES = {
    "US": "США", "GB": "Великобритания", "CA": "Канада", "AU": "Австралия", "NZ": "Новая Зеландия",
    "IE": "Ирландия", "DE": "Германия", "FR": "Франция", "NL": "Нидерланды", "BE": "Бельгия",
    "CH": "Швейцария", "AT": "Австрия", "SE": "Швеция", "NO": "Норвегия", "DK": "Дания",
    "FI": "Финляндия", "IT": "Италия", "ES": "Испания", "PT": "Португалия", "PL": "Польша",
    "CZ": "Чехия", "RU": "Россия", "UA": "Украина", "BY": "Беларусь", "KZ": "Казахстан",
    "UZ": "Узбекистан", "KG": "Кыргызстан", "TR": "Турция", "IN": "Индия", "PK": "Пакистан",
    "BD": "Бангладеш", "ID": "Индонезия", "PH": "Филиппины", "VN": "Вьетнам", "TH": "Таиланд",
    "MY": "Малайзия", "SG": "Сингапур", "JP": "Япония", "KR": "Южная Корея", "CN": "Китай",
    "BR": "Бразилия", "MX": "Мексика", "AR": "Аргентина", "CO": "Колумбия", "EG": "Египет",
    "NG": "Нигерия", "ZA": "ЮАР", "KE": "Кения", "SA": "Саудовская Аравия", "AE": "ОАЭ", "IL": "Израиль",
}
# Countries where advertisers pay the most per view.
HIGH_RPM = {"US", "GB", "CA", "AU", "NZ", "IE", "DE", "CH", "NO", "SE", "DK", "NL", "AT", "BE", "FI"}

TRAFFIC = {
    "YT_SEARCH": "Поиск YouTube", "RELATED_VIDEO": "Рекомендации рядом с видео",
    "YT_OTHER_PAGE": "Главная и другие страницы YouTube", "SUBSCRIBER": "Подписки и колокольчик",
    "NOTIFICATION": "Уведомления", "YT_CHANNEL": "Страница канала", "PLAYLIST": "Плейлисты",
    "YT_PLAYLIST_PAGE": "Страница плейлиста", "SHORTS": "Лента Shorts", "EXT_URL": "Внешние сайты",
    "NO_LINK_OTHER": "Прямые заходы", "NO_LINK_EMBEDDED": "Встроенный плеер", "END_SCREEN": "Конечные заставки",
    "ANNOTATION": "Подсказки", "CAMPAIGN_CARD": "Карточки", "ADVERTISING": "Реклама", "PROMOTED": "Продвижение",
    "HASHTAGS": "Хэштеги", "SOUND_PAGE": "Страница звука", "VIDEO_REMIXES": "Ремиксы",
    "LIVE_REDIRECT": "Переход с трансляции", "PRODUCT_PAGE": "Страница товара",
}
DEVICES = {"MOBILE": "Телефон", "DESKTOP": "Компьютер", "TABLET": "Планшет", "TV": "Телевизор",
           "GAME_CONSOLE": "Игровая приставка", "UNKNOWN_PLATFORM": "Другое"}
GENDERS = {"male": "мужчины", "female": "женщины", "user_specified": "другое"}

CACHE_HOURS = 1


def flag(code):
    return "".join(chr(0x1F1E6 + ord(c) - 65) for c in code) if len(code) == 2 and code.isalpha() else "🌍"


def _rows(resp):
    names = [h["name"] for h in resp.get("columnHeaders", [])]
    return [dict(zip(names, r)) for r in resp.get("rows") or []]


def _friendly(e):
    text = str(e)
    if "accessNotConfigured" in text or "has not been used" in text or "is disabled" in text:
        return ("В Google Cloud не включён YouTube Analytics API. Откройте "
                "https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com "
                "в том же проекте, где OAuth-клиент, нажмите «Enable» и обновите статистику.")
    if "insufficient" in text.lower() or "403" in text or "scope" in text.lower():
        return ("У софта нет доступа к статистике этого канала. В разделе «Каналы» нажмите "
                "«Подключить YouTube» ещё раз и разрешите просмотр статистики YouTube Analytics.")
    return f"YouTube Analytics: {text[:300]}"


def fetch(channel_id, days=28, fresh=False):
    """Everything for the statistics page, cached for an hour per period."""
    cache = CHANNELS_DIR / channel_id / f"stats_{days}.json"
    if not fresh and cache.exists():
        data = json.loads(cache.read_text("utf-8"))
        if time.time() - data.get("fetched", 0) < CACHE_HOURS * 3600:
            return data
    if not youtube.is_connected(channel_id):
        raise RuntimeError("Канал не подключён к YouTube: нажмите «Подключить YouTube» в разделе «Каналы».")
    try:
        data = _collect(channel_id, days)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(_friendly(e)) from e
    data["insights"] = insights(data)
    data["fetched"] = time.time()
    cache.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    return data


def _collect(channel_id, days):
    yta = youtube.analytics_service(channel_id)
    end = dt.date.today()
    start = end - dt.timedelta(days=days)

    missing = []

    def optional(name, *args, **kw):
        """A section YouTube can't answer (its API sometimes returns 500 for a breakdown,
        e.g. on small channels) is left empty instead of failing the whole page."""
        for attempt in range(2):
            try:
                return query(*args, **kw)
            except Exception as e:
                text = str(e)
                if not any(f"HttpError {c}" in text for c in (500, 503, 400)):
                    raise  # access problems are reported to the user
                if attempt == 0 and "HttpError 400" not in text:
                    time.sleep(1)  # a 500 is often momentary: try once more
                    continue
                missing.append(name)
                return []

    def query(metrics, dimensions=None, sort=None, limit=None, filters=None):
        kw = {"ids": "channel==MINE", "startDate": start.isoformat(), "endDate": end.isoformat(),
              "metrics": metrics}
        if dimensions:
            kw["dimensions"] = dimensions
        if sort:
            kw["sort"] = sort
        if limit:
            kw["maxResults"] = limit
        if filters:
            kw["filters"] = filters
        return _rows(yta.reports().query(**kw).execute())

    totals = query("views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,"
                   "subscribersGained,subscribersLost,likes,comments,shares")
    daily = optional("по дням", "views,estimatedMinutesWatched,subscribersGained", "day", "day")
    countries = optional("страны", "views,estimatedMinutesWatched,averageViewDuration", "country", "-views", 25)
    demo = optional("возраст и пол", "viewerPercentage", "ageGroup,gender")
    traffic = optional("источники", "views,estimatedMinutesWatched", "insightTrafficSourceType", "-views")
    devices = optional("устройства", "views,estimatedMinutesWatched", "deviceType", "-views")
    subscribed = optional("подписчики/не подписчики", "views", "subscribedStatus")
    videos = optional("видео", "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,"
                      "subscribersGained,likes", "video", "-views", 25)
    titles = youtube.video_titles(channel_id, [v["video"] for v in videos]) if videos else {}

    t = totals[0] if totals else {}
    total_views = sum(c["views"] for c in countries) or t.get("views") or 0
    return {
        "days": days, "start": start.isoformat(), "end": end.isoformat(),
        "totals": t,
        "daily": daily,
        "countries": [{"code": c["country"], "flag": flag(c["country"]),
                       "name": COUNTRIES.get(c["country"], c["country"]),
                       "views": c["views"], "minutes": c["estimatedMinutesWatched"],
                       "avg_duration": c["averageViewDuration"],
                       "share": round(c["views"] / total_views * 100, 1) if total_views else 0,
                       "high_rpm": c["country"] in HIGH_RPM} for c in countries],
        "audience": [{"age": d["ageGroup"].replace("age", "").replace("-", "–"),
                      "gender": GENDERS.get(d["gender"], d["gender"]),
                      "percent": round(d["viewerPercentage"], 1)}
                     for d in demo if d["viewerPercentage"] >= 0.5],
        "traffic": [{"source": TRAFFIC.get(x["insightTrafficSourceType"], x["insightTrafficSourceType"]),
                     "views": x["views"], "minutes": x["estimatedMinutesWatched"]} for x in traffic],
        "devices": [{"device": DEVICES.get(x["deviceType"], x["deviceType"]), "views": x["views"]}
                    for x in devices],
        "subscribed": {x["subscribedStatus"]: {"views": x["views"]} for x in subscribed},
        "missing": missing,
        "videos": [{"video_id": v["video"], "title": titles.get(v["video"], v["video"]), "views": v["views"],
                    "minutes": v["estimatedMinutesWatched"], "avg_duration": v["averageViewDuration"],
                    "retention": round(v["averageViewPercentage"], 1), "subs": v["subscribersGained"],
                    "likes": v["likes"]} for v in videos],
    }


def _pct(part, whole):
    return round(part / whole * 100) if whole else 0


def insights(d):
    """Plain-rule conclusions in Russian — no AI, so they cost nothing."""
    out = []
    t = d.get("totals") or {}
    views = t.get("views") or 0
    if not views:
        return ["За этот период просмотров нет — выводы появятся, когда видео начнут смотреть."]

    countries = d.get("countries") or []
    if countries:
        top = countries[0]
        out.append(f"{top['flag']} Больше всего смотрят из страны «{top['name']}»: {top['share']}% просмотров.")
        rich = sum(c["share"] for c in countries if c["high_rpm"])
        if rich >= 50:
            out.append(f"💰 {rich:.0f}% просмотров — из стран с дорогой рекламой (США, Европа, Австралия). "
                       "Это хорошо для дохода — держите язык и темы под них.")
        elif rich < 25:
            out.append(f"💸 Только {rich:.0f}% просмотров из стран с дорогой рекламой. Если цель — доход, "
                       "делайте видео на английском и темы, интересные США и Европе.")

    retention = t.get("averageViewPercentage") or 0
    if retention:
        if retention < 30:
            out.append(f"⚠️ В среднем досматривают только {retention:.0f}% видео. Зрители уходят рано: "
                       "сильнее первые 15 секунд и короче вступление.")
        elif retention >= 50:
            out.append(f"✅ Досматривают в среднем {retention:.0f}% видео — это отлично, удержание сильное.")
        else:
            out.append(f"Досматривают в среднем {retention:.0f}% видео — нормально; цель — выше 50%.")

    gained, lost = t.get("subscribersGained") or 0, t.get("subscribersLost") or 0
    per_1000 = gained / views * 1000
    out.append(f"👥 Подписчики: +{gained} / −{lost} ({per_1000:.1f} новых на 1000 просмотров"
               + ("; хороший результат)." if per_1000 >= 5 else "; добавьте призыв подписаться в конце)."))

    traffic = d.get("traffic") or []
    if traffic:
        top = traffic[0]
        out.append(f"🚦 Главный источник просмотров: {top['source']} ({_pct(top['views'], views)}%).")
        search = sum(x["views"] for x in traffic if x["source"] == TRAFFIC["YT_SEARCH"])
        if _pct(search, views) < 5:
            out.append("🔎 Из поиска почти не приходят — пробуйте заголовки с запросами, которые люди реально ищут.")

    devices = d.get("devices") or []
    mobile = sum(x["views"] for x in devices if x["device"] in (DEVICES["MOBILE"], DEVICES["TABLET"]))
    if devices and _pct(mobile, views) >= 60:
        out.append(f"📱 {_pct(mobile, views)}% смотрят с телефона: крупные субтитры и простые картинки "
                   "работают лучше мелких деталей.")

    audience = d.get("audience") or []
    if audience:
        main = max(audience, key=lambda a: a["percent"])
        out.append(f"🎯 Основная аудитория: {main['gender']} {main['age']} лет ({main['percent']}%).")

    vids = [v for v in d.get("videos") or [] if v["views"] >= 20]
    if len(vids) >= 3:
        best = max(vids, key=lambda v: v["retention"])
        worst = min(vids, key=lambda v: v["retention"])
        out.append(f"🏆 Лучше всего досматривают «{best['title']}» ({best['retention']}%) — "
                   "делайте похожие по теме и подаче.")
        if worst is not best:
            out.append(f"📉 Хуже всего досматривают «{worst['title']}» ({worst['retention']}%) — "
                       "такие темы или начало лучше не повторять.")
    return out
