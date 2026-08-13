import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type UserRole } from "@/generated/prisma/client";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import {
  IdentityError,
} from "@/modules/identity/application/identity-errors";
import { validateSelectedPassword } from "@/modules/identity/domain/password-policy";
import { generateTemporaryPassword } from "@/modules/identity/domain/temporary-password";
import {
  createUserSchema,
  passwordChangeSchema,
  userRoleChangeSchema,
  userStatusChangeSchema,
} from "@/modules/identity/domain/validation";
import {
  acquireIdentityLifecycleLock,
  runIdentityTransaction,
} from "@/modules/identity/infrastructure/identity-repository";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { prisma } from "@/server/db/prisma";
import { z } from "zod";

export interface IdentityActor {
  id: string;
  restaurantId: string;
}

export interface ManagedUser {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  disabledAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
}

type IdentityUser = {
  id: string;
  restaurantId: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  disabledAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
};

type IdentityClient = Prisma.TransactionClient;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new IdentityError(
      "VALIDATION",
      result.error.issues[0]?.message ?? "I dati inseriti non sono validi.",
    );
  }

  return result.data;
}

function parseUserId(value: unknown): string {
  return parse(z.string().uuid(), value);
}

function toManagedUser(user: IdentityUser): ManagedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    disabledAt: user.disabledAt?.toISOString() ?? null,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt.toISOString(),
  };
}

function auditSnapshot(user: IdentityUser) {
  return {
    role: user.role,
    isActive: user.isActive,
    disabledAtPresent: user.disabledAt !== null,
    mustChangePassword: user.mustChangePassword,
  };
}

function auditMetadata(
  revokedSessionCount: number,
  flowType:
    | "ADMIN_CREATE"
    | "ADMIN_ROLE_CHANGE"
    | "ADMIN_ENABLE"
    | "ADMIN_DISABLE"
    | "ADMIN_PASSWORD_RESET"
    | "PERSONAL_PASSWORD_CHANGE",
) {
  return { revokedSessionCount, flowType };
}

async function requireFreshAdmin(
  client: IdentityClient,
  actor: IdentityActor,
): Promise<IdentityUser> {
  const current = await client.user.findFirst({
    where: {
      id: actor.id,
      restaurantId: actor.restaurantId,
      isActive: true,
      disabledAt: null,
    },
  });

  if (!current || current.role !== "ADMIN" || current.mustChangePassword) {
    throw new IdentityError(
      "FORBIDDEN",
      "Solo un amministratore attivo può gestire gli utenti.",
    );
  }

  return current;
}

async function requireFreshTarget(
  client: IdentityClient,
  restaurantId: string,
  targetUserId: string,
): Promise<IdentityUser> {
  const target = await client.user.findFirst({
    where: { id: targetUserId, restaurantId },
  });

  if (!target) {
    throw new IdentityError(
      "NOT_FOUND",
      "L'utente richiesto non appartiene a questo ristorante.",
    );
  }

  return target;
}

async function writeIdentityAudit(
  client: IdentityClient,
  input: {
    actor: IdentityUser;
    targetUserId: string;
    action:
      | "USER_CREATED"
      | "USER_ROLE_CHANGED"
      | "USER_ENABLED"
      | "USER_DISABLED"
      | "USER_PASSWORD_RESET"
      | "PASSWORD_CHANGED";
    previousState: ReturnType<typeof auditSnapshot> | null;
    newState: ReturnType<typeof auditSnapshot>;
    revokedSessionCount: number;
    flowType: Parameters<typeof auditMetadata>[1];
    now: Date;
  },
): Promise<void> {
  await insertAuditEvent(client, {
    restaurantId: input.actor.restaurantId,
    category: "IDENTITY",
    action: input.action,
    outcome: "SUCCESS",
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    entityType: "USER",
    entityId: input.targetUserId,
    correlationId: randomUUID(),
    previousState: input.previousState,
    newState: input.newState,
    metadata: auditMetadata(input.revokedSessionCount, input.flowType),
    createdAt: input.now,
  });
}

function handleDuplicate(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new IdentityError(
      "DUPLICATE",
      "Esiste già un utente con questo username nel ristorante.",
    );
  }

  throw error;
}

function temporaryPasswordFor(username: string): string {
  for (;;) {
    const password = generateTemporaryPassword();
    if (!validateSelectedPassword(password, username)) return password;
  }
}

export async function listManagedUsers(
  actor: IdentityActor,
): Promise<ManagedUser[]> {
  return prisma.$transaction(async (client) => {
    await requireFreshAdmin(client, actor);
    const users = await client.user.findMany({
      where: { restaurantId: actor.restaurantId },
      orderBy: [{ isActive: "desc" }, { role: "asc" }, { username: "asc" }],
    });

    return users.map(toManagedUser);
  });
}

