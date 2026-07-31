const DEFAULT_LOCAL_PORT = 4000;

export function resolvePort(configuredPort) {
  const normalizedPort = configuredPort?.trim() || String(DEFAULT_LOCAL_PORT);
  const numericPort = Number(normalizedPort);

  if (
    !/^\d+$/.test(normalizedPort) ||
    !Number.isInteger(numericPort) ||
    numericPort < 1 ||
    numericPort > 65_535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return normalizedPort;
}
