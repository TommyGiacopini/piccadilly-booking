import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function assertExactBlueprintCardinality(blueprint: string): void {
  const servicesStart = blueprint.indexOf("services:");
  const databasesStart = blueprint.indexOf("\ndatabases:");
  if (servicesStart < 0 || databasesStart < 0 || databasesStart <= servicesStart) {
    throw new Error("Blueprint service/database sections are invalid.");
  }
  const servicesSection = blueprint.slice(servicesStart, databasesStart);
  const databasesSection = blueprint.slice(databasesStart);
  const serviceEntries = servicesSection.match(/^  - /gm) ?? [];
  const serviceTypes = [...servicesSection.matchAll(/^  - type: ([^\s]+)$/gm)].map(
    (match) => match[1],
  );
  const databaseEntries = databasesSection.match(/^  - /gm) ?? [];
  const databaseNames = [
    ...databasesSection.matchAll(/^  - name: ([^\s]+)$/gm),
  ].map((match) => match[1]);

  if (
    serviceEntries.length !== 2 ||
    serviceTypes.length !== 2 ||
    serviceTypes.filter((type) => type === "web").length !== 1 ||
    serviceTypes.filter((type) => type === "worker").length !== 1 ||
    serviceTypes.some((type) => type !== "web" && type !== "worker")
  ) {
    throw new Error("Blueprint must contain exactly one web and one worker.");
  }
  if (
    databaseEntries.length !== 1 ||
    databaseNames.length !== 1 ||
    databaseNames[0] !== "piccadilly-booking-m13-61a66b11-db"
  ) {
    throw new Error("Blueprint must contain exactly the frozen M13 PostgreSQL database.");
  }
}

describe("M13 Render Blueprint contract", () => {
  const blueprint = read("render.yaml");
  const servicesSection = blueprint.slice(
    blueprint.indexOf("services:"),
    blueprint.indexOf("\ndatabases:"),
  );
  const databasesSection = blueprint.slice(blueprint.indexOf("databases:"));

  it("pins the frozen web, worker and PostgreSQL shape without auto-deploy", () => {
    expect(() => assertExactBlueprintCardinality(blueprint)).not.toThrow();
    expect(blueprint).toContain("previews:\n  generation: off");
    expect(servicesSection.match(/^  - type: web$/gm)).toHaveLength(1);
    expect(servicesSection.match(/^  - type: worker$/gm)).toHaveLength(1);
    expect(databasesSection.match(/^  - name:/gm)).toHaveLength(1);
    expect(servicesSection).toContain(
      "name: piccadilly-booking-m13-61a66b11-web",
    );
    expect(servicesSection).toContain(
      "name: piccadilly-booking-m13-61a66b11-worker",
    );
    expect(databasesSection).toContain(
      "name: piccadilly-booking-m13-61a66b11-db",
    );
    expect(servicesSection.match(/runtime: node/g)).toHaveLength(2);
    expect(servicesSection.match(/branch: main/g)).toHaveLength(2);
    expect(servicesSection.match(/region: frankfurt/g)).toHaveLength(2);
    expect(databasesSection.match(/region: frankfurt/g)).toHaveLength(1);
    expect(servicesSection.match(/plan: 0\.5c-512mb/g)).toHaveLength(2);
    expect(databasesSection.match(/plan: 0\.1c-256mb/g)).toHaveLength(1);
    expect(blueprint.match(/numInstances: 1/g)).toHaveLength(2);
    expect(blueprint.match(/autoDeployTrigger: off/g)).toHaveLength(2);
    expect(blueprint).toContain(
      "buildCommand: npm ci && npm run db:generate && npm run build",
    );
    expect(blueprint).toContain(
      "buildCommand: npm ci && npm run db:generate && npm run typecheck",
    );
    expect(blueprint).toContain(
      "preDeployCommand: npm run staging:validate:web && npm run db:migrate:deploy && npm run db:seed",
    );
    expect(blueprint).toContain("startCommand: npm run start");
    expect(blueprint).toContain(
      "startCommand: npm run notifications:worker:staging",
    );
    expect(blueprint).toContain("healthCheckPath: /api/health");
    expect(blueprint.match(/maxShutdownDelaySeconds: 60/g)).toHaveLength(2);

    for (const fragment of [
      "diskSizeGB: 1",
      "storageAutoscalingEnabled: false",
      'postgresMajorVersion: "18"',
      "connectionPool: none",
      "ipAllowList: []",
    ]) {
      expect(databasesSection).toContain(fragment);
    }

    expect(servicesSection.match(/- key: DATABASE_URL/g)).toHaveLength(2);
    expect(servicesSection.match(/fromDatabase:/g)).toHaveLength(2);
    expect(servicesSection.match(/property: connectionString/g)).toHaveLength(2);
    expect(servicesSection.match(/- key: APP_ENV/g)).toHaveLength(2);
    expect(servicesSection.match(/^\s+value: staging$/gm)).toHaveLength(2);
    expect(blueprint).not.toMatch(/autoDeployTrigger:\s*(?:on|commit)/);
    expect(blueprint).not.toMatch(
      /(?:runtime:\s*docker|type:\s*(?:cron|keyvalue|redis)|^\s+(?:domains|disk|dockerCommand|schedule):|customDomain)/im,
    );
  });

  it.each(["pserv", "static", "web", "worker", "cron"])(
    "rejects an otherwise identical Blueprint with an extra %s service",
    (serviceType) => {
      const extraService = `\n  - type: ${serviceType}\n    name: forbidden-extra-service\n`;
      const mutated = blueprint.replace("\ndatabases:", `${extraService}\ndatabases:`);
      expect(() => assertExactBlueprintCardinality(mutated)).toThrow(
        "exactly one web and one worker",
      );
    },
  );

  it("contains only simulated-provider-safe staging environment fields", () => {
    expect(blueprint).toContain("value: staging");
    expect(blueprint).toContain("value: piccadilly-staging");
    expect(blueprint).not.toMatch(
      /(?:META|GRAPH_API|SMTP|SES_|RESEND|SENDGRID|PROVIDER_(?:URL|TOKEN|API_KEY|SECRET|MODE))/i,
    );
    expect(blueprint).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(blueprint).not.toMatch(/(?:token|password):\s*[^\s]/i);
  });
});

