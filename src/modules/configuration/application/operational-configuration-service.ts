import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  Prisma,
  type DayOfWeek,
  type ServiceType,
} from "@/generated/prisma/client";
import {
  getLocalDayOfWeek,
  getZonedDateTimeParts,
} from "@/modules/availability/domain/local-calendar";
import { auditStatesEqual } from "@/modules/audit/domain/audit-event";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import {
  calculateConfigurationImpact,
  type ImpactContext,
  type ImpactReservation,
  type ImpactSchedule,
  type ImpactSpecialDate,
} from "@/modules/configuration/application/configuration-impact";
import { ConfigurationError } from "@/modules/configuration/application/configuration-errors";
import {
  DEFAULT_SLOT_INTERVAL_MINUTES,
  FIXED_ROLLING_WINDOW_MINUTES,
} from "@/modules/configuration/domain/defaults";
import type {
  BookingCutoffRuleProposal,
  ConfigurationImpactDto,
  OperationalChangeProposal,
} from "@/modules/configuration/domain/operational-change";
import {
  operationalChangeConfirmationSchema,
  operationalChangeProposalSchema,
} from "@/modules/configuration/domain/operational-change";
import {
  localDateFromDatabase,
  operationalTimeFromDatabase,
} from "@/modules/configuration/domain/operational-time";
import {
  acquireOperationalConfigurationLock,
  applyOperationalProposal,
  readOperationalConfigurationContext,
  runOperationalConfigurationTransaction,
  type OperationalConfigurationClient,
} from "@/modules/configuration/infrastructure/operational-configuration-repository";

export interface OperationalConfigurationActor {
  id: string;
  restaurantId: string;
}

export interface OperationalConfigurationPreview {
  proposal: OperationalChangeProposal;
  fingerprint: string;
  changed: boolean;
  confirmationRequired: boolean;
  impact: ConfigurationImpactDto;
}

export class ConfigurationImpactChangedError extends ConfigurationError {
  constructor(readonly preview: OperationalConfigurationPreview) {
    super(
      "IMPACT_CHANGED",
      "La configurazione o le prenotazioni sono cambiate. Controlla la nuova anteprima e conferma di nuovo.",
    );
    this.name = "ConfigurationImpactChangedError";
  }
}

async function requireFreshAdmin(
  client: OperationalConfigurationClient,
  actor: OperationalConfigurationActor,
) {
  const current = await client.user.findFirst({
    where: {
      id: actor.id,
      restaurantId: actor.restaurantId,
      isActive: true,
      disabledAt: null,
      role: "ADMIN",
      mustChangePassword: false,
    },
    select: { id: true, restaurantId: true, role: true },
  });

  if (!current) {
    throw new ConfigurationError(
      "FORBIDDEN",
      "Solo un amministratore attivo può gestire la configurazione.",
    );
  }

  return current;
}

function parseProposal(input: unknown): OperationalChangeProposal {
  const parsed = operationalChangeProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigurationError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "La proposta non è valida.",
    );
  }
  return parsed.data;
}

