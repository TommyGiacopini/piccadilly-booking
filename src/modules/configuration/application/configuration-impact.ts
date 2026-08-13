import { getLocalDayOfWeek } from "@/modules/availability/domain/local-calendar";
import { generateInclusiveSlots } from "@/modules/availability/domain/slot-generation";
import {
  operationalTimeToMinutes,
} from "@/modules/configuration/domain/operational-time";
import type {
  ConfigurationImpactDto,
  ConfigurationImpactItem,
  OperationalChangeProposal,
} from "@/modules/configuration/domain/operational-change";

export interface ImpactReservation {
  id: string;
  status: "CONFIRMED" | "CANCELLED";
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  origin: "PUBLIC" | "PHONE" | "STAFF";
}

export interface ImpactSchedule {
  id: string;
  dayOfWeek:
    | "MONDAY"
    | "TUESDAY"
    | "WEDNESDAY"
    | "THURSDAY"
    | "FRIDAY"
    | "SATURDAY"
    | "SUNDAY";
  serviceType: "LUNCH" | "DINNER";
  isEnabled: boolean;
  startTime: string;
  endTime: string;
  slotIntervalMinutes: number;
  updatedAt: string;
}

export interface ImpactSpecialDate {
  id: string;
  localDate: string;
  scope: "ALL" | "LUNCH" | "DINNER";
  isClosed: boolean;
  specialStartTime: string | null;
  specialEndTime: string | null;
  specialCapacityCovers: number | null;
  updatedAt: string;
}

export interface ImpactContext {
  settings: {
    rollingCapacityCovers: number;
    rollingWindowMinutes: number;
    lunchModificationCutoff: string;
    dinnerModificationCutoff: string;
    updatedAt: string;
  };
  schedules: ImpactSchedule[];
  specialDates: ImpactSpecialDate[];
  reservations: ImpactReservation[];
}

export interface CalculatedImpact {
  dto: ConfigurationImpactDto;
  impactedReservations: Map<string, number>;
}

function activeOverride(
  context: ImpactContext,
  reservation: Pick<ImpactReservation, "localDate" | "serviceType">,
): ImpactSpecialDate | null {
  return (
    context.specialDates.find(
      (override) =>
        override.localDate === reservation.localDate &&
        override.scope === reservation.serviceType,
    ) ??
    context.specialDates.find(
      (override) =>
        override.localDate === reservation.localDate &&
        override.scope === "ALL",
    ) ??
    null
  );
}

function weeklySchedule(
  context: ImpactContext,
  localDate: string,
  serviceType: "LUNCH" | "DINNER",
): ImpactSchedule | null {
  const dayOfWeek = getLocalDayOfWeek(localDate);
  return (
    context.schedules.find(
      (schedule) =>
        schedule.dayOfWeek === dayOfWeek &&
        schedule.serviceType === serviceType,
    ) ?? null
  );
}

function addGroupedItem(
  groups: Map<
    string,
    { item: ConfigurationImpactItem; reservations: Map<string, number> }
  >,
  input: {
    classification: ConfigurationImpactItem["classification"];
    reservation: ImpactReservation;
    slot?: string | null;
    previousLimit?: number | null;
    proposedLimit?: number | null;
    maxLoad?: number | null;
  },
): void {
  const key = [
    input.classification,
    input.reservation.localDate,
    input.reservation.serviceType,
    input.slot ?? "",
    input.previousLimit ?? "",
    input.proposedLimit ?? "",
    input.maxLoad ?? "",
  ].join("|");
  let group = groups.get(key);

  if (!group) {
    group = {
      item: {
        reservationCount: 0,
        covers: 0,
        classification: input.classification,
        localDate: input.reservation.localDate,
        serviceType: input.reservation.serviceType,
        slot: input.slot ?? null,
        previousLimit: input.previousLimit ?? null,
        proposedLimit: input.proposedLimit ?? null,
        maxLoad: input.maxLoad ?? null,
      },
      reservations: new Map(),
    };
    groups.set(key, group);
  }

  group.reservations.set(input.reservation.id, input.reservation.partySize);
  group.item.reservationCount = group.reservations.size;
  group.item.covers = [...group.reservations.values()].reduce(
    (sum, covers) => sum + covers,
    0,
  );
}

function calculateWeeklyImpact(
  proposal: Extract<OperationalChangeProposal, { kind: "WEEKLY_SCHEDULE" }>,
  context: ImpactContext,
  groups: Parameters<typeof addGroupedItem>[0],
): void {
  const current = context.schedules.find(
    (schedule) =>
      schedule.id === proposal.id &&
      schedule.dayOfWeek === proposal.dayOfWeek &&
      schedule.serviceType === proposal.serviceType,
  );
  if (!current) return;

  for (const reservation of context.reservations) {
    if (
      reservation.serviceType !== proposal.serviceType ||
      getLocalDayOfWeek(reservation.localDate) !== proposal.dayOfWeek
    ) {
      continue;
    }

    const override = activeOverride(context, reservation);
    const currentOpen = override ? !override.isClosed : current.isEnabled;
    const proposedOpen = override ? !override.isClosed : proposal.isEnabled;

    if (currentOpen && !proposedOpen) {
      addGroupedItem(groups, {
        classification: "SERVICE_DISABLED",
        reservation,
      });
      continue;
    }

    if (!proposedOpen) continue;

    const currentStart = override?.specialStartTime ?? current.startTime;
    const currentEnd = override?.specialEndTime ?? current.endTime;
    const proposedStart = override?.specialStartTime ?? proposal.startTime;
    const proposedEnd = override?.specialEndTime ?? proposal.endTime;
    const wasInsideCurrent =
      reservation.arrivalTime >= currentStart &&
      reservation.arrivalTime <= currentEnd;
    const isOutsideProposed =
      reservation.arrivalTime < proposedStart ||
      reservation.arrivalTime > proposedEnd;

    if (wasInsideCurrent && isOutsideProposed) {
      addGroupedItem(groups, {
        classification: "OUTSIDE_NEW_HOURS",
        reservation,
        slot: reservation.arrivalTime,
      });
    }
  }
}

