import importlib.util
import random

import numpy as np
import pytest
from PIL import Image

from anpr.data.augment import (
    apply,
    build_camera_augment,
    build_light_augment,
    build_plate_augment,
    build_real_augment,
    paste_plate,
    single_transforms,
)
from anpr.utils.config import REPO_ROOT

EXPECTED = {"motion_blur", "rain", "fog", "noise", "perspective", "brightness", "jpeg"}


def _plate(seed=0) -> Image.Image:
    """A plate-like test image (no fonts needed): white with dark bars."""
    arr = np.full((112, 520, 3), 255, np.uint8)
    rs = np.random.default_rng(seed)
    for x in rs.integers(20, 480, 8):
        arr[20:92, x : x + 20] = 0
    return Image.fromarray(arr)


def test_all_requested_transforms_present():
    assert set(single_transforms()) == EXPECTED


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_single_transform_changes_pixels(name):
    t = single_transforms()[name]
    t.set_random_seed(0)
    img = _plate()
    out = apply(t, img)
    assert out.mode == "RGB"
    if name != "perspective":  # fit_output may change size
        assert out.size == img.size
    assert out.tobytes() != img.tobytes()


def test_pipeline_is_seeded():
    a = apply(build_plate_augment(seed=1), _plate())
    b = apply(build_plate_augment(seed=1), _plate())
    assert a.tobytes() == b.tobytes()


def test_camera_pipeline_is_seeded_and_changes_the_plate():
    img = _plate()
    outs = [apply(build_camera_augment(seed=s), img) for s in range(20)]
    assert apply(build_camera_augment(seed=3), img).tobytes() == outs[3].tobytes()
    assert all(o.mode == "RGB" for o in outs)
    assert sum(o.tobytes() != img.tobytes() for o in outs) >= 12  # most, not all: clean crops are useful too


def test_light_pipeline_is_seeded_and_mild():
    img = _plate()
    a = apply(build_light_augment(seed=2), img)
    b = apply(build_light_augment(seed=2), img)
    assert a.tobytes() == b.tobytes()
    if a.size == img.size:  # perspective (fit_output) may change size
        diff = np.abs(np.asarray(a, np.int16) - np.asarray(img, np.int16)).mean()
        assert diff < 40  # light: the plate stays close to the original


def test_paste_plate_box_in_bounds_and_contains_plate():
    bg = Image.new("RGB", (640, 480), (0, 0, 255))
    rng = random.Random(0)
    for _ in range(50):
        scene, (x1, y1, x2, y2) = paste_plate(_plate(), bg, rng)
        assert scene.size == bg.size
        assert 0 <= x1 < x2 <= 640 and 0 <= y1 < y2 <= 480
        assert y1 >= 480 // 3  # lower two thirds
        # plate has white pixels; background is pure blue
        assert scene.crop((x1, y1, x2, y2)).getpixel((1, 1)) != (0, 0, 255)


def test_paste_plate_fixed_position_and_errors():
    bg = Image.new("RGB", (400, 300))
    _, box = paste_plate(_plate(), bg, random.Random(0), width_range=(0.5, 0.5), position=(10, 20))
    assert box[:2] == (10, 20) and box[2] - box[0] == 200
    with pytest.raises(ValueError):
        paste_plate(_plate(), bg, width_range=(0.5, 0.5), position=(390, 20))


def test_paste_plate_onto_tiny_background():
    bg = Image.new("RGB", (2000, 50))
    _, (_, y1, x2, y2) = paste_plate(_plate(), bg, random.Random(0), width_range=(0.9, 0.9))
    assert y2 - y1 <= 50 and x2 <= 2000


def test_preview_script(tmp_path):
    from anpr.data.plate_generator import DIGIT_FONT, LETTER_FONT

    if not (DIGIT_FONT.exists() and LETTER_FONT.exists()):
        pytest.skip("fonts not found")
    spec = importlib.util.spec_from_file_location("preview", REPO_ROOT / "scripts" / "preview_augmentations.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    paths = module.main(["--out", str(tmp_path), "--cols", "2", "--backgrounds", str(tmp_path / "none")])
    for p in paths:
        assert Image.open(p).size[0] > 0


def test_real_pipeline_is_seeded_and_keeps_size():
    img = _plate()
    a = apply(build_real_augment(seed=3), img)
    b = apply(build_real_augment(seed=3), img)
    assert a.tobytes() == b.tobytes()
    assert a.size == img.size  # affine jitter keeps the frame: characters are shifted, never cropped away
