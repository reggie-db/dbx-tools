/**
 * Static frontend middleware shared by the demo server and its delivery tests.
 */
import compression from "compression";
import express, { type Application } from "express";

/** Bun content hashes make these assets safe to cache permanently. */
const HASHED_ASSET_PATH = /-[a-z0-9]{8,}\.(?:css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$/i;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Compress static responses and serve assets with cache headers before AppKit's
 * fallback static mount.
 */
export function configureStaticDelivery(app: Application, staticPath: string): void {
  app.use(compression());
  app.use(
    express.static(staticPath, {
      index: false,
      setHeaders(response, filePath) {
        response.setHeader(
          "Cache-Control",
          HASHED_ASSET_PATH.test(filePath) ? IMMUTABLE_CACHE_CONTROL : "no-cache",
        );
      },
    }),
  );
}
