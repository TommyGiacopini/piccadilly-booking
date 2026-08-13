import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";

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
const healthUrl = "http://127.0.0.1:4000/api/health";
const e2eRunIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e2eRunId = process.env.E2E_RUN_ID?.trim() || randomUUID();

if (!e2eRunIdPattern.test(e2eRunId)) {
  throw new Error("E2E_RUN_ID must be a valid UUID.");
}
process.env.E2E_RUN_ID = e2eRunId.toLowerCase();

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

async function prepareDedicatedE2eUsers() {
  const preparation = spawn(
    process.execPath,
    [tsxCliPath, e2eUserPreparationPath],
    {
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const [exitCode] = await once(preparation, "exit");

  if (exitCode !== 0) {
    throw new Error("Dedicated E2E user preparation failed.");
  }
}

async function cleanupDedicatedE2eReservations() {
  const cleanup = spawn(
    process.execPath,
    [tsxCliPath, e2eReservationCleanupPath],
    {
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const [exitCode] = await once(cleanup, "exit");

  if (exitCode !== 0) {
    throw new Error("Dedicated E2E reservation cleanup failed.");
  }
}

await prepareDedicatedE2eUsers();

const server = spawn(process.execPath, [nextCliPath, "start", "-p", "4000"], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

let testExitCode = 1;
let serverReady = false;

try {
  await waitForServer(server, 120_000);
  serverReady = true;
  await cleanupDedicatedE2eReservations();
  const tests = spawn(
    process.execPath,
    [playwrightCliPath, "test", ...process.argv.slice(2)],
    {
      env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: "true" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const [exitCode] = await once(tests, "exit");
  testExitCode = typeof exitCode === "number" ? exitCode : 1;
} finally {
  if (serverReady) {
    try {
      await cleanupDedicatedE2eReservations();
    } catch {
      testExitCode = 1;
    }
  }
  await terminateProcessTree(server);
}

process.exitCode = testExitCode;
