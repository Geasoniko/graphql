"""Kokoro TTS worker, run by a separate Python (3.10-3.12) when the main one
is newer than Kokoro supports. Standalone on purpose: no imports from app.

Protocol: one JSON object per line on stdin {"id", "text", "voice", "out"};
answers one JSON line on stdout {"id", "ok": true} or {"id", "error": "..."}.
"""
import json
import os
import sys

# Only protocol lines may reach the app: anything else written to stdout (library
# messages, pip downloading a language pack on first use) goes to stderr instead.
protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from kokoro import KPipeline  # noqa: E402


def reply(**kw):
    protocol.write(json.dumps(kw) + "\n")
    protocol.flush()


pipelines = {}
reply(ready=True)
for line in sys.stdin:
    job = {}
    try:
        job = json.loads(line)
        lang = job["voice"][0]
        if lang not in pipelines:
            pipelines[lang] = KPipeline(lang_code=lang)
        chunks = [np.asarray(audio) for _, _, audio in pipelines[lang](job["text"], voice=job["voice"], speed=1.0)]
        if not chunks:
            raise ValueError("пустой текст")
        sf.write(job["out"], np.concatenate(chunks), 24000)
        reply(id=job.get("id"), ok=True)
    except Exception as e:  # report and keep serving
        reply(id=job.get("id"), error=f"{type(e).__name__}: {e}")
