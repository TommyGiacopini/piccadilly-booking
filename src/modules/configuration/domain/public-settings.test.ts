import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  managementLinkDurationMutationSchema,
  publicContactsSchema,
  publicContentSetSchema,
  resolvePublicLocale,
} from "@/modules/configuration/domain/public-settings";

function contentSet(text = "Testo dimostrativo") {
  const locale = {
    BOOKING_PAGE_TITLE: text,
    BOOKING_PAGE_INTRO: text,
    UNAVAILABLE_MESSAGE: text,
    CONTACT_PROMPT: text,
    CONFIRMATION_MESSAGE: text,
    MANAGEMENT_PAGE_TITLE: text,
    MANAGEMENT_PAGE_INTRO: text,
  };
  return { IT: { ...locale }, EN: { ...locale } };
}

describe("public contacts validation", () => {
  it.each(["+39000000", "+123456789012345"])(
    "accepts canonical E.164 value %s",
    (publicPhone) => {
      expect(
        publicContactsSchema.parse({
          publicPhone,
          publicBookingBaseUrl: "https://PRENOTA.example.test",
          publicEmail: "Demo@EXAMPLE.TEST",
          whatsappNumber: "+390000000001",
        }),
      ).toEqual({
        publicPhone,
        publicBookingBaseUrl: "https://prenota.example.test/",
        publicEmail: "Demo@example.test",
        whatsappNumber: "+390000000001",
      });
    },
  );

  it.each([
    "+1234567",
    "+1234567890123456",
    "390000000000",
    "+39 0000000000",
    "+390000000000 interno 2",
  ])("rejects invalid phone %s", (publicPhone) => {
    expect(
      publicContactsSchema.safeParse({
        publicPhone,
        publicBookingBaseUrl: "https://prenota.example.test/",
        publicEmail: "",
        whatsappNumber: "",
      }).success,
    ).toBe(false);
  });

  it("normalizes empty optional contacts to null", () => {
    expect(
      publicContactsSchema.parse({
        publicPhone: "+390000000000",
        publicBookingBaseUrl: "https://prenota.example.test/",
        publicEmail: "",
        whatsappNumber: "",
      }),
    ).toMatchObject({ publicEmail: null, whatsappNumber: null });
  });

  it.each([
    "http://prenota.example.test/",
    "https://user:pass@prenota.example.test/",
    "https://prenota.example.test/path",
    "https://prenota.example.test/?query=1",
    "https://prenota.example.test/#fragment",
  ])("rejects unsafe canonical URL %s", (publicBookingBaseUrl) => {
    expect(
      publicContactsSchema.safeParse({
        publicPhone: "+390000000000",
        publicBookingBaseUrl,
        publicEmail: "demo@example.test",
        whatsappNumber: null,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid email and WhatsApp", () => {
    expect(
      publicContactsSchema.safeParse({
        publicPhone: "+390000000000",
        publicBookingBaseUrl: "https://prenota.example.test/",
        publicEmail: "not-an-email",
        whatsappNumber: "+39 invalid",
      }).success,
    ).toBe(false);
  });

  it("normalizes only the email domain and preserves the local part exactly", () => {
    expect(
      publicContactsSchema.parse({
        publicPhone: "+390000000000",
        publicBookingBaseUrl: "https://prenota.example.test/",
        publicEmail: "Demo.User+Test@EXAMPLE.TEST",
        whatsappNumber: null,
      }).publicEmail,
    ).toBe("Demo.User+Test@example.test");
  });

  it("does not trim or truncate email input and rejects more than 254 characters", () => {
    const tooLong = `${"A".repeat(243)}@EXAMPLE.TEST`;
    expect(tooLong).toHaveLength(256);
    for (const publicEmail of [" Demo.User@EXAMPLE.TEST", `${tooLong}`]) {
      expect(
        publicContactsSchema.safeParse({
          publicPhone: "+390000000000",
          publicBookingBaseUrl: "https://prenota.example.test/",
          publicEmail,
          whatsappNumber: null,
        }).success,
      ).toBe(false);
    }
  });
});

describe("public editorial content validation", () => {
  it("counts Unicode code points and accepts exact title/text limits", () => {
    const contents = contentSet("😀".repeat(120));
    contents.IT.BOOKING_PAGE_INTRO = "à".repeat(1_000);
    expect(publicContentSetSchema.safeParse(contents).success).toBe(true);
  });

  it("normalizes only CRLF and preserves newlines", () => {
    const contents = contentSet();
    contents.IT.CONTACT_PROMPT = "Riga uno\r\nRiga due";
    expect(publicContentSetSchema.parse(contents).IT.CONTACT_PROMPT).toBe(
      "Riga uno\nRiga due",
    );
  });

  it.each(["", "a".repeat(121)])("rejects invalid title length", (title) => {
    const contents = contentSet();
    contents.IT.BOOKING_PAGE_TITLE = title;
    expect(publicContentSetSchema.safeParse(contents).success).toBe(false);
  });

  it.each([
    "test\u0000",
    "test\u0007",
    "visita https://example.test",
    "scrivi mailto:demo@example.test",
    "javascript:alert(1)",
  ])(
    "rejects controls and arbitrary URLs",
    (value) => {
      const contents = contentSet();
      contents.EN.BOOKING_PAGE_INTRO = value;
      expect(publicContentSetSchema.safeParse(contents).success).toBe(false);
    },
  );

  it("renders HTML-like input as inert text", () => {
    const htmlLike = '<img src=x onerror="globalThis.pwned=true">';
    const contents = contentSet(htmlLike);
    const parsed = publicContentSetSchema.parse(contents);
    const markup = renderToStaticMarkup(
      createElement("p", null, parsed.IT.BOOKING_PAGE_INTRO),
    );
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
  });

  it("rejects arbitrary locale and content keys", () => {
    expect(
      publicContentSetSchema.safeParse({
        ...contentSet(),
        FR: contentSet().IT,
      }).success,
    ).toBe(false);
    expect(
      publicContentSetSchema.safeParse({
        ...contentSet(),
        IT: { ...contentSet().IT, ARBITRARY: "no" },
      }).success,
    ).toBe(false);
  });
});

describe("public locale and duration", () => {
  it.each([
    [undefined, "it"],
    ["it", "it"],
    ["EN", "en"],
    ["fr", "it"],
  ])("resolves %s to %s", (value, expected) => {
    expect(resolvePublicLocale(value)).toBe(expected);
  });

  it.each([1, 24])("accepts duration boundary %s", (duration) => {
    expect(
      managementLinkDurationMutationSchema.safeParse({
        fingerprint: "a".repeat(64),
        managementLinkDurationHours: duration,
      }).success,
    ).toBe(true);
  });

  it.each([0, 25, 1.5, "12"])("rejects invalid duration %s", (duration) => {
    expect(
      managementLinkDurationMutationSchema.safeParse({
        fingerprint: "a".repeat(64),
        managementLinkDurationHours: duration,
      }).success,
    ).toBe(false);
  });
});
