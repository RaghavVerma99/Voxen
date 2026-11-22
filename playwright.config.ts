import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const devCommand =
  process.platform === "win32"
    ? `npm.cmd run dev -- --hostname 127.0.0.1 --port ${port}`
    : `npm run dev -- --hostname 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: devCommand,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      OPENAI_API_KEY: "test-key-for-e2e",
      REQUIRE_ACCESS_CODE: "false",
      REALTIME_ENABLED: "true",
      WORKFLOW_ENABLED: "true",
    },
  },
});
