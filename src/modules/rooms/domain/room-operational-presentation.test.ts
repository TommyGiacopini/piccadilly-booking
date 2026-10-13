import { describe, expect, it } from "vitest";

import { roomOperationalPresentation } from "./room-operational-presentation";

describe("T05 operational room presentation (U01–U05)", () => {
  it.each([
    ["sala-1", "Sala 1", "MAIN"],
    ["sala-2", "Sala 2", "MAIN"],
    ["sala-3", "Sala 3 — Giochi", "MAIN"],
    ["galleria", "Galleria", "LEGACY"],
    ["terrazzo", "Terrazzo", "LEGACY"],
  ])("U01/U02 maps %s without availability metadata", (code, label, category) => {
    expect(roomOperationalPresentation({ code, name: code })).toEqual({ label, category });
  });

  it("U03 preserves the complete raw fallback, including literal markup", () => {
    const name = "Area sconosciuta à <script>non eseguire</script> " + "Lungo".repeat(200);
    expect(roomOperationalPresentation({ code: "future-area", name })).toEqual({ label: name, category: "UNKNOWN" });
    expect(roomOperationalPresentation({ code: "SALA-3", name: "Raw" }).label).toBe("Raw");
    expect(roomOperationalPresentation({ code: "", name: "" }).label).toBe("");
  });

  it("U04 is pure and preserves identity, raw names, policy and Admin ordering", () => {
    const rooms = Object.freeze([
      Object.freeze({ id: "legacy", code: "galleria", name: "Galleria", displayOrder: 1, serviceAvailabilityPolicy: "EXPLICIT_ONLY", isActive: false }),
      Object.freeze({ id: "games", code: "sala-3", name: "Sala 3", displayOrder: 2, serviceAvailabilityPolicy: "DEFAULT_AVAILABLE", isActive: true }),
    ]);
    const before = JSON.stringify(rooms);
    expect(rooms.map(roomOperationalPresentation).map((room) => room.label)).toEqual(["Galleria", "Sala 3 — Giochi"]);
    expect(JSON.stringify(rooms)).toBe(before);
    expect(roomOperationalPresentation(rooms[0])).toEqual(roomOperationalPresentation(rooms[0]));
  });

  it("U05 adapts summary/history text only, not counts or historical preference", () => {
    const summary = Object.freeze([
      Object.freeze({ code: "sala-3", label: "Sala 3", covers: 5 }),
      Object.freeze({ code: "galleria", label: "Galleria", covers: 2 }),
    ]);
    const history = Object.freeze({ roomId: "unchanged", roomCode: "sala-3", roomName: "Sala 3", preferredRoom: "Sala 3", childrenCount: null, gameRoomPreference: null });
    const before = JSON.stringify({ summary, history });
    expect(summary.map((room) => `${roomOperationalPresentation({ code: room.code, name: room.label }).label}: ${room.covers}`)).toEqual(["Sala 3 — Giochi: 5", "Galleria: 2"]);
    expect(roomOperationalPresentation({ code: history.roomCode, name: history.roomName }).label).toBe("Sala 3 — Giochi");
    expect(history.preferredRoom).toBe("Sala 3");
    expect(JSON.stringify({ summary, history })).toBe(before);
  });
});
