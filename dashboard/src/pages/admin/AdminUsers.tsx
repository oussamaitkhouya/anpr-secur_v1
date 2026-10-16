import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { KeyRound, Lock, Pencil, Plus, Power, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { accounts } from "../../api/client";
import { registry } from "../../features/cameras/api";
import { ApiError } from "../../api/errors";
import { useApi, useRequestContext } from "../../api/useApi";
import type { City, User } from "../../api/types";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, RevealGroup } from "../../components/ui/Card";
import { CheckboxList } from "../../components/ui/CheckboxList";
import { DataTable } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader } from "../../components/ui/PageHeader";
import { PasswordField } from "../../components/ui/PasswordField";
import { LoadingBlock } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { useToast } from "../../components/ui/toast";
import { formatDate } from "../../lib/format";
import { passwordOk } from "../../lib/passwordPolicy";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "../../lib/rbac";

type Mode =
  | { kind: "create" }
  | { kind: "edit"; user: User }
  | { kind: "reset"; user: User }
  | { kind: "delete"; user: User }
  | { kind: "own-password" };

const ROLE_TONE: Record<Role, "gold" | "accent" | "ok" | "neutral"> = { super_admin: "gold", admin: "accent", analyst: "ok", auditor: "neutral" };
const input = "focus-ring h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm shadow-1";

/** Roles the signed-in user may hand out. The server enforces the same rule. */
function assignableRoles(actor: Role): Role[] {
  return actor === "super_admin" ? ["super_admin", "admin", "analyst", "auditor"] : actor === "admin" ? ["analyst", "auditor"] : [];
}

