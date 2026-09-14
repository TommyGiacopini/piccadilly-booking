import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { isIP } from "node:net";
import { delimiter as pathDelimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

const { Client } = pg;

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const prismaCliPath = fileURLToPath(
  new URL("../node_modules/prisma/build/index.js", import.meta.url),
);
const vitestCliPath = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const projectBinPath = fileURLToPath(
  new URL("../node_modules/.bin", import.meta.url),
);

export const TEMP_DATABASE_NAME_PATTERN =
  /^piccadilly_vitest_[0-9a-f]{32}$/u;
export const EXPECTED_MIGRATION_COUNT = 13;

const CHILD_OS_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
];

const TEST_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";

export class IsolatedVitestSafetyError extends Error {
  constructor(code) {
    super("The isolated Vitest runner rejected an unsafe configuration.");
    this.name = "IsolatedVitestSafetyError";
    this.code = code;
  }
}

function normalizedHostname(hostname) {
  const lower = hostname.trim().toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

export function isLoopbackPostgresHost(hostname) {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const [firstOctet] = normalized.split(".").map(Number);
  return firstOctet === 127;
}

export function assertTemporaryDatabaseName(databaseName) {
  if (!TEMP_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new IsolatedVitestSafetyError("TEMP_DATABASE_NAME_INVALID");
  }
  return databaseName;
}

export function createTemporaryDatabaseName(random = randomBytes) {
  return assertTemporaryDatabaseName(
    `piccadilly_vitest_${random(16).toString("hex")}`,
  );
}

function databaseNameFromUrl(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (!/^\/[A-Za-z0-9_-]+$/u.test(pathname)) {
    throw new IsolatedVitestSafetyError("SOURCE_DATABASE_NAME_INVALID");
  }
  return pathname.slice(1);
}

function parsePostgresUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new IsolatedVitestSafetyError("DATABASE_URL_INVALID");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new IsolatedVitestSafetyError("DATABASE_URL_INVALID");
  }
  return parsed;
}

