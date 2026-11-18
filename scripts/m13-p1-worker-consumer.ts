import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isIPv4 } from "node:net";
import { isLinuxOwnedDatabaseTarget, receiveLinuxDatabaseBinding } from "./m13-p1-worker-linux-entry.mjs";

import type { NotificationWorkerDependencies } from "@/modules/notifications/application/worker";
import type { NotificationProvider, NotificationWorkerEvent } from "@/modules/notifications/application/ports";
import type { NotificationPayloadV1 } from "@/modules/notifications/domain/types";
import type { Prisma } from "@/generated/prisma/client";

import { WorkerRunError, createWorkerPeer, assertWorkerIdentity } from "./m13-p1-worker-runtime.mjs";

export const SCENARIOS = ["concurrent", "row-lock", "retry", "crash"] as const;
type Scenario = (typeof SCENARIOS)[number];
type JsonRecord = Record<string, unknown>;
type Transport = {
  send: (value: unknown) => void;
  subscribe: (listener: (value: unknown) => void) => () => void;
  disconnected: (listener: () => void) => () => void;
};
function requireWorker(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WorkerRunError(code);
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function validateConsumerEnvironment(environment: NodeJS.ProcessEnv, linuxTarget?: Record<string, unknown>) {
  for (const key of Object.keys(environment)) {
    requireWorker(!/^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|RENDER.*|DOTENV_CONFIG_.*|PGOPTIONS|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)$/iu.test(key), "P1C_ENVIRONMENT_REJECTED");
  }
  requireWorker(environment.APP_ENV === "development", "P1C_ENVIRONMENT_REJECTED");
  requireWorker(["A", "B"].includes(environment.P1C_SLOT ?? ""), "P1C_SLOT_INVALID");
  for (const key of ["P1C_RUN_ID", "P1C_GENERATION", "P1C_NONCE"]) {
    requireWorker(/^[a-f0-9-]{36}$/u.test(environment[key] ?? ""), "P1C_CORRELATION_INVALID");
  }
  const url = new URL(environment.DATABASE_URL ?? "invalid:");
  if (linuxTarget) {
    requireWorker(isLinuxOwnedDatabaseTarget(linuxTarget) && linuxTarget.runId === environment.P1C_RUN_ID
      && linuxTarget.generation === environment.P1C_GENERATION && linuxTarget.slot === environment.P1C_SLOT
      && typeof linuxTarget.serverAddress === "string" && isIPv4(linuxTarget.serverAddress)
      && !linuxTarget.serverAddress.startsWith("127.") && url.hostname === linuxTarget.serverAddress && url.port === "5432"
      && url.pathname === "/" + linuxTarget.database && url.username === linuxTarget.role, "P1C_DATABASE_TARGET_REJECTED");
  }
  requireWorker(url.protocol === "postgresql:" && (linuxTarget ? url.hostname === linuxTarget.serverAddress : url.hostname === "127.0.0.1")
    && /^\/piccadilly_e2e_[a-f0-9]{32}$/u.test(url.pathname)
    && /^m13_p1_[a-f0-9]{16}$/u.test(url.username) && Boolean(url.password)
    && Boolean(url.port) && !url.search && !url.hash, "P1C_DATABASE_TARGET_REJECTED");
  requireWorker(/^m13-p1c-[a-f0-9]{12}-[AB]$/u.test(environment.PGAPPNAME ?? ""), "P1C_APPNAME_INVALID");
  return { runId: environment.P1C_RUN_ID!, generation: environment.P1C_GENERATION!,
    slot: environment.P1C_SLOT!, nonce: environment.P1C_NONCE! };
}

async function loadWorkerModules() {
  const [cli, composition, providers, db, policy] = await Promise.all([
    import("@/modules/notifications/infrastructure/worker-cli"),
    import("@/modules/notifications/infrastructure/notification-composition"),
    import("@/modules/notifications/infrastructure/simulated-providers"),
    import("@/server/db/prisma"),
    import("@/modules/notifications/domain/delivery-policy"),
  ]);
  return { cli, composition, providers, db, policy };
}

