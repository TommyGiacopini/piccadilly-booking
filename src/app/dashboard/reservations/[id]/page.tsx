import { notFound } from "next/navigation";
import { z } from "zod";
import { ReservationDetailContent } from "@/app/dashboard/reservation-detail-content";
import { getStaffReservationFormContext } from "@/modules/dashboard/application/dashboard-query";
import { getStaffReservation } from "@/modules/reservations/application/staff-reservation-service";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import { requireAuthenticatedUser } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export default async function ReservationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) notFound();
  const user = await requireAuthenticatedUser("/dashboard/reservations/" + parsed.data);
  try { await getStaffReservation({ actor: { id: user.id, restaurantId: user.restaurantId, role: user.role }, reservationId: parsed.data }); }
  catch (error) { if (error instanceof ReservationApplicationError && error.code === "NOT_FOUND") notFound(); throw error; }
  const context = await getStaffReservationFormContext({ restaurantId: user.restaurantId });
  return <main className="mx-auto min-w-0 max-w-4xl px-4 py-6"><ReservationDetailContent reservationId={parsed.data} timezone={context.timezone} /></main>;
}
