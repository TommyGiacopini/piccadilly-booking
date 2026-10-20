import { describe, expect, it } from "vitest";

import {
  buildStaffNavigation,
  isStaffNavigationActive,
  navigationGroupsForRole,
  navigationGroupForPath,
  staffBreadcrumbs,
} from "@/app/_components/staff/staff-navigation";

describe("T01 Staff shell navigation", () => {
  it("keeps Admin destinations hidden from Staff", () => {
    expect(buildStaffNavigation("STAFF").map((item) => item.label)).toEqual([
      "Agenda",
      "Nuova prenotazione",
      "ASSEGNA SALA",
    ]);
  });

  it("exposes only existing authorized destinations to Admin", () => {
    expect(buildStaffNavigation("ADMIN").map((item) => item.label)).toEqual([
      "Agenda",
      "Nuova prenotazione",
      "ASSEGNA SALA",
      "Impostazioni operative",
      "Orari settimanali",
      "Date speciali",
      "Sale",
      "Anteprima disponibilità",
      "Contenuti pubblici IT/EN",
      "Notifiche",
      "Gestione utenti",
      "Registro audit",
      "Admin",
    ]);
  });

  it("distinguishes Agenda, creation and Admin active states", () => {
    expect(isStaffNavigationActive("/dashboard/assign-room", "/dashboard")).toBe(false);
    expect(isStaffNavigationActive("/dashboard/assign-room", "/dashboard/assign-room")).toBe(true);
    expect(isStaffNavigationActive("/dashboard", "/dashboard")).toBe(true);
    expect(
      isStaffNavigationActive(
        "/dashboard/reservations/new",
        "/dashboard/reservations/new",
      ),
    ).toBe(true);
    expect(
      isStaffNavigationActive("/dashboard/reservations/new", "/dashboard"),
    ).toBe(false);
    expect(isStaffNavigationActive("/admin/users", "/admin")).toBe(false);
    expect(isStaffNavigationActive("/admin/users", "/admin/users")).toBe(true);
    expect(
      isStaffNavigationActive("/admin/configuration", "/admin"),
    ).toBe(false);
  });
});

describe("T06-D metadata and breadcrumb contract", () => {
  it("retains four Owner groups and nine unique Admin leaves", () => {
    expect(navigationGroupsForRole("ADMIN").map(group => [group.label, group.items.length])).toEqual([
      ["Operatività", 3], ["Configurazione", 5], ["Comunicazione", 2], ["Amministrazione", 2],
    ]);
    expect(navigationGroupsForRole("STAFF").map(group => group.id)).toEqual(["operations"]);
    const all = buildStaffNavigation("ADMIN");
    expect(new Set(all.map(item => item.href)).size).toBe(13);
    expect(all.filter(item => item.href.startsWith("/admin/")).length).toBe(9);
    expect(buildStaffNavigation("STAFF").every(item => item.href.startsWith("/dashboard"))).toBe(true);
  });
  it.each([
    ["/dashboard", "/dashboard"], ["/dashboard/assign-room", "/dashboard/assign-room"],
    ["/dashboard/reservations/new", "/dashboard/reservations/new"],
    ["/dashboard/reservations/123e4567-e89b-42d3-a456-426614174000/edit", "/dashboard"],
    ["/admin", "/admin"], ["/admin/users", "/admin/users"], ["/admin/configuration", "/admin/configuration"],
    ["/admin/rooms/service", "/admin/rooms"],
  ])("selects exactly one active destination for %s", (path, href) => {
    expect(buildStaffNavigation("ADMIN").filter(item => isStaffNavigationActive(path, item.href)).map(item => item.href)).toEqual([href]);
  });
  it.each(["/admin/rooms-extra", "/admin/users-old", "/admin/configuration-old", "/administrator"])("rejects similar prefix %s", path => {
    expect(buildStaffNavigation("ADMIN").filter(item => isStaffNavigationActive(path, item.href))).toEqual([]);
  });
  it("normalizes trailing slash, query and hash without widening segment matching", () => {
    expect(isStaffNavigationActive("/admin/rooms/?date=2099-01-01#details", "/admin/rooms")).toBe(true);
    expect(isStaffNavigationActive("/dashboard/reservations/newspaper", "/dashboard/reservations/new")).toBe(false);
    expect(navigationGroupForPath("/admin/notification-settings")?.id).toBe("communication");
    expect(navigationGroupForPath("/unknown")).toBeUndefined();
  });
  it("uses only canonical breadcrumb destinations and no fabricated group URL", () => {
    expect(staffBreadcrumbs("/admin/rooms", "ADMIN")).toEqual([{ label: "Hub Admin", href: "/admin" }, { label: "Configurazione" }, { label: "Sale" }]);
    expect(staffBreadcrumbs("/admin", "ADMIN")).toEqual([{ label: "Hub Admin" }]);
    expect(staffBreadcrumbs("/admin/users", "STAFF")).toEqual([]);
    expect(staffBreadcrumbs("/unknown?personal=ARTIFICIAL", "ADMIN")).toEqual([]);
  });
  it("does not display resource UUIDs or private query values", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const result = staffBreadcrumbs(`/dashboard/reservations/${id}/edit?notes=ARTIFICIAL_PRIVATE`, "STAFF");
    expect(result).toEqual([{ label: "Agenda", href: "/dashboard" }, { label: "Dettaglio prenotazione", href: "/dashboard/reservations/" + id }, { label: "Modifica" }]);
    expect(result.map(item => item.label).join(" ")).not.toContain(id);
    expect(JSON.stringify(result)).not.toContain("ARTIFICIAL_PRIVATE");
    expect(JSON.stringify(staffBreadcrumbs("/dashboard/reservations/not-a-uuid/edit", "STAFF"))).not.toContain("not-a-uuid");
  });
});
