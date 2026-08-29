import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import { acquireOperationalConfigurationLock } from "@/modules/configuration/infrastructure/operational-configuration-repository";
import type {
  NotificationSettingsActor,
  NotificationSettingsRepository,
} from "@/modules/notifications/application/ports";
import { NotificationSettingsError } from "@/modules/notifications/application/notification-settings-service";
import { prisma } from "@/server/db/prisma";

async function requireActiveAdmin(
  client: Pick<Prisma.TransactionClient, "user">,
  actor: NotificationSettingsActor,
) {
  const current = await client.user.findFirst({
    where: {
      id: actor.id,
      restaurantId: actor.restaurantId,
      role: "ADMIN",
      isActive: true,
      disabledAt: null,
      mustChangePassword: false,
    },
    select: { id: true, restaurantId: true, role: true },
  });
  if (!current) {
    throw new NotificationSettingsError(
      "FORBIDDEN",
      "Solo un amministratore attivo può gestire la strategia di notifica.",
    );
  }
  return current;
}

export class PrismaNotificationSettingsRepository
  implements NotificationSettingsRepository
{
  async read(actor: NotificationSettingsActor) {
    const current = await requireActiveAdmin(prisma, actor);
    const settings = await prisma.restaurantNotificationSettings.findUnique({
      where: { restaurantId: current.restaurantId },
      select: { strategy: true },
    });
    if (!settings) {
      throw new NotificationSettingsError(
        "NOT_FOUND",
        "La configurazione delle notifiche non è disponibile.",
      );
    }
    return settings;
  }

  async update(input: Parameters<NotificationSettingsRepository["update"]>[0]) {
    return prisma.$transaction(
      async (client) => {
        await acquireOperationalConfigurationLock(
          client,
          input.actor.restaurantId,
        );
        const actor = await requireActiveAdmin(client, input.actor);
        const previous =
          await client.restaurantNotificationSettings.findUnique({
            where: { restaurantId: input.actor.restaurantId },
            select: { strategy: true },
          });
        if (!previous) {
          throw new NotificationSettingsError(
            "NOT_FOUND",
            "La configurazione delle notifiche non è disponibile.",
          );
        }
        if (previous.strategy === input.strategy) {
          return { strategy: previous.strategy, changed: false };
        }
        const updated =
          await client.restaurantNotificationSettings.update({
            where: { restaurantId: input.actor.restaurantId },
            data: { strategy: input.strategy },
            select: { strategy: true },
          });
        await insertAuditEvent(client, {
          restaurantId: input.actor.restaurantId,
          category: "CONFIGURATION",
          action: "NOTIFICATION_STRATEGY_UPDATED",
          outcome: "SUCCESS",
          actorUserId: actor.id,
          actorRole: actor.role,
          entityType: "RESTAURANT_NOTIFICATION_SETTINGS",
          entityId: input.actor.restaurantId,
          correlationId: input.correlationId,
          previousState: { strategy: previous.strategy },
          newState: { strategy: updated.strategy },
          metadata: null,
          createdAt: input.now,
        });
        return { strategy: updated.strategy, changed: true };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 20_000,
      },
    );
  }
}
