"""Render synthetic Moroccan licence plates with Pillow.

Layout (left to right): number | letter | region, with vertical separators,
matching the canonical label "number|letter|region".

variety=True closes the gap to real plates for OCR training: real Moroccan plates use a narrow,
condensed font with thinner strokes than the default Cairo Bold. Each plate then picks a digit
font and weight (variable Cairo / Montserrat, 300-900), a condensed Arabic width (Noto Sans
Arabic wdth axis), squeezes each text horizontally, and jitters cell widths, sizes, borders and
separators. Off by default, so existing datasets and tests are unchanged.

This Pillow build has no libraqm, so Arabic text is shaped with arabic-reshaper
and reordered with python-bidi before drawing, using Pillow's BASIC layout.
"""

import random
from dataclasses import dataclass
from pathlib import Path

import arabic_reshaper
import numpy as np
from bidi import get_display
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

from anpr.pipeline.validator import Plate
from anpr.utils.config import REPO_ROOT, PlateFormat, default_plate_format

FONT_DIR = REPO_ROOT / "data" / "fonts"
DIGIT_FONT = FONT_DIR / "Cairo-Bold.ttf"
LETTER_FONT = FONT_DIR / "NotoSansArabic-Bold.ttf"

# Variable fonts (Google Fonts, OFL) used when variety=True: (path, weights, axes builder)
VARIABLE_DIGIT_FONTS = (
    (REPO_ROOT / "data" / "Cairo" / "Cairo-VariableFont_slnt,wght.ttf", (300, 450, 600, 800, 950), lambda w: [w, 0]),
    (REPO_ROOT / "data" / "Montserrat" / "Montserrat-VariableFont_wght.ttf", (300, 500, 700, 850), lambda w: [w]),
)
VARIABLE_LETTER_FONT = REPO_ROOT / "data" / "Noto_Sans_Arabic" / "NotoSansArabic-VariableFont_wdth,wght.ttf"

PLATE_SIZE = (520, 112)          # width, height in pixels
CELL_SPLIT = (0.56, 0.19, 0.25)  # share of width for number, letter, region


@dataclass(frozen=True)
class GeneratedPlate:
    image: Image.Image
    label: str
    plate_type: str


def shape_arabic(text: str) -> str:
    """Join and reorder Arabic text so Pillow's BASIC layout draws it correctly."""
    return get_display(arabic_reshaper.reshape(text))


