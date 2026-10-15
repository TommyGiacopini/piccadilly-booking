import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const migrations = resolve("prisma/migrations");
const names = readdirSync(migrations).filter((name) => /^\d+_/u.test(name)).sort();
const latest = "20261014000000_add_reservation_private_notes";
const prefixHashes = [
  [
    "20260731120000_create_restaurant_foundation",
    "2aaf5ba51b9a13976d84c72c6363f6ed58c79b49263da6d71f76501518562e23"
  ],
  [
    "20260802153732_add_authentication_users_sessions_rate_limits",
    "d8f7daf6c21000f4851373a6a55a6b337aefb3b3db2178f03d41ae9cb43ae994"
  ],
  [
    "20260803090743_add_operational_configuration",
    "89e07eb50367f498f6499b6e97ed9ff454cd11f42d98f913c74734668e6c5db6"
  ],
  [
    "20260803141513_add_reservation_core",
    "436c68d86cda37498a7a097a4fe3a672b9432a858dc52feac20cce039c7140b7"
  ],
  [
    "20260810090000_add_public_booking_management",
    "8058234de27c964ab072e91504a2728ac1e0a08d1c4f2ffae88e3a8bff033c50"
  ],
  [
    "20260810160000_add_authenticated_reservation_audit",
    "b048c92ccf809575e2cc23c934b8d41250c8ee639ffcafa018ae2a8839e907a6"
  ],
  [
    "20260812090000_add_admin_audit_foundation",
    "d1d6b02ed6ca3f352e189f9b485340c75a0dc412bfd8201f5ce5a5e283ff6cb8"
  ],
  [
    "20260812120000_add_user_lifecycle",
    "2fa7c53270cc251b0f8e47b5262e5a11d788ae14c4c6322f72db11a7b6a0a342"
  ],
  [
    "20260812160000_add_generic_booking_cutoff_rules",
    "42368e85e2a438161ba1dcc96ecd54445a83d18d12b6cfb904cd0a833df7271c"
  ],
  [
    "20260812200000_add_service_instance_room_availability",
    "ae1ccc3d7af2787e890d2996389a2c5790abff82c51c35440a5d46f179311d65"
  ],
  [
    "20260813123000_add_public_settings_and_content",
    "c2ca01936d3e09749d7f1a59cee709902fa5ad8efd356b6ccb2ab23c8e305521"
  ],
  [
    "20260813190000_add_reservation_assignments",
    "8c8d1e9d7e9ad185b85a008072f68c1dce8f457250fde0751059d831cb771a04"
  ],
  [
    "20260828120000_add_notification_outbox_and_simulators",
    "42ba74fc5e64a7fc8d16e9847be10464e9f0d91980e3e40900efda90b34e6c21"
  ],
  [
    "20260930120000_add_reservation_arrival_lifecycle",
    "adf794fe8ce56ab737398ea27d8512476523012d09988793906c9cf757427ebe"
  ],
  [
    "20261007120000_add_reservation_party_composition_and_game_room_preference",
    "efc047451059fcbc331f4458da044417c8e58a02c1c54b62df4eeadba7ee7632"
  ]
] as const;