describe("M13 dependency and runtime contract", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const packageLock = JSON.parse(read("package-lock.json")) as {
    packages: Record<
      string,
      {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }
    >;
  };

  it("pins Node without changing dependency inventories", () => {
    expect(read(".node-version").trim()).toBe("24.14.1");
    expect(packageJson.engines.node).toBe(">=20.9.0 <25");
    expect(packageJson.dependencies).toEqual(packageLock.packages[""].dependencies);
    expect(packageJson.devDependencies).toEqual(
      packageLock.packages[""].devDependencies,
    );
  });

  it("contains no provider SDK dependency", () => {
    const names = [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ].join(" ");
    expect(names).not.toMatch(/meta|whatsapp|sendgrid|resend|aws-sdk|smtp|mailgun/i);
  });
});

describe("M13 provider and filesystem kill gates", () => {
  it("keeps the notification infrastructure limited to simulated adapters and no network", () => {
    const directory = join(
      repositoryRoot,
      "src/modules/notifications/infrastructure",
    );
    const sources = readdirSync(directory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("\n");
    expect(sources).toContain("SimulatedWhatsAppProvider");
    expect(sources).toContain("SimulatedEmailProvider");
    expect(sources).not.toMatch(
      /\bfetch\s*\(|https?\.request|createConnection\s*\(|Graph API|SMTP|SendGrid|Resend/i,
    );
    expect(sources).not.toMatch(/RealWhatsAppProvider|RealEmailProvider/);
  });

  it("keeps PDF, Excel and font paths server-side and platform-neutral", () => {
    const sources = [
      read("src/modules/exports/infrastructure/font-loader.ts"),
      read("src/modules/exports/infrastructure/pdfkit-export-renderer.ts"),
      read("src/modules/exports/infrastructure/exceljs-export-renderer.ts"),
    ].join("\n");
    expect(sources).not.toMatch(/[A-Za-z]:\\/);
    expect(sources).not.toMatch(/(?:writeFile|mkdtemp|tmpdir)\s*\(/);
    expect(sources).toContain("NotoSans[wdth,wght].ttf");
  });
});

describe("M13 staging Playwright static contract", () => {
  const config = read("playwright.staging.config.ts");
  const suite = read("tests/staging/staging.spec.ts");

  it("uses one Chromium worker, no local web server and failure evidence only", () => {
    expect(config).toContain('testDir: "./tests/staging"');
    expect(config).toContain("fullyParallel: false");
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "retain-on-failure"');
    expect(config).toContain('screenshot: "only-on-failure"');
    expect(config).not.toContain("webServer");
  });

  it("covers the frozen remote surfaces without importing database access", () => {
    for (const marker of [
      "Basic gate",
      "banner",
      "noindex",
      "robots",
      "health",
      "public booking",
      "management update/cancel",
      "Staff phone opt-out",
      "assignment",
      "PDF/Excel",
      "Origin security",
      "Admin configuration",
      "notification settings",
      "390, 820, 1440",
    ]) {
      expect(suite).toContain(marker);
    }
    expect(suite).not.toContain("DATABASE_URL");
    expect(suite).not.toMatch(/from\s+["']pg["']|PrismaClient/);
  });
});
