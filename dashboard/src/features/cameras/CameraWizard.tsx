/*
 * Add / edit camera: a slide-over with five steps (Identity, Location, Network and stream,
 * Credentials, Review). Every step is validated before moving on (the server re-validates).
 * Credentials are write-only: never prefilled, never echoed on the Review step, cleared from
 * state right after they are sent, and sent to PUT /credentials, never inside the camera body.
 */
import { useId, useMemo, useState, type Dispatch, type InputHTMLAttributes, type ReactNode, type SetStateAction } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Info, KeyRound, Lock, MapPin, Plug, Save, ShieldCheck } from "lucide-react";
import { ApiError } from "../../api/errors";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Drawer } from "../../components/ui/Drawer";
import { useBeforeUnload } from "../../lib/useBeforeUnload";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import {
  assembledUrlPreview, DEFAULT_PORTS, emptyForm, firstInvalidStep, formFromCamera, KIND_LABELS, MASK, passwordStrength,
  PROTOCOL_LABELS, STEPS, toDraft, validateStep, type CameraForm, type FormErrors,
} from "./logic";
import { LocationPickerMap } from "./map";
import { KIND_ICONS } from "./style";
import { ConnectionTimeline, DirectionDial, SuccessCheck } from "./widgets";
import { CAMERA_KINDS, CAMERA_PROTOCOLS, type CameraPatch, type CameraRegistryApi, type ConnectionTestResult, type RegistryCamera, type RegistryCity } from "./types";

const input = "focus-ring h-10 w-full rounded-sm border bg-surface px-3 text-sm placeholder:text-faint transition-colors";
const NETWORK_FIELDS = ["protocol", "host", "port"] as const;

