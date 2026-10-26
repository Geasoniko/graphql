"""Image generation for characters, scenes and thumbnails."""
import io
import textwrap

from PIL import Image, ImageDraw, ImageFont, ImageOps

from . import llm

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}


def _font(size):
    for path in (FONT, "DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def save_fitted(data, path, aspect):
    """Crop/resize to the exact video frame so ffmpeg gets uniform inputs."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img = ImageOps.fit(img, SIZES.get(aspect, SIZES["16:9"]), Image.LANCZOS)
    img.save(path, "PNG")


def placeholder(path, text, aspect, seed=0):
    w, h = SIZES.get(aspect, SIZES["16:9"])
    hue = [(52, 80, 160), (30, 110, 120), (110, 60, 140), (150, 90, 40)][seed % 4]
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        k = y / h
        draw.line([(0, y), (w, y)], fill=tuple(int(c * (1 - k) + 15 * k) for c in hue))
    font = _font(int(h * 0.045))
    lines = textwrap.wrap(text, 40)[:6]
    y = h // 2 - len(lines) * int(h * 0.03)
    for line in lines:
        tw = draw.textlength(line, font=font)
        draw.text(((w - tw) / 2, y), line, font=font, fill=(235, 240, 255))
        y += int(h * 0.06)
    img.save(path, "PNG")


def character_prompt(style, char):
    return (f"Character reference sheet, single character, full body, front view, plain light "
            f"background, no text. Style: {style}. Character: {char['name']} — {char['description']}")


def scene_prompt(style, scene, characters):
    parts = [f"Style: {style}." if style else "",
             f"Scene: {scene['image_prompt']}"]
    used = [c for c in characters if c["id"] in scene.get("characters", [])]
    for c in used:
        parts.append(f"Character {c['name']} ({c['id']}): {c['description']}. "
                     f"Keep exactly the same look as in the reference image.")
    parts.append("Single cinematic frame, no text, no captions, no watermark, no panels.")
    return " ".join(p for p in parts if p)


def generate(prompt, path, aspect, references=(), label="", seed=0, role="illustrator"):
    try:
        data = llm.generate_image(prompt, references=references, aspect=aspect, role=role)
    except llm.LLMError as e:
        if str(e) != "demo":
            raise
        placeholder(path, label or prompt, aspect, seed)
        return
    save_fitted(data, path, aspect)


def compose_thumbnail(src, dst, text):
    """Thumbnail for YouTube: 1280x720 JPEG (<2 MB) with big outlined text."""
    img = ImageOps.fit(Image.open(src).convert("RGB"), (1280, 720), Image.LANCZOS)
    if text:
        text = text.upper()
        w, h = img.size
        draw = ImageDraw.Draw(img)
        size = int(h * 0.16)
        font = _font(size)
        while draw.textlength(text, font=font) > w * 0.9 and size > 20:
            size -= 4
            font = _font(size)
        tw = draw.textlength(text, font=font)
        draw.text(((w - tw) / 2, h - size * 1.6), text, font=font, fill=(255, 230, 40),
                  stroke_width=max(4, size // 12), stroke_fill=(0, 0, 0))
    img.save(dst, "JPEG", quality=90)
