import { createHash } from "node:crypto";

import { resolveAppEnvironment } from "../src/shared/config/app-environment";

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
  recordType: "restaurant" | "public-settings" | "reservation" | "destination";
  restaurantId: string;
  nameValue: string | null;
  phoneValue: string | null;
  secondaryPhoneValue: string | null;
  emailValue: string | null;
  urlValue: string | null;
  textValue: string | null;
  channelValue: string | null;
};

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
  const result = await database.query(
    `/* staging:fake-data-scan */
    SELECT 'restaurant'::text AS "recordType", r.id::text AS "restaurantId", r.name AS "nameValue", NULL::text AS "phoneValue", NULL::text AS "secondaryPhoneValue", NULL::text AS "emailValue", NULL::text AS "urlValue", r.timezone AS "textValue", NULL::text AS "channelValue"
      FROM restaurants r
    UNION ALL
    SELECT 'public-settings', ps.restaurant_id::text, NULL, ps.public_phone, ps.whatsapp_number, ps.public_email, ps.public_booking_base_url, NULL, NULL
      FROM restaurant_public_settings ps
    UNION ALL
    SELECT 'reservation', x.restaurant_id::text, x.customer_first_name || ' ' || x.customer_last_name, x.customer_phone, NULL, x.customer_email, NULL, concat_ws(' ', x.preferences, x.notes, x.allergies, x.capacity_override_reason), NULL
      FROM reservations x
    UNION ALL
    SELECT 'destination', n.restaurant_id::text, NULL, CASE WHEN n.channel::text = 'WHATSAPP' THEN n.destination END, NULL, CASE WHEN n.channel::text = 'EMAIL' THEN n.destination END, NULL, NULL, n.channel::text
      FROM notification_outbox n`,
  );
  const rows = result.rows as FakeDataRow[];
  const violations = new Map<string, number>();
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
    if (row.secondaryPhoneValue && !isFakePhone(row.secondaryPhoneValue)) {
      addViolation(violations, "non-fake-phone");
    }
    if (!isExampleTestEmail(row.emailValue)) {
      addViolation(violations, "non-fake-email");
    }
    if (row.urlValue && !isOnrenderRootUrl(row.urlValue)) {
      addViolation(violations, "non-staging-hostname");
    }
    if (
      row.recordType === "reservation" &&
      (!row.nameValue || !row.nameValue.split(" ").every((name) => name.startsWith("M13-")))
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
