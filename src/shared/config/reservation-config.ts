export const LOCAL_FAKE_PRIVACY_POLICY_VERSION = "local-demo-v1";
export const DEFAULT_RESERVATION_IDEMPOTENCY_TTL_HOURS = 24;

export interface ReservationConfig {
  privacyPolicyVersion: string;
  idempotencyTtlMs: number;
}

export function resolveReservationConfig(
  environment: Record<string, string | undefined> = process.env,
): ReservationConfig {
  const privacyPolicyVersion =
    environment.RESERVATION_PRIVACY_POLICY_VERSION?.trim() ||
    LOCAL_FAKE_PRIVACY_POLICY_VERSION;
  const ttlHoursValue =
    environment.RESERVATION_IDEMPOTENCY_TTL_HOURS?.trim() ||
    String(DEFAULT_RESERVATION_IDEMPOTENCY_TTL_HOURS);
  const ttlHours = Number(ttlHoursValue);

  if (
    privacyPolicyVersion.length === 0 ||
    privacyPolicyVersion.length > 64 ||
    !Number.isInteger(ttlHours) ||
    ttlHours < 1 ||
    ttlHours > 168
  ) {
    throw new Error("Invalid reservation configuration.");
  }

  return {
    privacyPolicyVersion,
    idempotencyTtlMs: ttlHours * 60 * 60 * 1000,
  };
}
