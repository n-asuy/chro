import {
  createLogger,
  defineConfig,
  type Logger,
  type Plugin,
  type ProxyOptions,
} from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ServerResponse } from "node:http";

const DEFAULT_BACKEND_PORT = 4310;
const BACKEND_PROXY_LOG_WINDOW_MS = 5_000;
const NATIVE_FS_ADDON_PATH = path.resolve(
  __dirname,
  ".native/chro-filesystem.node",
);
const NATIVE_PROJECT_RPC_PATTERN = /^\/rpc\/projects\/([^/]+)\/(entries|file)$/;
const nativeFsEnabled = process.env.CHRO_ENABLE_NAPI_FS !== "0";
const perfEnabled =
  process.env.CHRO_PERF === "1" || process.argv.includes("--perf");
const packageJsonPath = path.resolve(__dirname, "package.json");
const viteBaseLogger = createLogger();

type ProxyLogKind = "http" | "ws";
type ProxyLogState = {
  lastLoggedAt: number;
  suppressed: number;
};

const backendProxyLogState = new Map<ProxyLogKind, ProxyLogState>();

function resolveAppVersion(): string {
  const envVersion = process.env.VITE_APP_VERSION ?? process.env.APP_VERSION;
  if (typeof envVersion === "string" && envVersion.trim().length > 0) {
    return envVersion.trim();
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (
      typeof packageJson.version === "string" &&
      packageJson.version.trim().length > 0
    ) {
      return packageJson.version.trim();
    }
  } catch (error) {
    console.warn("[vite] Failed to resolve app version from package.json:", error);
  }

  return "0.0.0";
}

const appVersion = resolveAppVersion();

