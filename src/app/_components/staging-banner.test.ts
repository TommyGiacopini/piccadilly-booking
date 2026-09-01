import { afterEach, describe, expect, it } from "vitest";

import { StagingBanner } from "@/app/_components/staging-banner";
import { STAGING_BANNER_TEXT } from "@/server/staging/access-gate";

const originalAppEnvironment = process.env.APP_ENV;

afterEach(() => {
  if (originalAppEnvironment === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = originalAppEnvironment;
});

describe("M13 staging banner", () => {
  it("is rendered only for APP_ENV=staging", () => {
    process.env.APP_ENV = "staging";
    expect(StagingBanner()).toMatchObject({ props: { children: STAGING_BANNER_TEXT } });
    process.env.APP_ENV = "development";
    expect(StagingBanner()).toBeNull();
    process.env.APP_ENV = "production";
    expect(StagingBanner()).toBeNull();
  });
});
