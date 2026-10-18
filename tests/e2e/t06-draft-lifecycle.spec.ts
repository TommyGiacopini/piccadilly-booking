import { expect, test, chromium, type Page } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { e2eAdminUsername, e2eStaffUsername, e2eReservationFirstName, e2eRestaurantId, e2eRunId } from "./e2e-run";

const origin = "http://localhost:4000", date = "2099-12-18";
const target = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T06B_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: target.href }), owned: string[] = [];
const extraTenants: string[] = [];
async function login(page: Page) {
  await page.goto("/login"); await page.getByLabel("Username").fill(e2eAdminUsername); await page.getByLabel("Password").fill(process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "");
  await page.getByRole("button", { name: "Accedi" }).click(); await expect(page).toHaveURL(/\/dashboard/u);
}
async function create(page: Page) {
  const response = await page.request.post("/api/staff/reservations", { headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: {
    localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 2, childrenCount: 0, gameRoomPreference: null,
    customerFirstName: e2eReservationFirstName, customerLastName: "T06B Draft " + e2eRunId, customerPhone: "+390000000618", customerEmail: null,
    highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false,
    notes: "T06B_CANONICAL_NC", verbalConsentConfirmed: true, sendWhatsAppConfirmation: false, capacityOverride: false, capacityOverrideReason: null,
  } }); expect(response.status(), await response.text()).toBe(201);
  const row = (await response.json()).reservation as {id:string;version:number}; owned.push(row.id); return row;
}
async function keep(page: Page) { await page.getByRole("dialog", { name: "Modifiche non salvate" }).getByRole("button", { name: "Esci conservando la bozza" }).click(); }
async function resume(page: Page, kind: string) { await page.getByRole("button", { name: kind === "NI" ? "Continua modifica NI" : "Continua modifica", exact: true }).click(); }
async function phone(page: Page) {
  await page.goto("/dashboard/reservations/new?date=" + date);
  await page.getByLabel("Nome", { exact: true }).fill(e2eReservationFirstName);
  await page.getByLabel("Cognome", { exact: true }).fill("T06B DraftPhone " + e2eRunId);
  await page.getByLabel("Telefono", { exact: true }).fill("+390000000618");
  await page.getByLabel("Slot configurato").selectOption("19:00"); await page.getByLabel(/Confermo di avere acquisito verbalmente/u).check();
}
async function sessionSwitch(page: Page, staff = false) {
  const previousPath = page.url();
  const prior = await (await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: crypto.randomUUID() } })).json();
  const response = await page.request.post("/api/auth/login", { headers: { origin }, form: { username: staff ? e2eStaffUsername : e2eAdminUsername, password: (staff ? process.env.AUTH_DEMO_STAFF_PASSWORD : process.env.AUTH_DEMO_ADMIN_PASSWORD) ?? "", returnTo: "/dashboard" }, maxRedirects: 0 });
  expect(response.status()).toBe(303);
  // Headless bringToFront does not reliably emit focus/visibility. Use a real
  // SPA departure/return and require a fresh HTTP proof of the changed session.
  const proof = page.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/draft-context" && value.request().method() === "POST");
  await page.getByRole("link", { name: "Agenda", exact: true }).click(); await keep(page);
  const checked = await proof; expect(checked.status()).toBe(200);
  const next = await checked.json(); expect(next.sessionBinding !== prior.sessionBinding).toBe(true);
  expect(next.role).toBe(staff ? "STAFF" : "ADMIN");
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goBack(); await expect(page).toHaveURL(previousPath);
}
test.afterEach(async () => { for (const id of owned.splice(0)) await database.query("UPDATE reservations SET status='CANCELLED',cancelled_at=now() WHERE id=$1 AND restaurant_id=$2 AND status='CONFIRMED'", [id, e2eRestaurantId]); });
test.afterAll(async () => database.end());

test("F04 NI delayed/failed reload keeps draft and base; current successful snapshot requires explicit adoption", async ({ page }, info) => {
  await login(page); const item = await create(page); await page.goto("/dashboard/reservations/" + item.id);
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true }); await field.fill("F04_LOCAL_DRAFT");
  expect((await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "F04_SERVER_WINNER" } })).status()).toBe(200);
  let release: () => void = () => undefined, reached: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { reached = resolve; });
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", async route => { if (route.request().method() !== "GET") return route.continue(); reached(); await gate; await route.fulfill({ status: 500, json: { error: "ARTIFICIAL_READ_FAILURE" } }); });
  await page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }).click(); await reading;
  const adopt = page.getByRole("button", { name: "Adotta la nota canonica dopo conferma" }), reapply = page.getByRole("button", { name: "Riapplica la mia bozza sulla versione riletta" });
  await expect(page.getByText("Rilettura NI in corso.", { exact: false })).toBeVisible(); await expect(adopt).toBeDisabled(); await expect(reapply).toBeDisabled();
  await expect(field).toHaveValue("F04_LOCAL_DRAFT"); await expect(page.getByText(/^Nota canonica riletta:/u)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("f04-reload-pending.png") }); release();
  await expect(page.locator('[data-reload-status="RELOAD_FAILED"]')).toBeVisible(); await expect(adopt).toBeDisabled(); await expect(reapply).toBeDisabled(); await expect(field).toHaveValue("F04_LOCAL_DRAFT");
  await page.unroute("**/api/staff/reservations/" + item.id + "/private-notes");
  await page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }).click(); await expect(adopt).toBeEnabled();
  await expect(page.getByText("Nota canonica riletta: F04_SERVER_WINNER · versione 2", { exact: true })).toBeVisible();
  await reapply.click(); await expect(field).toHaveValue("F04_LOCAL_DRAFT");
  await page.getByRole("button", { name: "Salva nota interna", exact: true }).click(); await expect(page.getByText("Nota interna salvata.", { exact: true })).toBeVisible();
  expect((await database.query("SELECT private_notes,version FROM reservations WHERE id=$1", [item.id])).rows[0]).toMatchObject({ private_notes: "F04_LOCAL_DRAFT", version: 3 });
  await page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }).click(); await expect(adopt).toBeEnabled(); await adopt.click();
  await page.getByRole("button", { name: "Conferma scarto e adotta nota canonica" }).click(); await expect(field).toHaveValue("F04_LOCAL_DRAFT");
  writeFileSync(info.outputPath("f04-reload.json"), JSON.stringify({ pendingActionsDisabled: true, failureActionsDisabled: true, draftPreserved: true, explicitReapplyVersion: 2, confirmedVersion: 3, explicitAdoption: true }));
});

