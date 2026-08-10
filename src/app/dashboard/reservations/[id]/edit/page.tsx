import { notFound } from "next/navigation";
import { z } from "zod";

import { ReservationEditForm } from "@/app/dashboard/reservations/[id]/edit/reservation-edit-form";
import { getStaffReservationFormContext } from "@/modules/dashboard/application/dashboard-query";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import { getStaffReservation } from "@/modules/reservations/application/staff-reservation-service";
import { requireAuthenticatedUser } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface EditReservationPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditReservationPage({
  params,
}: EditReservationPageProps) {
  const user = await requireAuthenticatedUser("/dashboard");
  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);

  if (!parsedId.success) notFound();

  let reservation;

  try {
    reservation = await getStaffReservation({
      actor: {
        id: user.id,
        restaurantId: user.restaurantId,
        role: user.role,
      },
      reservationId: parsedId.data,
    });
  } catch (error) {
    if (
      error instanceof ReservationApplicationError &&
      error.code === "NOT_FOUND"
    ) {
      notFound();
    }
    throw error;
  }

  if (reservation.status === "CANCELLED") notFound();

  const context = await getStaffReservationFormContext({
    restaurantId: user.restaurantId,
    rawDate: reservation.localDate,
  });

  return (
    <main className="min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="rounded-3xl bg-zinc-950 px-7 py-8 text-white shadow-xl sm:px-10">
          <p className="text-sm font-bold tracking-[0.18em] text-orange-400 uppercase">
            Gestione Staff/Admin
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
            Modifica prenotazione
          </h1>
          <p className="mt-3 max-w-3xl leading-7 text-zinc-300">
            Origine iniziale {reservation.origin}, autore e consensi restano invariati.
          </p>
        </header>

        <ReservationEditForm
          reservation={reservation}
          rooms={context.rooms
            .filter((room) => room.isActive)
            .map(({ code, name }) => ({ code, name }))}
        />
      </div>
    </main>
  );
}
