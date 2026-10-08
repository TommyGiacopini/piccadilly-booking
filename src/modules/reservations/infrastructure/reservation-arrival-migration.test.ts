import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const { Client } = pg;

const migrationsDirectory = resolve(process.cwd(), "prisma", "migrations");
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_/u.test(name))
  .sort();
const migrationName =
  "20260930120000_add_reservation_arrival_lifecycle";
const migrationPath = resolve(
  migrationsDirectory,
  migrationName,
  "migration.sql",
);

const historicalHashes: Record<string, string> = {
  "20260731120000_create_restaurant_foundation": "2AAF5BA51B9A13976D84C72C6363F6ED58C79B49263DA6D71F76501518562E23",
  "20260802153732_add_authentication_users_sessions_rate_limits": "D8F7DAF6C21000F4851373A6A55A6B337AEFB3B3DB2178F03D41AE9CB43AE994",
  "20260803090743_add_operational_configuration": "89E07EB50367F498F6499B6E97ED9FF454CD11F42D98F913C74734668E6C5DB6",
  "20260803141513_add_reservation_core": "436C68D86CDA37498A7A097A4FE3A672B9432A858DC52FEAC20CCE039C7140B7",
  "20260810090000_add_public_booking_management": "8058234DE27C964AB072E91504A2728AC1E0A08D1C4F2FFAE88E3A8BFF033C50",
  "20260810160000_add_authenticated_reservation_audit": "B048C92CCF809575E2CC23C934B8D41250C8EE639FFCAFA018AE2A8839E907A6",
  "20260812090000_add_admin_audit_foundation": "D1D6B02ED6CA3F352E189F9B485340C75A0DC412BFD8201F5CE5A5E283FF6CB8",
  "20260812120000_add_user_lifecycle": "2FA7C53270CC251B0F8E47B5262E5A11D788AE14C4C6322F72DB11A7B6A0A342",
  "20260812160000_add_generic_booking_cutoff_rules": "42368E85E2A438161BA1DCC96ECD54445A83D18D12B6CFB904CD0A833DF7271C",
  "20260812200000_add_service_instance_room_availability": "AE1CCC3D7AF2787E890D2996389A2C5790ABFF82C51C35440A5D46F179311D65",
  "20260813123000_add_public_settings_and_content": "C2CA01936D3E09749D7F1A59CEE709902FA5AD8EFD356B6CCB2AB23C8E305521",
  "20260813190000_add_reservation_assignments": "8C8D1E9D7E9AD185B85A008072F68C1DCE8F457250FDE0751059D831CB771A04",
  "20260828120000_add_notification_outbox_and_simulators": "42BA74FC5E64A7FC8D16E9847BE10464E9F0D91980E3E40900EFDA90B34E6C21",
};