test("F04 NI ignores an older GET after a newer reload confirms another version", async ({ page }) => {
  await login(page); const item = await create(page); await page.goto("/dashboard/reservations/" + item.id);
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true }); await field.fill("F04_ORDERED_DRAFT");
  await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "F04_OLD_READ" } });
  let release: () => void = () => undefined, reached: () => void = () => undefined, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { reached = resolve; });
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", async route => { if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); if (++calls === 1) { reached(); await gate; } await route.fulfill({ response }); });
  const reread = page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }); await reread.click(); await reading;
  await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 2, privateNotes: "F04_NEW_READ" } });
  await reread.click(); await expect(page.getByText("Nota canonica riletta: F04_NEW_READ · versione 3", { exact: true })).toBeVisible();
  release(); await expect(field).toHaveValue("F04_ORDERED_DRAFT"); await expect(page.getByText(/^Nota canonica riletta: F04_OLD_READ/u)).toHaveCount(0);
  await page.getByRole("button", { name: "Adotta la nota canonica dopo conferma" }).click(); await page.getByRole("button", { name: "Conferma scarto e adotta nota canonica" }).click();
  await expect(field).toHaveValue("F04_NEW_READ"); expect((await database.query("SELECT version FROM reservations WHERE id=$1", [item.id])).rows[0].version).toBe(3);
});

test("F04 closed NI reload cannot contaminate another reservation; F02 retained close still guards logout", async ({ page }) => {
  await login(page); const item = await create(page), other = await create(page); await page.goto("/dashboard?date=" + date);
  const row = (id: string) => page.locator('article[data-reservation-id="' + id + '"]');
  await row(item.id).getByRole("button", { name: "Apri note interne", exact: true }).click();
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true }); await field.fill("F04_RETAINED_ONE");
  let release: () => void = () => undefined, reached: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { reached = resolve; });
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }).click(); await reading;
  await page.getByRole("button", { name: "Chiudi note interne", exact: true }).click(); await keep(page);
  await row(other.id).getByRole("button", { name: "Apri note interne", exact: true }).click(); await field.fill("F04_OTHER_DRAFT"); release();
  await expect(field).toHaveValue("F04_OTHER_DRAFT"); await expect(page.getByRole("heading", { name: "Rivalutazione esplicita" })).toHaveCount(0);
  await page.getByRole("button", { name: "Chiudi note interne", exact: true }).click(); await keep(page);
  await page.getByRole("button", { name: "Logout", exact: true }).click(); const guard = page.getByRole("dialog", { name: "Modifiche non salvate" });
  await expect(guard.getByText("Bozza NI:", { exact: false })).toHaveCount(2); await guard.getByRole("button", { name: "Resta", exact: true }).click();
  await row(other.id).getByRole("button", { name: "Apri note interne", exact: true }).click(); await resume(page, "NI"); await expect(field).toHaveValue("F04_OTHER_DRAFT");
});

test.afterEach(async () => {
  await database.query("UPDATE users SET role='ADMIN' WHERE restaurant_id=$1 AND username=$2", [e2eRestaurantId, e2eAdminUsername]);
  for (const tenant of extraTenants.splice(0)) {
    await database.query("DELETE FROM users WHERE restaurant_id=$1", [tenant]);
    await database.query("DELETE FROM restaurants WHERE id=$1", [tenant]);
  }
});

