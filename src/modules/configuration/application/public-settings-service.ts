import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import { PublicSettingsError } from "@/modules/configuration/application/public-settings-errors";
import {
  managementLinkDurationMutationSchema,
  PUBLIC_CONTENT_KEYS,
  PUBLIC_CONTENT_LOCALES,
  publicContactsMutationSchema,
  publicContentMutationSchema,
  publicContentSetSchema,
  type PublicContacts,
  type PublicContentKey,
  type PublicContentLocale,
  type PublicContentSet,
} from "@/modules/configuration/domain/public-settings";
import {
  acquireOperationalConfigurationLock,
  runOperationalConfigurationTransaction,
  type OperationalConfigurationClient,
} from "@/modules/configuration/infrastructure/operational-configuration-repository";
import {
  readPublicSettingsContext,
  updateManagementLinkDuration,
  upsertPublicContacts,
  upsertPublicContentSet,
} from "@/modules/configuration/infrastructure/public-settings-repository";
import { prisma } from "@/server/db/prisma";

export interface PublicSettingsActor {
  id: string;
  restaurantId: string;
}

type PublicSettingsContext = NonNullable<
  Awaited<ReturnType<typeof readPublicSettingsContext>>
>;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validationError(message: string): PublicSettingsError {
  return new PublicSettingsError("VALIDATION", message);
}

function contactsFromContext(
  context: PublicSettingsContext,
): PublicContacts | null {
  return context.publicSettings
    ? {
        publicPhone: context.publicSettings.publicPhone,
        publicBookingBaseUrl: context.publicSettings.publicBookingBaseUrl,
        publicEmail: context.publicSettings.publicEmail,
        whatsappNumber: context.publicSettings.whatsappNumber,
      }
    : null;
}

export function contentsFromContext(
  context: PublicSettingsContext,
): PublicContentSet | null {
  const candidate = Object.fromEntries(
    PUBLIC_CONTENT_LOCALES.map((locale) => [locale, {}]),
  ) as Record<PublicContentLocale, Partial<Record<PublicContentKey, string>>>;
  for (const row of context.publicContents) {
    candidate[row.locale][row.contentKey] = row.contentText;
  }
  const parsed = publicContentSetSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function contextFingerprints(context: PublicSettingsContext) {
  const contacts = contactsFromContext(context);
  const contents = contentsFromContext(context);
  const duration = context.bookingSettings?.managementLinkDurationHours ?? null;
  return {
    contacts: fingerprint(contacts),
    contents: fingerprint(contents),
    duration: fingerprint(duration),
  };
}

async function requireFreshAdmin(
  client: OperationalConfigurationClient,
  actor: PublicSettingsActor,
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
    throw new PublicSettingsError(
      "FORBIDDEN",
      "Solo un amministratore attivo può gestire la configurazione pubblica.",
    );
  }
  return current;
}

async function lockedContext(
  client: OperationalConfigurationClient,
  actor: PublicSettingsActor,
) {
  await acquireOperationalConfigurationLock(client, actor.restaurantId);
  const currentActor = await requireFreshAdmin(client, actor);
  const context = await readPublicSettingsContext(client, actor.restaurantId);
  if (!context || !context.bookingSettings) {
    throw new PublicSettingsError(
      "NOT_FOUND",
      "La configurazione del ristorante non è disponibile.",
    );
  }
  return { currentActor, context };
}

function assertFingerprint(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new PublicSettingsError(
      "STATE_CHANGED",
      "La configurazione è cambiata. Ricarica la pagina e riprova.",
    );
  }
}

function contactPresence(contacts: PublicContacts | null) {
  return {
    phoneConfigured: contacts !== null,
    emailConfigured: contacts?.publicEmail !== null && contacts?.publicEmail !== undefined,
    whatsappConfigured:
      contacts?.whatsappNumber !== null && contacts?.whatsappNumber !== undefined,
    urlConfigured: contacts !== null,
  };
}

function contentAuditState(contents: PublicContentSet | null) {
  return {
    complete: contents !== null,
    locales: contents ? [...PUBLIC_CONTENT_LOCALES] : [],
    keys: contents ? [...PUBLIC_CONTENT_KEYS] : [],
  };
}

function contactChangedFields(
  previous: PublicContacts | null,
  next: PublicContacts,
) {
  return (Object.keys(next) as Array<keyof PublicContacts>).filter(
    (key) => previous?.[key] !== next[key],
  );
}

function contentChanges(
  previous: PublicContentSet | null,
  next: PublicContentSet,
) {
  return PUBLIC_CONTENT_LOCALES.map((locale) => ({
    locale,
    keys: PUBLIC_CONTENT_KEYS.filter(
      (key) => previous?.[locale][key] !== next[locale][key],
    ),
  })).filter((entry) => entry.keys.length > 0);
}

