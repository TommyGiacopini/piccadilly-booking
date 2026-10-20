"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  authorizeStaffDrafts, beginStaffDraftAttempt, createStaffDraftState, discardStaffDraft, draftHasUnsavedChanges,
  initializeStaffDraft, invalidateStaffDrafts, matchesStaffDraftAttempt, ownsStaffDraftAttempt, rejectStaffDraftDispatch, quarantineStaffDrafts, reviewStaffDraftBaseline,
  sameDraftSession, settleStaffDraftAttempt, staffDraftKey, updateStaffDraft,
  type StaffDraftIdentity, type StaffDraftKind, type StaffDraftReceipt, type StaffDraftRecord, type StaffDraftState, type StaffDraftValues,
} from "@/modules/dashboard/domain/staff-draft-state";
import type { StaffAgendaOrder } from "@/modules/dashboard/domain/staff-agenda";
import type { StaffReservationDto } from "@/modules/reservations/domain/staff-dto";
import type { ReservationPrivateNotesContext } from "@/modules/reservations/domain/reservation-notes";
import type { ReservationAssignmentContextDto } from "@/modules/rooms/domain/reservation-assignment";
import { StaffNavigationGuard } from "./staff-navigation-guard";
import { createClientIdempotencyKey } from "@/shared/client/client-idempotency";

export interface VolatileAgendaState {
  originPath: string; query: string; order: StaffAgendaOrder; scrollY: number; focusReservationId: string | null;
  feedback: string | null; destinationHref: string | null;
}
export interface StaffNavigationIntent { id: string; keys: readonly string[]; run: () => void; trigger: HTMLElement | null; purpose?: "LOGOUT" }
interface OverlayLease { owner: string; element: HTMLElement; close: () => void }
type ResourceKind = "STAFF" | "NI" | "ASSIGNMENT";
type ResourceData = StaffReservationDto | ReservationPrivateNotesContext | ReservationAssignmentContextDto;
interface ResourceEntry { epoch: number; lease: number; route: string; data: ResourceData }
export interface StaffHostView {
  drafts: StaffDraftState;
  revision: number;
  resourceGeneration: number;
  overlay: OverlayLease | null;
  guard: StaffNavigationIntent | null;
  notice: string | null;
  detachedReceipt: StaffDraftReceipt | null;
  privateNotesSurface: string | null;
  roomSurface: string | null;
  agenda: VolatileAgendaState;
}
const emptyAgenda = (): VolatileAgendaState => ({ originPath: "/dashboard", query: "", order: "OLDEST", scrollY: 0, focusReservationId: null, feedback: null, destinationHref: null });
const locationKey = () => typeof window === "undefined" ? "" : window.location.pathname + window.location.search;
const staffPath = (path: string) => /^\/(?:dashboard|admin)(?:\/|\?|$)/u.test(path);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validProof(value: unknown, challenge: string): value is StaffDraftIdentity & { challenge: string } {
  return object(value) && Object.keys(value).sort().join(",") === "actorId,challenge,role,sessionBinding,tenantId" &&
    value.challenge === challenge && typeof value.actorId === "string" && uuid.test(value.actorId) && typeof value.tenantId === "string" && uuid.test(value.tenantId) &&
    typeof value.sessionBinding === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.sessionBinding) && (value.role === "STAFF" || value.role === "ADMIN");
}
function validResource(kind: ResourceKind, body: unknown, id: string): body is ResourceData {
  if (!object(body)) return false;
  const reservation = kind === "STAFF" ? body : body.reservation;
  if (!object(reservation) || reservation.id !== id || !Number.isInteger(reservation.version) || Number(reservation.version) < 1 ||
    (reservation.status !== "CONFIRMED" && reservation.status !== "CANCELLED")) return false;
  if (kind === "STAFF") return object(body.customer) && typeof body.localDate === "string" && typeof body.arrivalTime === "string" &&
    (body.serviceType === "LUNCH" || body.serviceType === "DINNER") && typeof body.customer.firstName === "string" && typeof body.customer.lastName === "string" && typeof body.customer.phone === "string";
  if (kind === "NI") return (body.privateNotes === null || typeof body.privateNotes === "string") && typeof body.privateNotesPresent === "boolean" &&
    (body.legacyAssignment === null || object(body.legacyAssignment));
  return Array.isArray(body.rooms) && (body.assignment === null || object(body.assignment));
}
export class StaffResourceError extends Error {
  constructor(public readonly status: number) { super(status === 404 ? "Prenotazione non disponibile." : "Lettura non disponibile. Riprova senza sostituire la bozza."); }
}

