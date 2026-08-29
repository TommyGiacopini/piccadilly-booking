import type {
  Clock,
  NotificationIdGenerator,
  NotificationSettingsActor,
  NotificationSettingsRepository,
} from "@/modules/notifications/application/ports";
import { notificationSettingsMutationSchema } from "@/modules/notifications/domain/notification-settings";

export class NotificationSettingsError extends Error {
  constructor(
    readonly code: "VALIDATION" | "FORBIDDEN" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "NotificationSettingsError";
  }
}

export interface NotificationSettingsDependencies {
  repository: NotificationSettingsRepository;
  clock: Clock;
  ids: NotificationIdGenerator;
}

export async function getNotificationSettings(
  dependencies: NotificationSettingsDependencies,
  actor: NotificationSettingsActor,
) {
  const settings = await dependencies.repository.read(actor);
  if (!settings) {
    throw new NotificationSettingsError(
      "FORBIDDEN",
      "Solo un amministratore attivo può leggere la strategia di notifica.",
    );
  }
  return settings;
}

export async function updateNotificationSettings(
  dependencies: NotificationSettingsDependencies,
  actor: NotificationSettingsActor,
  rawInput: unknown,
) {
  const parsed = notificationSettingsMutationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new NotificationSettingsError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "La strategia non è valida.",
    );
  }
  return dependencies.repository.update({
    actor,
    strategy: parsed.data.strategy,
    correlationId: dependencies.ids.generate(),
    now: dependencies.clock.now(),
  });
}
