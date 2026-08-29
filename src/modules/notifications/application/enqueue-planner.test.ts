import { describe, expect, it } from "vitest";

import {
  planReservationCancelled,
  planReservationCreated,
  planReservationUpdated,
  type ReservationNotificationSource,
} from "@/modules/notifications/application/enqueue-planner";
import type {
  NotificationPlanningContext,
  NotificationTransactionWriter,
} from "@/modules/notifications/application/ports";
import type { PlannedNotificationLeg } from "@/modules/notifications/domain/types";

const now = new Date("2028-08-20T10:00:00.000Z");
const reservation: ReservationNotificationSource = {
  id: "10000000-0000-4000-8000-000000000001",
  restaurantId: "10000000-0000-4000-8000-000000000002",
  version: 1,
  origin: "PHONE",
  customerFirstName: "Ada",
  customerPhone: "+39000000000",
  customerEmail: "ada@example.test",
  consentLanguage: null,
  localDate: "2028-08-21",
  serviceType: "DINNER",
  arrivalTime: "20:00",
  partySize: 2,
};

function harness(context: NotificationPlanningContext, succeededReminder = false) {
  const inserted: PlannedNotificationLeg[] = [];
  const superseded: Array<{ reason: string }> = [];
  const writer: NotificationTransactionWriter = {
    readPlanningContext: async () => context,
    insertLeg: async ({ leg }) => { inserted.push(leg); },
    supersedeNonTerminal: async (input) => { superseded.push(input); },
    hasSucceededReminderForSchedule: async () => succeededReminder,
  };
  let sequence = 0;
  return {
    dependencies: {
      writer,
      ids: { generate: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` },
    },
    inserted,
    superseded,
  };
}

describe("transaction-scoped notification enqueue planner", () => {
  it.each([
    ["WHATSAPP_ONLY", false, []],
    ["WHATSAPP_WITH_EMAIL_FALLBACK", false, []],
    ["WHATSAPP_AND_EMAIL_PARALLEL", false, ["EMAIL"]],
  ] as const)("applies phone opt-out to initial confirmation for %s", async (strategy, requested, channels) => {
    const test = harness({ restaurantName: "Piccadilly", timezone: "Europe/Rome", strategy });
    await planReservationCreated({
      dependencies: test.dependencies,
      reservation: { ...reservation, localDate: "2028-08-20", arrivalTime: "12:00" },
      actorUserId: "30000000-0000-4000-8000-000000000001",
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
      sendWhatsAppConfirmation: requested,
    });
    expect(test.inserted.filter((leg) => leg.eventType === "RESERVATION_CONFIRMED").map((leg) => leg.channel)).toEqual(channels);
  });

  it("leaves reminder enabled after phone confirmation opt-out", async () => {
    const test = harness({ restaurantName: "Piccadilly", timezone: "Europe/Rome", strategy: "WHATSAPP_ONLY" });
    await planReservationCreated({
      dependencies: test.dependencies,
      reservation,
      actorUserId: null,
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
      sendWhatsAppConfirmation: false,
    });
    expect(test.inserted.map((leg) => leg.eventType)).toEqual(["RESERVATION_REMINDER"]);
  });

  it("supersedes older legs and enqueues update plus replacement reminder", async () => {
    const test = harness({ restaurantName: "Piccadilly", timezone: "Europe/Rome", strategy: "WHATSAPP_ONLY" });
    await planReservationUpdated({
      dependencies: test.dependencies,
      reservation: { ...reservation, version: 3 },
      actorUserId: null,
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
      scheduleChanged: false,
    });
    expect(test.superseded).toHaveLength(1);
    expect(test.superseded[0]?.reason).toBe("SUPERSEDED");
    expect(test.inserted.map((leg) => leg.eventType)).toEqual(["RESERVATION_UPDATED", "RESERVATION_REMINDER"]);
  });

  it("accepts sparse reservation versions and skips a duplicate succeeded reminder for unchanged scheduling", async () => {
    const test = harness({ restaurantName: "Piccadilly", timezone: "Europe/Rome", strategy: "WHATSAPP_ONLY" }, true);
    await planReservationUpdated({
      dependencies: test.dependencies,
      reservation: { ...reservation, version: 7 },
      actorUserId: null,
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
      scheduleChanged: false,
    });
    expect(test.inserted.map((leg) => [leg.eventType, leg.channel])).toEqual([["RESERVATION_UPDATED", "WHATSAPP"]]);
  });

  it("creates a new reminder after a real reschedule even if an old one succeeded", async () => {
    const test = harness({ restaurantName: "Piccadilly", timezone: "Europe/Rome", strategy: "WHATSAPP_ONLY" }, true);
    await planReservationUpdated({
      dependencies: test.dependencies,
      reservation: { ...reservation, version: 8 },
      actorUserId: null,
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
      scheduleChanged: true,
    });
    expect(test.inserted.map((leg) => leg.eventType)).toEqual(["RESERVATION_UPDATED", "RESERVATION_REMINDER"]);
  });

  it("cancels non-terminal work with the reservation reason before cancellation delivery", async () => {
    const test = harness({ restaurantName: "Piccadilly", timezone: "Europe/Rome", strategy: "WHATSAPP_ONLY" });
    await planReservationCancelled({
      dependencies: test.dependencies,
      reservation: { ...reservation, version: 4 },
      actorUserId: null,
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
    });
    expect(test.superseded[0]?.reason).toBe("RESERVATION_CANCELLED");
    expect(test.inserted.map((leg) => leg.eventType)).toEqual(["RESERVATION_CANCELLED"]);
  });

  it("rolls the mutation back by surfacing a missing persisted setting", async () => {
    const test = harness({ restaurantName: "unused", timezone: "Europe/Rome", strategy: "WHATSAPP_ONLY" });
    test.dependencies.writer.readPlanningContext = async () => null;
    await expect(planReservationCreated({
      dependencies: test.dependencies,
      reservation,
      actorUserId: null,
      originCorrelationId: "40000000-0000-4000-8000-000000000001",
      now,
    })).rejects.toThrow("Notification settings are not available");
    expect(test.inserted).toHaveLength(0);
  });
});
