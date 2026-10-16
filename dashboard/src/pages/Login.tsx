import { useId, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Copy, Eye, EyeOff, FileLock2, KeyRound, Lock, Moon, ScanLine, ShieldCheck, Smartphone, Sun, UserCheck } from "lucide-react";
import { accounts } from "../api/client";
import { ApiError } from "../api/errors";
import type { MfaSetup, User } from "../api/types";
import { Button } from "../components/ui/Button";
import { EASE_OUT } from "../components/ui/motion";

const input = "h-12 w-full rounded-sm border border-border bg-bg-subtle/60 px-4 text-[15px] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-faint focus:border-accent focus:shadow-glow";

export default function Login({ onLogin, expired, theme, onToggleTheme }: {
  onLogin: (user: User) => void;
  expired: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [step, setStep] = useState<"password" | "setup" | "code">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = useId();
  const passId = useId();
  const codeId = useId();

  const fail = (err: unknown, fallback: string) => {
    setError(err instanceof ApiError ? err.message : fallback);
    setBusy(false);
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return setError("Enter your username and password.");
    setBusy(true);
    setError(null);
    try {
      const { mfaEnrolled } = await accounts.login(username.trim(), password);
      setPassword(""); // do not keep the password around after use
      if (mfaEnrolled) {
        setStep("code");
      } else {
        setSetup(await accounts.mfaSetup());
        setStep("setup");
      }
      setBusy(false);
    } catch (err) {
      fail(err, "Sign-in failed.");
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError("Enter the 6-digit code from your authenticator app.");
    setBusy(true);
    setError(null);
    try {
      const user = await accounts.mfaVerify(code);
      setSetup(null); // the secret is shown once and then forgotten
      onLogin(user);
    } catch (err) {
      setCode("");
      fail(err, "That code did not work.");
    }
  };

  const restart = () => {
    setStep("password");
    setSetup(null);
    setCode("");
    setError(null);
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-border/70 lg:block">
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3">
            <span className="btn-primary relative grid size-11 place-items-center overflow-hidden rounded-[13px]">
              <ScanLine size={21} strokeWidth={2.2} aria-hidden />
              <span className="scan-beam" aria-hidden />
            </span>
            <span className="font-display text-2xl font-bold tracking-[-0.03em]">
              ANPR <span className="text-gradient font-serif text-[1.15em] font-normal italic tracking-normal">Secure</span>
            </span>
          </div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: EASE_OUT }}>
            <Viewfinder />
            <h1 className="mt-12 max-w-xl text-[3rem] font-semibold leading-[1.02] tracking-[-0.04em]">
              Plate recognition, with a human on{" "}
              <span className="text-gradient font-serif font-normal italic tracking-[-0.01em]">every decision.</span>
            </h1>
            <ul className="mt-9 grid max-w-xl gap-3 text-[14px] text-muted">
              {[
                { icon: UserCheck, text: "Every watchlist match is confirmed by a person, with a written justification." },
                { icon: FileLock2, text: "Evidence is hash-chained and Ed25519-signed; the audit log is append-only." },
                { icon: ShieldCheck, text: "Plates are masked by default; each role sees only what it needs." },
              ].map(({ icon: Icon, text }, i) => (
                <motion.li
                  key={text}
                  className="card-surface relative flex items-center gap-3 rounded-md px-4 py-3"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.35 + i * 0.1, duration: 0.6, ease: EASE_OUT }}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent"><Icon size={16} aria-hidden /></span>
                  {text}
                </motion.li>
              ))}
            </ul>
          </motion.div>
          <p className="text-xs text-faint">Accounts are stored in the local database, with Argon2id password hashes.</p>
        </div>
      </aside>

      <main className="flex items-center justify-center px-6 py-12">
        <motion.div
          className="card-surface relative w-full max-w-md rounded-lg p-8 shadow-3 sm:p-10"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: EASE_OUT }}
        >
          <div className="mb-8 flex items-start justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-accent">ANPR Secure</p>
              <h2 className="mt-1 text-[2.1rem] font-semibold tracking-[-0.035em]">Welcome <span className="text-gradient font-serif font-normal italic">back</span></h2>
            </div>
            <button type="button" onClick={onToggleTheme} className="focus-ring grid size-10 place-items-center rounded-sm text-muted hover:bg-bg-subtle hover:text-text" aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}>
              {theme === "light" ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
            </button>
          </div>

          {expired && (
            <p role="alert" className="mb-5 rounded-sm border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">Your session ended. Sign in again to continue.</p>
          )}

          {step === "password" ? (
            <form onSubmit={submitPassword} noValidate className="space-y-4">
              <div>
                <label htmlFor={userId} className="mb-1.5 block text-sm font-medium">Username</label>
                <input id={userId} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus className={input} />
              </div>
              <div>
                <label htmlFor={passId} className="mb-1.5 block text-sm font-medium">Password</label>
                <span className="relative block">
                  <input id={passId} type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={`${input} pr-11`} />
                  <button type="button" onClick={() => setShow((s) => !s)} className="focus-ring absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-xs text-faint hover:text-text" aria-label={show ? "Hide password" : "Show password"}>
                    {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                </span>
              </div>
              {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>}
              <Button type="submit" variant="primary" className="mt-2 h-12 w-full text-[15px]" loading={busy}>
                Continue <ArrowRight size={16} aria-hidden />
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} noValidate className="space-y-4">
              {step === "setup" && setup && <MfaEnrolment setup={setup} />}
              {step === "code" && (
                <p className="flex items-start gap-3 rounded-sm border border-border bg-bg-subtle/60 px-4 py-3 text-sm text-muted">
                  <Smartphone size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  Open your authenticator app and enter the current code for ANPR Secure.
                </p>
              )}
              <div>
                <label htmlFor={codeId} className="mb-1.5 block text-sm font-medium">6-digit code</label>
                <input
                  id={codeId}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  className={`${input} text-center font-mono text-2xl tracking-[0.5em]`}
                />
              </div>
              {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>}
              <Button type="submit" variant="primary" className="mt-2 h-12 w-full text-[15px]" loading={busy}>
                Verify and sign in <KeyRound size={16} aria-hidden />
              </Button>
              <button type="button" onClick={restart} className="focus-ring mx-auto flex items-center gap-1.5 rounded-xs text-sm text-muted hover:text-text">
                <ArrowLeft size={14} aria-hidden /> Use another account
              </button>
            </form>
          )}

          <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
            After 5 failed attempts an account is locked for 15 minutes. Every sign-in needs a code from your authenticator app. The session lives in a secure, httpOnly cookie that page scripts cannot read.
          </p>
        </motion.div>
      </main>
    </div>
  );
}