async function businessFingerprint(includeAuth = true) {
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const hashes: { table: string; hash: string }[] = [];
    for (const row of tables) {
      const table = String(row.tablename); if (!/^[a-z_][a-z0-9_]*$/u.test(table)) throw Error("Unexpected fixture table");
      if (!includeAuth && ["sessions", "users", "login_rate_limits", "audit_events"].includes(table)) continue;
      const value = await client.query('SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,\'[]\')) AS fingerprint FROM "' + table + '" t');
      hashes.push({ table, hash: value.rows[0].fingerprint as string });
    }
    await client.query("COMMIT"); return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function prepareDraft(page: Page, kind: "PHONE" | "EDIT" | "NI") {
  await login(page); const item = kind === "PHONE" ? null : await create(page);
  if (kind === "PHONE") await phone(page); else await page.goto("/dashboard/reservations/" + item!.id + (kind === "EDIT" ? "/edit" : ""));
  const field = page.getByLabel(kind === "NI" ? "Nota interna autonoma (NI)" : "Note", { exact: true });
  await field.fill("F01_ARTIFICIAL_" + kind);
  const save = page.getByRole("button", { name: kind === "PHONE" ? "Salva prenotazione telefonica" : kind === "EDIT" ? "Salva modifiche" : "Salva nota interna", exact: true });
  return { item, field, save };
}
async function armNoBrowserEvents(page: Page) {
  await page.evaluate(() => {
    document.documentElement.dataset.f01Events = "0";
    const count = () => { document.documentElement.dataset.f01Events = String(Number(document.documentElement.dataset.f01Events) + 1); };
    for (const event of ["focus", "pageshow", "popstate"]) window.addEventListener(event, count);
    document.addEventListener("visibilitychange", count);
  });
}
async function switchWithoutBrowserEvent(page: Page, mode: string) {
  if (mode === "session" || mode === "actor") {
    const staff = mode === "actor";
    const response = await page.request.post("/api/auth/login", { headers: { origin }, form: { username: staff ? e2eStaffUsername : e2eAdminUsername, password: (staff ? process.env.AUTH_DEMO_STAFF_PASSWORD : process.env.AUTH_DEMO_ADMIN_PASSWORD) ?? "", returnTo: "/dashboard" }, maxRedirects: 0 });
    expect(response.status()).toBe(303); return;
  }
  if (mode === "tenant") {
    const tenant = randomUUID(), user = randomUUID(), session = randomUUID(), secret = randomBytes(32).toString("base64url"); extraTenants.push(tenant);
    await database.query("INSERT INTO restaurants(id,name,timezone,updated_at) VALUES($1,'F01 fake tenant','Europe/Rome',now())", [tenant]);
    await database.query("INSERT INTO users(id,restaurant_id,username,password_hash,role,updated_at) SELECT $1,$2,$3,password_hash,'ADMIN',now() FROM users WHERE restaurant_id=$4 AND username=$5", [user, tenant, "f01." + user, e2eRestaurantId, e2eAdminUsername]);
    await database.query("INSERT INTO sessions(id,secret_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [session, createHash("sha256").update(secret).digest("hex"), user]);
    await page.context().addCookies([{ name: "piccadilly_session", value: session + "." + secret, url: origin, httpOnly: true, sameSite: "Lax" }]); return;
  }
  if (mode === "role") { await database.query("UPDATE users SET role='STAFF' WHERE restaurant_id=$1 AND username=$2", [e2eRestaurantId, e2eAdminUsername]); return; }
  const cookie = (await page.context().cookies()).find(value => value.name === "piccadilly_session"); expect(cookie).toBeDefined();
  await database.query(mode === "revoked" ? "UPDATE sessions SET revoked_at=now() WHERE id=$1" : "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [cookie!.value.split(".")[0]]);
}

// Real browser + real HTTP + temporary PostgreSQL. In this schedule the request
// IS dispatched. The server, not a client event/proof, rejects it before writer.
test("F01 server boundary real duplicate HTTP headers are rejected on all three methods", async ({ page }, info) => {
  await login(page); const item = await create(page);
  const proof = await (await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: randomUUID() } })).json();
  const cookie = (await page.context().cookies(origin)).map(value => value.name + "=" + value.value).join("; ");
  const before = await businessFingerprint(), outcomes = [];
  for (const method of ["POST", "PATCH", "PUT"]) {
    const path = "/api/staff/reservations" + (method === "POST" ? "" : "/" + item.id + (method === "PUT" ? "/private-notes" : ""));
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(origin + path, { method, headers: { origin, cookie, "Content-Type": "application/json", "X-Piccadilly-Draft-Session-Binding": [proof.sessionBinding, proof.sessionBinding] } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }); req.on("error", reject); req.end("{}");
    });
    expect(response.status).toBe(400); expect(JSON.parse(response.body)).toEqual({ code: "DRAFT_SESSION_BINDING_INVALID" }); outcomes.push({ method, status: response.status });
  }
  expect(await businessFingerprint()).toBe(before);
  writeFileSync(info.outputPath("f01-duplicate-wire-header.json"), JSON.stringify({ actualRepeatedWireHeaders: true, outcomes, allPublicTablesUnchanged: true }));
});
test("F01 server boundary PHONE replay and Edit/NI no-op409 retain canonical and legacy contracts", async ({ page }, info) => {
  const draft = await prepareDraft(page, "PHONE");
  const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/staff/reservations" && response.request().method() === "POST");
  await draft.save.click(); const first = await created; expect(first.status()).toBe(201);
  const item = (await first.json()).reservation; owned.push(item.id);
  const request = first.request(), payload = request.postDataJSON() as Record<string, unknown>;
  const ownerBinding = request.headers()["x-piccadilly-draft-session-binding"], idempotency = request.headers()["idempotency-key"];
  expect(/^[A-Za-z0-9_-]{43}$/u.test(ownerBinding)).toBe(true);
  const headers = { origin, "X-Piccadilly-Draft-Session-Binding": ownerBinding, "Idempotency-Key": idempotency };
  const beforeReplay = await businessFingerprint();
  const replay = await page.request.post("/api/staff/reservations", { headers, data: payload });
  expect(replay.status()).toBe(200); expect((await replay.json()).replayed).toBe(true); expect(await businessFingerprint()).toBe(beforeReplay);
  const altered = (ownerBinding[0] === "A" ? "B" : "A") + ownerBinding.slice(1);
  const blockedReplay = await page.request.post("/api/staff/reservations", { headers: { ...headers, "X-Piccadilly-Draft-Session-Binding": altered }, data: payload });
  expect(blockedReplay.status()).toBe(403); expect((await blockedReplay.json()).code).toBe("DRAFT_SESSION_MISMATCH"); expect(await businessFingerprint()).toBe(beforeReplay);
  const niUrl = "/api/staff/reservations/" + item.id + "/private-notes";
  expect((await page.request.put(niUrl, { headers, data: { version: 1, privateNotes: "F01_BOUND_NI" } })).status()).toBe(200);
  const beforeNoop = await businessFingerprint();
  const noop = await page.request.put(niUrl, { headers, data: { version: 1, privateNotes: "F01_BOUND_NI" } });
  expect(noop.status()).toBe(200); expect((await noop.json()).changed).toBe(false); expect(await businessFingerprint()).toBe(beforeNoop);
  expect((await page.request.put(niUrl, { headers, data: { version: 1, privateNotes: "F01_STALE_CHANGE" } })).status()).toBe(409); expect(await businessFingerprint()).toBe(beforeNoop);
  const editPayload: Record<string, unknown> = { ...payload, version: 1 }; delete editPayload.verbalConsentConfirmed; delete editPayload.sendWhatsAppConfirmation;
  const editUrl = "/api/staff/reservations/" + item.id;
  expect((await page.request.patch(editUrl, { headers, data: editPayload })).status()).toBe(409); expect(await businessFingerprint()).toBe(beforeNoop);
  const legacy = await page.request.put(niUrl, { headers: { origin }, data: { version: 2, privateNotes: "F01_LEGACY_COMPATIBLE_NI" } }); expect(legacy.status()).toBe(200);
  await switchWithoutBrowserEvent(page, "tenant");
  const proofB = await (await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: randomUUID() } })).json();
  const foreignHeaders = { origin, "X-Piccadilly-Draft-Session-Binding": proofB.sessionBinding }, beforeForeign = await businessFingerprint();
  expect((await page.request.put(niUrl, { headers: foreignHeaders, data: { version: 3, privateNotes: "F01_FORBIDDEN" } })).status()).toBe(404);
  expect((await page.request.patch(editUrl, { headers: foreignHeaders, data: { ...editPayload, version: 3 } })).status()).toBe(404); expect(await businessFingerprint()).toBe(beforeForeign);
  writeFileSync(info.outputPath("f01-canonical-contracts.json"), JSON.stringify({ phoneReplay: true, mismatchedReplayRejected: true, staleIdenticalNiNoop: true, ni409: true, edit409: true, legacyHeaderlessNi: true, correctBindingForeignResourceRejected: true }));
});
for (const kind of ["PHONE", "EDIT", "NI"] as const) {
  for (const stage of kind === "PHONE" ? ["PROOF"] as const : ["PROOF", "GET"] as const) {
    for (const mode of ["session", "actor"] as const) {
      test("F01 server boundary " + kind + " cookie switch after " + stage + " to " + mode, async ({ page }, info) => {
        const draft = await prepareDraft(page, kind);
        const proofA = await (await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: randomUUID() } })).json();
        let release: () => void = () => undefined, reached: () => void = () => undefined, mutations = 0, originalHeader = false;
        const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reached = resolve; });
        const endpoint = "/api/staff/reservations" + (draft.item ? "/" + draft.item.id + (kind === "NI" ? "/private-notes" : "") : "");
        const method = kind === "PHONE" ? "POST" : kind === "EDIT" ? "PATCH" : "PUT";
        const consoleMessages: string[] = []; page.on("console", message => consoleMessages.push(message.text()));
        page.on("request", request => {
          if (new URL(request.url()).pathname === endpoint && request.method() === method) {
            ++mutations; originalHeader = request.headers()["x-piccadilly-draft-session-binding"] === proofA.sessionBinding;
          }
        });
        const holdUrl = stage === "PROOF" ? "**/api/auth/draft-context" : "**" + endpoint;
        await page.route(holdUrl, async route => {
          if (stage === "GET" && route.request().method() !== "GET") { await route.continue(); return; }
          const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
        });
        await armNoBrowserEvents(page); await draft.save.dispatchEvent("click"); await held;
        await expect(draft.field).toBeDisabled(); expect(mutations).toBe(0);
        await switchWithoutBrowserEvent(page, mode);
        expect(await page.locator("html").getAttribute("data-f01-events")).toBe("0");
        const proofB = await (await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: randomUUID() } })).json();
        expect(proofA.sessionBinding === proofB.sessionBinding).toBe(false);
        if (draft.item) expect((await page.request.get(endpoint)).status()).toBe(200);
        const before = await businessFingerprint();
        const rejected = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === method);
        release(); const response = await rejected;
        expect(response.status()).toBe(403); expect(await response.json()).toEqual({ code: "DRAFT_SESSION_MISMATCH" });
        await expect(page.getByText("Il server ha rifiutato il salvataggio:", { exact: false })).toBeVisible();
        expect(mutations).toBe(1); expect(originalHeader).toBe(true); expect(await businessFingerprint()).toBe(before);
        expect(consoleMessages.some(message => message.includes(proofA.sessionBinding) || message.includes(proofB.sessionBinding))).toBe(false);
        expect(await page.getByText(/Nota interna salvata|Prenotazione telefonica salvata/u).count()).toBe(0);
        writeFileSync(info.outputPath("f01-server-boundary.json"), JSON.stringify({ kind, stage, mode, realHTTP: true, realTemporaryPostgres: true,
          classification: "SERVER_REJECTED_BEFORE_WRITER", clientNoDispatch: false, dispatches: mutations, originalOwnerHeader: originalHeader,
          cookieBindingChanged: true, sameTenantResourceAccessibleToB: !!draft.item, httpStatus: 403, code: "DRAFT_SESSION_MISMATCH", allPublicTablesUnchanged: true, consoleBindingLeak: false }));
      });
    }
  }
  test("F01 server boundary " + kind + " authorized controller always carries binding", async ({ page }, info) => {
    const draft = await prepareDraft(page, kind); let mutations = 0, validBinding = true;
    page.on("request", request => { if (/\/api\/staff\/reservations(?:\/|$)/u.test(new URL(request.url()).pathname) && ["POST", "PUT", "PATCH"].includes(request.method())) {
      ++mutations; validBinding &&= /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(request.headers()["x-piccadilly-draft-session-binding"] ?? "");
    } });
    const responsePromise = page.waitForResponse(response => /\/api\/staff\/reservations(?:\/|$)/u.test(new URL(response.url()).pathname) && ["POST", "PUT", "PATCH"].includes(response.request().method()));
    await draft.save.click(); const response = await responsePromise; expect(response.ok()).toBe(true); expect(mutations).toBe(1); expect(validBinding).toBe(true);
    if (kind === "PHONE") { const body = await response.json(); owned.push(body.reservation.id); }
    writeFileSync(info.outputPath("f01-authorized-controller.json"), JSON.stringify({ kind, classification: "AUTHORIZED_MUTATION", mutations, canonicalOwnerHeader: validBinding }));
  });
}

