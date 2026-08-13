import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PrivacyConsentMethod,
  ReservationAuditAction,
  ReservationOrigin,
  ReservationStatus,
  ServiceType,
  UserRole,
} from "@/generated/prisma/client";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const userId = randomUUID();
const reservationId = randomUUID();
const publicAuditId = randomUUID();
const staffAuditId = randomUUID();

const sensitiveValues = [
  "Nome Legacy Fittizio",
  "Cognome Legacy Fittizio",
  "+39 000 999 0000",
  "legacy@example.invalid",
  "Allergia legacy fittizia",
  "Intolleranza legacy fittizia",
  "Ricorrenza legacy fittizia",
  "Nota legacy fittizia",
];

function operationalState() {
  return {
    localDate: "2099-12-24",
    serviceType: "DINNER",
    arrivalTime: "20:00",
    partySize: 4,
    status: "CONFIRMED",
  };
}

describe.sequential("M9-A legacy reservation audit minimization", () => {
  beforeAll(async () => {
    await prisma.restaurant.create({
      data: {
        id: restaurantId,
        name: "M9-A Audit Migration Fixture",
        timezone: "Europe/Rome",
      },
    });
    await prisma.user.create({
      data: {
        id: userId,
        restaurantId,
        username: `m9a.audit.${userId.slice(0, 8)}`,
        passwordHash: "fake-hash-used-only-by-the-migration-test",
        role: UserRole.ADMIN,
      },
    });
    await prisma.reservation.create({
      data: {
        id: reservationId,
        restaurantId,
        localDate: new Date("2099-12-24T00:00:00.000Z"),
        serviceType: ServiceType.DINNER,
        arrivalTime: operationalTimeToDatabase("20:00"),
        partySize: 4,
        status: ReservationStatus.CONFIRMED,
        origin: ReservationOrigin.PUBLIC,
        customerFirstName: sensitiveValues[0]!,
        customerLastName: sensitiveValues[1]!,
        customerPhone: sensitiveValues[2]!,
        customerEmail: sensitiveValues[3]!,
        notes: sensitiveValues[7]!,
        preferences: JSON.stringify({
          roomCode: "sala-2",
          highChair: true,
          celebration: sensitiveValues[6],
        }),
        allergies: JSON.stringify({
          celiac: false,
          allergies: sensitiveValues[4],
          intolerances: sensitiveValues[5],
        }),
        privacyPolicyVersion: "test-privacy-v1",
        privacyConsentAt: new Date("2099-01-01T10:00:00.000Z"),
        privacyConsentMethod: PrivacyConsentMethod.WEB_CHECKBOX,
        termsPolicyVersion: "test-terms-v1",
        termsConsentAt: new Date("2099-01-01T10:00:00.000Z"),
        termsConsentMethod: PrivacyConsentMethod.WEB_CHECKBOX,
        consentLanguage: "it",
      },
    });

    await prisma.reservationAuditEvent.create({
      data: {
        id: publicAuditId,
        restaurantId,
        reservationId,
        action: ReservationAuditAction.CREATED,
        actorOrigin: ReservationOrigin.PUBLIC,
        correlationId: randomUUID(),
        previousState: undefined,
        newState: {
          ...operationalState(),
          preferences: JSON.stringify({
            roomCode: "sala-2",
            highChair: true,
            celebration: sensitiveValues[6],
          }),
          allergies: JSON.stringify({
            allergies: sensitiveValues[4],
            intolerances: sensitiveValues[5],
          }),
          notes: sensitiveValues[7],
          customerFirstName: sensitiveValues[0],
          customerPhone: sensitiveValues[2],
        },
      },
    });
    await prisma.reservationAuditEvent.create({
      data: {
        id: staffAuditId,
        restaurantId,
        reservationId,
        action: ReservationAuditAction.UPDATED,
        actorOrigin: ReservationOrigin.STAFF,
        actorUserId: userId,
        actorRole: UserRole.ADMIN,
        correlationId: randomUUID(),
        previousState: {
          ...operationalState(),
          customer: {
            firstName: sensitiveValues[0],
            lastName: sensitiveValues[1],
          },
          requests: {
            roomCode: "sala-2",
            allergiesPresent: true,
            notesPresent: true,
          },
          version: 1,
        },
        newState: {
          ...operationalState(),
          partySize: 3,
          customer: {
            firstName: sensitiveValues[0],
            lastName: sensitiveValues[1],
          },
          requests: {
            roomCode: "sala-2",
            allergiesPresent: true,
            intolerancesPresent: true,
            celebrationPresent: true,
            notesPresent: true,
          },
          version: 2,
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.reservationAuditEvent.deleteMany({ where: { restaurantId } });
    await prisma.reservation.deleteMany({ where: { restaurantId } });
    await prisma.user.deleteMany({ where: { restaurantId } });
    await prisma.restaurant.deleteMany({ where: { id: restaurantId } });
    await prisma.$disconnect();
  });

  it("removes sensitive legacy copies while preserving rows and operations", async () => {
    const reservationBefore = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    const eventsBefore = await prisma.reservationAuditEvent.findMany({
      where: { id: { in: [publicAuditId, staffAuditId] } },
      orderBy: { id: "asc" },
    });

    await prisma.$executeRaw`
      UPDATE reservation_audit_events
      SET
        previous_state = CASE
          WHEN previous_state IS NULL THEN NULL
          ELSE m9a_minimize_reservation_audit_snapshot(
            previous_state,
            actor_origin::text
          )
        END,
        new_state = m9a_minimize_reservation_audit_snapshot(
          new_state,
          actor_origin::text
        )
      WHERE id IN (${publicAuditId}::uuid, ${staffAuditId}::uuid)
    `;

    const eventsAfter = await prisma.reservationAuditEvent.findMany({
      where: { id: { in: [publicAuditId, staffAuditId] } },
      orderBy: { id: "asc" },
    });
    const reservationAfter = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
    });

    expect(eventsAfter).toHaveLength(2);
    expect(eventsAfter.map((event) => event.id)).toEqual(
      eventsBefore.map((event) => event.id),
    );
    expect(eventsAfter.map((event) => event.correlationId)).toEqual(
      eventsBefore.map((event) => event.correlationId),
    );
    expect(eventsAfter.map((event) => event.createdAt)).toEqual(
      eventsBefore.map((event) => event.createdAt),
    );
    expect(reservationAfter).toEqual(reservationBefore);

    const serialized = JSON.stringify(eventsAfter);
    for (const sensitive of sensitiveValues) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(serialized).not.toContain("customerFirstName");
    expect(serialized).not.toContain('"customer"');

    const publicEvent = eventsAfter.find((event) => event.id === publicAuditId)!;
    expect(publicEvent.newState).toMatchObject({
      localDate: "2099-12-24",
      serviceType: "DINNER",
      arrivalTime: "20:00",
      partySize: 4,
      status: "CONFIRMED",
      origin: "PUBLIC",
      requests: {
        roomCode: "sala-2",
        highChair: true,
        foodRequestsPresent: true,
        allergiesPresent: true,
        intolerancesPresent: true,
        celebrationPresent: true,
        notesPresent: true,
      },
    });
    const staffEvent = eventsAfter.find((event) => event.id === staffAuditId)!;
    expect(staffEvent.newState).toMatchObject({
      partySize: 3,
      origin: "STAFF",
      version: 2,
      requests: {
        roomCode: "sala-2",
        allergiesPresent: true,
        intolerancesPresent: true,
        celebrationPresent: true,
        notesPresent: true,
      },
    });
  });
});
