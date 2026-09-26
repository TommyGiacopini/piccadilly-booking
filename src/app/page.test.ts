import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "@/app/page";

describe("T01 root", () => {
  it("replaces the technical landing with the approved booking entry points", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain("Prenotazioni Piccadilly");
    expect(markup).toContain("Prenota online oppure accedi all’area riservata.");
    expect(markup).toContain('href="/prenota"');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain("piccadilly-wordmark-white.png");
    expect(markup).not.toContain("M1 / Fondamenta");
    expect(markup).not.toContain("Next.js App Router");
  });
});
