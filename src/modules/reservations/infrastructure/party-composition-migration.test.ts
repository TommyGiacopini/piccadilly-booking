import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const migrations = resolve("prisma/migrations");
const names = readdirSync(migrations).filter((name) => /^\d+_/u.test(name)).sort();
const foundationMigration = "20261007120000_add_reservation_party_composition_and_game_room_preference";

describe("Foundation A additive party composition migration", () => {
  it("is migration 15, with no default, index, backfill or destructive SQL", () => {
    expect(names).toHaveLength(15);
    expect(names[14]).toBe(foundationMigration);
    const sql = readFileSync(join(migrations, foundationMigration, "migration.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "children_count" INTEGER');
    expect(sql).toContain('ADD COLUMN "game_room_preference" BOOLEAN');
    expect(sql).toContain('ALTER COLUMN "preferences" TYPE TEXT');
    expect(sql).toContain('ALTER COLUMN "allergies" TYPE TEXT');
    expect(sql).not.toMatch(/\b(?:DEFAULT|CREATE\s+INDEX|INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/iu);
    expect(sql).toContain('"children_count" IS NOT NULL');
  });

  it("upgrades schema14 without inferring legacy composition or mutating data/assignment/audit", async () => {
    const source = new URL(process.env.DATABASE_URL ?? "");
    expect(["localhost", "127.0.0.1", "::1"]).toContain(source.hostname);
    const database = `piccadilly_foundation_upgrade_${randomBytes(12).toString("hex")}`;
    const targetUrl = new URL(source); targetUrl.pathname = `/${database}`;
    const maintenanceUrl = new URL(source); maintenanceUrl.pathname = "/postgres";
    const evidenceRoot = resolve("test-results");
    mkdirSync(evidenceRoot, { recursive: true });
    const project = mkdtempSync(join(evidenceRoot, "foundation-upgrade-"));
    const projectMigrations = join(project, "prisma", "migrations");
    mkdirSync(projectMigrations, { recursive: true });
    cpSync(resolve("prisma/schema.prisma"), join(project, "prisma", "schema.prisma"));
    cpSync(join(migrations, "migration_lock.toml"), join(projectMigrations, "migration_lock.toml"));
    for (const name of names.slice(0, 14)) cpSync(join(migrations, name), join(projectMigrations, name), { recursive: true });
    const config = join(project, "prisma.config.ts");
    writeFileSync(config, `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(join(project, "prisma/schema.prisma").replaceAll("\\", "/"))}, migrations: { path: ${JSON.stringify(projectMigrations.replaceAll("\\", "/"))} }, datasource: { url: process.env.DATABASE_URL! } });\n`);
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    const target = new pg.Client({ connectionString: targetUrl.href });
    let connected = false;
    const deploy = async () => {
      try {
        await execFileAsync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", config], {
          cwd: process.cwd(), env: { ...process.env, DATABASE_URL: targetUrl.href }, windowsHide: true,
        });
      } catch { throw new Error("Foundation upgrade fixture deploy failed."); }
    };
    const state = async () => {
      const rows: Record<string, unknown[]> = {};
      for (const table of ["reservations", "users", "rooms", "dining_tables", "reservation_assignments", "reservation_assignment_tables", "reservation_audit_events"]) {
        rows[table] = (await target.query(`SELECT to_jsonb(t) - 'children_count' - 'game_room_preference' AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return rows;
    };
    await maintenance.connect();
    try {
      await maintenance.query(`CREATE DATABASE "${database}"`);
      await deploy();
      await target.connect(); connected = true;
      const restaurant = "95000000-0000-4000-8000-000000000001";
      const user = "95000000-0000-4000-8000-000000000002";
      const reservation = "95000000-0000-4000-8000-000000000003";
      const room = "95000000-0000-4000-8000-000000000004";
      const table = "95000000-0000-4000-8000-000000000005";
      const assignment = "95000000-0000-4000-8000-000000000006";
      const timestamp = new Date("2026-10-07T09:00:00.000Z");
      await target.query("INSERT INTO restaurants (id,name,timezone,updated_at) VALUES ($1,'Foundation Upgrade Fixture','Europe/Rome',$2)", [restaurant, timestamp]);
      await target.query("INSERT INTO users (id,restaurant_id,username,password_hash,role,updated_at) VALUES ($1,$2,'foundation.upgrade','synthetic-hash','STAFF',$3)", [user, restaurant, timestamp]);
      await target.query(`INSERT INTO reservations (id,restaurant_id,local_date,service_type,arrival_time,party_size,origin,customer_first_name,customer_last_name,customer_phone,privacy_policy_version,privacy_consent_at,privacy_consent_method,created_by_user_id,updated_at,preferences,arrived_at)
        VALUES ($1,$2,'2099-10-07','DINNER','19:30',6,'STAFF','Cliente','Upgrade Fittizio','+390000009500','foundation-upgrade-v1',$4,'STAFF_RECORDED',$3,$4,'{"children":true,"roomCode":"sala-3"}',$4)`, [reservation, restaurant, user, timestamp]);
      await target.query("INSERT INTO rooms (id,restaurant_id,name,code,updated_at) VALUES ($1,$2,'Legacy Sala 3','sala-3',$3)", [room, restaurant, timestamp]);
      await target.query("INSERT INTO dining_tables (id,room_id,name,minimum_seats,maximum_seats,updated_at) VALUES ($1,$2,'Tavolo Fixture',1,8,$3)", [table, room, timestamp]);
      await target.query("INSERT INTO reservation_assignments (id,restaurant_id,reservation_id,room_id,assigned_by_user_id,updated_by_user_id,updated_at) VALUES ($1,$2,$3,$4,$5,$5,$6)", [assignment, restaurant, reservation, room, user, timestamp]);
      await target.query("INSERT INTO reservation_assignment_tables (restaurant_id,assignment_id,room_id,dining_table_id) VALUES ($1,$2,$3,$4)", [restaurant, assignment, room, table]);
      await target.query(`INSERT INTO reservation_audit_events (id,restaurant_id,reservation_id,action,actor_origin,actor_user_id,actor_role,correlation_id,new_state,created_at)
        VALUES ('95000000-0000-4000-8000-000000000007',$1,$2,'CREATED','STAFF',$3,'STAFF','95000000-0000-4000-8000-000000000008','{"partySize":6}',$4)`, [restaurant, reservation, user, timestamp]);
      const preferenceBoundary = '"\\\nX'.repeat(250);
      const allergyBoundary = "H".repeat(1000);
      expect(preferenceBoundary).toHaveLength(1000);
      expect(allergyBoundary).toHaveLength(1000);
      for (const [id, preferences, allergies] of [
        ["95000000-0000-4000-8000-000000000009", preferenceBoundary, null],
        ["95000000-0000-4000-8000-000000000010", null, allergyBoundary],
      ]) {
        await target.query(`INSERT INTO reservations (id,restaurant_id,local_date,service_type,arrival_time,party_size,origin,customer_first_name,customer_last_name,customer_phone,privacy_policy_version,privacy_consent_at,privacy_consent_method,created_by_user_id,updated_at,preferences,allergies)
          SELECT $1,restaurant_id,local_date,service_type,arrival_time,party_size,origin,customer_first_name,customer_last_name,customer_phone,privacy_policy_version,privacy_consent_at,privacy_consent_method,created_by_user_id,updated_at,$2,$3 FROM reservations WHERE id=$4`, [id, preferences, allergies, reservation]);
      }
      const before = await state();
      expect((await target.query('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).rows[0].count).toBe(14);
      cpSync(join(migrations, foundationMigration), join(projectMigrations, foundationMigration), { recursive: true });
      await deploy();
      expect(await state()).toEqual(before);
      expect((await target.query("SELECT children_count,game_room_preference FROM reservations")).rows).toEqual(Array.from({ length: 3 }, () => ({ children_count: null, game_room_preference: null })));
      const storage = (await target.query("SELECT column_name,data_type,character_maximum_length,is_nullable,column_default FROM information_schema.columns WHERE table_name='reservations' AND column_name IN ('preferences','allergies','notes') ORDER BY column_name")).rows;
      expect(storage).toEqual([
        { column_name: "allergies", data_type: "text", character_maximum_length: null, is_nullable: "YES", column_default: null },
        { column_name: "notes", data_type: "character varying", character_maximum_length: 1000, is_nullable: "YES", column_default: null },
        { column_name: "preferences", data_type: "text", character_maximum_length: null, is_nullable: "YES", column_default: null },
      ]);
      expect((await target.query('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).rows[0].count).toBe(15);
      const columns = await target.query("SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name='reservations' AND column_name IN ('children_count','game_room_preference') ORDER BY column_name");
      expect(columns.rows).toEqual([
        { column_name: "children_count", is_nullable: "YES", column_default: null },
        { column_name: "game_room_preference", is_nullable: "YES", column_default: null },
      ]);
      const indexes = await target.query("SELECT indexdef FROM pg_indexes WHERE tablename='reservations'");
      expect(JSON.stringify(indexes.rows)).not.toMatch(/children_count|game_room_preference/u);
      for (const [children, games] of [[null, true], [null, false], [0, true], [0, false], [1, null], [-1, false], [7, true]]) {
        await expect(target.query("UPDATE reservations SET children_count=$2,game_room_preference=$3 WHERE id=$1", [reservation, children, games])).rejects.toMatchObject({ code: "23514" });
      }
      for (const [children, games] of [[0, null], [2, true], [2, false], [null, null]]) {
        await target.query("UPDATE reservations SET children_count=$2,game_room_preference=$3 WHERE id=$1", [reservation, children, games]);
      }
      expect(await state()).toEqual(before);
    } finally {
      if (connected) await target.end();
      await maintenance.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [database]);
      await maintenance.query(`DROP DATABASE IF EXISTS "${database}"`);
      expect((await maintenance.query("SELECT count(*)::int AS count FROM pg_database WHERE datname=$1", [database])).rows[0].count).toBe(0);
      await maintenance.end();
      if (!resolve(project).startsWith(`${evidenceRoot}${sep}`)) throw new Error("Unsafe upgrade fixture cleanup path.");
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("fresh migration chain 1–15 has lossless envelopes and bounded scalar notes", async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      expect((await client.query('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].count).toBe(15);
      expect((await client.query("SELECT column_name,data_type,character_maximum_length FROM information_schema.columns WHERE table_name='reservations' AND column_name IN ('preferences','allergies','notes') ORDER BY column_name")).rows).toEqual([
        { column_name: "allergies", data_type: "text", character_maximum_length: null },
        { column_name: "notes", data_type: "character varying", character_maximum_length: 1000 },
        { column_name: "preferences", data_type: "text", character_maximum_length: null },
      ]);
    } finally { await client.end(); }
  });
});