export function CameraWizard({ open, onClose, cities, camera, defaultCityId, preset, api, onSaved }: {
  open: boolean;
  onClose: () => void;
  cities: RegistryCity[];
  /** set when editing */
  camera?: RegistryCamera | null;
  defaultCityId?: string;
  /** prefilled fields for a new camera (e.g. this PC's webcam) */
  preset?: Partial<CameraForm>;
  api: Pick<CameraRegistryApi, "createCamera" | "updateCamera" | "replaceCredentials" | "testConnection" | "testDraftConnection">;
  onSaved: (camera: RegistryCamera) => void;
}) {
  const editing = !!camera;
  const initial = useMemo(() => (camera ? formFromCamera(camera) : { ...emptyForm(defaultCityId ?? cities[0]?.id ?? ""), ...preset }), [camera, defaultCityId, cities, preset]);
  const [form, setForm] = useState<CameraForm>(initial);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [errors, setErrors] = useState<FormErrors>({});
  const [replacingCreds, setReplacingCreds] = useState(!editing);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ running: boolean; result: ConnectionTestResult | null; error: string | null }>({ running: false, result: null, error: null });
  const toast = useToast();

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useBeforeUnload(open && dirty && !saved);

  const set = <K extends keyof CameraForm>(key: K, value: CameraForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    if ((NETWORK_FIELDS as readonly string[]).includes(key)) setTest({ running: false, result: null, error: null });
  };

  const requestClose = () => (dirty && !saved ? setConfirmDiscard(true) : onClose());

  const goTo = (target: number) => {
    if (target > step) {
      for (let s = step; s < target; s++) {
        const e = validateStep(s, form, editing);
        if (Object.keys(e).length) {
          setErrors(e);
          setDir(1);
          setStep(s);
          return;
        }
      }
    }
    setErrors({});
    setDir(target > step ? 1 : -1);
    setStep(target);
  };

  const credsTyped = !!(form.credUsername || form.credPassword);
  const willHaveCreds = credsTyped || (editing && camera!.credentialsSet && !replacingCreds);
  const preview = assembledUrlPreview({ protocol: form.protocol, host: form.host, port: form.port ? Number(form.port) : null, streamPath: form.streamPath, withCredentials: willHaveCreds });

  const runTest = async () => {
    setTest({ running: true, result: null, error: null });
    try {
      const networkUnchanged = editing && NETWORK_FIELDS.every((k) => form[k] === initial[k]);
      const result = networkUnchanged
        ? await api.testConnection(camera!.id)
        : await api.testDraftConnection({ protocol: form.protocol, host: form.host.trim(), port: form.port ? Number(form.port) : null });
      setTest({ running: false, result, error: null });
    } catch (e) {
      setTest({ running: false, result: null, error: e instanceof ApiError ? e.message : "The test could not run." });
    }
  };

  const save = async () => {
    const bad = firstInvalidStep(form, editing);
    if (bad !== null) {
      setErrors(validateStep(bad, form, editing));
      setDir(-1);
      setStep(bad);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const credentials = credsTyped ? { username: form.credUsername, password: form.credPassword } : null;
    // Drop the typed secret from React state now: whatever happens next, it is not kept.
    setForm((f) => ({ ...f, credUsername: "", credPassword: "" }));
    try {
      const draft = toDraft(form);
      let result: RegistryCamera;
      if (editing) {
        const patch: CameraPatch = {};
        const before = toDraft(initial) as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(draft)) if (k !== "cityId" && before[k] !== v) (patch as Record<string, unknown>)[k] = v;
        result = Object.keys(patch).length ? await api.updateCamera(camera!.id, patch) : camera!;
      } else {
        result = await api.createCamera(draft);
      }
      if (credentials) {
        await api.replaceCredentials(result.id, credentials);
        result = { ...result, credentialsSet: true };
      }
      setSaved(true);
      toast({ tone: "success", title: editing ? "Camera updated" : "Camera added", body: `${result.name}${credentials ? " · credentials stored encrypted" : ""}` });
      onSaved(result);
      window.setTimeout(onClose, 1100);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Saving failed.");
      if (credentials && !editing) setReplacingCreds(true);
    } finally {
      setSaving(false);
    }
  };

  const cityName = cities.find((c) => c.id === form.cityId)?.name ?? "—";

  return (
    <>
      <Drawer
        open={open}
        onRequestClose={requestClose}
        width="max-w-4xl"
        title={editing ? `Edit ${camera!.name}` : "Add a camera"}
        subtitle={<Stepper step={step} onPick={goTo} disabled={saved} />}
        footer={!saved && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => goTo(step - 1)} disabled={step === 0 || saving}>
              <ArrowLeft size={15} aria-hidden /> Back
            </Button>
            {saveError && <p role="alert" className="order-last w-full rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger sm:order-none sm:w-auto">{saveError}</p>}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => goTo(step + 1)}>Next: {STEPS[step + 1]} <ArrowRight size={15} aria-hidden /></Button>
            ) : (
              <Button variant="primary" onClick={save} loading={saving}><Save size={15} aria-hidden /> {editing ? "Save changes" : "Add camera"}</Button>
            )}
          </div>
        )}
      >
        {saved ? (
          <SuccessCheck label={editing ? "Changes saved" : "Camera added"} />
        ) : (
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.div
              key={step}
              custom={dir}
              initial={{ opacity: 0, x: dir * 28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -28 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === 0 && <IdentityStep form={form} set={set} errors={errors} cities={cities} editing={editing} />}
              {step === 1 && <LocationStep form={form} set={set} setForm={setForm} errors={errors} />}
              {step === 2 && <NetworkStep form={form} set={set} errors={errors} preview={preview} />}
              {step === 3 && (
                <CredentialsStep form={form} set={set} errors={errors} editing={editing} credentialsSet={!!camera?.credentialsSet}
                  replacing={replacingCreds} onReplace={() => setReplacingCreds(true)}
                  onCancelReplace={() => { setReplacingCreds(false); setForm((f) => ({ ...f, credUsername: "", credPassword: "" })); }} />
              )}
              {step === 4 && (
                <ReviewStep form={form} cityName={cityName} preview={preview} credentials={credsTyped ? "new" : editing && camera!.credentialsSet ? "kept" : "none"}
                  test={test} onTest={runTest} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </Drawer>
      <Dialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="Discard your changes?" description="What you typed in this camera form will be lost.">
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
          <Button variant="danger" onClick={() => { setConfirmDiscard(false); onClose(); }}>Discard</Button>
        </div>
      </Dialog>
    </>
  );
}

function Stepper({ step, onPick, disabled }: { step: number; onPick: (s: number) => void; disabled: boolean }) {
  return (
    <nav aria-label="Steps" className="mt-3">
      <ol className="flex flex-wrap items-center gap-1.5">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(i)}
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "focus-ring flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs font-medium transition-colors",
                i === step ? "border-accent bg-accent-soft text-accent" : i < step ? "border-ok/40 text-ok" : "border-border text-muted hover:text-text",
              )}
            >
              <span className={cn("grid size-5 place-items-center rounded-full text-[10px] font-semibold", i === step ? "btn-primary" : i < step ? "bg-ok-soft" : "bg-bg-subtle")}>
                {i < step ? <Check size={11} aria-hidden /> : i + 1}
              </span>
              <span className={i === step ? "" : "hidden md:inline"}>{label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-3 bg-border" aria-hidden />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

type Setter = <K extends keyof CameraForm>(key: K, value: CameraForm[K]) => void;

function Field({ label, error, hint, children, className, htmlFor }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string; htmlFor: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {error ? <p id={`${htmlFor}-err`} className="mt-1 text-xs font-medium text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function TextInput({ id, value, onChange, error, mono, className, ...rest }: { id: string; value: string; onChange: (v: string) => void; error?: string; mono?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "id">) {
  return (
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-err` : undefined}
      className={cn(input, error ? "border-danger" : "border-border", mono && "font-mono", className)}
      {...rest}
    />
  );
}

function IdentityStep({ form, set, errors, cities, editing }: { form: CameraForm; set: Setter; errors: FormErrors; cities: RegistryCity[]; editing: boolean }) {
  const base = useId();
  return (
    <section aria-label="Identity" className="space-y-5">
      <StepIntro icon={Info} title="Identity">What this camera is and who runs it.</StepIntro>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" htmlFor={`${base}-city`} error={errors.cityId} hint={editing ? "A camera cannot move to another city; add a new one instead." : undefined}>
          <select id={`${base}-city`} value={form.cityId} disabled={editing} onChange={(e) => set("cityId", e.target.value)} className={cn(input, errors.cityId ? "border-danger" : "border-border")} data-autofocus>
            <option value="">Choose…</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Camera name" htmlFor={`${base}-name`} error={errors.name}>
          <TextInput id={`${base}-name`} value={form.name} onChange={(v) => set("name", v)} error={errors.name} maxLength={80} placeholder="e.g. Agdal gate 1" />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Type</legend>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {CAMERA_KINDS.map((k) => {
            const Icon = KIND_ICONS[k];
            const active = form.kind === k;
            return (
              <label key={k} className={cn("focus-within:shadow-[0_0_0_3px_var(--ring)] flex cursor-pointer flex-col items-center gap-2 rounded-md border p-4 text-center text-sm transition-all", active ? "border-accent bg-accent-soft text-accent shadow-glow" : "border-border hover:border-border-strong")}>
                <input type="radio" name={`${base}-kind`} value={k} checked={active} onChange={() => set("kind", k)} className="sr-only" />
                <Icon size={22} aria-hidden />
                <span className="font-medium">{KIND_LABELS[k]}</span>
              </label>
            );
          })}
        </div>
        {errors.kind && <p className="mt-1 text-xs font-medium text-danger">{errors.kind}</p>}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Owner" htmlFor={`${base}-owner`} error={errors.owner}>
          <TextInput id={`${base}-owner`} value={form.owner} onChange={(v) => set("owner", v)} maxLength={80} placeholder="Operator or agency" />
        </Field>
        <Field label="Installed on" htmlFor={`${base}-inst`}>
          <TextInput id={`${base}-inst`} type="date" value={form.installedOn} onChange={(v) => set("installedOn", v)} />
        </Field>
        <Field label="Firmware version" htmlFor={`${base}-fw`}>
          <TextInput id={`${base}-fw`} value={form.firmwareVersion} onChange={(v) => set("firmwareVersion", v)} maxLength={40} mono />
        </Field>
      </div>
      <Field label="Notes" htmlFor={`${base}-notes`} hint="Internal only. No credentials here.">
        <textarea id={`${base}-notes`} value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} rows={3} className={cn(input, "h-auto border-border py-2")} />
      </Field>
    </section>
  );
}

function LocationStep({ form, set, setForm, errors }: { form: CameraForm; set: Setter; setForm: Dispatch<SetStateAction<CameraForm>>; errors: FormErrors }) {
  const base = useId();
  const lat = Number(form.latitude);
  const lon = Number(form.longitude);
  const valid = form.latitude !== "" && form.longitude !== "" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const pick = (la: number, lo: number) => setForm((f) => ({ ...f, latitude: la.toFixed(6), longitude: lo.toFixed(6) }));
  return (
    <section aria-label="Location" className="space-y-5">
      <StepIntro icon={MapPin} title="Location">Click the map or drag the pin. Exact positions are sensitive: only admins and analysts of this city can see them.</StepIntro>
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="h-80 overflow-hidden rounded-md border border-border lg:h-auto">
          <LocationPickerMap position={valid ? [lat, lon] : null} bearing={form.viewDirectionDeg === "" ? null : Number(form.viewDirectionDeg)} kind={form.kind || "anpr_camera"} onPick={pick} />
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude" htmlFor={`${base}-lat`} error={errors.latitude}>
              <TextInput id={`${base}-lat`} value={form.latitude} onChange={(v) => set("latitude", v)} error={errors.latitude} inputMode="decimal" mono placeholder="34.020882" data-autofocus />
            </Field>
            <Field label="Longitude" htmlFor={`${base}-lon`} error={errors.longitude}>
              <TextInput id={`${base}-lon`} value={form.longitude} onChange={(v) => set("longitude", v)} error={errors.longitude} inputMode="decimal" mono placeholder="-6.841650" />
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Direction of view</p>
            <DirectionDial value={form.viewDirectionDeg === "" ? null : Number(form.viewDirectionDeg)} onChange={(d) => set("viewDirectionDeg", d === null ? "" : String(d))} />
            {errors.viewDirectionDeg && <p className="mt-1 text-xs font-medium text-danger">{errors.viewDirectionDeg}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="District" htmlFor={`${base}-dist`}>
              <TextInput id={`${base}-dist`} value={form.district} onChange={(v) => set("district", v)} maxLength={80} />
            </Field>
            <Field label="Lane" htmlFor={`${base}-lane`} error={errors.lane}>
              <TextInput id={`${base}-lane`} value={form.lane} onChange={(v) => set("lane", v)} maxLength={20} placeholder="e.g. 2 or northbound" />
            </Field>
          </div>
          <Field label="Street address" htmlFor={`${base}-addr`} error={errors.streetAddress}>
            <TextInput id={`${base}-addr`} value={form.streetAddress} onChange={(v) => set("streetAddress", v)} maxLength={200} />
          </Field>
        </div>
      </div>
    </section>
  );
}

function NetworkStep({ form, set, errors, preview }: { form: CameraForm; set: Setter; errors: FormErrors; preview: string | null }) {
  const base = useId();
  const noNetwork = form.protocol === "webhook" || form.protocol === "file";
  return (
    <section aria-label="Network and stream" className="space-y-5">
      <StepIntro icon={Plug} title="Network and stream">Host, port and path are stored separately. The camera worker assembles the URL at runtime; it is never stored with credentials in it.</StepIntro>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Protocol</legend>
        <div className="flex flex-wrap gap-2">
          {CAMERA_PROTOCOLS.map((p) => (
            <label key={p} className={cn("focus-within:shadow-[0_0_0_3px_var(--ring)] flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 font-mono text-xs font-semibold transition-colors", form.protocol === p ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}>
              <input type="radio" name={`${base}-proto`} value={p} checked={form.protocol === p} onChange={() => set("protocol", p)} className="sr-only" />
              {PROTOCOL_LABELS[p]}{p === "rtsps" && <ShieldCheck size={13} className="text-ok" aria-label="recommended" />}
            </label>
          ))}
        </div>
        <p className={cn("mt-2 flex items-start gap-1.5 text-xs", form.protocol === "rtsp" ? "text-warn" : "text-muted")}>
          <Info size={13} className="mt-px shrink-0" aria-hidden />
          {form.protocol === "rtsp" ? "RTSP sends video and the login in clear text on the network. Use RTSPS (RTSP over TLS) whenever the camera supports it."
            : form.protocol === "rtsps" ? "Recommended: RTSP over TLS, so the stream and the login are encrypted in transit."
            : noNetwork ? "This source does not need a host: the server does not connect to it." : "Make sure this traffic stays on the camera VLAN."}
        </p>
      </fieldset>
      {!noNetwork && (
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Host" htmlFor={`${base}-host`} error={errors.host} hint="Hostname or IP only, e.g. 10.20.0.11 or cam-01.rabat.local">
            <TextInput id={`${base}-host`} value={form.host} onChange={(v) => set("host", v)} error={errors.host} mono autoComplete="off" spellCheck={false} data-autofocus />
          </Field>
          <Field label="Port" htmlFor={`${base}-port`} error={errors.port} hint={DEFAULT_PORTS[form.protocol] ? `Default ${DEFAULT_PORTS[form.protocol]}` : undefined}>
            <TextInput id={`${base}-port`} value={form.port} onChange={(v) => set("port", v.replace(/\D/g, "").slice(0, 5))} error={errors.port} inputMode="numeric" mono />
          </Field>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Stream path" htmlFor={`${base}-path`} error={errors.streamPath} hint="Starts with /. Never put a user or password in it.">
          <TextInput id={`${base}-path`} value={form.streamPath} onChange={(v) => set("streamPath", v)} error={errors.streamPath} mono spellCheck={false} placeholder="/stream1" />
        </Field>
        <Field label="VLAN" htmlFor={`${base}-vlan`} error={errors.vlan}>
          <TextInput id={`${base}-vlan`} value={form.vlan} onChange={(v) => set("vlan", v.replace(/\D/g, "").slice(0, 4))} error={errors.vlan} inputMode="numeric" mono />
        </Field>
      </div>
      <UrlPreview preview={preview} />
    </section>
  );
}

export function UrlPreview({ preview }: { preview: string | null }) {
  return (
    <div className="rounded-md border border-border bg-bg-subtle/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Assembled URL preview</p>
      <p className="mt-2 break-all font-mono text-sm" data-testid="url-preview">{preview ?? <span className="text-faint">Fill in the host to see it.</span>}</p>
      <p className="mt-1.5 text-xs text-muted">Credentials always appear as {MASK}. This exact string is never saved.</p>
    </div>
  );
}

function CredentialsStep({ form, set, errors, editing, credentialsSet, replacing, onReplace, onCancelReplace }: {
  form: CameraForm; set: Setter; errors: FormErrors; editing: boolean; credentialsSet: boolean;
  replacing: boolean; onReplace: () => void; onCancelReplace: () => void;
}) {
  const base = useId();
  const [show, setShow] = useState(false);
  const strength = passwordStrength(form.credPassword);
  const showFields = !editing || replacing;
  return (
    <section aria-label="Credentials" className="space-y-5">
      <StepIntro icon={KeyRound} title="Credentials">Write-only. Encrypted with AES-256-GCM as soon as they reach the server, and never shown again, not even to admins.</StepIntro>
      {editing && !replacing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-raised p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Lock size={16} className={credentialsSet ? "text-ok" : "text-gold-strong"} aria-hidden />
            {credentialsSet ? "Credentials set" : "No credentials stored"}
          </p>
          <Button onClick={onReplace}><KeyRound size={14} aria-hidden /> {credentialsSet ? "Replace credentials" : "Add credentials"}</Button>
        </div>
      )}
      {showFields && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Camera username" htmlFor={`${base}-u`} error={errors.credUsername}>
              <TextInput id={`${base}-u`} value={form.credUsername} onChange={(v) => set("credUsername", v)} error={errors.credUsername} autoComplete="off" spellCheck={false} maxLength={128} data-autofocus />
            </Field>
            <Field label="Camera password" htmlFor={`${base}-p`} error={errors.credPassword} hint={strength.label || undefined}>
              <span className="relative block">
                <TextInput id={`${base}-p`} type={show ? "text" : "password"} value={form.credPassword} onChange={(v) => set("credPassword", v)} error={errors.credPassword} autoComplete="new-password" maxLength={256} className="pr-10" />
                <button type="button" onClick={() => setShow((s) => !s)} className="focus-ring absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-xs text-faint hover:text-text" aria-label={show ? "Hide password" : "Show password"}>
                  {show ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                </button>
              </span>
              {strength.score > 0 && (
                <span className="mt-1.5 flex gap-1" aria-hidden>
                  {[1, 2, 3].map((n) => <span key={n} className="h-1 flex-1 rounded-full" style={{ background: n <= strength.score ? ["", "var(--danger)", "var(--warn)", "var(--ok)"][strength.score] : "var(--border)" }} />)}
                </span>
              )}
            </Field>
          </div>
          <p className="flex items-start gap-2 rounded-sm bg-accent-soft/60 px-3 py-2.5 text-xs text-muted">
            <ShieldCheck size={14} className="mt-px shrink-0 text-accent" aria-hidden />
            Stored encrypted, never shown again. Leave both empty to add them later. Use a dedicated, least-privilege camera account (view-only), not the camera admin.
          </p>
          {editing && <Button variant="ghost" size="sm" onClick={onCancelReplace}>Keep the current credentials</Button>}
        </div>
      )}
    </section>
  );
}

function ReviewStep({ form, cityName, preview, credentials, test, onTest }: {
  form: CameraForm; cityName: string; preview: string | null; credentials: "new" | "kept" | "none";
  test: { running: boolean; result: ConnectionTestResult | null; error: string | null }; onTest: () => void;
}) {
  const rows: [string, ReactNode][] = [
    ["City", cityName], ["Name", form.name], ["Type", form.kind ? KIND_LABELS[form.kind] : "—"],
    ["Position", form.latitude && form.longitude ? <span className="font-mono">{form.latitude}, {form.longitude}</span> : "—"],
    ["View", form.viewDirectionDeg ? `${form.viewDirectionDeg}°` : "—"], ["Lane", form.lane || "—"],
    ["Protocol", PROTOCOL_LABELS[form.protocol]], ["VLAN", form.vlan || "—"],
    ["Credentials", credentials === "new" ? `${MASK} (will be encrypted)` : credentials === "kept" ? "Set (unchanged)" : "None"],
  ];
  const canTest = !["webhook", "file"].includes(form.protocol) && !!form.host.trim();
  return (
    <section aria-label="Review" className="space-y-5">
      <StepIntro icon={Check} title="Review">Check the details, test the network path, then save.</StepIntro>
      <div className="card-surface relative rounded-md p-5">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          {rows.map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-xs text-muted">{k}</dt><dd className="truncate text-sm font-medium">{v}</dd></div>
          ))}
        </dl>
        <div className="mt-4"><UrlPreview preview={preview} /></div>
      </div>
      <div className="rounded-md border border-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">Test connection</p>
            <p className="text-xs text-muted">DNS, TCP{form.protocol === "rtsps" ? " and TLS" : ""} from the server. Optional: a camera can be registered before it is reachable.</p>
          </div>
          <Button onClick={onTest} loading={test.running} disabled={!canTest}><Plug size={14} aria-hidden /> {test.result ? "Test again" : "Test connection"}</Button>
        </div>
        <ConnectionTimeline running={test.running} result={test.result} error={test.error} tls={form.protocol === "rtsps"} />
      </div>
    </section>
  );
}

function StepIntro({ icon: Icon, title, children }: { icon: typeof Info; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-accent-soft text-accent"><Icon size={18} aria-hidden /></span>
      <div>
        <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
        <p className="text-sm text-muted">{children}</p>
      </div>
    </div>
  );
}
