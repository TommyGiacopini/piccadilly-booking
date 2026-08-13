import { createHash } from "node:crypto";

import { z } from "zod";

import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_OUTCOMES } from "@/modules/audit/domain/audit-event";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";
import { localReservationInstant } from "@/modules/reservations/domain/management-time";

export const AUDIT_SOURCES = ["RESERVATION", "ADMINISTRATIVE"] as const;
export const AUDIT_SOURCE_RANK = {
  RESERVATION: 1,
  ADMINISTRATIVE: 2,
} as const;
export const RESERVATION_AUDIT_ACTIONS = ["CREATED", "UPDATED", "CANCELLED"] as const;
export const AUDIT_LIST_CATEGORIES = ["RESERVATION", ...AUDIT_CATEGORIES] as const;
export const AUDIT_LIST_ACTIONS = [...RESERVATION_AUDIT_ACTIONS, ...AUDIT_ACTIONS] as const;
export const AUDIT_LIST_OUTCOMES = AUDIT_OUTCOMES;
export const AUDIT_ENTITY_TYPES = [
  "RESERVATION",
  "USER",
  "ROOM",
  "DINING_TABLE",
  "WEEKLY_SERVICE_SCHEDULE",
  "RESTAURANT_BOOKING_SETTINGS",
  "SPECIAL_DATE_OVERRIDE",
  "BOOKING_CUTOFF_RULE",
  "SERVICE_ROOM_AVAILABILITY",
  "RestaurantPublicSettings",
  "RestaurantBookingSettings",
  "Restaurant",
] as const;
export const AUDIT_ACTOR_KINDS = ["USER", "PUBLIC", "ANONYMOUS", "SYSTEM"] as const;
export const AUDIT_DEFAULT_PAGE_SIZE = 25;
export const AUDIT_MAX_PAGE_SIZE = 100;
export const AUDIT_CURSOR_MAX_LENGTH = 512;

export type AuditSource = (typeof AUDIT_SOURCES)[number];
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];
export type AuditListCategory = (typeof AUDIT_LIST_CATEGORIES)[number];
export type AuditListAction = (typeof AUDIT_LIST_ACTIONS)[number];
export type AuditListOutcome = (typeof AUDIT_LIST_OUTCOMES)[number];
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export class AuditQueryError extends Error {
  constructor(
    public readonly code: "INVALID_QUERY" | "FORBIDDEN" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "AuditQueryError";
  }
}