function calculateCapacityImpact(
  proposal: Extract<OperationalChangeProposal, { kind: "BOOKING_SETTINGS" }>,
  context: ImpactContext,
  groups: Parameters<typeof addGroupedItem>[0],
): void {
  if (
    proposal.rollingCapacityCovers >= context.settings.rollingCapacityCovers
  ) {
    return;
  }

  const byService = new Map<string, ImpactReservation[]>();
  for (const reservation of context.reservations) {
    const key = `${reservation.localDate}|${reservation.serviceType}`;
    byService.set(key, [...(byService.get(key) ?? []), reservation]);
  }

  for (const reservations of byService.values()) {
    const first = reservations[0];
    const override = activeOverride(context, first);
    if (
      override?.isClosed ||
      (override && override.specialCapacityCovers !== null)
    ) {
      continue;
    }

    const schedule = weeklySchedule(
      context,
      first.localDate,
      first.serviceType,
    );
    if (!schedule) continue;

    const startTime = override?.specialStartTime ?? schedule.startTime;
    const endTime = override?.specialEndTime ?? schedule.endTime;
    let slots: string[];
    try {
      slots = generateInclusiveSlots(startTime, endTime, 15);
    } catch {
      continue;
    }

    for (const slot of slots) {
      const windowStart = operationalTimeToMinutes(slot);
      const included = reservations.filter((reservation) => {
        const arrival = operationalTimeToMinutes(reservation.arrivalTime);
        return arrival >= windowStart && arrival < windowStart + 30;
      });
      const load = included.reduce(
        (sum, reservation) => sum + reservation.partySize,
        0,
      );

      if (load <= proposal.rollingCapacityCovers) continue;
      for (const reservation of included) {
        addGroupedItem(groups, {
          classification: "CAPACITY_EXCEEDED",
          reservation,
          slot,
          previousLimit: context.settings.rollingCapacityCovers,
          proposedLimit: proposal.rollingCapacityCovers,
          maxLoad: load,
        });
      }
    }
  }
}

function calculateModificationCutoffImpact(
  proposal: Extract<OperationalChangeProposal, { kind: "BOOKING_SETTINGS" }>,
  context: ImpactContext,
  groups: Parameters<typeof addGroupedItem>[0],
): void {
  const lunchChanged =
    proposal.lunchModificationCutoff !==
    context.settings.lunchModificationCutoff;
  const dinnerChanged =
    proposal.dinnerModificationCutoff !==
    context.settings.dinnerModificationCutoff;

  for (const reservation of context.reservations) {
    if (reservation.origin !== "PUBLIC") continue;
    if (
      (reservation.serviceType === "LUNCH" && !lunchChanged) ||
      (reservation.serviceType === "DINNER" && !dinnerChanged)
    ) {
      continue;
    }

    addGroupedItem(groups, {
      classification: "MODIFICATION_CUTOFF_CHANGED",
      reservation,
    });
  }
}

export function calculateConfigurationImpact(
  proposal: OperationalChangeProposal,
  context: ImpactContext,
): CalculatedImpact {
  const groups = new Map<
    string,
    { item: ConfigurationImpactItem; reservations: Map<string, number> }
  >();

  if (proposal.kind === "WEEKLY_SCHEDULE") {
    calculateWeeklyImpact(proposal, context, groups);
  } else if (proposal.kind === "BOOKING_SETTINGS") {
    calculateCapacityImpact(proposal, context, groups);
    calculateModificationCutoffImpact(proposal, context, groups);
  }

  const impactedReservations = new Map<string, number>();
  for (const group of groups.values()) {
    for (const [id, covers] of group.reservations) {
      impactedReservations.set(id, covers);
    }
  }

  const items = [...groups.values()].map((group) => group.item);
  if (items.length === 0) {
    items.push({
      reservationCount: 0,
      covers: 0,
      classification: "NO_EXISTING_RESERVATION_IMPACT",
      localDate: null,
      serviceType:
        proposal.kind === "BOOKING_SETTINGS" ? null : proposal.serviceType,
      slot: null,
      previousLimit: null,
      proposedLimit: null,
      maxLoad: null,
    });
  }

  return {
    dto: {
      reservationCount: impactedReservations.size,
      covers: [...impactedReservations.values()].reduce(
        (sum, covers) => sum + covers,
        0,
      ),
      items,
    },
    impactedReservations,
  };
}
