import { afterEach, describe, expect, it } from "vitest";

import robots from "@/app/robots";

const originalAppEnvironment = process.env.APP_ENV;

afterEach(() => {
  if (originalAppEnvironment === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = originalAppEnvironment;
});

describe("M13 robots", () => {
  it("disallows all crawling only in staging", () => {
    process.env.APP_ENV = "staging";
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    process.env.APP_ENV = "development";
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/" } });
  });
});
