export const APP_ENVIRONMENTS = [
  "development",
  "staging",
  "production",
] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const DEFAULT_APP_ENVIRONMENT: AppEnvironment = "development";

export function resolveAppEnvironment(
  configuredEnvironment: string | undefined,
): AppEnvironment {
  if (!configuredEnvironment?.trim()) {
    return DEFAULT_APP_ENVIRONMENT;
  }

  const normalizedEnvironment = configuredEnvironment.trim().toLowerCase();

  if (APP_ENVIRONMENTS.some((environment) => environment === normalizedEnvironment)) {
    return normalizedEnvironment as AppEnvironment;
  }

  throw new Error(
    `Unsupported APP_ENV value. Expected one of: ${APP_ENVIRONMENTS.join(", ")}.`,
  );
}

export function getAppEnvironment(): AppEnvironment {
  return resolveAppEnvironment(process.env.APP_ENV);
}
