import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { hashPassword, passwordSchema } from "../src/server/auth/password-core";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import { resolveAppEnvironment } from "../src/shared/config/app-environment";
import {
  E2E_TEMPLATE_RESTAURANT_ID,
  e2eAdminUserId,
  e2eAdminUsername,
  e2eRestaurantId,
  e2eRestaurantName,
  e2eStaffUsername,
  e2eStaffUserId,
  parseE2eRunId,
} from "./e2e-fixture-ownership";

export async function prepareE2eTenant(
  client: PrismaClient,
  runIdInput: string,
  passwords: { admin: string; staff: string },
): Promise<void> {
  const runId = parseE2eRunId(runIdInput);
  const restaurantId = e2eRestaurantId(runId);
  const [adminPasswordHash, staffPasswordHash] = await Promise.all([
    hashPassword(passwordSchema.parse(passwords.admin)),
    hashPassword(passwordSchema.parse(passwords.staff)),
  ]);

  await client.$transaction(
    async (transaction) => {
      const existing = await transaction.restaurant.findUnique({
        where: { id: restaurantId },
        select: { name: true },
      });
      if (existing) {
        throw new Error(
          existing.name === e2eRestaurantName(runId)
            ? "The E2E run tenant already exists; run-scoped purge is required first."
            : "The E2E run UUID is already used by a non-E2E restaurant.",
        );
      }

      const template = await transaction.restaurant.findUnique({
        where: { id: E2E_TEMPLATE_RESTAURANT_ID },
        include: {
          bookingSettings: true,
          bookingCutoffRules: true,
          weeklySchedules: true,
          rooms: { include: { diningTables: true } },
          publicSettings: true,
          publicContents: true,
          notificationSettings: true,
        },
      });
      if (
        !template?.bookingSettings ||
        !template.publicSettings ||
        !template.notificationSettings ||
        template.rooms.length === 0 ||
        template.weeklySchedules.length === 0
      ) {
        throw new Error("The read-only demo template is incomplete for E2E setup.");
      }

      await transaction.restaurant.create({
        data: {
          id: restaurantId,
          name: e2eRestaurantName(runId),
          timezone: template.timezone,
        },
      });
      await transaction.restaurantBookingSettings.create({
        data: {
          restaurantId,
          rollingCapacityCovers: template.bookingSettings.rollingCapacityCovers,
          rollingWindowMinutes: template.bookingSettings.rollingWindowMinutes,
          lunchModificationCutoff:
            template.bookingSettings.lunchModificationCutoff,
          dinnerModificationCutoff:
            template.bookingSettings.dinnerModificationCutoff,
          managementLinkDurationHours:
            template.bookingSettings.managementLinkDurationHours,
        },
      });
      await transaction.restaurantNotificationSettings.create({
        data: {
          restaurantId,
          strategy: "WHATSAPP_ONLY",
        },
      });
      await transaction.weeklyServiceSchedule.createMany({
        data: template.weeklySchedules.map((schedule) => ({
          restaurantId,
          dayOfWeek: schedule.dayOfWeek,
          serviceType: schedule.serviceType,
          isEnabled: schedule.isEnabled,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          slotIntervalMinutes: schedule.slotIntervalMinutes,
        })),
      });
      await transaction.bookingCutoffRule.createMany({
        data: template.bookingCutoffRules.map((rule) => ({
          restaurantId,
          dayOfWeek: rule.dayOfWeek,
          serviceType: rule.serviceType,
          isEnabled: rule.isEnabled,
          cutoffTime: rule.cutoffTime,
        })),
      });
      await transaction.restaurantPublicSettings.create({
        data: {
          restaurantId,
          publicPhone: template.publicSettings.publicPhone,
          publicBookingBaseUrl: template.publicSettings.publicBookingBaseUrl,
          publicEmail: template.publicSettings.publicEmail,
          whatsappNumber: template.publicSettings.whatsappNumber,
        },
      });
      await transaction.publicContent.createMany({
        data: template.publicContents.map((content) => ({
          restaurantId,
          locale: content.locale,
          contentKey: content.contentKey,
          contentText: content.contentText,
        })),
      });

      for (const room of template.rooms) {
        const createdRoom = await transaction.room.create({
          data: {
            restaurantId,
            name: room.name,
            code: room.code,
            serviceAvailabilityPolicy: room.serviceAvailabilityPolicy,
            displayOrder: room.displayOrder,
            isActive: room.isActive,
          },
        });
        if (room.diningTables.length > 0) {
          await transaction.diningTable.createMany({
            data: room.diningTables.map((table) => ({
              roomId: createdRoom.id,
              name: table.name,
              minimumSeats: table.minimumSeats,
              maximumSeats: table.maximumSeats,
              isActive: table.isActive,
              displayOrder: table.displayOrder,
            })),
          });
        }
      }

      await transaction.user.createMany({
        data: [
          {
            id: e2eAdminUserId(runId),
            restaurantId,
            username: e2eAdminUsername(runId),
            passwordHash: adminPasswordHash,
            role: "ADMIN",
            mustChangePassword: false,
          },
          {
            id: e2eStaffUserId(runId),
            restaurantId,
            username: e2eStaffUsername(runId),
            passwordHash: staffPasswordHash,
            role: "STAFF",
            mustChangePassword: false,
          },
        ],
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function main(): Promise<void> {
  if (resolveAppEnvironment(process.env.APP_ENV) === "production") {
    throw new Error("E2E tenants cannot be prepared in production.");
  }
  if (process.env.E2E_TEST_MODE !== "true") {
    throw new Error("E2E_TEST_MODE=true is required for E2E tenant setup.");
  }

  const runId = parseE2eRunId(process.env.E2E_RUN_ID);
  if (process.env.AUTH_RESTAURANT_ID !== e2eRestaurantId(runId)) {
    throw new Error("AUTH_RESTAURANT_ID must equal the explicit E2E run tenant.");
  }
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
      connectionTimeoutMillis: 5_000,
    }),
  });

  try {
    await prepareE2eTenant(client, runId, {
      admin: passwordSchema.parse(process.env.AUTH_DEMO_ADMIN_PASSWORD),
      staff: passwordSchema.parse(process.env.AUTH_DEMO_STAFF_PASSWORD),
    });
    console.info(`Dedicated fake E2E tenant prepared for run ${runId}.`);
  } finally {
    await client.$disconnect();
  }
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Dedicated fake E2E tenant preparation failed: ${message}`);
    process.exit(1);
  });
}