export function resolveIsolatedVitestPlan(environment, targetDatabaseName) {
  if (environment.APP_ENV !== "development") {
    throw new IsolatedVitestSafetyError("APP_ENV_NOT_DEVELOPMENT");
  }
  if (
    environment.RENDER !== undefined ||
    environment.RENDER_SERVICE_ID !== undefined ||
    environment.RENDER_EXTERNAL_URL !== undefined
  ) {
    throw new IsolatedVitestSafetyError("RENDER_ENVIRONMENT_REJECTED");
  }

  const sourceUrl = parsePostgresUrl(environment.DATABASE_URL ?? "");
  if (!isLoopbackPostgresHost(sourceUrl.hostname)) {
    throw new IsolatedVitestSafetyError("SOURCE_DATABASE_NOT_LOOPBACK");
  }

  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
  const safeTargetDatabaseName =
    assertTemporaryDatabaseName(targetDatabaseName);
  if (sourceDatabaseName === safeTargetDatabaseName) {
    throw new IsolatedVitestSafetyError("TARGET_MATCHES_SOURCE_DATABASE");
  }

  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${safeTargetDatabaseName}`;
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = "/postgres";

  return {
    sourceDatabaseName,
    targetDatabaseName: safeTargetDatabaseName,
    sourceUrl,
    targetUrl,
    maintenanceUrl,
  };
}

function quoteDatabaseIdentifier(databaseName) {
  return `"${assertTemporaryDatabaseName(databaseName)}"`;
}

export function redactRunnerOutput(value, secrets = []) {
  let sanitized = String(value).replace(
    /postgres(?:ql)?:\/\/[^\s"']+/giu,
    "[REDACTED_DATABASE_URL]",
  );
  for (const secret of [...secrets].sort(
    (left, right) => right.length - left.length,
  )) {
    if (typeof secret === "string" && secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  return sanitized;
}

export function isSensitiveEnvironmentVariableName(name) {
  const normalized = name.trim().toUpperCase();
  return (
    /(^|_)(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|CREDENTIALS)(?:_|$)/u.test(
      normalized,
    ) ||
    /(^|_)(?:DATABASE_URL|CONNECTION_STRING)(?:_|$)/u.test(normalized)
  );
}

function addDecodedSecret(secrets, value) {
  if (!value) return;
  secrets.add(value);
  try {
    secrets.add(decodeURIComponent(value));
  } catch {
    // The encoded form is still covered when percent-decoding is invalid.
  }
}

export function collectChildEnvironmentSecrets(childEnvironment) {
  const secrets = new Set();
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (isSensitiveEnvironmentVariableName(name)) secrets.add(value);

    if (!value.includes("://")) continue;
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) {
        secrets.add(value);
        addDecodedSecret(secrets, parsed.username);
        addDecodedSecret(secrets, parsed.password);
      }
    } catch {
      // Non-URL values remain covered by their sensitive variable name.
    }
  }
  return [...secrets];
}

function environmentValue(environment, expectedName) {
  const match = Object.entries(environment).find(
    ([name, value]) =>
      name.toUpperCase() === expectedName.toUpperCase() &&
      typeof value === "string" &&
      value.length > 0,
  );
  return match?.[1];
}

export function buildIsolatedVitestChildEnvironment(environment, input) {
  const childEnvironment = {};
  for (const name of CHILD_OS_ENVIRONMENT_KEYS) {
    if (name === "PATH") continue;
    const value = environmentValue(environment, name);
    if (value !== undefined) childEnvironment[name] = value;
  }
  const inheritedPath = environmentValue(environment, "PATH");
  childEnvironment.PATH = inheritedPath
    ? `${projectBinPath}${pathDelimiter}${inheritedPath}`
    : projectBinPath;

  return {
    ...childEnvironment,
    APP_ENV: "development",
    NODE_ENV: "test",
    DATABASE_URL: input.databaseUrl,
    AUTH_RESTAURANT_ID: TEST_RESTAURANT_ID,
    AUTH_RATE_LIMIT_SECRET: input.authRateLimitSecret,
    AUTH_TRUST_PROXY: "false",
    AUTH_DEMO_ADMIN_PASSWORD: input.adminPassword,
    AUTH_DEMO_STAFF_PASSWORD: input.staffPassword,
    RESERVATION_PRIVACY_POLICY_VERSION: "isolated-vitest-privacy-v1",
    RESERVATION_TERMS_VERSION: "isolated-vitest-terms-v1",
    RESERVATION_IDEMPOTENCY_TTL_HOURS: "24",
    PUBLIC_BOOKING_MANAGEMENT_SECRET: input.publicManagementSecret,
    PUBLIC_BOOKING_RATE_LIMIT_SECRET: input.publicRateLimitSecret,
    PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS: "900",
    PUBLIC_BOOKING_READ_LIMIT: "10000",
    PUBLIC_BOOKING_MUTATION_LIMIT: "10000",
  };
}

function safeLog(logger, event) {
  try {
    logger(event);
  } catch {
    // Evidence logging must never change database cleanup semantics.
  }
}

function defaultLogger(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function withClient(connectionString, operation) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(plan) {
  await withClient(plan.maintenanceUrl.href, (client) =>
    client.query(
      `CREATE DATABASE ${quoteDatabaseIdentifier(plan.targetDatabaseName)}`,
    ),
  );
}

async function dropDatabase(plan) {
  await withClient(plan.maintenanceUrl.href, async (client) => {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [plan.targetDatabaseName],
    );
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(plan.targetDatabaseName)}`,
    );
  });
}

async function databaseExists(plan) {
  return withClient(plan.maintenanceUrl.href, async (client) => {
    const result = await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [plan.targetDatabaseName],
    );
    return result.rows[0]?.exists === true;
  });
}

