import { StaffNavigationLink } from "@/app/_components/staff/staff-shell";
import { navigationGroupsForRole } from "@/app/_components/staff/staff-navigation";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

export default async function AdminTechnicalPage() {
  await requireAdmin();
  return <main className="min-h-screen px-4 py-8 sm:px-8">
    <div className="mx-auto max-w-6xl">
      <header className="rounded-3xl bg-shell px-6 py-7 text-shell-text sm:px-9">
        <p className="text-xs font-semibold tracking-widest text-brand-copper uppercase">Piccadilly Booking</p>
        <h1 className="mt-3 text-3xl font-bold sm:text-4xl">Hub Admin</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-shell-text-secondary sm:text-base">Accedi alle funzioni amministrative. Agenda, prenotazioni telefoniche e assegnazione sala restano nella sezione Operatività.</p>
      </header>
      <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-3">
        {navigationGroupsForRole("ADMIN").filter(group => group.id !== "operations").map(group => <section key={group.id} aria-labelledby={"hub-" + group.id} className="min-w-0 rounded-2xl border border-border bg-surface p-5">
          <h2 id={"hub-" + group.id} className="text-lg font-semibold text-text-primary">{group.label}</h2>
          <ul className="mt-3 space-y-2">{group.items.map(item => <li key={item.href}>
            <StaffNavigationLink href={item.href} className="flex min-h-11 items-center justify-between gap-3 rounded-control border border-border px-4 py-3 text-sm font-semibold text-text-primary hover:border-brand-copper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-copper">
              <span className="min-w-0">{item.label}</span><span aria-hidden="true">→</span>
            </StaffNavigationLink>
          </li>)}</ul>
        </section>)}
      </div>
    </div>
  </main>;
}
