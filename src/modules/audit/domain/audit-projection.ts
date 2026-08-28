import { z } from "zod";

import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_OUTCOMES, type AuditAction } from "@/modules/audit/domain/audit-event";
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_ENTITY_TYPES,
  AUDIT_LIST_ACTIONS,
  AUDIT_LIST_CATEGORIES,
  AUDIT_SOURCE_RANK,
  AUDIT_SOURCES,
  RESERVATION_AUDIT_ACTIONS,
  type AuditActorKind,
  type AuditListAction,
  type AuditListCategory,
  type AuditListOutcome,
  type AuditSource,
} from "@/modules/audit/domain/audit-query";
import { PUBLIC_CONTENT_KEYS, PUBLIC_CONTENT_LOCALES } from "@/modules/configuration/domain/public-settings";

const roleSchema = z.enum(["ADMIN", "STAFF"]);
const actorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
const sourceSchema = z.enum(AUDIT_SOURCES);
const categorySchema = z.enum(AUDIT_LIST_CATEGORIES);
const actionSchema = z.enum(AUDIT_LIST_ACTIONS);
const outcomeSchema = z.enum(AUDIT_OUTCOMES);
const entityTypeSchema = z.enum(AUDIT_ENTITY_TYPES);
const uuidSchema = z.uuid();

export interface AuditListDatabaseRow {
  source: string;
  sourceRank: number;
  eventId: string;
  occurredAt: Date;
  category: string;
  action: string;
  outcome: string;
  actorKind: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  actorRole: string | null;
  entityType: string | null;
  entityId: string | null;
  correlationId: string;
}

export interface AuditListItemDto {
  source: AuditSource;
  eventId: string;
  occurredAt: string;
  category: AuditListCategory;
  action: AuditListAction;
  outcome: AuditListOutcome;
  actorKind: AuditActorKind;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: "ADMIN" | "STAFF";
  entityType?: string;
  entityId?: string;
  correlationId: string;
  summary: string;
}

export interface AuditDetailFieldDto {
  key: string;
  label: string;
  value: string | number | boolean;
}

export interface AuditDetailDto extends AuditListItemDto {
  previousState: AuditDetailFieldDto[];
  newState: AuditDetailFieldDto[];
  metadata: AuditDetailFieldDto[];
}

export interface AuditDetailDatabaseRecord extends AuditListDatabaseRow {
  previousState: unknown;
  newState: unknown;
  metadata: unknown;
}

const actionLabels: Record<AuditListAction, string> = {
  CREATED: "Prenotazione creata",
  UPDATED: "Prenotazione aggiornata",
  CANCELLED: "Prenotazione cancellata",
  ASSIGNED: "Sala e tavoli assegnati",
  REASSIGNED: "Assegnazione sala e tavoli aggiornata",
  UNASSIGNED: "Assegnazione sala e tavoli rimossa",
  LOGIN_SUCCEEDED: "Accesso riuscito",
  LOGIN_FAILED: "Accesso non riuscito",
  LOGIN_RATE_LIMITED: "Accesso limitato",
  LOGOUT_SUCCEEDED: "Disconnessione riuscita",
  USER_CREATED: "Utente creato",
  USER_ROLE_CHANGED: "Ruolo utente modificato",
  USER_ENABLED: "Utente abilitato",
  USER_DISABLED: "Utente disabilitato",
  USER_PASSWORD_RESET: "Password utente reimpostata",
  PASSWORD_CHANGED: "Password modificata",
  BOOKING_SETTINGS_UPDATED: "Impostazioni prenotazione aggiornate",
  ROOM_UPDATED: "Sala aggiornata",
  ROOM_AVAILABILITY_UPDATED: "Disponibilità sala aggiornata",
  ROOM_DISABLED: "Sala disabilitata",
  ROOM_ENABLED: "Sala abilitata",
  ROOM_ORDER_UPDATED: "Ordine sale aggiornato",
  DINING_TABLE_CREATED: "Tavolo creato",
  DINING_TABLE_UPDATED: "Tavolo aggiornato",
  DINING_TABLE_DISABLED: "Tavolo disabilitato",
  DINING_TABLE_ENABLED: "Tavolo abilitato",
  WEEKLY_SCHEDULE_UPDATED: "Orario settimanale aggiornato",
  PUBLIC_BOOKING_CUTOFF_RULE_CREATED: "Regola cutoff creata",
  PUBLIC_BOOKING_CUTOFF_RULE_UPDATED: "Regola cutoff aggiornata",
  PUBLIC_BOOKING_CUTOFF_RULE_DISABLED: "Regola cutoff disabilitata",
  SPECIAL_DATE_CREATED: "Data speciale creata",
  SPECIAL_DATE_UPDATED: "Data speciale aggiornata",
  SPECIAL_DATE_ARCHIVED: "Data speciale archiviata",
  SPECIAL_DATE_REACTIVATED: "Data speciale riattivata",
  PUBLIC_CONTACTS_UPDATED: "Contatti pubblici aggiornati",
  PUBLIC_CONTENT_UPDATED: "Contenuti pubblici aggiornati",
  MANAGEMENT_LINK_DURATION_UPDATED: "Durata link aggiornata",
  PDF_EXPORT_REQUESTED: "Esportazione PDF richiesta",
  EXCEL_EXPORT_REQUESTED: "Esportazione Excel richiesta",
};

