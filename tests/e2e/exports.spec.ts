import "dotenv/config";

import { expect, test, type APIRequestContext, type Download, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eRunId,
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
      roomCode: "sala-2",
      customerFirstName: e2eReservationFirstName,
      customerLastName: lastName,
      customerPhone: "+390000001111",
      customerEmail: null,
      highChair: true,
      stroller: false,
      accessibility: false,
      children: true,
      celiac: false,
      allergies: "Nessuna — àèéìòù",
      intolerances: null,
      celebration: "Compleanno fittizio",
      animals: false,
      notes: `Fixture export M11 ${e2eRunId}`,
      verbalConsentConfirmed: true,
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
    const panelButtons = page.getByTestId("export-panel").locator("button");
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
        const overflow = await page.getByTestId("export-panel").evaluate((panel) => {
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
            panelRight: panelRectangle.right,
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
