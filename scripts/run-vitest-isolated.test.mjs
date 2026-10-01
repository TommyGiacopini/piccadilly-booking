import { describe, expect, it } from "vitest";

import {
  IsolatedVitestSafetyError,
  assertTemporaryDatabaseName,
  buildIsolatedVitestChildEnvironment,
  collectChildEnvironmentSecrets,
  isLoopbackPostgresHost,
  isSensitiveEnvironmentVariableName,
  redactRunnerOutput,
  resolveIsolatedVitestPlan,
  runIsolatedVitest,
  runSanitizedNodeChild,
} from "./run-vitest-isolated.mjs";

const safeTarget = "piccadilly_vitest_0123456789abcdef0123456789abcdef";

function environment(overrides = {}) {
  return {
    APP_ENV: "development",
    DATABASE_URL:
      "postgresql://runner:local-password@127.0.0.1:5433/piccadilly_booking",
    ...overrides,
  };
}

function fakeDependencies(input = {}) {
  const calls = [];
  const childEnvironments = [];
  const existenceResults = [...(input.exists ?? [false, true, false])];
  return {
    calls,
    childEnvironments,
    dependencies: {
      createDatabase: async () => {
        calls.push("create");
        await input.createDatabase?.();
      },
      dropDatabase: async () => {
        calls.push("drop");
        await input.dropDatabase?.();
      },
      databaseExists: async () => {
        calls.push("exists");
        if (input.databaseExists) return input.databaseExists();
        const result = existenceResults.shift();
        if (result === undefined) {
          throw new Error("missing fake existence result");
        }
        return result;
      },
      migrationCount: async () => 14,
      runChild: async (step, childEnvironment, vitestArguments) => {
        calls.push(step);
        childEnvironments.push({ step, childEnvironment, vitestArguments });
        await input.runChild?.(step, childEnvironment, vitestArguments);
        return input.exitCodes?.[step] ?? 0;
      },
    },
  };
}

