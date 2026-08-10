import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const nextCliPath = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const playwrightCliPath = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
const healthUrl = "http://127.0.0.1:4000/api/health";

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
    const terminator = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await once(terminator, "exit");
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

const server = spawn(process.execPath, [nextCliPath, "start", "-p", "4000"], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

let testExitCode = 1;

try {
  await waitForServer(server, 120_000);
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
  await terminateProcessTree(server);
}

process.exitCode = testExitCode;
