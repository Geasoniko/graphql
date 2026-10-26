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
        "about": "Лучший открытый английский голос по слепым тестам, лицензия Apache 2.0. Работает без интернета и без оплаты; с видеокартой NVIDIA быстрее. Нужен Python 3.10–3.12 (ставится рядом с основным).",
        "separate_python": True,
    },
}

_installs = {}  # module -> {"status": running|done|error, "log": str}
_lock = threading.Lock()


def has(module):
    return importlib.util.find_spec(module) is not None


_kpy = {"cmd": None, "checked": False, "installed": None}


def kokoro_python():
    """A Python Kokoro supports (3.10-3.12): this one if it fits, else one found
    through the Windows `py` launcher or pythonX.Y on PATH. None if absent."""
    if _kpy["checked"]:
        return _kpy["cmd"]
    candidates = [[sys.executable]] if sys.version_info < (3, 13) else []
    for v in ("3.12", "3.11", "3.10"):
        if shutil.which("py"):
            candidates.append(["py", f"-{v}"])
        if shutil.which(f"python{v}"):
            candidates.append([shutil.which(f"python{v}")])
    for cmd in candidates:
        out = _run(cmd + ["-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"])
        if out.isdigit() and 310 <= int(out) <= 312:
            _kpy["cmd"] = cmd
            break
    _kpy["checked"] = True
    return _kpy["cmd"]


def kokoro_installed():
    if has("kokoro"):
        return True
    if _kpy["installed"] is None:
        cmd = kokoro_python()
        _kpy["installed"] = bool(cmd) and _run(cmd + ["-c", "import kokoro, soundfile; print('ok')"], 60) == "ok"
    return _kpy["installed"]


def installed(module):
    return kokoro_installed() if module == "kokoro" else has(module)


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
        "modules": {k: {**v, "installed": installed(k), "install": _installs.get(k)} for k, v in MODULES.items()},
        "kokoro_python": " ".join(kokoro_python() or []) or None,
    }


def install(module):
    """pip-install an optional module in the background; progress via report()."""
    spec = MODULES[module]
    with _lock:
        if (_installs.get(module) or {}).get("status") == "running":
            return
        _installs[module] = {"status": "running", "log": "", "started": time.time()}

    python = [sys.executable]
    if spec.get("separate_python") and sys.version_info >= (3, 13):
        _kpy["checked"] = False
        python = kokoro_python()
        if not python:
            _installs[module] = {"status": "error", "log": (
                f"Kokoro пока не поддерживает Python {platform.python_version()}. Поставьте рядом Python 3.12 "
                "(основной не трогается). В PowerShell:\n  winget install Python.Python.3.12\n"
                "Затем закройте и откройте софт и снова нажмите «Установить».")}
            return

    def work():
        cmd = [*python, "-m", "pip", "install", "--upgrade", *spec["pip"]]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        for line in proc.stdout:
            lines.append(line.rstrip())
            _installs[module]["log"] = "\n".join(lines[-12:])
        proc.wait()
        importlib.invalidate_caches()
        _kpy["installed"] = None
        ok = proc.returncode == 0 and installed(module)
        _installs[module]["status"] = "done" if ok else "error"

    threading.Thread(target=work, daemon=True).start()
