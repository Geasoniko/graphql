"""Ready-made visual styles for channels (prompts are in English for image models)."""

PRESETS = [
    {
        "id": "stick_doodle",
        "name": "Stick-figure doodle (человечки-палочки)",
        "about": "Нарисовано от руки маркером: круглые головы, палочки вместо рук, бумажный фон, 2–4 цвета. Как Sam O'Nella / Casually Explained.",
        "prompt": ("Hand-drawn doodle stick-figure cartoon on a warm off-white paper background (#FAF6E6). "
                   "Characters have round white heads, simple dot eyes and expressive mouths, thin black stick "
                   "arms and legs, messy hair, minimal clothing shapes. Thick, slightly uneven black marker "
                   "outlines. Flat colors only, limited to a few accents: warm brown, red, yellow, sky blue. "
                   "No shading, no gradients, no realism, no 3D. Lots of empty space, one clear idea per frame, "
                   "simple icon-like props, humorous whiteboard explainer look."),
    },
    {
        "id": "flat_cartoon",
        "name": "Flat 2D cartoon (плоский мультфильм)",
        "about": "Аккуратная мультяшная рисовка с толстым контуром и тёплыми цветами — как в рилсах про пещерного человека.",
        "prompt": ("Clean flat 2D cartoon illustration, bold black outlines, soft muted warm palette, simple shapes, "
                   "expressive cartoon characters with big heads, subtle flat shadows, storybook background, "
                   "consistent character design, family-friendly explainer animation look."),
    },
    {
        "id": "anime_cozy",
        "name": "Cozy anime (уютное аниме)",
        "about": "Мягкий свет, аниме-герой, детальные уютные фоны — как «The Debt That Grows While You Sleep».",
        "prompt": ("Cozy 2D anime illustration, soft cel shading, warm cinematic lighting, detailed lived-in "
                   "backgrounds, a recurring young protagonist with simple expressive face, muted teal and amber "
                   "palette, slice-of-life mood, film still composition."),
    },
    {
        "id": "dark_history",
        "name": "Dark painted history (мрачная история)",
        "about": "Драматичная цифровая живопись для историй, тайн и true crime.",
        "prompt": ("Dramatic digital painting, cinematic chiaroscuro lighting, muted earthy palette with deep "
                   "shadows, painterly brush texture, historical atmosphere, epic wide compositions, documentary mood."),
    },
]
