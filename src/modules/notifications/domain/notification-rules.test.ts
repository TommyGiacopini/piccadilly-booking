import { describe, expect, it } from "vitest";

import {
  buildNotificationPayloadV1,
  buildPlannedLegs,
  notificationGroupOutcome,
  notificationLocale,
  parseNotificationPayload,
  plannedChannels,
  reminderSchedule,
} from "@/modules/notifications/domain/notification-rules";
import {
  canTransitionNotification,
  nextRetryAt,
  notificationIdempotencyKey,
  retryDelayAfterAttempt,
  terminalFailureForTransient,
} from "@/modules/notifications/domain/delivery-policy";
import type { NotificationReservationSnapshot } from "@/modules/notifications/domain/types";

const reservation: NotificationReservationSnapshot = {
  id: "10000000-0000-4000-8000-000000000001",
  restaurantId: "10000000-0000-4000-8000-000000000002",
  restaurantName: "Piccadilly Demo",
  timezone: "Europe/Rome",
  version: 1,
  origin: "PUBLIC",
  customerFirstName: "Ada",
  customerPhone: "+39000000000",
  customerEmail: "ada@example.test",
  consentLanguage: "en",
  localDate: "2028-03-26",
  serviceType: "DINNER",
  arrivalTime: "20:00",
  partySize: 4,
};

