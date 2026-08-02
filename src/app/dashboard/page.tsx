import { requireAuthenticatedUser } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireAuthenticatedUser("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-8">
      <section className="w-full max-w-2xl overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(0,0,0,0.08)]">
        <div className="h-2 bg-orange-500" />
        <div className="px-7 py-10 sm:px-12 sm:py-12">
          <p className="text-sm font-bold tracking-[0.18em] text-orange-600 uppercase">
            Area protetta
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight text-zinc-950">
            Piccadilly Booking
          </h1>

          <dl className="mt-8 grid gap-4 rounded-2xl bg-zinc-100 p-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-bold tracking-wider text-zinc-500 uppercase">
                Username
              </dt>
              <dd className="mt-1 font-bold text-zinc-950">{user.username}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold tracking-wider text-zinc-500 uppercase">
                Ruolo
              </dt>
              <dd className="mt-1 font-bold text-zinc-950">{user.role}</dd>
            </div>
          </dl>

          <p className="mt-6 text-zinc-600">
            Questa è una pagina tecnica protetta. La dashboard operativa sarà
            realizzata nelle milestone successive.
          </p>

          <form action="/api/auth/logout" className="mt-8" method="post">
            <button
              className="rounded-xl bg-zinc-950 px-6 py-3 font-bold text-white transition hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200"
              type="submit"
            >
              Logout
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
