/*
 * /settings: your account (from the server), password change, sign out everywhere, appearance,
 * and, for admins, the limits the API is running with (no key material, only key ids).
 */
import { useId, useState, type FormEvent } from "react";
import { KeyRound, LogOut, Moon, Palette, Server, Sun, UserRound } from "lucide-react";
import { ApiError } from "../../api/errors";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader, RevealGroup } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast";
import { ROLE_LABELS } from "../../lib/rbac";
import { useChangePassword, useRevokeSessions, useSystemSettings } from "./api";

const field = "focus-ring h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm";

export default function SettingsPage() {
  const { user, role, theme, toggleTheme, expire } = useSession();
  const isAdmin = role === "admin" || role === "super_admin";
  const system = useSystemSettings(isAdmin);
  const revoke = useRevokeSessions();
  const toast = useToast();

  return (
    <>
      <PageHeader eyebrow="System" title="Settings" />
      <RevealGroup className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><UserRound size={16} className="text-accent" aria-hidden /> Your account</span>} />
          <dl className="grid grid-cols-2 gap-4 p-6 pt-4 text-sm">
            <div><dt className="text-xs text-muted">Username</dt><dd className="font-mono">{user.username}</dd></div>
            <div><dt className="text-xs text-muted">Role</dt><dd><Badge tone="accent">{ROLE_LABELS[role]}</Badge></dd></div>
            <div className="col-span-2"><dt className="text-xs text-muted">Cities</dt><dd>{role === "analyst" ? `${user.allowedCityIds.length} assigned` : "All cities"}</dd></div>
            <div className="col-span-2"><dt className="text-xs text-muted">Sign-in</dt><dd>Password + authenticator code. Session in a secure httpOnly cookie.</dd></div>
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
            <p className="text-xs text-muted">Lost a device or left a session open somewhere?</p>
            <Button variant="danger" loading={revoke.isPending} onClick={async () => {
              try {
                await revoke.mutateAsync();
                toast({ tone: "success", title: "Signed out everywhere" });
                expire();
              } catch (e) {
                toast({ tone: "error", title: "Could not sign out everywhere", body: e instanceof ApiError ? e.message : undefined });
              }
            }}><LogOut size={14} aria-hidden /> Sign out everywhere</Button>
          </div>
        </Card>

        <ChangePassword onDone={expire} />

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Palette size={16} className="text-accent" aria-hidden /> Appearance</span>} />
          <div className="flex items-center justify-between gap-4 p-6 pt-4">
            <p className="text-sm text-muted">Theme, remembered in this browser.</p>
            <Button onClick={toggleTheme}>{theme === "dark" ? <><Sun size={14} aria-hidden /> Light theme</> : <><Moon size={14} aria-hidden /> Dark theme</>}</Button>
          </div>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Server size={16} className="text-accent" aria-hidden /> System limits</span>} subtitle="What the API is running with. Change them in .env and restart the API." />
            {!system.data ? <div className="p-6"><Skeleton className="h-40" /></div> : (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-6 pt-4 text-sm">
                {([
                  ["Environment", system.data.appEnv], ["Allowed origins", system.data.corsOrigins.join(", ")],
                  ["Session", `${system.data.accessTokenMinutes} min access, ${system.data.refreshTokenDays} d refresh`],
                  ["Lockout", `${system.data.maxFailedLogins} failures → ${system.data.lockoutMinutes} min`],
                  ["Sign-in rate", `${system.data.authRatePerMinute}/min per IP`], ["Registry rate", `${system.data.cameraRatePerMinute}/min per IP`],
                  ["Connection tests", `${system.data.probeRatePerMinute}/min per IP`], ["Detections", `${system.data.detectionRatePerMinute}/min per IP`],
                  ["CSV imports", `${(system.data.maxCsvBytes / 1e6).toFixed(1)} MB, ${system.data.maxCsvRows} rows`],
                  ["Data keys", `${system.data.dataKeyIds.join(", ")} (active ${system.data.activeDataKeyId})`],
                  ["Camera networks allowed", system.data.allowedCameraNetworks.join(", ") || "default policy"],
                  ["Proxy headers trusted", system.data.trustProxyHeaders ? "yes" : "no"],
                ] as const).map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="font-mono text-xs">{v}</dd></div>)}
              </dl>
            )}
          </Card>
        )}
      </RevealGroup>
    </>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const base = useId();
  const change = useChangePassword();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 12) return setError("Use at least 12 characters.");
    if (next !== repeat) return setError("The new passwords do not match.");
    setError(null);
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      toast({ tone: "success", title: "Password changed", body: "Every session ended. Sign in with the new password." });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 401 ? "The current password is wrong." : err.message) : "Could not change the password.");
    } finally {
      setCurrent("");
      setNext("");
      setRepeat("");
    }
  };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><KeyRound size={16} className="text-accent" aria-hidden /> Change password</span>} subtitle="Signs you out everywhere, this browser included." />
      <form onSubmit={submit} className="space-y-3 p-6 pt-4" noValidate>
        <div><label htmlFor={`${base}-c`} className="mb-1 block text-sm font-medium">Current password</label><input id={`${base}-c`} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className={field} /></div>
        <div><label htmlFor={`${base}-n`} className="mb-1 block text-sm font-medium">New password</label><input id={`${base}-n`} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={field} /></div>
        <div><label htmlFor={`${base}-r`} className="mb-1 block text-sm font-medium">Repeat new password</label><input id={`${base}-r`} type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" className={field} /></div>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" loading={change.isPending}>Change password</Button>
      </form>
    </Card>
  );
}
