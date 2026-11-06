import { createHash } from "node:crypto";
import { z } from "zod";

import { resolveAppEnvironment } from "../src/shared/config/app-environment";
import { parseNotificationPayload } from "../src/modules/notifications/domain/notification-rules";
import { DEMO_ROOMS } from "../src/modules/configuration/domain/defaults";
import { isLocalDate, isOperationalTime } from "../src/modules/configuration/domain/operational-time";
import { PUBLIC_CONTENT_KEYS, PUBLIC_CONTENT_LOCALES } from "../src/modules/configuration/domain/public-settings";
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES } from "../src/modules/audit/domain/audit-event";
import { AUDIT_ENTITY_TYPES } from "../src/modules/audit/domain/audit-query";

export const STAGING_DEMO_RESTAURANT_ID =
  "00000000-0000-4000-8000-000000000001";
export const STAGING_ALLOWED_SERVICE_TYPES = new Set(["web", "worker"]);
export const STAGING_RUN_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{7,31}$/;

export interface QueryResult {
  rows: unknown[];
  rowCount?: number | null;
}

export interface StagingDatabase {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
}

export interface StagingToolingGuard {
  restaurantId: typeof STAGING_DEMO_RESTAURANT_ID;
  serviceType: "web" | "worker";
}

function requiredEnvironmentValue(
  environment: Record<string, string | undefined>,
  key: string,
): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Missing required staging tooling configuration: ${key}.`);
  return value;
}

function assertNoProviderConfiguration(
  environment: Record<string, string | undefined>,
): void {
  for (const [key, rawValue] of Object.entries(environment)) {
    if (!rawValue?.trim()) continue;
    const normalizedKey = key.toUpperCase();
    const value = rawValue.trim().toUpperCase();
    if (
      /(^|_)(META|GRAPH|GRAPH_API|SMTP|SES|RESEND|SENDGRID)(_|$)/.test(
        normalizedKey,
      ) ||
      /(^|_)(PROVIDER|WHATSAPP|EMAIL)(_|.*_)(URL|TOKEN|API_KEY|SECRET|MODE)$/.test(
        normalizedKey,
      ) ||
      ((normalizedKey.includes("PROVIDER") || normalizedKey.endsWith("_MODE")) &&
        value === "REAL")
    ) {
      throw new Error("Real provider configuration is forbidden for staging tooling.");
    }
  }
}

export function assertStagingToolingGuard(
  environment: Record<string, string | undefined> = process.env,
): StagingToolingGuard {
  if (resolveAppEnvironment(environment.APP_ENV) !== "staging") {
    throw new Error("Staging tooling requires APP_ENV=staging.");
  }
  if (environment.RENDER !== "true") {
    throw new Error("Staging tooling requires the Render environment.");
  }

  const serviceType = requiredEnvironmentValue(environment, "RENDER_SERVICE_TYPE");
  if (!STAGING_ALLOWED_SERVICE_TYPES.has(serviceType)) {
    throw new Error("Render service type is not allowed for staging tooling.");
  }
  if (environment.AUTH_RESTAURANT_ID !== STAGING_DEMO_RESTAURANT_ID) {
    throw new Error("Staging tooling requires the exact demo tenant.");
  }

  requiredEnvironmentValue(environment, "DATABASE_URL");
  assertNoProviderConfiguration(environment);
  return {
    restaurantId: STAGING_DEMO_RESTAURANT_ID,
    serviceType: serviceType as "web" | "worker",
  };
}

export function assertValidStagingRunId(runId: string | undefined): string {
  const normalized = runId?.trim().toUpperCase();
  if (!normalized || !STAGING_RUN_ID_PATTERN.test(normalized)) {
    throw new Error("Staging run ID is invalid.");
  }
  return normalized;
}

export function stagingRunPrefix(runId: string): string {
  return `M13-${assertValidStagingRunId(runId)}-`;
}

type SeedVerificationRow = {
  restaurantName: string;
  timezone: string;
  publicPhone: string;
  publicBookingBaseUrl: string;
  publicEmail: string | null;
  whatsappNumber: string | null;
  notificationStrategy: string;
  demoUserCount: string | number;
  demoTableCount: string | number;
  reservationCount: string | number;
  outboxCount: string | number;
  attemptCount: string | number;
  receiptCount: string | number;
};

function numeric(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Staging database returned an invalid count.");
  }
  return parsed;
}

function isFakePhone(value: string | null): boolean {
  return value !== null && /^\+390000\d{6}$/.test(value);
}

function isExampleTestEmail(value: string | null): boolean {
  return value === null || /^[^@\s]+@example\.test$/i.test(value);
}

function isOnrenderRootUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/.test(
        url.hostname.toLowerCase(),
      ) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function verifyStagingSeed(database: StagingDatabase) {
  const result = await database.query(
    `/* staging:verify-seed */
    SELECT
      r.name AS "restaurantName",
      r.timezone,
      ps.public_phone AS "publicPhone",
      ps.public_booking_base_url AS "publicBookingBaseUrl",
      ps.public_email AS "publicEmail",
      ps.whatsapp_number AS "whatsappNumber",
      ns.strategy::text AS "notificationStrategy",
      (SELECT COUNT(*) FROM users u WHERE u.restaurant_id = r.id AND u.username IN ('demo.admin', 'demo.staff')) AS "demoUserCount",
      (SELECT COUNT(*) FROM dining_tables dt JOIN rooms room ON room.id = dt.room_id WHERE room.restaurant_id = r.id AND dt.name LIKE 'DEMO-%') AS "demoTableCount",
      (SELECT COUNT(*) FROM reservations x WHERE x.restaurant_id = r.id) AS "reservationCount",
      (SELECT COUNT(*) FROM notification_outbox x WHERE x.restaurant_id = r.id) AS "outboxCount",
      (SELECT COUNT(*) FROM notification_attempts x WHERE x.restaurant_id = r.id) AS "attemptCount",
      (SELECT COUNT(*) FROM notification_simulation_receipts x WHERE x.restaurant_id = r.id) AS "receiptCount"
    FROM restaurants r
    JOIN restaurant_public_settings ps ON ps.restaurant_id = r.id
    JOIN restaurant_notification_settings ns ON ns.restaurant_id = r.id
    WHERE r.id = $1::uuid`,
    [STAGING_DEMO_RESTAURANT_ID],
  );
  const row = result.rows[0] as SeedVerificationRow | undefined;

  if (
    !row ||
    row.restaurantName !== "Piccadilly Demo" ||
    row.timezone !== "Europe/Rome" ||
    !isFakePhone(row.publicPhone) ||
    !isFakePhone(row.whatsappNumber) ||
    !isExampleTestEmail(row.publicEmail) ||
    !isOnrenderRootUrl(row.publicBookingBaseUrl) ||
    row.notificationStrategy !== "WHATSAPP_ONLY" ||
    numeric(row.demoUserCount) !== 2 ||
    numeric(row.demoTableCount) !== 5 ||
    numeric(row.reservationCount) !== 0 ||
    numeric(row.outboxCount) !== 0 ||
    numeric(row.attemptCount) !== 0 ||
    numeric(row.receiptCount) !== 0
  ) {
    throw new Error("Staging seed verification failed.");
  }

  return { demoUsers: 2, demoTables: 5, operationalRows: 0 };
}

type FakeDataRow = {
  recordType: string;
  restaurantId: string;
  nameValue: string | null;
  phoneValue: string | null;
  secondaryPhoneValue: string | null;
  emailValue: string | null;
  urlValue: string | null;
  textValue: string | null;
  channelValue: string | null;
  dataValue?: unknown;
};

// Positive fixture grammar: a marker alone never authorizes arbitrary prose.
const syntheticText = z.union([
  z.enum(["", "M13 fixture", "M13-LQG synthetic fixture", "M13 synthetic PRE private note", "M13 synthetic changed NI", "M13 synthetic run private note"]),
  z.string().regex(/^M13-[A-Z0-9][A-Z0-9-]{7,31}-(?:(?:PUBLIC|PHONE|STAFF)-)?(?:NOTES(?:-ASSIGNMENT)?|ASSIGNMENT)$/),
]).nullable();
const syntheticName = z.string().regex(/^M13-(?:(?:NONRUN|[A-Z0-9][A-Z0-9-]{7,31}(?:-(?:PUBLIC|PHONE|STAFF))?)-)?(?:FIRST|LAST)$/);
const count = z.number().int().nonnegative();
const date = z.string().refine(isLocalDate);
const time = z.string().refine(isOperationalTime);
const service = z.enum(["LUNCH", "DINNER"]);
const roomCode = z.enum(["", "sala-1", "sala-2", "sala-3", "galleria", "terrazzo"]);
const tableName = z.enum(["DEMO-S1-01", "DEMO-S2-01", "DEMO-S3-01", "DEMO-G-01", "DEMO-T-01"]);
const preferences = z.strictObject({ roomCode, highChair: z.boolean(), stroller: z.boolean(), accessibility: z.boolean(), children: z.boolean(), celebration: syntheticText, animals: z.boolean(), legacyText: syntheticText.optional() });
const allergies = z.strictObject({ celiac: z.boolean(), allergies: syntheticText, intolerances: syntheticText, legacyText: syntheticText.optional() });

/** Inspect serialized request JSON before object parsing can discard duplicate keys. */
export function hasUnambiguousStagingJson(raw: string): boolean {
  let position = 0;
  const invalid = (): never => { throw new Error("Staging request JSON is ambiguous or invalid."); };
  const whitespace = () => {
    while (position < raw.length && /[\t\n\r ]/.test(raw[position])) position += 1;
  };
  const string = (): string => {
    const start = position;
    if (raw[position++] !== '"') invalid();
    while (position < raw.length) {
      const character = raw[position++];
      if (character === '"') {
        // Only a string token is decoded here, never an object with repeated keys.
        return JSON.parse(raw.slice(start, position)) as string;
      }
      if (character === "\\") position += 1;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    // Canonical request schemas are shallow. Bound malformed/untrusted nesting.
    if (depth > 128) invalid();
    whitespace();
    const character = raw[position];
    if (character === "{") {
      position += 1;
      whitespace();
      const keys = new Set<string>();
      if (raw[position] === "}") { position += 1; return; }
      while (position < raw.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (raw[position++] !== ":") invalid();
        value(depth + 1);
        whitespace();
        const delimiter = raw[position++];
        if (delimiter === "}") return;
        if (delimiter !== ",") invalid();
      }
      invalid();
    } else if (character === "[") {
      position += 1;
      whitespace();
      if (raw[position] === "]") { position += 1; return; }
      while (position < raw.length) {
        value(depth + 1);
        whitespace();
        const delimiter = raw[position++];
        if (delimiter === "]") return;
        if (delimiter !== ",") invalid();
      }
      invalid();
    } else if (character === '"') {
      string();
    } else {
      const literal = ["true", "false", "null"].find(token => raw.startsWith(token, position));
      if (literal) position += literal.length;
      else {
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(position));
        if (!number) return invalid();
        position += number[0].length;
      }
    }
  };
  try {
    value(0);
    whitespace();
    return position === raw.length;
  } catch {
    // Syntax errors may contain source fragments. Expose only the boolean verdict.
    return false;
  }
}

function serializedRequests(value: unknown, schema: z.ZodType): boolean {
  if (syntheticText.safeParse(value).success) return true;
  if (typeof value !== "string" || !hasUnambiguousStagingJson(value)) return false;
  try { return schema.safeParse(JSON.parse(value)).success; }
  catch { return false; }
}

const reservationContent = z.strictObject({
  notes: syntheticText, privateNotes: syntheticText, capacityOverrideReason: syntheticText,
  preferences: z.unknown().refine(value => serializedRequests(value, preferences)),
  allergies: z.unknown().refine(value => serializedRequests(value, allergies)),
});
const assignmentState = z.strictObject({ assignment: z.strictObject({ finalRoomCode: roomCode, tableIds: z.array(z.uuid()).max(20), tableCount: count, internalNotesPresent: z.boolean() }).nullable(), reason: z.literal("RESERVATION_SCHEDULE_CHANGED").optional() });
const reservationState = z.strictObject({
  localDate: date, serviceType: service, arrivalTime: time, partySize: count, childrenCount: count.nullable().optional(), gameRoomPreference: z.boolean().nullable().optional(),
  status: z.enum(["CONFIRMED", "CANCELLED"]), origin: z.enum(["PUBLIC", "PHONE", "STAFF"]), version: count,
  requests: z.strictObject({ roomCode: roomCode.nullable(), legacyPreferencePresent: z.boolean(), highChair: z.boolean(), stroller: z.boolean(), accessibility: z.boolean(), children: z.boolean(), celiac: z.boolean(), foodRequestsPresent: z.boolean(), allergiesPresent: z.boolean(), intolerancesPresent: z.boolean(), celebrationPresent: z.boolean(), animals: z.boolean(), notesPresent: z.boolean() }),
  capacityOverride: z.boolean(), capacityOverrideReason: syntheticText,
  capacityOverrideResult: z.strictObject({ capacityLimit: count, totalBefore: count, totalAfter: count }).optional(),
  notification: z.strictObject({ confirmationWhatsAppRequested: z.boolean() }).optional(),
  assignment: assignmentState.shape.assignment.optional(), reason: assignmentState.shape.reason,
});
const reservationStates: Record<string, z.ZodType> = {
  CREATED: reservationState, UPDATED: reservationState, CANCELLED: reservationState,
  ASSIGNED: assignmentState, REASSIGNED: assignmentState, UNASSIGNED: assignmentState,
  ARRIVAL_RECORDED: z.strictObject({ arrival: z.strictObject({ recorded: z.boolean(), arrivedAt: z.iso.datetime().nullable() }) }),
  ARRIVAL_REVERTED: z.strictObject({ arrival: z.strictObject({ recorded: z.boolean(), arrivedAt: z.iso.datetime().nullable() }) }),
  PRIVATE_NOTES_UPDATED: z.strictObject({ privateNotes: z.strictObject({ present: z.boolean() }), version: count }),
};
const role = z.enum(["ADMIN", "STAFF"]);
const identityState = z.strictObject({ role, isActive: z.boolean(), disabledAtPresent: z.boolean(), mustChangePassword: z.boolean() });
const roomState = z.strictObject({ code: roomCode, displayOrder: count, isActive: z.boolean() });
const diningTableState = z.strictObject({ roomId: z.uuid(), name: tableName.optional(), minimumSeats: count, maximumSeats: count, displayOrder: count, isActive: z.boolean() });
const bookingState = z.strictObject({ rollingCapacityCovers: count, rollingWindowMinutes: count, lunchModificationCutoff: time, dinnerModificationCutoff: time, managementLinkDurationHours: count.optional() });
const dayOfWeek = z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
const weeklyState = z.strictObject({ dayOfWeek, serviceType: service, isEnabled: z.boolean(), startTime: time, endTime: time, slotIntervalMinutes: count });
const cutoffState = z.strictObject({ dayOfWeek, serviceType: service, isEnabled: z.boolean(), cutoffTime: time });
const specialDateState = z.strictObject({ date, scope: z.enum(["ALL", "LUNCH", "DINNER"]), isClosed: z.boolean(), specialStartTime: time.nullable(), specialEndTime: time.nullable(), specialCapacityCovers: count.nullable(), operationalNotesPresent: z.boolean(), archived: z.boolean() });
const administrativeStates: Record<string, z.ZodType> = {
  LOGIN_SUCCEEDED: z.null(), LOGIN_FAILED: z.null(), LOGIN_RATE_LIMITED: z.null(), LOGOUT_SUCCEEDED: z.null(),
  USER_CREATED: identityState, USER_ROLE_CHANGED: identityState, USER_ENABLED: identityState, USER_DISABLED: identityState, USER_PASSWORD_RESET: identityState, PASSWORD_CHANGED: identityState,
  ROOM_UPDATED: roomState, ROOM_DISABLED: roomState, ROOM_ENABLED: roomState,
  ROOM_ORDER_UPDATED: roomState,
  ROOM_AVAILABILITY_UPDATED: z.strictObject({ localDate: date, serviceType: service, roomCode: roomCode.nullable(), isAvailable: z.boolean() }),
  DINING_TABLE_CREATED: diningTableState, DINING_TABLE_UPDATED: diningTableState, DINING_TABLE_DISABLED: diningTableState, DINING_TABLE_ENABLED: diningTableState,
  BOOKING_SETTINGS_UPDATED: bookingState, WEEKLY_SCHEDULE_UPDATED: weeklyState,
  PUBLIC_BOOKING_CUTOFF_RULE_CREATED: cutoffState, PUBLIC_BOOKING_CUTOFF_RULE_UPDATED: cutoffState, PUBLIC_BOOKING_CUTOFF_RULE_DISABLED: cutoffState,
  SPECIAL_DATE_CREATED: specialDateState, SPECIAL_DATE_UPDATED: specialDateState, SPECIAL_DATE_ARCHIVED: specialDateState, SPECIAL_DATE_REACTIVATED: specialDateState,
  PUBLIC_CONTACTS_UPDATED: z.strictObject({ phoneConfigured: z.boolean(), emailConfigured: z.boolean(), whatsappConfigured: z.boolean(), urlConfigured: z.boolean() }),
  PUBLIC_CONTENT_UPDATED: z.strictObject({ complete: z.boolean(), locales: z.array(z.enum(PUBLIC_CONTENT_LOCALES)), keys: z.array(z.enum(PUBLIC_CONTENT_KEYS)) }),
  MANAGEMENT_LINK_DURATION_UPDATED: z.strictObject({ managementLinkDurationHours: count }),
  NOTIFICATION_STRATEGY_UPDATED: z.strictObject({ strategy: z.enum(["WHATSAPP_ONLY", "WHATSAPP_WITH_EMAIL_FALLBACK", "WHATSAPP_AND_EMAIL_PARALLEL"]) }),
  PDF_EXPORT_REQUESTED: z.null(), EXCEL_EXPORT_REQUESTED: z.null(),
};
const classification = z.enum(["SERVICE_DISABLED", "OUTSIDE_NEW_HOURS", "CAPACITY_EXCEEDED", "MODIFICATION_CUTOFF_CHANGED", "ROOM_UNAVAILABLE", "ROOM_DISABLED", "TABLE_DISABLED", "RESERVATION_WITH_AFFECTED_ROOM_PREFERENCE", "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT", "NO_EXISTING_RESERVATION_IMPACT"]);
const impactMetadata = z.strictObject({ reservationCount: count, covers: count, classifications: z.array(classification), classification: classification.nullable().optional(), previousLimit: count.nullable().optional(), proposedLimit: count.nullable().optional(), maxLoad: count.nullable().optional(), instanceMaterialized: z.boolean().optional(), preferenceReservationCount: count.optional(), assignmentReservationCount: count.optional() });
const exportMetadata = z.strictObject({ format: z.enum(["PDF", "EXCEL"]), mode: z.enum(["DAY", "MONTH", "RANGE"]), fromDate: date, toDate: date, dayCount: count, reservationCount: count.optional(), failureCode: z.enum(["GENERATION_FAILED", "EXPORT_TOO_LARGE", "EXPORT_RANGE_TOO_LARGE"]).optional() });

function validAudit(value: unknown, reservation: boolean): boolean {
  const envelope = z.strictObject({ action: z.string(), category: z.enum([...AUDIT_CATEGORIES, "RESERVATION"]), outcome: z.enum(AUDIT_OUTCOMES), entityType: z.enum(AUDIT_ENTITY_TYPES).nullable(), previousState: z.unknown(), newState: z.unknown(), metadata: z.unknown(), capacityOverrideReason: syntheticText }).safeParse(value);
  if (!envelope.success) return false;
  const event = envelope.data;
  const states = reservation ? reservationStates : administrativeStates;
  if (!Object.hasOwn(states, event.action)) return false;
  const schema = states[event.action];
  if (!(event.previousState === null || schema.safeParse(event.previousState).success) ||
      !(event.newState === null && !reservation || schema.safeParse(event.newState).success)) return false;
  if (reservation) return event.metadata === null;
  if (event.metadata === null) return true;
  const metadata = event.action.startsWith("LOGIN_") ? z.strictObject({ credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    : event.action.startsWith("USER_") || event.action === "PASSWORD_CHANGED" ? z.strictObject({ revokedSessionCount: count, flowType: z.enum(["ADMIN_CREATE", "ADMIN_ROLE_CHANGE", "ADMIN_ENABLE", "ADMIN_DISABLE", "ADMIN_PASSWORD_RESET", "PERSONAL_PASSWORD_CHANGE"]) })
    : event.action === "PUBLIC_CONTACTS_UPDATED" ? z.strictObject({ changedFields: z.array(z.enum(["publicPhone", "publicEmail", "publicBookingBaseUrl", "whatsappNumber"])) })
    : event.action === "PUBLIC_CONTENT_UPDATED" ? z.strictObject({ changed: z.array(z.strictObject({ locale: z.enum(PUBLIC_CONTENT_LOCALES), keys: z.array(z.enum(PUBLIC_CONTENT_KEYS)) })) })
    : event.action === "MANAGEMENT_LINK_DURATION_UPDATED" ? z.strictObject({ existingTokensAffected: z.literal(0) })
    : event.action.endsWith("_EXPORT_REQUESTED") ? exportMetadata : impactMetadata;
  return metadata.safeParse(event.metadata).success;
}

function validNotification(value: unknown): boolean {
  try {
    const payload = parseNotificationPayload(value);
    return syntheticName.safeParse(payload.params.customerFirstName).success && payload.params.restaurantName === "Piccadilly Demo";
  } catch { return false; }
}

// Exact seed copy, keyed by locale and content key; no arbitrary editorial prose.
const syntheticPublicContents = {
  IT: ["Prenotazione dimostrativa Piccadilly", "Contenuto dimostrativo: scegli data, servizio e orario disponibili.", "Nessuna disponibilità dimostrativa per la selezione corrente.", "Per assistenza sulla dimostrazione puoi usare uno dei contatti indicati.", "La prenotazione dimostrativa è stata registrata correttamente.", "Gestisci la prenotazione dimostrativa", "Consulta, modifica o annulla la prenotazione entro i termini disponibili."],
  EN: ["Piccadilly demonstration booking", "Demonstration content: choose an available date, service and time.", "No demonstration availability exists for the current selection.", "For help with this demonstration, use one of the listed contacts.", "The demonstration booking has been recorded successfully.", "Manage the demonstration booking", "View, change or cancel the booking within the available time limits."],
};
function validPublicContent(value: unknown): boolean {
  const parsed = z.strictObject({ locale: z.enum(PUBLIC_CONTENT_LOCALES), key: z.enum(PUBLIC_CONTENT_KEYS), text: z.string() }).safeParse(value);
  return parsed.success && syntheticPublicContents[parsed.data.locale][PUBLIC_CONTENT_KEYS.indexOf(parsed.data.key)] === parsed.data.text;
}

export interface SanitizedFakeDataFinding {
  type: string;
  count: number;
}

export class StagingFakeDataScanError extends Error {
  readonly findings: readonly SanitizedFakeDataFinding[];

  constructor(findings: readonly SanitizedFakeDataFinding[]) {
    super(
      `Staging fake-data scan failed: ${findings
        .map((finding) => `${finding.type}=${finding.count}`)
        .join(", ")}.`,
    );
    this.name = "StagingFakeDataScanError";
    this.findings = findings;
  }
}

function addViolation(violations: Map<string, number>, type: string): void {
  violations.set(type, (violations.get(type) ?? 0) + 1);
}

export async function scanStagingFakeData(database: StagingDatabase) {
  let result: QueryResult;
  try { result = await database.query(
    `/* staging:fake-data-scan */
    SELECT 'restaurant'::text AS "recordType", r.id::text AS "restaurantId", r.name AS "nameValue", NULL::text AS "phoneValue", NULL::text AS "secondaryPhoneValue", NULL::text AS "emailValue", NULL::text AS "urlValue", r.timezone AS "textValue", NULL::text AS "channelValue", NULL::jsonb AS "dataValue"
      FROM restaurants r
    UNION ALL
    SELECT 'public-settings', ps.restaurant_id::text, NULL, ps.public_phone, ps.whatsapp_number, ps.public_email, ps.public_booking_base_url, NULL, NULL, NULL
      FROM restaurant_public_settings ps
    UNION ALL
    SELECT 'reservation', x.restaurant_id::text, x.customer_first_name || ' ' || x.customer_last_name, x.customer_phone, NULL, x.customer_email, NULL, concat_ws(' ', x.preferences, x.notes, x.allergies, x.capacity_override_reason), NULL, NULL
      FROM reservations x
    UNION ALL
    SELECT 'destination', n.restaurant_id::text, NULL, CASE WHEN n.channel::text = 'WHATSAPP' THEN n.destination END, NULL, CASE WHEN n.channel::text = 'EMAIL' THEN n.destination END, NULL, NULL, n.channel::text, NULL
      FROM notification_outbox n
    UNION ALL
    SELECT 'reservation-content', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('notes', x.notes, 'privateNotes', x.private_notes, 'preferences', x.preferences, 'allergies', x.allergies, 'capacityOverrideReason', x.capacity_override_reason)
      FROM reservations x
    UNION ALL
    SELECT 'legacy-notes', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, to_jsonb(x.internal_notes)
      FROM reservation_assignments x
    UNION ALL
    SELECT 'reservation-audit', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('action', x.action, 'category', 'RESERVATION', 'outcome', 'SUCCESS', 'entityType', 'RESERVATION', 'previousState', x.previous_state, 'newState', x.new_state, 'metadata', NULL, 'capacityOverrideReason', x.capacity_override_reason)
      FROM reservation_audit_events x
    UNION ALL
    SELECT 'audit', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('action', x.action, 'category', x.category, 'outcome', x.outcome, 'entityType', x.entity_type, 'previousState', x.previous_state, 'newState', x.new_state, 'metadata', x.metadata, 'capacityOverrideReason', NULL)
      FROM audit_events x
    UNION ALL
    SELECT 'outbox-payload', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('payloadVersion', x.payload_version, 'payload', x.payload)
      FROM notification_outbox x
    UNION ALL
    SELECT 'user', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, to_jsonb(x.username) FROM users x
    UNION ALL
    SELECT 'operational-notes', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, to_jsonb(x.operational_notes) FROM special_date_overrides x
    UNION ALL
    SELECT 'room', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, jsonb_build_object('code', x.code, 'name', x.name) FROM rooms x
    UNION ALL
    SELECT 'table', r.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, to_jsonb(x.name) FROM dining_tables x JOIN rooms r ON r.id = x.room_id
    UNION ALL
    SELECT 'public-content', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, jsonb_build_object('locale', x.locale, 'key', x.content_key, 'text', x.content_text) FROM public_contents x
    UNION ALL
    SELECT 'provider-reference', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, to_jsonb(x.provider_reference) FROM notification_attempts x
    UNION ALL
    SELECT 'provider-reference', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, to_jsonb(x.provider_reference) FROM notification_simulation_receipts x
    UNION ALL
    SELECT 'tenant', x.restaurant_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM (
      SELECT restaurant_id FROM restaurant_notification_settings UNION ALL SELECT restaurant_id FROM restaurant_booking_settings
      UNION ALL SELECT restaurant_id FROM weekly_service_schedules UNION ALL SELECT restaurant_id FROM booking_cutoff_rules
      UNION ALL SELECT restaurant_id FROM service_instances UNION ALL SELECT restaurant_id FROM service_room_availability
      UNION ALL SELECT restaurant_id FROM reservation_assignment_tables UNION ALL SELECT restaurant_id FROM reservation_idempotency_keys
      UNION ALL SELECT restaurant_id FROM public_reservation_rate_limits
    ) x`,
  ); } catch {
    // Drivers may include SQL, cell contents or credentials in errors. Never forward them.
    throw new StagingFakeDataScanError([{ type: "scan-unavailable", count: 1 }]);
  }
  if (!result || !Array.isArray(result.rows)) {
    throw new StagingFakeDataScanError([{ type: "scan-unverifiable", count: 1 }]);
  }
  // This contract belongs only to the canonical scanner SELECT, not other SQL commands.
  if (typeof result.rowCount !== "number" || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0) {
    throw new StagingFakeDataScanError([{ type: "scan-row-count-unverifiable", count: 1 }]);
  }
  if (result.rowCount !== result.rows.length) {
    throw new StagingFakeDataScanError([{ type: "scan-row-count-mismatch", count: 1 }]);
  }
  const rows: FakeDataRow[] = [];
  const violations = new Map<string, number>();
  const rowSchema = z.strictObject({ recordType: z.string(), restaurantId: z.string(), nameValue: z.string().nullable(), phoneValue: z.string().nullable(), secondaryPhoneValue: z.string().nullable(), emailValue: z.string().nullable(), urlValue: z.string().nullable(), textValue: z.string().nullable(), channelValue: z.string().nullable(), dataValue: z.unknown().optional() });
  for (const value of result.rows) {
    const parsed = rowSchema.safeParse(value);
    if (!parsed.success) addViolation(violations, "unknown-row-structure");
    else rows.push(parsed.data);
  }
  const restaurantRows = rows.filter((row) => row.recordType === "restaurant");

  if (restaurantRows.length !== 1) {
    violations.set("restaurant-cardinality", restaurantRows.length);
  }
  for (const row of restaurantRows) {
    if (row.restaurantId !== STAGING_DEMO_RESTAURANT_ID) {
      addViolation(violations, "unexpected-restaurant");
    }
    if (row.nameValue !== "Piccadilly Demo" || row.textValue !== "Europe/Rome") {
      addViolation(violations, "unexpected-restaurant-profile");
    }
  }

  const publicSettingsRows = rows.filter(
    (row) => row.recordType === "public-settings",
  );
  if (
    publicSettingsRows.length !== 1
  ) {
    violations.set("public-settings-cardinality", publicSettingsRows.length);
  }

  for (const row of rows) {
    if (row.restaurantId !== STAGING_DEMO_RESTAURANT_ID) {
      addViolation(violations, "unexpected-tenant-data");
      if (row.recordType === "public-settings") {
        addViolation(violations, "unexpected-public-settings");
      } else if (row.recordType === "reservation") {
        addViolation(violations, "unexpected-reservation");
      } else if (row.recordType === "destination") {
        addViolation(violations, "unexpected-notification-destination");
      }
    }
    const combined = [
      row.nameValue,
      row.phoneValue,
      row.secondaryPhoneValue,
      row.emailValue,
      row.urlValue,
      row.textValue,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");

    if (/ristopizzapiccadilly\.it|\b(?:prod|production|live)\b/i.test(combined)) {
      addViolation(violations, "official-or-production-marker");
    }
    if (row.phoneValue && !isFakePhone(row.phoneValue)) {
      addViolation(violations, "non-fake-phone");
    }
    if (row.secondaryPhoneValue !== null && !isFakePhone(row.secondaryPhoneValue)) {
      addViolation(violations, "non-fake-phone");
    }
    if (!isExampleTestEmail(row.emailValue)) {
      addViolation(violations, "non-fake-email");
    }
    if ((row.recordType === "public-settings" || row.urlValue !== null) && !isOnrenderRootUrl(row.urlValue ?? "")) {
      addViolation(violations, "non-staging-hostname");
    }
    if (
      row.recordType === "reservation" &&
      (!row.nameValue || row.nameValue.split(" ").length !== 2 || !row.nameValue.split(" ").every((name) => syntheticName.safeParse(name).success))
    ) {
      addViolation(violations, "unprefixed-test-name");
    }
    if (
      row.recordType === "destination" &&
      row.channelValue !== "WHATSAPP" &&
      row.channelValue !== "EMAIL"
    ) {
      addViolation(violations, "unexpected-notification-channel");
    }
    if ((row.recordType === "reservation" || row.recordType === "public-settings") && !isFakePhone(row.phoneValue)) {
      addViolation(violations, "missing-required-contact");
    }
    const privacyChecks: Record<string, () => boolean> = {
      "reservation-content": () => reservationContent.safeParse(row.dataValue).success,
      "legacy-notes": () => row.dataValue !== undefined && syntheticText.safeParse(row.dataValue).success,
      "reservation-audit": () => validAudit(row.dataValue, true),
      audit: () => validAudit(row.dataValue, false),
      "outbox-payload": () => {
        const envelope = z.strictObject({ payloadVersion: z.literal(1), payload: z.unknown() }).safeParse(row.dataValue);
        return envelope.success && validNotification(envelope.data.payload);
      },
      user: () => row.dataValue === "demo.admin" || row.dataValue === "demo.staff",
      "operational-notes": () => row.dataValue !== undefined && syntheticText.safeParse(row.dataValue).success,
      room: () => DEMO_ROOMS.some(room => z.strictObject({ code: z.literal(room.code), name: z.literal(room.name) }).safeParse(row.dataValue).success),
      table: () => tableName.safeParse(row.dataValue).success,
      "public-content": () => validPublicContent(row.dataValue),
      "provider-reference": () => row.dataValue === null || typeof row.dataValue === "string" && /^sim-(?:wa|email)-[a-f0-9]{48}$/.test(row.dataValue),
      tenant: () => row.dataValue === null,
    };
    if (Object.hasOwn(privacyChecks, row.recordType)) {
      if (!privacyChecks[row.recordType]()) addViolation(violations, `unexpected-${row.recordType}-content`);
    } else if (!["restaurant", "public-settings", "reservation", "destination"].includes(row.recordType)) {
      addViolation(violations, "unknown-record-type");
    } else if (row.dataValue !== null && row.dataValue !== undefined) {
      addViolation(violations, "unknown-row-structure");
    }
  }

  if (violations.size > 0) {
    throw new StagingFakeDataScanError(
      [...violations.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => left.type.localeCompare(right.type)),
    );
  }

  return { scannedRows: rows.length, restaurants: 1, violationClasses: 0 };
}

export const STAGING_LIFECYCLE_FAMILIES = [
  "reservations",
  "reservation_assignments",
  "reservation_assignment_tables",
  "reservation_audit_events",
  "audit_events",
  "reservation_management_tokens",
  "reservation_idempotency_keys",
  "notification_outbox",
  "notification_attempts",
  "notification_simulation_receipts",
  "sessions",
  "login_rate_limits",
  "public_reservation_rate_limits",
  "service_instances",
  "service_room_availability",
] as const;

export type StagingLifecycleFamily =
  (typeof STAGING_LIFECYCLE_FAMILIES)[number];

interface LifecycleDefinition {
  family: StagingLifecycleFamily;
  table: string;
  from: string;
  identityExpression: string;
}

const LIFECYCLE_DEFINITIONS: readonly LifecycleDefinition[] = [
  { family: "reservations", table: "reservations", from: "reservations t", identityExpression: "t.id::text" },
  { family: "reservation_assignments", table: "reservation_assignments", from: "reservation_assignments t", identityExpression: "t.id::text" },
  { family: "reservation_assignment_tables", table: "reservation_assignment_tables", from: "reservation_assignment_tables t", identityExpression: "t.restaurant_id::text || ':' || t.assignment_id::text || ':' || t.dining_table_id::text" },
  { family: "reservation_audit_events", table: "reservation_audit_events", from: "reservation_audit_events t", identityExpression: "t.id::text" },
  { family: "audit_events", table: "audit_events", from: "audit_events t", identityExpression: "t.id::text" },
  { family: "reservation_management_tokens", table: "reservation_management_tokens", from: "reservation_management_tokens t", identityExpression: "t.id::text" },
  { family: "reservation_idempotency_keys", table: "reservation_idempotency_keys", from: "reservation_idempotency_keys t", identityExpression: "t.id::text" },
  { family: "notification_outbox", table: "notification_outbox", from: "notification_outbox t", identityExpression: "t.id::text" },
  { family: "notification_attempts", table: "notification_attempts", from: "notification_attempts t", identityExpression: "t.id::text" },
  { family: "notification_simulation_receipts", table: "notification_simulation_receipts", from: "notification_simulation_receipts t", identityExpression: "t.restaurant_id::text || ':' || t.idempotency_key" },
  { family: "sessions", table: "sessions", from: "sessions t", identityExpression: "t.id::text" },
  { family: "login_rate_limits", table: "login_rate_limits", from: "login_rate_limits t", identityExpression: "t.key_hash" },
  { family: "public_reservation_rate_limits", table: "public_reservation_rate_limits", from: "public_reservation_rate_limits t", identityExpression: "t.id::text" },
  { family: "service_instances", table: "service_instances", from: "service_instances t", identityExpression: "t.id::text" },
  { family: "service_room_availability", table: "service_room_availability", from: "service_room_availability t", identityExpression: "t.id::text" },
];

export interface StagingLifecycleFamilySnapshot {
  count: number;
  identities: string[];
  sha256: string;
}

export interface StagingPreBaselineManifest {
  version: 1;
  restaurantId: typeof STAGING_DEMO_RESTAURANT_ID;
  runId: string;
  families: Record<StagingLifecycleFamily, StagingLifecycleFamilySnapshot>;
  fingerprint: string;
}

type SnapshotRow = { identity: string; rowValue: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lifecycleFingerprint(
  families: Record<StagingLifecycleFamily, StagingLifecycleFamilySnapshot>,
): string {
  return sha256(
    JSON.stringify(
      STAGING_LIFECYCLE_FAMILIES.map((family) => ({
        family,
        count: families[family].count,
        identities: families[family].identities,
        sha256: families[family].sha256,
      })),
    ),
  );
}

async function snapshotStagingLifecycle(database: StagingDatabase) {
  const entries: Array<
    readonly [StagingLifecycleFamily, StagingLifecycleFamilySnapshot]
  > = [];

  for (const definition of LIFECYCLE_DEFINITIONS) {
    const result = await database.query(
      `/* staging:lifecycle-snapshot:${definition.family} */
      SELECT ${definition.identityExpression} AS "identity", to_jsonb(t)::text AS "rowValue"
      FROM ${definition.from}
      ORDER BY ${definition.identityExpression}`,
    );
    const rows = result.rows as SnapshotRow[];
    const identities = rows.map((row) => row.identity);
    if (new Set(identities).size !== identities.length) {
      throw new Error("Staging lifecycle snapshot contains duplicate identities.");
    }
    entries.push([
      definition.family,
      {
        count: rows.length,
        identities,
        sha256: sha256(rows.map((row) => row.rowValue).join("\n")),
      },
    ]);
  }

  const families = Object.fromEntries(entries) as Record<
    StagingLifecycleFamily,
    StagingLifecycleFamilySnapshot
  >;
  return { families, fingerprint: lifecycleFingerprint(families) };
}

export async function acquireStagingPreBaseline(
  database: StagingDatabase,
  runIdInput: string,
): Promise<StagingPreBaselineManifest> {
  const runId = assertValidStagingRunId(runIdInput);
  const existingRun = await database.query(
    `/* staging:pre-existing-run */
    SELECT COUNT(*) AS "rowCount"
    FROM reservations
    WHERE restaurant_id = $1::uuid AND customer_first_name LIKE $2`,
    [STAGING_DEMO_RESTAURANT_ID, `${stagingRunPrefix(runId)}%`],
  );
  const existingCount = numeric(
    (existingRun.rows[0] as { rowCount: string | number } | undefined)?.rowCount ?? -1,
  );
  if (existingCount !== 0) {
    throw new Error("Staging PRE baseline requires an unused run ID.");
  }

  const snapshot = await snapshotStagingLifecycle(database);
  return {
    version: 1,
    restaurantId: STAGING_DEMO_RESTAURANT_ID,
    runId,
    ...snapshot,
  };
}

export function parseStagingPreBaselineManifest(
  value: unknown,
): StagingPreBaselineManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Staging PRE baseline manifest is invalid.");
  }
  const manifest = value as Partial<StagingPreBaselineManifest>;
  if (
    manifest.version !== 1 ||
    manifest.restaurantId !== STAGING_DEMO_RESTAURANT_ID ||
    typeof manifest.runId !== "string" ||
    !manifest.families ||
    typeof manifest.fingerprint !== "string"
  ) {
    throw new Error("Staging PRE baseline manifest is invalid.");
  }
  const runId = assertValidStagingRunId(manifest.runId);
  const familyKeys = Object.keys(manifest.families).sort();
  if (
    familyKeys.join("\n") !== [...STAGING_LIFECYCLE_FAMILIES].sort().join("\n")
  ) {
    throw new Error("Staging PRE baseline manifest family inventory is invalid.");
  }

  for (const family of STAGING_LIFECYCLE_FAMILIES) {
    const snapshot = manifest.families[family];
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.count) ||
      snapshot.count < 0 ||
      !Array.isArray(snapshot.identities) ||
      snapshot.identities.length !== snapshot.count ||
      snapshot.identities.some(
        (identity) => typeof identity !== "string" || identity.length === 0,
      ) ||
      new Set(snapshot.identities).size !== snapshot.identities.length ||
      snapshot.identities.join("\n") !==
        [...snapshot.identities].sort().join("\n") ||
      !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    ) {
      throw new Error("Staging PRE baseline manifest family is invalid.");
    }
  }
  if (lifecycleFingerprint(manifest.families) !== manifest.fingerprint) {
    throw new Error("Staging PRE baseline manifest fingerprint is invalid.");
  }
  return { ...manifest, runId } as StagingPreBaselineManifest;
}

type RunVerificationRow = {
  reservationCount: string | number;
  confirmedCount: string | number;
  succeededOutboxCount: string | number;
  emailOutboxCount: string | number;
  attemptCount: string | number;
  successfulAttemptCount: string | number;
  receiptCount: string | number;
  simulatedWhatsappReceiptCount: string | number;
  providerReferenceCount: string | number;
};

export async function verifyStagingNotificationRun(
  database: StagingDatabase,
  runId: string,
) {
  const result = await database.query(
    `/* staging:verify-run */
    WITH run_reservations AS (
      SELECT id, status FROM reservations WHERE restaurant_id = $1::uuid AND customer_first_name LIKE $2
    ), run_outbox AS (
      SELECT * FROM notification_outbox WHERE restaurant_id = $1::uuid AND reservation_id IN (SELECT id FROM run_reservations) AND event_type::text = 'RESERVATION_CONFIRMED'
    )
    SELECT
      (SELECT COUNT(*) FROM run_reservations) AS "reservationCount",
      (SELECT COUNT(*) FROM run_reservations WHERE status::text = 'CONFIRMED') AS "confirmedCount",
      (SELECT COUNT(*) FROM run_outbox WHERE status::text = 'SUCCEEDED' AND channel::text = 'WHATSAPP') AS "succeededOutboxCount",
      (SELECT COUNT(*) FROM run_outbox WHERE channel::text = 'EMAIL') AS "emailOutboxCount",
      (SELECT COUNT(*) FROM notification_attempts WHERE outbox_id IN (SELECT id FROM run_outbox)) AS "attemptCount",
      (SELECT COUNT(*) FROM notification_attempts WHERE outbox_id IN (SELECT id FROM run_outbox) AND outcome::text = 'SUCCESS' AND provider_kind::text = 'SIMULATED_WHATSAPP') AS "successfulAttemptCount",
      (SELECT COUNT(*) FROM notification_simulation_receipts WHERE outbox_id IN (SELECT id FROM run_outbox)) AS "receiptCount",
      (SELECT COUNT(*) FROM notification_simulation_receipts WHERE outbox_id IN (SELECT id FROM run_outbox) AND provider_kind::text = 'SIMULATED_WHATSAPP') AS "simulatedWhatsappReceiptCount",
      (SELECT COUNT(*) FROM notification_simulation_receipts WHERE outbox_id IN (SELECT id FROM run_outbox) AND provider_reference IS NOT NULL AND provider_reference <> '') AS "providerReferenceCount"`,
    [STAGING_DEMO_RESTAURANT_ID, `${stagingRunPrefix(runId)}%`],
  );
  const row = result.rows[0] as RunVerificationRow | undefined;
  if (
    !row ||
    numeric(row.reservationCount) !== 1 ||
    numeric(row.confirmedCount) !== 1 ||
    numeric(row.succeededOutboxCount) !== 1 ||
    numeric(row.emailOutboxCount) !== 0 ||
    numeric(row.attemptCount) !== 1 ||
    numeric(row.successfulAttemptCount) !== 1 ||
    numeric(row.receiptCount) !== 1 ||
    numeric(row.simulatedWhatsappReceiptCount) !== 1 ||
    numeric(row.providerReferenceCount) !== 1
  ) {
    throw new Error("Staging notification acceptance run is incomplete.");
  }
  return { reservations: 1, outbox: 1, attempts: 1, receipts: 1, fallback: 0 };
}

type IdentityRow = { identity: string };
type CountRow = { rowCount: string | number };

const DIRECT_DEMO_TENANT_FAMILIES = new Set<StagingLifecycleFamily>([
  "audit_events",
  "reservation_idempotency_keys",
  "public_reservation_rate_limits",
  "service_instances",
  "service_room_availability",
]);

const CLEANUP_ORDER: readonly StagingLifecycleFamily[] = [
  "notification_simulation_receipts",
  "notification_attempts",
  "notification_outbox",
  "reservation_assignment_tables",
  "reservation_assignments",
  "reservation_audit_events",
  "audit_events",
  "reservation_management_tokens",
  "reservation_idempotency_keys",
  "sessions",
  "login_rate_limits",
  "public_reservation_rate_limits",
  "reservations",
  "service_room_availability",
  "service_instances",
];

function lifecycleDefinition(family: StagingLifecycleFamily): LifecycleDefinition {
  const definition = LIFECYCLE_DEFINITIONS.find(
    (candidate) => candidate.family === family,
  );
  if (!definition) throw new Error("Staging lifecycle family is unsupported.");
  return definition;
}

async function ownedNewIdentities(input: {
  database: StagingDatabase;
  family: StagingLifecycleFamily;
  newIdentities: string[];
  runPrefix: string;
}): Promise<string[]> {
  if (input.newIdentities.length === 0) return [];

  const definition = lifecycleDefinition(input.family);
  let from = definition.from;
  let ownership = "";
  let values: readonly unknown[] = [input.newIdentities];

  if (input.family === "reservations") {
    ownership =
      "t.restaurant_id = $2::uuid AND t.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "reservation_assignments") {
    from =
      "reservation_assignments t JOIN reservations r ON r.id = t.reservation_id AND r.restaurant_id = t.restaurant_id";
    ownership =
      "t.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "reservation_assignment_tables") {
    from =
      "reservation_assignment_tables t JOIN reservation_assignments a ON a.id = t.assignment_id AND a.restaurant_id = t.restaurant_id JOIN reservations r ON r.id = a.reservation_id AND r.restaurant_id = a.restaurant_id";
    ownership =
      "t.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "reservation_audit_events") {
    from =
      "reservation_audit_events t JOIN reservations r ON r.id = t.reservation_id AND r.restaurant_id = t.restaurant_id";
    ownership =
      "t.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "reservation_management_tokens") {
    from =
      "reservation_management_tokens t JOIN reservations r ON r.id = t.reservation_id";
    ownership =
      "r.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "notification_outbox") {
    from =
      "notification_outbox t JOIN reservations r ON r.id = t.reservation_id AND r.restaurant_id = t.restaurant_id";
    ownership =
      "t.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "notification_attempts") {
    from =
      "notification_attempts t JOIN notification_outbox o ON o.id = t.outbox_id AND o.restaurant_id = t.restaurant_id JOIN reservations r ON r.id = o.reservation_id AND r.restaurant_id = o.restaurant_id";
    ownership =
      "t.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "notification_simulation_receipts") {
    from =
      "notification_simulation_receipts t JOIN notification_outbox o ON o.id = t.outbox_id AND o.restaurant_id = t.restaurant_id JOIN reservations r ON r.id = o.reservation_id AND r.restaurant_id = o.restaurant_id";
    ownership =
      "t.restaurant_id = $2::uuid AND r.customer_first_name LIKE $3";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID, `${input.runPrefix}%`];
  } else if (input.family === "sessions") {
    from = "sessions t JOIN users u ON u.id = t.user_id";
    ownership = "u.restaurant_id = $2::uuid";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID];
  } else if (input.family === "login_rate_limits") {
    ownership = "TRUE";
  } else if (DIRECT_DEMO_TENANT_FAMILIES.has(input.family)) {
    ownership = "t.restaurant_id = $2::uuid";
    values = [input.newIdentities, STAGING_DEMO_RESTAURANT_ID];
  } else {
    throw new Error("Staging lifecycle ownership rule is missing.");
  }

  const result = await input.database.query(
    `/* staging:owned-new:${input.family} */
    SELECT ${definition.identityExpression} AS "identity"
    FROM ${from}
    WHERE ${definition.identityExpression} = ANY($1::text[]) AND ${ownership}
    ORDER BY ${definition.identityExpression}`,
    values,
  );
  return (result.rows as IdentityRow[]).map((row) => row.identity);
}

async function deleteLifecycleIdentities(
  database: StagingDatabase,
  family: StagingLifecycleFamily,
  identities: string[],
): Promise<number> {
  if (identities.length === 0) return 0;
  const definition = lifecycleDefinition(family);
  const result = await database.query(
    `/* staging:cleanup:${family} */
    DELETE FROM ${definition.table} t
    WHERE ${definition.identityExpression} = ANY($1::text[])`,
    [identities],
  );
  return numeric(result.rowCount ?? 0);
}

async function countRemainingOwnedRows(
  database: StagingDatabase,
  owned: Record<StagingLifecycleFamily, string[]>,
): Promise<number> {
  let total = 0;
  for (const family of STAGING_LIFECYCLE_FAMILIES) {
    const identities = owned[family];
    if (identities.length === 0) continue;
    const definition = lifecycleDefinition(family);
    const result = await database.query(
      `/* staging:count-owned-after:${family} */
      SELECT COUNT(*) AS "rowCount"
      FROM ${definition.from}
      WHERE ${definition.identityExpression} = ANY($1::text[])`,
      [identities],
    );
    total += numeric((result.rows[0] as CountRow | undefined)?.rowCount ?? -1);
  }
  return total;
}

export async function cleanupStagingRun(input: {
  database: StagingDatabase;
  runId: string;
  confirmation: string | undefined;
  preBaseline: StagingPreBaselineManifest;
}) {
  const runId = assertValidStagingRunId(input.runId);
  if (input.confirmation !== runId) {
    throw new Error("Cleanup requires exact run-scoped confirmation.");
  }
  const preBaseline = parseStagingPreBaselineManifest(input.preBaseline);
  if (preBaseline.runId !== runId) {
    throw new Error("Cleanup run ID does not match the PRE baseline manifest.");
  }

  await input.database.query("BEGIN");
  try {
    const current = await snapshotStagingLifecycle(input.database);
    const owned = {} as Record<StagingLifecycleFamily, string[]>;
    for (const family of STAGING_LIFECYCLE_FAMILIES) owned[family] = [];

    for (const family of STAGING_LIFECYCLE_FAMILIES) {
      const baselineIdentities = new Set(preBaseline.families[family].identities);
      const newIdentities = current.families[family].identities.filter(
        (identity) => !baselineIdentities.has(identity),
      );
      owned[family] = await ownedNewIdentities({
        database: input.database,
        family,
        newIdentities,
        runPrefix: stagingRunPrefix(runId),
      });
      if (owned[family].length !== newIdentities.length) {
        throw new Error(
          "Staging lifecycle contains new rows without proven run ownership.",
        );
      }
    }

    const deleted = Object.fromEntries(
      STAGING_LIFECYCLE_FAMILIES.map((family) => [family, 0]),
    ) as Record<StagingLifecycleFamily, number>;
    for (const family of CLEANUP_ORDER) {
      deleted[family] = await deleteLifecycleIdentities(
        input.database,
        family,
        owned[family],
      );
    }

    const runRowsAfter = await countRemainingOwnedRows(input.database, owned);
    const post = await snapshotStagingLifecycle(input.database);
    if (
      runRowsAfter !== 0 ||
      post.fingerprint !== preBaseline.fingerprint
    ) {
      throw new Error("Run cleanup PRE/POST invariant failed.");
    }
    await input.database.query("COMMIT");
    return {
      beforeFingerprint: preBaseline.fingerprint,
      afterFingerprint: post.fingerprint,
      runRowsAfter,
      deleted,
    };
  } catch (error) {
    await input.database.query("ROLLBACK");
    throw error;
  }
}
