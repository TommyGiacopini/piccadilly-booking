import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(process.cwd(), "prisma", "migrations");
const m9eMigrations = readdirSync(migrationsDirectory).filter((name) =>
  name.endsWith("_add_public_settings_and_content"),
);

describe("M9-E progressive migration", () => {
  it("has exactly one M9-E migration", () => {
    expect(m9eMigrations).toHaveLength(1);
  });

  it("creates only public settings/content structures and never mutates operational data", () => {
    const sql = readFileSync(
      resolve(migrationsDirectory, m9eMigrations[0]!, "migration.sql"),
      "utf8",
    );
    expect(sql).toContain('CREATE TABLE "restaurant_public_settings"');
    expect(sql).toContain('CREATE TABLE "public_contents"');
    expect(sql).toContain('CREATE TYPE "PublicContentLocale"');
    expect(sql).toContain('CREATE TYPE "PublicContentKey"');
    expect(sql).toContain("ON DELETE RESTRICT");
    expect(sql).not.toMatch(
      /(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+"?(?:reservations|reservation_management_tokens|users|sessions|audit_events)"?/iu,
    );
    expect(sql).not.toContain("management_link_duration_hours");
    expect(sql).not.toContain("view_expires_at");
    expect(sql).not.toContain("token_hash");
  });
});
