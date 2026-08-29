import "server-only";

import { randomUUID } from "node:crypto";

import {
  getNotificationSettings,
  updateNotificationSettings,
} from "@/modules/notifications/application/notification-settings-service";
import type { NotificationSettingsActor } from "@/modules/notifications/application/ports";
import { PrismaNotificationSettingsRepository } from "@/modules/notifications/infrastructure/notification-settings-repository";

const dependencies = {
  repository: new PrismaNotificationSettingsRepository(),
  clock: { now: () => new Date() },
  ids: { generate: randomUUID },
};

export function readAdminNotificationSettings(actor: NotificationSettingsActor) {
  return getNotificationSettings(dependencies, actor);
}

export function patchAdminNotificationSettings(
  actor: NotificationSettingsActor,
  rawInput: unknown,
) {
  return updateNotificationSettings(dependencies, actor, rawInput);
}
