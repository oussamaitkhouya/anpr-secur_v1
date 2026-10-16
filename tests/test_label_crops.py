import csv
import importlib.util
import json
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer

import pytest
from PIL import Image

from anpr.utils.config import REPO_ROOT


def _load_script():
    spec = importlib.util.spec_from_file_location("label_crops", REPO_ROOT / "scripts" / "label_crops.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lc = _load_script()


@pytest.fixture
def crops(tmp_path):
    (tmp_path / "images").mkdir()
    rows = []
    for i in range(3):
        name = f"images/c{i}.png"
        Image.new("RGB", (60, 20)).save(tmp_path / name)
        rows.append({"filename": name, "label": "", "source": "nowhere.jpg"})
    rows[1]["label"] = "123|ب|6"
    with open(tmp_path / "labels.csv", "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=lc.FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return tmp_path


def test_clean_label_canonicalises_valid_plates():
    assert lc.clean_label(" 0123 - ب - 06 ") == ("123|ب|6", None)
    assert lc.clean_label("١٢٣|ب|٦") == ("123|ب|6", None)


def test_clean_label_keeps_unknown_letter_with_warning():
    label, warning = lc.clean_label("123|W|6")
    assert label == "123|W|6"
    assert "not valid" in warning


def test_clean_label_unreadable_and_empty():
    assert lc.clean_label("-") == (lc.UNREADABLE, None)
    with pytest.raises(ValueError):
        lc.clean_label("   ")


def test_save_is_atomic_and_keeps_columns(crops):
    app = lc.Labeller(crops, {})
    app.set_label(0, "45|أ|40")
    app.set_label(2, "-")
    rows = lc.load_rows(crops / "labels.csv")
    assert [r["label"] for r in rows] == ["45|أ|40", "123|ب|6", "-"]
    assert rows[0]["source"] == "nowhere.jpg"
    assert not list(crops.glob(".labels-*"))  # no temp file left behind
    assert lc.counts(rows) == {"total": 3, "labelled": 2, "unreadable": 1, "todo": 0}


def test_next_todo_skips_labelled_and_wraps(crops):
    app = lc.Labeller(crops, {})
    assert app.next_todo(-1) == 0
    assert app.next_todo(0) == 2   # row 1 is labelled
    assert app.next_todo(2) == 0   # wraps around


def test_drafts_prefer_later_files_and_ignore_empty(tmp_path):
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    a.write_text("filename,prediction\nx.png,1|ب|2\ny.png,3|ب|4\n", encoding="utf-8")
    b.write_text("filename,label\nx.png,9|ب|9\ny.png,\n", encoding="utf-8")
    assert lc.load_drafts([a, b]) == {"x.png": "9|ب|9", "y.png": "3|ب|4"}


@pytest.fixture
def server(crops):
    app = lc.Labeller(crops, {"images/c0.png": "7|ج|1"})
    srv = HTTPServer(("127.0.0.1", 0), lc.make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", app
    srv.shutdown()


def _get(url):
    with urllib.request.urlopen(url) as r:
        return r.status, r.read()


def test_http_flow(server):
    base, app = server
    _, body = _get(base + "/api/next?after=-1")
    item = json.loads(body)
    assert (item["index"], item["draft"], item["todo"]) == (0, "7|ج|1", 2)
    assert _get(base + "/crop?i=0")[1][:4] == b"\x89PNG"

    req = urllib.request.Request(base + "/api/label", method="POST",
                                 data=json.dumps({"index": 0, "label": "7|ج|1"}).encode())
    with urllib.request.urlopen(req) as r:
        assert json.loads(r.read())["label"] == "7|ج|1"
    assert lc.load_rows(app.labels_csv)[0]["label"] == "7|ج|1"


@pytest.mark.parametrize("path", ["/crop?i=99", "/crop?i=-1", "/crop?i=abc", "/../labels.csv", "/crop?i=0/../../x"])
def test_http_refuses_unknown_files(server, path):
    base, _ = server
    with pytest.raises(urllib.error.HTTPError) as e:
        _get(base + path)
    assert e.value.code in (400, 404)


def test_http_rejects_bad_post(server):
    base, app = server
    for payload in ({"index": 9, "label": "1|ب|1"}, {"index": 0, "label": ""}, {"label": "1|ب|1"}):
        req = urllib.request.Request(base + "/api/label", method="POST", data=json.dumps(payload).encode())
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        assert e.value.code == 400
    assert lc.load_rows(app.labels_csv)[0]["label"] == ""
