import "dotenv/config";

import { spawn } from "node:child_process";

if ((process.env.APP_ENV ?? "development") !== "development") {
  console.error("Database reset is allowed only when APP_ENV=development.");
  process.exit(1);
}

console.warn(
  "DANGER: this command deletes and recreates all data in the local development database.",
);

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npxCommand, ["prisma", "migrate", "reset"], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to start Prisma reset: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Prisma reset was terminated by signal ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
