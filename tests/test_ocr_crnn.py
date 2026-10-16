import csv
import importlib.util
import json

import pytest

torch = pytest.importorskip("torch")

from anpr.data.plate_generator import DIGIT_FONT, LETTER_FONT
from anpr.models.ocr_crnn import (
    CRNN,
    IMG_HEIGHT,
    IMG_WIDTH,
    greedy_decode,
    preprocess,
)
from anpr.models.ocr_labels import Charset
from anpr.utils.config import REPO_ROOT, default_plate_format


@pytest.fixture
def charset():
    return Charset.from_config(default_plate_format())


def test_output_shape(charset):
    model = CRNN(charset.num_classes).eval()
    out = model(torch.rand(3, 1, IMG_HEIGHT, IMG_WIDTH))
    assert out.shape == (IMG_WIDTH // 4, 3, charset.num_classes)
    # log-probabilities: exp sums to 1 per time step
    assert torch.allclose(out.exp().sum(2), torch.ones(IMG_WIDTH // 4, 3), atol=1e-5)


def test_small_enough_for_cpu(charset):
    assert sum(p.numel() for p in CRNN(charset.num_classes).parameters()) < 1_000_000


def test_bad_height_rejected(charset):
    with pytest.raises(ValueError):
        CRNN(charset.num_classes, img_height=30)


def test_preprocess_and_decode(charset):
    from PIL import Image

    x = preprocess(Image.new("RGB", (520, 112), "white"))
    assert x.shape == (1, IMG_HEIGHT, IMG_WIDTH) and float(x.max()) == 1.0
    log_probs = CRNN(charset.num_classes).eval()(x.unsqueeze(0))
    assert len(greedy_decode(log_probs, charset)) == 1


def test_overfits_one_batch(charset):
    """Sanity check: CTC loss must drop sharply when memorising 4 fixed samples."""
    torch.manual_seed(0)
    model = CRNN(charset.num_classes, dropout=0.0)
    labels = ["12|ب|6", "345|ج|12", "7|د|1", "8890|ه|45"]
    targets = [torch.tensor(charset.encode(t)) for t in labels]
    x = torch.rand(4, 1, IMG_HEIGHT, IMG_WIDTH)
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
    opt = torch.optim.Adam(model.parameters(), lr=3e-3)
    lengths = torch.tensor([len(t) for t in targets])
    flat = torch.cat(targets)

    def step():
        lp = model(x)
        loss = ctc(lp, flat, torch.full((4,), lp.size(0)), lengths)
        opt.zero_grad()
        loss.backward()
        opt.step()
        return loss.item()

    first = step()
    for _ in range(150):
        last = step()
    assert last < first * 0.2


@pytest.mark.skipif(not (DIGIT_FONT.exists() and LETTER_FONT.exists()), reason="fonts not found")
def test_train_smoke(tmp_path):
    spec = importlib.util.spec_from_file_location("gen", REPO_ROOT / "scripts" / "generate_dataset.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    gen.main(["--n", "40", "--out", str(tmp_path / "data"), "--seed", "0"])

    from anpr.training.train_ocr import main

    out = tmp_path / "run"
    results = main(["--data", str(tmp_path / "data"), "--out", str(out), "--epochs", "2",
                    "--batch-size", "8", "--augment"])
    history = results["history"]
    assert [h["epoch"] for h in history] == [1, 2]
    assert all(0 <= h["char_acc"] <= 1 and 0 <= h["plate_acc"] <= 1 for h in history)
    with open(out / "metrics.csv", encoding="utf-8") as f:
        assert len(list(csv.DictReader(f))) == 2
    ckpt = torch.load(out / "best.pt", weights_only=False)
    assert ckpt["img_size"] == (IMG_HEIGHT, IMG_WIDTH)
    assert ckpt["epoch"] == results["best_epoch"]

    with open(out / "results.json", encoding="utf-8") as f:
        saved = json.load(f)
    sizes = saved["sizes"]
    assert sum(sizes.values()) == 40 and sizes["val"] >= 1 and sizes["test"] >= 1
    test = saved["test"]
    assert test["n"] == sizes["test"] and 0 <= test["plate_acc"] <= 1
    assert sum(m["n"] for m in test["by_plate_type"].values()) == test["n"]


@pytest.mark.skipif(not (DIGIT_FONT.exists() and LETTER_FONT.exists()), reason="fonts not found")
def test_train_real_mix_fine_tunes(tmp_path):
    """--real + --init: selection and test on real plates, synthetic test still scored."""
    from PIL import Image

    from anpr.data.real_plates import split_of
    from anpr.training.train_ocr import main

    spec = importlib.util.spec_from_file_location("gen", REPO_ROOT / "scripts" / "generate_dataset.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    gen.main(["--n", "40", "--out", str(tmp_path / "syn"), "--seed", "0"])
    base = main(["--data", str(tmp_path / "syn"), "--out", str(tmp_path / "base"), "--epochs", "1", "--batch-size", "8"])
    assert base["init"] is None and base["real"] is None

    # stand-in "real" crops: synthetic images relabelled; enough plates that every split gets some
    real = tmp_path / "real"
    (real / "images").mkdir(parents=True)
    with open(tmp_path / "syn" / "labels.csv", encoding="utf-8") as f:
        syn = list(csv.DictReader(f))
    lines = ["filename,label,source"]
    for i, row in enumerate(syn):
        Image.open(tmp_path / "syn" / row["filename"]).save(real / "images" / f"{i}.png")
        lines.append(f"images/{i}.png,{row['label']},photo{i}.jpg")
    lines += ["images/0.png,-,photo0.jpg", "images/1.png,64112|A|7,photo1.jpg"]
    (real / "labels.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert {split_of(r["label"]) for r in syn} == {"train", "val", "test"}

    out = tmp_path / "ft"
    results = main(["--data", str(tmp_path / "syn"), "--real", str(real), "--init", str(tmp_path / "base" / "best.pt"),
                    "--out", str(out), "--epochs", "2", "--batch-size", "8", "--augment"])
    assert results["init"].endswith("best.pt") and results["args"]["lr"] == 3e-4
    r = results["real"]
    assert sum(r["sizes"].values()) == len(syn) and results["test"]["n"] == r["sizes"]["test"]
    assert [x["label"] for x in r["rejected"]] == ["-", "64112|A|7"]
    assert set(results["test"]["by_plate_type"]) == {"real"}
    assert 0 <= r["synthetic_test"]["plate_acc"] <= 1


def test_train_refuses_overlapping_splits(tmp_path):
    from anpr.training.train_ocr import load_splits

    header = "filename,label,plate_type\n"
    (tmp_path / "train.csv").write_text(header + "images/0.png,12|ب|6,private\n", encoding="utf-8")
    (tmp_path / "val.csv").write_text(header + "images/1.png,34|ب|6,taxi\n", encoding="utf-8")
    (tmp_path / "test.csv").write_text(header + "images/2.png,12|ب|6,police\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="both train and test"):
        load_splits(tmp_path)


def _ckpt(path, charset, model=None, img_size=(IMG_HEIGHT, IMG_WIDTH), chars=None):
    model = model or CRNN(charset.num_classes)
    torch.save({"model": model.state_dict(), "charset": chars or charset.chars, "img_size": img_size, "epoch": 7}, path)
    return model


def test_init_loads_checkpoint_weights(tmp_path, charset):
    from anpr.training.train_ocr import load_init

    source = _ckpt(tmp_path / "best.pt", charset)
    target = CRNN(charset.num_classes)
    load_init(target, tmp_path / "best.pt", charset, torch.device("cpu"))
    for a, b in zip(source.state_dict().values(), target.state_dict().values(), strict=True):
        assert torch.equal(a, b)


def test_init_refuses_other_charset_or_size(tmp_path, charset):
    from anpr.training.train_ocr import load_init

    _ckpt(tmp_path / "chars.pt", charset, chars=list(charset.chars)[:-1] + ["X"])
    with pytest.raises(SystemExit, match="different charset"):
        load_init(CRNN(charset.num_classes), tmp_path / "chars.pt", charset, torch.device("cpu"))
    _ckpt(tmp_path / "size.pt", charset, img_size=(IMG_HEIGHT * 2, IMG_WIDTH))
    with pytest.raises(SystemExit, match="expects images"):
        load_init(CRNN(charset.num_classes), tmp_path / "size.pt", charset, torch.device("cpu"))


@pytest.mark.skipif(not (DIGIT_FONT.exists() and LETTER_FONT.exists()), reason="fonts not found")
def test_fine_tune_from_checkpoint_with_camera_augment(tmp_path, charset):
    spec = importlib.util.spec_from_file_location("gen", REPO_ROOT / "scripts" / "generate_dataset.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    gen.main(["--n", "30", "--out", str(tmp_path / "data"), "--seed", "1"])
    _ckpt(tmp_path / "start.pt", charset)

    from anpr.training.train_ocr import main

    results = main(["--data", str(tmp_path / "data"), "--out", str(tmp_path / "run"), "--epochs", "1",
                    "--batch-size", "8", "--augment", "camera", "--init", str(tmp_path / "start.pt")])
    assert results["args"]["augment"] == "camera"
    assert results["args"]["init"] == str(tmp_path / "start.pt")


def test_init_must_exist(tmp_path):
    from anpr.training.train_ocr import parse_args

    with pytest.raises(SystemExit):
        parse_args(["--init", str(tmp_path / "missing.pt")])

