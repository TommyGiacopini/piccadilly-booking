import "server-only";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { localDateToDatabase, operationalTimeFromDatabase } from "@/modules/configuration/domain/operational-time";
import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import { parsePublicPreferences, parsePublicAllergies } from "@/modules/reservations/domain/public-validation";
import { readFreshAssignmentActor } from "./reservation-assignment-repository";
import { readEffectiveServiceRooms } from "./service-instance-repository";
import { ReservationAssignmentError } from "@/modules/rooms/application/reservation-assignment-errors";
import { deriveRoomAssignedAt, type AssignmentHistoryEvent, type RoomAssignmentWorkspace, type WorkspaceQuery } from "@/modules/rooms/domain/room-assignment-workspace";

interface PresenceRow { id: string; notesPresent: boolean; privateNotesPresent: boolean; legacyNotesPresent: boolean; legacyNotesState: "ACTIVE" | "CLEARED" | null }
export async function readRoomAssignmentWorkspace(input: {
  actor: { id: string; restaurantId: string }; query: WorkspaceQuery; now: Date;
}, client: PrismaClient = prisma): Promise<RoomAssignmentWorkspace> {
  return client.$transaction(async tx => {
    const actor = await readFreshAssignmentActor(tx, { actorId: input.actor.id, restaurantId: input.actor.restaurantId });
    if (!actor) throw new ReservationAssignmentError("FORBIDDEN", "Accesso Staff richiesto.");
    const restaurantId = actor.restaurantId, date = localDateToDatabase(input.query.date);
    const restaurant = await tx.restaurant.findUnique({ where: { id: restaurantId }, select: { timezone: true } });
    if (!restaurant) throw new ReservationAssignmentError("NOT_FOUND", "Ristorante non disponibile.");
    const historical = input.query.date < getZonedDateTimeParts(input.now, restaurant.timezone).date;
    const catalog = await tx.room.findMany({ where: { restaurantId }, select: { id: true, code: true, name: true, isActive: true }, orderBy: [{ displayOrder: "asc" }, { code: "asc" }] });
    const effective = historical ? null : await readEffectiveServiceRooms(tx, { restaurantId, localDate: input.query.date, serviceType: input.query.service, now: input.now });
    const rows = await tx.reservation.findMany({ where: { restaurantId, localDate: date, serviceType: input.query.service, status: "CONFIRMED" }, select: {
      id: true, version: true, customerFirstName: true, customerLastName: true, arrivalTime: true,
      partySize: true, childrenCount: true, createdAt: true, preferences: true, allergies: true,
      assignment: { select: { roomId: true, clearedAt: true, _count: { select: { tables: true } } } },
    } });
    // The database evaluates presence. Neither NI text is selected or transported.
    const presence = await tx.$queryRaw<PresenceRow[]>(Prisma.sql`
      SELECT r.id, (r.notes IS NOT NULL AND r.notes <> '') AS "notesPresent",
        (r.private_notes IS NOT NULL AND r.private_notes <> '') AS "privateNotesPresent",
        (a.internal_notes IS NOT NULL) AS "legacyNotesPresent",
        CASE WHEN a.id IS NULL THEN NULL WHEN a.cleared_at IS NULL THEN 'ACTIVE' ELSE 'CLEARED' END AS "legacyNotesState"
      FROM reservations r LEFT JOIN reservation_assignments a
        ON a.restaurant_id = r.restaurant_id AND a.reservation_id = r.id
      WHERE r.restaurant_id = ${restaurantId}::uuid AND r.local_date = ${date}::date
        AND r.service_type = ${input.query.service}::"ServiceType" AND r.status = 'CONFIRMED'
    `);
    const events = rows.length ? await tx.reservationAuditEvent.findMany({ where: {
      restaurantId, reservationId: { in: rows.map(r => r.id) }, action: { in: ["ASSIGNED", "REASSIGNED", "UNASSIGNED"] },
    }, select: { reservationId: true, action: true, createdAt: true, previousState: true, newState: true }, orderBy: { createdAt: "asc" } }) : [];
    const byId = new Map<string, AssignmentHistoryEvent[]>();
    for (const e of events) {
      if (e.action !== "ASSIGNED" && e.action !== "REASSIGNED" && e.action !== "UNASSIGNED") continue;
      const list = byId.get(e.reservationId) ?? [];
      list.push({ action: e.action, createdAt: e.createdAt.toISOString(), previousState: e.previousState, newState: e.newState }); byId.set(e.reservationId, list);
    }
    const presenceById = new Map(presence.map(p => [p.id, p]));
    const reservations = rows.map(r => {
      const active = r.assignment?.clearedAt === null ? r.assignment : null;
      const room = catalog.find(room => room.id === active?.roomId);
      const p = presenceById.get(r.id), preferences = parsePublicPreferences(r.preferences), allergies = parsePublicAllergies(r.allergies);
      return {
        id: r.id, version: r.version, name: `${r.customerFirstName} ${r.customerLastName}`,
        arrivalTime: operationalTimeFromDatabase(r.arrivalTime), partySize: r.partySize,
        childrenCount: r.childrenCount, children: preferences.children, createdAt: r.createdAt.toISOString(),
        roomId: active?.roomId ?? null, roomAssignedAt: deriveRoomAssignedAt(room?.code ?? null, byId.get(r.id) ?? []),
        notesPresent: p?.notesPresent === true, privateNotesPresent: p?.privateNotesPresent === true,
        legacyNotesPresent: p?.legacyNotesPresent === true, legacyNotesState: p?.legacyNotesState ?? null,
        legacyTableCount: r.assignment?._count.tables ?? 0,
        requirements: [preferences.highChair && "Seggiolone", preferences.stroller && "Passeggino", preferences.accessibility && "Accessibilità", allergies.celiac && "Celiachia", (allergies.allergies || allergies.legacyText) && "Allergie segnalate", allergies.intolerances && "Intolleranze segnalate"].filter((v): v is string => typeof v === "string" && v.length > 0),
      };
    });
    return { query: input.query, timezone: restaurant.timezone, isHistorical: historical, snapshotAt: input.now.toISOString(), reservations,
      rooms: catalog.map(room => {
        const assigned = reservations.filter(r => r.roomId === room.id);
        return { ...room, isAvailable: historical ? null : effective?.rooms.find(r => r.id === room.id)?.isAvailable === true,
          reservations: assigned.length, covers: assigned.reduce((sum, r) => sum + r.partySize, 0) };
      }),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