export async function getAdminPublicSettings(actor: PublicSettingsActor) {
  const currentActor = await prisma.user.findFirst({
    where: {
      id: actor.id,
      restaurantId: actor.restaurantId,
      role: "ADMIN",
      isActive: true,
      disabledAt: null,
      mustChangePassword: false,
    },
    select: { id: true },
  });
  if (!currentActor) {
    throw new PublicSettingsError("FORBIDDEN", "Accesso non autorizzato.");
  }
  const context = await readPublicSettingsContext(prisma, actor.restaurantId);
  if (!context || !context.bookingSettings) {
    throw new PublicSettingsError("NOT_FOUND", "Configurazione non disponibile.");
  }
  return {
    contacts: contactsFromContext(context),
    contents: contentsFromContext(context),
    managementLinkDurationHours:
      context.bookingSettings.managementLinkDurationHours,
    fingerprints: contextFingerprints(context),
  };
}

export async function getPublicSettings(restaurantId: string) {
  const context = await readPublicSettingsContext(prisma, restaurantId);
  if (!context) return null;
  const contacts = contactsFromContext(context);
  const contents = contentsFromContext(context);
  if (!contacts || !contents) return null;
  return { contacts, contents };
}

export async function updatePublicContacts(
  actor: PublicSettingsActor,
  rawInput: unknown,
) {
  const parsed = publicContactsMutationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues[0]?.message ?? "I contatti non sono validi.",
    );
  }
  return runOperationalConfigurationTransaction(async (client) => {
    const { currentActor, context } = await lockedContext(client, actor);
    const previous = contactsFromContext(context);
    assertFingerprint(parsed.data.fingerprint, fingerprint(previous));
    const changedFields = contactChangedFields(previous, parsed.data.contacts);
    if (changedFields.length === 0) return { changed: false };

    await upsertPublicContacts(client, actor.restaurantId, parsed.data.contacts);
    await insertAuditEvent(client, {
      restaurantId: actor.restaurantId,
      category: "CONFIGURATION",
      action: "PUBLIC_CONTACTS_UPDATED",
      outcome: "SUCCESS",
      actorUserId: currentActor.id,
      actorRole: "ADMIN",
      entityType: "RestaurantPublicSettings",
      entityId: actor.restaurantId,
      correlationId: randomUUID(),
      previousState: contactPresence(previous),
      newState: contactPresence(parsed.data.contacts),
      metadata: { changedFields },
      createdAt: new Date(),
    });
    return { changed: true };
  });
}

export async function updatePublicContents(
  actor: PublicSettingsActor,
  rawInput: unknown,
) {
  const parsed = publicContentMutationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues[0]?.message ?? "I contenuti non sono validi.",
    );
  }
  return runOperationalConfigurationTransaction(async (client) => {
    const { currentActor, context } = await lockedContext(client, actor);
    const previous = contentsFromContext(context);
    assertFingerprint(parsed.data.fingerprint, fingerprint(previous));
    const changed = contentChanges(previous, parsed.data.contents);
    if (changed.length === 0) return { changed: false };

    await upsertPublicContentSet(client, actor.restaurantId, parsed.data.contents);
    await insertAuditEvent(client, {
      restaurantId: actor.restaurantId,
      category: "CONFIGURATION",
      action: "PUBLIC_CONTENT_UPDATED",
      outcome: "SUCCESS",
      actorUserId: currentActor.id,
      actorRole: "ADMIN",
      entityType: "Restaurant",
      entityId: actor.restaurantId,
      correlationId: randomUUID(),
      previousState: contentAuditState(previous),
      newState: contentAuditState(parsed.data.contents),
      metadata: { changed },
      createdAt: new Date(),
    });
    return { changed: true };
  });
}

export async function updatePublicManagementLinkDuration(
  actor: PublicSettingsActor,
  rawInput: unknown,
) {
  const parsed = managementLinkDurationMutationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues[0]?.message ?? "La durata non è valida.",
    );
  }
  return runOperationalConfigurationTransaction(async (client) => {
    const { currentActor, context } = await lockedContext(client, actor);
    const previous = context.bookingSettings?.managementLinkDurationHours;
    if (previous === undefined) {
      throw new PublicSettingsError("NOT_FOUND", "Configurazione non disponibile.");
    }
    assertFingerprint(parsed.data.fingerprint, fingerprint(previous));
    if (previous === parsed.data.managementLinkDurationHours) {
      return { changed: false, existingTokensAffected: 0 };
    }

    await updateManagementLinkDuration(
      client,
      actor.restaurantId,
      parsed.data.managementLinkDurationHours,
    );
    await insertAuditEvent(client, {
      restaurantId: actor.restaurantId,
      category: "CONFIGURATION",
      action: "MANAGEMENT_LINK_DURATION_UPDATED",
      outcome: "SUCCESS",
      actorUserId: currentActor.id,
      actorRole: "ADMIN",
      entityType: "RestaurantBookingSettings",
      entityId: actor.restaurantId,
      correlationId: randomUUID(),
      previousState: { managementLinkDurationHours: previous },
      newState: {
        managementLinkDurationHours: parsed.data.managementLinkDurationHours,
      },
      metadata: { existingTokensAffected: 0 },
      createdAt: new Date(),
    });
    return { changed: true, existingTokensAffected: 0 };
  });
}
