import { expect, test, type WebSocket as PWWebSocket } from "@playwright/test";

/**
 * Regression: a project tab whose project no longer exists in the DB used to
 * open `/streams/tasks?project_id=<id>`, get the handshake rejected, and
 * reconnect forever — one storm per dangling tab. The registry now gives up
 * after a bounded number of never-connected attempts, while a live project's
 * stream still connects. Unit contract: json-patch-stream-registry.test.ts
 * (MAX_INITIAL_CONNECT_ATTEMPTS); server returns 404 (not 500) for the unknown
 * id (crates/server/src/errors.rs).
 *
 * Self-seeding so it runs against a fresh CI database.
 */

// Stable phantom ids (not in the DB) so re-runs are deterministic.
const DANGLING_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];
const MAX_ATTEMPTS = 5; // mirrors MAX_INITIAL_CONNECT_ATTEMPTS
const GIVE_UP_BUDGET_MS = 30_000; // 1+2+4+8+8s of backoff + slack
const QUIET_WINDOW_MS = 8_000;

test("a dangling project tab does not storm the server with reconnects", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(90_000);

  // Seed a live project so the live-vs-dangling contrast is exercised end to end.
  const ensure = await request.post(`${baseURL}/rpc/projects/ensure`, {
    data: { git_repo_path: process.cwd(), name: "ws-reconnect-live" },
  });
  expect(ensure.ok()).toBeTruthy();
  const liveProject = (await ensure.json()).project as {
    id: string;
    slug: string;
    git_repo_path: string;
  };

  const tabs = [
    {
      id: liveProject.id,
      name: "ws-reconnect-live",
      slug: liveProject.slug,
      workspacePath: liveProject.git_repo_path,
    },
    ...DANGLING_IDS.map((id, i) => ({
      id,
      name: `ghost-${i}`,
      slug: id.slice(0, 8),
      workspacePath: `/tmp/does-not-exist-${i}`,
    })),
  ];
  const allIds = [liveProject.id, ...DANGLING_IDS];
  await request.put(`${baseURL}/rpc/ui-state`, {
    data: {
      "chro.openProjectTabs": tabs,
      "chro.activeProjectWorkspace": liveProject.git_repo_path,
      "chro:setup-onboarding-complete": true,
      "workspace-layout:project-tree-expanded:v1": {
        version: 1,
        expandedProjectIds: allIds,
        knownProjectIds: allIds,
      },
    },
  });

  const t0 = Date.now();
  const attempts = new Map<string, number[]>(); // project_id -> open timestamps
  for (const id of allIds) attempts.set(id, []);

  page.on("websocket", (ws: PWWebSocket) => {
    const m = /\/streams\/tasks\?project_id=([0-9a-f-]+)/.exec(ws.url());
    if (m) attempts.get(m[1])?.push(Date.now() - t0);
  });

  await page.goto(`/projects/${liveProject.slug}/session/`);

  // Let the give-up window fully elapse, then watch a quiet window for any
  // further reconnect attempts.
  await page.waitForTimeout(GIVE_UP_BUDGET_MS);
  const beforeQuiet = new Map([...attempts].map(([id, ts]) => [id, ts.length]));
  await page.waitForTimeout(QUIET_WINDOW_MS);

  for (const id of allIds) {
    const ts = attempts.get(id) ?? [];
    const inQuiet = ts.length - (beforeQuiet.get(id) ?? 0);
    console.log(
      `${id === liveProject.id ? "LIVE  " : "DANGLE"} ${id} attempts=${ts.length} duringQuietWindow=${inQuiet}`,
    );
  }

  // The live project connects (and is exempt from the give-up cap).
  expect((attempts.get(liveProject.id) ?? []).length).toBeGreaterThanOrEqual(1);

  for (const id of DANGLING_IDS) {
    const ts = attempts.get(id) ?? [];
    // Bounded total attempts: initial + at most MAX_ATTEMPTS retries.
    expect(ts.length).toBeLessThanOrEqual(MAX_ATTEMPTS + 1);
    // No new attempts after the give-up budget: the storm has stopped.
    const inQuiet = ts.length - (beforeQuiet.get(id) ?? 0);
    expect(inQuiet).toBe(0);
  }
});
