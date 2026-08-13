import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import type { AuditDetailDatabaseRecord, AuditListDatabaseRow } from "@/modules/audit/domain/audit-projection";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_OUTCOMES } from "@/modules/audit/domain/audit-event";
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_SOURCE_RANK,
  RESERVATION_AUDIT_ACTIONS,
  type AuditListFilters,
  type AuditCursorPosition,
  type AuditSource,
} from "@/modules/audit/domain/audit-query";

const ANONYMOUS_AUDIT_ACTIONS = ["LOGIN_FAILED", "LOGIN_RATE_LIMITED"] as const;

export type AuditQueryClient = Pick<
  PrismaClient,
  "$queryRaw" | "reservationAuditEvent" | "auditEvent"
>;

function falseCondition(): Prisma.Sql {
  return Prisma.sql`FALSE`;
}

function reservationConditions(
  restaurantId: string,
  filters: AuditListFilters,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`rae.restaurant_id = ${restaurantId}::uuid`,
    Prisma.sql`rae.created_at >= ${filters.fromInclusive}`,
    Prisma.sql`rae.created_at < ${filters.toExclusive}`,
    Prisma.sql`(rae.actor_user_id IS NOT NULL OR rae.actor_origin::text = 'PUBLIC')`,
  ];
  if (filters.source && filters.source !== "RESERVATION") conditions.push(falseCondition());
  if (filters.category && filters.category !== "RESERVATION") conditions.push(falseCondition());
  if (filters.action) {
    if (RESERVATION_AUDIT_ACTIONS.includes(filters.action as never)) {
      conditions.push(Prisma.sql`rae.action::text = ${filters.action}`);
    } else conditions.push(falseCondition());
  }
  if (filters.outcome && filters.outcome !== "SUCCESS") conditions.push(falseCondition());
  if (filters.actor) {
    if (filters.actor === "PUBLIC") {
      conditions.push(Prisma.sql`rae.actor_user_id IS NULL AND rae.actor_origin::text = 'PUBLIC'`);
    } else if (filters.actor === "ANONYMOUS") {
      conditions.push(falseCondition());
    } else if (filters.actor === "SYSTEM") {
      conditions.push(falseCondition());
    } else {
      conditions.push(Prisma.sql`rae.actor_user_id = ${filters.actor}::uuid`);
    }
  }
  if (filters.entityType && filters.entityType !== "RESERVATION") conditions.push(falseCondition());
  if (filters.entityId) conditions.push(Prisma.sql`rae.reservation_id = ${filters.entityId}::uuid`);
  if (filters.correlationId) conditions.push(Prisma.sql`rae.correlation_id = ${filters.correlationId}::uuid`);
  return conditions;
}

function administrativeConditions(
  restaurantId: string,
  filters: AuditListFilters,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`ae.restaurant_id = ${restaurantId}::uuid`,
    Prisma.sql`ae.created_at >= ${filters.fromInclusive}`,
    Prisma.sql`ae.created_at < ${filters.toExclusive}`,
    Prisma.sql`ae.category IN (${Prisma.join(AUDIT_CATEGORIES)})`,
    Prisma.sql`ae.action IN (${Prisma.join(AUDIT_ACTIONS)})`,
    Prisma.sql`ae.outcome IN (${Prisma.join(AUDIT_OUTCOMES)})`,
    Prisma.sql`(ae.entity_type IS NULL OR ae.entity_type IN (${Prisma.join(AUDIT_ENTITY_TYPES)}))`,
    Prisma.sql`(ae.actor_user_id IS NOT NULL OR ae.action IN (${Prisma.join(ANONYMOUS_AUDIT_ACTIONS)}))`,
  ];
  if (filters.source && filters.source !== "ADMINISTRATIVE") conditions.push(falseCondition());
  if (filters.category) {
    if (filters.category === "RESERVATION") conditions.push(falseCondition());
    else conditions.push(Prisma.sql`ae.category = ${filters.category}`);
  }
  if (filters.action) {
    if (AUDIT_ACTIONS.includes(filters.action as never)) {
      conditions.push(Prisma.sql`ae.action = ${filters.action}`);
    } else conditions.push(falseCondition());
  }
  if (filters.outcome) conditions.push(Prisma.sql`ae.outcome = ${filters.outcome}`);
  if (filters.actor) {
    if (filters.actor === "ANONYMOUS") {
      conditions.push(Prisma.sql`ae.actor_user_id IS NULL AND ae.action IN (${Prisma.join(ANONYMOUS_AUDIT_ACTIONS)})`);
    } else if (filters.actor === "SYSTEM") {
      conditions.push(falseCondition());
    } else if (filters.actor === "PUBLIC") {
      conditions.push(falseCondition());
    } else {
      conditions.push(Prisma.sql`ae.actor_user_id = ${filters.actor}::uuid`);
    }
  }
  if (filters.entityType) conditions.push(Prisma.sql`ae.entity_type = ${filters.entityType}`);
  if (filters.entityId) conditions.push(Prisma.sql`ae.entity_id = ${filters.entityId}::uuid`);
  if (filters.correlationId) conditions.push(Prisma.sql`ae.correlation_id = ${filters.correlationId}::uuid`);
  return conditions;
}