for (const kind of ["PHONE", "EDIT", "NI"] as const) {
  test("F02 " + kind + " retained outside editor warns before canonical logout303", async ({ page }, info) => {
    const draft = await prepareDraft(page, kind);
    await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page); await expect(page).toHaveURL(/\/admin$/u);
    let posts = 0; page.on("request", request => { if (request.url().endsWith("/api/auth/logout") && request.method() === "POST") ++posts; });
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Modifiche non salvate" }); await expect(guard).toContainText("comprese quelle conservate e non aperte"); expect(posts).toBe(0);
    await guard.getByRole("button", { name: "Resta", exact: true }).click();
    await page.getByRole("button", { name: "Torna al draft " + kind, exact: true }).click(); await resume(page, kind); await expect(draft.field).toHaveValue("F01_ARTIFICIAL_" + kind);
    await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page); await expect(page).toHaveURL(/\/admin$/u);
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    const loggedOut = page.waitForResponse(response => response.url().endsWith("/api/auth/logout") && response.request().method() === "POST");
    await guard.getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click(); expect((await loggedOut).status()).toBe(303);
    await expect(page).toHaveURL(/\/login$/u); expect(posts).toBe(1); await page.goBack();
    await expect(page.getByRole("button", { name: "Torna al draft " + kind, exact: true })).toHaveCount(0);
    expect(await page.locator("body").textContent()).not.toContain("F01_ARTIFICIAL_" + kind);
    writeFileSync(info.outputPath("f02-retained-logout.json"), JSON.stringify({ kind, retainedGuard: true, stayPreserved: true, logoutHttpStatus: 303, logoutPosts: posts, oldDraftAbsentAfterBack: true }));
  });
  for (const failure of [403, 500, "network"] as const) {
    test("F02 " + kind + " retained failed logout " + failure + " stays quarantined until explicit recovery", async ({ page }) => {
      const draft = await prepareDraft(page, kind);
      await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page); await expect(page).toHaveURL(/\/admin$/u);
      await page.route("**/api/auth/logout", route => failure === "network" ? route.abort("internetdisconnected") : route.fulfill({ status: failure, body: "ARTIFICIAL_LOGOUT_FAILURE" }));
      await page.getByRole("button", { name: "Logout", exact: true }).click(); await page.getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click();
      await expect(page.getByText("Logout non confermato.", { exact: false })).toBeVisible(); await expect(page).toHaveURL(/\/admin$/u);
      await expect(page.getByRole("button", { name: "Torna al draft " + kind, exact: true })).toHaveCount(0);
      await page.unroute("**/api/auth/logout"); await page.getByRole("button", { name: "Verifica di nuovo la sessione", exact: true }).click();
      await page.getByRole("button", { name: "Torna al draft " + kind, exact: true }).click(); await resume(page, kind); await expect(draft.field).toHaveValue("F01_ARTIFICIAL_" + kind);
    });
  }
  test("F01/F02 " + kind + " logout during delayed pre-submit proof never dispatches the old attempt", async ({ page }) => {
    const draft = await prepareDraft(page, kind); let release: () => void = () => undefined, reached: () => void = () => undefined, mutations = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), proofReached = new Promise<void>(resolve => { reached = resolve; });
    page.on("request", request => { if (/\/api\/staff\/reservations(?:\/|$)/u.test(new URL(request.url()).pathname) && ["POST", "PUT", "PATCH"].includes(request.method())) ++mutations; });
    await page.route("**/api/auth/draft-context", async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }).catch(() => undefined); });
    const before = await businessFingerprint(false); await draft.save.dispatchEvent("click"); await proofReached; await expect(draft.field).toBeDisabled();
    await page.getByRole("button", { name: "Logout", exact: true }).click(); const guard = page.getByRole("dialog", { name: "Modifiche non salvate" });
    await expect(guard).toContainText("richiesta in corso"); await guard.getByRole("button", { name: "Resta", exact: true }).click(); await expect(draft.field).toBeDisabled();
    await page.getByRole("button", { name: "Logout", exact: true }).click(); await guard.getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/u); release(); expect(mutations).toBe(0); expect(await businessFingerprint(false)).toBe(before);
  });
}

