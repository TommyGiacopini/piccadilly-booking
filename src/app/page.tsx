export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-8">
      <section className="w-full max-w-4xl overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(0,0,0,0.08)]">
        <div className="h-2 bg-orange-500" />

        <div className="grid gap-12 px-7 py-10 sm:px-12 sm:py-14 lg:grid-cols-[1.4fr_0.8fr] lg:px-16 lg:py-16">
          <div className="flex flex-col justify-center">
            <span className="mb-8 w-fit rounded-full bg-orange-100 px-4 py-2 text-sm font-bold tracking-wide text-orange-800 uppercase">
              Ambiente di sviluppo
            </span>

            <p className="mb-3 text-sm font-semibold tracking-[0.2em] text-zinc-500 uppercase">
              Risto Pizza Piccadilly
            </p>
            <h1 className="text-4xl font-black tracking-tight text-black sm:text-5xl">
              Piccadilly Booking
            </h1>
            <p className="mt-5 max-w-xl text-xl leading-8 font-medium text-zinc-700">
              Fondamenta applicative configurate
            </p>
            <p className="mt-4 max-w-xl leading-7 text-zinc-500">
              Questa pagina conferma che la base tecnica è operativa. Il modulo
              di prenotazione e l’interfaccia definitiva saranno realizzati nelle
              milestone dedicate.
            </p>
          </div>

          <aside
            aria-label="Stato delle fondamenta tecniche"
            className="rounded-2xl bg-zinc-950 p-6 text-white sm:p-8"
          >
            <p className="text-sm font-bold tracking-[0.18em] text-orange-400 uppercase">
              M1 / Fondamenta
            </p>
            <ul className="mt-6 space-y-4 text-sm text-zinc-300">
              <li className="border-b border-zinc-800 pb-4">Next.js App Router</li>
              <li className="border-b border-zinc-800 pb-4">TypeScript strict</li>
              <li className="border-b border-zinc-800 pb-4">Tailwind CSS</li>
              <li>Health check e test unitari</li>
            </ul>
          </aside>
        </div>
      </section>
    </main>
  );
}
