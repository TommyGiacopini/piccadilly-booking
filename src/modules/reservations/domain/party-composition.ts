import { z } from "zod";

export const partyCompositionFields = {
  childrenCount: z.number().int().nonnegative().nullable(),
  gameRoomPreference: z.boolean().nullable(),
} as const;

export interface PartyComposition {
  partySize: number;
  childrenCount: number | null;
  gameRoomPreference: boolean | null;
}

export function validatePartyComposition(value: PartyComposition, context: z.RefinementCtx) {
  const { childrenCount, gameRoomPreference, partySize } = value;
  if (childrenCount !== null && childrenCount > partySize) {
    context.addIssue({ code: "custom", path: ["childrenCount"], message: "Il numero di bambini non può superare i coperti totali." });
  }
  if ((childrenCount === null || childrenCount === 0) ? gameRoomPreference !== null : gameRoomPreference === null) {
    context.addIssue({ code: "custom", path: ["gameRoomPreference"], message: "Indica Sì o No per la Sala con i Giochi soltanto quando sono presenti bambini." });
  }
}

export function compositionChangeIsDeclared(current: PartyComposition, desired: PartyComposition): boolean {
  return desired.childrenCount !== null ||
    (current.childrenCount === null && current.partySize === desired.partySize);
}

export function partyCompositionLabel(value: PartyComposition): string {
  const composition = value.childrenCount === null
    ? "composizione non specificata"
    : value.childrenCount === 0
      ? "tutti adulti"
      : `${value.childrenCount} ${value.childrenCount === 1 ? "bambino" : "bambini"}`;
  return `${value.partySize} coperti · ${composition}`;
}
