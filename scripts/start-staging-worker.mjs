import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import { validateStagingWorkerEnvironment } from "./staging-config.mjs";
import {
  EXPECTED_STAGING_MIGRATION_NAMES,
  inspectMigrationLedger,
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

export async function readExpectedMigrationNames(directory = migrationsDirectory) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid migration directory.");
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink() ||
    (!entry.isDirectory() && !(entry.name === "migration_lock.toml" && entry.isFile())))) {
    throw new Error("Invalid migration inventory entry.");
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (!migrationSetIsReady(names, EXPECTED_STAGING_MIGRATION_NAMES)) {
    throw new Error("The versioned migration inventory is not the approved set.");
  }
  for (const name of names) {
    const folder = await lstat(join(directory, name));
    const sqlPath = join(directory, name, "migration.sql");
    const before = await lstat(sqlPath);
    if (!folder.isDirectory() || folder.isSymbolicLink() || !before.isFile() || before.isSymbolicLink()) {
      throw new Error("Migration SQL must be a regular file.");
    }
    const file = await open(sqlPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      const after = await lstat(sqlPath);
      if (!opened.isFile() || after.isSymbolicLink() || opened.ino !== before.ino ||
        opened.dev !== before.dev || after.ino !== opened.ino || after.dev !== opened.dev ||
        !(await file.readFile("utf8")).trim()) throw new Error("Migration SQL is invalid or empty.");
    } finally { await file.close(); }
  }
  return names;
}

export async function runStagingWorker(options = {}) {
  const environment = options.environment ?? process.env;
  const processHost = options.processHost ?? process;
  const createClient = options.createClient ?? ((config) => new Client(config));
  const spawnProcess = options.spawnProcess ?? spawn;
  validateStagingWorkerEnvironment(environment);
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
  processHost.once("SIGINT", onSigint);
  processHost.once("SIGTERM", onSigterm);

  try {
    const expectedMigrations = await (options.readInventory ?? readExpectedMigrationNames)();
    console.info("Waiting for the staging database schema.");
    await waitForStagingSchemaReady({
      ...options.waitOptions,
      signal: controller.signal,
      checkReady: async (signal) => {
        const client = createClient({
          connectionString: environment.DATABASE_URL,
          connectionTimeoutMillis: 2_000,
          query_timeout: 2_000,
        });
        const abort = () => {
          void client.end().catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await client.connect();
          const result = await client.query(
            'SELECT migration_name, finished_at, rolled_back_at, logs FROM "_prisma_migrations"',
          );
          const readiness = inspectMigrationLedger(result.rows, expectedMigrations);
          if (!readiness.ready) console.info("Staging schema is not ready: " + readiness.anomalies.join(",") + ".");
          return readiness.ready;
        } finally {
          signal.removeEventListener("abort", abort);
          await client.end().catch(() => undefined);
        }
      },
    });

    if (controller.signal.aborted) return signalExitCode(receivedSignal);
    console.info("Staging database schema is ready. Starting notification worker.");

    workerChild = spawnProcess(
      process.execPath,
      [
        workerCliPath,
        "--conditions=react-server",
        workerEntryPath,
      ],
      { env: environment, stdio: "inherit" },
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
    processHost.removeListener("SIGINT", onSigint);
    processHost.removeListener("SIGTERM", onSigterm);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runStagingWorker()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    console.error("Staging notification worker startup failed safely.");
    process.exitCode = 1;
  });