describe("T06 additive private-notes migration16", () => {
  it("anchors the exact source latest16 and all migration1–15 checksums", () => {
    expect(names).toHaveLength(16); expect(names.at(-1)).toBe(latest);
    expect(names.slice(0, 15)).toEqual(prefixHashes.map(([name]) => name));
    for (const [name, hash] of prefixHashes) {
      expect(createHash("sha256").update(readFileSync(join(migrations, name, "migration.sql"))).digest("hex")).toBe(hash);
    }
    const sql = readFileSync(join(migrations, latest, "migration.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "private_notes" VARCHAR(1000)');
    expect(sql).toContain("ADD VALUE 'PRIVATE_NOTES_UPDATED'");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN|CREATE\s+INDEX)\b/iu);
    expect(sql).not.toMatch(/"private_notes"[^;]*(?:DEFAULT|NOT NULL)/iu);
    for (const action of ["CREATED", "UPDATED", "CANCELLED", "ASSIGNED", "REASSIGNED", "UNASSIGNED", "ARRIVAL_RECORDED", "ARRIVAL_REVERTED"]) expect(sql).toContain("'" + action + "'");
  });

  it("applies exact fresh16 with nullable bounded notes and the audit action", async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const rows = (await client.query('SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows;
      expect(rows.map((row) => row.migration_name)).toEqual(names);
      for (const row of rows) expect(row.checksum).toBe(createHash("sha256").update(readFileSync(join(migrations, row.migration_name, "migration.sql"))).digest("hex"));
      expect((await client.query("SELECT data_type,character_maximum_length,is_nullable,column_default FROM information_schema.columns WHERE table_name='reservations' AND column_name='private_notes'")).rows).toEqual([
        { data_type: "character varying", character_maximum_length: 1000, is_nullable: "YES", column_default: null },
      ]);
      expect((await client.query("SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ReservationAuditAction' ORDER BY enumsortorder")).rows.map((row) => row.enumlabel)).toContain("PRIVATE_NOTES_UPDATED");
    } finally { await client.end(); }
  });

  it("upgrades exactly15→16 without copying NC/legacy NI or changing data/FK/history", async () => {
    const source = new URL(process.env.DATABASE_URL ?? "");
    expect(source.pathname).toMatch(/^\/piccadilly_vitest_[0-9a-f]{32}$/u);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(source.hostname);
    const database = `piccadilly_notes_upgrade_${randomBytes(12).toString("hex")}`;
    const targetUrl = new URL(source); targetUrl.pathname = "/" + database;
    const maintenanceUrl = new URL(source); maintenanceUrl.pathname = "/postgres";
    const evidenceRoot = resolve("test-results");
    mkdirSync(evidenceRoot, { recursive: true });
    const project = mkdtempSync(join(evidenceRoot, "t06-notes-upgrade-"));
    const projectMigrations = join(project, "prisma", "migrations"); mkdirSync(projectMigrations, { recursive: true });
    cpSync(resolve("prisma/schema.prisma"), join(project, "prisma", "schema.prisma"));
    cpSync(join(migrations, "migration_lock.toml"), join(projectMigrations, "migration_lock.toml"));
    for (const name of names.slice(0, 15)) cpSync(join(migrations, name), join(projectMigrations, name), { recursive: true });
    const config = join(project, "prisma.config.ts");
    writeFileSync(config, `import { defineConfig } from "prisma/config";\nexport default defineConfig({schema:${JSON.stringify(join(project,"prisma/schema.prisma").replaceAll("\\","/"))},migrations:{path:${JSON.stringify(projectMigrations.replaceAll("\\","/"))}},datasource:{url:process.env.DATABASE_URL!}});\n`);
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    const target = new pg.Client({ connectionString: targetUrl.href });
    let connected = false;
    const deploy = async () => {
      try { await execFileAsync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", config],
        { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: targetUrl.href }, windowsHide: true });
      } catch { throw new Error("T06 isolated migration fixture deploy failed."); }
    };
    const state = async () => {
      const result: Record<string, unknown[]> = {};
      for (const table of ["restaurants", "users", "rooms", "dining_tables", "reservations", "reservation_assignments", "reservation_assignment_tables", "reservation_audit_events"]) {
        result[table] = (await target.query(`SELECT to_jsonb(t)-'private_notes' AS row FROM "${table}" t ORDER BY (to_jsonb(t)-'private_notes')::text`)).rows;
      }
      return result;
    };
    await maintenance.connect();
    try {
      await maintenance.query(`CREATE DATABASE "${database}"`); await deploy(); await target.connect(); connected = true;
      const restaurant = "96000000-0000-4000-8000-000000000001", user = "96000000-0000-4000-8000-000000000002";
      const room = "96000000-0000-4000-8000-000000000003", table = "96000000-0000-4000-8000-000000000004";
      const ids = ["96000000-0000-4000-8000-000000000011", "96000000-0000-4000-8000-000000000012", "96000000-0000-4000-8000-000000000013"];
      await target.query("INSERT INTO restaurants(id,name,timezone,updated_at) VALUES($1,'T06 synthetic migration','Europe/Rome',NOW())", [restaurant]);
      await target.query("INSERT INTO users(id,restaurant_id,username,password_hash,role,updated_at) VALUES($1,$2,'t06.migration','synthetic-hash','STAFF',NOW())", [user, restaurant]);
      await target.query("INSERT INTO rooms(id,restaurant_id,name,code,updated_at) VALUES($1,$2,'Sala 1','sala-1',NOW())", [room, restaurant]);
      await target.query("INSERT INTO dining_tables(id,room_id,name,minimum_seats,maximum_seats,updated_at) VALUES($1,$2,'T06 legacy table',1,4,NOW())", [table, room]);
      for (const [index, id] of ids.entries()) {
        await target.query(`INSERT INTO reservations(id,restaurant_id,local_date,service_type,arrival_time,party_size,origin,status,customer_first_name,customer_last_name,customer_phone,notes,privacy_policy_version,privacy_consent_at,privacy_consent_method,created_by_user_id,cancelled_at,updated_at)
          VALUES($1,$2,'2099-10-14','DINNER','19:00',2,'STAFF',$3::"ReservationStatus",'T06','Synthetic','+390000000600','T06_NC_MIGRATION','synthetic',NOW(),'STAFF_RECORDED',$4,CASE WHEN $3='CANCELLED' THEN NOW() ELSE NULL END,NOW())`,
          [id, restaurant, index === 2 ? "CANCELLED" : "CONFIRMED", user]);
        const assignment = "96000000-0000-4000-8000-" + String(21 + index).padStart(12, "0");
        await target.query("INSERT INTO reservation_assignments(id,restaurant_id,reservation_id,room_id,internal_notes,assigned_by_user_id,updated_by_user_id,cleared_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,CASE WHEN $7 THEN NOW() ELSE NULL END,NOW())",
          [assignment, restaurant, id, room, "T06_LEGACY_MIGRATION_" + index, user, index === 1]);
        await target.query("INSERT INTO reservation_assignment_tables(restaurant_id,assignment_id,room_id,dining_table_id) VALUES($1,$2,$3,$4)", [restaurant, assignment, room, table]);
      }
      const before = await state();
      const foreignKeysBefore = (await target.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' ORDER BY conname")).rows;
      const appliedBefore = (await target.query('SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows;
      expect(appliedBefore.map((row) => row.migration_name)).toEqual(names.slice(0, 15));
      cpSync(join(migrations, latest), join(projectMigrations, latest), { recursive: true }); await deploy();
      expect(await state()).toEqual(before);
      expect((await target.query("SELECT private_notes FROM reservations ORDER BY id")).rows).toEqual(ids.map(() => ({ private_notes: null })));
      expect((await target.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' ORDER BY conname")).rows).toEqual(foreignKeysBefore);
      const appliedAfter = (await target.query('SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows;
      expect(appliedAfter.map((row) => row.migration_name)).toEqual(names); expect(appliedAfter.slice(0, 15)).toEqual(appliedBefore);
      await target.query(`INSERT INTO reservation_audit_events(id,restaurant_id,reservation_id,action,actor_origin,actor_user_id,actor_role,correlation_id,previous_state,new_state)
        VALUES(gen_random_uuid(),$1,$2,'PRIVATE_NOTES_UPDATED','STAFF',$3,'STAFF',gen_random_uuid(),'{"privateNotes":{"present":false},"version":1}','{"privateNotes":{"present":true},"version":2}')`, [restaurant, ids[0], user]);
      const folder = resolve("test-results/t06-migration-evidence"); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "upgrade15to16.json"), JSON.stringify({ database, appliedBefore, appliedAfter, businessStatePreserved: true, foreignKeysPreserved: true, noBackfill: true, legacyState: before, newAuditActionUsable: true }, null, 2));
    } finally {
      if (connected) await target.end();
      await maintenance.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [database]);
      await maintenance.query(`DROP DATABASE IF EXISTS "${database}"`);
      expect((await maintenance.query("SELECT count(*)::int AS count FROM pg_database WHERE datname=$1", [database])).rows[0].count).toBe(0);
      await maintenance.end();
      if (!resolve(project).startsWith(evidenceRoot + sep)) throw new Error("Unsafe migration fixture cleanup path.");
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});
