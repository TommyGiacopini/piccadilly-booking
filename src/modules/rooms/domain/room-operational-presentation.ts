export interface RoomOperationalPresentation {
  label: string;
  category: "MAIN" | "LEGACY" | "UNKNOWN";
}

/** Presentation only: never determines availability or assignment eligibility. */
export function roomOperationalPresentation(
  room: Readonly<{ code: string; name: string }>,
): RoomOperationalPresentation {
  switch (room.code) {
    case "sala-1": return { label: "Sala 1", category: "MAIN" };
    case "sala-2": return { label: "Sala 2", category: "MAIN" };
    case "sala-3": return { label: "Sala 3 — Giochi", category: "MAIN" };
    case "galleria": return { label: "Galleria", category: "LEGACY" };
    case "terrazzo": return { label: "Terrazzo", category: "LEGACY" };
    default: return { label: room.name, category: "UNKNOWN" };
  }
}
