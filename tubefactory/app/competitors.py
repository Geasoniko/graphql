"""Competitor analysis: 5-10 YouTube channels given as links. Their latest
videos, views, upload times, lengths and titles come from the YouTube Data API
(public data, free quota); the recommendations are plain rules — no AI.

Access: the OAuth token of any connected channel, or a YouTube API key in
Settings when no channel is connected yet.
"""
import datetime as dt
import json
import re
import statistics
import time
from collections import Counter
from urllib.parse import unquote

from . import storage, youtube
from .config import CHANNELS_DIR, load_settings

VIDEOS_PER_CHANNEL = 50
HIT = 3.0            # a video with 3x the channel's median views is a hit
CACHE_HOURS = 6
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
STOP = set("""a an the of to in on for and or but is are was were be been with from at by as it its this that
these those you your we our they their he she his her i me my how why what when who where which do does did not no
vs v s t ll re ve d m just than then there here into out up down over about after before more most very can will
и в во не на что как это с со по к у из за от для о об а но же ли бы то так все всё ещё уже""".split())


def _client():
    """A YouTube Data API client that can read public data."""
    from googleapiclient.discovery import build

    for ch in storage.list_channels():
        if youtube.is_connected(ch["id"]):
            try:
                return youtube._service(ch["id"])
            except Exception:
                continue
    key = load_settings().get("youtube_api_key")
    if key:
        return build("youtube", "v3", developerKey=key, cache_discovery=False)
    raise RuntimeError("Нужен доступ к YouTube: подключите любой свой канал («Каналы» → «Подключить YouTube») "
                       "или вставьте YouTube API key в Настройках.")


def parse_link(text):
    """('id', 'UC...') | ('handle', '@name') | ('user', 'name') | ('custom', 'name') | ('video', id)."""
    text = unquote(text.strip())  # non-Latin handles arrive URL-encoded
    if not text:
        return None
    m = re.search(r"(UC[\w-]{22})", text)
    if m:
        return "id", m.group(1)
    m = re.search(r"youtube\.com/(@[\w.\-%]+)", text) or re.match(r"^(@[\w.\-]+)$", text)
    if m:
        return "handle", m.group(1)
    m = re.search(r"youtube\.com/user/([\w.\-]+)", text)
    if m:
        return "user", m.group(1)
    m = re.search(r"youtube\.com/c/([\w.\-%]+)", text)
    if m:
        return "custom", m.group(1)
    m = re.search(r"(?:v=|youtu\.be/|shorts/)([\w-]{11})", text)
    if m:
        return "video", m.group(1)
    if re.match(r"^[\w.\-]{3,}$", text):
        return "handle", "@" + text
    return None


def _resolve(yt, link):
    kind, value = parse_link(link) or (None, None)
    if not kind:
        raise RuntimeError(f"Не понял ссылку: {link}")
    part = "snippet,statistics,contentDetails"
    if kind == "id":
        resp = yt.channels().list(part=part, id=value).execute()
    elif kind == "handle":
        resp = yt.channels().list(part=part, forHandle=value).execute()
    elif kind == "user":
        resp = yt.channels().list(part=part, forUsername=value).execute()
    elif kind == "video":
        v = yt.videos().list(part="snippet", id=value).execute().get("items") or []
        if not v:
            raise RuntimeError(f"Видео не найдено: {link}")
        resp = yt.channels().list(part=part, id=v[0]["snippet"]["channelId"]).execute()
    else:  # old /c/ links: try them as a handle
        resp = yt.channels().list(part=part, forHandle="@" + value).execute()
    items = resp.get("items") or []
    if not items:
        raise RuntimeError(f"Канал не найден: {link}")
    return items[0]


def _iso_seconds(duration):
    m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration or "")
    if not m:
        return 0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def _videos(yt, uploads, limit):
    ids, token = [], None
    while len(ids) < limit:
        resp = yt.playlistItems().list(part="contentDetails", playlistId=uploads, maxResults=50,
                                       pageToken=token).execute()
        ids += [it["contentDetails"]["videoId"] for it in resp.get("items", [])]
        token = resp.get("nextPageToken")
        if not token:
            break
    out = []
    for i in range(0, len(ids[:limit]), 50):
        resp = yt.videos().list(part="snippet,statistics,contentDetails", id=",".join(ids[i:i + 50])).execute()
        for v in resp.get("items", []):
            st = v.get("statistics", {})
            out.append({"video_id": v["id"], "title": v["snippet"]["title"],
                        "published_at": v["snippet"]["publishedAt"],
                        "seconds": _iso_seconds(v["contentDetails"].get("duration")),
                        "views": int(st.get("viewCount", 0)), "likes": int(st.get("likeCount", 0)),
                        "comments": int(st.get("commentCount", 0))})
    return out


