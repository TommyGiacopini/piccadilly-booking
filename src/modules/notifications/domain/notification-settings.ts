import { z } from "zod";

import { NOTIFICATION_STRATEGIES } from "@/modules/notifications/domain/types";

export const notificationStrategySchema = z.enum(NOTIFICATION_STRATEGIES);

export const notificationSettingsMutationSchema = z
  .object({ strategy: notificationStrategySchema })
  .strict();

export type NotificationSettingsMutation = z.infer<
  typeof notificationSettingsMutationSchema
>;
