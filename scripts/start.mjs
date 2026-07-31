import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolvePort } from "./resolve-port.mjs";

const nextCliPath = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const port = resolvePort(process.env.PORT);
const nextServer = spawn(process.execPath, [nextCliPath, "start", "-p", port], {
  env: process.env,
  stdio: "inherit",
});

nextServer.once("error", (error) => {
  console.error("Unable to start the Next.js server.", error);
  process.exitCode = 1;
});

nextServer.once("exit", (exitCode) => {
  process.exitCode = exitCode ?? 1;
});