export async function readUnifiedAuditPage(
  client: AuditQueryClient,
  input: {
    restaurantId: string;
    filters: AuditListFilters;
    cursor: AuditCursorPosition | null;
    limit: number;
  },
): Promise<AuditListDatabaseRow[]> {
  const reservationWhere = Prisma.join(
    reservationConditions(input.restaurantId, input.filters),
    " AND ",
  );
  const administrativeWhere = Prisma.join(
    administrativeConditions(input.restaurantId, input.filters),
    " AND ",
  );
  const cursorCondition = input.cursor
    ? Prisma.sql`WHERE (occurred_at, source_rank, event_id) < (${input.cursor.timestamp}, ${input.cursor.sourceRank}, ${input.cursor.eventId}::uuid)`
    : Prisma.empty;

  return client.$queryRaw<AuditListDatabaseRow[]>(Prisma.sql`
    WITH unified_audit AS (
      SELECT
        'RESERVATION'::text AS source,
        ${AUDIT_SOURCE_RANK.RESERVATION}::integer AS source_rank,
        rae.id AS event_id,
        rae.created_at AS occurred_at,
        'RESERVATION'::text AS category,
        rae.action::text AS action,
        'SUCCESS'::text AS outcome,
        CASE
          WHEN rae.actor_user_id IS NOT NULL THEN 'USER'
          WHEN rae.actor_origin::text = 'PUBLIC' THEN 'PUBLIC'
          ELSE 'SYSTEM'
        END::text AS actor_kind,
        rae.actor_user_id,
        actor.username::text AS actor_display_name,
        rae.actor_role::text AS actor_role,
        'RESERVATION'::text AS entity_type,
        rae.reservation_id AS entity_id,
        rae.correlation_id
      FROM reservation_audit_events rae
      LEFT JOIN users actor
        ON actor.id = rae.actor_user_id
       AND actor.restaurant_id = rae.restaurant_id
      WHERE ${reservationWhere}

      UNION ALL

      SELECT
        'ADMINISTRATIVE'::text AS source,
        ${AUDIT_SOURCE_RANK.ADMINISTRATIVE}::integer AS source_rank,
        ae.id AS event_id,
        ae.created_at AS occurred_at,
        ae.category::text AS category,
        ae.action::text AS action,
        ae.outcome::text AS outcome,
        CASE
          WHEN ae.actor_user_id IS NOT NULL THEN 'USER'
          WHEN ae.category = 'AUTHENTICATION' THEN 'ANONYMOUS'
          ELSE 'SYSTEM'
        END::text AS actor_kind,
        ae.actor_user_id,
        actor.username::text AS actor_display_name,
        ae.actor_role::text AS actor_role,
        ae.entity_type::text AS entity_type,
        ae.entity_id,
        ae.correlation_id
      FROM audit_events ae
      LEFT JOIN users actor
        ON actor.id = ae.actor_user_id
       AND actor.restaurant_id = ae.restaurant_id
      WHERE ${administrativeWhere}
    )
    SELECT
      source,
      source_rank AS "sourceRank",
      event_id AS "eventId",
      occurred_at AS "occurredAt",
      category,
      action,
      outcome,
      actor_kind AS "actorKind",
      actor_user_id AS "actorUserId",
      actor_display_name AS "actorDisplayName",
      actor_role AS "actorRole",
      entity_type AS "entityType",
      entity_id AS "entityId",
      correlation_id AS "correlationId"
    FROM unified_audit
    ${cursorCondition}
    ORDER BY occurred_at DESC, source_rank DESC, event_id DESC
    LIMIT ${input.limit + 1}
  `);
}

