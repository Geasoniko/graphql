"""YouTube: OAuth per channel, upload with thumbnail, and reference fetching.

Uploading needs a Google Cloud OAuth client (type "Desktop app") with the
YouTube Data API v3 enabled, saved as data/client_secret.json. Each channel
gets its own token in data/channels/<id>/token.json.
"""
import re

import requests

from .config import CHANNELS_DIR, load_settings

SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly"]


def _token_path(channel_id):
    d = CHANNELS_DIR / channel_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "token.json"


def authorize(channel_id):
    """Opens a browser window for Google sign-in (run on the machine with the browser)."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    secret = load_settings()["youtube_client_secret"]
    flow = InstalledAppFlow.from_client_secrets_file(secret, SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", open_browser=True)
    _token_path(channel_id).write_text(creds.to_json(), "utf-8")
    return channel_info(channel_id)


def _service(channel_id):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    path = _token_path(channel_id)
    if not path.exists():
        raise RuntimeError("Канал не подключён к YouTube: нажмите «Подключить YouTube» в разделе Каналы")
    creds = Credentials.from_authorized_user_file(str(path), SCOPES)
    if not creds.valid and creds.refresh_token:
        creds.refresh(Request())
        path.write_text(creds.to_json(), "utf-8")
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def is_connected(channel_id):
    return _token_path(channel_id).exists()


def channel_info(channel_id):
    yt = _service(channel_id)
    items = yt.channels().list(part="snippet,statistics", mine=True).execute().get("items", [])
    if not items:
        return None
    it = items[0]
    return {"youtube_id": it["id"], "title": it["snippet"]["title"],
            "subscribers": it["statistics"].get("subscriberCount"),
            "views": it["statistics"].get("viewCount"),
            "videos": it["statistics"].get("videoCount")}


def upload(channel_id, video_path, title, description, tags, privacy="private",
           publish_at=None, thumbnail=None, language="en", progress=None):
    from googleapiclient.http import MediaFileUpload

    yt = _service(channel_id)
    status = {"privacyStatus": privacy, "selfDeclaredMadeForKids": False,
              # Required disclosure for realistic AI-generated content.
              "containsSyntheticMedia": True}
    if publish_at:
        status["privacyStatus"] = "private"
        status["publishAt"] = publish_at
    body = {
        "snippet": {"title": title[:100], "description": description[:4900],
                    "tags": tags[:30], "categoryId": "27", "defaultLanguage": language,
                    "defaultAudioLanguage": language},
        "status": status,
    }
    media = MediaFileUpload(str(video_path), chunksize=8 * 1024 * 1024, resumable=True,
                            mimetype="video/mp4")
    req = yt.videos().insert(part="snippet,status", body=body, media_body=media)
    resp = None
    while resp is None:
        st, resp = req.next_chunk()
        if st and progress:
            progress(int(st.progress() * 100))
    video_id = resp["id"]
    if thumbnail:
        try:
            yt.thumbnails().set(videoId=video_id, media_body=MediaFileUpload(str(thumbnail))).execute()
        except Exception as e:  # custom thumbnails need a verified channel
            if progress:
                progress(100, f"превью не загружено: {e}")
    return {"video_id": video_id, "url": f"https://youtu.be/{video_id}"}


def channel_videos(channel_id, limit=50):
    """Latest uploads of the connected channel with their statistics."""
    yt = _service(channel_id)
    ch = yt.channels().list(part="contentDetails", mine=True).execute()["items"][0]
    uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    items = yt.playlistItems().list(part="contentDetails", playlistId=uploads,
                                    maxResults=min(limit, 50)).execute().get("items", [])
    ids = [it["contentDetails"]["videoId"] for it in items]
    if not ids:
        return []
    resp = yt.videos().list(part="snippet,statistics,contentDetails,status", id=",".join(ids)).execute()
    out = []
    for v in resp.get("items", []):
        st = v.get("statistics", {})
        out.append({
            "video_id": v["id"],
            "title": v["snippet"]["title"],
            "published_at": v["snippet"]["publishedAt"],
            "privacy": v["status"]["privacyStatus"],
            "duration": v["contentDetails"]["duration"],
            "views": int(st.get("viewCount", 0)),
            "likes": int(st.get("likeCount", 0)),
            "comments": int(st.get("commentCount", 0)),
        })
    return out


# ---------- reference videos ----------

def _vtt_to_text(vtt):
    out, last = [], None
    for line in vtt.splitlines():
        line = line.strip()
        if not line or "-->" in line or line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
            continue
        line = re.sub(r"<[^>]+>", "", line)
        if line != last:
            out.append(line)
            last = line
    return " ".join(out)


def fetch_reference(url):
    """Title, stats and transcript of a YouTube video via yt-dlp (no download)."""
    try:
        import yt_dlp
    except ImportError:
        raise RuntimeError("Установите yt-dlp: pip install yt-dlp")
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    transcript = ""
    for source in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        for lang in ("en", "en-US", "en-orig", "ru"):
            tracks = source.get(lang) or []
            vtt = next((t for t in tracks if t.get("ext") == "vtt"), None)
            if vtt:
                transcript = _vtt_to_text(requests.get(vtt["url"], timeout=60).text)
                break
        if transcript:
            break
    return {
        "title": info.get("title"),
        "channel": info.get("channel"),
        "views": info.get("view_count"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "description": info.get("description") or "",
        "transcript": transcript,
    }


def reference_text(ref):
    return (f"Title: {ref['title']}\nChannel: {ref['channel']}\nViews: {ref['views']}\n"
            f"Duration: {ref['duration']} s\nDescription: {ref['description'][:1500]}\n\n"
            f"Transcript:\n{ref['transcript']}")
