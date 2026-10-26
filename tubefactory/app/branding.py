"""Channel stylist: builds the channel's visual identity and draws its
banner (2560x1440) and avatar (800x800) in that style."""
from PIL import Image, ImageOps

from . import company, images, storage, styles, team
from .config import CHANNELS_DIR


def style_channel(channel_id, wish="", preset_id=None):
    ch = storage.get_channel(channel_id)
    preset = next((p for p in styles.PRESETS if p["id"] == preset_id), None)
    company.feed("stylist", f"разрабатываю фирменный стиль для «{ch['name']}»…", channel_id=channel_id)
    brand = team.channel_style(ch, wish, preset)
    d = CHANNELS_DIR / channel_id
    d.mkdir(parents=True, exist_ok=True)
    hero = brand.get("hero") or {}
    style = brand.get("style_prompt") or (preset or {}).get("prompt") or ch.get("style", "")

    company.feed("thumbnail", "рисую шапку и аватар канала…", channel_id=channel_id)
    raw = d / "banner_raw.png"
    images.generate(f"YouTube channel banner, wide, important content in the central third, no text. "
                    f"Style: {style}. {brand.get('banner_prompt', '')}", raw, "16:9",
                    label=brand.get("style_name", ch["name"]), role="thumbnail")
    ImageOps.fit(Image.open(raw).convert("RGB"), (2560, 1440), Image.LANCZOS).save(d / "banner.jpg", quality=92)
    raw.unlink(missing_ok=True)

    raw = d / "avatar_raw.png"
    images.generate(f"YouTube channel avatar, square, centered face, bold and readable at small size, no text. "
                    f"Style: {style}. Character: {hero.get('description', '')}. {brand.get('avatar_prompt', '')}",
                    raw, "1:1", label=hero.get("name", "Avatar"), role="thumbnail", seed=2)
    ImageOps.fit(Image.open(raw).convert("RGB"), (800, 800), Image.LANCZOS).save(d / "avatar.jpg", quality=92)
    raw.unlink(missing_ok=True)

    brand.update(banner="banner.jpg", avatar="avatar.jpg", preset=preset_id, time=storage.now())
    storage.save_channel({"id": channel_id, "style": style, "brand": brand})
    company.feed("stylist", f"стиль «{brand.get('style_name', '')}» готов: шапка, аватар, правила превью",
                 channel_id=channel_id)
    return storage.get_channel(channel_id)
