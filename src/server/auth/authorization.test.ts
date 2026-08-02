import { describe, expect, it } from "vitest";

import { UserRole } from "@/generated/prisma/client";
import {
  canAccessAdminArea,
  canAccessStaffArea,
} from "@/server/auth/authorization";

describe("role authorization", () => {
  it("allows STAFF and ADMIN into protected staff areas", () => {
    expect(canAccessStaffArea(UserRole.STAFF)).toBe(true);
    expect(canAccessStaffArea(UserRole.ADMIN)).toBe(true);
  });

  it("allows only ADMIN into the technical admin area", () => {
    expect(canAccessAdminArea(UserRole.ADMIN)).toBe(true);
    expect(canAccessAdminArea(UserRole.STAFF)).toBe(false);
  });
});