function parseListHeader(row: AuditListDatabaseRow): AuditListItemDto | null {
  const parsed = z
    .object({
      source: sourceSchema,
      eventId: uuidSchema,
      occurredAt: z.date(),
      category: categorySchema,
      action: actionSchema,
      outcome: outcomeSchema,
      actorKind: actorKindSchema,
      actorUserId: uuidSchema.nullable(),
      actorDisplayName: z.string().max(64).nullable(),
      actorRole: roleSchema.nullable(),
      entityType: entityTypeSchema.nullable(),
      entityId: uuidSchema.nullable(),
      correlationId: uuidSchema,
    })
    .safeParse(row);
  if (!parsed.success || Number.isNaN(parsed.data.occurredAt.getTime())) return null;

  const value = parsed.data;
  if (
    (value.source === "RESERVATION" &&
      (!RESERVATION_AUDIT_ACTIONS.includes(value.action as never) ||
        value.category !== "RESERVATION" ||
        value.outcome !== "SUCCESS")) ||
    (value.source === "ADMINISTRATIVE" &&
      (!AUDIT_ACTIONS.includes(value.action as never) ||
        !AUDIT_CATEGORIES.includes(value.category as never)))
  ) {
    return null;
  }

  return {
    source: value.source,
    eventId: value.eventId,
    occurredAt: value.occurredAt.toISOString(),
    category: value.category,
    action: value.action,
    outcome: value.outcome,
    actorKind: value.actorKind,
    ...(value.actorUserId ? { actorUserId: value.actorUserId } : {}),
    ...(value.actorKind === "USER"
      ? { actorDisplayName: value.actorDisplayName ?? "Utente non disponibile" }
      : {}),
    ...(value.actorRole ? { actorRole: value.actorRole } : {}),
    ...(value.entityType ? { entityType: value.entityType } : {}),
    ...(value.entityId ? { entityId: value.entityId } : {}),
    correlationId: value.correlationId,
    summary: actionLabels[value.action],
  };
}

export function projectAuditListRow(row: AuditListDatabaseRow): AuditListItemDto | null {
  return parseListHeader(row);
}

type SafeValue = string | number | boolean;
type ValueParser = (value: unknown) => SafeValue | null;

interface FieldRule {
  path: string;
  label: string;
  parse: ValueParser;
}

function scalarParser(schema: z.ZodType<SafeValue>): ValueParser {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

function enumArrayParser(values: readonly string[]): ValueParser {
  const allowed = new Set(values);
  return (value) =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && allowed.has(item))
      ? value.join(", ")
      : null;
}

function uuidArrayParser(value: unknown): SafeValue | null {
  const parsed = z.array(z.uuid()).min(1).max(20).safeParse(value);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    return null;
  }
  return [...parsed.data].sort((left, right) => left.localeCompare(right)).join(", ");
}

const bool = scalarParser(z.boolean());
const count = scalarParser(z.number().int().min(0).max(1_000_000));
const positiveCount = scalarParser(z.number().int().min(1).max(1_000_000));
const localDate = scalarParser(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
const localTime = scalarParser(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/));
const uuid = scalarParser(z.uuid());
const serviceType = scalarParser(z.enum(["LUNCH", "DINNER"]));
const userRole = scalarParser(roleSchema);
const roomCode = scalarParser(z.enum(["sala-1", "sala-2", "sala-3", "galleria", "terrazzo"]));
const dayOfWeek = scalarParser(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]));
const classification = scalarParser(z.enum([
  "SERVICE_DISABLED",
  "OUTSIDE_NEW_HOURS",
  "CAPACITY_EXCEEDED",
  "MODIFICATION_CUTOFF_CHANGED",
  "ROOM_UNAVAILABLE",
  "ROOM_DISABLED",
  "TABLE_DISABLED",
  "RESERVATION_WITH_AFFECTED_ROOM_PREFERENCE",
  "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT",
  "NO_EXISTING_RESERVATION_IMPACT",
]));

