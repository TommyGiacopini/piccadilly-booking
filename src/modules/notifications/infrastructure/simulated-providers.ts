import "server-only";

import type {
  NotificationProvider,
  NotificationProviderRequest,
  NotificationProviderResult,
} from "@/modules/notifications/application/ports";
import { notificationPayloadHash } from "@/modules/notifications/domain/delivery-policy";
import type { NotificationProviderKind } from "@/modules/notifications/domain/types";
import {
  createOrReadSimulationReceipt,
  type SimulationReceiptResult,
} from "@/modules/notifications/infrastructure/simulation-receipt-repository";

export type SimulatedProviderMode =
  | { type: "SUCCESS" }
  | { type: "TRANSIENT_THEN_SUCCESS"; failures: number }
  | { type: "PERMANENT" }
  | { type: "TIMEOUT" }
  | { type: "TIMEOUT_AFTER_RECEIPT" };

export type SimulationReceiptWriter = (input: {
  restaurantId: string;
  outboxId: string;
  providerKind: NotificationProviderKind;
  idempotencyKey: string;
  payloadHash: string;
}) => Promise<SimulationReceiptResult>;

class SimulatedNotificationProvider implements NotificationProvider {
  private readonly calls = new Map<string, number>();

  constructor(
    private readonly providerKind: NotificationProviderKind,
    private readonly mode: SimulatedProviderMode,
    private readonly receipts: SimulationReceiptWriter,
  ) {}

  private async receipt(
    request: NotificationProviderRequest,
  ): Promise<NotificationProviderResult> {
    const receipt = await this.receipts({
      restaurantId: request.context.restaurantId,
      outboxId: request.context.outboxId,
      providerKind: this.providerKind,
      idempotencyKey: request.idempotencyKey,
      payloadHash: notificationPayloadHash(request.message),
    });
    return receipt.type === "CONFLICT"
      ? { type: "PERMANENT_FAILURE", failureCode: "IDEMPOTENCY_CONFLICT" }
      : {
          type: "SUCCESS",
          providerReference: receipt.providerReference,
          deduplicated: receipt.deduplicated,
        };
  }

  async send(
    request: NotificationProviderRequest,
    options: { signal: AbortSignal },
  ): Promise<NotificationProviderResult> {
    options.signal.throwIfAborted();
    const call = (this.calls.get(request.idempotencyKey) ?? 0) + 1;
    this.calls.set(request.idempotencyKey, call);
    switch (this.mode.type) {
      case "SUCCESS":
        return this.receipt(request).then((result) => {
          options.signal.throwIfAborted();
          return result;
        });
      case "TRANSIENT_THEN_SUCCESS":
        return call <= this.mode.failures
          ? {
              type: "TRANSIENT_FAILURE",
              failureCode: "SIMULATED_TRANSIENT_FAILURE",
            }
          : this.receipt(request).then((result) => {
              options.signal.throwIfAborted();
              return result;
            });
      case "PERMANENT":
        return {
          type: "PERMANENT_FAILURE",
          failureCode: "SIMULATED_PERMANENT_FAILURE",
        };
      case "TIMEOUT":
        return {
          type: "TRANSIENT_FAILURE",
          failureCode: "SIMULATED_TIMEOUT",
        };
      case "TIMEOUT_AFTER_RECEIPT": {
        const result = await this.receipt(request);
        options.signal.throwIfAborted();
        return result.type === "SUCCESS" && !result.deduplicated
          ? {
              type: "TRANSIENT_FAILURE",
              failureCode: "SIMULATED_TIMEOUT",
            }
          : result;
      }
    }
  }
}

export class SimulatedWhatsAppProvider extends SimulatedNotificationProvider {
  constructor(
    mode: SimulatedProviderMode = { type: "SUCCESS" },
    receipts: SimulationReceiptWriter = createOrReadSimulationReceipt,
  ) {
    super("SIMULATED_WHATSAPP", mode, receipts);
  }
}

export class SimulatedEmailProvider extends SimulatedNotificationProvider {
  constructor(
    mode: SimulatedProviderMode = { type: "SUCCESS" },
    receipts: SimulationReceiptWriter = createOrReadSimulationReceipt,
  ) {
    super("SIMULATED_EMAIL", mode, receipts);
  }
}
