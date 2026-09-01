export const STAGING_SCHEMA_POLL_INTERVAL_MS = 2_000;
export const STAGING_SCHEMA_TIMEOUT_MS = 120_000;
export const EXPECTED_STAGING_MIGRATION_COUNT = 13;

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
      if (await options.checkReady(options.signal)) return;
    } catch (error) {
      if (options.signal.aborted) throw createAbortError();
      if (error instanceof Error && error.name === "AbortError") throw error;
    }

    if (now() >= deadline) {
      throw new Error("Staging database schema readiness timed out.");
    }

    await sleep(pollIntervalMs, options.signal);
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

export function propagateWorkerSignal(child, signal) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}