describe("isolated Vitest runner safety", () => {
  it("accepts only semantic loopback PostgreSQL hosts", () => {
    expect([
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.255.20.4",
      "::1",
      "[::1]",
    ].every(isLoopbackPostgresHost)).toBe(true);
    expect([
      "192.168.1.12",
      "10.0.0.2",
      "db.example.test",
      "0.0.0.0",
    ].some(isLoopbackPostgresHost)).toBe(false);
  });

  it("rejects APP_ENV values other than development", () => {
    expect(() =>
      resolveIsolatedVitestPlan(environment({ APP_ENV: "staging" }), safeTarget),
    ).toThrowError(
      expect.objectContaining({ code: "APP_ENV_NOT_DEVELOPMENT" }),
    );
  });

  it("rejects an environment identified as Render", () => {
    expect(() =>
      resolveIsolatedVitestPlan(
        environment({ RENDER_SERVICE_ID: "srv-not-allowed" }),
        safeTarget,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RENDER_ENVIRONMENT_REJECTED" }),
    );
  });

  it("rejects a non-loopback source", () => {
    expect(() =>
      resolveIsolatedVitestPlan(
        environment({
          DATABASE_URL:
            "postgresql://runner:secret@db.example.test:5432/piccadilly_booking",
        }),
        safeTarget,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "SOURCE_DATABASE_NOT_LOOPBACK" }),
    );
  });

  it("rejects non-conforming temporary database names", () => {
    for (const name of [
      "piccadilly_booking",
      "piccadilly_vitest_short",
      "piccadilly_vitest_0123456789abcdef0123456789abcdeg",
      'piccadilly_vitest_0123456789abcdef01234567";DROP',
    ]) {
      expect(() => assertTemporaryDatabaseName(name)).toThrow(
        IsolatedVitestSafetyError,
      );
    }
  });

  it("rejects using the source database itself as the temporary target", () => {
    expect(() =>
      resolveIsolatedVitestPlan(
        environment({
          DATABASE_URL: `postgresql://runner:secret@localhost:5433/${safeTarget}`,
        }),
        safeTarget,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "TARGET_MATCHES_SOURCE_DATABASE" }),
    );
  });

  it("builds a minimized child environment with runner-controlled application values", () => {
    const childEnvironment = buildIsolatedVitestChildEnvironment(
      environment({
        Path: "C:\\Windows\\System32",
        AUTH_RATE_LIMIT_SECRET: "host-auth-secret-canary",
        M13_STAGING_TOOLING_PG_TEST: "false",
        UNRELATED_HOST_SECRET: "unrelated-host-secret-canary",
        RENDER: "true",
      }),
      {
        databaseUrl:
          "postgresql://isolated:test-password@127.0.0.1:5433/piccadilly_vitest_0123456789abcdef0123456789abcdef",
        adminPassword: "runner-admin-password-canary",
        staffPassword: "runner-staff-password-canary",
        authRateLimitSecret: "runner-auth-secret-canary-value",
        publicManagementSecret: "runner-management-secret-canary-value",
        publicRateLimitSecret: "runner-rate-secret-canary-value",
      },
    );

    expect(childEnvironment.PATH).toContain(
      `node_modules\\.bin;C:\\Windows\\System32`,
    );
    expect(childEnvironment.APP_ENV).toBe("development");
    expect(childEnvironment.M13_STAGING_TOOLING_PG_TEST).toBe("true");
    expect(childEnvironment.AUTH_RATE_LIMIT_SECRET).toBe(
      "runner-auth-secret-canary-value",
    );
    expect(childEnvironment).not.toHaveProperty("UNRELATED_HOST_SECRET");
    expect(childEnvironment).not.toHaveProperty("RENDER");
    expect(JSON.stringify(childEnvironment)).not.toContain(
      "host-auth-secret-canary",
    );
    expect(JSON.stringify(childEnvironment)).not.toContain(
      "unrelated-host-secret-canary",
    );
  });

  it.each(["false", "arbitrary-host-value"])(
    "keeps the M13 PostgreSQL test flag runner-controlled when the host supplies %s",
    (hostValue) => {
      const childEnvironment = buildIsolatedVitestChildEnvironment(
        environment({ M13_STAGING_TOOLING_PG_TEST: hostValue }),
        {
          databaseUrl:
            "postgresql://isolated:test-password@127.0.0.1:5433/piccadilly_vitest_0123456789abcdef0123456789abcdef",
          adminPassword: "runner-admin-password-canary",
          staffPassword: "runner-staff-password-canary",
          authRateLimitSecret: "runner-auth-secret-canary-value",
          publicManagementSecret: "runner-management-secret-canary-value",
          publicRateLimitSecret: "runner-rate-secret-canary-value",
        },
      );

      expect(childEnvironment.M13_STAGING_TOOLING_PG_TEST).toBe("true");
      if (hostValue !== "false") {
        expect(JSON.stringify(childEnvironment)).not.toContain(hostValue);
      }
    },
  );

  it("classifies sensitive environment variable names without substring matching", () => {
    for (const name of [
      "USER_PASSWORD",
      "DB_PASS",
      "AUTH_SECRET",
      "ACCESS_TOKEN",
      "PROVIDER_KEY",
      "DATABASE_URL",
      "SERVICE_CONNECTION_STRING",
    ]) {
      expect(isSensitiveEnvironmentVariableName(name)).toBe(true);
    }
    for (const name of ["PATH", "PATHEXT", "MONKEY", "KEYSTORE_PATH"]) {
      expect(isSensitiveEnvironmentVariableName(name)).toBe(false);
    }
  });

  it.each([
    ["migrate", 21],
    ["seed", 22],
    ["vitest", 23],
  ])(
    "sanitizes hostile %s child stdout and stderr from the actual child environment",
    async (step, expectedExitCode) => {
      const canaries = {
        password: `password-${step}-canary`,
        secret: `secret-${step}-canary`,
        token: `token-${step}-canary`,
        key: `key-${step}-canary`,
        databaseUser: `database-user-${step}-canary`,
        databasePassword: `database-password-${step}-canary`,
        unrelated: `unrelated-${step}-canary`,
      };
      const builtEnvironment = buildIsolatedVitestChildEnvironment(
        environment({ UNRELATED_HOST_SECRET: canaries.unrelated }),
        {
          databaseUrl: `postgresql://${canaries.databaseUser}:${canaries.databasePassword}@127.0.0.1:5433/${safeTarget}`,
          adminPassword: canaries.password,
          staffPassword: `staff-${step}-password-canary`,
          authRateLimitSecret: canaries.secret,
          publicManagementSecret: `management-${step}-secret-canary`,
          publicRateLimitSecret: `rate-${step}-secret-canary`,
        },
      );
      const childEnvironment = {
        ...builtEnvironment,
        RUNNER_TEST_TOKEN: canaries.token,
        RUNNER_TEST_KEY: canaries.key,
        RUNNER_TEST_EXIT_CODE: String(expectedExitCode),
      };
      expect(builtEnvironment).not.toHaveProperty("UNRELATED_HOST_SECRET");
      const discovered = collectChildEnvironmentSecrets(childEnvironment);
      for (const value of [
        canaries.password,
        canaries.secret,
        canaries.token,
        canaries.key,
        childEnvironment.DATABASE_URL,
        canaries.databaseUser,
        canaries.databasePassword,
      ]) {
        expect(discovered).toContain(value);
      }

      let stdout = "";
      let stderr = "";
      const hostileChild = [
        "const names = [",
        '  "AUTH_DEMO_ADMIN_PASSWORD",',
        '  "AUTH_RATE_LIMIT_SECRET",',
        '  "RUNNER_TEST_TOKEN",',
        '  "RUNNER_TEST_KEY",',
        '  "UNRELATED_HOST_SECRET",',
        '  "DATABASE_URL",',
        "];",
        'const output = names.map((name) => process.env[name] ?? "MISSING").join("|");',
        "process.stdout.write(output);",
        "process.stderr.write(output);",
        "process.exitCode = Number(process.env.RUNNER_TEST_EXIT_CODE);",
      ].join("\n");
      const exitCode = await runSanitizedNodeChild(
        ["-e", hostileChild],
        childEnvironment,
        {
          stdout: { write: (value) => (stdout += value) },
          stderr: { write: (value) => (stderr += value) },
        },
      );

      expect(exitCode).toBe(expectedExitCode);
      expect(stdout).toContain("[REDACTED]");
      expect(stderr).toContain("[REDACTED]");
      expect(stdout).toContain("MISSING");
      expect(stderr).toContain("MISSING");
      for (const canary of Object.values(canaries)) {
        expect(stdout).not.toContain(canary);
        expect(stderr).not.toContain(canary);
      }
      expect(stdout).not.toContain("postgresql://");
      expect(stderr).not.toContain("postgresql://");
    },
  );

  it("always drops and verifies the temporary database after success", async () => {
    const fake = fakeDependencies();
    const exitCode = await runIsolatedVitest({
      environment: environment({
        UNRELATED_HOST_SECRET: "must-not-reach-runner-children",
      }),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(fake.calls).toEqual([
      "exists",
      "create",
      "migrate",
      "seed",
      "vitest",
      "exists",
      "drop",
      "exists",
    ]);
    expect(fake.childEnvironments).toHaveLength(3);
    for (const { childEnvironment } of fake.childEnvironments) {
      expect(childEnvironment.M13_STAGING_TOOLING_PG_TEST).toBe("true");
      expect(childEnvironment).not.toHaveProperty("UNRELATED_HOST_SECRET");
      expect(JSON.stringify(childEnvironment)).not.toContain(
        "must-not-reach-runner-children",
      );
    }
  });

  it("cleans up after a child failure and propagates its exit status", async () => {
    const fake = fakeDependencies({ exitCodes: { migrate: 17 } });
    const exitCode = await runIsolatedVitest({
      environment: environment(),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: () => undefined,
    });
    expect(exitCode).toBe(17);
    expect(fake.calls).toEqual([
      "exists",
      "create",
      "migrate",
      "exists",
      "drop",
      "exists",
    ]);
  });

  it("cleans up a committed create after the acknowledgement is lost", async () => {
    const events = [];
    const fake = fakeDependencies({
      exists: [false, true, false],
      createDatabase: async () => {
        throw new Error("connection-lost-after-create");
      },
    });

    const exitCode = await runIsolatedVitest({
      environment: environment(),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: (event) => events.push(event),
    });

    expect(exitCode).toBe(1);
    expect(fake.calls).toEqual([
      "exists",
      "create",
      "exists",
      "drop",
      "exists",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ state: "failed", code: "ISOLATED_RUN_FAILED" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ state: "dropped", createAcknowledged: false }),
    );
  });

  it("checks absence after a create failure that happened before commit", async () => {
    const events = [];
    const fake = fakeDependencies({
      exists: [false, false],
      createDatabase: async () => {
        throw new Error("create-failed-before-commit");
      },
    });

    const exitCode = await runIsolatedVitest({
      environment: environment(),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: (event) => events.push(event),
    });

    expect(exitCode).toBe(1);
    expect(fake.calls).toEqual(["exists", "create", "exists"]);
    expect(fake.calls).not.toContain("drop");
    expect(events).toContainEqual(
      expect.objectContaining({ state: "absent", createAcknowledged: false }),
    );
  });

  it("rejects a pre-existing target without creating or dropping it", async () => {
    const events = [];
    const fake = fakeDependencies({ exists: [true] });

    const exitCode = await runIsolatedVitest({
      environment: environment(),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: (event) => events.push(event),
    });

    expect(exitCode).toBe(1);
    expect(fake.calls).toEqual(["exists"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        state: "failed",
        code: "TEMP_DATABASE_COLLISION",
      }),
    );
  });

  it("reports both an ambiguous create failure and its cleanup failure", async () => {
    const events = [];
    const fake = fakeDependencies({
      exists: [false, true],
      createDatabase: async () => {
        throw new Error("ambiguous-create-failure");
      },
      dropDatabase: async () => {
        throw new Error("cleanup-failure");
      },
    });

    const exitCode = await runIsolatedVitest({
      environment: environment(),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: (event) => events.push(event),
    });

    expect(exitCode).toBe(1);
    expect(fake.calls).toEqual(["exists", "create", "exists", "drop"]);
    expect(events).toContainEqual(
      expect.objectContaining({ state: "failed", code: "ISOLATED_RUN_FAILED" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        state: "cleanup_failed",
        code: "TEMP_DATABASE_CLEANUP_FAILED",
        createAcknowledged: false,
      }),
    );
    expect(JSON.stringify(events)).not.toContain("ambiguous-create-failure");
    expect(JSON.stringify(events)).not.toContain("cleanup-failure");
  });

  it("does not expose credentials or connection strings in lifecycle logs", async () => {
    const events = [];
    const fake = fakeDependencies();
    await runIsolatedVitest({
      environment: environment(),
      targetDatabaseName: safeTarget,
      dependencies: fake.dependencies,
      logger: (event) => events.push(event),
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("local-password");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("runner:");
  });

  it("redacts PostgreSQL URLs and exact secret values from child output", () => {
    const sanitized = redactRunnerOutput(
      "failed postgresql://runner:secret@localhost:5433/db token-canary",
      ["token-canary", "secret"],
    );
    expect(sanitized).toBe(
      "failed [REDACTED_DATABASE_URL] [REDACTED]",
    );
  });
});
