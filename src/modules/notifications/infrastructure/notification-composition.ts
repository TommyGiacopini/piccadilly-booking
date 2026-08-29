import "server-only";

import { randomUUID } from "node:crypto";

import type { NotificationWorkerDependencies } from "@/modules/notifications/application/worker";
import { PrismaNotificationWorkerRepository } from "@/modules/notifications/infrastructure/notification-worker-repository";
import {
  SimulatedEmailProvider,
  SimulatedWhatsAppProvider,
  type SimulatedProviderMode,
} from "@/modules/notifications/infrastructure/simulated-providers";

export const systemClock = { now: () => new Date() };

export const realSleeper = {
  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  },
};

export function createNotificationWorkerDependencies(input?: {
  whatsappMode?: SimulatedProviderMode;
  emailMode?: SimulatedProviderMode;
}): NotificationWorkerDependencies {
  return {
    repository: new PrismaNotificationWorkerRepository(),
    whatsappProvider: new SimulatedWhatsAppProvider(input?.whatsappMode),
    emailProvider: new SimulatedEmailProvider(input?.emailMode),
    clock: systemClock,
    sleeper: realSleeper,
    ids: { generate: randomUUID },
  };
}
