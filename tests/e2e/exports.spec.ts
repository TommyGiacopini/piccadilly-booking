import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { Pool } from "pg";

import { expect, test, type APIRequestContext, type Download, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eRunId,
  e2eRestaurantId,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const exportDate = "2099-12-10";

interface CreatedReservation {
  id: string;
  version: number;
}

async function login(page: Page, role: "STAFF" | "ADMIN"): Promise<void> {
  await page.goto("/login");
  await page
    .getByLabel("Username")
    .fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page
    .getByLabel("Password")
    .fill(role === "ADMIN" ? adminPassword : staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard/u);
}

async function createReservation(
  request: APIRequestContext,
  lastName: string,
): Promise<CreatedReservation> {
  const response = await request.post("/api/staff/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data: {
      localDate: exportDate,
      serviceType: "DINNER",
      arrivalTime: "19:00",
      partySize: 3,
      childrenCount: 1,
      gameRoomPreference: false,
      customerFirstName: e2eReservationFirstName,
      customerLastName: lastName,
      customerPhone: "+390000001111",
      customerEmail: null,
      highChair: true,
      stroller: false,
      accessibility: false,
      celiac: false,
      allergies: "Nessuna — àèéìòù",
      intolerances: null,
      celebration: "Compleanno fittizio",
      animals: false,
      notes: `Fixture export M11 ${e2eRunId}`,
      verbalConsentConfirmed: true,
      sendWhatsAppConfirmation: true,
      capacityOverride: false,
      capacityOverrideReason: null,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { reservation: CreatedReservation }).reservation;
}

async function cancelReservation(
  request: APIRequestContext,
  reservation: CreatedReservation,
): Promise<void> {
  const response = await request.delete(
    `/api/staff/reservations/${reservation.id}`,
    { headers: { origin }, data: { version: reservation.version } },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function downloadBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Il download Playwright non espone uno stream.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function excelJsInput(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

async function pdfText(buffer: Buffer): Promise<string> {
  const task = getDocument({ data: new Uint8Array(buffer) });
  const document = await task.promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  await document.destroy();
  return pages.join(" ");
}

test.describe.serial("M11 export PDF ed Excel", () => {
  for (const role of ["STAFF", "ADMIN"] as const) {
    test(`T06 ${role}: PDF/DAY/MONTH/RANGE escludono NI autonome e legacy conservando NC e dati business`, async ({ page }) => {
      const target = new URL(process.env.DATABASE_URL ?? "");
      expect(target.pathname).toMatch(/^\/piccadilly_e2e_[0-9a-f]{32}$/u);
      const database = new Pool({ connectionString: target.href });
      await login(page, role);
      const markers = ["T06_HTTP_AUTONOMOUS_NI", "T06_HTTP_ACTIVE_LEGACY_NI", "T06_HTTP_CLEARED_LEGACY_NI"];
      const reservations: CreatedReservation[] = [];
      const folder = resolve("test-results/t06-http-export-evidence"); mkdirSync(folder, { recursive: true });
      const fingerprint = async () => JSON.stringify((await database.query(
        "SELECT to_jsonb(r) AS reservation,(SELECT json_agg(to_jsonb(a) ORDER BY a.id) FROM reservation_assignments a WHERE a.reservation_id=r.id) AS assignment FROM reservations r WHERE r.id=ANY($1::uuid[]) AND r.restaurant_id=$2 ORDER BY r.id",
        [reservations.map((item) => item.id), e2eRestaurantId],
      )).rows);
      function xmlContents(buffer: Buffer): string {
        let end = -1;
        for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
        if (end < 0) throw new Error("Invalid fixture ZIP.");
        let cursor = buffer.readUInt32LE(end + 16); const output: string[] = [];
        for (let count = buffer.readUInt16LE(end + 10); count > 0; count -= 1) {
          const method = buffer.readUInt16LE(cursor + 10), size = buffer.readUInt32LE(cursor + 20);
          const length = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
          const offset = buffer.readUInt32LE(cursor + 42), name = buffer.subarray(cursor + 46, cursor + 46 + length).toString("utf8");
          const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
          const bytes = buffer.subarray(start, start + size);
          if (name.endsWith(".xml") || name.endsWith(".rels")) output.push(name + "\n" + (method === 0 ? bytes : inflateRawSync(bytes)).toString("utf8"));
          cursor += 46 + length + extra + comment;
        }
        return output.join("\n");
      }
      try {
        for (let index = 0; index < 3; index += 1) {
          const reservation = await createReservation(page.request, `T06 ${role} ${index} ${e2eRunId}`);
          reservations.push(reservation);
          const note = await page.request.put(`/api/staff/reservations/${reservation.id}/private-notes`, {
            headers: { origin }, data: { version: 1, privateNotes: markers[0] },
          }); expect(note.status()).toBe(200); reservation.version = 2;
          if (index > 0) {
            const ctx = await (await page.request.get(`/api/staff/reservations/${reservation.id}/assignment`)).json();
            const room = ctx.rooms.find((item: { code: string }) => item.code === "sala-1");
            const assigned = await page.request.put(`/api/staff/reservations/${reservation.id}/assignment`, {
              headers: { origin }, data: { version: 2, roomId: room.id, tableIds: [], internalNotes: markers[index] },
            }); expect(assigned.status()).toBe(200); reservation.version = 3;
            if (index === 2) {
              const clear = await page.request.delete(`/api/staff/reservations/${reservation.id}/assignment`, { headers: { origin }, data: { version: 3 } });
              expect(clear.status()).toBe(200); reservation.version = 4;
            }
          }
        }
        const before = await fingerprint();
        const requests = [
          { format: "pdf", mode: "PDF", data: { date: exportDate } },
          { format: "excel", mode: "DAY", data: { mode: "DAY", date: exportDate } },
          { format: "excel", mode: "MONTH", data: { mode: "MONTH", month: "2099-12" } },
          { format: "excel", mode: "RANGE", data: { mode: "RANGE", from: exportDate, to: exportDate } },
        ];
        for (const request of requests) {
          const response = await page.request.post("/api/staff/exports/" + request.format, { headers: { origin }, data: request.data });
          expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toContain("private, no-store");
          const buffer = await response.body();
          let extracted: string;
          if (request.format === "pdf") {
            extracted = await pdfText(buffer);
            const task = getDocument({ data: new Uint8Array(buffer) }); const pdf = await task.promise;
            const metadata = await pdf.getMetadata(); const annotations: unknown[] = [];
            for (let number = 1; number <= pdf.numPages; number += 1) annotations.push(await (await pdf.getPage(number)).getAnnotations());
            for (const marker of markers) { expect(JSON.stringify(metadata)).not.toContain(marker); expect(JSON.stringify(annotations)).not.toContain(marker); }
            await pdf.destroy();
          } else {
            const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(excelJsInput(buffer));
            const cells: unknown[] = [];
            for (const sheet of workbook.worksheets) {
              expect(sheet.columnCount).toBe(24);
              sheet.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.value)));
              for (let row = 2; row <= sheet.rowCount; row += 1) expect(sheet.getCell(`W${row}`).value).toBeNull();
            }
            extracted = JSON.stringify(cells) + "\n" + xmlContents(buffer);
          }
          for (const marker of markers) expect(extracted).not.toContain(marker);
          expect(extracted).toContain("Fixture export M11");
          writeFileSync(resolve(folder, `${role}-${request.mode}.${request.format === "pdf" ? "pdf" : "xlsx"}`), buffer);
          writeFileSync(resolve(folder, `${role}-${request.mode}-extraction.txt`), extracted);
        }
        expect(await fingerprint()).toBe(before);
        writeFileSync(resolve(folder, role + "-privacy-results.json"), JSON.stringify({ role, modes: ["PDF", "DAY", "MONTH", "RANGE"], markers, niAbsent: true, ncPreserved: true, businessUnchanged: true }, null, 2));
      } finally {
        for (const reservation of reservations) await cancelReservation(page.request, reservation);
        await database.end();
      }
    });
  }
  test("serializza i submit concorrenti e sblocca il pannello dopo success e failure", async ({
    page,
  }) => {
    await login(page, "STAFF");

    const releases: Array<() => void> = [];
    const outcomes = [200, 500, 200];
    let intercepted = 0;
    let requestCount = 0;
    page.on("request", (request) => {
      if (/\/api\/staff\/exports\/(?:pdf|excel)$/u.test(request.url())) {
        requestCount += 1;
      }
    });
    await page.route("**/api/staff/exports/**", async (route) => {
      const requestIndex = intercepted;
      intercepted += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      const status = outcomes[requestIndex] ?? 500;
      await route.fulfill({
        status,
        contentType: status === 200 ? "application/pdf" : "application/json",
        headers: status === 200
          ? { "Content-Disposition": 'attachment; filename="synthetic.pdf"' }
          : undefined,
        body: status === 200
          ? "%PDF-synthetic-M11"
          : JSON.stringify({ error: "Errore sintetico M11" }),
      });
    });

    await page.goto(`/dashboard?date=${exportDate}`);
    const panelButtons = page.getByTestId("legacy-export-downloads").locator("button");
    const pdfButton = panelButtons.nth(0);
    const dayButton = panelButtons.nth(1);

    await pdfButton.click();
    await expect.poll(() => requestCount).toBe(1);
    await dayButton.dispatchEvent("click");
    await pdfButton.dispatchEvent("click");
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(requestCount).toBe(1);
    await expect(pdfButton).toBeDisabled();
    await expect(dayButton).toBeDisabled();

    const firstDownload = page.waitForEvent("download");
    releases.shift()?.();
    await firstDownload;
    await expect(pdfButton).toBeEnabled();
    await expect(dayButton).toBeEnabled();

    await dayButton.click();
    await expect.poll(() => requestCount).toBe(2);
    await pdfButton.dispatchEvent("click");
    await dayButton.dispatchEvent("click");
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(requestCount).toBe(2);
    releases.shift()?.();
    await expect(page.getByTestId("export-error")).toContainText("Errore sintetico M11");
    await expect(pdfButton).toBeEnabled();
    await expect(dayButton).toBeEnabled();

    const finalDownload = page.waitForEvent("download");
    await pdfButton.click();
    await expect.poll(() => requestCount).toBe(3);
    releases.shift()?.();
    await finalDownload;
    await expect(pdfButton).toBeEnabled();
    await expect(dayButton).toBeEnabled();
  });

  test("Staff scarica e apre il PDF reale della data dashboard", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, "STAFF");
    const lastName = `PdfExport${Date.now()}`;
    const reservation = await createReservation(page.request, lastName);

    try {
      await page.goto(`/dashboard?date=${exportDate}`);
      const responsePromise = page.waitForResponse(
        (response) => response.url().endsWith("/api/staff/exports/pdf"),
      );
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "PDF giornata completa" }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const download = await downloadPromise;
      expect(response.headers()["content-type"]).toBe("application/pdf");
      expect(response.headers()["cache-control"]).toContain("private, no-store");
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
      expect(download.suggestedFilename()).toBe(
        `piccadilly-prenotazioni-${exportDate}.pdf`,
      );
      const buffer = await downloadBuffer(download);
      expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
      const text = await pdfText(buffer);
      expect(text.replace(/\s/gu, "")).toContain(lastName);
      expect(text).toContain("Pranzo e cena");
      expect(text).toContain("DA ASSEGNARE");
      expect(text).toContain("Cena");
    } finally {
      await cancelReservation(page.request, reservation);
    }
  });

  test("Admin scarica DAY, MONTH e RANGE reali e vede l'errore RANGE a 32 giorni", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await login(page, "ADMIN");
    const lastName = `ExcelExport${Date.now()}`;
    const reservation = await createReservation(page.request, lastName);

    try {
      await page.goto(`/dashboard?date=${exportDate}`);
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 820, height: 1000 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(page.getByTestId("export-panel")).toBeVisible();
        const overflow = await page.getByTestId("legacy-export-downloads").evaluate((panel) => {
          const panelRectangle = panel.getBoundingClientRect();
          const overflowingElements = [panel, ...panel.querySelectorAll<HTMLElement>("*")]
            .filter((element) => {
              const rectangle = element.getBoundingClientRect();
              return (
                rectangle.right > panelRectangle.right + 1 ||
                rectangle.left < panelRectangle.left - 1
              );
            })
            .map((element) => ({
              tag: element.tagName,
              testId: element.dataset.testid ?? null,
              className: element.className,
            }));

          return {
            overflowingElements,
            panelRight: panel.closest('[data-testid="export-panel"]')!.getBoundingClientRect().right,
            viewportWidth: window.innerWidth,
          };
        });
        expect(overflow.overflowingElements, JSON.stringify(overflow)).toEqual([]);
        expect(overflow.panelRight, JSON.stringify(overflow)).toBeLessThanOrEqual(
          overflow.viewportWidth + 1,
        );
      }

      const dayResponsePromise = page.waitForResponse(
        (response) => response.url().endsWith("/api/staff/exports/excel"),
      );
      const dayDownloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Excel giorno" }).click();
      const dayResponse = await dayResponsePromise;
      expect(dayResponse.status()).toBe(200);
      const dayDownload = await dayDownloadPromise;
      expect(dayDownload.suggestedFilename()).toBe(
        `piccadilly-prenotazioni-${exportDate}.xlsx`,
      );
      const dayWorkbook = new ExcelJS.Workbook();
      await dayWorkbook.xlsx.load(excelJsInput(await downloadBuffer(dayDownload)));
      expect(dayWorkbook.worksheets.map((sheet) => sheet.name)).toEqual([exportDate]);
      expect(dayWorkbook.getWorksheet(exportDate)?.getCell("E2").value).toBe(lastName);
      expect(dayWorkbook.getWorksheet(exportDate)?.getRow(1).cellCount).toBe(24);

      await page.getByLabel("Mese").fill("2099-12");
      const monthDownloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Excel mese" }).click();
      const monthWorkbook = new ExcelJS.Workbook();
      await monthWorkbook.xlsx.load(
        excelJsInput(await downloadBuffer(await monthDownloadPromise)),
      );
      expect(monthWorkbook.worksheets).toHaveLength(31);
      expect(monthWorkbook.worksheets[0]?.name).toBe("2099-12-01");
      expect(monthWorkbook.worksheets[30]?.name).toBe("2099-12-31");

      await page.getByLabel("Data iniziale").fill("2099-12-01");
      await page.getByLabel("Data finale").fill("2099-12-31");
      const rangeDownloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Excel intervallo" }).click();
      const rangeWorkbook = new ExcelJS.Workbook();
      await rangeWorkbook.xlsx.load(
        excelJsInput(await downloadBuffer(await rangeDownloadPromise)),
      );
      expect(rangeWorkbook.worksheets).toHaveLength(31);

      let unexpectedDownload = false;
      page.once("download", () => {
        unexpectedDownload = true;
      });
      await page.getByLabel("Data finale").fill("2100-01-01");
      const errorResponsePromise = page.waitForResponse(
        (response) => response.url().endsWith("/api/staff/exports/excel"),
      );
      await page.getByRole("button", { name: "Excel intervallo" }).click();
      expect((await errorResponsePromise).status()).toBe(422);
      await expect(page.getByTestId("export-error")).toContainText(
        "al massimo 31 giorni",
      );
      expect(unexpectedDownload).toBe(false);
    } finally {
      await cancelReservation(page.request, reservation);
    }
  });

  test("nega richieste anonime/cross-origin e rifiuta contratti HTTP non validi", async ({
    page,
  }) => {
    const anonymous = await page.request.post("/api/staff/exports/pdf", {
      headers: { origin },
      data: { date: exportDate },
    });
    expect(anonymous.status()).toBe(401);

    await login(page, "STAFF");
    const wrongOrigin = await page.request.post("/api/staff/exports/pdf", {
      headers: { origin: "https://evil.example" },
      data: { date: exportDate },
    });
    expect(wrongOrigin.status()).toBe(403);

    const wrongContentType = await page.request.post("/api/staff/exports/pdf", {
      headers: { origin, "content-type": "text/plain" },
      data: JSON.stringify({ date: exportDate }),
    });
    expect(wrongContentType.status()).toBe(400);
    await expect(wrongContentType.json()).resolves.toMatchObject({
      code: "INVALID_EXPORT_REQUEST",
    });

    const malformed = await page.request.post("/api/staff/exports/excel", {
      headers: { origin, "content-type": "application/json" },
      data: "{",
    });
    expect(malformed.status()).toBe(400);

    const extraFields = await page.request.post("/api/staff/exports/excel", {
      headers: { origin },
      data: {
        mode: "DAY",
        date: exportDate,
        restaurantId: "00000000-0000-4000-8000-000000000000",
        actorUserId: "00000000-0000-4000-8000-000000000000",
        correlationId: "00000000-0000-4000-8000-000000000000",
      },
    });
    expect(extraFields.status()).toBe(400);
    await expect(extraFields.json()).resolves.toMatchObject({
      code: "INVALID_EXPORT_REQUEST",
    });
  });
});