export default function AdminUsers() {
  const { user: me, role } = useSession();
  const toast = useToast();
  const users = useApi((ctx) => accounts.listUsers(ctx));
  const cities = useApi(() => registry.listCities().then((cs) => cs.map((c) => ({ id: c.id, name: c.name, demo: false }))));
  const [mode, setMode] = useState<Mode | null>(null);
  const cityName = useMemo(() => new Map((cities.data ?? []).map((c) => [c.id, c.name])), [cities.data]);

  const done = (message: string) => {
    setMode(null);
    toast({ tone: "success", title: message, body: "Recorded in the audit log." });
    users.reload();
  };

  const columns = useMemo(() => {
    const col = createColumnHelper<User>();
    return [
      col.accessor("name", {
        header: "Account",
        cell: ({ row: { original: u } }) => (
          <span className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft font-display text-sm font-semibold text-accent" aria-hidden>
              {u.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("")}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{u.name}{u.id === me.id && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}</span>
              <span className="block font-mono text-[12px] text-muted">{u.username}</span>
            </span>
          </span>
        ),
      }),
      col.accessor("role", { header: "Role", cell: (c) => <Badge tone={ROLE_TONE[c.getValue()]}>{ROLE_LABELS[c.getValue()]}</Badge> }),
      col.display({
        id: "cities",
        header: "Cities",
        cell: ({ row: { original: u } }) =>
          u.role === "analyst" ? (
            u.allowedCityIds.length ? (
              <span className="flex flex-wrap gap-1">{u.allowedCityIds.map((id) => <Badge key={id}>{cityName.get(id) ?? id}</Badge>)}</span>
            ) : <span className="text-xs text-warn">None: sees no cameras</span>
          ) : (
            <span className="text-xs text-muted">{u.role === "auditor" ? "No camera access" : "All cities"}</span>
          ),
      }),
      col.accessor("active", {
        header: "Status",
        cell: (c) => (c.getValue() === false ? <Badge tone="danger" dot>Deactivated</Badge> : <Badge tone="ok" dot>Active</Badge>),
      }),
      col.accessor("createdAt", {
        header: "Created",
        cell: ({ row: { original: u } }) => (
          <span className="whitespace-nowrap text-xs text-muted">{u.createdAt ? formatDate(u.createdAt) : "—"}<span className="block font-mono">by {u.createdBy ?? "—"}</span></span>
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original: u } }) =>
          u.manageable ? (
            <span className="flex justify-end gap-1">
              <IconButton label={`Edit ${u.username}`} onClick={() => setMode({ kind: "edit", user: u })}><Pencil size={15} /></IconButton>
              <IconButton label={`Reset password for ${u.username}`} onClick={() => setMode({ kind: "reset", user: u })}><KeyRound size={15} /></IconButton>
              <IconButton label={`Delete ${u.username}`} danger onClick={() => setMode({ kind: "delete", user: u })}><Trash2 size={15} /></IconButton>
            </span>
          ) : (
            <span className="flex justify-end text-xs text-faint" title={u.id === me.id ? "Change your own password from the button above" : "Only a super admin can change this account"}>
              <Lock size={13} className="mr-1" aria-hidden /> {u.id === me.id ? "You" : "Protected"}
            </span>
          ),
      }),
    ];
  }, [cityName, me.id]);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Accounts"
        description={
          role === "super_admin"
            ? "You can create and manage every account, including admins. Passwords are stored as Argon2id hashes in the local database and are never shown again."
            : "You can create and manage Analyst and Auditor accounts. Admin accounts are managed by a super admin."
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setMode({ kind: "own-password" })}><KeyRound size={15} aria-hidden /> Change my password</Button>
            <Button variant="primary" onClick={() => setMode({ kind: "create" })}><UserPlus size={15} aria-hidden /> New account</Button>
          </>
        }
      />

      {users.error ? (
        <ErrorState error={users.error} onRetry={users.reload} />
      ) : !users.data ? (
        <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading accounts" />
      ) : (
        <RevealGroup className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(["super_admin", "admin", "analyst", "auditor"] as const).map((r) => (
              <Card key={r} className="p-5">
                <div className="flex items-center justify-between">
                  <Badge tone={ROLE_TONE[r]}>{ROLE_LABELS[r]}</Badge>
                  <span className="font-display text-2xl tabular">{users.data!.filter((u) => u.role === r).length}</span>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">{ROLE_DESCRIPTIONS[r]}</p>
              </Card>
            ))}
          </div>
          <Card className="overflow-hidden">
            <DataTable
              label="Accounts"
              data={users.data}
              columns={columns}
              getRowId={(u) => u.id}
              pageSize={20}
              empty={<EmptyState title="No accounts">Create the first one with “New account”.</EmptyState>}
            />
          </Card>
          <p className="flex items-center gap-2 text-xs text-muted">
            <ShieldCheck size={14} className="text-accent" aria-hidden />
            Changing a role, deactivating an account or resetting a password signs that person out everywhere. After 5 failed sign-ins an account locks for 15 minutes.
          </p>
        </RevealGroup>
      )}

      {mode?.kind === "create" && <AccountDialog mode={mode} cities={cities.data ?? []} onClose={() => setMode(null)} onDone={done} />}
      {mode?.kind === "edit" && <AccountDialog mode={mode} cities={cities.data ?? []} onClose={() => setMode(null)} onDone={done} />}
      {(mode?.kind === "reset" || mode?.kind === "own-password") && <PasswordDialog mode={mode} onClose={() => setMode(null)} onDone={done} />}
      {mode?.kind === "delete" && <DeleteDialog user={mode.user} onClose={() => setMode(null)} onDone={done} />}
    </>
  );
}

function IconButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={`focus-ring grid size-8 place-items-center rounded-sm text-muted hover:bg-bg-subtle ${danger ? "hover:text-danger" : "hover:text-text"}`}>
      {children}
    </button>
  );
}

function FormError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null;
}

const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "The request failed.");

