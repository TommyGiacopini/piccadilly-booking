import { describe, expect, it } from "vitest";

import {
  bookingSettingsUpdateSchema,
  diningTableUpdateSchema,
  specialDateInputSchema,
  weeklyScheduleUpdateSchema,
} from "@/modules/configuration/domain/validation";

const scheduleId = "11111111-1111-4111-8111-111111111111";

function validScheduleInput() {
  return {
    id: scheduleId,
    dayOfWeek: "MONDAY",
    serviceType: "LUNCH",
    isEnabled: "true",
    startTime: "12:00",
    endTime: "14:00",
    slotIntervalMinutes: "15",
  };
}

function validSettingsInput() {
  return {
    rollingCapacityCovers: "30",
    rollingWindowMinutes: "30",
    lunchModificationCutoff: "10:30",
    dinnerModificationCutoff: "17:30",
    managementLinkDurationHours: "24",
  };
}

function validSpecialDateInput() {
  return {
    date: "2026-12-24",
    scope: "ALL",
    isClosed: undefined,
    specialStartTime: "",
    specialEndTime: "",
    specialCapacityCovers: "",
    operationalNotes: "Configurazione dimostrativa",
  };
}

describe("operational configuration validation", () => {
  it("accepts a weekly schedule with a positive slot", () => {
    expect(weeklyScheduleUpdateSchema.safeParse(validScheduleInput()).success).toBe(
      true,
    );
  });

  it("requires startTime to precede endTime", () => {
    expect(
      weeklyScheduleUpdateSchema.safeParse({
        ...validScheduleInput(),
        startTime: "14:00",
        endTime: "14:00",
      }).success,
    ).toBe(false);
  });

  it("rejects zero or negative slot intervals", () => {
    expect(
      weeklyScheduleUpdateSchema.safeParse({
        ...validScheduleInput(),
        slotIntervalMinutes: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects every slot interval other than the fixed 15 minutes", () => {
    expect(
      weeklyScheduleUpdateSchema.safeParse({
        ...validScheduleInput(),
        slotIntervalMinutes: "30",
      }).success,
    ).toBe(false);
  });

  it("requires a positive rolling capacity and the fixed V1 window", () => {
    expect(
      bookingSettingsUpdateSchema.safeParse({
        ...validSettingsInput(),
        rollingCapacityCovers: "0",
      }).success,
    ).toBe(false);
    expect(
      bookingSettingsUpdateSchema.safeParse({
        ...validSettingsInput(),
        rollingWindowMinutes: "15",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed cut-offs", () => {
    expect(
      bookingSettingsUpdateSchema.safeParse({
        ...validSettingsInput(),
        lunchModificationCutoff: "25:30",
      }).success,
    ).toBe(false);
  });

  it("rejects legacy cutoff fields and arbitrary client fields", () => {
    expect(
      bookingSettingsUpdateSchema.safeParse({
        ...validSettingsInput(),
        fridayDinnerBookingCutoff: "17:30",
      }).success,
    ).toBe(false);
  });

  it("validates table capacity and seat ordering", () => {
    expect(
      diningTableUpdateSchema.safeParse({
        id: scheduleId,
        name: "DEMO-01",
        minimumSeats: "4",
        maximumSeats: "2",
        displayOrder: "1",
        isActive: "true",
      }).success,
    ).toBe(false);
  });

  it.each(["ALL", "LUNCH", "DINNER"])(
    "accepts a complete, lunch-only or dinner-only special date (%s)",
    (scope) => {
      expect(
        specialDateInputSchema.safeParse({
          ...validSpecialDateInput(),
          scope,
          isClosed: "true",
          operationalNotes: "Chiusura demo",
        }).success,
      ).toBe(true);
    },
  );

  it("accepts special hours and a positive special capacity", () => {
    expect(
      specialDateInputSchema.safeParse({
        ...validSpecialDateInput(),
        scope: "DINNER",
        specialStartTime: "20:00",
        specialEndTime: "23:00",
        specialCapacityCovers: "24",
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete, inverted, or non-positive special values", () => {
    expect(
      specialDateInputSchema.safeParse({
        ...validSpecialDateInput(),
        specialStartTime: "20:00",
      }).success,
    ).toBe(false);
    expect(
      specialDateInputSchema.safeParse({
        ...validSpecialDateInput(),
        specialStartTime: "23:00",
        specialEndTime: "20:00",
      }).success,
    ).toBe(false);
    expect(
      specialDateInputSchema.safeParse({
        ...validSpecialDateInput(),
        specialCapacityCovers: "0",
      }).success,
    ).toBe(false);
  });

  it("keeps the local calendar date stable without a timezone day shift", () => {
    expect(
      specialDateInputSchema.safeParse({
        ...validSpecialDateInput(),
        date: "2026-02-30",
      }).success,
    ).toBe(false);
  });
});
