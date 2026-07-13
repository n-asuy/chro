// One-off verification config: reuse the app's vite config but rewrite the
// Origin header sent to the backend so an isolated dev server (port 3457)
// passes the backend's allowed-origins check (which only permits :3400).
// CHRO_VERIFY_BACKEND_PORT additionally redirects the proxy to an isolated
// backend instead of the port recorded in $TMPDIR/chro/chro.port.
import config from "../vite.config";

type ProxyEntry = { headers?: Record<string, string>; target?: string };

const backendPort = process.env.CHRO_VERIFY_BACKEND_PORT;
const server = (config as { server?: { proxy?: Record<string, unknown> } })
  .server;
for (const value of Object.values(server?.proxy ?? {})) {
  if (typeof value === "object" && value !== null) {
    const entry = value as ProxyEntry;
    entry.headers = { ...entry.headers, origin: "http://localhost:3400" };
    if (backendPort) {
      entry.target = `http://127.0.0.1:${backendPort}`;
    }
  }
}

export default config;
