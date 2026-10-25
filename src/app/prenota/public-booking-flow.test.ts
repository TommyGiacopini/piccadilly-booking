import { describe, expect, it } from "vitest";
import { availabilityQuery, bookingIssues, freezeAttempt, hasCurrentSlot, idleAvailability, initialBookingValues, ownsAttempt, reachSection, settleAvailability, type AvailabilityState, type BookingPayload } from "./public-booking-flow";
import { resolveClientSubmissionIdentity } from "@/shared/client/client-idempotency";

const payload: BookingPayload = {
  ...initialBookingValues, localDate: "2099-11-18", arrivalTime: "19:00",
  childrenCount: 0, gameRoomPreference: null, customerFirstName: "Synthetic",
  customerLastName: "T08", customerPhone: "+39000000000", language: "it",
  privacyAccepted: true, termsAccepted: true,
};
const key = availabilityQuery(payload)!;
const ready: AvailabilityState = { status: "READY", key, generation: 2, slots: ["19:00"] };
describe("T08 U01 progressive ownership", () => {
  it("only grows the reached surface; back does not erase values", () => {
    const draft = { ...payload, notes: "T08_MARKER", allergies: "Synthetic request" };
    expect(reachSection(1, 2)).toBe(2);
    expect(reachSection(3, 1)).toBe(3);
    expect(draft).toMatchObject({ notes: "T08_MARKER", allergies: "Synthetic request" });
  });
  it("early Notes does not bypass availability or composition", () => {
    expect(reachSection(1, 2)).toBe(2);
    expect(bookingIssues({ ...payload, localDate: "", childrenCount: null }, idleAvailability, 3))
      .toEqual(expect.arrayContaining([{ field: "localDate", section: 1 }, { field: "arrivalTime", section: 1 }, { field: "childrenCount", section: 2 }]));
  });
  it("language and contact edits do not change the availability identity", () => {
    expect(availabilityQuery({ ...payload, language: "en", notes: "Changed" } as BookingPayload)).toBe(key);
  });
});
describe("T08 U02 canonical validation", () => {
  it.each([[0, null], [1, true], [1, false], [2, true]] as const)("accepts children %s games %s", (childrenCount, gameRoomPreference) => {
    expect(bookingIssues({ ...payload, childrenCount, gameRoomPreference }, ready, 3)).toEqual([]);
  });
  it.each([[null, null], [3, true], [1, null], [0, true], [-1, false]] as const)("rejects inconsistent children %s games %s", (childrenCount, gameRoomPreference) => {
    expect(bookingIssues({ ...payload, childrenCount, gameRoomPreference }, ready, 3).some(issue => issue.section === 2)).toBe(true);
  });
  it("does not serialize an incomplete children choice as an adult declaration", () => {
    expect(bookingIssues(payload, ready, 2, { mode: "children", count: "", games: "" })).toEqual(expect.arrayContaining([
      { field: "childrenCount", section: 2 }, { field: "gameRoomPreference", section: 2 },
    ]));
    expect(bookingIssues(payload, ready, 2, { mode: "children", count: "0", games: "no" })).toContainEqual({ field: "childrenCount", section: 2 });
  });
  it("keeps an invalid child count rather than silently reducing it", () => {
    const draft = { ...payload, partySize: 1, childrenCount: 2, gameRoomPreference: false };
    expect(bookingIssues(draft, { ...ready, key: availabilityQuery(draft) }, 2)).toContainEqual({ field: "childrenCount", section: 2 });
    expect(draft.childrenCount).toBe(2);
  });
  it("validates each reached section, including final consent and contacts", () => {
    const invalid = { ...payload, customerFirstName: "", privacyAccepted: false };
    expect(bookingIssues(invalid, ready, 2)).toEqual([]);
    expect(bookingIssues(invalid, ready, 3)).toContainEqual({ field: "customerFirstName", section: 3 });
    expect(bookingIssues(invalid, ready, 3)).toContainEqual({ field: "privacyAccepted", section: 3 });
  });
});
describe("T08 U03 availability and frozen submissions", () => {
  it.each(["", "not-a-date", "2099-02-30"])("does not search an invalid date %s", localDate => {
    expect(availabilityQuery({ ...payload, localDate })).toBeNull();
  });
  it.each([0, -1, 1.2, NaN])("does not search invalid covers %s", partySize => {
    expect(availabilityQuery({ ...payload, partySize })).toBeNull();
  });
  it("rejects old generations and old query responses", () => {
    const pending = { ...ready, status: "LOADING" as const, generation: 3, slots: [] };
    const body = { isOpen: true, slots: [{ time: "19:00", available: true }] };
    expect(settleAvailability(pending, key, 2, body)).toBe(pending);
    expect(settleAvailability(pending, "another-query", 3, body)).toBe(pending);
    expect(settleAvailability(pending, key, 3, body)).toMatchObject({ status: "READY", slots: ["19:00"] });
  });
  it.each([null, {}, { isOpen: true, slots: [{}] }, { isOpen: true, slots: [{ time: "99:99", available: true }] }, { isOpen: true, slots: [{ time: "19:00", available: "yes" }] }])("rejects malformed availability", body => {
    expect(settleAvailability({ ...ready, status: "LOADING" }, key, 2, body).status).toBe("ERROR");
  });
  it("distinguishes empty from error without inventing slots", () => {
    expect(settleAvailability(ready, key, 2, { isOpen: false, slots: [] })).toMatchObject({ status: "EMPTY", slots: [] });
    expect(settleAvailability(ready, key, 2, { isOpen: true, slots: [{ time: "19:00", available: false }] }).status).toBe("EMPTY");
  });
  it("requires a selected slot in the current READY query", () => {
    expect(hasCurrentSlot(ready, payload)).toBe(true);
    expect(hasCurrentSlot({ ...ready, status: "LOADING" }, payload)).toBe(false);
    expect(hasCurrentSlot(ready, { ...payload, partySize: 3 })).toBe(false);
    expect(hasCurrentSlot(ready, { ...payload, arrivalTime: "20:00" })).toBe(false);
  });
  it("freezes all submitted values and language; identical retry keeps key and bytes", () => {
    const draft = { ...payload, notes: "Original marker" };
    const identity = resolveClientSubmissionIdentity(null, JSON.stringify(draft), () => "00000000-0000-4000-8000-000000000001");
    const attempt = freezeAttempt(draft, identity, 1);
    draft.notes = "Edited"; draft.language = "en";
    expect(attempt.payload).toMatchObject({ notes: "Original marker", language: "it" });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.payload)).toBe(true);
    expect(resolveClientSubmissionIdentity(attempt, attempt.signature, () => { throw new Error("must not rotate"); })).toBe(attempt);
    expect(ownsAttempt(attempt, attempt)).toBe(true);
    expect(ownsAttempt(freezeAttempt(payload, identity, 2), attempt)).toBe(false);
  });
});
