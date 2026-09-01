import { defineConfig, devices } from "@playwright/test";

import { resolveStagingPlaywrightEnvironment } from "./tests/staging/environment";

const staging = resolveStagingPlaywrightEnvironment(process.env);

export default defineConfig({
  testDir: "./tests/staging",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: staging.baseURL,
    httpCredentials: staging.basicAuth,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
