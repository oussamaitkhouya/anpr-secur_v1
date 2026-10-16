import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Download, FileSpreadsheet, KeyRound, ShieldCheck, Upload, XCircle } from "lucide-react";
import { ApiError } from "../../api/errors";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { KIND_LABELS, passwordStrength, PROTOCOL_LABELS } from "./logic";
import type { CameraImportResult, CameraRegistryApi, RegistryCity } from "./types";

const MAX_BYTES = 2_000_000; // matches MAX_CSV_BYTES; the server enforces it anyway

export function ImportDialog({ open, onClose, api, cities, onImported }: {
  open: boolean;
  onClose: () => void;
  api: Pick<CameraRegistryApi, "importCsv" | "importTemplate">;
  cities: RegistryCity[];
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CameraImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const cityName = (id: string) => cities.find((c) => c.id === id)?.name ?? "—";

  const reset = () => { setFile(null); setPreview(null); setError(null); setBusy(false); };
  const close = () => { reset(); onClose(); };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setPreview(null);
    if (!f.name.toLowerCase().endsWith(".csv")) return setError("Choose a .csv file.");
    if (f.size > MAX_BYTES) return setError("File too large (2 MB at most).");
    setFile(f);
    setBusy(true);
    try {
      setPreview(await api.importCsv(f, "preview"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The file could not be checked.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await api.importCsv(file, "confirm");
      toast({ tone: "success", title: `${result.rowsAccepted} camera${result.rowsAccepted === 1 ? "" : "s"} imported`, body: `SHA-256 ${result.sha256.slice(0, 12)}… recorded in the audit log.` });
      onImported();
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Import failed.");
      setBusy(false);
    }
  };

  const download = async () => {
    try {
      const csv = await api.importTemplate();
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "cameras_template.csv" });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not download the template.");
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void choose(e.dataTransfer.files[0]);
  };

  return (
    <Dialog open={open} onClose={close} width="max-w-3xl" title="Import cameras from CSV" description="Check first, then confirm. Each row is validated like the form; bad rows are listed with the reason and never block good ones.">
      <div className="space-y-4">
        {!preview && (
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors", over ? "border-accent bg-accent-soft/60" : "border-border-strong")}
          >
            <motion.span animate={over ? { y: -4, scale: 1.05 } : { y: 0, scale: 1 }} className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent"><Upload size={24} aria-hidden /></motion.span>
            <p className="font-medium">Drop a CSV file here</p>
            <p className="text-sm text-muted">or</p>
            <Button onClick={() => inputRef.current?.click()} loading={busy}><FileSpreadsheet size={14} aria-hidden /> Choose a file</Button>
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => void choose(e.target.files?.[0])} />
            <p className="flex items-center gap-1.5 text-xs text-muted"><KeyRound size={12} aria-hidden />No credential columns: set credentials per camera afterwards.</p>
          </div>
        )}

        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        {preview && (
          <div className="space-y-3" data-testid="import-preview">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{preview.fileName}</span>
              <span className="flex items-center gap-1 text-ok"><CheckCircle2 size={14} aria-hidden />{preview.rowsAccepted} accepted</span>
              <span className={cn("flex items-center gap-1", preview.rowsRejected ? "text-danger" : "text-muted")}><XCircle size={14} aria-hidden />{preview.rowsRejected} rejected</span>
              <span className="ml-auto font-mono text-[11px] text-faint" title="SHA-256 of the file, recorded with the import">{preview.sha256.slice(0, 16)}…</span>
            </div>
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-raised text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                  <tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Camera</th><th className="px-3 py-2">Result</th></tr>
                </thead>
                <tbody>
                  {preview.rejected.map((r) => (
                    <tr key={`r${r.line}`} className="border-t border-border bg-danger-soft/40">
                      <td className="px-3 py-2 font-mono text-xs">{r.line}</td>
                      <td className="px-3 py-2">{r.name || <span className="text-faint">—</span>}</td>
                      <td className="px-3 py-2 text-xs text-danger"><ul className="list-disc pl-4">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul></td>
                    </tr>
                  ))}
                  {preview.accepted.map((r) => (
                    <tr key={`a${r.line}`} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">{r.line}</td>
                      <td className="px-3 py-2">{r.name} <span className="text-xs text-muted">· {cityName(r.cityId)}</span></td>
                      <td className="px-3 py-2 text-xs text-ok">Will be added · {KIND_LABELS[r.kind]} · {PROTOCOL_LABELS[r.protocol]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button variant="ghost" onClick={download}><Download size={14} aria-hidden /> Download template</Button>
          <div className="flex gap-2">
            {preview && <Button onClick={reset}>Choose another file</Button>}
            {preview && <Button variant="primary" onClick={confirm} loading={busy} disabled={!preview.rowsAccepted}>Import {preview.rowsAccepted} camera{preview.rowsAccepted === 1 ? "" : "s"}</Button>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** "Replace credentials" from a row: write-only fields, cleared as soon as they are sent. */
export function CredentialsDialog({ cameraName, open, onClose, onSubmit }: {
  cameraName: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (c: { username: string; password: string }) => Promise<void>;
}) {
  const base = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setUsername(""); setPassword(""); setError(null); onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return setError("Enter both the username and the password.");
    const creds = { username, password };
    setUsername("");
    setPassword(""); // not kept in state while the request runs
    setBusy(true);
    try {
      await onSubmit(creds);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Saving failed. Type the credentials again.");
    } finally {
      setBusy(false);
    }
  };
  const strength = passwordStrength(password);
  const field = "focus-ring h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm";
  return (
    <Dialog open={open} onClose={close} title={`Replace credentials · ${cameraName}`} description="The current credentials are overwritten. Nothing is shown back, now or later.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div><label htmlFor={`${base}-u`} className="mb-1.5 block text-sm font-medium">Camera username</label><input id={`${base}-u`} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" maxLength={128} className={field} /></div>
        <div>
          <label htmlFor={`${base}-p`} className="mb-1.5 block text-sm font-medium">Camera password</label>
          <input id={`${base}-p`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={256} className={field} />
          {strength.label && <p className="mt-1 text-xs text-muted">{strength.label}</p>}
        </div>
        <p className="flex items-start gap-2 text-xs text-muted"><ShieldCheck size={14} className="mt-px shrink-0 text-accent" aria-hidden />Stored encrypted (AES-256-GCM), never shown again. The audit log records that they changed, not what they are.</p>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Replace credentials</Button></div>
      </form>
    </Dialog>
  );
}
