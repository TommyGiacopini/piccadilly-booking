import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { RoomManagementPanel } from "@/app/admin/rooms/room-management-panel";
import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";
import { getAdminRoomConfiguration } from "@/modules/rooms/application/room-configuration-service";
import { requireAdmin } from "@/server/auth/authorization";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ date?: string; service?: string }>;
}

export default async function RoomsPage({ searchParams }: PageProps) {
  const user = await requireAdmin("/admin/rooms");
  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: user.restaurantId },
    select: { timezone: true },
  });
  const parameters = await searchParams;
  const today = getZonedDateTimeParts(new Date(), restaurant.timezone).date;
  const localDate = parameters.date && isLocalDate(parameters.date) ? parameters.date : today;
  const serviceType = parameters.service === "DINNER" ? "DINNER" : "LUNCH";
  const configuration = await getAdminRoomConfiguration(user, { localDate, serviceType });

  return (
    <ConfigurationShell
      description="Catalogo fisso delle cinque sale, disponibilità per singolo servizio e tavoli operativi. Le preferenze già salvate restano consultabili anche dopo una disattivazione."
      title="Sale, servizi e tavoli"
    >
      <RoomManagementPanel configuration={configuration} />
    </ConfigurationShell>
  );
}
