import { z } from "zod";

/** The port a sprite's URL is routed to; the preview's token proxy holds it. */
export const PREVIEW_PROXY_PORT = 8080;
/** The path of a preview link; the proxy answers it before any other. */
export const PREVIEW_LINK_PATH = "/__sky/preview";
/** The cookie a valid token earns the browser. */
export const PREVIEW_COOKIE = "sky_preview";
/** The two sprite services a preview runs. */
export const PREVIEW_PROXY_SERVICE = "sky-preview-proxy";
export const PREVIEW_APP_SERVICE = "sky-preview-app";

export const PREVIEW_MIN_TTL_SECONDS = 60;
export const PREVIEW_DEFAULT_TTL_SECONDS = 24 * 3600;
export const PREVIEW_MAX_TTL_SECONDS = 7 * 24 * 3600;

/** The dev server's port: any unprivileged port but the proxy's own. */
export const PreviewPort = z
  .int()
  .min(1024)
  .max(65535)
  .refine((port) => port !== PREVIEW_PROXY_PORT, {
    message: `${PREVIEW_PROXY_PORT} is the port the preview's proxy holds; the dev server needs another`,
  });

export const PreviewStart = z.strictObject({
  cmd: z.string().trim().min(1).max(4000),
  port: PreviewPort,
  ttlSeconds: z
    .int()
    .min(PREVIEW_MIN_TTL_SECONDS)
    .max(PREVIEW_MAX_TTL_SECONDS)
    .default(PREVIEW_DEFAULT_TTL_SECONDS),
});
export type PreviewStart = z.infer<typeof PreviewStart>;
