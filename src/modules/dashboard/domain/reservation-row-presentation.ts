export interface CompositionRowInput { partySize: number; childrenCount: number | null; children: boolean }
export function reservationCompositionPresentation(value: CompositionRowInput): { label: string; description: string } {
  if (value.childrenCount === 0) return { label: "TA", description: `${value.partySize} coperti, tutti adulti` };
  if (value.childrenCount !== null && value.childrenCount > 0) return { label: `Bimbi (${value.childrenCount})`, description: `${value.partySize} coperti totali, ${value.childrenCount} bambini inclusi` };
  return value.children
    ? { label: "Bambini segnalati", description: "Composizione non specificata; bambini segnalati senza numero" }
    : { label: "Composizione non specificata", description: "Numero di bambini non dichiarato" };
}
export function reservationNoteIndicators(value: {
  notes: string | null; privateNotesPresent: boolean; legacyNotesPresent: boolean; legacyNotesState: "ACTIVE" | "CLEARED" | null;
}): readonly { key: "NC" | "NI" | "LEGACY"; present: boolean; label: string }[] {
  return [
    { key: "NC", present: value.notes !== null && value.notes !== "", label: `NC condivisa ${value.notes !== null && value.notes !== "" ? "presente" : "assente"}` },
    { key: "NI", present: value.privateNotesPresent, label: `NI autonoma ${value.privateNotesPresent ? "presente" : "assente"}` },
    { key: "LEGACY", present: value.legacyNotesPresent, label: value.legacyNotesPresent
      ? `NI legacy presente · assegnazione ${value.legacyNotesState === "CLEARED" ? "rimossa" : "attiva"}` : "NI legacy assente" },
  ];
}
export function phoneInitialService(value: unknown): "LUNCH" | "DINNER" { return value === "LUNCH" ? "LUNCH" : "DINNER"; }
