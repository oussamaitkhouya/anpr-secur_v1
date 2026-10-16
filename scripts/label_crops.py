"""Label the real plate crops (data/real_crops) in the browser, one crop at a time.

    .venv\\Scripts\\python scripts\\label_crops.py
    .venv\\Scripts\\python scripts\\label_crops.py --drafts data/real_crops/predictions_ocr.csv

Then open http://127.0.0.1:8765. Type number, letter, region; Enter saves and moves on.
Every save rewrites labels.csv atomically (temp file + rename), so stopping at any point is safe.
A crop nobody can read is saved as "-" (UNREADABLE) and eval_ocr_real.py ignores it.

--drafts takes CSVs with a filename column and a label or prediction column (for example the
predictions_*.csv written by eval_ocr_real.py). Drafts only pre-fill the form: a human confirms
every label before it is written.

Security: the crops are real plates (personal data), so the server binds to 127.0.0.1 only and
serves only files listed in labels.csv (no path from the request reaches the filesystem).
"""

import argparse
import csv
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from anpr.pipeline.validator import normalize, parse_plate
from anpr.utils.config import default_plate_format

UNREADABLE = "-"
FIELDS = ["filename", "label", "source"]
TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def load_rows(labels_csv: Path) -> list[dict]:
    with open(labels_csv, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def save_rows(labels_csv: Path, rows: list[dict]) -> None:
    """Write to a temp file in the same folder, then rename: a crash never leaves a half-written CSV."""
    fd, tmp = tempfile.mkstemp(dir=labels_csv.parent, prefix=".labels-", suffix=".csv")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        os.replace(tmp, labels_csv)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_drafts(paths: list[Path]) -> dict[str, str]:
    """filename -> suggested label; later files win. Empty suggestions are ignored."""
    drafts = {}
    for path in paths:
        for row in load_rows(path):
            text = (row.get("label") or row.get("prediction") or "").strip()
            if text and row.get("filename"):
                drafts[row["filename"]] = text
    return drafts


def clean_label(raw: str) -> tuple[str, str | None]:
    """Return (label to store, warning or None). Canonical when valid; kept as typed otherwise.

    The letter set and region range in configs/plate_format.yaml are not verified yet, so a
    plate outside them is saved with a warning instead of being refused: real plates are the
    evidence for fixing the config.
    """
    text = raw.strip()
    if text == UNREADABLE:
        return UNREADABLE, None
    text = normalize(text)
    if not text:
        raise ValueError("empty label")
    plate = parse_plate(text)
    if plate:
        return plate.canonical(), None
    return text, f"{text!r} is not valid under configs/plate_format.yaml (saved anyway)"


def counts(rows: list[dict]) -> dict:
    labels = [(r.get("label") or "").strip() for r in rows]
    unreadable = sum(lb == UNREADABLE for lb in labels)
    done = sum(bool(lb) for lb in labels)
    return {"total": len(rows), "labelled": done - unreadable, "unreadable": unreadable, "todo": len(rows) - done}


class Labeller:
    """labels.csv rows in memory, plus the drafts; the single-threaded server is the only writer."""

    def __init__(self, crops: Path, drafts: dict[str, str]):
        self.crops = crops
        self.labels_csv = crops / "labels.csv"
        self.rows = load_rows(self.labels_csv)
        self.drafts = drafts
        self.letters = sorted(default_plate_format().letters)

    def item(self, i: int) -> dict:
        r = self.rows[i]
        return {"index": i, "filename": r["filename"], "label": r.get("label", ""),
                "draft": self.drafts.get(r["filename"], ""), "source": r.get("source", ""),
                **counts(self.rows)}

    def next_todo(self, after: int = -1) -> int:
        n = len(self.rows)
        for k in range(1, n + 1):
            i = (after + k) % n
            if not (self.rows[i].get("label") or "").strip():
                return i
        return max(after, 0)

    def set_label(self, i: int, raw: str) -> str | None:
        label, warning = clean_label(raw)
        self.rows[i]["label"] = label
        save_rows(self.labels_csv, self.rows)
        return warning

    def file_for(self, i: int, kind: str) -> Path:
        """Only paths written in labels.csv are served, never one taken from the URL."""
        r = self.rows[i]
        return self.crops / r["filename"] if kind == "crop" else REPO / r["source"]


def make_handler(app: Labeller):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the console for warnings only
            pass

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def _index(self, qs) -> int:
            i = int(qs.get("i", ["-1"])[0])
            if not 0 <= i < len(app.rows):
                raise IndexError(i)
            return i

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query)
            try:
                if url.path == "/":
                    page = PAGE.replace("__LETTERS__", json.dumps(app.letters, ensure_ascii=False))
                    return self._send(200, page.encode(), "text/html; charset=utf-8")
                if url.path == "/api/item":
                    return self._json(app.item(self._index(qs)))
                if url.path == "/api/next":
                    return self._json(app.item(app.next_todo(int(qs.get("after", ["-1"])[0]))))
                if url.path in ("/crop", "/source"):
                    path = app.file_for(self._index(qs), url.path[1:])
                    ctype = TYPES.get(path.suffix.lower())
                    if ctype and path.is_file():
                        return self._send(200, path.read_bytes(), ctype)
                self._json({"error": "not found"}, 404)
            except (ValueError, IndexError):
                self._json({"error": "bad index"}, 400)

        def do_POST(self):
            if urlparse(self.path).path != "/api/label":
                return self._json({"error": "not found"}, 404)
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                i = int(body["index"])
                if not 0 <= i < len(app.rows):
                    raise IndexError(i)
                warning = app.set_label(i, str(body["label"]))
            except PermissionError:
                return self._json({"error": "labels.csv is locked (open in Excel?); close it and retry"}, 409)
            except (ValueError, KeyError, IndexError, TypeError) as e:
                return self._json({"error": f"rejected: {e}"}, 400)
            if warning:
                print("warning:", warning)
            self._json({"ok": True, "warning": warning, **app.item(i)})

    return Handler


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Label plate crops</title>
<style>
 :root{--bg:#111418;--panel:#1b2027;--fg:#e8eaed;--mute:#9aa0a6;--acc:#4f8cff;--ok:#3fb27f;--warn:#e0a03a;--bad:#e5534b}
 body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
 main{max-width:760px;margin:0 auto;padding:16px}
 .bar{display:flex;gap:12px;align-items:center;color:var(--mute);font-size:13px}
 .bar b{color:var(--fg)} progress{flex:1;height:8px}
 .crop{background:#000;border-radius:8px;margin:12px 0;display:flex;justify-content:center;align-items:center;min-height:220px}
 .crop img{max-width:100%;height:220px;object-fit:contain}
 form{background:var(--panel);border-radius:8px;padding:14px;display:grid;gap:12px}
 .row{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
 label{display:grid;gap:4px;font-size:12px;color:var(--mute)}
 input{background:#0d1014;color:var(--fg);border:1px solid #333a44;border-radius:6px;padding:8px 10px;font-size:22px;font-variant-numeric:tabular-nums}
 input:focus{outline:2px solid var(--acc);border-color:transparent}
 #num{width:7.5em} #let{width:2.6em;text-align:center} #reg{width:3.2em}
 .letters{display:flex;gap:6px;flex-wrap:wrap}
 .letters button{font-size:20px;min-width:44px;padding:6px 8px;background:#0d1014;color:var(--fg);border:1px solid #333a44;border-radius:6px;cursor:pointer}
 .letters button small{display:block;font-size:10px;color:var(--mute)}
 .letters button.on{border-color:var(--acc);background:#1a2a48}
 .acts{display:flex;gap:8px;flex-wrap:wrap}
 .acts button{padding:8px 12px;border-radius:6px;border:1px solid #333a44;background:#0d1014;color:var(--fg);cursor:pointer}
 .acts .primary{background:var(--acc);border-color:var(--acc);color:#fff}
 #status{min-height:1.4em;font-size:13px} .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)}
 .meta{font-size:12px;color:var(--mute);word-break:break-all} .meta a{color:var(--acc)}
 kbd{background:#0d1014;border:1px solid #333a44;border-radius:4px;padding:0 4px;font-size:11px}
 .help{font-size:12px;color:var(--mute)}
</style></head><body><main>
 <div class="bar"><span>#<b id="idx">-</b></span><progress id="prog" max="1" value="0"></progress>
  <span><b id="lab">0</b> labelled · <b id="unr">0</b> unreadable · <b id="todo">0</b> to do</span></div>
 <div class="crop"><img id="img" alt="plate crop"></div>
 <form id="f" autocomplete="off">
  <div class="row">
   <label>Number<input id="num" inputmode="numeric" maxlength="5"></label>
   <label>Letter<input id="let" maxlength="2" dir="rtl"></label>
   <label>Region<input id="reg" inputmode="numeric" maxlength="2"></label>
   <span id="preview" class="meta"></span>
  </div>
  <div class="letters" id="letters"></div>
  <div class="acts">
   <button class="primary" type="submit">Save &amp; next <kbd>Enter</kbd></button>
   <button type="button" id="unread">Unreadable <kbd>Ctrl+U</kbd></button>
   <button type="button" id="prev">◀ Back <kbd>Ctrl+←</kbd></button>
   <button type="button" id="skip">Skip ▶ <kbd>Ctrl+→</kbd></button>
  </div>
  <div id="status"></div>
  <div class="meta">Draft: <span id="draft">none</span> · <a id="src" target="_blank">open source photo</a> · <span id="file"></span></div>
 </form>
 <p class="help">Type the number, then the letter (Arabic keyboard, or press <kbd>1</kbd>–<kbd>8</kbd> in the letter box, or click), then the region.
 The cursor moves on by itself. Labels follow the plate left-to-right as printed: number | letter | region.</p>
</main><script>
const LETTERS = __LETTERS__;
const $ = id => document.getElementById(id);
let cur = null, history = [];
const box = $("letters");
LETTERS.forEach((c, k) => {
  const b = document.createElement("button"); b.type = "button";
  b.innerHTML = c + "<small>" + (k + 1) + "</small>";
  b.onclick = () => { $("let").value = c; sync(); $("reg").focus(); };
  box.appendChild(b);
});
function label(){ return [$("num").value.trim(), $("let").value.trim(), $("reg").value.trim()].join("|"); }
function sync(){
  $("preview").textContent = label();
  [...box.children].forEach((b, k) => b.classList.toggle("on", LETTERS[k] === $("let").value.trim()));
}
function fill(text){
  const p = (text || "").split("|");
  $("num").value = p.length === 3 ? p[0] : ""; $("let").value = p.length === 3 ? p[1] : ""; $("reg").value = p.length === 3 ? p[2] : "";
  sync();
}
function show(it, msg, cls){
  cur = it;
  $("idx").textContent = it.index + 1; $("lab").textContent = it.labelled; $("unr").textContent = it.unreadable; $("todo").textContent = it.todo;
  $("prog").max = it.total; $("prog").value = it.total - it.todo;
  $("img").src = "/crop?i=" + it.index; $("src").href = "/source?i=" + it.index;
  $("file").textContent = it.filename; $("draft").textContent = it.draft || "none";
  fill(it.label && it.label !== "-" ? it.label : it.draft);
  $("status").textContent = msg || (it.label === "-" ? "marked unreadable" : it.label ? "already labelled: " + it.label : "");
  $("status").className = cls || "";
  $("num").focus(); $("num").select();
}
async function get(url){ const r = await fetch(url); return r.json(); }
async function next(after){ show(await get("/api/next?after=" + after)); }
async function save(text){
  const r = await fetch("/api/label", {method: "POST", headers: {"Content-Type": "application/json"},
                                         body: JSON.stringify({index: cur.index, label: text})});
  const j = await r.json();
  if (!r.ok) { $("status").textContent = j.error; $("status").className = "bad"; return; }
  history.push(cur.index);
  const it = await get("/api/next?after=" + cur.index);
  show(it, j.warning ? "saved with warning: " + j.warning : "saved #" + (cur.index + 1) + ": " + j.label, j.warning ? "warn" : "ok");
}
$("f").onsubmit = e => { e.preventDefault();
  if (!$("num").value.trim() || !$("let").value.trim() || !$("reg").value.trim()) {
    $("status").textContent = "fill all three fields, or mark it unreadable"; $("status").className = "bad"; return; }
  save(label()); };
$("unread").onclick = () => save("-");
$("skip").onclick = () => { history.push(cur.index); next(cur.index); };
$("prev").onclick = async () => { const i = history.pop(); if (i !== undefined) show(await get("/api/item?i=" + i)); };
$("num").oninput = e => { e.target.value = e.target.value.replace(/\D/g, ""); sync(); };
$("reg").oninput = e => { e.target.value = e.target.value.replace(/\D/g, ""); sync(); };
$("let").addEventListener("keydown", e => {
  const k = parseInt(e.key, 10);
  if (k >= 1 && k <= LETTERS.length) { e.preventDefault(); $("let").value = LETTERS[k - 1]; sync(); $("reg").focus(); }
});
$("let").oninput = () => { sync(); if ($("let").value.trim()) $("reg").focus(); };
document.addEventListener("keydown", e => {
  if (e.ctrlKey && e.key === "ArrowRight") { e.preventDefault(); $("skip").click(); }
  if (e.ctrlKey && e.key === "ArrowLeft") { e.preventDefault(); $("prev").click(); }
  if (e.ctrlKey && (e.key === "u" || e.key === "U")) { e.preventDefault(); $("unread").click(); }
  if (e.key === " " && document.activeElement === $("num") && $("num").value) { e.preventDefault(); $("let").focus(); }
  if (e.key === " " && document.activeElement === $("reg")) { e.preventDefault(); }
});
next(-1);
</script></body></html>
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crops", type=Path, default=REPO / "data" / "real_crops")
    ap.add_argument("--drafts", type=Path, nargs="*", default=[], help="CSVs whose label/prediction pre-fills the form")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args(argv)

    app = Labeller(args.crops, load_drafts(args.drafts))
    c = counts(app.rows)
    # single-threaded on purpose: requests run one at a time, so two saves never race on labels.csv
    server = HTTPServer(("127.0.0.1", args.port), make_handler(app))
    print(f"{c['total']} crops: {c['labelled']} labelled, {c['unreadable']} unreadable, {c['todo']} to do; "
          f"{len(app.drafts)} drafts")
    print(f"Open http://127.0.0.1:{args.port}  (Ctrl+C to stop; every save is already on disk)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
