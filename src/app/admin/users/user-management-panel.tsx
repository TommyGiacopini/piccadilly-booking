"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { ManagedUser } from "@/modules/identity/application/identity-service";

const inputClass =
  "rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

async function jsonMutation(
  url: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      typeof result.error === "string" ? result.error : "Operazione non riuscita.",
    );
  }

  return result;
}

export function UserManagementPanel({
  currentUserId,
  users,
}: {
  currentUserId: string;
  users: ManagedUser[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [temporaryCredential, setTemporaryCredential] = useState<{
    username: string;
    password: string;
  } | null>(null);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = String(data.get("username") ?? "");
    setBusyId("create");
    setMessage(null);

    try {
      const result = await jsonMutation("/api/admin/users", "POST", {
        username,
        role: data.get("role"),
      });
      setTemporaryCredential({
        username,
        password: String(result.temporaryPassword),
      });
      form.reset();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(user: ManagedUser, role: "ADMIN" | "STAFF") {
    if (role === user.role) return;
    if (!window.confirm(`Confermi il nuovo ruolo ${role} per ${user.username}?`)) return;
    setBusyId(user.id);
    setMessage(null);
    try {
      await jsonMutation(`/api/admin/users/${user.id}/role`, "PATCH", { role });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally {
      setBusyId(null);
    }
  }

  async function changeStatus(user: ManagedUser) {
    const nextActive = !user.isActive;
    if (!window.confirm(`${nextActive ? "Riattivare" : "Disattivare"} ${user.username}?`)) return;
    setBusyId(user.id);
    setMessage(null);
    try {
      await jsonMutation(`/api/admin/users/${user.id}/status`, "PATCH", {
        isActive: nextActive,
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(user: ManagedUser) {
    if (!window.confirm(`Generare una nuova password temporanea per ${user.username}?`)) return;
    setBusyId(user.id);
    setMessage(null);
    try {
      const result = await jsonMutation(
        `/api/admin/users/${user.id}/reset-password`,
        "POST",
      );
      setTemporaryCredential({
        username: user.username,
        password: String(result.temporaryPassword),
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {message ? (
        <p className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-800" role="alert">
          {message}
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-xl font-black text-zinc-950">Crea account individuale</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Lo username viene normalizzato e non potrà essere modificato. La password temporanea sarà mostrata una sola volta.
        </p>
        <form className="mt-5 flex flex-wrap items-end gap-3" onSubmit={createUser}>
          <label className="grid min-w-56 flex-1 gap-1.5 text-sm font-bold text-zinc-700">
            Username
            <input autoCapitalize="none" className={inputClass} maxLength={64} minLength={3} name="username" required spellCheck={false} />
          </label>
          <label className="grid gap-1.5 text-sm font-bold text-zinc-700">
            Ruolo
            <select className={inputClass} defaultValue="STAFF" name="role">
              <option value="STAFF">STAFF</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </label>
          <button className="rounded-xl bg-orange-600 px-5 py-2.5 text-sm font-black text-white disabled:opacity-50" disabled={busyId !== null} type="submit">
            Crea utente
          </button>
        </form>
      </section>

      <section className="mt-6 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-5 py-4">
          <h2 className="text-xl font-black text-zinc-950">Utenti del ristorante</h2>
        </div>
        <div className="divide-y divide-zinc-200">
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <article className="grid gap-4 px-5 py-5 lg:grid-cols-[1fr_auto_auto] lg:items-center" key={user.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-black text-zinc-950">{user.username}</h3>
                    {isSelf ? <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-bold text-orange-900">Account corrente</span> : null}
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${user.isActive ? "bg-emerald-100 text-emerald-900" : "bg-zinc-200 text-zinc-700"}`}>
                      {user.isActive ? "Attivo" : "Disattivato"}
                    </span>
                    {user.mustChangePassword ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">Cambio password richiesto</span> : null}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">Creato il {new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(user.createdAt))}</p>
                </div>
                <label className="grid gap-1 text-xs font-bold text-zinc-600">
                  Ruolo
                  <select className={inputClass} disabled={busyId !== null || isSelf} onChange={(event) => void changeRole(user, event.target.value as "ADMIN" | "STAFF")} value={user.role}>
                    <option value="ADMIN">ADMIN</option>
                    <option value="STAFF">STAFF</option>
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-bold text-zinc-800 disabled:opacity-40" disabled={busyId !== null || isSelf} onClick={() => void resetPassword(user)} type="button">
                    Reset password
                  </button>
                  <button className={`rounded-xl px-3 py-2 text-sm font-bold disabled:opacity-40 ${user.isActive ? "bg-red-50 text-red-800" : "bg-emerald-100 text-emerald-900"}`} disabled={busyId !== null || isSelf} onClick={() => void changeStatus(user)} type="button">
                    {user.isActive ? "Disattiva" : "Riattiva"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {temporaryCredential ? (
        <div aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" role="dialog">
          <section className="w-full max-w-lg rounded-3xl bg-white p-7 shadow-2xl">
            <p className="text-xs font-black tracking-widest text-orange-600 uppercase">Visualizzazione unica</p>
            <h2 className="mt-2 text-2xl font-black text-zinc-950">Consegna la password temporanea</h2>
            <p className="mt-3 text-sm leading-6 text-zinc-600">
              Copiala ora e consegnala direttamente a {temporaryCredential.username}. Dopo la chiusura non sarà recuperabile.
            </p>
            <output className="mt-5 block break-all rounded-xl bg-zinc-950 px-4 py-4 font-mono text-lg font-bold text-white">
              {temporaryCredential.password}
            </output>
            <div className="mt-5 flex flex-wrap gap-3">
              <button className="rounded-xl bg-orange-600 px-4 py-2.5 font-bold text-white" onClick={() => void navigator.clipboard.writeText(temporaryCredential.password)} type="button">
                Copia
              </button>
              <button className="rounded-xl border border-zinc-300 px-4 py-2.5 font-bold text-zinc-800" onClick={() => setTemporaryCredential(null)} type="button">
                Ho salvato, chiudi
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
