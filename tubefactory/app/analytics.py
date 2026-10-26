"""Channel analyst: pulls views of uploaded videos, finds the best local
publish hours and asks the analyst agent for a report the director uses."""
import datetime as dt

from . import company, storage, team, youtube

# Default for a US audience when there is not enough data yet:
# 12:00 and 15:00 US Eastern, converted to this computer's local time.
US_PRIME_UTC = [17, 20]


def default_hours():
    today = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    return sorted({today.replace(hour=h).astimezone().hour for h in US_PRIME_UTC})


def compute(videos):
    now = dt.datetime.now(dt.timezone.utc)
    rows, by_hour = [], {}
    for v in videos:
        if v["privacy"] != "public":
            continue
        published = dt.datetime.fromisoformat(v["published_at"].replace("Z", "+00:00"))
        age_h = max((now - published).total_seconds() / 3600, 1)
        per_day = v["views"] / max(age_h / 24, 1)
        local = published.astimezone()
        rows.append({"title": v["title"], "views": v["views"], "likes": v["likes"],
                     "comments": v["comments"], "hours": round(age_h), "views_per_day": round(per_day),
                     "hour": local.hour, "weekday": local.strftime("%a")})
        by_hour.setdefault(local.hour, []).append(per_day)
    hour_stats = {h: round(sum(x) / len(x)) for h, x in sorted(by_hour.items())}
    if len(rows) >= 5 and hour_stats:
        best = [h for h, _ in sorted(hour_stats.items(), key=lambda kv: -kv[1])[:2]]
    else:
        best = default_hours()
    return rows, hour_stats, sorted(best)


def analyze_channel(channel_id):
    ch = storage.get_channel(channel_id)
    videos = youtube.channel_videos(channel_id) if youtube.is_connected(channel_id) else []
    # Keep per-project stats in sync for videos this app uploaded.
    by_id = {v["video_id"]: v for v in videos}
    for p in storage.list_projects():
        vid = (p.get("youtube") or {}).get("video_id")
        if vid in by_id:
            with storage.edit_project(p["id"]) as pp:
                pp["stats"] = {k: by_id[vid][k] for k in ("views", "likes", "comments")} | {"time": storage.now()}
    rows, hour_stats, best = compute(videos)
    report = team.analyst_report(ch, rows, hour_stats, best)
    hours = [int(h) for h in report.get("best_hours") or best if 0 <= int(h) < 24] or best
    report.update(best_hours=hours, videos=rows[:30], hour_stats=hour_stats)
    company.set_report(channel_id, report)
    update = {"id": channel_id, "best_hours": hours}
    if ch.get("auto_schedule", True):
        update["publish_hours"] = hours
    storage.save_channel(update)
    company.feed("analyst", f"Отчёт по каналу «{ch['name']}»: {len(rows)} видео, лучшее время {hours}. "
                            f"{report.get('summary', '')}", channel_id=channel_id)
    return report


def recent_for_director(channel_id):
    rep = company.report(channel_id) or {}
    if rep.get("videos"):
        return [{"title": v["title"], "views": v["views"], "hours": v["hours"]} for v in rep["videos"][:20]]
    return [{"title": p["title"], "views": (p.get("stats") or {}).get("views")}
            for p in storage.list_projects() if p["channel_id"] == channel_id][:20]
