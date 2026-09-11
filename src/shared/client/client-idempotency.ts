export interface ClientCryptography {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export interface ClientSubmissionIdentity {
  signature: string;
  key: string;
}

function formatUuidV4(bytes: Uint8Array): string {
  const hexadecimal = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

export function createClientIdempotencyKey(
  cryptography: ClientCryptography | null | undefined = globalThis.crypto,
): string {
  if (typeof cryptography?.randomUUID === "function") {
    return cryptography.randomUUID();
  }

  if (typeof cryptography?.getRandomValues !== "function") {
    throw new Error("Secure client randomness is unavailable.");
  }

  const bytes = cryptography.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuidV4(bytes);
}

export function resolveClientSubmissionIdentity(
  current: ClientSubmissionIdentity | null,
  signature: string,
  createKey: () => string = createClientIdempotencyKey,
): ClientSubmissionIdentity {
  if (current?.signature === signature) return current;

  return { signature, key: createKey() };
}
