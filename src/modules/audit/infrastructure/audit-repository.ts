import "server-only";

import { Prisma } from "@/generated/prisma/client";
import {
  validateAuditEventHeader,
  type AuditAction,
  type AuditCategory,
  type AuditOutcome,
} from "@/modules/audit/domain/audit-event";

type AuditWriter = Pick<Prisma.TransactionClient, "auditEvent">;

export interface AuditEventWriteInput {
  restaurantId: string;
  category: AuditCategory;
  action: AuditAction;
  outcome: AuditOutcome;
  actorUserId: string | null;
  actorRole: "ADMIN" | "STAFF" | null;
  entityType: string | null;
  entityId: string | null;
  correlationId: string;
  previousState: Prisma.InputJsonValue | null;
  newState: Prisma.InputJsonValue | null;
  metadata: Prisma.InputJsonValue | null;
  createdAt: Date;
}

export async function insertAuditEvent(
  client: AuditWriter,
  input: AuditEventWriteInput,
): Promise<void> {
  const header = validateAuditEventHeader(input);

  await client.auditEvent.create({
    data: {
      ...header,
      previousState:
        input.previousState === null ? Prisma.DbNull : input.previousState,
      newState: input.newState === null ? Prisma.DbNull : input.newState,
      metadata: input.metadata === null ? Prisma.DbNull : input.metadata,
    },
  });
}