function createStaffDraftController() {
  let localSequence = 0;
  function localId(): string {
    try { return createClientIdempotencyKey(); }
    catch {
      // UUIDv8 equality/correlation IDs are scoped to this provider. They are
      // not credentials or PHONE idempotency keys. No insecure key fallback.
      if (++localSequence > 281474976710655) throw new Error("Local identity exhausted");
      return "00000000-0000-8000-8000-" + localSequence.toString(16).padStart(12, "0");
    }
  }
  let view: StaffHostView = { drafts: createStaffDraftState(), revision: 0, resourceGeneration: 0, overlay: null, guard: null, notice: null, detachedReceipt: null, privateNotesSurface: null, roomSurface: null, agenda: emptyAgenda() };
  const initial = view, listeners = new Set<() => void>(), resources = new Map<string, ResourceEntry>();
  const reads = new Map<string, Promise<ResourceData | null>>(), activeDrafts = new Map<string, { key: string; navigation: number }>();
  const readGenerations = new Map<string, number>();
  const deferred = new Map<string, { stamp: Parameters<typeof settleStaffDraftAttempt>[2]; outcome: Parameters<typeof settleStaffDraftAttempt>[3] }>();
  const sensitiveRegions = new Set<HTMLElement>();
  let proofGeneration = 0, proofFlight: { generation: number; promise: Promise<StaffDraftIdentity | null> } | null = null;
  let authorizedRoute = "", observedRoute = "", navigationGeneration = 0, phoneLocalId: string | null = null;
  let returnFocus: HTMLElement | null = null, documentLeaving = false, logoutPending = false;
  const publish = (next: StaffHostView) => { view = next; listeners.forEach(listener => listener()); };
  const update = (next: Partial<StaffHostView>) => publish({ ...view, ...next, revision: view.revision + 1 });
  const draftUpdate = (drafts: StaffDraftState) => update({ drafts });
  function erasePersonalState() {
    ++proofGeneration; proofFlight = null; authorizedRoute = ""; resources.clear(); reads.clear(); readGenerations.clear(); deferred.clear(); activeDrafts.clear(); phoneLocalId = null;
    update({ drafts: invalidateStaffDrafts(view.drafts), agenda: emptyAgenda(), overlay: null, guard: null, notice: null, detachedReceipt: null, privateNotesSurface: null, roomSurface: null });
  }
  function quarantine() {
    ++proofGeneration; proofFlight = null; authorizedRoute = ""; resources.clear(); reads.clear();
    draftUpdate(quarantineStaffDrafts(view.drafts));
  }
  function hideRegions() {
    for (const region of sensitiveRegions) { region.hidden = true; region.inert = true; }
  }
  function destroyDocumentState() {
    // Hide synchronously before React cleanup, including the DOM cached by a
    // browser. Flush removes controls/text; no old RSC/form state is a restore.
    hideRegions(); ++navigationGeneration;
    flushSync(erasePersonalState);
  }
  async function verifySession(): Promise<StaffDraftIdentity | null> {
    const route = locationKey();
    if (!staffPath(route)) return null;
    if (proofFlight?.generation === proofGeneration) return proofFlight.promise;
    quarantine();
    const generation = proofGeneration, navigation = navigationGeneration;
    const promise = (async () => {
      try {
        const challenge = localId();
        const response = await fetch("/api/auth/draft-context", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) });
        const body: unknown = await response.json();
        if (generation !== proofGeneration || navigation !== navigationGeneration || route !== locationKey()) return null;
        if (response.status === 401 || response.status === 403) { erasePersonalState(); update({ notice: "Accesso richiesto. Le bozze della sessione precedente sono state eliminate." }); return null; }
        if (!response.ok || !validProof(body, challenge)) throw new Error("Verification unavailable");
        const identity: StaffDraftIdentity = { actorId: body.actorId, tenantId: body.tenantId, sessionBinding: body.sessionBinding, role: body.role };
        const changed = view.drafts.identity !== null && !sameDraftSession(view.drafts.identity, identity);
        if (changed) { resources.clear(); reads.clear(); deferred.clear(); activeDrafts.clear(); phoneLocalId = null; }
        authorizedRoute = route;
        update({ drafts: authorizeStaffDrafts(view.drafts, identity), ...(changed ? { agenda: emptyAgenda(), detachedReceipt: null, privateNotesSurface: null, roomSurface: null, notice: "Sessione cambiata: nessuna bozza precedente è stata ripristinata." } : {}) });
        for (const [key, pending] of deferred) {
          if (matchesStaffDraftAttempt(view.drafts, key, pending.stamp)) {
            draftUpdate(settleStaffDraftAttempt(view.drafts, key, pending.stamp, pending.outcome));
            if (pending.outcome.kind === "CONFIRMED") { draftUpdate(discardStaffDraft(view.drafts, key)); update({ detachedReceipt: pending.outcome.receipt }); }
            update({ resourceGeneration: view.resourceGeneration + 1, notice: "Esito di una richiesta precedente verificato. Riprendi esplicitamente la relativa superficie." });
          }
          deferred.delete(key);
        }
        return identity;
      } catch {
        if (generation === proofGeneration && navigation === navigationGeneration) update({ drafts: { ...view.drafts, auth: "UNAVAILABLE" }, notice: "Verifica della sessione non disponibile. Le bozze restano nascoste; riprova." });
        return null;
      } finally { if (proofFlight?.generation === generation) proofFlight = null; }
    })();
    proofFlight = { generation, promise }; return promise;
  }
  const sessionVisible = () => view.drafts.auth === "AUTHORIZED" && authorizedRoute === locationKey() && staffPath(locationKey());
  async function readResource(kind: ResourceKind, id: string, force = false): Promise<ResourceData | null> {
    const key = `${kind}:${id}`, cached = resources.get(key);
    if (!force && cached && sessionVisible() && cached.epoch === view.drafts.authEpoch && cached.lease === view.drafts.leaseEpoch && cached.route === locationKey()) return cached.data;
    const inFlight = reads.get(key); if (inFlight && !force) return inFlight;
    const readGeneration = (readGenerations.get(key) ?? 0) + 1;
    readGenerations.set(key, readGeneration);
    const operation = (async () => {
      if (!sessionVisible() && !await verifySession()) return null;
      const epoch = view.drafts.authEpoch, lease = view.drafts.leaseEpoch, route = locationKey(), generation = proofGeneration;
      const suffix = kind === "NI" ? "/private-notes" : kind === "ASSIGNMENT" ? "/assignment" : "";
      try {
        const response = await fetch(`/api/staff/reservations/${id}${suffix}`, { cache: "no-store", credentials: "same-origin" });
        const raw: unknown = await response.json();
        if (readGeneration !== readGenerations.get(key) || epoch !== view.drafts.authEpoch || lease !== view.drafts.leaseEpoch || generation !== proofGeneration || route !== locationKey() || !sessionVisible()) return null;
        if (response.status === 401 || response.status === 403) { erasePersonalState(); throw new StaffResourceError(response.status); }
        if (response.status === 404) {
          const records = Object.fromEntries(Object.entries(view.drafts.records).filter(([, draft]) => draft.resourceId !== id));
          draftUpdate({ ...view.drafts, records }); throw new StaffResourceError(404);
        }
        const body = kind === "STAFF" && object(raw) ? raw.reservation : raw;
        if (!response.ok || !validResource(kind, body, id)) throw new StaffResourceError(response.ok ? 500 : response.status);
        resources.set(key, { epoch, lease, route, data: body }); update({}); return body;
      } catch (error) { if (error instanceof StaffResourceError) throw error; throw new StaffResourceError(500); }
    })();
    reads.set(key, operation);
    try { return await operation; } finally { if (reads.get(key) === operation) reads.delete(key); }
  }
  function getResource(kind: ResourceKind, id: string): ResourceData | null {
    const resource = resources.get(`${kind}:${id}`);
    return sessionVisible() && resource?.epoch === view.drafts.authEpoch && resource.lease === view.drafts.leaseEpoch && resource.route === locationKey() ? resource.data : null;
  }
  function routeChanged(route: string) {
    if (route === observedRoute) return;
    observedRoute = route; ++navigationGeneration;
    let state = view.drafts;
    for (const record of Object.values(state.records)) if (!draftHasUnsavedChanges(record)) {
      state = discardStaffDraft(state, record.key);
      if (record.kind === "PHONE") phoneLocalId = null;
    }
    if (state !== view.drafts) draftUpdate(state);
    if (view.drafts.identity || Object.keys(view.drafts.records).length || view.drafts.auth === "CHECKING") quarantine();
    update({ overlay: null, guard: null, privateNotesSurface: null, roomSurface: null });
    // The observer may mount after a child started proof. Its navigation
    // generation invalidates that response, so start a proof for this route.
    if (staffPath(route) && (view.drafts.identity || view.drafts.auth === "CHECKING")) void verifySession();
  }
  function activeKeys(): string[] {
    return [...new Set([...activeDrafts.values()].filter(owner => owner.navigation === navigationGeneration).map(owner => owner.key))].filter(key => view.drafts.records[key] && draftHasUnsavedChanges(view.drafts.records[key]));
  }
  function requestExit(run: () => void, keys: readonly string[] = activeKeys(), purpose?: "LOGOUT") {
    const dirty = keys.filter(key => view.drafts.records[key] && draftHasUnsavedChanges(view.drafts.records[key]));
    if (!dirty.length) { run(); return; }
    update({ guard: { id: localId(), keys: dirty, run, purpose, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null }, overlay: null });
  }
  function requestLogout(form?: HTMLFormElement) {
    requestExit(() => { void logout(form); }, Object.keys(view.drafts.records), "LOGOUT");
  }
  function resolveExit(choice: "STAY" | "KEEP" | "DISCARD", selected: readonly string[] = []) {
    const guard = view.guard; if (!guard) return;
    if (choice === "DISCARD") {
      if (selected.some(key => view.drafts.records[key]?.phase === "PENDING")) return;
      let state = view.drafts; for (const key of selected) state = discardStaffDraft(state, key); draftUpdate(state);
    }
    returnFocus = guard.trigger;
    update({ guard: null, overlay: null, notice: choice === "KEEP" && guard.purpose !== "LOGOUT" ? "Bozza conservata temporaneamente nella memoria di questa scheda." : view.notice });
    if (choice !== "STAY") guard.run();
    else {
      const navigation = navigationGeneration, epoch = view.drafts.authEpoch;
      requestAnimationFrame(() => {
        if (view.guard || view.overlay || navigation !== navigationGeneration || epoch !== view.drafts.authEpoch || !sessionVisible()) return;
        const target = guard.trigger?.isConnected ? guard.trigger : document.querySelector<HTMLElement>("h1");
        target?.focus(); returnFocus = null;
      });
    }
  }
  async function logout(form?: HTMLFormElement) {
    if (logoutPending) return;
    documentLeaving = false;
    // Preserve canonical native POST/303 navigation when there is no unsaved
    // work. A client redirect after fetch would race a following navigation.
    if (form?.isConnected && !Object.values(view.drafts.records).some(draftHasUnsavedChanges)) {
      quarantine(); hideRegions();
      HTMLFormElement.prototype.submit.call(form);
      return;
    }
    logoutPending = true;
    const epoch = view.drafts.authEpoch, navigation = navigationGeneration;
    quarantine(); hideRegions();
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", redirect: "follow", cache: "no-store" });
      const target = new URL(response.url);
      if (!response.ok || !response.redirected || target.origin !== location.origin || target.pathname !== "/login" || target.search || target.hash) throw new Error("Logout not confirmed");
      if (epoch !== view.drafts.authEpoch) { quarantine(); void verifySession(); return; }
      const foreground = !documentLeaving && navigation === navigationGeneration && staffPath(locationKey());
      erasePersonalState();
      if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("piccadilly-staff-auth"); channel.postMessage("reauth-required"); channel.close(); }
      if (foreground) window.location.assign(new URL("/login", window.location.origin).href);
      else update({ notice: "Logout confermato. Le bozze della sessione sono state eliminate." });
    } catch { if (epoch === view.drafts.authEpoch) update({ notice: "Logout non confermato. Le bozze restano nascoste; verifica la sessione o riprova il logout.", drafts: { ...view.drafts, auth: "UNAVAILABLE" } }); }
    finally { logoutPending = false; }
  }
  async function mutate(input: {
    key: string; url: string; method: "POST" | "PATCH" | "PUT"; payload: string; idempotencyKey?: string; failureMessage?: string;
    validate: (body: unknown) => { resourceId: string; version: number | null; text: string; destinationPath?: string } | null;
  }): Promise<{ confirmed: boolean; foreground: boolean; receipt: StaffDraftReceipt | null }> {
    const result = { confirmed: false, foreground: false, receipt: null };
    const current = view.drafts.records[input.key]; if (!current || !sessionVisible() || current.phase === "PENDING") return result;
    const route = locationKey(), navigation = navigationGeneration;
    const next = beginStaffDraftAttempt(view.drafts, input.key, { id: localId(), payload: input.payload, idempotencyKey: input.idempotencyKey });
    const stamp = next.records[input.key]?.attempt; if (!stamp) return result;
    draftUpdate(next);
    // Each attempt requires its own live challenge, never a cached/coalesced
    // display proof. Lock and snapshot precede this first asynchronous boundary.
    const owner = next.identity, generation = proofGeneration;
    const ownerBinding = owner?.sessionBinding;
    const ownsAttempt = () => ownsStaffDraftAttempt(view.drafts, input.key, stamp);
    const currentAttempt = () => ownsAttempt() && generation === proofGeneration && navigation === navigationGeneration && route === locationKey() && sessionVisible();
    const rejectDispatch = (unavailable: boolean) => {
      if (!ownsAttempt()) return;
      draftUpdate(rejectStaffDraftDispatch(view.drafts, input.key, stamp));
      if (unavailable) { hideRegions(); quarantine(); update({ drafts: { ...view.drafts, auth: "UNAVAILABLE" }, notice: "Verifica pre-invio non disponibile. Nessun invio effettuato; la bozza resta nascosta fino a nuova autorizzazione." }); }
    };
    // The immutable owner constraint is mandatory for this controller. Never
    // replace it with a later proof's binding or fall back to a legacy request.
    if (!ownerBinding || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(ownerBinding)) { rejectDispatch(true); return result; }
    try {
      const challenge = localId();
      const proof = await fetch("/api/auth/draft-context", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) });
      const checked: unknown = await proof.json().catch(() => null);
      if (!currentAttempt()) { rejectDispatch(false); return result; }
      if (proof.status === 401 || proof.status === 403) { hideRegions(); erasePersonalState(); update({ notice: "Accesso non confermato. Nessun invio effettuato; le bozze precedenti sono state invalidate." }); return result; }
      if (!proof.ok || !validProof(checked, challenge)) throw new Error("Fresh proof unavailable");
      if (!sameDraftSession(owner, checked)) {
        hideRegions(); erasePersonalState(); authorizedRoute = route;
        draftUpdate(authorizeStaffDrafts(view.drafts, { actorId: checked.actorId, tenantId: checked.tenantId, sessionBinding: checked.sessionBinding, role: checked.role }));
        update({ notice: "Sessione cambiata: nessun dato della bozza precedente è stato inviato." }); return result;
      }
      if (current.kind !== "PHONE") {
        const resource = await readResource(current.kind === "ROOM" ? "ASSIGNMENT" : current.kind === "NI" ? "NI" : "STAFF", stamp.resourceId, true);
        if (!currentAttempt()) { rejectDispatch(false); return result; }
        const reservation = (current.kind === "NI" || current.kind === "ROOM") && resource && "reservation" in resource ? resource.reservation : resource;
        if (!reservation || !("status" in reservation) || reservation.status !== "CONFIRMED") { rejectDispatch(false); return result; }
        if (current.kind === "ROOM") {
          if (!("localDate" in reservation) || !("serviceType" in reservation) ||
              !Number.isInteger(reservation.version) || reservation.version < 1 ||
              reservation.localDate !== stamp.values.expectedLocalDate || reservation.serviceType !== stamp.values.expectedServiceType) {
            if (ownsAttempt()) draftUpdate(settleStaffDraftAttempt(view.drafts, input.key, stamp, { kind: "DIRTY_CONFLICT", error: "Data o servizio modificati. Rileggi lo stato e rivaluta esplicitamente la scelta." }));
            return result;
          }
          const assignment = resource && "assignment" in resource ? resource.assignment : null;
          if (reservation.version !== stamp.baseVersion && assignment?.room.id !== stamp.values.roomId) {
            if (ownsAttempt()) draftUpdate(settleStaffDraftAttempt(view.drafts, input.key, stamp, { kind: "DIRTY_CONFLICT", error: "Versione modificata. Rileggi lo stato e rivaluta esplicitamente la scelta." }));
            return result;
          }
        }
      }
      if (!currentAttempt()) { rejectDispatch(false); return result; }
    } catch { rejectDispatch(true); return result; }
    // The server compares this original binding to the cookie authenticated
    // by this mutation, independently of the preceding display/submit proof.
    let outcome: Parameters<typeof settleStaffDraftAttempt>[3];
    try {
      const response = await fetch(input.url, { method: input.method, credentials: "same-origin", headers: { "Content-Type": "application/json", ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}), "X-Piccadilly-Draft-Session-Binding": ownerBinding }, body: stamp.payload });
      const body: unknown = await response.json();
      if ((response.status === 400 || response.status === 403) && object(body) &&
          (body.code === "DRAFT_SESSION_MISMATCH" || body.code === "DRAFT_SESSION_BINDING_INVALID")) {
        if (ownsAttempt()) { hideRegions(); erasePersonalState(); update({ notice: "Il server ha rifiutato il salvataggio: la sessione della richiesta non corrisponde alla bozza. Accedi nuovamente; nessun reinvio automatico." }); }
        return result;
      }
      if (response.status === 401 || response.status === 403) {
        const active = view.drafts.records[input.key];
        if (stamp.authEpoch === view.drafts.authEpoch && active?.phase === "PENDING" && active.instanceId === stamp.instanceId && active.resourceId === stamp.resourceId && active.baseVersion === stamp.baseVersion && active.attempt?.id === stamp.id) erasePersonalState();
        return result;
      }
      const valid = response.ok ? input.validate(body) : null;
      const message = object(body) && typeof body.error === "string" && body.error.trim() ? body.error : input.failureMessage ?? "Salvataggio non confermato. La bozza è conservata; verifica i dati e riprova.";
      outcome = valid
        ? { kind: "CONFIRMED", version: valid.version, receipt: { resourceId: valid.resourceId, originPath: current.originPath, text: valid.text, destinationPath: valid.destinationPath } }
        : { kind: response.status === 409 ? "DIRTY_CONFLICT" : "ERROR", error: response.status === 409 ? `Conflitto409. ${message} Rileggi i dati canonici e rivaluta la bozza senza sostituirla automaticamente.` : message };
    } catch { outcome = { kind: "ERROR", error: "Errore di rete. Esito incerto: la bozza e l’identità della richiesta sono conservate; nessun nuovo invio automatico." }; }
    // A response cannot restore access. Recheck a quarantined session before
    // applying any outcome, including errors, to the original frozen attempt.
    if (!sessionVisible() && !await verifySession()) {
      const record = view.drafts.records[input.key];
      if (stamp.authEpoch === view.drafts.authEpoch && record?.instanceId === stamp.instanceId && record.attempt?.id === stamp.id) deferred.set(input.key, { stamp, outcome });
      return result;
    }
    if (!matchesStaffDraftAttempt(view.drafts, input.key, stamp)) return result;
    draftUpdate(settleStaffDraftAttempt(view.drafts, input.key, stamp, outcome));
    const foreground = navigation === navigationGeneration && route === locationKey() && [...activeDrafts.values()].some(owner => owner.key === input.key && owner.navigation === navigationGeneration);
    if (outcome.kind === "CONFIRMED") {
      if (!foreground) { draftUpdate(discardStaffDraft(view.drafts, input.key)); update({ detachedReceipt: outcome.receipt }); if (current.kind === "PHONE") phoneLocalId = null; }
      resources.clear(); reads.clear(); for (const [key, generation] of readGenerations) readGenerations.set(key, generation + 1);
      update({ resourceGeneration: view.resourceGeneration + 1, notice: foreground ? null : "Un salvataggio già inviato è stato confermato. Puoi tornare esplicitamente alla relativa Agenda." });
      return { confirmed: true, foreground, receipt: outcome.receipt };
    }
    return { confirmed: false, foreground, receipt: null };
  }
  function synchronizeOverlay() {
    const overlay = view.overlay; if (!overlay) return;
    const { element, close } = overlay, previous = document.body.style.overflow;
    const changes: { node: HTMLElement; inert: boolean }[] = [];
    for (let node: HTMLElement | null = element; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) if (sibling !== node && sibling instanceof HTMLElement) { changes.push({ node: sibling, inert: sibling.inert }); sibling.inert = true; }
      if (node.parentElement === document.body) break;
    }
    document.body.style.overflow = "hidden";
    const selector = 'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
    const focusTarget = returnFocus; returnFocus = null;
    if (focusTarget?.isConnected && element.contains(focusTarget)) focusTarget.focus();
    else (element.querySelector<HTMLElement>(selector) ?? element).focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>(selector)].filter(node => !node.closest("[hidden], [inert]"));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); element.focus(); }
      else if (!element.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); document.body.style.overflow = previous; for (const change of changes) change.node.inert = change.inert; };
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view, getServerSnapshot: () => initial,
    verifySession, readResource, getResource, sessionVisible, routeChanged, requestExit, requestLogout, resolveExit, logout, mutate,
    destroyDocumentState, synchronizeOverlay, localId,
    documentNavigationStarted: () => { documentLeaving = true; },
    failBeforeAttempt: (key: string, error: string) => {
      const record = view.drafts.records[key];
      if (record && record.phase !== "PENDING" && sessionVisible()) draftUpdate({ ...view.drafts, records: { ...view.drafts.records, [key]: { ...record, phase: "ERROR", error } } });
    },
    quarantine: () => { hideRegions(); quarantine(); },
    registerRegion: (node: HTMLElement) => { sensitiveRegions.add(node); return () => { sensitiveRegions.delete(node); }; },
    setAgenda: (patch: Partial<VolatileAgendaState>) => update({ agenda: { ...view.agenda, ...patch } }),
    setNotice: (notice: string | null) => update({ notice }),
    prepareNavigation: () => { ++navigationGeneration; hideRegions(); quarantine(); },
    resumeFocus: () => { const target = returnFocus; returnFocus = null; return target; },
    claimOverlay: (owner: string, element: HTMLElement, close: () => void) => update({ overlay: { owner, element, close } }),
    releaseOverlay: (owner: string) => { if (view.overlay?.owner === owner) update({ overlay: null }); },
    activateDraft: (owner: string, key: string, resume = false) => {
      const current = activeDrafts.get(owner), record = view.drafts.records[key];
      const permit = resume || !record || !draftHasUnsavedChanges(record) || current?.key === key && current.navigation === navigationGeneration;
      const navigation = permit ? navigationGeneration : -1;
      if (current?.key !== key || current.navigation !== navigation) { activeDrafts.set(owner, { key, navigation }); update({}); }
    },
    canDisplayDraft: (owner: string, key: string) => sessionVisible() && activeDrafts.get(owner)?.key === key && activeDrafts.get(owner)?.navigation === navigationGeneration,
    resumeDraft: (owner: string, key: string) => { activeDrafts.set(owner, { key, navigation: navigationGeneration }); update({}); },
    releaseDraft: (owner: string) => { activeDrafts.delete(owner); },
    openPrivateNotes: (id: string) => update({ privateNotesSurface: id }),
    openRoomSurface: (owner: string) => { if (sessionVisible()) update({ roomSurface: owner }); },
    closeRoomSurface: (owner: string) => { if (view.roomSurface === owner) update({ roomSurface: null }); },
    invalidateRoomResource: (id: string) => {
      const key = "ASSIGNMENT:" + id;
      resources.delete(key); reads.delete(key);
      readGenerations.set(key, (readGenerations.get(key) ?? 0) + 1);
      update({ resourceGeneration: view.resourceGeneration + 1 });
    },
    closePrivateNotes: (id: string) => {
      const key = view.drafts.identity ? staffDraftKey(view.drafts.identity, "NI", id) : null;
      const record = key ? view.drafts.records[key] : null;
      if (record && !draftHasUnsavedChanges(record)) draftUpdate(discardStaffDraft(view.drafts, record.key));
      resources.delete("NI:" + id); reads.delete("NI:" + id);
      readGenerations.set("NI:" + id, (readGenerations.get("NI:" + id) ?? 0) + 1);
      if (view.privateNotesSurface === id) update({ privateNotesSurface: null });
    },
    phoneId: () => { phoneLocalId ??= localId(); return phoneLocalId; },
    initialize: (input: Parameters<typeof initializeStaffDraft>[1]) => { const next = initializeStaffDraft(view.drafts, input); if (next !== view.drafts) draftUpdate(next); },
    updateDraft: (key: string, values: StaffDraftValues) => draftUpdate(updateStaffDraft(view.drafts, key, values)),
    patchDraft: (key: string, patch: StaffDraftValues) => { const record = view.drafts.records[key]; if (record) draftUpdate(updateStaffDraft(view.drafts, key, { ...record.values, ...patch })); },
    discard: (key: string) => draftUpdate(discardStaffDraft(view.drafts, key)),
    review: (key: string, input: Parameters<typeof reviewStaffDraftBaseline>[2]) => draftUpdate(reviewStaffDraftBaseline(view.drafts, key, input)),
    get navigationGeneration() { return navigationGeneration; },
  };
}
export type StaffDraftController = ReturnType<typeof createStaffDraftController>;
const Context = createContext<StaffDraftController | null>(null);
export function useStaffDraftHost(): StaffDraftController {
  const controller = useContext(Context); if (!controller) throw new Error("Staff draft host is required."); return controller;
}
export function useStaffHostView(): StaffHostView {
  const controller = useStaffDraftHost(); return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
}
function RouteObserver({ controller }: { controller: StaffDraftController }) {
  const pathname = usePathname(), query = useSearchParams(), key = pathname + (query.size ? `?${query.toString()}` : "");
  useLayoutEffect(() => { controller.routeChanged(key); }, [controller, key]); return null;
}

