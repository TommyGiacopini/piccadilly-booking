import { describe, expect, it } from "vitest";

import {
  buildStaffNavigation,
  isStaffNavigationActive,
} from "@/app/_components/staff/staff-shell";

describe("T01 Staff shell navigation", () => {
  it("keeps Admin destinations hidden from Staff", () => {
    expect(buildStaffNavigation("STAFF").map((item) => item.label)).toEqual([
      "Agenda",
      "ASSEGNA SALA",
      "Nuova prenotazione",
    ]);
  });

  it("exposes only existing authorized destinations to Admin", () => {
    expect(buildStaffNavigation("ADMIN").map((item) => item.label)).toEqual([
      "Agenda",
      "ASSEGNA SALA",
      "Nuova prenotazione",
      "Configurazioni",
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
    expect(isStaffNavigationActive("/admin/users", "/admin")).toBe(true);
    expect(
      isStaffNavigationActive("/admin/configuration", "/admin"),
    ).toBe(false);
  });
});