function AccountDialog({ mode, cities, onClose, onDone }: {
  mode: { kind: "create" } | { kind: "edit"; user: User };
  cities: City[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const ctx = useRequestContext();
  const { role: actorRole } = useSession();
  const editing = mode.kind === "edit" ? mode.user : null;
  const roles = assignableRoles(actorRole);
  const [username, setUsername] = useState(editing?.username ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [role, setRole] = useState<Role>(editing?.role ?? "analyst");
  const [cityIds, setCityIds] = useState<string[]>(editing?.allowedCityIds ?? []);
  const [active, setActive] = useState(editing?.active !== false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim() && (editing || (/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) && passwordOk(password, username) && password === confirm));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return setError("Check the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await accounts.updateUser(ctx, editing.id, { name: name.trim(), role, allowedCityIds: role === "analyst" ? cityIds : [], active });
        onDone(`Updated ${editing.username}`);
      } else {
        await accounts.createUser(ctx, { username, name: name.trim(), role, password, allowedCityIds: role === "analyst" ? cityIds : [] });
        setPassword("");
        setConfirm("");
        onDone(`Created ${username}`);
      }
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose} width="max-w-xl"
      title={editing ? `Edit ${editing.username}` : "New account"}
      description={editing ? "Changing the role or deactivating signs this person out everywhere." : "Share the password with the person through a separate, secure channel."}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} disabled={!!editing} autoComplete="off" spellCheck={false}
              className={`${input} font-mono disabled:opacity-60`} placeholder="e.g. a.benali" />
            {!editing && <span className="mt-1 block text-[11px] text-faint">3–32: lowercase letters, digits, . _ -</span>}
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Display name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={input} />
          </label>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Role</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <label key={r} className={`flex cursor-pointer items-start gap-2.5 rounded-sm border p-3 text-sm focus-within:shadow-[0_0_0_3px_var(--ring)] ${role === r ? "border-accent bg-accent-soft" : "border-border hover:bg-bg-subtle"}`}>
                <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} className="mt-0.5 accent-[var(--accent)]" />
                <span>
                  <span className="font-medium">{ROLE_LABELS[r]}</span>
                  <span className="mt-0.5 block text-xs text-muted">{ROLE_DESCRIPTIONS[r]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {role === "analyst" && (
          <CheckboxList
            legend="Allowed cities"
            hint="The analyst sees cameras, reads and alerts of these cities only."
            options={cities.map((c) => ({ id: c.id, label: c.name, detail: c.demo ? "demo" : undefined }))}
            value={cityIds}
            onChange={setCityIds}
          />
        )}

        {editing ? (
          <label className="flex items-center gap-2.5 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-[var(--accent)]" />
            <Power size={14} className="text-muted" aria-hidden /> Account active
          </label>
        ) : (
          <PasswordField value={password} confirm={confirm} onChange={setPassword} onConfirmChange={setConfirm} username={username} label="Initial password" />
        )}

        <FormError error={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
            {editing ? "Save changes" : <><Plus size={15} aria-hidden /> Create account</>}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordDialog({ mode, onClose, onDone }: {
  mode: { kind: "reset"; user: User } | { kind: "own-password" };
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const ctx = useRequestContext();
  const { user: me, expire } = useSession();
  const target = mode.kind === "reset" ? mode.user : me;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = passwordOk(password, target.username) && password === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === "own-password") {
        await accounts.changeOwnPassword(ctx, password);
        expire(); // the server revoked every session, including this one
        return;
      }
      await accounts.resetPassword(ctx, target.id, password);
      onDone(`Password reset for ${target.username}`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    } finally {
      setPassword("");
      setConfirm("");
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose}
      title={mode.kind === "own-password" ? "Change my password" : `Reset password for ${target.username}`}
      description={mode.kind === "own-password" ? "You will be signed out everywhere and sign in again with the new password." : "Their current sessions end immediately. Share the new password through a separate, secure channel."}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <PasswordField value={password} confirm={confirm} onChange={setPassword} onConfirmChange={setConfirm} username={target.username} label="New password" />
        <FormError error={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!valid}><KeyRound size={15} aria-hidden /> Set password</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: (msg: string) => void }) {
  const ctx = useRequestContext();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (typed !== user.username) return;
    setBusy(true);
    try {
      await accounts.deleteUser(ctx, user.id);
      onDone(`Deleted ${user.username}`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={`Delete ${user.username}?`}
      description="The account and its sessions are removed. Its past actions stay in the audit log. To keep the account but block sign-in, deactivate it instead.">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm">Type <span className="font-mono font-semibold">{user.username}</span> to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={`${input} font-mono`} />
        </label>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={typed !== user.username}><Trash2 size={15} aria-hidden /> Delete account</Button>
        </div>
      </form>
    </Dialog>
  );
}