export function StaffDraftHost({ children }: { children: ReactNode }) {
  const [controller] = useState(createStaffDraftController), router = useRouter();
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const pathname = usePathname();
  const lastIdentity = useRef<StaffDraftIdentity | null>(null);
  useEffect(() => {
    const identity = view.drafts.auth === "AUTHORIZED" ? view.drafts.identity : null;
    if (!identity) return;
    if (lastIdentity.current && !sameDraftSession(lastIdentity.current, identity)) router.refresh();
    lastIdentity.current = identity;
  }, [router, view.drafts.auth, view.drafts.identity]);
  useEffect(() => {
    function pagehide() { controller.destroyDocumentState(); }
    function foreground() { if (staffPath(locationKey())) { controller.quarantine(); void controller.verifySession(); } }
    function visibility() { if (document.visibilityState === "hidden") controller.quarantine(); else foreground(); }
    function popstate() { controller.quarantine(); }
    function beforeunload(event: BeforeUnloadEvent) { controller.documentNavigationStarted(); if (Object.values(controller.getSnapshot().drafts.records).some(draftHasUnsavedChanges)) { event.preventDefault(); event.returnValue = ""; } }
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("piccadilly-staff-auth") : null;
    if (channel) channel.onmessage = event => { if (event.data === "reauth-required" && staffPath(locationKey())) foreground(); };
    addEventListener("pagehide", pagehide); addEventListener("pageshow", foreground); addEventListener("focus", foreground);
    addEventListener("popstate", popstate); addEventListener("beforeunload", beforeunload); document.addEventListener("visibilitychange", visibility);
    return () => { channel?.close(); removeEventListener("pagehide", pagehide); removeEventListener("pageshow", foreground); removeEventListener("focus", foreground);
      removeEventListener("popstate", popstate); removeEventListener("beforeunload", beforeunload); document.removeEventListener("visibilitychange", visibility); };
  }, [controller]);
  useLayoutEffect(() => controller.synchronizeOverlay(), [controller, view.overlay]);
  const recoverable = staffPath(pathname) && view.drafts.auth === "AUTHORIZED" && controller.sessionVisible()
    ? Object.values(view.drafts.records).filter(draftHasUnsavedChanges) : [];
  return <Context.Provider value={controller}>
    <Suspense fallback={null}><RouteObserver controller={controller} /></Suspense>
    {staffPath(pathname) && view.notice ? <div className="border-b border-warning/30 bg-surface px-4 py-3 text-sm md:ml-[72px] lg:ml-[216px]" role="status">{view.notice}
      {view.drafts.auth === "DENIED" ? <Link href="/login" className="ml-3 inline-flex min-h-11 items-center underline">Accedi</Link> : null}
      {view.drafts.auth === "UNAVAILABLE" ? <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void controller.verifySession()}>Verifica di nuovo la sessione</button><button type="button" onClick={() => controller.requestLogout()}>Riprova logout</button></div> : null}</div> : null}
    {recoverable.length ? <aside aria-label="Bozze temporanee" className="border-b border-border bg-surface px-4 py-2 text-sm md:ml-[72px] lg:ml-[216px]">
      <p>Le bozze restano solo nella memoria di questa scheda, fino a scarto, conferma o fine sessione. Reload e chiusura possono perderle.</p>
      <div className="mt-1 flex flex-wrap gap-3">{recoverable.map(record => <button key={record.key} type="button" className="min-h-11 underline" onClick={() => controller.requestExit(() => { controller.prepareNavigation(); router.push(record.route); }, [])}>Torna al draft {record.kind}</button>)}</div>
    </aside> : null}
    {children}
    {controller.sessionVisible() && view.detachedReceipt ? <p className="px-4 py-2 text-sm md:ml-[72px] lg:ml-[216px]">Salvataggio precedente confermato. <Link href={view.detachedReceipt.originPath} onNavigate={event => { event.preventDefault(); controller.requestExit(() => { controller.prepareNavigation(); router.push(view.detachedReceipt!.originPath); }); }}>Apri l’Agenda relativa al salvataggio</Link></p> : null}
    {view.guard ? <StaffNavigationGuard key={view.guard.id} controller={controller} intent={view.guard} /> : null}
    {staffPath(pathname) && view.drafts.auth === "AUTHORIZED" ? Object.values(view.drafts.records).filter(record => record.receipt && record.phase === "CONFIRMED").map(record => <div className="px-4 py-2 text-sm md:ml-[72px] lg:ml-[216px]" key={record.key}>
      <span>Salvataggio confermato.</span> <Link href={record.receipt!.originPath} onNavigate={event => { event.preventDefault(); controller.requestExit(() => { controller.prepareNavigation(); router.push(record.receipt!.originPath); }); }}>Torna all’Agenda originaria</Link>
    </div>) : null}
  </Context.Provider>;
}