export async function createManagedUser(
  actor: IdentityActor,
  unsafeInput: unknown,
): Promise<{ user: ManagedUser; temporaryPassword: string }> {
  const input = parse(createUserSchema, unsafeInput);
  const temporaryPassword = temporaryPasswordFor(input.username);
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date();

  try {
    const user = await runIdentityTransaction(async (client) => {
      const freshActor = await requireFreshAdmin(client, actor);
      const created = await client.user.create({
        data: {
          restaurantId: actor.restaurantId,
          username: input.username,
          passwordHash,
          role: input.role,
          mustChangePassword: true,
        },
      });

      await writeIdentityAudit(client, {
        actor: freshActor,
        targetUserId: created.id,
        action: "USER_CREATED",
        previousState: null,
        newState: auditSnapshot(created),
        revokedSessionCount: 0,
        flowType: "ADMIN_CREATE",
        now,
      });
      return created;
    });

    return { user: toManagedUser(user), temporaryPassword };
  } catch (error) {
    handleDuplicate(error);
  }
}

export async function changeManagedUserRole(
  actor: IdentityActor,
  targetUserIdValue: unknown,
  unsafeInput: unknown,
): Promise<{ user: ManagedUser; changed: boolean }> {
  const targetUserId = parseUserId(targetUserIdValue);
  const input = parse(userRoleChangeSchema, unsafeInput);
  const now = new Date();

  return runIdentityTransaction(async (client) => {
    await acquireIdentityLifecycleLock(client, actor.restaurantId);
    const freshActor = await requireFreshAdmin(client, actor);
    const target = await requireFreshTarget(
      client,
      actor.restaurantId,
      targetUserId,
    );

    if (target.role === input.role) {
      return { user: toManagedUser(target), changed: false };
    }

    if (target.id === freshActor.id && input.role !== "ADMIN") {
      throw new IdentityError(
        "SELF_PROTECTED",
        "Non puoi rimuovere il tuo ruolo amministratore.",
      );
    }

    if (
      target.role === "ADMIN" &&
      input.role === "STAFF" &&
      target.isActive &&
      !target.disabledAt
    ) {
      const activeAdmins = await client.user.count({
        where: {
          restaurantId: actor.restaurantId,
          role: "ADMIN",
          isActive: true,
          disabledAt: null,
        },
      });

      if (activeAdmins <= 1) {
        throw new IdentityError(
          "LAST_ADMIN",
          "Il ristorante deve mantenere almeno un amministratore attivo.",
        );
      }
    }

    const updated = await client.user.update({
      where: { id: target.id },
      data: { role: input.role },
    });
    const revokedSessionCount = await revokeAllSessionsForUser(target.id, {
      client,
      now,
    });

    await writeIdentityAudit(client, {
      actor: freshActor,
      targetUserId: target.id,
      action: "USER_ROLE_CHANGED",
      previousState: auditSnapshot(target),
      newState: auditSnapshot(updated),
      revokedSessionCount,
      flowType: "ADMIN_ROLE_CHANGE",
      now,
    });

    return { user: toManagedUser(updated), changed: true };
  });
}

export async function changeManagedUserStatus(
  actor: IdentityActor,
  targetUserIdValue: unknown,
  unsafeInput: unknown,
): Promise<{ user: ManagedUser; changed: boolean }> {
  const targetUserId = parseUserId(targetUserIdValue);
  const input = parse(userStatusChangeSchema, unsafeInput);
  const now = new Date();

  return runIdentityTransaction(async (client) => {
    await acquireIdentityLifecycleLock(client, actor.restaurantId);
    const freshActor = await requireFreshAdmin(client, actor);
    const target = await requireFreshTarget(
      client,
      actor.restaurantId,
      targetUserId,
    );

    if (target.isActive === input.isActive) {
      return { user: toManagedUser(target), changed: false };
    }

    if (target.id === freshActor.id && !input.isActive) {
      throw new IdentityError(
        "SELF_PROTECTED",
        "Non puoi disattivare il tuo account.",
      );
    }

    if (target.role === "ADMIN" && target.isActive && !input.isActive) {
      const activeAdmins = await client.user.count({
        where: {
          restaurantId: actor.restaurantId,
          role: "ADMIN",
          isActive: true,
          disabledAt: null,
        },
      });

      if (activeAdmins <= 1) {
        throw new IdentityError(
          "LAST_ADMIN",
          "Il ristorante deve mantenere almeno un amministratore attivo.",
        );
      }
    }

    const updated = await client.user.update({
      where: { id: target.id },
      data: {
        isActive: input.isActive,
        disabledAt: input.isActive ? null : now,
      },
    });
    const revokedSessionCount = input.isActive
      ? 0
      : await revokeAllSessionsForUser(target.id, { client, now });

    await writeIdentityAudit(client, {
      actor: freshActor,
      targetUserId: target.id,
      action: input.isActive ? "USER_ENABLED" : "USER_DISABLED",
      previousState: auditSnapshot(target),
      newState: auditSnapshot(updated),
      revokedSessionCount,
      flowType: input.isActive ? "ADMIN_ENABLE" : "ADMIN_DISABLE",
      now,
    });

    return { user: toManagedUser(updated), changed: true };
  });
}

