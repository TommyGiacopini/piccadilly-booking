import { describe, expect, it } from "vitest";

import type { NotificationProviderRequest } from "@/modules/notifications/application/ports";
import {
  SimulatedEmailProvider,
  SimulatedWhatsAppProvider,
  type SimulationReceiptWriter,
} from "@/modules/notifications/infrastructure/simulated-providers";

const request: NotificationProviderRequest = {
  destination: "+39000000000",
  message: {
    templateKey: "RESERVATION_CONFIRMED",
    templateVersion: 1,
    locale: "IT",
    params: {
      customerFirstName: "Ada",
      restaurantName: "Piccadilly Demo",
      localDate: "2028-08-20",
      serviceType: "DINNER",
      arrivalTime: "20:00",
      partySize: 2,
    },
  },
  idempotencyKey: "a".repeat(64),
  correlationId: "10000000-0000-4000-8000-000000000001",
  context: {
    restaurantId: "10000000-0000-4000-8000-000000000002",
    outboxId: "10000000-0000-4000-8000-000000000003",
    providerKind: "SIMULATED_WHATSAPP",
  },
};
const options = () => ({ signal: new AbortController().signal });

function memoryReceipts(): SimulationReceiptWriter {
  const receipts = new Map<string, { hash: string; reference: string }>();
  return async (input) => {
    const existing = receipts.get(input.idempotencyKey);
    if (existing && existing.hash !== input.payloadHash) return { type: "CONFLICT" };
    if (existing) return { type: "RECEIPT", providerReference: existing.reference, deduplicated: true };
    const reference = `sim-${receipts.size + 1}`;
    receipts.set(input.idempotencyKey, { hash: input.payloadHash, reference });
    return { type: "RECEIPT", providerReference: reference, deduplicated: false };
  };
}

describe("simulated notification providers", () => {
  it("succeeds and persistently deduplicates the same logical request", async () => {
    const provider = new SimulatedWhatsAppProvider({ type: "SUCCESS" }, memoryReceipts());
    const first = await provider.send(request, options());
    const replay = await provider.send(request, options());
    expect(first).toMatchObject({ type: "SUCCESS", deduplicated: false });
    expect(replay).toEqual({ ...first, deduplicated: true });
  });

  it("returns transient failures N times then succeeds", async () => {
    const provider = new SimulatedWhatsAppProvider({ type: "TRANSIENT_THEN_SUCCESS", failures: 2 }, memoryReceipts());
    expect(await provider.send(request, options())).toEqual({ type: "TRANSIENT_FAILURE", failureCode: "SIMULATED_TRANSIENT_FAILURE" });
    expect(await provider.send(request, options())).toEqual({ type: "TRANSIENT_FAILURE", failureCode: "SIMULATED_TRANSIENT_FAILURE" });
    expect(await provider.send(request, options())).toMatchObject({ type: "SUCCESS", deduplicated: false });
  });

  it("supports permanent and timeout modes without throwing raw errors", async () => {
    expect(await new SimulatedEmailProvider({ type: "PERMANENT" }, memoryReceipts()).send(request, options())).toEqual({ type: "PERMANENT_FAILURE", failureCode: "SIMULATED_PERMANENT_FAILURE" });
    expect(await new SimulatedEmailProvider({ type: "TIMEOUT" }, memoryReceipts()).send(request, options())).toEqual({ type: "TRANSIENT_FAILURE", failureCode: "SIMULATED_TIMEOUT" });
  });

  it("models a timeout after receipt followed by deduplicated success", async () => {
    const provider = new SimulatedWhatsAppProvider({ type: "TIMEOUT_AFTER_RECEIPT" }, memoryReceipts());
    expect(await provider.send(request, options())).toEqual({ type: "TRANSIENT_FAILURE", failureCode: "SIMULATED_TIMEOUT" });
    expect(await provider.send(request, options())).toMatchObject({ type: "SUCCESS", deduplicated: true });
  });

  it("turns the same key with a different payload into an idempotency conflict", async () => {
    const provider = new SimulatedWhatsAppProvider({ type: "SUCCESS" }, memoryReceipts());
    await provider.send(request, options());
    expect(await provider.send({ ...request, message: { ...request.message, locale: "EN" } }, options())).toEqual({
      type: "PERMANENT_FAILURE",
      failureCode: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("honors a server-side abort signal before touching a receipt", async () => {
    let receiptCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const provider = new SimulatedWhatsAppProvider(
      { type: "SUCCESS" },
      async () => {
        receiptCalls += 1;
        return {
          type: "RECEIPT",
          providerReference: "unexpected",
          deduplicated: false,
        };
      },
    );
    await expect(
      provider.send(request, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(receiptCalls).toBe(0);
  });
});
