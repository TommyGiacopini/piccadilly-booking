import { describe, expect, it } from "vitest";

import { calculateAvailability } from "@/modules/availability/domain/availability-engine";
import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import { evaluateRollingCapacity } from "@/modules/availability/domain/rolling-capacity";
import { generateInclusiveSlots } from "@/modules/availability/domain/slot-generation";
import type {
  AvailabilityConfigurationInput,
  AvailabilityEngineInput,
  AvailabilityServiceType,
  CapacityArrival,
  SpecialDateAvailabilityRule,
} from "@/modules/availability/domain/types";

const futureNow = new Date("2026-08-01T10:00:00.000Z");

function configuration(
  serviceType: AvailabilityServiceType = "DINNER",
  overrides: {
    timezone?: string;
    settings?: Partial<NonNullable<AvailabilityConfigurationInput["settings"]>> | null;
    weeklyRule?: Partial<NonNullable<AvailabilityConfigurationInput["weeklyRule"]>> | null;
    allDateOverride?: SpecialDateAvailabilityRule | null;
    serviceDateOverride?: SpecialDateAvailabilityRule | null;
  } = {},
): AvailabilityConfigurationInput {
  const serviceTimes =
    serviceType === "LUNCH"
      ? { startTime: "12:00", endTime: "14:00" }
      : { startTime: "19:00", endTime: "22:15" };
  const settings =
    overrides.settings === null
      ? null
      : {
          rollingCapacityCovers: 30,
          rollingWindowMinutes: 30,
          fridayDinnerBookingCutoff: "17:30",
          saturdayDinnerBookingCutoff: "17:30",
          ...overrides.settings,
        };
  const weeklyRule =
    overrides.weeklyRule === null
      ? null
      : {
          serviceType,
          isEnabled: true,
          ...serviceTimes,
          slotIntervalMinutes: 15,
          ...overrides.weeklyRule,
        };

  return {
    timezone: overrides.timezone ?? "Europe/Rome",
    settings,
    weeklyRule,
    allDateOverride: overrides.allDateOverride ?? null,
    serviceDateOverride: overrides.serviceDateOverride ?? null,
  };
}

function engineInput(
  overrides: Partial<AvailabilityEngineInput> = {},
): AvailabilityEngineInput {
  const serviceType = overrides.serviceType ?? "DINNER";

  return {
    date: "2026-08-10",
    serviceType,
    partySize: 2,
    now: futureNow,
    channel: "PUBLIC",
    arrivals: [],
    configuration: configuration(serviceType),
    ...overrides,
  };
}

function openOverride(
  scope: "ALL" | AvailabilityServiceType,
  overrides: Partial<SpecialDateAvailabilityRule> = {},
): SpecialDateAvailabilityRule {
  return {
    scope,
    isClosed: false,
    specialStartTime: null,
    specialEndTime: null,
    specialCapacityCovers: null,
    ...overrides,
  };
}

function closedOverride(
  scope: "ALL" | AvailabilityServiceType,
): SpecialDateAvailabilityRule {
  return {
    scope,
    isClosed: true,
    specialStartTime: null,
    specialEndTime: null,
    specialCapacityCovers: null,
  };
}

function slotAt(
  result: ReturnType<typeof calculateAvailability>,
  time: string,
) {
  return result.slots.find((slot) => slot.time === time);
}

describe("inclusive slot generation", () => {
  it("generates LUNCH from 12:00 through 14:00 inclusive", () => {
    const slots = generateInclusiveSlots("12:00", "14:00", 15);

    expect(slots).toHaveLength(9);
    expect(slots[0]).toBe("12:00");
    expect(slots.at(-1)).toBe("14:00");
  });

  it("generates DINNER from 19:00 through 22:15 inclusive", () => {
    const slots = generateInclusiveSlots("19:00", "22:15", 15);

    expect(slots).toHaveLength(14);
    expect(slots[0]).toBe("19:00");
    expect(slots.at(-1)).toBe("22:15");
  });

  it("supports an interval other than 15 minutes", () => {
    expect(generateInclusiveSlots("12:00", "14:00", 30)).toEqual([
      "12:00",
      "12:30",
      "13:00",
      "13:30",
      "14:00",
    ]);
  });

  it("rejects incoherent ranges without looping", () => {
    expect(() => generateInclusiveSlots("12:00", "14:00", 17)).toThrow();
    expect(() => generateInclusiveSlots("14:00", "12:00", 15)).toThrow();
    expect(() => generateInclusiveSlots("12:00", "14:00", 0)).toThrow();
  });
});

