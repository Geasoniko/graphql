"""Channel stylist: builds the channel's visual identity and draws its
banner (2560x1440) and avatar (800x800) in that style."""
import shutil

from PIL import Image, ImageOps

from . import company, images, storage, styles, team
from .config import CHANNELS_DIR


def style_channel(channel_id, wish="", preset_id=None):
    ch = storage.get_channel(channel_id)
    if ch.get("brand_locked"):
        raise RuntimeError("Стиль канала закреплён 🔒. Снимите замок, чтобы переоформить.")
    d = CHANNELS_DIR / channel_id
    if ch.get("brand"):
        # Keep the previous identity so it can be restored with one click.
        for name in ("banner.jpg", "avatar.jpg", "hero.png"):
            if (d / name).exists():
                shutil.copyfile(d / name, d / name.replace(".", "_prev."))
        (d / "hero.png").unlink(missing_ok=True)  # the new mascot gets a new master drawing
        storage.save_channel({"id": channel_id, "brand_prev": ch["brand"], "style_prev": ch.get("style", "")})
    preset = next((p for p in styles.PRESETS if p["id"] == preset_id), None)
    company.feed("stylist", f"разрабатываю фирменный стиль для «{ch['name']}»…", channel_id=channel_id)
    brand = team.channel_style(ch, wish, preset)
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
    # A channel without a mascot (music, ambience) gets its symbol instead of a face.
    images.generate(f"YouTube channel avatar, square, one centered subject, bold and readable at small size, no text. "
                    f"Style: {style}. Subject: {hero.get('description', '')}. {brand.get('avatar_prompt', '')}",
                    raw, "1:1", label=hero.get("name", "Avatar"), role="thumbnail", seed=2)
    ImageOps.fit(Image.open(raw).convert("RGB"), (800, 800), Image.LANCZOS).save(d / "avatar.jpg", quality=92)
    raw.unlink(missing_ok=True)

    brand.update(banner="banner.jpg", avatar="avatar.jpg", preset=preset_id, time=storage.now())
    storage.save_channel({"id": channel_id, "style": style, "brand": brand})
    company.feed("stylist", f"стиль «{brand.get('style_name', '')}» готов: шапка, аватар, правила превью",
                 channel_id=channel_id)
    return storage.get_channel(channel_id)


def restore_previous(channel_id):
    """Swap the current identity with the previous one (so restoring twice undoes it)."""
    ch = storage.get_channel(channel_id)
    if not ch.get("brand_prev"):
        raise RuntimeError("Прошлого стиля нет")
    if ch.get("brand_locked"):
        raise RuntimeError("Стиль канала закреплён 🔒. Снимите замок, чтобы вернуть прошлый.")
    d = CHANNELS_DIR / channel_id
    for name, ext in (("banner", "jpg"), ("avatar", "jpg"), ("hero", "png")):
        cur, prev, tmp = d / f"{name}.{ext}", d / f"{name}_prev.{ext}", d / f"{name}_tmp.{ext}"
        if prev.exists():
            if cur.exists():
                cur.replace(tmp)
            prev.replace(cur)
            if tmp.exists():
                tmp.replace(prev)
    brand = {**ch["brand_prev"], "time": storage.now()}
    storage.save_channel({"id": channel_id, "brand": brand, "style": ch.get("style_prev") or brand.get("style_prompt", ""),
                          "brand_prev": ch.get("brand"), "style_prev": ch.get("style", "")})
    company.feed("stylist", f"вернул прошлый стиль «{brand.get('style_name', '')}»", channel_id=channel_id)
    return storage.get_channel(channel_id)