class PlateGenerator:
    def __init__(
        self,
        fmt: PlateFormat | None = None,
        digit_font: Path | str = DIGIT_FONT,
        letter_font: Path | str = LETTER_FONT,
        seed: int | None = None,
        augment: bool = True,
        variety: bool = False,
    ):
        self.fmt = fmt or default_plate_format()
        self.rng = random.Random(seed)
        self.augment = augment
        basic = ImageFont.Layout.BASIC
        self.digit_font = ImageFont.truetype(str(digit_font), 72, layout_engine=basic)
        self.letter_font = ImageFont.truetype(str(letter_font), 64, layout_engine=basic)
        self.letters = sorted(self.fmt.letters)
        self.variety = variety
        self.digit_fonts: list[ImageFont.FreeTypeFont] = []
        self.letter_fonts: list[ImageFont.FreeTypeFont] = []
        if variety:
            for path, weights, axes in VARIABLE_DIGIT_FONTS:
                if path.is_file():
                    for w in weights:
                        f = ImageFont.truetype(str(path), 80, layout_engine=basic)
                        f.set_variation_by_axes(axes(w))
                        self.digit_fonts.append(f)
            if VARIABLE_LETTER_FONT.is_file():
                for width in (62.5, 75, 87.5, 100):
                    for w in (400, 600, 800):
                        f = ImageFont.truetype(str(VARIABLE_LETTER_FONT), 70, layout_engine=basic)
                        f.set_variation_by_axes([width, w])
                        self.letter_fonts.append(f)
            self.digit_fonts = self.digit_fonts or [self.digit_font]
            self.letter_fonts = self.letter_fonts or [self.letter_font]

    def random_plate(self) -> Plate:
        digits = self.rng.randint(1, 5)
        number = self.rng.randint(10 ** (digits - 1), 10**digits - 1)
        letter = self.rng.choice(self.letters)
        region = self.rng.randint(self.fmt.region_min, self.fmt.region_max)
        return Plate(number, letter, region)

    def render(self, plate: Plate, plate_type: str = "private") -> Image.Image:
        if self.variety:
            return self._render_varied(plate, plate_type)
        style = self._plate_type(plate_type)
        w, h = PLATE_SIZE
        img = Image.new("RGB", PLATE_SIZE, style.background)
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle((2, 2, w - 3, h - 3), radius=10, outline=style.text_color, width=4)

        texts = [
            (str(plate.number), self.digit_font),
            (shape_arabic(plate.letter), self.letter_font),
            (str(plate.region), self.digit_font),
        ]
        x = 0
        for i, ((text, font), share) in enumerate(zip(texts, CELL_SPLIT)):
            cell_w = share * w
            draw.text((x + cell_w / 2, h / 2), text, font=font, fill=style.text_color, anchor="mm")
            x += cell_w
            if i < len(texts) - 1:
                draw.line((x, 14, x, h - 14), fill=style.text_color, width=4)

        return self._augment(img) if self.augment else img

    def _render_varied(self, plate: Plate, plate_type: str) -> Image.Image:
        """Same layout, randomised font, weight, condensing, proportions and lines."""
        r = self.rng
        style = self._plate_type(plate_type)
        w, h = PLATE_SIZE
        img = Image.new("RGB", PLATE_SIZE, style.background)
        draw = ImageDraw.Draw(img)
        line = r.randint(2, 5)
        draw.rounded_rectangle((2, 2, w - 3, h - 3), radius=r.randint(4, 14), outline=style.text_color, width=line)

        number_share = r.uniform(0.50, 0.60)
        letter_share = r.uniform(0.15, 0.21)
        shares = (number_share, letter_share, 1 - number_share - letter_share)
        digit_font = r.choice(self.digit_fonts)
        letter_font = r.choice(self.letter_fonts)
        squeeze = r.uniform(0.55, 1.0)  # real plates are condensed
        texts = [(str(plate.number), digit_font), (shape_arabic(plate.letter), letter_font), (str(plate.region), digit_font)]
        x = 0.0
        for i, ((text, font), share) in enumerate(zip(texts, shares, strict=True)):
            cell_w = share * w
            glyphs = self._text_layer(text, font, style.text_color)
            target_h = h * r.uniform(0.55, 0.75)
            scale_y = target_h / glyphs.height
            new_w = max(1, int(glyphs.width * scale_y * (squeeze if i != 1 else r.uniform(0.75, 1.0))))
            margin = 18  # real plates leave clear space around the separators
            new_w = min(new_w, int(cell_w - 2 * margin))  # never touch a separator or the border
            glyphs = glyphs.resize((new_w, max(1, int(target_h))), Image.LANCZOS)
            free = cell_w - 2 * margin - glyphs.width
            px = int(x + margin + free / 2 + r.uniform(-min(3, free / 2), min(3, free / 2)))
            py = int((h - glyphs.height) / 2 + r.uniform(-3, 3))
            img.paste(glyphs, (px, py), glyphs)
            x += cell_w
            if i < len(texts) - 1:
                inset = r.randint(10, 22)
                draw.line((x, inset, x, h - inset), fill=style.text_color, width=r.randint(2, 5))

        return self._augment(img) if self.augment else img

    @staticmethod
    def _text_layer(text: str, font: ImageFont.FreeTypeFont, color) -> Image.Image:
        """Text drawn tight on a transparent layer, so it can be squeezed independently."""
        left, top, right, bottom = font.getbbox(text)
        layer = Image.new("RGBA", (max(1, right - left), max(1, bottom - top)), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((-left, -top), text, font=font, fill=color)
        return layer

    def generate(self, plate_type: str | None = None) -> GeneratedPlate:
        plate_type = plate_type or self.rng.choice(sorted(self.fmt.plate_types))
        plate = self.random_plate()
        return GeneratedPlate(self.render(plate, plate_type), plate.canonical(), plate_type)

    def _plate_type(self, name: str):
        try:
            return self.fmt.plate_types[name]
        except KeyError:
            known = ", ".join(sorted(self.fmt.plate_types))
            raise ValueError(f"unknown plate type {name!r}; known: {known}") from None

    def _augment(self, img: Image.Image) -> Image.Image:
        """Mild camera-like distortions: margin, tilt, blur, lighting, sensor noise."""
        r = self.rng
        pad = r.randint(4, 20)
        bg = tuple(r.randint(40, 200) for _ in range(3))
        canvas = Image.new("RGB", (img.width + 2 * pad, img.height + 2 * pad), bg)
        canvas.paste(img, (pad, pad))

        canvas = canvas.rotate(r.uniform(-4, 4), resample=Image.BICUBIC, expand=False, fillcolor=bg)
        canvas = canvas.filter(ImageFilter.GaussianBlur(r.uniform(0, 1.2)))
        canvas = ImageEnhance.Brightness(canvas).enhance(r.uniform(0.7, 1.2))
        canvas = ImageEnhance.Contrast(canvas).enhance(r.uniform(0.8, 1.2))

        arr = np.asarray(canvas, dtype=np.float32)
        noise = np.random.default_rng(r.getrandbits(32)).normal(0, r.uniform(0, 8), arr.shape)
        return Image.fromarray(np.clip(arr + noise, 0, 255).astype(np.uint8))