/**
 * Decorative camera viewfinder: a sample plate, corner brackets and a sweeping laser.
 * The plate and the confidence figure are illustrative, not data.
 */
function Viewfinder() {
  return (
    <div className="card-surface relative h-56 max-w-xl overflow-hidden rounded-lg" aria-hidden>
      <div className="absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_100%,var(--aurora-1),transparent_70%)]" />
      {["left-4 top-4 border-l-2 border-t-2", "right-4 top-4 border-r-2 border-t-2", "bottom-4 left-4 border-b-2 border-l-2", "bottom-4 right-4 border-b-2 border-r-2"].map((c) => (
        <span key={c} className={`absolute size-6 rounded-[3px] border-accent-2 ${c}`} />
      ))}
      <div className="absolute left-4 top-4 ml-9 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
        <span className="size-1.5 rounded-full bg-danger motion-safe:animate-pulse" /> REC · CAM-01
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <motion.div
          className="relative"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.4, duration: 0.8, ease: EASE_OUT }}
        >
          <div className="flex h-16 items-center gap-4 rounded-[10px] border-2 border-plate-ink/80 bg-[var(--plate-bg)] px-6 font-mono text-[28px] font-semibold text-plate-ink shadow-3" dir="ltr">
            <span className="tracking-wider">12345</span>
            <span className="h-9 w-px bg-plate-ink/40" />
            <span className="font-sans" lang="ar">أ</span>
            <span className="h-9 w-px bg-plate-ink/40" />
            <span>6</span>
          </div>
          <motion.div
            className="absolute -inset-3 rounded-[14px] border-2 border-accent-2 shadow-[0_0_24px_-2px_var(--accent-2)]"
            initial={{ opacity: 0, scale: 1.2 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 1.1, duration: 0.5, ease: EASE_OUT }}
          />
          <motion.span
            className="absolute -top-11 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent-2 px-3 py-1 font-mono text-[11px] font-semibold text-plate-ink"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.5, duration: 0.5, ease: EASE_OUT }}
          >
            PLATE · 98.4%
          </motion.span>
        </motion.div>
      </div>
      <span className="scan-beam" />
    </div>
  );
}

/** First sign-in: the TOTP secret to type into an authenticator app (shown once, never stored here). */
function MfaEnrolment({ setup }: { setup: MfaSetup }) {
  const [copied, setCopied] = useState(false);
  const grouped = setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret;
  const copy = () => {
    void navigator.clipboard?.writeText(setup.secret).then(() => setCopied(true));
  };
  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft/50 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-accent" aria-hidden /> Set up two-factor sign-in</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>In your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), choose <em>Enter a setup key</em>.</li>
        <li>Account: <span className="font-mono text-text">ANPR Secure</span>, key type: time based.</li>
        <li>Type the key below, then enter the 6-digit code the app shows.</li>
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm border border-border bg-surface-raised px-3 py-2 font-mono text-[13px] tracking-wider" aria-label="Setup key">{grouped}</code>
        <button type="button" onClick={copy} className="focus-ring grid size-9 shrink-0 place-items-center rounded-sm border border-border bg-surface text-muted hover:text-text" aria-label="Copy setup key">
          <Copy size={15} aria-hidden />
        </button>
      </div>
      <p className="mt-2 text-xs text-muted" aria-live="polite">{copied ? "Copied. " : ""}This key is shown only now. Lost it? An Admin can reset your MFA.</p>
    </div>
  );
}
