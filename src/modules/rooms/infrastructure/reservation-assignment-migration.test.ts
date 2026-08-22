import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(process.cwd(), "prisma", "migrations");
const migrationNames = readdirSync(migrationsDirectory).filter((name) =>
  /^\d+_/u.test(name),
);
const assignmentMigrations = migrationNames.filter((name) =>
  name.endsWith("_add_reservation_assignments"),
);
const previousMigrationHashes: Record<string, string> = {
  "20260731120000_create_restaurant_foundation":
    "2AAF5BA51B9A13976D84C72C6363F6ED58C79B49263DA6D71F76501518562E23",
  "20260802153732_add_authentication_users_sessions_rate_limits":
    "D8F7DAF6C21000F4851373A6A55A6B337AEFB3B3DB2178F03D41AE9CB43AE994",
  "20260803090743_add_operational_configuration":
    "89E07EB50367F498F6499B6E97ED9FF454CD11F42D98F913C74734668E6C5DB6",
  "20260803141513_add_reservation_core":
    "436C68D86CDA37498A7A097A4FE3A672B9432A858DC52FEAC20CCE039C7140B7",
  "20260810090000_add_public_booking_management":
    "8058234DE27C964AB072E91504A2728AC1E0A08D1C4F2FFAE88E3A8BFF033C50",
  "20260810160000_add_authenticated_reservation_audit":
    "B048C92CCF809575E2CC23C934B8D41250C8EE639FFCAFA018AE2A8839E907A6",
  "20260812090000_add_admin_audit_foundation":
    "D1D6B02ED6CA3F352E189F9B485340C75A0DC412BFD8201F5CE5A5E283FF6CB8",
  "20260812120000_add_user_lifecycle":
    "2FA7C53270CC251B0F8E47B5262E5A11D788AE14C4C6322F72DB11A7B6A0A342",
  "20260812160000_add_generic_booking_cutoff_rules":
    "42368E85E2A438161BA1DCC96ECD54445A83D18D12B6CFB904CD0A833DF7271C",
  "20260812200000_add_service_instance_room_availability":
    "AE1CCC3D7AF2787E890D2996389A2C5790ABFF82C51C35440A5D46F179311D65",
  "20260813123000_add_public_settings_and_content":
    "C2CA01936D3E09749D7F1A59CEE709902FA5AD8EFD356B6CCB2AB23C8E305521",
};

describe("M10-A additive migration", () => {
  it("adds exactly one migration and leaves all eleven predecessors byte-identical", () => {
    expect(migrationNames).toHaveLength(12);
    expect(assignmentMigrations).toHaveLength(1);

    for (const [name, expectedHash] of Object.entries(
      previousMigrationHashes,
    )) {
      const contents = readFileSync(
        resolve(migrationsDirectory, name, "migration.sql"),
      );
      expect(createHash("sha256").update(contents).digest("hex").toUpperCase())
        .toBe(expectedHash);
    }
  });

  it("contains tenant-scoped restrictive keys and no operational backfill", () => {
    const sql = readFileSync(
      resolve(
        migrationsDirectory,
        assignmentMigrations[0]!,
        "migration.sql",
      ),
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE "reservation_assignments"');
    expect(sql).toContain('CREATE TABLE "reservation_assignment_tables"');
    expect(sql).toContain(
      'FOREIGN KEY ("restaurant_id", "reservation_id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("restaurant_id", "assignment_id", "room_id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("room_id", "dining_table_id")',
    );
    expect(sql.match(/ON DELETE RESTRICT/gu)).toHaveLength(7);
    expect(sql).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:reservations|rooms|dining_tables|service_instances|reservation_audit_events)"?/iu,
    );
    expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER/iu);
    expect(sql).not.toMatch(/EXCLUDE|occup|duration/iu);
  });

  it("keeps reservations independent from ServiceInstance", () => {
    const schema = readFileSync(
      resolve(process.cwd(), "prisma", "schema.prisma"),
      "utf8",
    );
    const reservationModel = schema.match(
      /model Reservation \{[\s\S]*?\n\}/u,
    )?.[0];
    expect(reservationModel).toBeDefined();
    expect(reservationModel).not.toContain("ServiceInstance");
  });

  it("keeps assignments and internal notes out of the public reservation DTO", () => {
    const publicDto = readFileSync(
      resolve(
        process.cwd(),
        "src",
        "modules",
        "reservations",
        "domain",
        "public-dto.ts",
      ),
      "utf8",
    );

    expect(publicDto).not.toMatch(/assignment/iu);
    expect(publicDto).not.toContain("internalNotes");
  });
});