function actorName(
  actorUser: { username: string; restaurantId: string } | null,
  restaurantId: string,
): string | null {
  return actorUser?.restaurantId === restaurantId ? actorUser.username : null;
}

export async function readAuditDetail(
  client: AuditQueryClient,
  input: { restaurantId: string; source: AuditSource; eventId: string },
): Promise<AuditDetailDatabaseRecord | null> {
  if (input.source === "RESERVATION") {
    const event = await client.reservationAuditEvent.findFirst({
      where: { id: input.eventId, restaurantId: input.restaurantId },
      select: {
        id: true,
        reservationId: true,
        action: true,
        actorOrigin: true,
        actorUserId: true,
        actorRole: true,
        correlationId: true,
        previousState: true,
        newState: true,
        capacityOverride: true,
        createdAt: true,
        actorUser: { select: { username: true, restaurantId: true } },
      },
    });
    if (!event) return null;
    if (!event.actorUserId && event.actorOrigin !== "PUBLIC") return null;
    return {
      source: "RESERVATION",
      sourceRank: AUDIT_SOURCE_RANK.RESERVATION,
      eventId: event.id,
      occurredAt: event.createdAt,
      category: "RESERVATION",
      action: event.action,
      outcome: "SUCCESS",
      actorKind: event.actorUserId
        ? "USER"
        : event.actorOrigin === "PUBLIC"
          ? "PUBLIC"
          : "SYSTEM",
      actorUserId: event.actorUserId,
      actorDisplayName: actorName(event.actorUser, input.restaurantId),
      actorRole: event.actorRole,
      entityType: "RESERVATION",
      entityId: event.reservationId,
      correlationId: event.correlationId,
      previousState: event.previousState,
      newState: event.newState,
      metadata: event.capacityOverride ? { capacityOverride: true } : null,
    };
  }

  const event = await client.auditEvent.findFirst({
    where: { id: input.eventId, restaurantId: input.restaurantId },
    select: {
      id: true,
      category: true,
      action: true,
      outcome: true,
      actorUserId: true,
      actorRole: true,
      entityType: true,
      entityId: true,
      correlationId: true,
      previousState: true,
      newState: true,
      metadata: true,
      createdAt: true,
      actorUser: { select: { username: true, restaurantId: true } },
    },
  });
  if (!event) return null;
  if (!event.actorUserId && !ANONYMOUS_AUDIT_ACTIONS.includes(event.action as never)) {
    return null;
  }
  return {
    source: "ADMINISTRATIVE",
    sourceRank: AUDIT_SOURCE_RANK.ADMINISTRATIVE,
    eventId: event.id,
    occurredAt: event.createdAt,
    category: event.category,
    action: event.action,
    outcome: event.outcome,
    actorKind: event.actorUserId ? "USER" : "ANONYMOUS",
    actorUserId: event.actorUserId,
    actorDisplayName: actorName(event.actorUser, input.restaurantId),
    actorRole: event.actorRole,
    entityType: event.entityType,
    entityId: event.entityId,
    correlationId: event.correlationId,
    previousState: event.previousState,
    newState: event.newState,
    metadata: event.metadata,
  };
}
