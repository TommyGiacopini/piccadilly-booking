import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(process.cwd(), "prisma", "migrations");
const migrationNames = readdirSync(migrationsDirectory).filter((name) => /^\d+_/u.test(name));
const notificationMigrations = migrationNames.filter((name) => name.endsWith("_add_notification_outbox_and_simulators"));
const migrationPath = resolve(migrationsDirectory, notificationMigrations[0] ?? "missing", "migration.sql");

describe("M12 additive notification migration", () => {
  it("is the single thirteenth migration with the reviewed bytes", () => {
    expect(migrationNames).toHaveLength(13);
    expect(notificationMigrations).toHaveLength(1);
    expect(createHash("sha256").update(readFileSync(migrationPath)).digest("hex").toUpperCase()).toBe(
      "42BA74FC5E64A7FC8D16E9847BE10464E9F0D91980E3E40900EFDA90B34E6C21",
    );
  });

  it("contains only the four M12 tables, constraints, indexes and settings bootstrap", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql.match(/CREATE TABLE/gu)).toHaveLength(4);
    expect(sql).toContain('CREATE TABLE "restaurant_notification_settings"');
    expect(sql).toContain('CREATE TABLE "notification_outbox"');
    expect(sql).toContain('CREATE TABLE "notification_attempts"');
    expect(sql).toContain('CREATE TABLE "notification_simulation_receipts"');
    expect(sql).not.toContain("FOR UPDATE");
    expect(sql).toMatch(/INSERT INTO "restaurant_notification_settings"[\s\S]*SELECT "id", 'WHATSAPP_ONLY'/u);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?reservations"?/iu);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)|RENAME\s+/iu);
    expect(sql).not.toMatch(/(?:api[_-]?key|access[_-]?token|smtp|provider[_-]?secret)/iu);
  });
});