export async function runWorkerConsumer(input: {
  environment?: NodeJS.ProcessEnv;
  transport?: Transport;
  load?: typeof loadWorkerModules;
} = {}) {
  const environment = input.environment ?? process.env;
  const linuxTarget = !input.transport && process.platform === "linux" ? await receiveLinuxDatabaseBinding() as Record<string, unknown> : undefined;
  const correlation = validateConsumerEnvironment(environment, linuxTarget);
  requireWorker(!(await readdir(process.cwd())).some(name => (name.startsWith(".env") && name !== ".env.example") || name === ".npmrc"), "P1C_CWD_NOT_CLEAN");
  const transport = input.transport ?? {
    send(value: unknown) { requireWorker(process.connected, "P1C_IPC_DISCONNECTED"); process.send!(value); },
    subscribe(listener: (value: unknown) => void) { process.on("message", listener); return () => process.off("message", listener); },
    disconnected(listener: () => void) { process.on("disconnect", listener); return () => process.off("disconnect", listener); },
  };
  const peer = createWorkerPeer(correlation, transport.send);
  const controller = new AbortController();
  const pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void }>();
  const stops = new Set<() => void>();
  let nextId = 0, modules: Awaited<ReturnType<typeof loadWorkerModules>> | undefined;
  let started = false, stopping = false, busy = false, failed = false, receiptGate = false, work: Promise<void> | undefined;
  const scenarios = new Map<string, Scenario>();
  const removed: Array<() => void> = [];
  const stop = () => {
    if (stopping) return;
    stopping = true; controller.abort(new WorkerRunError("P1C_CONSUMER_ABORT"));
    peer.send("EVENT", { event: "abort-observed" });
    for (const callback of stops) callback();
    for (const wait of pending.values()) wait.reject(new WorkerRunError("P1C_CONSUMER_ABORT"));
    pending.clear();
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    try { peer.send("ERROR", { code: "P1C_CONSUMER_FAILED" }); } catch { /* Disconnected IPC is already a failure. */ }
    stop();
  };
  const assertActive = () => { requireWorker(!controller.signal.aborted && !stopping, "P1C_CONSUMER_ABORT"); };
  const gate = (point: string, details: JsonRecord = {}) => {
    assertActive(); const id = ++nextId;
    const result = new Promise<JsonRecord>((resolve, reject) => pending.set(id, { resolve, reject }));
    peer.send("REQUEST", { id, point, ...details }); return result;
  };
  const event = (value: JsonRecord) => { assertActive(); peer.send("EVENT", value); };

  async function fixture(scenario: Scenario) {
    requireWorker(modules && correlation.slot === "A", "P1C_FIXTURE_FORBIDDEN");
    assertActive();
    const { prisma } = modules.db;
    const now = new Date();
    const restaurant = await prisma.restaurant.findFirst({ where: { name: "M13 P1-C Demo" }, select: { id: true } });
    const restaurantId = restaurant?.id ?? (await prisma.restaurant.create({
      data: { name: "M13 P1-C Demo", timezone: "Europe/Rome" }, select: { id: true },
    })).id;
    const ids: string[] = [], channels: string[] = [];
    const count = scenario === "concurrent" ? 12 : scenario === "row-lock" ? 3 : scenario === "retry" ? 2 : 1;
    for (let index = 0; index < count; index++) {
      assertActive();
      const channel = scenario === "retry" || scenario === "crash" || index % 2 === 0 ? "WHATSAPP" : "EMAIL";
      const reservation = await prisma.reservation.create({ data: {
        restaurantId, localDate: new Date("2028-08-21"), serviceType: "DINNER",
        arrivalTime: new Date("1970-01-01T20:00:00Z"), partySize: 2, status: "CONFIRMED", origin: "PHONE",
        customerFirstName: "M13-P1C-FIRST", customerLastName: "M13-P1C-LAST",
        customerPhone: "+390000000000", customerEmail: "m13-p1c@example.test",
        privacyPolicyVersion: "m13-p1c-synthetic", privacyConsentAt: now, privacyConsentMethod: "VERBAL",
      } });
      const payload: NotificationPayloadV1 = { schemaVersion: 1, templateKey: "RESERVATION_CONFIRMED",
        templateVersion: 1, locale: "IT", params: { customerFirstName: "M13-P1C-FIRST", restaurantName: "M13 P1-C Demo",
          localDate: "2028-08-21", serviceType: "DINNER", arrivalTime: "20:00", partySize: 2 } };
      const row = await prisma.notificationOutbox.create({ data: {
        restaurantId, reservationId: reservation.id, reservationVersion: 1, eventGroupId: randomUUID(),
        eventType: "RESERVATION_CONFIRMED", source: "PHONE", actorUserId: null, channel,
        strategy: "WHATSAPP_ONLY", destination: channel === "WHATSAPP" ? "+390000000000" : "m13-p1c@example.test",
        payload: payload as unknown as Prisma.InputJsonValue, payloadVersion: 1, scheduledAt: new Date(now.getTime() - 1000), availableAt: new Date(now.getTime() - 1000),
        expiresAt: new Date(now.getTime() + 3600_000), maxAttempts: 4, retryPolicyVersion: 1,
        idempotencyKey: modules.policy.notificationIdempotencyKey({ restaurantId, reservationId: reservation.id,
          reservationVersion: 1, eventType: "RESERVATION_CONFIRMED", channel }), originCorrelationId: randomUUID(),
      }, select: { id: true } });
      ids.push(row.id); channels.push(channel);
    }
    return { scenario, restaurantId, ids, channels };
  }

  const execute = async () => {
    requireWorker(modules, "P1C_NOT_INITIALIZED");
    const loaded = modules;
    const deps = loaded.composition.createNotificationWorkerDependencies();
    const real = deps.repository;
    const ensure = () => assertActive();
    const repository: NotificationWorkerDependencies["repository"] = {
      async expirePending(value) { await gate("batch"); ensure(); return real.expirePending(value); },
      async recoverExpiredLeases(value) { ensure(); const n = await real.recoverExpiredLeases(value);
        if (n) event({ event: "recovered", count: n }); return n; },
      async claimDue(value) {
        await gate("claim"); ensure();
        const rows = await real.claimDue(value);
        await gate("claimed", { rows: rows.map(row => ({ id: row.id, lease: digest(row.leaseToken) })) });
        ensure(); return rows;
      },
      async startAttempt(value) { ensure(); const attempt = await real.startAttempt(value);
        if (attempt) event({ event: "attempt-started", id: value.notification.id }); return attempt; },
      async confirmProviderCall(value) { ensure(); return real.confirmProviderCall(value); },
      async finalizeAttempt(value) { ensure(); const outcome = await real.finalizeAttempt(value);
        event({ event: "finalized", id: value.attempt.notification.id, outcome }); return outcome; },
    };
    const timeoutProvider = new loaded.providers.SimulatedWhatsAppProvider({ type: "TIMEOUT_AFTER_RECEIPT" });
    const permanentProvider = new loaded.providers.SimulatedWhatsAppProvider({ type: "PERMANENT" });
    const provider = (base: NotificationProvider): NotificationProvider => ({
      async send(request, options) {
        ensure(); const scenario = scenarios.get(request.context.outboxId);
        event({ event: "provider-start", id: request.context.outboxId });
        const selected = scenario === "retry" && request.context.outboxId === [...scenarios].find(([, s]) => s === "retry")?.[0]
          ? timeoutProvider : scenario === "retry" ? permanentProvider : base;
        const result = await selected.send(request, options);
        ensure();
        if (result.type === "SUCCESS") event({ event: "receipt-observed", id: request.context.outboxId, reference: result.providerReference, payloadHash: loaded.policy.notificationPayloadHash(request.message), deduplicated: result.deduplicated });
        if (scenario === "crash" && correlation.slot === "A") {
          receiptGate = true;
          try { await gate("receipt", { outboxId: request.context.outboxId }); }
          finally { receiptGate = false; }
        }
        ensure(); return result;
      },
    });
    const emitRuntime = (value: NotificationWorkerEvent) => {
      // Only fixed classes/counts cross IPC; raw errors and payloads never do.
      if (value.event === "notification_worker_runtime_failure" || value.event === "notification_worker_item_failure") {
        peer.send("EVENT", { event: "runtime-failure", code: value.code });
      }
    };
    const runtime = loaded.composition.createNotificationWorkerDependencies().runtime!;
    const code = await loaded.cli.runNotificationWorkerCli({
      args: [], createDependencies: () => ({ ...deps, repository,
        whatsappProvider: provider(deps.whatsappProvider), emailProvider: provider(deps.emailProvider) }),
      runtime: { ...runtime, emit: emitRuntime },
      addSignalListener(signal, callback) { stops.add(callback); process.once(signal, callback); },
      removeSignalListener(signal, callback) { stops.delete(callback); process.off(signal, callback); },
      disconnect: () => loaded.db.prisma.$disconnect(),
      writeResult: () => { throw new WorkerRunError("P1C_UNEXPECTED_ONE_SHOT"); },
    });
    requireWorker(code === 0 && stopping && !failed, "P1C_WORKER_EXIT_FAILED");
  };

  removed.push(transport.disconnected(() => { failed = true; stop(); }));
  removed.push(transport.subscribe(value => {
    void (async () => {
      const packet = peer.receive(value), data = packet.data as JsonRecord;
      if (packet.type === "REPLY") {
        const wait = pending.get(data.id as number);
        requireWorker(wait, "P1C_UNEXPECTED_REPLY");
        pending.delete(data.id as number); wait.resolve(data); return;
      }
      if (packet.type === "STOP") { stop(); return; }
      if (packet.type === "INTERRUPT") {
        requireWorker(linuxTarget && isLinuxOwnedDatabaseTarget(linuxTarget) && correlation.slot === "A" && receiptGate && started && !stopping, "P1C_CRASH_BARRIER_INVALID");
        // Controlled C05 fault: only this owned consumer exits. The supervisor,
        // init and the second original consumer remain available for recovery.
        process.exit(86);
      }
      assertActive();
      if (packet.type === "INIT") {
        requireWorker(!modules && !busy, "P1C_DUPLICATE_INIT"); busy = true;
        modules = await (input.load ?? loadWorkerModules)();
        assertActive();
        const rows = await modules.db.prisma.$queryRaw<Array<{ identity: JsonRecord }>>`
          SELECT json_build_object('database',current_database(),'role',current_user,
          'version',current_setting('server_version'),'dataDirectory',current_setting('data_directory'),
          'systemIdentifier',(pg_control_system()).system_identifier::text,
          'postmasterStart',pg_postmaster_start_time()::text,'serverAddress',inet_server_addr()::text,
          'clientAddress',inet_client_addr()::text,'serverPort',inet_server_port()) AS identity
        `;
        requireWorker(rows.length === 1, "P1C_IDENTITY_INCOMPLETE");
        assertWorkerIdentity(data.identity, rows[0].identity);
        busy = false; peer.send("READY", { identity: rows[0].identity }); return;
      }
      requireWorker(modules && !busy, "P1C_COMMAND_STATE");
      if (packet.type === "FIXTURE") {
        requireWorker(SCENARIOS.includes(data.scenario as Scenario), "P1C_SCENARIO_REJECTED");
        busy = true; const result = await fixture(data.scenario as Scenario);
        busy = false; peer.send("FIXTURE_DONE", result); return;
      }
      if (packet.type === "CONFIGURE") {
        requireWorker(SCENARIOS.includes(data.scenario as Scenario) && Array.isArray(data.ids), "P1C_SCENARIO_REJECTED");
        for (const id of data.ids) { requireWorker(typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id) && !scenarios.has(id), "P1C_FIXTURE_ID_REJECTED"); scenarios.set(id, data.scenario as Scenario); }
        peer.send("CONFIGURED", { scenario: data.scenario }); return;
      }
      requireWorker(packet.type === "START" && !started, "P1C_COMMAND_REJECTED");
      started = true; work = execute(); work.catch(fail);
    })().catch(() => { busy = false; fail(); });
  }));
  peer.send("HELLO", { pid: process.pid, node: process.versions.node, execPath: process.execPath });
  try {
    while (!work && (!stopping || busy)) await new Promise(resolve => setTimeout(resolve, 10));
    if (work) await work;
    while (busy) await new Promise(resolve => setTimeout(resolve, 10));
    requireWorker(stopping && !failed, "P1C_PREMATURE_STOP");
    await modules?.db.prisma.$disconnect();
    peer.send("STOPPED", { exitCode: 0, databaseClosed: true, aborted: controller.signal.aborted });
    return 0;
  } catch {
    failed = true; stop();
    await modules?.db.prisma.$disconnect();
    return 1;
  } finally {
    for (const callback of stops) { process.off("SIGINT", callback); process.off("SIGTERM", callback); }
    stops.clear();
    for (const remove of removed) remove();
    if (!input.transport && process.connected) process.disconnect();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runWorkerConsumer().then(code => { process.exitCode = code; }).catch(() => {
    // No message, stack, cause or environment values escape the process.
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}

