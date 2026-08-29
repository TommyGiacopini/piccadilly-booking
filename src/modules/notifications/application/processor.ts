import {
  nextRetryAt,
  terminalFailureForTransient,
} from "@/modules/notifications/domain/delivery-policy";
import { toVersionedMessage } from "@/modules/notifications/domain/notification-rules";
import type {
  Clock,
  NotificationProvider,
  NotificationProviderResult,
  NotificationWorkerRepository,
  Sleeper,
  StartedNotificationAttempt,
} from "@/modules/notifications/application/ports";

export const NOTIFICATION_PROVIDER_DEADLINE_MS = 30_000;

export interface NotificationProcessorDependencies {
  repository: NotificationWorkerRepository;
  whatsappProvider: NotificationProvider;
  emailProvider: NotificationProvider;
  clock: Clock;
  sleeper: Sleeper;
}

function sanitizedUnexpectedFailure(): NotificationProviderResult {
  return { type: "TRANSIENT_FAILURE", failureCode: "PROVIDER_UNAVAILABLE" };
}

async function providerResult(
  dependencies: NotificationProcessorDependencies,
  attempt: StartedNotificationAttempt,
  shutdownSignal: AbortSignal,
): Promise<NotificationProviderResult | null> {
  const provider =
    attempt.notification.channel === "WHATSAPP"
      ? dependencies.whatsappProvider
      : dependencies.emailProvider;
  const providerController = new AbortController();
  const deadlineController = new AbortController();
  let resolveShutdown!: (value: { kind: "SHUTDOWN" }) => void;
  let resolveDeadline!: (value: { kind: "DEADLINE" }) => void;
  const shutdown = new Promise<{ kind: "SHUTDOWN" }>((resolve) => {
    resolveShutdown = resolve;
  });
  const deadline = new Promise<{ kind: "DEADLINE" }>((resolve) => {
    resolveDeadline = resolve;
  });
  const stop = () => {
    resolveShutdown({ kind: "SHUTDOWN" });
    providerController.abort();
    deadlineController.abort();
  };
  shutdownSignal.addEventListener("abort", stop, { once: true });

  void dependencies.sleeper
    .wait(NOTIFICATION_PROVIDER_DEADLINE_MS, deadlineController.signal)
    .then(() => {
      if (deadlineController.signal.aborted) return;
      resolveDeadline({ kind: "DEADLINE" });
      providerController.abort();
    })
    .catch(() => {
      if (deadlineController.signal.aborted) return;
      resolveDeadline({ kind: "DEADLINE" });
      providerController.abort();
    });

  const send = Promise.resolve()
    .then(() =>
      provider.send(
        {
          destination: attempt.notification.destination,
          message: toVersionedMessage(attempt.notification.payload),
          idempotencyKey: attempt.notification.idempotencyKey,
          correlationId: attempt.attemptCorrelationId,
          context: {
            restaurantId: attempt.notification.restaurantId,
            outboxId: attempt.notification.id,
            providerKind: attempt.providerKind,
          },
        },
        { signal: providerController.signal },
      ),
    )
    .then(
      (result) => ({ kind: "RESULT" as const, result }),
      () => ({ kind: "RESULT" as const, result: sanitizedUnexpectedFailure() }),
    );

  try {
    const outcome = await Promise.race([send, deadline, shutdown]);
    if (outcome.kind === "SHUTDOWN") return null;
    if (outcome.kind === "DEADLINE") {
      return { type: "TRANSIENT_FAILURE", failureCode: "PROVIDER_TIMEOUT" };
    }
    return outcome.result;
  } finally {
    shutdownSignal.removeEventListener("abort", stop);
    deadlineController.abort();
  }
}

export async function processClaimedNotification(input: {
  dependencies: NotificationProcessorDependencies;
  notification: Parameters<NotificationWorkerRepository["startAttempt"]>[0]["notification"];
  attemptCorrelationId: string;
  signal: AbortSignal;
}): Promise<void> {
  if (input.signal.aborted) return;
  const startedAt = input.dependencies.clock.now();
  const attempt = await input.dependencies.repository.startAttempt({
    notification: input.notification,
    attemptCorrelationId: input.attemptCorrelationId,
    now: startedAt,
  });
  if (!attempt) return;
  if (input.signal.aborted) return;
  const canCall = await input.dependencies.repository.confirmProviderCall({
    attempt,
    now: input.dependencies.clock.now(),
  });
  if (!canCall) return;
  if (input.signal.aborted) return;
  const result = await providerResult(input.dependencies, attempt, input.signal);
  if (!result) return;
  const completedAt = input.dependencies.clock.now();
  const terminalFailureCode =
    result.type === "TRANSIENT_FAILURE"
      ? terminalFailureForTransient({
          attemptNumber: attempt.attemptNumber,
          maxAttempts: attempt.notification.maxAttempts,
          now: completedAt,
          expiresAt: attempt.notification.expiresAt,
        })
      : result.type === "PERMANENT_FAILURE"
        ? result.failureCode
        : null;
  const nextAvailableAt =
    result.type === "TRANSIENT_FAILURE" && terminalFailureCode === null
      ? nextRetryAt({
          attemptNumber: attempt.attemptNumber,
          completedAt,
          expiresAt: attempt.notification.expiresAt,
        })
      : null;
  await input.dependencies.repository.finalizeAttempt({
    attempt,
    result,
    now: completedAt,
    nextAvailableAt,
    terminalFailureCode,
  });
}
