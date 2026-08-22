import { createHmac } from "node:crypto";

const E2E_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const E2E_TEMPLATE_RESTAURANT_ID =
  "00000000-0000-4000-8000-000000000001";

export function parseE2eRunId(value: string | undefined): string {
  const runId = value?.trim();
  if (!runId || !E2E_RUN_ID_PATTERN.test(runId)) {
    throw new Error("E2E_RUN_ID must be a valid UUID.");
  }
  return runId.toLowerCase();
}

export function e2eRestaurantId(runId: string): string {
  return parseE2eRunId(runId);
}

export function e2eRestaurantName(runId: string): string {
  return `Piccadilly E2E ${parseE2eRunId(runId)}`;
}

export function e2eAdminUsername(runId: string): string {
  return `e2e.admin.${parseE2eRunId(runId)}`;
}

export function e2eAdminUserId(runId: string): string {
  return `${parseE2eRunId(runId).slice(0, -1)}a`;
}

export function e2eStaffUsername(runId: string): string {
  return `e2e.staff.${parseE2eRunId(runId)}`;
}

export function e2eStaffUserId(runId: string): string {
  return `${parseE2eRunId(runId).slice(0, -1)}b`;
}

export function e2eReservationFirstName(runId: string): string {
  return `E2E-${parseE2eRunId(runId)}`;
}

export function e2eDiningTableName(runId: string): string {
  return `E2E-${parseE2eRunId(runId)}`;
}

export function e2eCreatedUsernames(runId: string): string[] {
  const normalized = parseE2eRunId(runId);
  return [
    `e2e.audit.must.${normalized}`,
    `e2e.staff.create.${normalized}`,
    `e2e.staff.reset.${normalized}`,
  ];
}

export function e2eOwnedUsernames(runId: string): string[] {
  return [
    e2eAdminUsername(runId),
    e2eStaffUsername(runId),
    ...e2eCreatedUsernames(runId),
  ];
}

export function e2ePublicRateLimitSecret(runId: string): string {
  return `e2e-only-public-rate-limit-${parseE2eRunId(runId)}`;
}

export function e2eAuthRateLimitSecret(runId: string): string {
  return `e2e-only-auth-rate-limit-${parseE2eRunId(runId)}`;
}

export function e2eLoginRateLimitHashes(runId: string): string[] {
  const secret = e2eAuthRateLimitSecret(runId);
  const clientAddresses = ["direct-client"] as const;

  return e2eOwnedUsernames(runId)
    .flatMap((username) =>
      clientAddresses.map((clientAddress) =>
        createHmac("sha256", secret)
          .update(`${clientAddress}\u0000${username}`, "utf8")
          .digest("hex"),
      ),
    )
    .sort();
}

export function e2ePurgeOptIn(runId: string): string {
  return `purge-e2e-run-${parseE2eRunId(runId)}`;
}
