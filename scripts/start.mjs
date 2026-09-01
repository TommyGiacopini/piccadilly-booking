import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePort } from "./resolve-port.mjs";
import {
  resolveApplicationEnvironment,
  validateStagingWebEnvironment,
} from "./staging-config.mjs";

const nextCliPath = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
export function resolveNextStartArguments(environment, cliPath = nextCliPath) {
  return [
    cliPath,
    "start",
    "-H",
    "0.0.0.0",
    "-p",
    resolvePort(environment.PORT),
  ];
}

function exitCodeFromSignal(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export function startNextServer(options = {}) {
  const environment = options.environment ?? process.env;
  const parentProcess = options.parentProcess ?? process;
  const spawnChild = options.spawnChild ?? spawn;
  const appEnvironment = resolveApplicationEnvironment(environment.APP_ENV);

  if (appEnvironment === "staging") {
    validateStagingWebEnvironment(environment);
  }

  const child = spawnChild(
    parentProcess.execPath,
    resolveNextStartArguments(environment, options.nextCliPath),
    { env: environment, stdio: "inherit" },
  );

  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const removeSignalHandlers = () => {
    parentProcess.removeListener("SIGINT", onSigint);
    parentProcess.removeListener("SIGTERM", onSigterm);
  };

  parentProcess.once("SIGINT", onSigint);
  parentProcess.once("SIGTERM", onSigterm);
  child.once("error", () => {
    removeSignalHandlers();
    console.error("Unable to start the Next.js server.");
    parentProcess.exitCode = 1;
  });
  child.once("exit", (exitCode, signal) => {
    removeSignalHandlers();
    parentProcess.exitCode = exitCode ?? exitCodeFromSignal(signal);
  });

  return child;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entryPoint === import.meta.url) {
  try {
    startNextServer();
  } catch {
    console.error("Unable to start the Next.js server.");
    process.exitCode = 1;
  }
}
