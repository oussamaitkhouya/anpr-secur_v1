"""Albumentations pipelines for synthetic and real plates, and pasting plates onto scenes.

All functions take and return RGB PIL images; Albumentations works on numpy arrays
internally. Augmentations change only pixels, never the plate label.
"""

import random

import albumentations as A
import cv2
import numpy as np
from PIL import Image


def single_transforms() -> dict[str, A.BasicTransform]:
    """Each augmentation on its own at p=1, for previews and tests."""
    return {
        "motion_blur": A.MotionBlur(blur_limit=(3, 9), p=1),
        # darker streaks than the default so they show on a white plate
        "rain": A.RandomRain(slant_range=(-15, 15), drop_length=30, drop_width=1, blur_value=1,
                             drop_color=(110, 110, 110), brightness_coefficient=0.9, p=1),
        # A.RandomFog is tuned for full scenes and barely changes a 520x112 crop,
        # so plate fog is built as haze: washed-out contrast, lifted brightness, soft blur.
        "fog": A.Sequential([
            A.RandomBrightnessContrast(brightness_limit=(0.05, 0.2), contrast_limit=(-0.65, -0.4), p=1),
            A.GaussianBlur(blur_limit=(3, 5), p=1),
        ], p=1),
        "noise": A.GaussNoise(std_range=(0.02, 0.08), p=1),
        "perspective": A.Perspective(scale=(0.02, 0.07), fit_output=True,
                                     border_mode=cv2.BORDER_REPLICATE, p=1),
        "brightness": A.RandomBrightnessContrast(brightness_limit=0.35, contrast_limit=0.3, p=1),
        "jpeg": A.ImageCompression(compression_type="jpeg", quality_range=(20, 60), p=1),
    }


def build_plate_augment(seed: int | None = None) -> A.Compose:
    """Realistic mix: geometry first, then weather, then camera and lighting, then compression."""
    t = single_transforms()
    return A.Compose(
        [
            A.Perspective(scale=(0.02, 0.07), fit_output=True, border_mode=cv2.BORDER_REPLICATE, p=0.6),
            A.OneOf([t["rain"], t["fog"]], p=0.25),
            A.MotionBlur(blur_limit=(3, 7), p=0.3),
            A.RandomBrightnessContrast(brightness_limit=0.3, contrast_limit=0.25, p=0.7),
            A.GaussNoise(std_range=(0.01, 0.06), p=0.4),
            A.ImageCompression(compression_type="jpeg", quality_range=(30, 90), p=0.5),
        ],
        seed=seed,
    )


def build_camera_augment(seed: int | None = None) -> A.Compose:
    """Webcam and phone conditions, for training on real crops (--augment camera).

    On top of the plate pipeline: low resolution (a far plate is only a few dozen pixels wide),
    defocus, sensor noise, gamma and glare-like contrast swings. These are what make a 6 look
    like an 8 on a real frame; synthetic renders rarely show them.
    """
    t = single_transforms()
    return A.Compose(
        [
            A.Perspective(scale=(0.02, 0.08), fit_output=True, border_mode=cv2.BORDER_REPLICATE, p=0.6),
            A.OneOf([t["rain"], t["fog"]], p=0.15),
            A.OneOf([
                A.MotionBlur(blur_limit=(3, 9), p=1),
                A.Defocus(radius=(1, 3), p=1),
                A.GaussianBlur(blur_limit=(3, 5), p=1),
            ], p=0.5),
            A.Downscale(scale_range=(0.3, 0.7), p=0.4),
            A.RandomBrightnessContrast(brightness_limit=0.35, contrast_limit=0.35, p=0.7),
            A.RandomGamma(gamma_limit=(60, 160), p=0.3),
            A.OneOf([A.GaussNoise(std_range=(0.02, 0.08), p=1), A.ISONoise(p=1)], p=0.5),
            A.ImageCompression(compression_type="jpeg", quality_range=(20, 85), p=0.6),
        ],
        seed=seed,
    )


def build_light_augment(seed: int | None = None) -> A.Compose:
    """Mild version for baking into the stored dataset: keeps every character readable.

    The heavy pipeline (build_plate_augment) is still available on the fly at training time,
    so the saved images should not already be badly degraded.
    """
    return A.Compose(
        [
            A.Perspective(scale=(0.01, 0.03), fit_output=True, border_mode=cv2.BORDER_REPLICATE, p=0.3),
            A.RandomBrightnessContrast(brightness_limit=0.15, contrast_limit=0.15, p=0.5),
            A.GaussNoise(std_range=(0.01, 0.03), p=0.3),
            A.ImageCompression(compression_type="jpeg", quality_range=(70, 95), p=0.3),
        ],
        seed=seed,
    )


def build_real_augment(seed: int | None = None) -> A.Compose:
    """For real plate crops, which already carry real blur, angle and lighting.

    The main new source of variation is the detector itself: its boxes are a little loose,
    tight or off-centre from frame to frame, so the crop is shifted, scaled and tilted
    slightly (edges replicated, characters never cut off). On top: the low resolution of
    distant plates, mild blur, lighting and JPEG. Weaker than build_plate_augment, which has
    to make clean synthetic plates look like photos.
    """
    return A.Compose(
        [
            A.Affine(scale=(0.9, 1.08), translate_percent={"x": (-0.04, 0.04), "y": (-0.08, 0.08)},
                     rotate=(-4, 4), shear=(-4, 4), border_mode=cv2.BORDER_REPLICATE, p=0.8),
            A.Downscale(scale_range=(0.35, 0.8), p=0.3),
            A.OneOf([A.MotionBlur(blur_limit=(3, 5)), A.GaussianBlur(blur_limit=(3, 5))], p=0.25),
            A.RandomBrightnessContrast(brightness_limit=0.25, contrast_limit=0.25, p=0.6),
            A.CLAHE(clip_limit=(1, 3), p=0.15),
            A.GaussNoise(std_range=(0.01, 0.04), p=0.25),
            A.ImageCompression(compression_type="jpeg", quality_range=(35, 90), p=0.4),
        ],
        seed=seed,
    )


def apply(transform: A.BasicTransform | A.Compose, img: Image.Image) -> Image.Image:
    out = transform(image=np.asarray(img.convert("RGB")))["image"]
    return Image.fromarray(out)


def paste_plate(
    plate: Image.Image,
    background: Image.Image,
    rng: random.Random | None = None,
    width_range: tuple[float, float] = (0.15, 0.35),
    position: tuple[int, int] | None = None,
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """Paste plate onto background; return the scene and the plate box (x1, y1, x2, y2).

    The plate is resized to a random share of the background width (width_range),
    keeping its aspect ratio. Without position it lands at a random spot in the
    lower two thirds of the image, where plates usually are on a car photo.
    """
    rng = rng or random.Random()
    scene = background.convert("RGB").copy()
    bw, bh = scene.size

    w = max(1, round(bw * rng.uniform(*width_range)))
    h = max(1, round(w * plate.height / plate.width))
    if h > bh:  # very wide backgrounds: shrink to fit height
        h, w = bh, max(1, round(bh * plate.width / plate.height))
    resized = plate.convert("RGB").resize((w, h), Image.LANCZOS)

    if position is None:
        x = rng.randint(0, bw - w)
        y = rng.randint(min(bh // 3, bh - h), bh - h)
    else:
        x, y = position
        if not (0 <= x <= bw - w and 0 <= y <= bh - h):
            raise ValueError(f"plate of size {(w, h)} at {position} does not fit in {(bw, bh)}")

    scene.paste(resized, (x, y))
    return scene, (x, y, x + w, y + h)
