import { z } from "zod";

export const AUDIT_CATEGORIES = [
  "AUTHENTICATION",
  "IDENTITY",
  "CONFIGURATION",
  "EXPORT",
] as const;

export const AUDIT_OUTCOMES = ["SUCCESS", "FAILURE", "BLOCKED"] as const;

export const AUDIT_ACTIONS = [
  "LOGIN_SUCCEEDED",
  "LOGIN_FAILED",
  "LOGIN_RATE_LIMITED",
  "LOGOUT_SUCCEEDED",
  "USER_CREATED",
  "USER_ROLE_CHANGED",
  "USER_ENABLED",
  "USER_DISABLED",
  "USER_PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "BOOKING_SETTINGS_UPDATED",
  "ROOM_UPDATED",
  "ROOM_AVAILABILITY_UPDATED",
  "ROOM_DISABLED",
  "ROOM_ENABLED",
  "ROOM_ORDER_UPDATED",
  "DINING_TABLE_CREATED",
  "DINING_TABLE_UPDATED",
  "DINING_TABLE_DISABLED",
  "DINING_TABLE_ENABLED",
  "WEEKLY_SCHEDULE_UPDATED",
  "PUBLIC_BOOKING_CUTOFF_RULE_CREATED",
  "PUBLIC_BOOKING_CUTOFF_RULE_UPDATED",
  "PUBLIC_BOOKING_CUTOFF_RULE_DISABLED",
  "SPECIAL_DATE_CREATED",
  "SPECIAL_DATE_UPDATED",
  "SPECIAL_DATE_ARCHIVED",
  "SPECIAL_DATE_REACTIVATED",
  "PUBLIC_CONTACTS_UPDATED",
  "PUBLIC_CONTENT_UPDATED",
  "MANAGEMENT_LINK_DURATION_UPDATED",
  "NOTIFICATION_STRATEGY_UPDATED",
  "PDF_EXPORT_REQUESTED",
  "EXCEL_EXPORT_REQUESTED",
] as const;

const auditEventHeaderSchema = z
  .object({
    restaurantId: z.uuid(),
    category: z.enum(AUDIT_CATEGORIES),
    action: z.enum(AUDIT_ACTIONS),
    outcome: z.enum(AUDIT_OUTCOMES),
    actorUserId: z.uuid().nullable(),
    actorRole: z.enum(["ADMIN", "STAFF"]).nullable(),
    entityType: z.string().trim().min(1).max(64).nullable(),
    entityId: z.uuid().nullable(),
    correlationId: z.uuid(),
    createdAt: z.date(),
  })
  .superRefine((value, context) => {
    if ((value.actorUserId === null) !== (value.actorRole === null)) {
      context.addIssue({
        code: "custom",
        message: "Audit actor ID and role must be supplied together.",
      });
    }

    if ((value.entityType === null) !== (value.entityId === null)) {
      context.addIssue({
        code: "custom",
        message: "Audit entity type and ID must be supplied together.",
      });
    }
  });

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export function validateAuditEventHeader(
  input: z.input<typeof auditEventHeaderSchema>,
): z.output<typeof auditEventHeaderSchema> {
  return auditEventHeaderSchema.parse(input);
}

export function auditStatesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