def _channel_report(info, videos):
    now = dt.datetime.now(dt.timezone.utc)
    for v in videos:
        published = dt.datetime.fromisoformat(v["published_at"].replace("Z", "+00:00"))
        local = published.astimezone()
        v.update(age_days=max((now - published).total_seconds() / 86400, 0.5),
                 hour=local.hour, weekday=local.weekday(), short=v["seconds"] <= 180)
    # Videos younger than 3 days haven't collected their views yet.
    settled = [v for v in videos if v["age_days"] >= 3] or videos
    median = statistics.median([v["views"] for v in settled]) if settled else 0
    for v in videos:
        v["x_median"] = round(v["views"] / median, 1) if median else 0
    recent = [v for v in videos if v["age_days"] <= 90]
    st = info.get("statistics", {})
    return {
        "id": info["id"], "title": info["snippet"]["title"],
        "url": f"https://www.youtube.com/channel/{info['id']}",
        "thumbnail": (info["snippet"].get("thumbnails", {}).get("default") or {}).get("url"),
        "subscribers": int(st.get("subscriberCount", 0) or 0),
        "total_views": int(st.get("viewCount", 0) or 0),
        "video_count": int(st.get("videoCount", 0) or 0),
        "median_views": round(median),
        "per_week": round(len(recent) / (90 / 7), 1) if recent else 0,
        "avg_minutes": round(statistics.mean([v["seconds"] for v in videos]) / 60, 1) if videos else 0,
        "shorts_share": round(sum(v["short"] for v in videos) / len(videos) * 100) if videos else 0,
        "best": max(videos, key=lambda v: v["views"]) if videos else None,
        "last_upload": max((v["published_at"] for v in videos), default=None),
        "videos": videos,
    }


def _bucket(seconds):
    m = seconds / 60
    for limit, name in ((1, "до 1 мин"), (3, "1–3 мин"), (8, "3–8 мин"), (15, "8–15 мин"), (30, "15–30 мин")):
        if m <= limit:
            return name
    return "30+ мин"


def _words(title):
    return [w for w in re.findall(r"[\w']+", title.lower()) if len(w) > 2 and w not in STOP and not w.isdigit()]


