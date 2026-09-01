import "dotenv/config";

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import pg from "pg";

import {
  acquireStagingPreBaseline,
  assertStagingToolingGuard,
  assertValidStagingRunId,
  cleanupStagingRun,
  parseStagingPreBaselineManifest,
  scanStagingFakeData,
  verifyStagingNotificationRun,
  verifyStagingSeed,
  type StagingDatabase,
} from "./staging-tooling";

const { Pool } = pg;

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function externalManifestPath(): string {
  const value = optionValue("--manifest-path")?.trim();
  if (!value || !isAbsolute(value)) {
    throw new Error("Staging PRE baseline requires an absolute manifest path.");
  }
  const manifestPath = resolve(value);
  const repositoryPath = resolve(process.cwd());
  const repositoryRelative = relative(repositoryPath, manifestPath);
  if (
    repositoryRelative === "" ||
    (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
  ) {
    throw new Error("Staging PRE baseline manifest must be outside the repository.");
  }
  if (/\.env(?:\.|$)/i.test(manifestPath)) {
    throw new Error("Staging PRE baseline manifest path is forbidden.");
  }
  return manifestPath;
}

async function main(): Promise<void> {
  assertStagingToolingGuard(process.env);
  const command = process.argv[2];
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    max: 1,
  });
  const database = pool as unknown as StagingDatabase;

  try {
    let result: unknown;
    if (command === "verify-seed") {
      result = await verifyStagingSeed(database);
    } else if (command === "fake-data-scan") {
      result = await scanStagingFakeData(database);
    } else {
      const runId = assertValidStagingRunId(optionValue("--run-id"));
      if (command === "verify-run") {
        result = await verifyStagingNotificationRun(database, runId);
      } else if (command === "fingerprint") {
        const manifest = await acquireStagingPreBaseline(database, runId);
        await writeFile(
          externalManifestPath(),
          `${JSON.stringify(manifest)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        result = {
          fingerprint: manifest.fingerprint,
          families: Object.keys(manifest.families).length,
          manifest: "written",
        };
      } else if (command === "cleanup-run") {
        const preBaseline = parseStagingPreBaselineManifest(
          JSON.parse(await readFile(externalManifestPath(), "utf8")),
        );
        result = await cleanupStagingRun({
          database,
          runId,
          confirmation: optionValue("--confirm-run-id")?.trim().toUpperCase(),
          preBaseline,
        });
      } else {
        throw new Error("Unsupported staging tooling command.");
      }
    }

    console.info(JSON.stringify({ command, status: "ok", result }));
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error("Staging tooling stopped after a sanitized failure.");
  process.exitCode = 1;
});
