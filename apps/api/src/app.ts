import { readFile } from "node:fs/promises";
import type { SpritesClient } from "@fly/sprites";
import type { Db } from "@sky/db";
import { createMcpHandler } from "@sky/mcp";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { accountEventRoutes } from "./account-events.js";
import { agentRoutes } from "./agents.js";
import { createBranchChecker } from "./branch-check.js";
import type { Config } from "./config.js";
import { environmentRoutes } from "./environments.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { internalRoutes } from "./internal.js";
import { createLauncher } from "./launch.js";
import { wakeLaunch } from "./probe.js";
import { createProvisioner } from "./provision.js";
import { KnownSecrets } from "./redact.js";
import { createBundleInstaller } from "./runner-bundle.js";
import { registerStoredValues, secretRoutes } from "./secrets.js";
import { SPRITES_TIMEOUT_MS, type SpriteOps } from "./sprites.js";
import { webhookRoutes } from "./webhooks.js";

export type AppDeps = {
  db: Db;
  config: Config;
  sprites: SpritesClient;
  log: (line: string) => void;
  /** Wakes the delivery loop after ingestion enqueues webhook deliveries; must not block. */
  nudgeDeliveries: () => void;
  /** Quiet time before an event stream sends a `: ping` comment; 15 s unless a test shortens it. */
  heartbeatMs?: number;
  /** How long the runner's decision long-poll waits before answering pending; 25 s unless a test shortens it. */
  longPollMs?: number;
  /** How long a launch watches its runner for an exit at start; 3 s unless a test shortens it. */
  launchWatchMs?: number;
  /** How long after its runner starts a run that hasn't reported in gets its sprite woken; 90 s unless a test shortens it. */
  launchWakeMs?: number;
  /** The bound on a Sprites call that should answer promptly; 60 s unless a test shortens it. */
  spritesTimeoutMs?: number;
  /** The redaction registry, shared with whatever else purges from it; one from `config` by default. */
  secrets?: KnownSecrets;
  /** Aborted at shutdown: event streams send a final `server.shutdown` frame and end, parked event polls answer. */
  closing?: AbortSignal;
};

export function createApp({
  db,
  config,
  sprites,
  log,
  nudgeDeliveries,
  heartbeatMs = 15_000,
  longPollMs = 25_000,
  launchWatchMs = 3_000,
  launchWakeMs = 90_000,
  spritesTimeoutMs = SPRITES_TIMEOUT_MS,
  secrets = KnownSecrets.fromConfig(config),
  closing = new AbortController().signal,
}: AppDeps) {
  // bearerAuth answers a malformed header with 400; every auth failure here is one 401
  const unauthorized = (message: string) => (c: Context) =>
    apiError(c, 401, "unauthorized", message);

  registerStoredValues(db, config.secretEncryptionKey, secrets);
  const spriteOps: SpriteOps = {
    client: sprites,
    log,
    secrets,
    timeoutMs: spritesTimeoutMs,
    longTimeoutMs: config.spritesLongTimeoutMs,
  };
  const ensureBundle = createBundleInstaller(
    spriteOps,
    config.runnerBundlePath,
  );
  const provisioner = createProvisioner({
    db,
    secretEncryptionKey: config.secretEncryptionKey,
    secrets,
    sprites: spriteOps,
    ensureBundle,
    baseProfiles: config.baseProfiles,
    log,
  });
  const launcher = createLauncher({
    db,
    config,
    secrets,
    sprites: spriteOps,
    ensureBundle,
    log,
    nudgeDeliveries,
    watchMs: launchWatchMs,
    wakeAfterMs: launchWakeMs,
    wake: (runId, spriteName) => wakeLaunch(spriteOps, runId, spriteName, log),
  });
  const checkBranch = createBranchChecker({
    db,
    secretEncryptionKey: config.secretEncryptionKey,
    secrets,
    sprites: spriteOps,
    ensureBundle,
    log,
  });
  const apiKeyGuard = bearerAuth({
    token: config.apiKey,
    noAuthenticationHeader: { message: unauthorized("missing bearer token") },
    invalidAuthenticationHeader: {
      message: unauthorized("malformed Authorization header"),
    },
    invalidToken: { message: unauthorized("invalid bearer token") },
  });
  // the MCP tools call /v1 in-process through the whole app, so its guard checks them too
  const mcp = createMcpHandler({
    baseUrl: "http://sky.internal",
    fetch: (request) => app.fetch(request),
    apiKey: config.apiKey,
  });
  const v1 = factory
    .createApp()
    .route("/environments", environmentRoutes(provisioner, spriteOps, log))
    .route("/environments", secretRoutes())
    .route(
      "/agents",
      agentRoutes(launcher, checkBranch, spriteOps, log, heartbeatMs),
    )
    .route("/webhooks", webhookRoutes())
    .route("/", accountEventRoutes(heartbeatMs, log));

  const app = factory
    .createApp()
    .use(logger(log))
    .use(async (c, next) => {
      c.set("db", db);
      c.set("config", config);
      c.set("secrets", secrets);
      c.set("nudgeDeliveries", nudgeDeliveries);
      c.set("closing", closing);
      await next();
    })
    // public so a fresh machine can install the CLI before it has a key; the bundle holds no credentials
    .get("/cli/sky.mjs", async (c) => {
      try {
        const bytes = await readFile(config.cliBundlePath);
        return c.body(bytes, 200, {
          "content-type": "text/javascript; charset=utf-8",
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return apiError(c, 404, "not_found", "this server has no CLI bundle");
      }
    })
    .get("/healthz", (c) => {
      try {
        db.$client.prepare("select 1").get();
      } catch {
        return apiError(c, 503, "db_unreachable", "database is unreachable");
      }
      return c.json({ status: "ok", db: "ok" } as const, 200);
    })
    // the runner's own channel, authenticated per run by its agent token rather than the API key
    .route("/internal", internalRoutes(longPollMs, log))
    .use("/v1/*", apiKeyGuard)
    .route("/v1", v1)
    .use("/mcp", apiKeyGuard)
    .all("/mcp", (c) => mcp(c.req.raw));

  app.onError((err, c) => {
    // a thrown HTTPException (bearerAuth's 401) already carries its enveloped response
    if (err instanceof HTTPException) return err.getResponse();
    log(`${c.req.method} ${c.req.path} failed: ${err.stack ?? err}`);
    return apiError(c, 500, "internal", "internal server error");
  });
  app.notFound((c) => apiError(c, 404, "not_found", "no such route"));
  return app;
}

export type AppType = ReturnType<typeof createApp>;