for (const kind of ["PHONE", "EDIT", "NI"] as const) {
  for (const mode of ["session", "actor", "tenant", "role", "revoked", "expired"] as const) {
    test("F01 " + kind + " blocks dispatch after " + mode + " change with no document event", async ({ page }, info) => {
      const draft = await prepareDraft(page, kind);
      const prior = await (await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: randomUUID() } })).json();
      await armNoBrowserEvents(page); await switchWithoutBrowserEvent(page, mode);
      expect(await page.locator("html").getAttribute("data-f01-events")).toBe("0");
      const before = await businessFingerprint(); let mutations = 0, proofs = 0;
      page.on("request", request => { if (/\/api\/staff\/reservations(?:\/|$)/u.test(new URL(request.url()).pathname) && ["POST", "PUT", "PATCH"].includes(request.method())) ++mutations; if (request.url().endsWith("/api/auth/draft-context")) ++proofs; });
      const proof = page.waitForResponse(response => response.url().endsWith("/api/auth/draft-context") && response.request().method() === "POST");
      await draft.save.dispatchEvent("click"); const response = await proof; const body = await response.json();
      if (mode === "revoked" || mode === "expired") { expect(response.status()).toBe(401); expect(body.error).toBe("UNAUTHENTICATED"); }
      if (["session", "actor", "tenant"].includes(mode)) expect(body.sessionBinding).not.toBe(prior.sessionBinding);
      if (mode === "role") expect(body.role).not.toBe(prior.role);
      await expect(page.getByRole("status").filter({ hasText: /nessun dato|Nessun invio/u })).toBeVisible();
      expect(proofs).toBeGreaterThanOrEqual(1); expect(mutations).toBe(0); expect(await businessFingerprint()).toBe(before);
      expect(await page.getByText(/Nota interna salvata|Prenotazione telefonica salvata/u).count()).toBe(0);
      writeFileSync(info.outputPath("f01-zero-dispatch.json"), JSON.stringify({ kind, mode, newProof: true, bindingChanged: ["session", "actor", "tenant"].includes(mode), noIntermediateBrowserEvent: true, classification: "NO_MUTATION_DISPATCH", mutationDispatches: mutations, databaseAllPublicTablesUnchanged: true, serverRejectedMutation: false }));
    });
  }
  for (const mode of [401, 403, 500, "network", "malformed", "wrong-challenge"] as const) {
    test("F01 " + kind + " refuses pre-submit proof " + mode, async ({ page }, info) => {
      const draft = await prepareDraft(page, kind), before = await businessFingerprint(); let mutations = 0;
      page.on("request", request => { if (/\/api\/staff\/reservations(?:\/|$)/u.test(new URL(request.url()).pathname) && ["POST", "PUT", "PATCH"].includes(request.method())) ++mutations; });
      await page.route("**/api/auth/draft-context", async route => {
        if (mode === "network") return route.abort("internetdisconnected");
        if (mode === "wrong-challenge") { const real = await route.fetch(), body = await real.json(); return route.fulfill({ response: real, json: { ...body, challenge: randomUUID() } }); }
        return route.fulfill({ status: typeof mode === "number" ? mode : 200, json: mode === "malformed" ? { extra: "invalid" } : { error: "ARTIFICIAL_PROOF_FAILURE" } });
      });
      await draft.save.dispatchEvent("click"); await expect(page.getByRole("status").filter({ hasText: /nessun invio effettuato/iu })).toBeVisible();
      expect(mutations).toBe(0); expect(await businessFingerprint()).toBe(before);
      await expect(draft.field).toHaveCount(0);
      writeFileSync(info.outputPath("f01-proof-failure.json"), JSON.stringify({ kind, mode, classification: "NO_MUTATION_DISPATCH", mutations, databaseBusinessUnchanged: true, proofErrorSimulatedAtBrowserTransport: true }));
      if (mode === "network") {
        await page.unroute("**/api/auth/draft-context"); await page.getByRole("button", { name: "Verifica di nuovo la sessione", exact: true }).click();
        await resume(page, kind); await expect(draft.field).toHaveValue("F01_ARTIFICIAL_" + kind); expect(mutations).toBe(0);
        if (kind === "NI") { await page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }).click(); await page.getByRole("button", { name: "Riapplica la mia bozza sulla versione riletta" }).click(); }
        await draft.save.dispatchEvent("click"); await expect.poll(() => mutations).toBe(1);
        if (kind === "EDIT") await expect(page).toHaveURL(/\/dashboard\?/u);
        else await expect(page.getByRole("status").filter({ hasText: kind === "NI" ? "Nota interna salvata" : "Prenotazione telefonica salvata" })).toBeVisible();
      }
    });
  }
  test("F01 " + kind + " locks through delayed live proof and dispatches only after authorization", async ({ page }) => {
    const draft = await prepareDraft(page, kind); let release: () => void = () => undefined, reached: () => void = () => undefined, mutations = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), proofReached = new Promise<void>(resolve => { reached = resolve; });
    page.on("request", request => { if (/\/api\/staff\/reservations(?:\/|$)/u.test(new URL(request.url()).pathname) && ["POST", "PUT", "PATCH"].includes(request.method())) ++mutations; });
    await page.route("**/api/auth/draft-context", async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
    await draft.save.dispatchEvent("click"); await proofReached; await expect(draft.field).toBeDisabled();
    await page.getByRole("button", { name: "Salvataggio…", exact: true }).dispatchEvent("click"); expect(mutations).toBe(0); release();
    await expect.poll(() => mutations).toBe(1);
    if (kind === "EDIT") await expect(page).toHaveURL(/\/dashboard\?/u);
    else await expect(page.getByRole("status").filter({ hasText: kind === "NI" ? "Nota interna salvata" : "Prenotazione telefonica salvata" })).toBeVisible();
  });
}

