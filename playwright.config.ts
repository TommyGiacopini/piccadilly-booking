import { defineConfig, devices } from "@playwright/test";

const usesExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: usesExternalServer
    ? undefined
    : {
        command: "node node_modules/next/dist/bin/next start -p 4000",
        url: "http://127.0.0.1:4000/api/health",
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