describe("T03 additive arrival migration", () => {
  it("is the single fourteenth migration and preserves migrations 1 through 13 byte-for-byte", () => {
    expect(migrationNames).toHaveLength(15);
    expect(migrationNames[13]).toBe(migrationName);
    for (const [name, expectedHash] of Object.entries(historicalHashes)) {
      const contents = readFileSync(
        resolve(migrationsDirectory, name, "migration.sql"),
      );
      expect(
        createHash("sha256").update(contents).digest("hex").toUpperCase(),
      ).toBe(expectedHash);
    }
  });

  it("adds only nullable arrived_at and the two constrained audit actions", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('ADD COLUMN "arrived_at" TIMESTAMPTZ(3)');
    expect(sql).not.toMatch(/arrived_at[^;]*(?:DEFAULT|NOT NULL)/iu);
    expect(sql).toContain("ADD VALUE 'ARRIVAL_RECORDED'");
    expect(sql).toContain("ADD VALUE 'ARRIVAL_REVERTED'");
    expect(sql).toContain(
      '"action" = \'ARRIVAL_RECORDED\' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL',
    );
    expect(sql).toContain(
      '"action" = \'ARRIVAL_REVERTED\' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL',
    );
    expect(sql).not.toMatch(/(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|CREATE\s+INDEX|DROP\s+COLUMN|TRUNCATE)/iu);
    expect(
      createHash("sha256")
        .update(readFileSync(migrationPath))
        .digest("hex")
        .toUpperCase(),
    ).toBe("ADF794FE8CE56AB737398EA27D8512476523012D09988793906C9CF757427EBE");
  });

  it("keeps arrivedAt out of the public DTO", () => {
    const publicDto = readFileSync(
      resolve(
        process.cwd(),
        "src/modules/reservations/domain/public-dto.ts",
      ),
      "utf8",
    );
    expect(publicDto).not.toContain("arrivedAt");
  });

  it("upgrades a real PostgreSQL database from migrations 1-13 to 14 without backfill", async () => {
    const sourceUrl = new URL(process.env.DATABASE_URL ?? "");
    expect(["localhost", "127.0.0.1", "::1"]).toContain(sourceUrl.hostname);
    const databaseName = `piccadilly_t03_upgrade_${randomBytes(12).toString("hex")}`;
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${databaseName}`;
    const maintenanceUrl = new URL(sourceUrl);
    maintenanceUrl.pathname = "/postgres";
    const project = mkdtempSync(
      join(process.cwd(), "test-results", "t03-upgrade-"),
    );
    const projectPrisma = join(project, "prisma");
    const projectMigrations = join(projectPrisma, "migrations");
    mkdirSync(projectMigrations, { recursive: true });
    cpSync(
      resolve(process.cwd(), "prisma", "schema.prisma"),
      join(projectPrisma, "schema.prisma"),
    );
    cpSync(
      resolve(migrationsDirectory, "migration_lock.toml"),
      join(projectMigrations, "migration_lock.toml"),
    );
    for (const name of migrationNames.slice(0, 13)) {
      cpSync(resolve(migrationsDirectory, name), join(projectMigrations, name), {
        recursive: true,
      });
    }
    const normalizedSchema = join(projectPrisma, "schema.prisma").replaceAll(
      "\\",
      "/",
    );
    const normalizedMigrations = projectMigrations.replaceAll("\\", "/");
    const configPath = join(project, "prisma.config.ts");
    writeFileSync(
      configPath,
      [
        'import { defineConfig } from "prisma/config";',
        "export default defineConfig({",
        `  schema: ${JSON.stringify(normalizedSchema)},`,
        `  migrations: { path: ${JSON.stringify(normalizedMigrations)} },`,
        "  datasource: { url: process.env.DATABASE_URL! },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    const maintenance = new Client({ connectionString: maintenanceUrl.href });
    const target = new Client({ connectionString: targetUrl.href });
    let targetConnected = false;
    const prismaCli = resolve(process.cwd(), "node_modules/prisma/build/index.js");
    const runDeploy = async () => {
      try {
        await execFileAsync(
          process.execPath,
          [prismaCli, "migrate", "deploy", "--config", configPath],
          {
            cwd: process.cwd(),
            env: { ...process.env, DATABASE_URL: targetUrl.href },
            windowsHide: true,
          },
        );
      } catch {
        throw new Error("T03 migration deploy fixture failed.");
      }
    };

    await maintenance.connect();
    try {
      await maintenance.query(`CREATE DATABASE "${databaseName}"`);
      await runDeploy();
      await target.connect();
      targetConnected = true;
      const restaurantId = "93000000-0000-4000-8000-000000000001";
      const userId = "93000000-0000-4000-8000-000000000002";
      const reservationId = "93000000-0000-4000-8000-000000000003";
      await target.query(
        `INSERT INTO restaurants (id, name, timezone, updated_at)
         VALUES ($1, 'T03 Upgrade Fixture', 'Europe/Rome', $2)`,
        [restaurantId, fixedUpgradeTimestamp],
      );
      await target.query(
        `INSERT INTO users (id, restaurant_id, username, password_hash, role, updated_at)
         VALUES ($2, $1, 't03.upgrade', 'synthetic-hash', 'STAFF', $3)`,
        [restaurantId, userId, fixedUpgradeTimestamp],
      );
      await target.query(
        `INSERT INTO reservations (
           id, restaurant_id, local_date, service_type, arrival_time, party_size,
           origin, customer_first_name, customer_last_name, customer_phone,
           privacy_policy_version, privacy_consent_at, privacy_consent_method,
           created_by_user_id, updated_at
         ) VALUES (
           $3, $1, '2099-09-30', 'DINNER', '19:30', 4,
           'STAFF', 'Cliente', 'Upgrade Fittizio', '+390000003030',
           't03-upgrade-v1', $4, 'STAFF_RECORDED', $2, $4
         )`,
        [restaurantId, userId, reservationId, fixedUpgradeTimestamp],
      );
      await expect(
        target.query(
          `SELECT arrived_at FROM reservations WHERE id = $1`,
          [reservationId],
        ),
      ).rejects.toThrow();

      cpSync(
        resolve(migrationsDirectory, migrationName),
        join(projectMigrations, migrationName),
        { recursive: true },
      );
      await runDeploy();
      const upgraded = await target.query(
        `SELECT arrived_at FROM reservations WHERE id = $1`,
        [reservationId],
      );
      expect(upgraded.rows).toEqual([{ arrived_at: null }]);
      const migrationCount = await target.query(
        `SELECT COUNT(*)::int AS count FROM "_prisma_migrations"
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      );
      expect(migrationCount.rows[0]?.count).toBe(14);
      const enumValues = await target.query(
        `SELECT enumlabel
         FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
         WHERE pg_type.typname = 'ReservationAuditAction'
         ORDER BY enumsortorder`,
      );
      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(
        expect.arrayContaining(["ARRIVAL_RECORDED", "ARRIVAL_REVERTED"]),
      );
      const constraint = await target.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conname = 'reservation_audit_events_state_check'`,
      );
      expect(constraint.rows[0]?.definition).toContain("ARRIVAL_RECORDED");
      expect(constraint.rows[0]?.definition).toContain("ARRIVAL_REVERTED");

      await target.query(
        `UPDATE reservations SET arrived_at = $3, updated_at = $3, version = 2
         WHERE id = $2 AND restaurant_id = $1`,
        [restaurantId, reservationId, fixedUpgradeTimestamp],
      );
      await target.query(
        `INSERT INTO reservation_audit_events (
           id, restaurant_id, reservation_id, action, actor_origin,
           actor_user_id, actor_role, correlation_id, previous_state, new_state,
           created_at
         ) VALUES (
           '93000000-0000-4000-8000-000000000004', $1, $3,
           'ARRIVAL_RECORDED', 'STAFF', $2, 'STAFF',
           '93000000-0000-4000-8000-000000000005',
           '{"arrival":{"recorded":false,"arrivedAt":null}}'::jsonb,
           '{"arrival":{"recorded":true,"arrivedAt":"2026-09-30T19:42:15.123Z"}}'::jsonb,
           $4
         )`,
        [restaurantId, userId, reservationId, fixedUpgradeTimestamp],
      );
      await target.query(
        `UPDATE reservations SET arrived_at = NULL, updated_at = $3, version = 3
         WHERE id = $2 AND restaurant_id = $1`,
        [restaurantId, reservationId, fixedUpgradeTimestamp],
      );
      await target.query(
        `INSERT INTO reservation_audit_events (
           id, restaurant_id, reservation_id, action, actor_origin,
           actor_user_id, actor_role, correlation_id, previous_state, new_state,
           created_at
         ) VALUES (
           '93000000-0000-4000-8000-000000000006', $1, $3,
           'ARRIVAL_REVERTED', 'STAFF', $2, 'STAFF',
           '93000000-0000-4000-8000-000000000007',
           '{"arrival":{"recorded":true,"arrivedAt":"2026-09-30T19:42:15.123Z"}}'::jsonb,
           '{"arrival":{"recorded":false,"arrivedAt":null}}'::jsonb,
           $4
         )`,
        [restaurantId, userId, reservationId, fixedUpgradeTimestamp],
      );
      const finalState = await target.query(
        `SELECT arrived_at, version FROM reservations WHERE id = $1`,
        [reservationId],
      );
      expect(finalState.rows).toEqual([{ arrived_at: null, version: 3 }]);
      await target.end();
      targetConnected = false;
    } finally {
      if (targetConnected) await target.end().catch(() => undefined);
      await maintenance.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await maintenance.end();
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});

const fixedUpgradeTimestamp = new Date("2026-09-30T19:42:15.123Z");