for (const kind of ["PHONE", "EDIT", "NI"] as const) {
  test("CB06 " + kind + ": Staff Link, native Back/Forward, multi-step and cross-layout recovery", async ({ page }) => {
    await login(page); const item = kind === "PHONE" ? null : await create(page);
    if (kind === "PHONE") await phone(page); else await page.goto("/dashboard/reservations/" + item!.id + (kind === "EDIT" ? "/edit" : ""));
    const field = page.getByLabel(kind === "NI" ? "Nota interna autonoma (NI)" : "Note", { exact: true }), marker = "T06B_RAM_" + kind;
    await field.fill(marker); const start = page.url();
    const editFields = { customerFirstName: e2eReservationFirstName + " Edit", customerLastName: "T06B ALL FIELDS", customerPhone: "+390000000619", customerEmail: "artificial@example.invalid", allergies: "ARTIFICIAL_ALLERGY", intolerances: "ARTIFICIAL_INTOLERANCE", celebration: "ARTIFICIAL_CELEBRATION", capacityOverrideReason: "ARTIFICIAL_REASON" };
    if (kind === "EDIT") {
      for (const [name, value] of Object.entries(editFields)) await page.locator('[name="' + name + '"]').fill(value);
      for (const name of ["highChair", "stroller", "accessibility", "celiac", "animals", "capacityOverride"]) await page.locator('[name="' + name + '"]').check();
      await page.getByLabel("In quanti siete? (coperti totali)", { exact: true }).fill("4");
      await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
      await page.getByLabel("Quanti bambini ci sono?", { exact: true }).fill("1");
      await page.getByRole("group", { name: "Preferite un tavolo nella Sala con i Giochi?", exact: true }).getByRole("radio", { name: "Sì", exact: true }).check();
      await page.getByLabel("Slot", { exact: false }).selectOption("21:00");
    }
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Modifiche non salvate" }); await expect(guard).toBeVisible(); await guard.getByRole("button", { name: "Resta", exact: true }).click();
    await expect(page).toHaveURL(start); await expect(field).toHaveValue(marker);
    await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page); await expect(page).toHaveURL(/\/admin$/u);
    await page.goBack(); await resume(page, kind); await expect(field).toHaveValue(marker);
    await page.goForward(); await expect(page).toHaveURL(/\/admin$/u);
    await page.getByRole("link", { name: "Configurazioni", exact: true }).click(); await expect(page).toHaveURL(/\/admin\/configuration$/u);
    await page.evaluate(() => history.go(-2)); await expect(page).toHaveURL(start); await resume(page, kind); await expect(field).toHaveValue(marker);
    await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page);
    await page.getByRole("button", { name: "Torna al draft " + kind, exact: true }).click(); await resume(page, kind); await expect(field).toHaveValue(marker);
    expect(page.url()).not.toContain(marker);
    const storage = await page.evaluate(() => ({ local: Object.values(localStorage), session: Object.values(sessionStorage), state: JSON.stringify(history.state) }));
    expect(JSON.stringify(storage)).not.toContain(marker);
    if (kind === "EDIT") {
      for (const [name, value] of Object.entries(editFields)) await expect(page.locator('[name="' + name + '"]')).toHaveValue(value);
      for (const name of ["highChair", "stroller", "accessibility", "celiac", "animals", "capacityOverride"]) await expect(page.locator('[name="' + name + '"]')).toBeChecked();
      await expect(page.getByLabel("Quanti bambini ci sono?", { exact: true })).toHaveValue("1"); await expect(page.getByLabel("Slot", { exact: false })).toHaveValue("21:00");
    }
  });
}

