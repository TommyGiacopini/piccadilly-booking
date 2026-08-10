import { ReservationCreateForm } from "@/app/dashboard/reservations/new/reservation-create-form";
import { getStaffReservationFormContext } from "@/modules/dashboard/application/dashboard-query";
import { requireAuthenticatedUser } from "@/server/auth/authorization";
import { resolveReservationConfig } from "@/shared/config/reservation-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface NewReservationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewReservationPage({
  searchParams,
}: NewReservationPageProps) {
  const user = await requireAuthenticatedUser("/dashboard/reservations/new");
  const config = resolveReservationConfig();
  const query = await searchParams;
  const context = await getStaffReservationFormContext({
    restaurantId: user.restaurantId,
    rawDate: typeof query.date === "string" ? query.date : undefined,
  });

  return (
    <main className="min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="rounded-3xl bg-zinc-950 px-7 py-8 text-white shadow-xl sm:px-10">
          <p className="text-sm font-bold tracking-[0.18em] text-orange-400 uppercase">
            Area Staff · operatività M8
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
            Prenotazione telefonica rapida
          </h1>
          <p className="mt-3 max-w-3xl leading-7 text-zinc-300">
            L’origine è fissata dal server a PHONE. Il salvataggio aggiorna
            subito la capacità condivisa e non invia notifiche.
          </p>
        </header>

        <ReservationCreateForm
          defaultDate={context.localDate}
          initialRooms={context.rooms
            .filter((room) => room.isActive)
            .map(({ code, name }) => ({ code, name }))}
          privacyPolicyVersion={config.privacyPolicyVersion}
        />
      </div>
    </main>
  );
}
