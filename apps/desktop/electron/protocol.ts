import fs from "node:fs";
import path from "node:path";
import { app, protocol, net } from "electron";

/**
 * Custom protocol scheme for serving Vite-built SPA in production.
 * Handles SPA routing by serving index.html for non-file paths.
 */
export const APP_PROTOCOL_SCHEME = "app";

/**
 * Register custom protocol scheme for production SPA serving.
 * Must be called before app.whenReady().
 */
export const registerAppProtocolScheme = () => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
};

/**
 * Resolve the directory containing Vite-built static files.
 */
export const resolveDistDir = (): string => {
  const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";
  if (isDev) {
    // Development: dist-vite folder in project root
    return path.join(__dirname, "..", "dist-vite");
  }
  // Production: bundled in app resources, or local dist-vite for non-packaged production
  if (!app.isPackaged) {
    return path.join(__dirname, "..", "dist-vite");
  }
  return path.join(process.resourcesPath, "vite-app");
};

/**
 * Register the app:// protocol handler for serving static files.
 * Implements SPA fallback: serves index.html for non-file routes.
 *
 * @param distDir - Directory containing Vite-built files
 */
export const registerAppProtocolHandler = (distDir: string) => {
  protocol.handle(APP_PROTOCOL_SCHEME, (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);

    // Remove leading slash for path resolution
    if (pathname.startsWith("/")) {
      pathname = pathname.slice(1);
    }

    // Resolve file path
    let filePath = path.join(distDir, pathname);

    // Check if it's a file request (has extension) or route request
    const hasExtension = path.extname(pathname).length > 0;

    if (!hasExtension) {
      // SPA fallback: serve index.html for route requests
      filePath = path.join(distDir, "index.html");
    } else if (!fs.existsSync(filePath)) {
      // File not found, fallback to index.html
      filePath = path.join(distDir, "index.html");
    }

    // Use net.fetch to serve file with proper MIME type handling
    return net.fetch(`file://${filePath}`);
  });
};
