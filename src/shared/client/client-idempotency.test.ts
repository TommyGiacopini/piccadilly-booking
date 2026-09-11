import { describe, expect, it, vi } from "vitest";

import {
  createClientIdempotencyKey,
  resolveClientSubmissionIdentity,
  type ClientCryptography,
} from "@/shared/client/client-idempotency";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function deterministicCryptography(
  sequences: readonly (readonly number[])[],
): ClientCryptography {
  let index = 0;

  return {
    getRandomValues(array) {
      const sequence = sequences[index];
      if (!sequence) throw new Error("No deterministic sequence available.");
      array.set(sequence);
      index += 1;
      return array;
    },
  };
}

describe("client idempotency key", () => {
  it("uses randomUUID when it is available", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    const getRandomValues = vi.fn((array: Uint8Array) => array);

    expect(createClientIdempotencyKey({ randomUUID, getRandomValues })).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("falls back to getRandomValues when randomUUID is unavailable", () => {
    const cryptography = deterministicCryptography([
      Array.from({ length: 16 }, (_, index) => index),
    ]);

    expect(createClientIdempotencyKey(cryptography)).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
  });

  it("formats fallback output as an RFC-compatible UUID v4", () => {
    const cryptography = deterministicCryptography([new Array(16).fill(255)]);
    expect(createClientIdempotencyKey(cryptography)).toMatch(uuidV4Pattern);
  });

  it("sets the UUID version nibble to 4", () => {
    const cryptography = deterministicCryptography([new Array(16).fill(0)]);
    expect(createClientIdempotencyKey(cryptography)[14]).toBe("4");
  });

  it("sets the UUID variant to the RFC 4122/RFC 9562 variant", () => {
    const variants = [0x00, 0x40, 0x80, 0xc0].map((variant) => {
      const bytes = new Array(16).fill(0);
      bytes[8] = variant;
      return createClientIdempotencyKey(deterministicCryptography([bytes]))[19];
    });

    expect(variants).toEqual(["8", "8", "8", "8"]);
  });

  it("does not attempt randomUUID when it is not a function", () => {
    const getRandomValues = vi.fn((array: Uint8Array) => {
      array.fill(1);
      return array;
    });

    expect(
      createClientIdempotencyKey({ randomUUID: undefined, getRandomValues }),
    ).toMatch(uuidV4Pattern);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("fails closed when no secure random source is available", () => {
    expect(() => createClientIdempotencyKey(null)).toThrow(
      "Secure client randomness is unavailable.",
    );
    expect(() => createClientIdempotencyKey({})).toThrow(
      "Secure client randomness is unavailable.",
    );
  });

  it("propagates getRandomValues failures", () => {
    expect(() =>
      createClientIdempotencyKey({
        getRandomValues() {
          throw new Error("CSPRNG failed");
        },
      }),
    ).toThrow("CSPRNG failed");
  });

  it("generates different keys when secure bytes differ", () => {
    const cryptography = deterministicCryptography([
      new Array(16).fill(1),
      new Array(16).fill(2),
    ]);

    const first = createClientIdempotencyKey(cryptography);
    const second = createClientIdempotencyKey(cryptography);

    expect(first).not.toBe(second);
    expect(first).toMatch(uuidV4Pattern);
    expect(second).toMatch(uuidV4Pattern);
  });
});

describe("client submission identity", () => {
  it("preserves the same key for the same payload signature", () => {
    const createKey = vi.fn(() => "first-key");
    const first = resolveClientSubmissionIdentity(null, "same", createKey);
    const retry = resolveClientSubmissionIdentity(first, "same", createKey);

    expect(retry).toBe(first);
    expect(retry.key).toBe("first-key");
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("creates a new key when the payload signature changes", () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("first-key")
      .mockReturnValueOnce("second-key");
    const first = resolveClientSubmissionIdentity(null, "first", createKey);
    const changed = resolveClientSubmissionIdentity(
      first,
      "changed",
      createKey,
    );

    expect(changed).not.toBe(first);
    expect(changed.key).toBe("second-key");
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});
