import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const nextCliPath = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const playwrightCliPath = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
const tsxCliPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const e2eUserPreparationPath = fileURLToPath(
  new URL("./prepare-e2e-users.ts", import.meta.url),
);
const e2eReservationCleanupPath = fileURLToPath(
  new URL("./cleanup-e2e-reservations.ts", import.meta.url),
);
const e2eDatabaseFingerprintPath = fileURLToPath(
  new URL("./fingerprint-e2e-database.ts", import.meta.url),
);
const healthUrl = "http://127.0.0.1:4000/api/health";
const e2eRunIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js E2E server exited with code ${server.exitCode}.`);
    }

    try {
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }

    await delay(250);
  }

  throw new Error("Next.js E2E server did not become healthy in time.");
}

async function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;

  if (process.platform === "win32") {
    child.kill();
    await Promise.race([once(child, "exit"), delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}


export class E2ERunnerSafetyError extends Error {
  constructor(code) { super(code); this.name = "E2ERunnerSafetyError"; this.code = code; }
}

// Importing the runner never loads environment files or starts application work.
export async function runE2e(options = {}) {
  const environment = options.environment ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const logger = options.logger ?? console.info;
  const e2eRunId = environment.E2E_RUN_ID?.trim() || randomUUID();
  if (!e2eRunIdPattern.test(e2eRunId)) throw new Error("E2E_RUN_ID must be a valid UUID.");
  environment.E2E_RUN_ID = e2eRunId.toLowerCase();
  environment.AUTH_RESTAURANT_ID = environment.E2E_RUN_ID;
  environment.E2E_TEST_MODE = "true";
  environment.AUTH_TRUST_PROXY = "false";
  environment.AUTH_RATE_LIMIT_SECRET = `e2e-only-auth-rate-limit-${environment.E2E_RUN_ID}`;
  environment.PUBLIC_BOOKING_RATE_LIMIT_SECRET = `e2e-only-public-rate-limit-${environment.E2E_RUN_ID}`;
  const guard = async phase => {
    if (options.signal?.aborted) throw new E2ERunnerSafetyError("OWNERSHIP_ABORTED");
    if (!options.requireOwnership && !options.ownershipGuard) return;
    if (typeof options.ownershipGuard !== "function") throw new E2ERunnerSafetyError("OWNERSHIP_GUARD_REQUIRED");
    const proof = await options.ownershipGuard({ phase, environment });
    if (proof?.valid !== true || typeof proof.generation !== "string") throw new E2ERunnerSafetyError("OWNERSHIP_GUARD_REJECTED");
  };
  const owned = (args, env, stdio = "inherit") => {
    if (options.signal?.aborted) throw new E2ERunnerSafetyError("OWNERSHIP_ABORTED");
    const child = spawnProcess(process.execPath, args, { env, stdio, windowsHide: true });
    options.onChild?.(child);
    return child;
  };
  const runScript = async (phase, path, env) => {
    await guard(phase);
    const child = owned([tsxCliPath, path], env);
    const [exitCode] = await once(child, "exit");
    if (exitCode !== 0) throw new E2ERunnerSafetyError("E2E_PREPARATION_OR_CLEANUP_FAILED");
  };
  const fingerprint = async phase => {
    await guard(phase);
    const child = owned([tsxCliPath, e2eDatabaseFingerprintPath], environment, ["ignore", "pipe", "inherit"]);
    let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    const [exitCode] = await once(child, "exit");
    if (exitCode !== 0) throw new E2ERunnerSafetyError("E2E_FINGERPRINT_FAILED");
    const evidence = JSON.parse(output.trim());
    logger(`E2E_DATABASE_FINGERPRINT ${JSON.stringify(evidence)}`);
    return evidence;
  };
  const cleanup = phase => runScript(phase, e2eReservationCleanupPath, { ...environment, E2E_PURGE_OPT_IN: `purge-e2e-run-${environment.E2E_RUN_ID}` });
  let baseline, server, cleanupRequired = false, exitCode = 1, primaryFailure = null, cleanupFailure = null;
  try {
    baseline = await fingerprint("e2e:fingerprint-before");
    await guard("e2e:prepare-fixture");
    // Mark attempted mutation before dispatch, so partial preparation is cleaned.
    cleanupRequired = true;
    await cleanup("e2e:cleanup-initial");
    await runScript("e2e:prepare-users", e2eUserPreparationPath, environment);
    await guard("e2e:application");
    server = owned([nextCliPath, "start", "-p", "4000"], environment);
    await (options.waitForServer ?? waitForServer)(server, 120_000);
    await guard("e2e:playwright");
    const tests = owned([playwrightCliPath, "test", ...(options.argumentsList ?? [])], { ...environment, PLAYWRIGHT_EXTERNAL_SERVER: "true" });
    const [testCode] = await once(tests, "exit");
    exitCode = typeof testCode === "number" ? testCode : 1;
    if (exitCode !== 0) primaryFailure = "PLAYWRIGHT_FAILED";
  } catch (error) {
    primaryFailure = error.code ?? "E2E_RUN_FAILED";
    exitCode = 1;
  } finally {
    try { if (server) await (options.stopChild ?? terminateProcessTree)(server); }
    catch (error) { cleanupFailure = error.code ?? "E2E_SERVER_STOP_FAILED"; exitCode = 1; }
    if (cleanupRequired && !cleanupFailure) {
      try {
        await cleanup("e2e:cleanup-final");
        const final = await fingerprint("e2e:fingerprint-after");
        if (final.nonRunFingerprint !== baseline.nonRunFingerprint || final.historicalFixtureRows !== baseline.historicalFixtureRows || final.runTenantRows !== 0) throw new E2ERunnerSafetyError("E2E_FINGERPRINT_CHANGED");
      } catch (error) { cleanupFailure = error.code ?? "E2E_CLEANUP_FAILED"; exitCode = 1; }
    }
    options.onOutcome?.({ exitCode, primaryFailure, cleanupFailure, cleanupRequired });
  }
  return exitCode;
}

async function main() {
  const { config: loadEnvironment } = await import("dotenv");
  for (const filename of ["../.env", "../.env.example"]) loadEnvironment({ path: fileURLToPath(new URL(filename, import.meta.url)), override: false, quiet: true });
  process.exitCode = await runE2e({ argumentsList: process.argv.slice(2) });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(() => {
  console.error("E2E runner startup failed."); process.exitCode = 1;
});
