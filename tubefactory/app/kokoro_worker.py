"""Kokoro TTS worker, run by a separate Python (3.10-3.12) when the main one
is newer than Kokoro supports. Standalone on purpose: no imports from app.

Protocol: one JSON object per line on stdin {"text", "voice", "out"};
answers one JSON line on stdout {"ok": true} or {"error": "..."}.
"""
import json
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

pipelines = {}
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        job = json.loads(line)
        lang = job["voice"][0]
        if lang not in pipelines:
            pipelines[lang] = KPipeline(lang_code=lang)
        chunks = [np.asarray(audio) for _, _, audio in pipelines[lang](job["text"], voice=job["voice"], speed=1.0)]
        sf.write(job["out"], np.concatenate(chunks), 24000)
        print(json.dumps({"ok": True}), flush=True)
    except Exception as e:  # report and keep serving
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)
