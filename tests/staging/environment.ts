export interface StagingPlaywrightEnvironment {
  baseURL: string;
  basicAuth: { username: string; password: string };
  admin: { username: string; password: string };
  staff: { username: string; password: string };
  runId: string;
}

function required(
  environment: Record<string, string | undefined>,
  key: string,
): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Missing staging Playwright configuration: ${key}.`);
  return value;
}

export function resolveStagingPlaywrightEnvironment(
  environment: Record<string, string | undefined> = process.env,
): StagingPlaywrightEnvironment {
  if (environment.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL must not be present in the staging Playwright process.");
  }

  const configuredUrl = required(environment, "STAGING_BASE_URL");
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("STAGING_BASE_URL must be an HTTPS onrender.com root URL.");
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/.test(
      url.hostname.toLowerCase(),
    ) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("STAGING_BASE_URL must be an HTTPS onrender.com root URL.");
  }
  url.pathname = "/";

  const runId = required(environment, "STAGING_RUN_ID").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{7,31}$/.test(runId)) {
    throw new Error("STAGING_RUN_ID is invalid.");
  }

  return {
    baseURL: url.toString().replace(/\/$/, ""),
    basicAuth: {
      username: required(environment, "STAGING_ACCESS_USERNAME"),
      password: required(environment, "STAGING_ACCESS_PASSWORD"),
    },
    admin: {
      username: required(environment, "STAGING_ADMIN_USERNAME"),
      password: required(environment, "STAGING_ADMIN_PASSWORD"),
    },
    staff: {
      username: required(environment, "STAGING_STAFF_USERNAME"),
      password: required(environment, "STAGING_STAFF_PASSWORD"),
    },
    runId,
  };
}

export function futureRestaurantDate(
  now = new Date(),
  daysAfterToday: 7 | 13 = 7,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(
    Date.UTC(value("year"), value("month") - 1, value("day") + daysAfterToday),
  );
  return date.toISOString().slice(0, 10);
}
