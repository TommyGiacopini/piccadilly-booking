export const STAGING_SCHEMA_POLL_INTERVAL_MS = 2_000;
export const STAGING_SCHEMA_TIMEOUT_MS = 120_000;
export const EXPECTED_STAGING_MIGRATION_COUNT = 16;
export const EXPECTED_STAGING_MIGRATION_NAMES = Object.freeze([
  "20260731120000_create_restaurant_foundation",
  "20260802153732_add_authentication_users_sessions_rate_limits",
  "20260803090743_add_operational_configuration",
  "20260803141513_add_reservation_core",
  "20260810090000_add_public_booking_management",
  "20260810160000_add_authenticated_reservation_audit",
  "20260812090000_add_admin_audit_foundation",
  "20260812120000_add_user_lifecycle",
  "20260812160000_add_generic_booking_cutoff_rules",
  "20260812200000_add_service_instance_room_availability",
  "20260813123000_add_public_settings_and_content",
  "20260813190000_add_reservation_assignments",
  "20260828120000_add_notification_outbox_and_simulators",
  "20260930120000_add_reservation_arrival_lifecycle",
  "20261007120000_add_reservation_party_composition_and_game_room_preference",
  "20261014000000_add_reservation_private_notes",
]);

function createAbortError() {
  const error = new Error("Staging worker startup was interrupted.");
  error.name = "AbortError";
  return error;
}

export function waitForAbortableDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(createAbortError());
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function waitForStagingSchemaReady(options) {
  const pollIntervalMs = options.pollIntervalMs ?? STAGING_SCHEMA_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? STAGING_SCHEMA_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? waitForAbortableDelay;
  const deadline = now() + timeoutMs;

  while (true) {
    if (options.signal.aborted) throw createAbortError();

    try {
      const ready = await options.checkReady(options.signal);
      if (options.signal.aborted) throw createAbortError();
      if (ready && now() < deadline) return;
    } catch (error) {
      if (options.signal.aborted) throw createAbortError();
      if (error instanceof Error && error.name === "AbortError") throw error;
    }

    if (now() >= deadline) {
      throw new Error("Staging database schema readiness timed out.");
    }

    await sleep(Math.min(pollIntervalMs, deadline - now()), options.signal);
  }
}

export function migrationSetIsReady(appliedMigrationNames, expectedMigrationNames) {
  if (
    expectedMigrationNames.length !== EXPECTED_STAGING_MIGRATION_COUNT ||
    appliedMigrationNames.length !== EXPECTED_STAGING_MIGRATION_COUNT
  ) {
    return false;
  }

  const expected = [...expectedMigrationNames].sort();
  const applied = [...appliedMigrationNames].sort();
  if (
    new Set(expected).size !== EXPECTED_STAGING_MIGRATION_COUNT ||
    new Set(applied).size !== EXPECTED_STAGING_MIGRATION_COUNT
  ) {
    return false;
  }
  return expected.every(
    (migrationName, index) => migrationName === applied[index],
  );
}

// Classify the entire ledger. Filtering successful rows in SQL hides anomalies.
export function inspectMigrationLedger(rows, expectedMigrationNames) {
  const anomalies = new Set();
  if (!migrationSetIsReady(expectedMigrationNames, EXPECTED_STAGING_MIGRATION_NAMES)) anomalies.add("INVENTORY_INVALID");
  const names = rows.map((row) => row.migration_name);
  if (new Set(names).size !== names.length) anomalies.add("DUPLICATE");
  if (names.some((name) => !expectedMigrationNames.includes(name))) anomalies.add("UNEXPECTED");
  if (expectedMigrationNames.some((name) => !names.includes(name))) anomalies.add("MISSING");
  for (const row of rows) {
    if (row.rolled_back_at !== null) anomalies.add("ROLLED_BACK");
    if (typeof row.logs === "string" && row.logs.trim()) anomalies.add("FAILED");
    if (row.finished_at === null || row.finished_at === undefined) anomalies.add("INCOMPLETE");
  }
  if (!migrationSetIsReady(names, expectedMigrationNames)) anomalies.add("SET_MISMATCH");
  return { ready: anomalies.size === 0, anomalies: [...anomalies].sort() };
}

export function propagateWorkerSignal(child, signal) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}