export function useStaffOverlay(open: boolean, owner: string, ref: RefObject<HTMLElement | null>, close: () => void) {
  const controller = useStaffDraftHost(), view = useStaffHostView(), callback = useRef(close);
  useLayoutEffect(() => { callback.current = close; });
  const suspended = view.guard !== null && owner !== "navigation-guard";
  useLayoutEffect(() => {
    if (!open || suspended || !ref.current) return;
    controller.claimOverlay(owner, ref.current, () => callback.current());
    return () => controller.releaseOverlay(owner);
  }, [controller, open, owner, ref, suspended]);
  return open && !suspended;
}
export function StaffSensitiveRegion({ children, allowed }: { children: ReactNode; allowed: boolean }) {
  const controller = useStaffDraftHost(), ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const region = ref.current; if (!region) return; return controller.registerRegion(region); }, [controller]);
  useLayoutEffect(() => { if (ref.current) { ref.current.hidden = !allowed; ref.current.inert = !allowed; } }, [allowed]);
  return <div ref={ref} data-staff-sensitive hidden={!allowed} inert={!allowed}>{allowed ? children : null}</div>;
}
type ReloadStatus = "CURRENT_CANONICAL_SNAPSHOT" | "RELOAD_IN_PROGRESS" | "RELOAD_FAILED" | "RELOADED_SNAPSHOT_CONFIRMED";
interface StaffResourceResult<T> { data: T | null; error: string | null; reload: () => Promise<boolean>; reloadStatus: ReloadStatus; ready: boolean; auth: StaffDraftState["auth"] }
export function useStaffResource(kind: "STAFF", id: string, active?: boolean): StaffResourceResult<StaffReservationDto>;
export function useStaffResource(kind: "NI", id: string, active?: boolean): StaffResourceResult<ReservationPrivateNotesContext>;
export function useStaffResource(kind: "ASSIGNMENT", id: string, active?: boolean): StaffResourceResult<ReservationAssignmentContextDto>;
export function useStaffResource(kind: ResourceKind, id: string, active = true) {
  const controller = useStaffDraftHost(), view = useStaffHostView(), [error, setError] = useState<string | null>(null);
  const resourceKey = JSON.stringify([kind, id, view.drafts.authEpoch, view.drafts.leaseEpoch, view.resourceGeneration]);
  const currentResource = useRef<string | null>(resourceKey), reloadSequence = useRef(0);
  const [reloadState, setReloadState] = useState<{ key: string; status: ReloadStatus; data: ResourceData | null } | null>(null);
  useLayoutEffect(() => { currentResource.current = resourceKey; return () => { currentResource.current = null; ++reloadSequence.current; }; }, [resourceKey]);
  useEffect(() => {
    if (!active || view.drafts.auth === "CHECKING" || view.drafts.auth === "UNAVAILABLE" || view.drafts.auth === "DENIED" || controller.getResource(kind, id)) return;
    let cancelled = false;
    void controller.readResource(kind, id).catch(error => { if (!cancelled) setError(error instanceof StaffResourceError ? error.message : "Lettura non disponibile."); });
    return () => { cancelled = true; };
  }, [active, controller, id, kind, view.drafts.auth, view.drafts.leaseEpoch, view.resourceGeneration]);
  const data = active && controller.sessionVisible() ? controller.getResource(kind, id) : null;
  async function reload() {
    const key = resourceKey, sequence = ++reloadSequence.current;
    setError(null); setReloadState({ key, status: "RELOAD_IN_PROGRESS", data: null });
    try {
      const confirmed = await controller.readResource(kind, id, true);
      if (key !== currentResource.current || sequence !== reloadSequence.current) return false;
      setReloadState({ key, status: confirmed ? "RELOADED_SNAPSHOT_CONFIRMED" : "RELOAD_FAILED", data: confirmed });
      if (!confirmed) setError("Rilettura non confermata. La bozza e la versione base restano invariate.");
      return confirmed !== null;
    } catch (error) {
      if (key === currentResource.current && sequence === reloadSequence.current) { setError(error instanceof StaffResourceError ? error.message : "Lettura non disponibile."); setReloadState({ key, status: "RELOAD_FAILED", data: null }); }
      return false;
    }
  }
  const reloadStatus: ReloadStatus = reloadState?.key === resourceKey && (reloadState.status !== "RELOADED_SNAPSHOT_CONFIRMED" || reloadState.data === data) ? reloadState.status : "CURRENT_CANONICAL_SNAPSHOT";
  return { data, error, reload, reloadStatus, ready: data !== null, auth: view.drafts.auth };
}
export function useStaffDraftBinding(input: {
  kind: StaffDraftKind; resourceId: string; values: StaffDraftValues; version: number | null; route: string; originPath: string; allowed: boolean;
}) {
  const controller = useStaffDraftHost(), view = useStaffHostView();
  const key = view.drafts.identity ? staffDraftKey(view.drafts.identity, input.kind, input.resourceId) : null;
  // There is one editor per logical draft. Its owner survives authorization
  // masking/unmount while a fresh proof and resource read finish.
  const owner = key ?? JSON.stringify([input.kind, input.resourceId]);
  useLayoutEffect(() => {
    if (!input.allowed || !key) return;
    controller.initialize({ kind: input.kind, resourceId: input.resourceId, instanceId: controller.localId(), route: input.route,
      originPath: input.originPath, values: input.values, baseVersion: input.version });
  }, [controller, input.allowed, input.kind, input.resourceId, input.route, input.originPath, input.values, input.version, key]);
  useLayoutEffect(() => {
    if (!input.allowed || !key) return;
    controller.activateDraft(owner, key); return () => controller.releaseDraft(owner);
  }, [controller, input.allowed, key, owner]);
  const record: StaffDraftRecord | null = input.allowed && key && controller.canDisplayDraft(owner, key) ? view.drafts.records[key] ?? null : null;
  const resumeRequired = input.allowed && key !== null && view.drafts.records[key] !== undefined && record === null;
  async function resume() {
    if (!key || !await controller.verifySession()) return;
    if (input.kind !== "PHONE" && !await controller.readResource(input.kind === "ROOM" ? "ASSIGNMENT" : input.kind === "NI" ? "NI" : "STAFF", input.resourceId, true)) return;
    if (controller.getSnapshot().drafts.records[key]) controller.resumeDraft(owner, key);
  }
  return { key, record, resumeRequired, resume, pending: record?.phase === "PENDING", update: (values: StaffDraftValues) => { if (key) controller.updateDraft(key, values); }, patch: (values: StaffDraftValues) => { if (key) controller.patchDraft(key, values); }, controller };
}