def recommend(channels):
    """Plain-rule recommendations from all competitors' videos."""
    videos = [dict(v, channel=c["title"]) for c in channels for v in c["videos"] if v["age_days"] >= 3]
    if not videos:
        return {"tips": ["У конкурентов пока нет видео старше 3 дней — анализировать нечего."]}
    long_ = [v for v in videos if not v["short"]]
    pool = long_ if len(long_) >= len(videos) / 3 else videos

    # When to publish: hours and weekdays whose videos beat their channel's median most often.
    def best_of(key, labels, top):
        score = {}
        for v in pool:
            score.setdefault(key(v), []).append(min(v["x_median"], 10))
        ranked = sorted(((statistics.mean(x), k, len(x)) for k, x in score.items() if len(x) >= 2), reverse=True)
        return [{"key": k, "label": labels(k), "score": round(s, 2), "videos": n} for s, k, n in ranked[:top]], score

    best_hours, by_hour = best_of(lambda v: v["hour"], lambda h: f"{h:02d}:00", 3)
    best_days, _ = best_of(lambda v: v["weekday"], lambda d: WEEKDAYS[d], 3)
    hour_counts = Counter(v["hour"] for v in pool)

    durations = {}
    for v in pool:
        durations.setdefault(_bucket(v["seconds"]), []).append(v["x_median"])
    duration_rank = sorted(((statistics.median(x), k, len(x)) for k, x in durations.items() if len(x) >= 3),
                           reverse=True)

    hits = sorted((v for v in videos if v["x_median"] >= HIT), key=lambda v: -v["x_median"])
    others = [v for v in videos if v["x_median"] < 1]

    def share(items, test):
        return round(sum(1 for v in items if test(v)) / len(items) * 100) if items else 0

    title_stats = {
        "hit_len": round(statistics.mean(len(v["title"]) for v in hits)) if hits else None,
        "other_len": round(statistics.mean(len(v["title"]) for v in others)) if others else None,
        "hit_numbers": share(hits, lambda v: re.search(r"\d", v["title"])),
        "other_numbers": share(others, lambda v: re.search(r"\d", v["title"])),
        "hit_questions": share(hits, lambda v: "?" in v["title"]),
        "other_questions": share(others, lambda v: "?" in v["title"]),
    }
    hit_words = Counter(w for v in hits for w in set(_words(v["title"])))
    words = [w for w, n in hit_words.most_common(15) if n >= 2][:10]

    per_week = statistics.median([c["per_week"] for c in channels if c["per_week"]] or [0])
    tips = []
    if best_hours:
        tips.append("⏰ Лучшее время публикации (ваше местное): " + ", ".join(h["label"] for h in best_hours)
                    + " — видео, вышедшие в эти часы, чаще набирают выше обычного у конкурентов.")
    if best_days:
        tips.append("📅 Лучшие дни: " + ", ".join(d["label"] for d in best_days) + ".")
    if per_week:
        tips.append(f"📈 Конкуренты выпускают в среднем {per_week} видео в неделю — "
                    f"держите темп не ниже {max(1, round(per_week))} в неделю.")
    if duration_rank:
        tips.append(f"⏱ Лучше всего заходит длина «{duration_rank[0][1]}» "
                    f"(в {duration_rank[0][0]:.1f}× от обычных просмотров канала).")
    if title_stats["hit_len"] and title_stats["other_len"]:
        tips.append(f"✍️ Заголовки хитов в среднем {title_stats['hit_len']} символов "
                    f"(у остальных {title_stats['other_len']}).")
    if title_stats["hit_numbers"] - title_stats["other_numbers"] >= 15:
        tips.append(f"🔢 Цифры в заголовке: у хитов {title_stats['hit_numbers']}%, у остальных "
                    f"{title_stats['other_numbers']}% — используйте числа («7 причин…», «за 100 лет…»).")
    if title_stats["hit_questions"] - title_stats["other_questions"] >= 15:
        tips.append(f"❓ Вопрос в заголовке: у хитов {title_stats['hit_questions']}% — пробуйте заголовки-вопросы.")
    if words:
        tips.append("🔑 Слова, которые чаще встречаются в хитах: " + ", ".join(words) + ".")
    if hits:
        tips.append(f"🔥 Найдено {len(hits)} хитов (в {HIT:.0f}+ раз больше обычного у своего канала) — "
                    "их темы ниже: сделайте свою версию с вашим героем.")
    return {"tips": tips, "best_hours": best_hours, "best_days": best_days,
            "hour_counts": {str(h): n for h, n in sorted(hour_counts.items())},
            "hour_scores": {str(h): round(statistics.mean(x), 2) for h, x in sorted(by_hour.items())},
            "durations": [{"bucket": k, "x_median": round(s, 2), "videos": n} for s, k, n in duration_rank],
            "title_stats": title_stats, "hit_words": words,
            "hits": [{k: v[k] for k in ("video_id", "title", "channel", "views", "x_median", "seconds",
                                         "published_at")} for v in hits[:30]]}


def analyze(channel_id, links, fresh=False):
    links = [l.strip() for l in links if l and l.strip()][:15]
    if not links:
        raise RuntimeError("Вставьте ссылки на каналы конкурентов — по одной на строку.")
    storage.save_channel({"id": channel_id, "competitors": links})
    cache = CHANNELS_DIR / channel_id / "competitors.json"
    if not fresh and cache.exists():
        data = json.loads(cache.read_text("utf-8"))
        if data.get("links") == links and time.time() - data.get("fetched", 0) < CACHE_HOURS * 3600:
            return data
    yt = _client()
    channels, errors = [], []
    for link in links:
        try:
            info = _resolve(yt, link)
            uploads = info["contentDetails"]["relatedPlaylists"]["uploads"]
            channels.append(_channel_report(info, _videos(yt, uploads, VIDEOS_PER_CHANNEL)))
        except Exception as e:
            errors.append({"link": link, "error": str(e)[:200]})
    if not channels:
        raise RuntimeError("Не удалось загрузить ни один канал: " + "; ".join(e["error"] for e in errors))
    data = {"links": links, "channels": channels, "errors": errors, "fetched": time.time(),
            **recommend(channels)}
    for c in data["channels"]:
        c["videos"] = sorted(c["videos"], key=lambda v: -v["views"])[:10]  # keep the file small
    cache.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    return data


def cached(channel_id):
    cache = CHANNELS_DIR / channel_id / "competitors.json"
    return json.loads(cache.read_text("utf-8")) if cache.exists() else None