function parseBackendProxyError(message: string): {
  kind: ProxyLogKind;
  path: string | null;
  code: string;
} | null {
  const plain = message.replace(/\x1b\[[0-9;]*m/g, "");
  const isWsProxyError =
    plain.includes("ws proxy error") ||
    plain.includes("ws proxy socket error");
  const httpMatch = plain.match(/http proxy error[^:]*:([^\n]+)/);

  if (!isWsProxyError && !httpMatch) {
    return null;
  }

  const codeMatch = message.match(
    /\b(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT)\b/,
  );
  const code = codeMatch?.[1] ?? "unknown";

  if (isWsProxyError) {
    return { kind: "ws", path: null, code };
  }

  return {
    kind: "http",
    path: httpMatch![1] ?? null,
    code,
  };
}

function maybeSuppressBackendProxyError(message: string): boolean {
  const parsed = parseBackendProxyError(message);
  if (!parsed) {
    return false;
  }

  const isTransient = parsed.code !== "ECONNREFUSED";
  const now = Date.now();
  const previous = backendProxyLogState.get(parsed.kind);

  if (previous) {
    if (isTransient) {
      // Transient errors (ECONNRESET, EPIPE, etc.): suppress after the first log
      return true;
    }
    if (now - previous.lastLoggedAt < BACKEND_PROXY_LOG_WINDOW_MS) {
      previous.suppressed += 1;
      return true;
    }
  }

  const port = readBackendPort();
  const pathSuffix =
    parsed.kind === "http" && parsed.path ? ` for ${parsed.path}` : "";
  const suppressed = previous?.suppressed ?? 0;

  if (isTransient) {
    viteBaseLogger.warn(
      `[vite] ${parsed.kind} proxy: connection reset (${parsed.code}) — backend http://127.0.0.1:${port}${pathSuffix}; further occurrences suppressed`,
    );
  } else if (suppressed > 0) {
    viteBaseLogger.warn(
      `[vite] ${parsed.kind} proxy error (${parsed.code}): backend http://127.0.0.1:${port} is still unavailable${pathSuffix}; suppressed ${suppressed} repeated logs in the last ${Math.round(BACKEND_PROXY_LOG_WINDOW_MS / 1000)}s`,
    );
  } else {
    viteBaseLogger.warn(
      `[vite] ${parsed.kind} proxy error (${parsed.code}): backend http://127.0.0.1:${port} is unavailable${pathSuffix}; suppressing repeated logs for ${Math.round(BACKEND_PROXY_LOG_WINDOW_MS / 1000)}s`,
    );
  }

  backendProxyLogState.set(parsed.kind, {
    lastLoggedAt: now,
    suppressed: 0,
  });
  return true;
}

const viteWarn: Logger["warn"] = (message, options) => {
  if (maybeSuppressBackendProxyError(message)) {
    return;
  }
  viteBaseLogger.warn(message, options);
};

const viteError: Logger["error"] = (message, options) => {
  if (maybeSuppressBackendProxyError(message)) {
    return;
  }
  viteBaseLogger.error(message, options);
};

const viteLogger: Logger = {
  ...viteBaseLogger,
  warn: viteWarn,
  error: viteError,
};

type NativeFilesystemAddon = {
  listWorkspaceEntries: (
    workspaceRoot: string,
    relativePath?: string | null,
    recursive?: boolean,
    includeHidden?: boolean,
  ) => string;
  readWorkspaceFile: (workspaceRoot: string, relativePath: string) => string;
};

type ProjectLookupResponse = {
  project?: {
    git_repo_path?: string;
    gitRepoPath?: string;
  };
};

type PreferencesResponse = {
  preferences?: {
    show_hidden_entries?: boolean;
  };
};

function readBackendPort(): number {
  const portFilePath = path.join(os.tmpdir(), "chro", "chro.port");
  try {
    const content = fs.readFileSync(portFilePath, "utf-8").trim();
    const port = parseInt(content, 10);
    return Number.isFinite(port) ? port : DEFAULT_BACKEND_PORT;
  } catch {
    return DEFAULT_BACKEND_PORT;
  }
}

function backendProxy(opts?: { ws?: boolean }): ProxyOptions {
  const port = readBackendPort();
  return {
    target: `http://127.0.0.1:${port}`,
    changeOrigin: true,
    ws: opts?.ws,
  };
}

function loadNativeFilesystemAddon(): NativeFilesystemAddon | null {
  if (!nativeFsEnabled) {
    return null;
  }

  if (!fs.existsSync(NATIVE_FS_ADDON_PATH)) {
    console.warn(
      "[vite:napi-fs] Native addon not found, falling back to HTTP proxy:",
      NATIVE_FS_ADDON_PATH,
    );
    return null;
  }

  try {
    const require = createRequire(import.meta.url);
    const addon = require(NATIVE_FS_ADDON_PATH) as Partial<NativeFilesystemAddon>;

    if (
      typeof addon.listWorkspaceEntries !== "function" ||
      typeof addon.readWorkspaceFile !== "function"
    ) {
      console.warn(
        "[vite:napi-fs] Native addon loaded but required exports are missing.",
      );
      return null;
    }

    return addon as NativeFilesystemAddon;
  } catch (error) {
    console.warn(
      "[vite:napi-fs] Failed to load native addon, falling back to HTTP proxy:",
      error,
    );
    return null;
  }
}

async function resolveProjectWorkspacePath(
  projectId: string,
  cache: Map<string, string>,
): Promise<string | null> {
  const cached = cache.get(projectId);
  if (cached) {
    return cached;
  }

  const backendPort = readBackendPort();
  const response = await fetch(
    `http://127.0.0.1:${backendPort}/rpc/projects/${encodeURIComponent(projectId)}`,
  );
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as ProjectLookupResponse;
  const workspacePath =
    body.project?.git_repo_path ?? body.project?.gitRepoPath ?? null;

  if (workspacePath) {
    cache.set(projectId, workspacePath);
  }
  return workspacePath;
}

const showHiddenCache = { value: false, expiresAt: 0 };
const SHOW_HIDDEN_CACHE_TTL_MS = 2_000;

async function resolveShowHiddenEntries(): Promise<boolean> {
  const now = Date.now();
  if (now < showHiddenCache.expiresAt) {
    return showHiddenCache.value;
  }
  const backendPort = readBackendPort();
  try {
    const response = await fetch(
      `http://127.0.0.1:${backendPort}/rpc/preferences`,
    );
    if (!response.ok) return showHiddenCache.value;
    const body = (await response.json()) as PreferencesResponse;
    const result = body.preferences?.show_hidden_entries === true;
    showHiddenCache.value = result;
    showHiddenCache.expiresAt = now + SHOW_HIDDEN_CACHE_TTL_MS;
    return result;
  } catch {
    return showHiddenCache.value;
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function nativeErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("NotFound") ||
    message.includes("WorkspaceMissing") ||
    message.includes("DirectoryDoesNotExist")
  ) {
    return 404;
  }
  if (
    message.includes("InvalidRelativePath") ||
    message.includes("OutsideWorkspace") ||
    message.includes("NotFile") ||
    message.includes("NotDirectory")
  ) {
    return 400;
  }
  return 500;
}

function nativeFilesystemPlugin(): Plugin {
  return {
    name: "chro-native-filesystem",
    apply: "serve",
    configureServer(server) {
      const addon = loadNativeFilesystemAddon();
      if (!addon) {
        return;
      }

      const projectPathCache = new Map<string, string>();

      server.middlewares.use((req, res, next) => {
        // Invalidate show_hidden_entries cache when preferences are updated
        if (req.method === "PUT" && req.url?.startsWith("/rpc/preferences")) {
          showHiddenCache.expiresAt = 0;
        }

        if (req.method !== "GET" || !req.url) {
          next();
          return;
        }

        const requestUrl = new URL(req.url, "http://localhost");
        const routeMatch = requestUrl.pathname.match(NATIVE_PROJECT_RPC_PATTERN);
        if (!routeMatch) {
          next();
          return;
        }

        const projectId = routeMatch[1];
        const resource = routeMatch[2];
        if (!projectId || !resource) {
          next();
          return;
        }

        void (async () => {
          const workspacePath = await resolveProjectWorkspacePath(
            projectId,
            projectPathCache,
          );
          if (!workspacePath) {
            next();
            return;
          }

          if (resource === "entries") {
            const relativePath = requestUrl.searchParams.get("relative_path");
            const recursive = requestUrl.searchParams.get("recursive") === "true";
            const includeHidden = await resolveShowHiddenEntries();
            const entriesJson = addon.listWorkspaceEntries(
              workspacePath,
              relativePath,
              recursive,
              includeHidden,
            );
            const entries = JSON.parse(entriesJson) as unknown[];
            writeJson(res, 200, { entries });
            return;
          }

          const relativePath = requestUrl.searchParams.get("relative_path");
          if (!relativePath || relativePath.trim().length === 0) {
            writeJson(res, 400, {
              error: "query parameter 'relative_path' is required",
            });
            return;
          }

          const fileJson = addon.readWorkspaceFile(workspacePath, relativePath);
          const file = JSON.parse(fileJson) as Record<string, unknown>;
          writeJson(res, 200, { file });
        })().catch((error) => {
          const status = nativeErrorStatus(error);
          const message = error instanceof Error ? error.message : String(error);
          if (status === 500) {
            console.warn(
              "[vite:napi-fs] Native handler failed, falling back to HTTP proxy:",
              error,
            );
            next();
            return;
          }
          writeJson(res, status, { error: message });
        });
      });
    },
  };
}

function perfLogDir(): string {
  if (process.env.CHRO_PERF_DIR) {
    return path.resolve(__dirname, process.env.CHRO_PERF_DIR);
  }
  // Resolve from project root (two levels up from apps/desktop)
  return path.resolve(__dirname, "../../log/performance");
}

const FRONTEND_MAX_LINES = 50_000;

function countLines(filePath: string): number {
  try {
    const buf = fs.readFileSync(filePath);
    let count = 0;
    for (const byte of buf) {
      if (byte === 0x0a) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function resolveFrontendLogPath(dir: string, date: string): string {
  const base = path.join(dir, `${date}_frontend.jsonl`);
  if (countLines(base) < FRONTEND_MAX_LINES) return base;

  for (let seg = 1; ; seg++) {
    const segPath = path.join(dir, `${date}_frontend.${seg}.jsonl`);
    if (!fs.existsSync(segPath) || countLines(segPath) < FRONTEND_MAX_LINES) {
      return segPath;
    }
  }
}

function perfPlugin(): Plugin {
  return {
    name: "chro-perf",
    configureServer(server) {
      server.middlewares.use("/perf/report", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const entries = JSON.parse(body) as Array<Record<string, unknown>>;
            const dir = perfLogDir();
            fs.mkdirSync(dir, { recursive: true });

            const date = new Date().toISOString().slice(0, 10);
            const filePath = resolveFrontendLogPath(dir, date);
            const lines =
              entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
            fs.appendFileSync(filePath, lines);

            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end("invalid json");
          }
        });
      });
    },
  };
}

export default defineConfig({
  customLogger: viteLogger,
  plugins: [
    nativeFilesystemPlugin(),
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    ...(perfEnabled ? [perfPlugin()] : []),
  ],
  define: {
    __PERF_ENABLED__: JSON.stringify(perfEnabled),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  base: "/",
  server: {
    port: 3400,
    strictPort: true,
    proxy: {
      "/rpc": backendProxy({ ws: true }),
      "/streams": backendProxy({ ws: true }),
      "/health": backendProxy(),
      "/sessions": backendProxy(),
      "/tasks": backendProxy(),
    },
  },
  build: {
    outDir: "dist-vite",
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
    entries: ["index.html", "src/**/*.{ts,tsx}"],
  },
});