describe("effective service configuration", () => {
  it("closes a disabled weekly service", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          weeklyRule: { isEnabled: false },
        }),
      }),
    );

    expect(result).toMatchObject({
      source: "WEEKLY",
      isOpen: false,
      reason: "SERVICE_CLOSED",
      slots: [],
    });
  });

  it("applies an ALL closure", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          allDateOverride: closedOverride("ALL"),
        }),
      }),
    );

    expect(result).toMatchObject({
      source: "SPECIAL_DATE_ALL",
      isOpen: false,
      reason: "SERVICE_CLOSED",
    });
  });

  it("applies a LUNCH-only closure", () => {
    const result = calculateAvailability(
      engineInput({
        serviceType: "LUNCH",
        configuration: configuration("LUNCH", {
          serviceDateOverride: closedOverride("LUNCH"),
        }),
      }),
    );

    expect(result).toMatchObject({
      serviceType: "LUNCH",
      source: "SPECIAL_DATE_SERVICE",
      isOpen: false,
    });
  });

  it("applies a DINNER-only closure", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          serviceDateOverride: closedOverride("DINNER"),
        }),
      }),
    );

    expect(result).toMatchObject({
      serviceType: "DINNER",
      source: "SPECIAL_DATE_SERVICE",
      isOpen: false,
    });
  });

  it("lets a service-specific opening take precedence over ALL closure", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          allDateOverride: closedOverride("ALL"),
          serviceDateOverride: openOverride("DINNER"),
        }),
      }),
    );

    expect(result).toMatchObject({
      source: "SPECIAL_DATE_SERVICE",
      isOpen: true,
    });
    expect(result.slots).toHaveLength(14);
  });

  it("opens an extraordinary service over a disabled weekly rule", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          weeklyRule: { isEnabled: false },
          serviceDateOverride: openOverride("DINNER"),
        }),
      }),
    );

    expect(result.isOpen).toBe(true);
    expect(result.slots[0]?.time).toBe("19:00");
  });

  it("uses special opening times", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          serviceDateOverride: openOverride("DINNER", {
            specialStartTime: "20:00",
            specialEndTime: "21:00",
          }),
        }),
      }),
    );

    expect(result.slots.map((slot) => slot.time)).toEqual([
      "20:00",
      "20:15",
      "20:30",
      "20:45",
      "21:00",
    ]);
  });

  it("uses a special capacity", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          serviceDateOverride: openOverride("DINNER", {
            specialCapacityCovers: 18,
          }),
        }),
      }),
    );

    expect(result.capacityLimit).toBe(18);
    expect(result.slots[0]?.remainingCapacity).toBe(18);
  });

  it("inherits missing special values from weekly rules and restaurant settings", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          settings: { rollingCapacityCovers: 27 },
          serviceDateOverride: openOverride("DINNER"),
        }),
      }),
    );

    expect(result).toMatchObject({
      source: "SPECIAL_DATE_SERVICE",
      capacityLimit: 27,
      slotIntervalMinutes: 15,
    });
    expect(result.slots.at(-1)?.time).toBe("22:15");
  });

  it("returns a controlled configuration failure for incoherent data", () => {
    const result = calculateAvailability(
      engineInput({
        configuration: configuration("DINNER", {
          weeklyRule: { endTime: "22:10" },
        }),
      }),
    );

    expect(result).toMatchObject({
      isOpen: false,
      reason: "CONFIGURATION_INVALID",
      slots: [],
    });
  });
});

