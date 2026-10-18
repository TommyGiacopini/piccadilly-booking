import { describe, expect, it } from "vitest";
import { phoneInitialService, reservationCompositionPresentation, reservationNoteIndicators } from "./reservation-row-presentation";
describe("T06-B row presentation without inferred data", () => {
  it("uses TA only for an explicit zero", () => {
    expect(reservationCompositionPresentation({ partySize: 7, childrenCount: 0, children: true })).toEqual({ label: "TA", description: "7 coperti, tutti adulti" });
    expect(reservationCompositionPresentation({ partySize: 7, childrenCount: null, children: false }).label).toBe("Composizione non specificata");
    expect(reservationCompositionPresentation({ partySize: 7, childrenCount: null, children: true }).label).toBe("Bambini segnalati");
  });
  it("shows the declared count without changing total covers", () => {
    expect(reservationCompositionPresentation({ partySize: 7, childrenCount: 2, children: true })).toEqual({ label: "Bimbi (2)", description: "7 coperti totali, 2 bambini inclusi" });
  });
  it("keeps NC, autonomous NI and cleared legacy distinct without projecting text", () => {
    const value = { notes: "ARTIFICIAL_SHARED_NC", privateNotesPresent: false, legacyNotesPresent: true, legacyNotesState: "CLEARED" as const };
    const labels = reservationNoteIndicators(value);
    expect(labels.map(i => i.present)).toEqual([true, false, true]);
    expect(labels[2].label).toContain("rimossa");
    expect(JSON.stringify(labels)).not.toContain(value.notes);
    expect(reservationNoteIndicators({ ...value, notes: " ", privateNotesPresent: true })[0].present).toBe(true);
  });
  it.each([undefined, "ALL", "DINNER", "invalid", ["LUNCH"]])("defaults ambiguous PHONE context to DINNER", value => expect(phoneInitialService(value)).toBe("DINNER"));
  it("preserves an explicit LUNCH origin", () => expect(phoneInitialService("LUNCH")).toBe("LUNCH"));
});