function bookingSettingsSnapshot(settings: {
  rollingCapacityCovers: number;
  rollingWindowMinutes: number;
  lunchModificationCutoff: Date;
  dinnerModificationCutoff: Date;
}) {
  return {
    rollingCapacityCovers: settings.rollingCapacityCovers,
    rollingWindowMinutes: settings.rollingWindowMinutes,
    lunchModificationCutoff: operationalTimeFromDatabase(
      settings.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeFromDatabase(
      settings.dinnerModificationCutoff,
    ),
  };
}

function scheduleSnapshot(schedule: {
  dayOfWeek: DayOfWeek;
  serviceType: ServiceType;
  isEnabled: boolean;
  startTime: Date;
  endTime: Date;
  slotIntervalMinutes: number;
}) {
  return {
    dayOfWeek: schedule.dayOfWeek,
    serviceType: schedule.serviceType,
    isEnabled: schedule.isEnabled,
    startTime: operationalTimeFromDatabase(schedule.startTime),
    endTime: operationalTimeFromDatabase(schedule.endTime),
    slotIntervalMinutes: schedule.slotIntervalMinutes,
  };
}

function cutoffRuleSnapshot(rule: {
  dayOfWeek: DayOfWeek;
  serviceType: ServiceType;
  isEnabled: boolean;
  cutoffTime: Date;
}) {
  return {
    dayOfWeek: rule.dayOfWeek,
    serviceType: rule.serviceType,
    isEnabled: rule.isEnabled,
    cutoffTime: operationalTimeFromDatabase(rule.cutoffTime),
  };
}

function proposalSnapshot(
  proposal: OperationalChangeProposal,
): Record<string, string | number | boolean> {
  if (proposal.kind === "BOOKING_SETTINGS") {
    return {
      rollingCapacityCovers: proposal.rollingCapacityCovers,
      rollingWindowMinutes: FIXED_ROLLING_WINDOW_MINUTES,
      lunchModificationCutoff: proposal.lunchModificationCutoff,
      dinnerModificationCutoff: proposal.dinnerModificationCutoff,
    };
  }
  if (proposal.kind === "WEEKLY_SCHEDULE") {
    return {
      dayOfWeek: proposal.dayOfWeek,
      serviceType: proposal.serviceType,
      isEnabled: proposal.isEnabled,
      startTime: proposal.startTime,
      endTime: proposal.endTime,
      slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
    };
  }
  return {
    dayOfWeek: proposal.dayOfWeek,
    serviceType: proposal.serviceType,
    isEnabled: proposal.isEnabled,
    cutoffTime: proposal.cutoffTime,
  };
}

function findCurrentEntity(
  proposal: OperationalChangeProposal,
  context: Awaited<ReturnType<typeof readOperationalConfigurationContext>> & {},
) {
  if (proposal.kind === "BOOKING_SETTINGS") {
    return context.restaurant.bookingSettings;
  }
  if (proposal.kind === "WEEKLY_SCHEDULE") {
    return context.restaurant.weeklySchedules.find(
      (schedule) =>
        schedule.id === proposal.id &&
        schedule.dayOfWeek === proposal.dayOfWeek &&
        schedule.serviceType === proposal.serviceType,
    );
  }
  return context.restaurant.bookingCutoffRules.find(
    (rule) =>
      rule.dayOfWeek === proposal.dayOfWeek &&
      rule.serviceType === proposal.serviceType,
  );
}

function currentSnapshot(
  proposal: OperationalChangeProposal,
  context: NonNullable<
    Awaited<ReturnType<typeof readOperationalConfigurationContext>>
  >,
): Record<string, string | number | boolean> | null {
  const entity = findCurrentEntity(proposal, context);
  if (!entity) return null;
  if (proposal.kind === "BOOKING_SETTINGS") {
    return bookingSettingsSnapshot(
      entity as NonNullable<typeof context.restaurant.bookingSettings>,
    );
  }
  if (proposal.kind === "WEEKLY_SCHEDULE") {
    return scheduleSnapshot(
      entity as (typeof context.restaurant.weeklySchedules)[number],
    );
  }
  return cutoffRuleSnapshot(
    entity as (typeof context.restaurant.bookingCutoffRules)[number],
  );
}

function isChanged(
  proposal: OperationalChangeProposal,
  before: Record<string, string | number | boolean> | null,
): boolean {
  if (
    proposal.kind === "BOOKING_CUTOFF_RULE" &&
    before === null &&
    !proposal.isEnabled
  ) {
    return false;
  }
  return !auditStatesEqual(before, proposalSnapshot(proposal));
}

function mapImpactContext(
  raw: NonNullable<
    Awaited<ReturnType<typeof readOperationalConfigurationContext>>
  >,
  localNow: { date: string; time: string },
): ImpactContext {
  const settings = raw.restaurant.bookingSettings;
  if (!settings) {
    throw new ConfigurationError(
      "NOT_FOUND",
      "La configurazione operativa non è stata inizializzata.",
    );
  }
  if (
    settings.rollingWindowMinutes !== FIXED_ROLLING_WINDOW_MINUTES ||
    raw.restaurant.weeklySchedules.some(
      (schedule) =>
        schedule.slotIntervalMinutes !== DEFAULT_SLOT_INTERVAL_MINUTES,
    )
  ) {
    throw new ConfigurationError(
      "VALIDATION",
      "La configurazione non rispetta gli intervalli fissi della prima versione.",
    );
  }

  return {
    settings: {
      rollingCapacityCovers: settings.rollingCapacityCovers,
      rollingWindowMinutes: settings.rollingWindowMinutes,
      lunchModificationCutoff: operationalTimeFromDatabase(
        settings.lunchModificationCutoff,
      ),
      dinnerModificationCutoff: operationalTimeFromDatabase(
        settings.dinnerModificationCutoff,
      ),
      updatedAt: settings.updatedAt.toISOString(),
    },
    schedules: raw.restaurant.weeklySchedules.map((schedule) => ({
      id: schedule.id,
      dayOfWeek: schedule.dayOfWeek,
      serviceType: schedule.serviceType,
      isEnabled: schedule.isEnabled,
      startTime: operationalTimeFromDatabase(schedule.startTime),
      endTime: operationalTimeFromDatabase(schedule.endTime),
      slotIntervalMinutes: schedule.slotIntervalMinutes,
      updatedAt: schedule.updatedAt.toISOString(),
    })),
    specialDates: raw.specialDateOverrides.map((override) => ({
      id: override.id,
      localDate: localDateFromDatabase(override.date),
      scope: override.scope,
      isClosed: override.isClosed,
      specialStartTime: override.specialStartTime
        ? operationalTimeFromDatabase(override.specialStartTime)
        : null,
      specialEndTime: override.specialEndTime
        ? operationalTimeFromDatabase(override.specialEndTime)
        : null,
      specialCapacityCovers: override.specialCapacityCovers,
      updatedAt: override.updatedAt.toISOString(),
    })),
    reservations: raw.reservations
      .map((reservation) => ({
        id: reservation.id,
        status: reservation.status,
        localDate: localDateFromDatabase(reservation.localDate),
        serviceType: reservation.serviceType,
        arrivalTime: operationalTimeFromDatabase(reservation.arrivalTime),
        partySize: reservation.partySize,
        origin: reservation.origin,
      }))
      .filter(
        (reservation) =>
          reservation.localDate > localNow.date ||
          (reservation.localDate === localNow.date &&
            reservation.arrivalTime > localNow.time),
      ),
  };
}

function activeFingerprintOverride(
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

function fingerprintReservation(reservation: ImpactReservation) {
  return {
    id: reservation.id,
    status: reservation.status,
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    origin: reservation.origin,
  };
}

function fingerprintSchedule(schedule: ImpactSchedule) {
  return {
    dayOfWeek: schedule.dayOfWeek,
    serviceType: schedule.serviceType,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
  };
}

function fingerprintCapacityOverride(override: ImpactSpecialDate) {
  return {
    localDate: override.localDate,
    scope: override.scope,
    isClosed: override.isClosed,
    specialStartTime: override.specialStartTime,
    specialEndTime: override.specialEndTime,
    specialCapacityCovers: override.specialCapacityCovers,
  };
}

function uniqueByKey<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function fingerprintDependencies(
  proposal: OperationalChangeProposal,
  context: ImpactContext,
) {
  if (proposal.kind === "BOOKING_CUTOFF_RULE") {
    return { reservations: [], schedules: [], specialDates: [] };
  }

  if (proposal.kind === "WEEKLY_SCHEDULE") {
    const candidates = context.reservations.filter(
      (reservation) =>
        reservation.serviceType === proposal.serviceType &&
        getLocalDayOfWeek(reservation.localDate) === proposal.dayOfWeek,
    );
    const overrides = uniqueByKey(
      candidates
        .map((reservation) => activeFingerprintOverride(context, reservation))
        .filter((override): override is ImpactSpecialDate => override !== null),
      (override) => `${override.localDate}|${override.scope}`,
    );

    return {
      reservations: candidates
        .filter(
          (reservation) =>
            activeFingerprintOverride(context, reservation) === null,
        )
        .map(fingerprintReservation),
      schedules: [],
      specialDates: overrides.map((override) => ({
        localDate: override.localDate,
        scope: override.scope,
      })),
    };
  }

  const capacityDecreased =
    proposal.rollingCapacityCovers < context.settings.rollingCapacityCovers;
  const lunchCutoffChanged =
    proposal.lunchModificationCutoff !==
    context.settings.lunchModificationCutoff;
  const dinnerCutoffChanged =
    proposal.dinnerModificationCutoff !==
    context.settings.dinnerModificationCutoff;
  const relevantReservations = new Map<string, ImpactReservation>();
  const relevantSchedules: ImpactSchedule[] = [];
  const relevantOverrides: ImpactSpecialDate[] = [];

  for (const reservation of context.reservations) {
    if (
      reservation.origin === "PUBLIC" &&
      ((reservation.serviceType === "LUNCH" && lunchCutoffChanged) ||
        (reservation.serviceType === "DINNER" && dinnerCutoffChanged))
    ) {
      relevantReservations.set(reservation.id, reservation);
    }
  }

  if (capacityDecreased) {
    const byService = new Map<string, ImpactReservation[]>();
    for (const reservation of context.reservations) {
      const key = `${reservation.localDate}|${reservation.serviceType}`;
      byService.set(key, [...(byService.get(key) ?? []), reservation]);
    }

    for (const reservations of byService.values()) {
      const first = reservations[0];
      if (!first) continue;
      const override = activeFingerprintOverride(context, first);
      if (override) relevantOverrides.push(override);
      if (
        override?.isClosed ||
        (override && override.specialCapacityCovers !== null)
      ) {
        continue;
      }

      const dayOfWeek = getLocalDayOfWeek(first.localDate);
      const schedule = context.schedules.find(
        (candidate) =>
          candidate.dayOfWeek === dayOfWeek &&
          candidate.serviceType === first.serviceType,
      );
      if (!schedule) continue;

      relevantSchedules.push(schedule);
      for (const reservation of reservations) {
        relevantReservations.set(reservation.id, reservation);
      }
    }
  }

  return {
    reservations: [...relevantReservations.values()].map(
      fingerprintReservation,
    ),
    schedules: uniqueByKey(
      relevantSchedules,
      (schedule) => `${schedule.dayOfWeek}|${schedule.serviceType}`,
    ).map(fingerprintSchedule),
    specialDates: uniqueByKey(
      relevantOverrides,
      (override) => `${override.localDate}|${override.scope}`,
    ).map(fingerprintCapacityOverride),
  };
}

function fingerprint(input: {
  proposal: OperationalChangeProposal;
  current: Record<string, string | number | boolean> | null;
  dependencies: ReturnType<typeof fingerprintDependencies>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

async function calculatePreview(
  client: OperationalConfigurationClient,
  actor: OperationalConfigurationActor,
  proposal: OperationalChangeProposal,
  now: Date,
): Promise<OperationalConfigurationPreview> {
  const restaurant = await client.restaurant.findUnique({
    where: { id: actor.restaurantId },
    select: { timezone: true },
  });
  if (!restaurant) {
    throw new ConfigurationError("NOT_FOUND", "Ristorante non disponibile.");
  }
  const localNow = getZonedDateTimeParts(now, restaurant.timezone);
  const raw = await readOperationalConfigurationContext(
    client,
    actor.restaurantId,
    localNow.date,
  );
  if (!raw) {
    throw new ConfigurationError("NOT_FOUND", "Ristorante non disponibile.");
  }
  const before = currentSnapshot(proposal, raw);
  if (
    proposal.kind !== "BOOKING_CUTOFF_RULE" &&
    before === null
  ) {
    throw new ConfigurationError(
      "NOT_FOUND",
      "La configurazione richiesta non appartiene al ristorante.",
    );
  }
  const context = mapImpactContext(raw, localNow);
  const impact = calculateConfigurationImpact(proposal, context);
  const changed = isChanged(proposal, before);

  return {
    proposal,
    fingerprint: fingerprint({
      proposal,
      current: before,
      dependencies: fingerprintDependencies(proposal, context),
    }),
    changed,
    confirmationRequired: changed && impact.dto.reservationCount > 0,
    impact: impact.dto,
  };
}

export async function getImpactAwareOperationalConfiguration(
  actor: OperationalConfigurationActor,
) {
  return runOperationalConfigurationTransaction(async (client) => {
    await requireFreshAdmin(client, actor);
    const restaurant = await client.restaurant.findUnique({
      where: { id: actor.restaurantId },
      select: {
        id: true,
        name: true,
        timezone: true,
        bookingSettings: true,
        weeklySchedules: true,
        bookingCutoffRules: true,
      },
    });
    if (!restaurant || !restaurant.bookingSettings) {
      throw new ConfigurationError(
        "NOT_FOUND",
        "La configurazione operativa non è stata inizializzata.",
      );
    }

    return {
      id: restaurant.id,
      name: restaurant.name,
      timezone: restaurant.timezone,
      settings: {
        ...bookingSettingsSnapshot(restaurant.bookingSettings),
        managementLinkDurationHours:
          restaurant.bookingSettings.managementLinkDurationHours,
      },
      weeklySchedules: restaurant.weeklySchedules.map((schedule) => ({
        id: schedule.id,
        ...scheduleSnapshot(schedule),
      })),
      bookingCutoffRules: restaurant.bookingCutoffRules.map((rule) => ({
        id: rule.id,
        ...cutoffRuleSnapshot(rule),
      })),
    };
  });
}

export async function previewOperationalConfigurationChange(
  actor: OperationalConfigurationActor,
  unsafeProposal: unknown,
  options: { now?: Date } = {},
): Promise<OperationalConfigurationPreview> {
  const proposal = parseProposal(unsafeProposal);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new ConfigurationError("VALIDATION", "Data di elaborazione non valida.");
  }

  return runOperationalConfigurationTransaction(async (client) => {
    await requireFreshAdmin(client, actor);
    return calculatePreview(client, actor, proposal, now);
  });
}

function auditAction(
  proposal: OperationalChangeProposal,
  before: Record<string, string | number | boolean> | null,
) {
  if (proposal.kind === "BOOKING_SETTINGS") {
    return "BOOKING_SETTINGS_UPDATED" as const;
  }
  if (proposal.kind === "WEEKLY_SCHEDULE") {
    return "WEEKLY_SCHEDULE_UPDATED" as const;
  }
  if (before === null) {
    return "PUBLIC_BOOKING_CUTOFF_RULE_CREATED" as const;
  }
  if (before.isEnabled === true && !proposal.isEnabled) {
    return "PUBLIC_BOOKING_CUTOFF_RULE_DISABLED" as const;
  }
  return "PUBLIC_BOOKING_CUTOFF_RULE_UPDATED" as const;
}

function impactMetadata(preview: OperationalConfigurationPreview) {
  const classifications = [
    ...new Set(preview.impact.items.map((item) => item.classification)),
  ];
  const limits = preview.impact.items.filter(
    (item) => item.proposedLimit !== null || item.maxLoad !== null,
  );
  return {
    reservationCount: preview.impact.reservationCount,
    covers: preview.impact.covers,
    classifications,
    previousLimit:
      limits.length > 0 ? limits[0]?.previousLimit ?? null : null,
    proposedLimit:
      limits.length > 0 ? limits[0]?.proposedLimit ?? null : null,
    maxLoad:
      limits.length > 0
        ? Math.max(...limits.map((item) => item.maxLoad ?? 0))
        : null,
  };
}

export async function applyOperationalConfigurationChange(
  actor: OperationalConfigurationActor,
  unsafeConfirmation: unknown,
  options: { now?: Date } = {},
): Promise<{ changed: boolean }> {
  const parsed = operationalChangeConfirmationSchema.safeParse(
    unsafeConfirmation,
  );
  if (!parsed.success) {
    throw new ConfigurationError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "La conferma non è valida.",
    );
  }
  const now = options.now ?? new Date();

  return runOperationalConfigurationTransaction(async (client) => {
    await acquireOperationalConfigurationLock(client, actor.restaurantId);
    const freshActor = await requireFreshAdmin(client, actor);
    const preview = await calculatePreview(
      client,
      actor,
      parsed.data.proposal,
      now,
    );
    if (preview.fingerprint !== parsed.data.fingerprint) {
      throw new ConfigurationImpactChangedError(preview);
    }
    if (!preview.changed) return { changed: false };

    const rawBefore = await client.restaurant.findUnique({
      where: { id: actor.restaurantId },
      select: {
        id: true,
        name: true,
        timezone: true,
        bookingSettings: true,
        weeklySchedules: true,
        bookingCutoffRules: true,
      },
    });
    if (!rawBefore) {
      throw new ConfigurationError("NOT_FOUND", "Ristorante non disponibile.");
    }
    const contextBefore = {
      restaurant: rawBefore,
      reservations: [],
      specialDateOverrides: [],
    } as NonNullable<
      Awaited<ReturnType<typeof readOperationalConfigurationContext>>
    >;
    const before = currentSnapshot(parsed.data.proposal, contextBefore);
    const applied = await applyOperationalProposal(
      client,
      actor.restaurantId,
      parsed.data.proposal,
    );
    if (!applied) {
      throw new ConfigurationError(
        "NOT_FOUND",
        "La configurazione richiesta non appartiene al ristorante.",
      );
    }
    const after = proposalSnapshot(parsed.data.proposal);
    const entityId =
      parsed.data.proposal.kind === "BOOKING_SETTINGS"
        ? actor.restaurantId
        : "id" in applied
          ? applied.id
          : actor.restaurantId;
    const entityType =
      parsed.data.proposal.kind === "BOOKING_SETTINGS"
        ? "RESTAURANT_BOOKING_SETTINGS"
        : parsed.data.proposal.kind === "WEEKLY_SCHEDULE"
          ? "WEEKLY_SERVICE_SCHEDULE"
          : "BOOKING_CUTOFF_RULE";

    await insertAuditEvent(client, {
      restaurantId: actor.restaurantId,
      category: "CONFIGURATION",
      action: auditAction(parsed.data.proposal, before),
      outcome: "SUCCESS",
      actorUserId: freshActor.id,
      actorRole: freshActor.role,
      entityType,
      entityId,
      correlationId: randomUUID(),
      previousState:
        before === null ? null : (before as Prisma.InputJsonValue),
      newState: after as Prisma.InputJsonValue,
      metadata: impactMetadata(preview) as Prisma.InputJsonValue,
      createdAt: now,
    });

    return { changed: true };
  });
}

export function defaultCutoffRuleProposal(
  input: Omit<BookingCutoffRuleProposal, "kind">,
): BookingCutoffRuleProposal {
  return { kind: "BOOKING_CUTOFF_RULE", ...input };
}