async function migrationCount(plan) {
  return withClient(plan.targetUrl.href, async (client) => {
    const result = await client.query(
      'SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    return Number(result.rows[0]?.count ?? -1);
  });
}

export async function runSanitizedNodeChild(
  argumentsList,
  childEnvironment,
  options = {},
) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const stdoutWriter = options.stdout ?? process.stdout;
  const stderrWriter = options.stderr ?? process.stderr;
  const child = spawnProcess(process.execPath, argumentsList, {
    cwd: options.cwd ?? projectRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [exitCode] = await once(child, "exit");
  const secrets = collectChildEnvironmentSecrets(childEnvironment);
  const sanitizedStdout = redactRunnerOutput(stdout, secrets);
  const sanitizedStderr = redactRunnerOutput(stderr, secrets);
  if (sanitizedStdout) stdoutWriter.write(sanitizedStdout);
  if (sanitizedStderr) stderrWriter.write(sanitizedStderr);
  return typeof exitCode === "number" ? exitCode : 1;
}

async function runChild(step, childEnvironment, vitestArguments = []) {
  const argumentsByStep = {
    migrate: [prismaCliPath, "migrate", "deploy"],
    seed: [prismaCliPath, "db", "seed"],
    vitest: [vitestCliPath, "run", ...vitestArguments],
  };
  return runSanitizedNodeChild(argumentsByStep[step], childEnvironment);
}

function fakePassword(label) {
  return `Vitest-${label}-${randomBytes(18).toString("base64url")}`;
}

export async function runIsolatedVitest(options = {}) {
  const environment = options.environment ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const targetDatabaseName =
    options.targetDatabaseName ?? createTemporaryDatabaseName();
  const plan = resolveIsolatedVitestPlan(environment, targetDatabaseName);
  const dependencies = {
    createDatabase,
    dropDatabase,
    databaseExists,
    migrationCount,
    runChild,
    ...options.dependencies,
  };
  const adminPassword = fakePassword("Admin");
  const staffPassword = fakePassword("Staff");
  const childEnvironment = buildIsolatedVitestChildEnvironment(environment, {
    databaseUrl: plan.targetUrl.href,
    adminPassword,
    staffPassword,
    authRateLimitSecret: fakePassword("AuthRateLimit"),
    publicManagementSecret: fakePassword("PublicManagement"),
    publicRateLimitSecret: fakePassword("PublicRateLimit"),
  });
  let targetConfirmedAbsent = false;
  let createAttemptStarted = false;
  let createAcknowledged = false;
  let exitCode = 0;

  safeLog(logger, {
    event: "isolated_vitest_lifecycle",
    state: "validated",
    database: plan.targetDatabaseName,
  });

  try {
    if (await dependencies.databaseExists(plan)) {
      throw new IsolatedVitestSafetyError("TEMP_DATABASE_COLLISION");
    }
    targetConfirmedAbsent = true;
    safeLog(logger, {
      event: "isolated_vitest_lifecycle",
      state: "target_absent",
      database: plan.targetDatabaseName,
    });

    createAttemptStarted = true;
    safeLog(logger, {
      event: "isolated_vitest_lifecycle",
      state: "create_started",
      database: plan.targetDatabaseName,
    });
    await dependencies.createDatabase(plan);
    createAcknowledged = true;
    safeLog(logger, {
      event: "isolated_vitest_lifecycle",
      state: "created",
      database: plan.targetDatabaseName,
    });

    for (const step of ["migrate", "seed"]) {
      const childExitCode = await dependencies.runChild(
        step,
        childEnvironment,
      );
      safeLog(logger, {
        event: "isolated_vitest_child",
        step,
        exitCode: childExitCode,
      });
      if (childExitCode !== 0) {
        exitCode = childExitCode;
        break;
      }
    }

    if (exitCode === 0) {
      const appliedMigrations = await dependencies.migrationCount(plan);
      safeLog(logger, {
        event: "isolated_vitest_migrations",
        count: appliedMigrations,
      });
      if (appliedMigrations !== EXPECTED_MIGRATION_COUNT) {
        throw new IsolatedVitestSafetyError("MIGRATION_COUNT_MISMATCH");
      }

      exitCode = await dependencies.runChild(
        "vitest",
        childEnvironment,
        options.vitestArguments ?? [],
      );
      safeLog(logger, {
        event: "isolated_vitest_child",
        step: "vitest",
        exitCode,
      });
    }
  } catch (error) {
    exitCode = 1;
    safeLog(logger, {
      event: "isolated_vitest_lifecycle",
      state: "failed",
      code:
        error instanceof IsolatedVitestSafetyError
          ? error.code
          : "ISOLATED_RUN_FAILED",
    });
  } finally {
    if (targetConfirmedAbsent && createAttemptStarted) {
      try {
        const existsAfterCreateAttempt = await dependencies.databaseExists(plan);
        if (existsAfterCreateAttempt) {
          await dependencies.dropDatabase(plan);
          const stillExists = await dependencies.databaseExists(plan);
          if (stillExists) {
            throw new IsolatedVitestSafetyError("TEMP_DATABASE_STILL_EXISTS");
          }
        }
        safeLog(logger, {
          event: "isolated_vitest_lifecycle",
          state: existsAfterCreateAttempt ? "dropped" : "absent",
          database: plan.targetDatabaseName,
          createAcknowledged,
        });
      } catch {
        exitCode = 1;
        safeLog(logger, {
          event: "isolated_vitest_lifecycle",
          state: "cleanup_failed",
          code: "TEMP_DATABASE_CLEANUP_FAILED",
          createAcknowledged,
        });
      }
    }
  }

  return exitCode;
}

function loadLocalEnvironment() {
  loadEnvironment({
    path: fileURLToPath(new URL("../.env", import.meta.url)),
    override: false,
    quiet: true,
  });
  loadEnvironment({
    path: fileURLToPath(new URL("../.env.example", import.meta.url)),
    override: false,
    quiet: true,
  });
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  loadLocalEnvironment();
  runIsolatedVitest({ vitestArguments: process.argv.slice(2) })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({ event: "isolated_vitest_lifecycle", state: "startup_failed" })}\n`,
      );
      process.exitCode = 1;
    });
}
