import { requireAdmin } from "@/server/auth/authorization";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminTechnicalPage() {
  const user = await requireAdmin();

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-8">
      <section className="w-full max-w-xl rounded-3xl border border-orange-200 bg-white p-8 shadow-[0_24px_80px_rgba(0,0,0,0.08)] sm:p-11">
        <p className="text-sm font-bold tracking-[0.18em] text-orange-600 uppercase">
          Verifica autorizzazione
        </p>
        <h1 className="mt-3 text-3xl font-black text-zinc-950">
          Area tecnica ADMIN
        </h1>
        <p className="mt-5 leading-7 text-zinc-600">
          Accesso autorizzato per {user.username}. La configurazione operativa è
          disponibile nella sezione tecnica dedicata.
        </p>
        <Link
          className="mt-7 inline-flex rounded-xl bg-orange-600 px-6 py-3 font-bold text-white"
          href="/admin/configuration"
        >
          Apri configurazione
        </Link>
        <form action="/api/auth/logout" className="mt-8" method="post">
          <button
            className="rounded-xl bg-zinc-950 px-6 py-3 font-bold text-white"
            type="submit"
          >
            Logout
          </button>
        </form>
      </section>
    </main>
  );
}