describe("local dates, Europe/Rome and injected clock", () => {
  it("preserves the requested local date without UTC date shifting", () => {
    const result = calculateAvailability(
      engineInput({
        date: "2026-08-10",
        now: new Date("2026-08-09T22:30:00.000Z"),
      }),
    );

    expect(result.date).toBe("2026-08-10");
    expect(result.timezone).toBe("Europe/Rome");
  });

  it("uses Europe/Rome rather than the operating-system timezone", () => {
    expect(
      getZonedDateTimeParts(
        new Date("2026-01-15T11:00:00.000Z"),
        "Europe/Rome",
      ),
    ).toMatchObject({ date: "2026-01-15", time: "12:00" });
  });

  it("handles the spring daylight-saving transition", () => {
    expect(
      getZonedDateTimeParts(
        new Date("2026-03-29T00:59:00.000Z"),
        "Europe/Rome",
      ),
    ).toMatchObject({ date: "2026-03-29", time: "01:59" });
    expect(
      getZonedDateTimeParts(
        new Date("2026-03-29T01:00:00.000Z"),
        "Europe/Rome",
      ),
    ).toMatchObject({ date: "2026-03-29", time: "03:00" });
  });

  it("handles both occurrences of the autumn daylight-saving hour", () => {
    const first = getZonedDateTimeParts(
      new Date("2026-10-25T00:30:00.000Z"),
      "Europe/Rome",
    );
    const second = getZonedDateTimeParts(
      new Date("2026-10-25T01:30:00.000Z"),
      "Europe/Rome",
    );

    expect(first).toMatchObject({ date: "2026-10-25", time: "02:30" });
    expect(second).toMatchObject({ date: "2026-10-25", time: "02:30" });
  });

  it("marks a current or past slot unavailable and a later slot available", () => {
    const result = calculateAvailability(
      engineInput({
        date: "2026-08-03",
        serviceType: "LUNCH",
        configuration: configuration("LUNCH"),
        now: new Date("2026-08-03T10:30:00.000Z"),
      }),
    );

    expect(slotAt(result, "12:30")).toMatchObject({
      available: false,
      reason: "SLOT_IN_PAST",
    });
    expect(slotAt(result, "12:45")).toMatchObject({ available: true });
  });

  it("is deterministic when the same clock is injected", () => {
    const input = engineInput({
      date: "2026-08-03",
      serviceType: "LUNCH",
      configuration: configuration("LUNCH"),
      now: new Date("2026-08-03T09:15:00.000Z"),
    });

    expect(calculateAvailability(input)).toEqual(calculateAvailability(input));
  });
});

describe("PUBLIC weekend cutoff and STAFF behavior", () => {
  function weekendResult(input: {
    date: string;
    instant: string;
    channel?: "PUBLIC" | "STAFF";
    serviceType?: AvailabilityServiceType;
  }) {
    const serviceType = input.serviceType ?? "DINNER";

    return calculateAvailability(
      engineInput({
        date: input.date,
        serviceType,
        channel: input.channel ?? "PUBLIC",
        configuration: configuration(serviceType),
        now: new Date(input.instant),
      }),
    );
  }

  it("keeps Friday dinner open at 17:29 local", () => {
    const result = weekendResult({
      date: "2026-08-07",
      instant: "2026-08-07T15:29:00.000Z",
    });

    expect(slotAt(result, "19:00")).toMatchObject({ available: true });
  });

  it("closes PUBLIC Friday dinner at 17:30 local", () => {
    const result = weekendResult({
      date: "2026-08-07",
      instant: "2026-08-07T15:30:00.000Z",
    });

    expect(slotAt(result, "19:00")).toMatchObject({
      available: false,
      reason: "ONLINE_CUTOFF_REACHED",
    });
  });

  it("keeps Saturday dinner open at 17:29 local", () => {
    const result = weekendResult({
      date: "2026-08-08",
      instant: "2026-08-08T15:29:00.000Z",
    });

    expect(slotAt(result, "19:00")?.available).toBe(true);
  });

  it("closes PUBLIC Saturday dinner at 17:30 local", () => {
    const result = weekendResult({
      date: "2026-08-08",
      instant: "2026-08-08T15:30:00.000Z",
    });

    expect(slotAt(result, "19:00")?.reason).toBe("ONLINE_CUTOFF_REACHED");
  });

  it("does not apply the weekend cutoff on Sunday", () => {
    const result = weekendResult({
      date: "2026-08-09",
      instant: "2026-08-09T15:30:00.000Z",
    });

    expect(slotAt(result, "19:00")?.available).toBe(true);
  });

  it("does not apply the online cutoff to STAFF", () => {
    const result = weekendResult({
      date: "2026-08-07",
      instant: "2026-08-07T15:30:00.000Z",
      channel: "STAFF",
    });

    expect(slotAt(result, "19:00")?.available).toBe(true);
  });

  it("does not apply the dinner cutoff to LUNCH", () => {
    const result = weekendResult({
      date: "2026-08-07",
      instant: "2026-08-07T08:00:00.000Z",
      serviceType: "LUNCH",
    });

    expect(slotAt(result, "12:00")?.available).toBe(true);
  });

  it("does not apply today's cutoff to a future Friday", () => {
    const result = weekendResult({
      date: "2026-08-14",
      instant: "2026-08-07T16:00:00.000Z",
    });

    expect(slotAt(result, "19:00")?.available).toBe(true);
  });
});