const querySchema = z.strictObject({
  from: z.string().refine(isLocalDate, "Data iniziale non valida.").optional(),
  to: z.string().refine(isLocalDate, "Data finale non valida.").optional(),
  source: z.enum(AUDIT_SOURCES).optional(),
  category: z.enum(AUDIT_LIST_CATEGORIES).optional(),
  action: z.enum(AUDIT_LIST_ACTIONS).optional(),
  outcome: z.enum(AUDIT_LIST_OUTCOMES).optional(),
  actor: z.union([z.enum(["PUBLIC", "ANONYMOUS", "SYSTEM"]), z.uuid()]).optional(),
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  correlationId: z.uuid().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE)).optional(),
  cursor: z.string().min(1).max(AUDIT_CURSOR_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

const allowedQueryKeys = new Set(Object.keys(querySchema.shape));

const cursorSchema = z.strictObject({
  v: z.literal(1),
  timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  sourceRank: z.union([z.literal(1), z.literal(2)]),
  eventId: z.uuid(),
  filterFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface AuditCursorPosition {
  timestamp: Date;
  sourceRank: 1 | 2;
  eventId: string;
}

export interface AuditListFilters {
  from: string;
  to: string;
  fromInclusive: Date;
  toExclusive: Date;
  source?: AuditSource;
  category?: AuditListCategory;
  action?: AuditListAction;
  outcome?: AuditListOutcome;
  actor?: "PUBLIC" | "ANONYMOUS" | "SYSTEM" | string;
  entityType?: AuditEntityType;
  entityId?: string;
  correlationId?: string;
}

export interface ParsedAuditListQuery {
  filters: AuditListFilters;
  filterFingerprint: string;
  limit: number;
  cursor: AuditCursorPosition | null;
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(from: string, to: string): number {
  return (
    (new Date(`${to}T00:00:00.000Z`).getTime() -
      new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000 +
    1
  );
}

function canonicalFilterFingerprint(filters: Omit<AuditListFilters, "fromInclusive" | "toExclusive">): string {
  return createHash("sha256")
    .update(JSON.stringify(filters), "utf8")
    .digest("hex");
}

function invalidQuery(message = "I filtri dell'audit non sono validi."): never {
  throw new AuditQueryError("INVALID_QUERY", message);
}

export function encodeAuditCursor(
  position: AuditCursorPosition,
  filterFingerprint: string,
): string {
  const payload = cursorSchema.parse({
    v: 1,
    timestamp: position.timestamp.toISOString(),
    sourceRank: position.sourceRank,
    eventId: position.eventId,
    filterFingerprint,
  });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeAuditCursor(
  encoded: string,
  expectedFilterFingerprint: string,
): AuditCursorPosition {
  try {
    if (
      encoded.length > AUDIT_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)
    ) {
      return invalidQuery("Il cursore dell'audit non è valido.");
    }
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
      return invalidQuery("Il cursore dell'audit non è valido.");
    }
    const payload = cursorSchema.parse(JSON.parse(decoded));
    if (payload.filterFingerprint !== expectedFilterFingerprint) {
      return invalidQuery("Il cursore non appartiene ai filtri correnti.");
    }
    const timestamp = new Date(payload.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      return invalidQuery("Il cursore dell'audit non è valido.");
    }
    return {
      timestamp,
      sourceRank: payload.sourceRank,
      eventId: payload.eventId,
    };
  } catch (error) {
    if (error instanceof AuditQueryError) throw error;
    return invalidQuery("Il cursore dell'audit non è valido.");
  }
}

export function parseAuditListQuery(
  searchParams: URLSearchParams,
  timezone: string,
  now = new Date(),
): ParsedAuditListQuery {
  const raw: Record<string, string> = {};
  for (const key of new Set(searchParams.keys())) {
    if (!allowedQueryKeys.has(key) || searchParams.getAll(key).length !== 1) {
      return invalidQuery();
    }
    raw[key] = searchParams.get(key) ?? "";
  }
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return invalidQuery(parsed.error.issues[0]?.message);
  }

  const localToday = getZonedDateTimeParts(now, timezone).date;
  const to = parsed.data.to ?? localToday;
  const from = parsed.data.from ?? addLocalDays(to, -29);
  const days = inclusiveDayCount(from, to);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    return invalidQuery("Il periodo deve contenere da 1 a 366 giorni.");
  }

  const canonicalFilters = {
    from,
    to,
    ...(parsed.data.source ? { source: parsed.data.source } : {}),
    ...(parsed.data.category ? { category: parsed.data.category } : {}),
    ...(parsed.data.action ? { action: parsed.data.action } : {}),
    ...(parsed.data.outcome ? { outcome: parsed.data.outcome } : {}),
    ...(parsed.data.actor ? { actor: parsed.data.actor } : {}),
    ...(parsed.data.entityType ? { entityType: parsed.data.entityType } : {}),
    ...(parsed.data.entityId ? { entityId: parsed.data.entityId } : {}),
    ...(parsed.data.correlationId
      ? { correlationId: parsed.data.correlationId }
      : {}),
  };
  const filterFingerprint = canonicalFilterFingerprint(canonicalFilters);
  return {
    filters: {
      ...canonicalFilters,
      fromInclusive: localReservationInstant(from, "00:00", timezone),
      toExclusive: localReservationInstant(addLocalDays(to, 1), "00:00", timezone),
    },
    filterFingerprint,
    limit: parsed.data.limit ?? AUDIT_DEFAULT_PAGE_SIZE,
    cursor: parsed.data.cursor
      ? decodeAuditCursor(parsed.data.cursor, filterFingerprint)
      : null,
  };
}
