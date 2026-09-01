import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { validateStagingWorkerEnvironment } from "./staging-config.mjs";
import {
  EXPECTED_STAGING_MIGRATION_COUNT,
  migrationSetIsReady,
  propagateWorkerSignal,
  waitForStagingSchemaReady,
} from "./staging-worker-startup.mjs";

const { Client } = pg;
const migrationsDirectory = fileURLToPath(
  new URL("../prisma/migrations/", import.meta.url),
);
const workerCliPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const workerEntryPath = fileURLToPath(
  new URL(
    "../src/modules/notifications/infrastructure/worker-cli.ts",
    import.meta.url,
  ),
);

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

async function readExpectedMigrationNames() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (names.length !== EXPECTED_STAGING_MIGRATION_COUNT) {
    throw new Error("The versioned migration inventory is not the expected size.");
  }
  return names;
}

async function main() {
  validateStagingWorkerEnvironment(process.env);
  const expectedMigrations = await readExpectedMigrationNames();
  const controller = new AbortController();
  let receivedSignal;
  let workerChild;
  const stop = (signal) => {
    receivedSignal ??= signal;
    controller.abort();
    if (workerChild) propagateWorkerSignal(workerChild, signal);
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    console.info("Waiting for the staging database schema.");
    await waitForStagingSchemaReady({
      signal: controller.signal,
      checkReady: async (signal) => {
        const client = new Client({
          connectionString: process.env.DATABASE_URL,
          connectionTimeoutMillis: 2_000,
          query_timeout: 2_000,
        });
        const abort = () => {
          void client.end();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await client.connect();
          const result = await client.query(
            'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
          );
          return migrationSetIsReady(
            result.rows.map((row) => row.migration_name),
            expectedMigrations,
          );
        } finally {
          signal.removeEventListener("abort", abort);
          await client.end().catch(() => undefined);
        }
      },
    });

    if (controller.signal.aborted) return signalExitCode(receivedSignal);
    console.info("Staging database schema is ready. Starting notification worker.");

    workerChild = spawn(
      process.execPath,
      [
        workerCliPath,
        "--conditions=react-server",
        workerEntryPath,
      ],
      { env: process.env, stdio: "inherit" },
    );

    return await new Promise((resolve, reject) => {
      workerChild.once("error", () => reject(new Error("Worker child failed to start.")));
      workerChild.once("exit", (code, signal) => {
        resolve(code ?? signalExitCode(signal ?? receivedSignal ?? "SIGTERM"));
      });
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return signalExitCode(receivedSignal ?? "SIGTERM");
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    console.error("Staging notification worker startup failed safely.");
    process.exitCode = 1;
  });
