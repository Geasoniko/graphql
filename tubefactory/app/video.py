"""Video assembly with ffmpeg: one clip per scene (Ken Burns over the still,
voice-over audio), concatenated, then subtitles and background music."""
import subprocess
from pathlib import Path

from .images import SIZES

PAD = 0.25  # seconds of breathing room after each line
MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left"]


def run(cmd, cwd=None):
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg: " + proc.stderr[-1500:])


def _motion_filter(kind, frames, w, h, fps):
    n = max(frames - 1, 1)
    center_y = "ih/2-(ih/zoom/2)"
    if kind == "zoom_in":
        z, x, y = f"1+0.12*on/{n}", "iw/2-(iw/zoom/2)", center_y
    elif kind == "zoom_out":
        z, x, y = f"1.12-0.12*on/{n}", "iw/2-(iw/zoom/2)", center_y
    elif kind == "pan_right":
        z, x, y = "1.12", f"(iw-iw/zoom)*on/{n}", center_y
    else:  # pan_left
        z, x, y = "1.12", f"(iw-iw/zoom)*(1-on/{n})", center_y
    # Upscale first so sub-pixel motion does not jitter.
    return (f"scale={w * 2}:{h * 2},zoompan=z='{z}':x='{x}':y='{y}':d={frames}"
            f":s={w}x{h}:fps={fps},setsar=1,format=yuv420p")


def _closeup_filter(frames, w, h, fps, side):
    """Second shot of the economy mode: a slow push-in on the left/right/centre third."""
    n = max(frames - 1, 1)
    fx = {0: "0.15", 1: "0.85", 2: "0.5"}[side]
    return (f"scale={w * 2}:{h * 2},zoompan=z='1.45+0.12*on/{n}':x='(iw-iw/zoom)*{fx}':"
            f"y='(ih-ih/zoom)*0.45':d={frames}:s={w}x{h}:fps={fps},setsar=1,format=yuv420p")


def render_clip(image, audio, out, seconds, idx, aspect="16:9", fps=30, ken_burns=True, motion=None,
                shots=1):
    """motion: camera move chosen by the art director (zoom_in, zoom_out, pan_left,
    pan_right, static); without one the moves rotate scene by scene.
    shots=2 (economy mode): the still plays as a wide shot, then a close-up of one part,
    so the picture changes as often as with two images while paying for one."""
    w, h = SIZES.get(aspect, SIZES["16:9"])
    total = seconds + PAD
    frames = int(round(total * fps))
    if motion not in MOTIONS and motion != "static":
        motion = MOTIONS[idx % len(MOTIONS)]
    if shots == 2 and ken_burns and total >= 8:
        first = frames // 2
        vf = (f"split=2[s1][s2];[s1]{_motion_filter('zoom_in' if motion == 'static' else motion, first, w, h, fps)}[v1];"
              f"[s2]{_closeup_filter(frames - first, w, h, fps, idx % 3)}[v2];[v1][v2]concat=n=2:v=1:a=0")
        vin = ["-i", str(image)]
    elif ken_burns and motion != "static":
        vf = _motion_filter(motion, frames, w, h, fps)
        vin = ["-i", str(image)]
    else:
        vf = f"scale={w}:{h},setsar=1,format=yuv420p,fps={fps}"
        vin = ["-loop", "1", "-i", str(image)]
    run(["ffmpeg", "-y", "-v", "error", *vin, "-i", str(audio),
         "-filter_complex", f"[0:v]{vf}[v];[1:a]aresample=44100,apad[a]",
         "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}", "-frames:v", str(frames),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(fps),
         "-c:a", "aac", "-b:a", "192k", "-ac", "2", str(out)])
    return total


def _ass_time(t):
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _chunks(words, max_words=5, max_chars=32):
    cur = []
    for w in words:
        cur.append(w)
        text = " ".join(x["text"] for x in cur)
        if len(cur) >= max_words or len(text) >= max_chars or w["text"][-1:] in ".!?,;:":
            yield cur
            cur = []
    if cur:
        yield cur


def write_ass(scenes, path, aspect="16:9"):
    """scenes: list of (start_offset, words)."""
    w, h = SIZES.get(aspect, SIZES["16:9"])
    vertical = h > w
    size = int(h * (0.045 if vertical else 0.062))
    margin = int(h * (0.38 if vertical else 0.07))
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,DejaVu Sans,{size},&H00FFFFFF,&H0000E5FF,&H00000000,&H80000000,"
        f"-1,0,0,0,100,100,0,0,1,{max(3, size // 12)},2,2,60,60,{margin},1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for offset, words in scenes:
        for group in _chunks(words):
            start = offset + group[0]["start"]
            end = offset + max(group[-1]["end"], group[0]["start"] + 0.4)
            text = " ".join(x["text"] for x in group).replace("{", "(").replace("}", ")")
            lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{text}")
    Path(path).write_text("\n".join(lines) + "\n", "utf-8")


def assemble(clips, out_path, workdir, ass_file=None, music=None, music_volume=0.12):
    workdir = Path(workdir)
    listing = workdir / "concat.txt"
    listing.write_text("".join(f"file '{Path(c).resolve().as_posix()}'\n" for c in clips), "utf-8")
    joined = workdir / "joined.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
         "-c", "copy", str(joined)])
    if not ass_file and not music:
        joined.replace(out_path)
        return
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", joined.name]
    if music:
        cmd += ["-stream_loop", "-1", "-i", str(Path(music).resolve())]
    vf = f"ass={Path(ass_file).name}" if ass_file else "null"
    filt = f"[0:v]{vf}[v]"
    if music:
        filt += (f";[1:a]volume={music_volume}[m];"
                 f"[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
    else:
        filt += ";[0:a]anull[a]"
    cmd += ["-filter_complex", filt, "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            str(Path(out_path).resolve())]
    # Relative names keep the ass= filter free of Windows drive-letter escaping.
    run(cmd, cwd=workdir)
    joined.unlink(missing_ok=True)
