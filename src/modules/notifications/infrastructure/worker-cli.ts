import "dotenv/config";

import {
  processDueNotificationBatch,
  runNotificationWorkerLoop,
} from "@/modules/notifications/application/worker";
import { createNotificationWorkerDependencies } from "@/modules/notifications/infrastructure/notification-composition";
import { prisma } from "@/server/db/prisma";

async function main(): Promise<void> {
  const dependencies = createNotificationWorkerDependencies();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (process.argv.includes("--once")) {
    try {
      const result = await processDueNotificationBatch(
        dependencies,
        controller.signal,
      );
      console.info(JSON.stringify(result));
      return;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }

  try {
    await runNotificationWorkerLoop(dependencies, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main()
  .catch(() => {
    console.error("Notification worker stopped after a sanitized failure.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
