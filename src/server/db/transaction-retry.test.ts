import { describe, expect, it } from "vitest";

import { isRetryableTransactionConflict } from "@/server/db/transaction-retry";

describe("transaction conflict classification", () => {
  it("recognizes Prisma and driver-adapter serialization conflicts", () => {
    expect(isRetryableTransactionConflict({ code: "P2034" })).toBe(true);
    expect(
      isRetryableTransactionConflict({
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      }),
    ).toBe(true);
    expect(
      isRetryableTransactionConflict({
        meta: {
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not classify unrelated database or application errors", () => {
    expect(isRetryableTransactionConflict({ code: "P2002" })).toBe(false);
    expect(
      isRetryableTransactionConflict({
        name: "DriverAdapterError",
        cause: { kind: "UniqueConstraintViolation" },
      }),
    ).toBe(false);
    expect(isRetryableTransactionConflict(new Error("failed"))).toBe(false);
  });
});
