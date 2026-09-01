const APP_ENVIRONMENTS = new Set(["development", "staging", "production"]);
const DEMO_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";
const ONRENDER_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/;

const WEB_REQUIRED_ENVIRONMENT_KEYS = [
  "DATABASE_URL",
  "RENDER_EXTERNAL_URL",
  "AUTH_RESTAURANT_ID",
  "AUTH_RATE_LIMIT_SECRET",
  "PUBLIC_BOOKING_MANAGEMENT_SECRET",
  "PUBLIC_BOOKING_RATE_LIMIT_SECRET",
  "PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS",
  "PUBLIC_BOOKING_READ_LIMIT",
  "PUBLIC_BOOKING_MUTATION_LIMIT",
  "RESERVATION_PRIVACY_POLICY_VERSION",
  "RESERVATION_TERMS_VERSION",
  "RESERVATION_IDEMPOTENCY_TTL_HOURS",
  "STAGING_ACCESS_USERNAME",
  "STAGING_ACCESS_PASSWORD",
  "AUTH_DEMO_ADMIN_PASSWORD",
  "AUTH_DEMO_STAFF_PASSWORD",
];

const FORBIDDEN_PROVIDER_KEY_PATTERN =
  /(^|_)(META|GRAPH|GRAPH_API|SMTP|SES|RESEND|SENDGRID)(_|$)/i;
const PROVIDER_CREDENTIAL_KEY_PATTERN =
  /(^|_)(PROVIDER|WHATSAPP|EMAIL)(_|.*_)(URL|TOKEN|API_KEY|SECRET|MODE)$/i;

function requireExactValue(environment, key, expected) {
  if (environment[key] !== expected) {
    throw new Error(`Invalid staging configuration for ${key}.`);
  }
}

function requireNonEmpty(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required staging configuration: ${key}.`);
  }
  return value.trim();
}

export function resolveApplicationEnvironment(configuredEnvironment) {
  const normalized = configuredEnvironment?.trim().toLowerCase() || "development";
  if (!APP_ENVIRONMENTS.has(normalized)) {
    throw new Error("Unsupported APP_ENV value.");
  }
  return normalized;
}

export function assertNoRealProviderConfiguration(environment) {
  for (const [key, rawValue] of Object.entries(environment)) {
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) continue;
    const value = rawValue.trim();
    const normalizedKey = key.toUpperCase();

    if (
      FORBIDDEN_PROVIDER_KEY_PATTERN.test(normalizedKey) ||
      PROVIDER_CREDENTIAL_KEY_PATTERN.test(normalizedKey) ||
      ((normalizedKey.includes("PROVIDER") || normalizedKey.endsWith("_MODE")) &&
        value.toUpperCase() === "REAL")
    ) {
      throw new Error("Real notification provider configuration is forbidden in staging.");
    }
  }
}

export function resolveOnrenderExternalUrl(configuredUrl) {
  let parsed;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("RENDER_EXTERNAL_URL must be a valid HTTPS onrender.com URL.");
  }

  if (
    parsed.protocol !== "https:" ||
    !ONRENDER_HOST_PATTERN.test(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("RENDER_EXTERNAL_URL must be a valid HTTPS onrender.com URL.");
  }

  parsed.pathname = "/";
  return parsed.toString();
}

function validateDatabaseUrl(configuredUrl) {
  let parsed;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  }
}

function validateInteger(environment, key, minimum, maximum) {
  const value = requireNonEmpty(environment, key);
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid staging numeric configuration for ${key}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid staging numeric configuration for ${key}.`);
  }
}

function validateCommonStagingEnvironment(environment, serviceType) {
  requireExactValue(environment, "APP_ENV", "staging");
  requireExactValue(environment, "RENDER", "true");
  requireExactValue(environment, "RENDER_SERVICE_TYPE", serviceType);
  validateDatabaseUrl(requireNonEmpty(environment, "DATABASE_URL"));
  assertNoRealProviderConfiguration(environment);
}

export function validateStagingWebEnvironment(environment = process.env) {
  validateCommonStagingEnvironment(environment, "web");
  requireExactValue(environment, "AUTH_TRUST_PROXY", "true");

  for (const key of WEB_REQUIRED_ENVIRONMENT_KEYS) {
    requireNonEmpty(environment, key);
  }

  if (environment.AUTH_RESTAURANT_ID !== DEMO_RESTAURANT_ID) {
    throw new Error("Staging must use the exact demo restaurant tenant.");
  }

  for (const key of [
    "AUTH_RATE_LIMIT_SECRET",
    "PUBLIC_BOOKING_MANAGEMENT_SECRET",
    "PUBLIC_BOOKING_RATE_LIMIT_SECRET",
  ]) {
    const value = requireNonEmpty(environment, key);
    if (value.length < 32 || value.startsWith("local-only-")) {
      throw new Error(`Invalid staging secret configuration for ${key}.`);
    }
  }

  validateInteger(environment, "PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS", 1, 86_400);
  validateInteger(environment, "PUBLIC_BOOKING_READ_LIMIT", 1, 10_000);
  validateInteger(environment, "PUBLIC_BOOKING_MUTATION_LIMIT", 1, 10_000);
  validateInteger(environment, "RESERVATION_IDEMPOTENCY_TTL_HOURS", 1, 168);

  for (const key of [
    "RESERVATION_PRIVACY_POLICY_VERSION",
    "RESERVATION_TERMS_VERSION",
  ]) {
    if (requireNonEmpty(environment, key).length > 64) {
      throw new Error(`Invalid staging configuration for ${key}.`);
    }
  }

  return {
    serviceType: "web",
    externalUrl: resolveOnrenderExternalUrl(environment.RENDER_EXTERNAL_URL),
  };
}

export function validateStagingWorkerEnvironment(environment = process.env) {
  validateCommonStagingEnvironment(environment, "worker");
  return { serviceType: "worker" };
}