export async function resetManagedUserPassword(
  actor: IdentityActor,
  targetUserIdValue: unknown,
): Promise<{ user: ManagedUser; temporaryPassword: string }> {
  const targetUserId = parseUserId(targetUserIdValue);
  const targetForPassword = await prisma.user.findFirst({
    where: { id: targetUserId, restaurantId: actor.restaurantId },
    select: { username: true },
  });

  if (!targetForPassword) {
    throw new IdentityError(
      "NOT_FOUND",
      "L'utente richiesto non appartiene a questo ristorante.",
    );
  }

  const temporaryPassword = temporaryPasswordFor(targetForPassword.username);
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date();

  const user = await runIdentityTransaction(async (client) => {
    const freshActor = await requireFreshAdmin(client, actor);
    const target = await requireFreshTarget(
      client,
      actor.restaurantId,
      targetUserId,
    );

    if (target.id === freshActor.id) {
      throw new IdentityError(
        "SELF_PROTECTED",
        "Per il tuo account usa il cambio password personale.",
      );
    }

    const updated = await client.user.update({
      where: { id: target.id },
      data: { passwordHash, mustChangePassword: true },
    });
    const revokedSessionCount = await revokeAllSessionsForUser(target.id, {
      client,
      now,
    });

    await writeIdentityAudit(client, {
      actor: freshActor,
      targetUserId: target.id,
      action: "USER_PASSWORD_RESET",
      previousState: auditSnapshot(target),
      newState: auditSnapshot(updated),
      revokedSessionCount,
      flowType: "ADMIN_PASSWORD_RESET",
      now,
    });
    return updated;
  });

  return { user: toManagedUser(user), temporaryPassword };
}

export async function changePersonalPassword(
  actor: IdentityActor,
  unsafeInput: unknown,
): Promise<void> {
  const input = parse(passwordChangeSchema, unsafeInput);
  const preliminaryUser = await prisma.user.findFirst({
    where: {
      id: actor.id,
      restaurantId: actor.restaurantId,
      isActive: true,
      disabledAt: null,
    },
  });

  if (
    !preliminaryUser ||
    !(await verifyPassword(preliminaryUser.passwordHash, input.currentPassword))
  ) {
    throw new IdentityError(
      "CURRENT_PASSWORD_INVALID",
      "La password attuale non è corretta.",
    );
  }

  if (input.newPassword !== input.confirmPassword) {
    throw new IdentityError(
      "VALIDATION",
      "La nuova password e la conferma non coincidono.",
    );
  }

  if (input.newPassword === input.currentPassword) {
    throw new IdentityError(
      "VALIDATION",
      "La nuova password deve essere diversa da quella attuale.",
    );
  }

  const policyFailure = validateSelectedPassword(
    input.newPassword,
    preliminaryUser.username,
  );

  if (policyFailure) {
    throw new IdentityError("VALIDATION", policyFailure.message);
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();

  await runIdentityTransaction(async (client) => {
    const current = await client.user.findFirst({
      where: {
        id: actor.id,
        restaurantId: actor.restaurantId,
        isActive: true,
        disabledAt: null,
      },
    });

    if (
      !current ||
      !(await verifyPassword(current.passwordHash, input.currentPassword))
    ) {
      throw new IdentityError(
        "CURRENT_PASSWORD_INVALID",
        "La password attuale non è corretta.",
      );
    }

    const updated = await client.user.update({
      where: { id: current.id },
      data: { passwordHash, mustChangePassword: false },
    });
    const revokedSessionCount = await revokeAllSessionsForUser(current.id, {
      client,
      now,
    });

    await writeIdentityAudit(client, {
      actor: current,
      targetUserId: current.id,
      action: "PASSWORD_CHANGED",
      previousState: auditSnapshot(current),
      newState: auditSnapshot(updated),
      revokedSessionCount,
      flowType: "PERSONAL_PASSWORD_CHANGE",
      now,
    });
  });
}
