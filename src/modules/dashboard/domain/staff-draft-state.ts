export type StaffDraftKind = "PHONE" | "EDIT" | "NI";
export type StaffDraftPhase = "CLEAN" | "DIRTY" | "PENDING" | "DIRTY_CONFLICT" | "ERROR" | "CONFIRMED";
export type StaffDraftValues = Readonly<Record<string, string | number | boolean | null>>;
export interface StaffDraftIdentity { actorId: string; tenantId: string; sessionBinding: string; role: "STAFF" | "ADMIN" }
export interface StaffDraftReceipt { resourceId: string; originPath: string; destinationPath?: string; text: string }
export interface StaffDraftAttempt {
  id: string;
  authEpoch: number;
  instanceId: string;
  resourceId: string;
  baseVersion: number | null;
  values: StaffDraftValues;
  payload: string;
  idempotencyKey: string | null;
  routeLease: number;
}
export interface StaffDraftRecord {
  key: string;
  instanceId: string;
  kind: StaffDraftKind;
  resourceId: string;
  route: string;
  originPath: string;
  phase: StaffDraftPhase;
  values: StaffDraftValues;
  baseline: StaffDraftValues;
  baseVersion: number | null;
  attempt: StaffDraftAttempt | null;
  retryIdentity: { signature: string; key: string } | null;
  error: string | null;
  receipt: StaffDraftReceipt | null;
}
export interface StaffDraftState {
  identity: StaffDraftIdentity | null;
  auth: "UNKNOWN" | "CHECKING" | "AUTHORIZED" | "DENIED" | "UNAVAILABLE";
  authEpoch: number;
  leaseEpoch: number;
  records: Readonly<Record<string, StaffDraftRecord>>;
}
export function createStaffDraftState(): StaffDraftState {
  return { identity: null, auth: "UNKNOWN", authEpoch: 0, leaseEpoch: 0, records: {} };
}
export function sameDraftSession(a: StaffDraftIdentity | null, b: StaffDraftIdentity): boolean {
  return a !== null && a.actorId === b.actorId && a.tenantId === b.tenantId && a.sessionBinding === b.sessionBinding && a.role === b.role;
}
export function staffDraftKey(identity: StaffDraftIdentity, kind: StaffDraftKind, resourceId: string): string {
  return JSON.stringify([identity.tenantId, identity.actorId, identity.sessionBinding, kind, resourceId]);
}
export function quarantineStaffDrafts(state: StaffDraftState): StaffDraftState {
  // The display lease expires on navigation. An attempt still belongs to its
  // session epoch until live revalidation proves that session changed or ended.
  return { ...state, auth: "CHECKING", leaseEpoch: state.leaseEpoch + 1 };
}
export function invalidateStaffDrafts(state: StaffDraftState): StaffDraftState {
  return { ...createStaffDraftState(), auth: "DENIED", authEpoch: state.authEpoch + 1, leaseEpoch: state.leaseEpoch + 1 };
}
export function authorizeStaffDrafts(state: StaffDraftState, identity: StaffDraftIdentity): StaffDraftState {
  const unchanged = sameDraftSession(state.identity, identity);
  return { ...state, identity, auth: "AUTHORIZED", authEpoch: unchanged ? state.authEpoch : state.authEpoch + 1,
    records: unchanged ? state.records : {}, leaseEpoch: unchanged && state.identity?.role === identity.role ? state.leaseEpoch : state.leaseEpoch + 1 };
}
export function draftHasUnsavedChanges(record: StaffDraftRecord): boolean {
  return record.phase === "PENDING" || record.phase === "DIRTY_CONFLICT" || record.phase === "ERROR" ||
    Object.keys({ ...record.baseline, ...record.values }).some(key => record.values[key] !== record.baseline[key]);
}
function withRecord(state: StaffDraftState, record: StaffDraftRecord): StaffDraftState {
  return { ...state, records: { ...state.records, [record.key]: record } };
}
export function initializeStaffDraft(state: StaffDraftState, input: {
  kind: StaffDraftKind; resourceId: string; instanceId: string; route: string; originPath: string;
  values: StaffDraftValues; baseVersion: number | null;
}): StaffDraftState {
  if (!state.identity || state.auth !== "AUTHORIZED") return state;
  const key = staffDraftKey(state.identity, input.kind, input.resourceId);
  if (state.records[key]) return state;
  const values = Object.freeze({ ...input.values });
  return withRecord(state, { ...input, key, phase: "CLEAN", values, baseline: values,
    attempt: null, retryIdentity: null, error: null, receipt: null });
}
export function updateStaffDraft(state: StaffDraftState, key: string, values: StaffDraftValues): StaffDraftState {
  const record = state.records[key];
  if (!record || record.phase === "PENDING" || state.auth !== "AUTHORIZED") return state;
  const next = { ...record, values: Object.freeze({ ...values }), error: null, receipt: null };
  return withRecord(state, { ...next, phase: draftHasUnsavedChanges({ ...next, phase: "CLEAN" }) ? "DIRTY" : "CLEAN" });
}
export function discardStaffDraft(state: StaffDraftState, key: string): StaffDraftState {
  if (!state.records[key] || state.records[key].phase === "PENDING") return state;
  const records = { ...state.records }; delete records[key];
  return { ...state, records };
}
export function beginStaffDraftAttempt(state: StaffDraftState, key: string, input: {
  id: string; payload: string; idempotencyKey?: string | null;
}): StaffDraftState {
  const record = state.records[key];
  if (!record || record.phase === "PENDING" || state.auth !== "AUTHORIZED") return state;
  const attempt: StaffDraftAttempt = Object.freeze({ ...input, authEpoch: state.authEpoch,
    instanceId: record.instanceId, resourceId: record.resourceId, baseVersion: record.baseVersion,
    values: Object.freeze({ ...record.values }), idempotencyKey: input.idempotencyKey ?? null, routeLease: state.leaseEpoch });
  return withRecord(state, { ...record, phase: "PENDING", attempt, error: null, receipt: null,
    retryIdentity: input.idempotencyKey ? { signature: input.payload, key: input.idempotencyKey } : record.retryIdentity });
}
export function matchesStaffDraftAttempt(state: StaffDraftState, key: string, stamp: StaffDraftAttempt): boolean {
  return state.auth === "AUTHORIZED" && ownsStaffDraftAttempt(state, key, stamp);
}
export function ownsStaffDraftAttempt(state: StaffDraftState, key: string, stamp: StaffDraftAttempt): boolean {
  const record = state.records[key];
  return stamp.authEpoch === state.authEpoch && record?.phase === "PENDING" &&
    record.instanceId === stamp.instanceId && record.resourceId === stamp.resourceId &&
    record.baseVersion === stamp.baseVersion && record.attempt?.id === stamp.id && record.attempt.instanceId === stamp.instanceId;
}
export function rejectStaffDraftDispatch(state: StaffDraftState, key: string, stamp: StaffDraftAttempt): StaffDraftState {
  if (!ownsStaffDraftAttempt(state, key, stamp)) return state;
  return withRecord(state, { ...state.records[key], phase: "ERROR", attempt: null,
    error: "Invio non effettuato. Verifica la sessione e rivaluta la bozza prima di un nuovo tentativo." });
}
export function settleStaffDraftAttempt(state: StaffDraftState, key: string, stamp: StaffDraftAttempt, result:
  | { kind: "CONFIRMED"; version: number | null; receipt: StaffDraftReceipt }
  | { kind: "ERROR" | "DIRTY_CONFLICT"; error: string },
): StaffDraftState {
  if (!matchesStaffDraftAttempt(state, key, stamp)) return state;
  const record = state.records[key];
  return withRecord(state, result.kind === "CONFIRMED"
    ? { ...record, phase: "CONFIRMED", values: stamp.values, baseline: stamp.values, baseVersion: result.version,
      attempt: null, retryIdentity: null, error: null, receipt: result.receipt }
    : { ...record, phase: result.kind, attempt: null, error: result.error });
}
export function reviewStaffDraftBaseline(state: StaffDraftState, key: string, input: {
  version: number; serverValues: StaffDraftValues; selectedFields: readonly string[];
}): StaffDraftState {
  const record = state.records[key];
  if (!record || record.phase === "PENDING" || state.auth !== "AUTHORIZED") return state;
  const values = { ...input.serverValues };
  for (const field of input.selectedFields) if (Object.hasOwn(record.values, field)) values[field] = record.values[field];
  const next = { ...record, baseline: Object.freeze({ ...input.serverValues }), values: Object.freeze(values),
    baseVersion: input.version, attempt: null, error: null, receipt: null, phase: "CLEAN" as const };
  return withRecord(state, { ...next, phase: draftHasUnsavedChanges(next) ? "DIRTY" : "CLEAN" });
}