test("CB06 selective discard preserves another reservation and another draft kind", async ({ page }) => {
  await login(page); const item = await create(page), other = await create(page);
  await phone(page); await page.getByLabel("Note", { exact: true }).fill("T06B_KEEP_PHONE");
  await page.getByRole("link", { name: "Torna Agenda", exact: true }).click(); await keep(page);
  for (const [row, marker] of [[item, "T06B_DISCARD_NI_ONE"], [other, "T06B_KEEP_NI_TWO"]] as const) {
    await page.locator('article[data-reservation-id="' + row.id + '"] [data-open-reservation]').click();
    await page.getByLabel("Nota interna autonoma (NI)", { exact: true }).fill(marker);
    await page.getByRole("button", { name: "Chiudi dettaglio" }).click(); await keep(page);
  }
  await page.locator('article[data-reservation-id="' + item.id + '"] [data-open-reservation]').click(); await resume(page, "NI");
  await page.getByRole("button", { name: "Chiudi dettaglio" }).click();
  await page.getByRole("checkbox", { name: "Scarta soltanto la bozza NI", exact: true }).check();
  await page.getByRole("button", { name: "Scarta selezionate ed esci" }).click();
  await expect(page.getByRole("button", { name: "Torna al draft NI", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Torna al draft PHONE", exact: true }).click(); await resume(page, "PHONE");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_KEEP_PHONE");
  await page.getByRole("link", { name: "Torna Agenda", exact: true }).click(); await keep(page);
  await page.getByRole("button", { name: "Torna al draft NI", exact: true }).click(); await resume(page, "NI");
  await expect(page.getByLabel("Nota interna autonoma (NI)", { exact: true })).toHaveValue("T06B_KEEP_NI_TWO");
});

test("CB06 NI pending fields stay locked during resize/navigation and detached ACK has no redirect or focus theft", async ({ page }) => {
  await login(page); const item = await create(page); await page.goto("/dashboard/reservations/" + item.id);
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true }); await field.fill("T06B_PENDING_NI");
  let release: () => void = () => undefined, requests = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", async route => { if (route.request().method() !== "PUT") return route.continue(); requests++; const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "Salva nota interna", exact: true }).click(); await expect(field).toBeDisabled();
  await page.setViewportSize({ width: 820, height: 1180 }); await expect(field).toBeDisabled();
  await page.getByRole("button", { name: "Salvataggio…", exact: true }).dispatchEvent("click"); await expect.poll(() => requests).toBe(1);
  await page.getByRole("link", { name: "Admin", exact: true }).click(); await expect(page.getByText(/uscire non annulla/u)).toBeVisible(); await keep(page);
  await expect(page).toHaveURL(/\/admin$/u); const focusTarget = page.getByRole("link", { name: "Agenda", exact: true }); await focusTarget.focus(); release();
  await expect(page.getByRole("status").filter({ hasText: "Un salvataggio già inviato" })).toBeVisible(); await expect(page).toHaveURL(/\/admin$/u);
  await expect(focusTarget).toBeFocused();
  expect((await database.query("SELECT private_notes,version FROM reservations WHERE id=$1", [item.id])).rows[0]).toMatchObject({ private_notes: "T06B_PENDING_NI", version: 2 });
});

test("CB06 actual409 and network error keep Edit fields/base separate from canonical reread", async ({ page }) => {
  await login(page); const item = await create(page); await page.goto("/dashboard/reservations/" + item.id + "/edit");
  await page.getByLabel("Note", { exact: true }).fill("T06B_EDIT_DRAFT_409"); await page.getByLabel("Seggiolone", { exact: true }).check();
  await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "T06B_OTHER_OPERATOR" } });
  const failed = page.waitForResponse(response => response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Salva modifiche", exact: true }).click(); expect((await failed).status()).toBe(409);
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_EDIT_DRAFT_409"); await expect(page.getByLabel("Seggiolone", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Rileggi dati canonici separatamente" }).click(); await expect(page.getByText("Versione della bozza: 1. Versione canonica riletta: 2.")).toBeVisible();
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_EDIT_DRAFT_409");
  await page.getByLabel("Riapplica NC condivisa", { exact: true }).check(); await page.getByLabel("Riapplica Seggiolone", { exact: true }).check();
  await page.getByRole("button", { name: "Usa il confronto e prepara la bozza" }).click();
  await page.route("**/api/staff/reservations/" + item.id, route => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  await page.getByRole("button", { name: "Salva modifiche", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "Errore di rete" })).toBeVisible();
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_EDIT_DRAFT_409");
  expect((await database.query("SELECT notes,version FROM reservations WHERE id=$1", [item.id])).rows[0]).toMatchObject({ notes: "T06B_CANONICAL_NC", version: 2 });
});

test("CB06 canonical logout303 clears drafts, Back exposes no old values; failed logout retains quarantine", async ({ page }) => {
  await login(page); await phone(page); await page.getByLabel("Note", { exact: true }).fill("T06B_LOGOUT_PRIVATE");
  await page.route("**/api/auth/logout", route => route.fulfill({ status: 500, body: "unavailable" }));
  await page.getByRole("button", { name: "Logout", exact: true }).click(); await page.getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click();
  await expect(page.getByText("Logout non confermato.", { exact: false })).toBeVisible(); await expect(page.locator('textarea[name="notes"]')).toHaveCount(0);
  await page.unroute("**/api/auth/logout"); const logout = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Riprova logout", exact: true }).click();
  await page.getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click();
  expect((await logout).status()).toBe(303); await expect(page).toHaveURL(/\/login$/u);
  await page.goBack(); await expect(page.getByText("T06B_LOGOUT_PRIVATE", { exact: true })).toHaveCount(0);
  expect(await page.locator('textarea[name="notes"]').evaluateAll(nodes => nodes.map(node => (node as HTMLTextAreaElement).value))).not.toContain("T06B_LOGOUT_PRIVATE");
});