function rule(path: string, label: string, parse: ValueParser): FieldRule {
  return { path, label, parse };
}

const reservationRules = [
  rule("localDate", "Data", localDate),
  rule("serviceType", "Servizio", serviceType),
  rule("arrivalTime", "Orario", localTime),
  rule("partySize", "Persone", positiveCount),
  rule("status", "Stato", scalarParser(z.enum(["CONFIRMED", "CANCELLED"]))),
  rule("origin", "Origine", scalarParser(z.enum(["STAFF", "PHONE", "PUBLIC"]))),
  rule("version", "Versione", positiveCount),
  rule("requests.roomCode", "Codice sala", roomCode),
  rule("requests.legacyPreferencePresent", "Preferenza legacy presente", bool),
  rule("requests.highChair", "Seggiolone", bool),
  rule("requests.stroller", "Passeggino", bool),
  rule("requests.accessibility", "Accessibilità", bool),
  rule("requests.children", "Bambini", bool),
  rule("requests.celiac", "Celiachia presente", bool),
  rule("requests.foodRequestsPresent", "Esigenze alimentari presenti", bool),
  rule("requests.allergiesPresent", "Allergie presenti", bool),
  rule("requests.intolerancesPresent", "Intolleranze presenti", bool),
  rule("requests.celebrationPresent", "Ricorrenza presente", bool),
  rule("requests.animals", "Animali", bool),
  rule("requests.notesPresent", "Note presenti", bool),
  rule("capacityOverride", "Override capacità", bool),
] as const;
const reservationAssignmentRules = [
  rule("assignment.finalRoomCode", "Sala finale", roomCode),
  rule("assignment.tableIds", "ID tavoli", uuidArrayParser),
  rule("assignment.tableCount", "Numero tavoli", positiveCount),
  rule("assignment.internalNotesPresent", "Note interne presenti", bool),
  rule(
    "reason",
    "Motivo rimozione",
    scalarParser(z.literal("RESERVATION_SCHEDULE_CHANGED")),
  ),
] as const;

