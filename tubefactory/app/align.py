"""Exact word timings for subtitles with faster-whisper (optional module).

Voices like OpenRouter/OpenAI TTS and Kokoro return audio without word
timings; without this module they are estimated from word length.
"""
import threading

from . import system

_model = None
_failed = False  # model could not load (e.g. no internet for the first download)
_lock = threading.Lock()


def available():
    return not _failed and system.has("faster_whisper")


def _get_model():
    global _model, _failed
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel
            g = system.gpu()
            try:
                # "base" is plenty for aligning known text; ~150 MB, fast on CPU.
                _model = WhisperModel("base", device="cuda" if g else "cpu",
                                      compute_type="float16" if g else "int8")
            except Exception:
                if not g:
                    _failed = True
                    raise
                try:
                    _model = WhisperModel("base", device="cpu", compute_type="int8")  # no CUDA runtime
                except Exception:
                    _failed = True
                    raise
        return _model


def word_timings(audio_path, text):
    """[{start, end, text}] using the original words so subtitles match the script."""
    model = _get_model()
    with _lock:  # one transcription at a time; the model is not thread-safe
        segments, _ = model.transcribe(str(audio_path), word_timestamps=True,
                                       initial_prompt=text[:200], vad_filter=False)
        heard = [w for seg in segments for w in (seg.words or [])]
    words = text.split()
    if not heard or not words:
        return None
    # Map script words onto heard timestamps proportionally (counts can differ slightly).
    out = []
    for i, w in enumerate(words):
        j = min(int(i * len(heard) / len(words)), len(heard) - 1)
        out.append({"start": round(heard[j].start, 3), "end": round(heard[j].end, 3), "text": w})
    return out
