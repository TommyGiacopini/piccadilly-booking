import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicContactLinks } from "@/app/_components/public-contact-links";

describe("public contact links", () => {
  it("always shows phone and omits optional email and WhatsApp", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicContactLinks, {
        contacts: {
          publicPhone: "+390000000000",
          publicBookingBaseUrl: "https://prenota.example.test/",
          publicEmail: null,
          whatsappNumber: null,
        },
        language: "it",
      }),
    );
    expect(markup).toContain('href="tel:+390000000000"');
    expect(markup).not.toContain("mailto:");
    expect(markup).not.toContain("wa.me");
  });

  it("uses explicit links without messages or automatic actions", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicContactLinks, {
        contacts: {
          publicPhone: "+390000000000",
          publicBookingBaseUrl: "https://prenota.example.test/",
          publicEmail: "demo@example.test",
          whatsappNumber: "+390000000001",
        },
        language: "en",
      }),
    );
    expect(markup).toContain('href="mailto:demo@example.test"');
    expect(markup).toContain('href="https://wa.me/390000000001"');
    expect(markup).not.toContain("?text=");
  });
});