const identityStateRules = [
  rule("role", "Ruolo", userRole),
  rule("isActive", "Attivo", bool),
  rule("disabledAtPresent", "Disabilitazione presente", bool),
  rule("mustChangePassword", "Cambio password obbligatorio", bool),
] as const;
const identityMetadataRules = [
  rule("revokedSessionCount", "Sessioni revocate", count),
  rule("flowType", "Flusso", scalarParser(z.enum([
    "ADMIN_CREATE",
    "ADMIN_ROLE_CHANGE",
    "ADMIN_ENABLE",
    "ADMIN_DISABLE",
    "ADMIN_PASSWORD_RESET",
    "PERSONAL_PASSWORD_CHANGE",
  ]))),
] as const;
const bookingRules = [
  rule("rollingCapacityCovers", "Limite coperti", positiveCount),
  rule("rollingWindowMinutes", "Finestra minuti", positiveCount),
  rule("lunchModificationCutoff", "Cutoff pranzo", localTime),
  rule("dinnerModificationCutoff", "Cutoff cena", localTime),
  rule("managementLinkDurationHours", "Durata link (ore)", positiveCount),
] as const;
const scheduleRules = [
  rule("dayOfWeek", "Giorno", dayOfWeek),
  rule("serviceType", "Servizio", serviceType),
  rule("isEnabled", "Abilitato", bool),
  rule("startTime", "Inizio", localTime),
  rule("endTime", "Fine", localTime),
  rule("slotIntervalMinutes", "Intervallo slot", positiveCount),
] as const;
const cutoffRules = [
  ...scheduleRules.slice(0, 3),
  rule("cutoffTime", "Cutoff", localTime),
] as const;
const roomRules = [
  rule("code", "Codice sala", roomCode),
  rule("displayOrder", "Ordine", count),
  rule("isActive", "Attiva", bool),
] as const;
const availabilityRules = [
  rule("localDate", "Data", localDate),
  rule("serviceType", "Servizio", serviceType),
  rule("roomCode", "Codice sala", roomCode),
  rule("isAvailable", "Disponibile", bool),
] as const;
const tableRules = [
  rule("roomId", "ID sala", uuid),
  rule("minimumSeats", "Posti minimi", positiveCount),
  rule("maximumSeats", "Posti massimi", positiveCount),
  rule("displayOrder", "Ordine", count),
  rule("isActive", "Attivo", bool),
] as const;
const specialDateRules = [
  rule("date", "Data", localDate),
  rule("scope", "Ambito", scalarParser(z.enum(["ALL", "LUNCH", "DINNER"]))),
  rule("isClosed", "Chiuso", bool),
  rule("specialStartTime", "Inizio speciale", localTime),
  rule("specialEndTime", "Fine speciale", localTime),
  rule("specialCapacityCovers", "Capacità speciale", positiveCount),
  rule("operationalNotesPresent", "Note operative presenti", bool),
  rule("archived", "Archiviata", bool),
] as const;
const publicContactRules = [
  rule("phoneConfigured", "Telefono configurato", bool),
  rule("emailConfigured", "Email configurata", bool),
  rule("whatsappConfigured", "WhatsApp configurato", bool),
  rule("urlConfigured", "URL configurato", bool),
] as const;
const publicContentRules = [
  rule("complete", "Set completo", bool),
  rule("locales", "Lingue", enumArrayParser(PUBLIC_CONTENT_LOCALES)),
  rule("keys", "Chiavi", enumArrayParser(PUBLIC_CONTENT_KEYS)),
] as const;
const durationRules = [rule("managementLinkDurationHours", "Durata link (ore)", positiveCount)] as const;
const exportCommonMetadataRules = [
  rule("format", "Formato", scalarParser(z.enum(["PDF", "EXCEL"]))),
  rule("mode", "Modalità", scalarParser(z.enum(["DAY", "MONTH", "RANGE"]))),
  rule("fromDate", "Data iniziale", localDate),
  rule("toDate", "Data finale", localDate),
  rule("dayCount", "Giorni", positiveCount),
] as const;
const exportSuccessMetadataRules = [
  ...exportCommonMetadataRules,
  rule("reservationCount", "Prenotazioni", count),
] as const;
const exportFailureMetadataRules = [
  ...exportCommonMetadataRules,
  rule(
    "failureCode",
    "Codice errore",
    scalarParser(
      z.enum([
        "GENERATION_FAILED",
        "EXPORT_TOO_LARGE",
        "EXPORT_RANGE_TOO_LARGE",
      ]),
    ),
  ),
] as const;
const impactRules = [
  rule("reservationCount", "Prenotazioni coinvolte", count),
  rule("covers", "Coperti coinvolti", count),
  rule("classification", "Classificazione", classification),
  rule("classifications", "Classificazioni", enumArrayParser([
    "SERVICE_DISABLED",
    "OUTSIDE_NEW_HOURS",
    "CAPACITY_EXCEEDED",
    "MODIFICATION_CUTOFF_CHANGED",
    "ROOM_UNAVAILABLE",
    "ROOM_DISABLED",
    "TABLE_DISABLED",
    "RESERVATION_WITH_AFFECTED_ROOM_PREFERENCE",
    "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT",
    "NO_EXISTING_RESERVATION_IMPACT",
  ])),
  rule("preferenceReservationCount", "Preferenze coinvolte", count),
  rule("assignmentReservationCount", "Assegnazioni coinvolte", count),
  rule("previousLimit", "Limite precedente", count),
  rule("proposedLimit", "Limite proposto", count),
  rule("maxLoad", "Carico massimo", count),
  rule("instanceMaterialized", "Istanza materializzata", bool),
  rule("existingTokensAffected", "Token esistenti coinvolti", count),
] as const;

