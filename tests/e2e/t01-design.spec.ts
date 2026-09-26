import "dotenv/config";

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eStaffUsername,
} from "./e2e-run";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variabile E2E ${name} non configurata.`);
  return value;
}

const evidenceDirectory = resolve("test-results/t01-evidence");
const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");
const adminPassword = requiredEnvironment("AUTH_DEMO_ADMIN_PASSWORD");
const responsiveLongLastName =
  "ResponsiveLongContentABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop";

mkdirSync(evidenceDirectory, { recursive: true });

async function screenshot(page: Page, filename: string) {
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: resolve(evidenceDirectory, filename),
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

async function collectHorizontalOverflowDiagnostics(page: Page) {
  return page.evaluate(() => {
    function selectorPath(element: Element): string {
      const segments: string[] = [];
      let current: Element | null = element;

      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        const siblings = parent
          ? Array.from(parent.children).filter(
              (sibling: Element) => sibling.tagName === current?.tagName,
            )
          : [];
        const index = siblings.indexOf(current);
        segments.unshift(
          `${current.tagName.toLowerCase()}${
            current.id ? `#${current.id}` : index > 0 ? `:nth-of-type(${index + 1})` : ""
          }`,
        );
        current = parent;
      }

      return segments.join(" > ");
    }

    const viewportWidth = window.innerWidth;
    const overflowingElements = Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const parentStyle = element.parentElement
          ? window.getComputedStyle(element.parentElement)
          : null;

        return {
          selector: selectorPath(element),
          left: rectangle.left,
          right: rectangle.right,
          width: rectangle.width,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          whiteSpace: style.whiteSpace,
          overflowX: style.overflowX,
          overflowWrap: style.overflowWrap,
          wordBreak: style.wordBreak,
          parentDisplay: parentStyle?.display ?? null,
          parentFlexDirection: parentStyle?.flexDirection ?? null,
          parentFlexWrap: parentStyle?.flexWrap ?? null,
          parentGridTemplateColumns: parentStyle?.gridTemplateColumns ?? null,
          text: element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 180) ?? "",
          element,
        };
      })
      .filter(({ left, right }) => left < 0 || right > viewportWidth + 0.5)
      .map(({ element, ...measurement }) => ({
        ...measurement,
        descendants: Array.from(element.querySelectorAll("*"))
          .map((descendant) => {
            const rectangle = descendant.getBoundingClientRect();
            const style = window.getComputedStyle(descendant);
            const parentStyle = descendant.parentElement
              ? window.getComputedStyle(descendant.parentElement)
              : null;

            return {
              selector: selectorPath(descendant),
              width: rectangle.width,
              clientWidth: descendant.clientWidth,
              scrollWidth: descendant.scrollWidth,
              minWidth: style.minWidth,
              maxWidth: style.maxWidth,
              whiteSpace: style.whiteSpace,
              overflowX: style.overflowX,
              overflowWrap: style.overflowWrap,
              wordBreak: style.wordBreak,
              display: style.display,
              flexBasis: style.flexBasis,
              flexShrink: style.flexShrink,
              parentDisplay: parentStyle?.display ?? null,
              parentFlexWrap: parentStyle?.flexWrap ?? null,
              parentGridTemplateColumns: parentStyle?.gridTemplateColumns ?? null,
              text:
                descendant.children.length === 0
                  ? descendant.textContent?.trim().replace(/\s+/gu, " ").slice(0, 180) ?? ""
                  : "",
            };
          })
          .filter(
            ({ display, scrollWidth, clientWidth, text }) =>
              display === "flex" ||
              display === "grid" ||
              scrollWidth > clientWidth ||
              text.length > 0,
          ),
      }));

    return {
      viewportWidth,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportScale: window.visualViewport?.scale ?? null,
      devicePixelRatio: window.devicePixelRatio,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowingElements,
    };
  });
}

async function recordResponsiveMetrics(page: Page, label: string) {
  const diagnostics = await collectHorizontalOverflowDiagnostics(page);
  console.info(
    `T01_RESPONSIVE_METRICS ${JSON.stringify({ label, ...diagnostics })}`,
  );
  expect(diagnostics.documentScrollWidth).toBeLessThanOrEqual(
    diagnostics.viewportWidth,
  );
  expect(diagnostics.bodyScrollWidth).toBeLessThanOrEqual(
    diagnostics.viewportWidth,
  );
  return diagnostics;
}

async function login(
  page: Page,
  role: "ADMIN" | "STAFF",
): Promise<void> {
  await page.goto("/login");
  await page
    .getByLabel("Username")
    .fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page
    .getByLabel("Password")
    .fill(role === "ADMIN" ? adminPassword : staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
}

async function createResponsiveLongContentReservation(page: Page) {
  const localDate = await page.getByLabel("Seleziona data").inputValue();
  const response = await page.request.post("/api/staff/reservations", {
    headers: {
      origin: new URL(page.url()).origin,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      localDate,
      serviceType: "DINNER",
      arrivalTime: "19:00",
      partySize: 2,
      roomCode: "sala-1",
      customerFirstName: e2eReservationFirstName,
      customerLastName: responsiveLongLastName,
      customerPhone: "+39000000000",
      customerEmail: null,
      highChair: false,
      stroller: false,
      accessibility: false,
      children: false,
      celiac: false,
      allergies: null,
      intolerances: null,
      celebration: null,
      animals: false,
      notes: null,
      verbalConsentConfirmed: true,
      sendWhatsAppConfirmation: false,
      capacityOverride: false,
      capacityOverrideReason: null,
    },
  });

  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { reservation: { id: string } };
  return {
    id: body.reservation.id,
    fullName: `${e2eReservationFirstName} ${responsiveLongLastName}`,
  };
}

test.describe.serial("T01 design foundations, auth e shell", () => {
  test("root e login rispettano copy, asset, accessibilità e loading", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Prenotazioni Piccadilly" }),
    ).toBeVisible();
    await expect(
      page.getByText("Prenota online oppure accedi all’area riservata."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Prenota un tavolo" }),
    ).toHaveAttribute("href", "/prenota");
    const staffAreaLink = page.getByRole("link", { name: "Area Staff" });
    await expect(staffAreaLink).toHaveAttribute("href", "/login");
    await expect(staffAreaLink).toHaveCSS("color", "rgb(247, 243, 239)");
    await expect(
      page.locator('img[src*="piccadilly-wordmark-white"]'),
    ).toHaveCount(1);
    await expect(page.getByText("M1 / Fondamenta")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "root-1440x900.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "root-390x844.png");

    await page.setViewportSize({ width: 320, height: 640 });
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Area Staff" })).toBeVisible();
    await expect(
      page.getByText("Accedi per gestire le prenotazioni."),
    ).toBeVisible();
    await screenshot(page, "login-1280x720.png");

    const password = page.getByLabel("Password");
    await password.fill("Password fittizia T01");
    await expect(password).toHaveAttribute("type", "password");
    const showPassword = page.getByRole("button", { name: "Mostra contenuto" });
    await showPassword.focus();
    await page.keyboard.press("Enter");
    await expect(password).toHaveAttribute("type", "text");
    await page.getByLabel("Username").fill("e2e.loading.t01");

    await page.evaluate(() => {
      window.HTMLFormElement.prototype.submit = () => undefined;
    });
    await page.getByRole("button", { name: "Accedi" }).click();
    await expect(
      page.getByRole("button", { name: "Accesso in corso…" }),
    ).toBeDisabled();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "login-390x844.png");
    await page.getByLabel("Username").fill(e2eStaffUsername);
    await page.getByLabel("Password").fill("Password non valida T01");
    await page.getByRole("button", { name: "Accedi" }).click();
    await expect(
      page.getByText("Nome utente o password non corretti.", { exact: true }),
    ).toBeVisible();
  });

  test("shell Staff è responsive, attiva e gestisce il drawer da tastiera", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, "STAFF");
    const longReservation = await createResponsiveLongContentReservation(page);
    await page.reload();

    const staffNavigation = page.getByRole("navigation", {
      name: "Navigazione area Staff",
    });
    await expect(staffNavigation.getByRole("link", { name: "Agenda" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      staffNavigation.getByRole("link", { name: "Nuova prenotazione" }),
    ).toBeVisible();
    await expect(staffNavigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await recordResponsiveMetrics(page, "1280x720");
    await screenshot(page, "dashboard-shell-1280x720.png");

    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.getByTestId("staff-sidebar")).toHaveCSS("width", "72px");
    await expectNoHorizontalOverflow(page);
    await recordResponsiveMetrics(page, "820x1180");
    await screenshot(page, "dashboard-rail-820x1180.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Apri navigazione" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await recordResponsiveMetrics(page, "390x844");
    await screenshot(page, "dashboard-shell-390x844.png");

    const menuButton = page.getByRole("button", { name: "Apri navigazione" });
    await menuButton.click();
    const drawer = page.getByRole("dialog", { name: "Menu area Staff" });
    const closeButton = drawer.getByRole("button", { name: "Chiudi menu" });
    await expect(closeButton).toBeFocused();
    await screenshot(page, "dashboard-drawer-390x844.png");

    const drawerLogout = drawer.getByRole("button", { name: "Logout" });
    await drawerLogout.focus();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(menuButton).toBeFocused();

    await page.setViewportSize({ width: 320, height: 640 });
    console.info(
      `T01_320_OVERFLOW_DIAGNOSTICS ${JSON.stringify(
        await collectHorizontalOverflowDiagnostics(page),
      )}`,
    );
    await expectNoHorizontalOverflow(page);
    await recordResponsiveMetrics(page, "320x640-long-content");
    const longContentCard = page.locator(
      `article[data-reservation-id="${longReservation.id}"]`,
    );
    await expect(longContentCard).toContainText(longReservation.fullName);
    await expect(
      longContentCard.getByRole("button", { name: "Assegna sala e tavoli" }),
    ).toBeVisible();
    await expect(
      longContentCard.getByRole("link", { name: "Modifica" }),
    ).toBeVisible();
    await expect(
      longContentCard.getByRole("button", { name: "Cancella" }),
    ).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNoHorizontalOverflow(page);
    await recordResponsiveMetrics(page, "1440x900");

    const chromiumSession = await page.context().newCDPSession(page);
    await page.setViewportSize({ width: 640, height: 450 });
    await chromiumSession.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: 2,
    });
    const zoomMetrics = await recordResponsiveMetrics(
      page,
      "200%-scale-effective-640px",
    );
    expect(zoomMetrics.visualViewportScale).toBe(2);
    await chromiumSession.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: 1,
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("shell Admin mantiene il permission gating server e UI", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, "ADMIN");

    const navigation = page.getByRole("navigation", {
      name: "Navigazione area Staff",
    });
    await expect(
      navigation.getByRole("link", { name: "Configurazioni" }),
    ).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Admin" })).toBeVisible();
    await navigation.getByRole("link", { name: "Admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { name: "Area tecnica ADMIN" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "admin-shell-1280x720.png");
  });
});