describe("party size validation", () => {
  it.each([0, -1, 1.5, Number.NaN])(
    "marks invalid numeric party size %s unavailable",
    (partySize) => {
      const result = calculateAvailability(engineInput({ partySize }));

      expect(result.slots.every((slot) => !slot.available)).toBe(true);
      expect(result.slots[0]?.reason).toBe("PARTY_SIZE_INVALID");
    },
  );

  it("rejects a non-numeric runtime value", () => {
    const result = calculateAvailability(
      engineInput({ partySize: "two" as unknown as number }),
    );

    expect(result.slots[0]?.reason).toBe("PARTY_SIZE_INVALID");
  });

  it("marks a party larger than the configured limit unavailable", () => {
    const result = calculateAvailability(engineInput({ partySize: 31 }));

    expect(result.slots[0]).toMatchObject({
      available: false,
      remainingCapacity: 30,
      reason: "CAPACITY_EXCEEDED",
    });
  });
});

describe("rolling capacity windows", () => {
  const slots = ["19:00", "19:15", "19:30", "19:45"];

  function arrival(
    arrivalTime: string,
    covers: number,
    countsTowardCapacity = true,
  ): CapacityArrival {
    return { arrivalTime, covers, countsTowardCapacity };
  }

  it("includes 19:00 and 19:15 in the 19:00 window", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 10), arrival("19:15", 5)],
      30,
      30,
      1,
    );

    expect(evaluation[0]?.remainingCapacity).toBe(15);
  });

  it("excludes 19:30 from the 19:00 window", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 10), arrival("19:15", 5), arrival("19:30", 7)],
      30,
      30,
      1,
    );

    expect(evaluation[0]?.remainingCapacity).toBe(15);
  });

  it("checks a 19:15 candidate against both 19:00 and 19:15 windows", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 20)],
      30,
      30,
      11,
    );

    expect(evaluation[1]).toMatchObject({
      time: "19:15",
      available: false,
      remainingCapacity: 10,
    });
  });

  it("accepts capacity exactly equal to the limit", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 20)],
      30,
      30,
      10,
    );

    expect(evaluation[1]?.available).toBe(true);
  });

  it("rejects a one-cover overflow", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 20)],
      30,
      30,
      11,
    );

    expect(evaluation[1]?.available).toBe(false);
  });

  it("uses the minimum remaining margin across affected windows", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 10), arrival("19:30", 18)],
      30,
      30,
      2,
    );

    expect(evaluation[1]?.remainingCapacity).toBe(12);
  });

  it("returns the full margin for an empty load", () => {
    const evaluation = evaluateRollingCapacity(slots, [], 30, 30, 2);

    expect(evaluation.every((slot) => slot.remainingCapacity === 30)).toBe(true);
  });

  it("excludes arrivals that do not count toward capacity", () => {
    const evaluation = evaluateRollingCapacity(
      slots,
      [arrival("19:00", 29, false)],
      30,
      30,
      2,
    );

    expect(evaluation[0]).toMatchObject({
      available: true,
      remainingCapacity: 30,
    });
  });

  it("keeps final output ordered without duplicates", () => {
    const result = calculateAvailability(engineInput());
    const times = result.slots.map((slot) => slot.time);

    expect(times).toEqual([...times].sort());
    expect(new Set(times).size).toBe(times.length);
  });
});