const stateRulesByAction: Record<AuditAction, readonly FieldRule[]> = {
  LOGIN_SUCCEEDED: [],
  LOGIN_FAILED: [],
  LOGIN_RATE_LIMITED: [],
  LOGOUT_SUCCEEDED: [],
  USER_CREATED: identityStateRules,
  USER_ROLE_CHANGED: identityStateRules,
  USER_ENABLED: identityStateRules,
  USER_DISABLED: identityStateRules,
  USER_PASSWORD_RESET: identityStateRules,
  PASSWORD_CHANGED: identityStateRules,
  BOOKING_SETTINGS_UPDATED: bookingRules,
  ROOM_UPDATED: roomRules,
  ROOM_AVAILABILITY_UPDATED: availabilityRules,
  ROOM_DISABLED: roomRules,
  ROOM_ENABLED: roomRules,
  ROOM_ORDER_UPDATED: roomRules,
  DINING_TABLE_CREATED: tableRules,
  DINING_TABLE_UPDATED: tableRules,
  DINING_TABLE_DISABLED: tableRules,
  DINING_TABLE_ENABLED: tableRules,
  WEEKLY_SCHEDULE_UPDATED: scheduleRules,
  PUBLIC_BOOKING_CUTOFF_RULE_CREATED: cutoffRules,
  PUBLIC_BOOKING_CUTOFF_RULE_UPDATED: cutoffRules,
  PUBLIC_BOOKING_CUTOFF_RULE_DISABLED: cutoffRules,
  SPECIAL_DATE_CREATED: specialDateRules,
  SPECIAL_DATE_UPDATED: specialDateRules,
  SPECIAL_DATE_ARCHIVED: specialDateRules,
  SPECIAL_DATE_REACTIVATED: specialDateRules,
  PUBLIC_CONTACTS_UPDATED: publicContactRules,
  PUBLIC_CONTENT_UPDATED: publicContentRules,
  MANAGEMENT_LINK_DURATION_UPDATED: durationRules,
  PDF_EXPORT_REQUESTED: [],
  EXCEL_EXPORT_REQUESTED: [],
};

function getPath(root: unknown, path: string): unknown {
  let value = root;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function sanitizeFields(root: unknown, rules: readonly FieldRule[]): AuditDetailFieldDto[] {
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  return rules.flatMap((field) => {
    const value = field.parse(getPath(root, field.path));
    return value === null ? [] : [{ key: field.path, label: field.label, value }];
  });
}

function contentChangeFields(metadata: unknown): AuditDetailFieldDto[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const changed = (metadata as Record<string, unknown>).changed;
  if (!Array.isArray(changed)) return [];
  const allowedLocales = new Set<string>(PUBLIC_CONTENT_LOCALES);
  const allowedKeys = new Set<string>(PUBLIC_CONTENT_KEYS);
  const values: string[] = [];
  for (const item of changed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { locale, keys } = item as Record<string, unknown>;
    if (
      typeof locale !== "string" ||
      !allowedLocales.has(locale) ||
      !Array.isArray(keys) ||
      !keys.every((key) => typeof key === "string" && allowedKeys.has(key))
    ) return [];
    values.push(`${locale}: ${keys.join(", ")}`);
  }
  return values.length > 0
    ? [{ key: "changed", label: "Chiavi editoriali modificate", value: values.join("; ") }]
    : [];
}

function metadataRules(
  action: AuditListAction,
  outcome: AuditListItemDto["outcome"],
): readonly FieldRule[] {
  if (action === "PDF_EXPORT_REQUESTED" || action === "EXCEL_EXPORT_REQUESTED") {
    if (outcome === "SUCCESS") return exportSuccessMetadataRules;
    if (outcome === "FAILURE") return exportFailureMetadataRules;
    return exportCommonMetadataRules;
  }
  if (action.startsWith("USER_") || action === "PASSWORD_CHANGED") return identityMetadataRules;
  if (action === "PUBLIC_CONTENT_UPDATED") return [];
  if (action === "PUBLIC_CONTACTS_UPDATED") {
    return [rule("changedFields", "Campi modificati", enumArrayParser([
      "publicPhone",
      "publicBookingBaseUrl",
      "publicEmail",
      "whatsappNumber",
    ]))];
  }
  return impactRules;
}

export function projectAuditDetail(record: AuditDetailDatabaseRecord): AuditDetailDto | null {
  const header = parseListHeader(record);
  if (!header) return null;
  const stateRules = header.source === "RESERVATION"
    ? header.action === "ASSIGNED" ||
      header.action === "REASSIGNED" ||
      header.action === "UNASSIGNED"
      ? reservationAssignmentRules
      : reservationRules
    : stateRulesByAction[header.action as AuditAction];
  if (!stateRules) return null;
  const metadata = header.source === "RESERVATION"
    ? []
    : header.action === "PUBLIC_CONTENT_UPDATED"
      ? contentChangeFields(record.metadata)
      : sanitizeFields(record.metadata, metadataRules(header.action, header.outcome));
  return {
    ...header,
    previousState: sanitizeFields(record.previousState, stateRules),
    newState: sanitizeFields(record.newState, stateRules),
    metadata,
  };
}

export function auditSourceRank(source: AuditSource): 1 | 2 {
  return AUDIT_SOURCE_RANK[source];
}