for (const staff of [false, true]) test("CB06 new " + (staff ? "actor/role" : "session of same actor") + " cannot restore an earlier NI or consume its late ACK", async ({ page }) => {
  await login(page); const item = await create(page); await page.goto("/dashboard/reservations/" + item.id);
  let release: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; });
  let acknowledge: () => void = () => undefined; const mutationCompleted = new Promise<void>(resolve => { acknowledge = resolve; });
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", async route => { if (route.request().method() !== "PUT") return route.continue(); const response = await route.fetch(); acknowledge(); await gate; await route.fulfill({ response }); });
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true }); await field.fill("T06B_OLD_ATTEMPT"); await page.getByRole("button", { name: "Salva nota interna", exact: true }).click();
  await expect(field).toBeDisabled(); await mutationCompleted; await sessionSwitch(page, staff);
  await expect(field).toBeEnabled(); await field.fill("T06B_NEW_SESSION_DRAFT"); release();
  await expect(field).toHaveValue("T06B_NEW_SESSION_DRAFT"); await expect(page.getByRole("button", { name: "Salva nota interna", exact: true })).toBeEnabled();
});

test("CB06 a late401 from an invalidated attempt cannot erase a new-session draft", async ({ page }) => {
  await login(page); const item = await create(page); await page.goto("/dashboard/reservations/" + item.id);
  let release: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; });
  let dispatched: () => void = () => undefined; const mutationReached = new Promise<void>(resolve => { dispatched = resolve; });
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", async route => { if (route.request().method() !== "PUT") return route.continue(); dispatched(); await gate; return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"UNAUTHENTICATED"}' }); });
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true });
  await field.fill("T06B_OLD_UNAUTHORIZED_ATTEMPT"); await page.getByRole("button", { name: "Salva nota interna", exact: true }).click(); await expect(field).toBeDisabled();
  await mutationReached; await sessionSwitch(page); await expect(field).toBeEnabled(); await field.fill("T06B_NEW_SURVIVES_401"); release();
  await expect(field).toHaveValue("T06B_NEW_SURVIVES_401");
  await expect(page.getByRole("button", { name: "Salva nota interna", exact: true })).toBeEnabled();
});

test("CB06 delayed/offline proof never authorizes personal draft display", async ({ page }) => {
  await login(page); await phone(page); await page.getByLabel("Note", { exact: true }).fill("T06B_OFFLINE_DRAFT");
  await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page);
  await expect(page).toHaveURL(/\/admin$/u);
  await page.route("**/api/auth/draft-context", route => route.abort("failed")); await page.goBack();
  await expect(page.getByText("Verifica della sessione non disponibile.", { exact: false })).toBeVisible();
  await expect(page.locator('textarea[name="notes"]')).toHaveCount(0);
  await page.unroute("**/api/auth/draft-context"); await page.getByRole("button", { name: "Verifica di nuovo la sessione" }).click(); await resume(page, "PHONE");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_OFFLINE_DRAFT");
});

test("CB06 a delayed proof stays masked and an old generation cannot unlock the restored form", async ({ page }) => {
  await login(page); await phone(page); await page.getByLabel("Note", { exact: true }).fill("T06B_DELAYED_PROOF_DRAFT");
  await page.getByRole("link", { name: "Admin", exact: true }).click(); await keep(page);
  await expect(page).toHaveURL(/\/admin$/u);
  let release: () => void = () => undefined, calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/draft-context", async route => { calls++; const response = await route.fetch(); if (calls === 1) await gate; await route.fulfill({ response }); });
  await page.goBack(); await expect.poll(() => calls).toBeGreaterThan(0);
  await expect(page.locator('textarea[name="notes"]')).toHaveCount(0);
  await page.goForward(); await expect(page).toHaveURL(/\/admin$/u); release();
  await page.goBack(); await resume(page, "PHONE");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_DELAYED_PROOF_DRAFT");
});

test("CB06 real cross-document BFCache probe with suspended-session revocation", async ({}, info) => {
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"], args: ["--enable-features=BackForwardCache"] });
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const observed = window as Window & {cb06PageShows?:{persisted:boolean;oldDraftInDom:boolean}[]};
    observed.cb06PageShows = [];
    addEventListener("pageshow", event => observed.cb06PageShows?.push({ persisted: event.persisted, oldDraftInDom: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].some(node => node.value.includes("T06B_BFCACHE_PRIVATE")) }));
  });
  const cdp = await context.newCDPSession(page), notUsed: unknown[] = [];
  await cdp.send("Page.enable");
  cdp.on("Page.backForwardCacheNotUsed", event => notUsed.push({ reasons: event.notRestoredExplanations }));
  const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Artificial foreign document</title><p>No personal data</p>"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await login(page); await phone(page); await page.getByLabel("Note", { exact: true }).fill("T06B_BFCACHE_PRIVATE");
    const cookie = (await context.cookies()).find(value => value.name === "piccadilly_session"); expect(cookie).toBeTruthy();
    page.on("dialog", dialog => { void dialog.accept(); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Foreign fixture port missing");
    await page.goto("http://127.0.0.1:" + address.port);
    await database.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [cookie!.value.split(".")[0]]);
    await page.goBack(); await expect(page.locator('textarea[name="notes"]')).toHaveCount(0);
    expect(await page.content()).not.toContain("T06B_BFCACHE_PRIVATE");
    const pageshows = await page.evaluate(() => (window as Window & {cb06PageShows?:{persisted:boolean;oldDraftInDom:boolean}[]}).cb06PageShows ?? []);
    expect(pageshows.every(event => !event.oldDraftInDom)).toBe(true);
    const activated = pageshows.some(event => event.persisted);
    const evidence = { realCrossDocumentTraversal: true, sessionRevokedWhileSuspended: true, pageshows, notUsed, bfcacheActivated: activated, result: activated ? "ACTIVATED_AND_NO_OLD_DRAFT_DISPLAY" : "NOT_ACTIVATED_NO_BFCACHE_PASS_CLAIM", browser: browser.version() };
    writeFileSync(info.outputPath("bfcache-probe.json"), JSON.stringify(evidence, null, 2)); await info.attach("BFCache actual activation evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  } finally { await context.close(); await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
