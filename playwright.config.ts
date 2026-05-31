import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.CHRO_E2E_PORT ?? 4399);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env.CHRO_E2E_DB_PATH ?? ".e2e-tmp/chro.sqlite";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: [
      "bun run --filter=@chro/desktop build",
      `cargo run --manifest-path crates/server/Cargo.toml --bin chro-server -- --port ${PORT} --no-open --db-path ${DB_PATH}`,
    ].join(" && "),
    url: `${BASE_URL}/health`,
    timeout: 600_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
