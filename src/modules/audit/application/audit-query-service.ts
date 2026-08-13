import "server-only";

import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { projectAuditDetail, projectAuditListRow, type AuditDetailDto, type AuditListItemDto } from "@/modules/audit/domain/audit-projection";
import {
  AUDIT_SOURCES,
  AuditQueryError,
  encodeAuditCursor,
  parseAuditListQuery,
  type AuditSource,
} from "@/modules/audit/domain/audit-query";
import {
  readAuditDetail,
  readUnifiedAuditPage,
  type AuditQueryClient,
} from "@/modules/audit/infrastructure/audit-query-repository";
import { prisma } from "@/server/db/prisma";

export interface AuditViewerActor {
  id: string;
  restaurantId: string;
}

type AuditServiceClient = AuditQueryClient & Pick<PrismaClient, "user">;

interface AuditServiceOptions {
  client?: AuditServiceClient;
  now?: Date;
}

async function requireFreshAuditAdmin(
  client: AuditServiceClient,
  actor: AuditViewerActor,
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
    select: {
      id: true,
      restaurantId: true,
      restaurant: { select: { timezone: true } },
    },
  });
  if (!current) {
    throw new AuditQueryError(
      "FORBIDDEN",
      "Solo un amministratore attivo può consultare l'audit.",
    );
  }
  return current;
}

function isSpecialActor(value: string): boolean {
  return value === "PUBLIC" || value === "ANONYMOUS" || value === "SYSTEM";
}

async function assertActorFilterTenant(
  client: AuditServiceClient,
  restaurantId: string,
  actorFilter: string | undefined,
): Promise<void> {
  if (!actorFilter || isSpecialActor(actorFilter)) return;
  const exists = await client.user.findFirst({
    where: { id: actorFilter, restaurantId },
    select: { id: true },
  });
  if (!exists) {
    throw new AuditQueryError(
      "INVALID_QUERY",
      "L'attore selezionato non appartiene al ristorante.",
    );
  }
}

export async function getAuditViewerContext(
  actor: AuditViewerActor,
  options: AuditServiceOptions = {},
): Promise<{ timezone: string }> {
  const client = options.client ?? prisma;
  const current = await requireFreshAuditAdmin(client, actor);
  return { timezone: current.restaurant.timezone };
}

export async function listAuditEvents(
  actor: AuditViewerActor,
  searchParams: URLSearchParams,
  options: AuditServiceOptions = {},
): Promise<{ items: AuditListItemDto[]; nextCursor: string | null }> {
  const client = options.client ?? prisma;
  const current = await requireFreshAuditAdmin(client, actor);
  const query = parseAuditListQuery(
    searchParams,
    current.restaurant.timezone,
    options.now,
  );
  await assertActorFilterTenant(client, actor.restaurantId, query.filters.actor);
  const rows = await readUnifiedAuditPage(client, {
    restaurantId: actor.restaurantId,
    filters: query.filters,
    cursor: query.cursor,
    limit: query.limit,
  });
  const pageRows = rows.slice(0, query.limit);
  const items = pageRows.flatMap((row) => {
    const projected = projectAuditListRow(row);
    return projected ? [projected] : [];
  });
  const last = pageRows.at(-1);
  const nextCursor = rows.length > query.limit && last
    ? encodeAuditCursor(
        {
          timestamp: last.occurredAt,
          sourceRank: last.sourceRank === 2 ? 2 : 1,
          eventId: last.eventId,
        },
        query.filterFingerprint,
      )
    : null;
  return { items, nextCursor };
}

const detailIdentitySchema = z.strictObject({
  source: z.enum(AUDIT_SOURCES),
  eventId: z.uuid(),
});

export async function getAuditEventDetail(
  actor: AuditViewerActor,
  source: unknown,
  eventId: unknown,
  options: AuditServiceOptions = {},
): Promise<AuditDetailDto> {
  const identity = detailIdentitySchema.safeParse({ source, eventId });
  if (!identity.success) {
    throw new AuditQueryError("INVALID_QUERY", "Evento audit non valido.");
  }
  const client = options.client ?? prisma;
  await requireFreshAuditAdmin(client, actor);
  const record = await readAuditDetail(client, {
    restaurantId: actor.restaurantId,
    source: identity.data.source as AuditSource,
    eventId: identity.data.eventId,
  });
  const detail = record ? projectAuditDetail(record) : null;
  if (!detail) {
    throw new AuditQueryError("NOT_FOUND", "Evento audit non disponibile.");
  }
  return detail;
}
