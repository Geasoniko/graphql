"""What this computer can do, and one-click installs of optional local modules.

Local modules make the company cheaper or better without cloud costs:
- faster-whisper: exact word timings for subtitles with any voice;
- kokoro: free high-quality local English voice (runs on CPU, faster on GPU).
Each is optional: the pipeline checks importability and falls back otherwise.
"""
import importlib.util
import platform
import shutil
import subprocess
import sys
import threading
import time

MODULES = {
    "faster_whisper": {
        "name": "Whisper — точные субтитры",
        "pip": ["faster-whisper"],
        "about": "Слушает готовую озвучку и ставит субтитры точно по словам. Работает на процессоре, модель ~150 МБ скачается при первом запуске.",
    },
    "kokoro": {
        "name": "Kokoro — бесплатный локальный голос",
        "pip": ["kokoro>=0.9", "soundfile"],
        "about": "Лучший открытый английский голос по слепым тестам, лицензия Apache 2.0. Работает без интернета и без оплаты; с видеокартой NVIDIA быстрее.",
    },
}

_installs = {}  # module -> {"status": running|done|error, "log": str}
_lock = threading.Lock()


def has(module):
    return importlib.util.find_spec(module) is not None


def _run(cmd, timeout=10):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def gpu():
    """NVIDIA GPU name and memory via nvidia-smi, or None."""
    if not shutil.which("nvidia-smi"):
        return None
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    if not out:
        return None
    name, mem = [x.strip() for x in out.splitlines()[0].split(",")[:2]]
    return {"name": name, "vram_gb": round(int(float(mem)) / 1024, 1)}


def ram_gb():
    try:
        if sys.platform == "win32":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return round(ms.ullTotalPhys / 1024 ** 3, 1)
        import os
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024 ** 3, 1)
    except Exception:
        return None


def report():
    from .config import DATA
    g = gpu()
    disk = shutil.disk_usage(DATA)
    return {
        "os": f"{platform.system()} {platform.release()}",
        "cpu": platform.processor() or platform.machine(),
        "python": platform.python_version(),
        "ram_gb": ram_gb(),
        "gpu": g,
        "disk_free_gb": round(disk.free / 1024 ** 3, 1),
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "modules": {k: {**v, "installed": has(k), "install": _installs.get(k)} for k, v in MODULES.items()},
    }


def install(module):
    """pip-install an optional module in the background; progress via report()."""
    spec = MODULES[module]
    with _lock:
        if (_installs.get(module) or {}).get("status") == "running":
            return
        _installs[module] = {"status": "running", "log": "", "started": time.time()}

    def work():
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *spec["pip"]]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        for line in proc.stdout:
            lines.append(line.rstrip())
            _installs[module]["log"] = "\n".join(lines[-12:])
        proc.wait()
        importlib.invalidate_caches()
        ok = proc.returncode == 0 and has(module)
        _installs[module]["status"] = "done" if ok else "error"

    threading.Thread(target=work, daemon=True).start()