describe("notification payload V1 and locale", () => {
  it("keeps only the approved minimized snapshot", () => {
    const payload = buildNotificationPayloadV1("RESERVATION_UPDATED", reservation);
    expect(payload).toEqual({
      schemaVersion: 1,
      templateKey: "RESERVATION_UPDATED",
      templateVersion: 1,
      locale: "EN",
      params: {
        customerFirstName: "Ada",
        restaurantName: "Piccadilly Demo",
        localDate: "2028-03-26",
        serviceType: "DINNER",
        arrivalTime: "20:00",
        partySize: 4,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/phone|email|note|allerg|token|uuid/iu);
    expect(parseNotificationPayload(payload)).toEqual(payload);
  });

  it.each([
    ["PUBLIC", "en", "EN"],
    ["PUBLIC", "it", "IT"],
    ["PUBLIC", null, "IT"],
    ["PUBLIC", "legacy", "IT"],
    ["PHONE", "en", "IT"],
    ["STAFF", "en", "IT"],
  ] as const)("maps %s/%s to %s", (origin, language, expected) => {
    expect(notificationLocale(origin, language)).toBe(expected);
  });

  it("rejects unknown payload versions and extra PII", () => {
    const payload = buildNotificationPayloadV1("RESERVATION_CONFIRMED", reservation);
    expect(() => parseNotificationPayload({ ...payload, schemaVersion: 2 })).toThrow();
    expect(() => parseNotificationPayload({ ...payload, customerLastName: "Sensitive" })).toThrow();
  });
});

describe("notification strategy", () => {
  it.each([
    ["WHATSAPP_ONLY", true, ["WHATSAPP"]],
    ["WHATSAPP_ONLY", false, []],
    ["WHATSAPP_WITH_EMAIL_FALLBACK", true, ["WHATSAPP"]],
    ["WHATSAPP_WITH_EMAIL_FALLBACK", false, []],
    ["WHATSAPP_AND_EMAIL_PARALLEL", true, ["WHATSAPP", "EMAIL"]],
    ["WHATSAPP_AND_EMAIL_PARALLEL", false, ["EMAIL"]],
  ] as const)("plans %s confirmation with opt-in=%s", (strategy, requested, expected) => {
    expect(plannedChannels({ strategy, eventType: "RESERVATION_CONFIRMED", whatsappConfirmationRequested: requested })).toEqual(expected);
  });

  it("does not apply the phone confirmation suppression to later events", () => {
    expect(plannedChannels({
      strategy: "WHATSAPP_WITH_EMAIL_FALLBACK",
      eventType: "RESERVATION_UPDATED",
      whatsappConfirmationRequested: false,
    })).toEqual(["WHATSAPP"]);
  });

  it("creates an immediately terminal parallel email leg when email is missing", () => {
    const now = new Date("2028-03-20T10:00:00.000Z");
    const legs = buildPlannedLegs({
      reservation: { ...reservation, customerEmail: null },
      eventGroupId: "20000000-0000-4000-8000-000000000001",
      eventType: "RESERVATION_CONFIRMED",
      strategy: "WHATSAPP_AND_EMAIL_PARALLEL",
      now,
      scheduledAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    expect(legs).toHaveLength(2);
    expect(legs[1]).toMatchObject({
      channel: "EMAIL",
      destination: null,
      terminalFailureCode: "DESTINATION_UNAVAILABLE",
    });
  });

  it.each([
    [["SUCCEEDED", "SUCCEEDED"], "SUCCESS"],
    [["SUCCEEDED", "DEAD"], "PARTIAL_SUCCESS"],
    [["DEAD", "DEAD"], "FAILURE"],
    [["PENDING", "SUCCEEDED"], "PENDING"],
    [["CANCELLED", "CANCELLED"], "CANCELLED"],
  ] as const)("derives group %j as %s", (statuses, outcome) => {
    expect(notificationGroupOutcome(statuses)).toBe(outcome);
  });
});

describe("absolute reminder calculation", () => {
  it.each([
    ["2028-03-26", "20:00", "2028-03-26T14:59:59.999Z", true],
    ["2028-03-26", "20:00", "2028-03-26T15:00:00.000Z", true],
    ["2028-03-26", "20:00", "2028-03-26T15:00:00.001Z", false],
    ["2028-03-26", "20:00", "2028-03-26T18:00:00.000Z", false],
    ["2028-02-29", "20:00", "2028-02-29T15:00:00.000Z", true],
  ] as const)("handles %s %s from %s", (localDate, arrivalTime, now, expected) => {
    expect(Boolean(reminderSchedule({ localDate, arrivalTime, timezone: "Europe/Rome" }, new Date(now)))).toBe(expected);
  });

  it("subtracts three absolute hours across the spring DST boundary", () => {
    const result = reminderSchedule(
      { localDate: "2028-03-26", arrivalTime: "04:30", timezone: "Europe/Rome" },
      new Date("2028-03-25T20:00:00.000Z"),
    );
    expect(result?.expiresAt.toISOString()).toBe("2028-03-26T02:30:00.000Z");
    expect(result?.scheduledAt.toISOString()).toBe("2028-03-25T23:30:00.000Z");
  });
});

describe("idempotency, retry and state machine", () => {
  const logical = {
    restaurantId: reservation.restaurantId,
    reservationId: reservation.id,
    reservationVersion: 1,
    eventType: "RESERVATION_CONFIRMED" as const,
    channel: "WHATSAPP" as const,
  };

  it("is stable for replay and differs by version, event and channel", () => {
    const key = notificationIdempotencyKey(logical);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(notificationIdempotencyKey(logical)).toBe(key);
    expect(notificationIdempotencyKey({ ...logical, reservationVersion: 2 })).not.toBe(key);
    expect(notificationIdempotencyKey({ ...logical, eventType: "RESERVATION_UPDATED" })).not.toBe(key);
    expect(notificationIdempotencyKey({ ...logical, channel: "EMAIL" })).not.toBe(key);
  });

  it("uses unambiguous length-prefixed encoding", () => {
    expect(notificationIdempotencyKey({ ...logical, restaurantId: "a|b", reservationId: "c" }))
      .not.toBe(notificationIdempotencyKey({ ...logical, restaurantId: "a", reservationId: "b|c" }));
  });

  it("uses the approved 1/5/15 minute policy and stops after attempt four", () => {
    expect([1, 2, 3, 4].map(retryDelayAfterAttempt)).toEqual([60_000, 300_000, 900_000, null]);
    const now = new Date("2028-01-01T00:00:00.000Z");
    expect(terminalFailureForTransient({ attemptNumber: 4, maxAttempts: 4, now, expiresAt: new Date("2028-01-02T00:00:00.000Z") })).toBe("RETRY_EXHAUSTED");
    expect(terminalFailureForTransient({ attemptNumber: 1, maxAttempts: 4, now: new Date("2028-01-02T00:00:00.000Z"), expiresAt: new Date("2028-01-02T00:00:00.000Z") })).toBe("EXPIRED");
    expect(nextRetryAt({ attemptNumber: 1, completedAt: now, expiresAt: new Date(now.getTime() + 60_000) })).toBeNull();
  });

  it("allows only the approved transitions", () => {
    expect(canTransitionNotification("PENDING", "CLAIMED")).toBe(true);
    expect(canTransitionNotification("PENDING", "CANCELLED")).toBe(true);
    expect(canTransitionNotification("CLAIMED", "PENDING")).toBe(true);
    expect(canTransitionNotification("CLAIMED", "SUCCEEDED")).toBe(true);
    expect(canTransitionNotification("CLAIMED", "DEAD")).toBe(true);
    expect(canTransitionNotification("CLAIMED", "CANCELLED")).toBe(true);
    expect(canTransitionNotification("SUCCEEDED", "PENDING")).toBe(false);
    expect(canTransitionNotification("DEAD", "CLAIMED")).toBe(false);
  });
});
