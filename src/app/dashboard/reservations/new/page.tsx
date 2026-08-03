import { ReservationCreateForm } from "@/app/dashboard/reservations/new/reservation-create-form";
import { requireAuthenticatedUser } from "@/server/auth/authorization";
import { resolveReservationConfig } from "@/shared/config/reservation-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function NewReservationPage() {
  const user = await requireAuthenticatedUser("/dashboard/reservations/new");
  const config = resolveReservationConfig();

  return (
    <main className="min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="rounded-3xl bg-zinc-950 px-7 py-8 text-white shadow-xl sm:px-10">
          <p className="text-sm font-bold tracking-[0.18em] text-orange-400 uppercase">
            Area Staff · strumento M6
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
            Nuova prenotazione tecnica
          </h1>
          <p className="mt-3 max-w-3xl leading-7 text-zinc-300">
            Inserimento persistente STAFF o PHONE. Questa pagina non è il
            modulo pubblico definitivo e non invia notifiche.
          </p>
        </header>

        <ReservationCreateForm
          isAdmin={user.role === "ADMIN"}
          privacyPolicyVersion={config.privacyPolicyVersion}
        />
      </div>
    </main>
  );
}
