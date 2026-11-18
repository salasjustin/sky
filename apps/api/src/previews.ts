import { createHash, randomBytes } from "node:crypto";
import {
  APIError,
  type ServiceLogEvent,
  type ServiceRequest,
} from "@fly/sprites";
import { agents, type Db, environments, previews } from "@sky/db";
import {
  type AgentId,
  type EnvironmentId,
  PREVIEW_APP_SERVICE,
  PREVIEW_LINK_PATH,
  PREVIEW_PROXY_PORT,
  PREVIEW_PROXY_SERVICE,
  type PreviewStart,
} from "@sky/shared";
import { and, eq, lte } from "drizzle-orm";
import { canUseEnv, ownAgents, type Principal } from "./auth.js";
import type { Config } from "./config.js";
import {
  REPO_DIR,
  RUNNER,
  WITH_PACKAGE_MANAGERS,
  WORKTREES_DIR,
} from "./provision.js";
import { cut, redact } from "./redact.js";
import type { BundleInstaller } from "./runner-bundle.js";
import { isReservedName, openEnvSecrets } from "./secrets.js";
import { execInSprite, type SpriteOps, spriteCall } from "./sprites.js";

// how long a created service is watched for an immediate exit; a dev server that dies in this window
// fails the start, with its last output
const WATCH = "2s";
const OUTPUT_TAIL = 1500;

// exits 10 when something listens on port $1: the kernel's table of listening TCP sockets (state 0A), v4 and v6
const PORT_HELD = `hex=$(printf '%04X' "$1"); cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v p=":$hex" '$4 == "0A" && toupper($2) ~ p "$" { held = 1 } END { exit (held ? 10 : 0) }'`;
const HELD = 10;

// the user's command, whole, as $1 of a shell of its own: `cd web && pnpm dev` and `FOO=1 pnpm dev` run as
// written, and a single program still replaces that shell as the service's process
const RUN_DEV_SERVER = `${WITH_PACKAGE_MANAGERS} && exec bash -c "$1"`;

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type PreviewRow = typeof previews.$inferSelect;

/** What teardown needs of a preview: which one it is, and where it runs. */
type Running = Pick<PreviewRow, "envId" | "agentId" | "tokenHash"> & {
  spriteName: string;
};

const runningOf = (db: Db) =>
  db
    .select({
      envId: previews.envId,
      agentId: previews.agentId,
      tokenHash: previews.tokenHash,
      port: previews.port,
      spriteName: environments.spriteName,
    })
    .from(previews)
    .innerJoin(environments, eq(previews.envId, environments.id));

const isGone = (err: unknown) =>
  (err instanceof APIError && err.statusCode === 404) ||
  (err instanceof Error && /not found/i.test(err.message));

// one start, stop or sweep at a time per environment: a sprite has one HTTP port
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(
  envId: EnvironmentId,
  work: () => Promise<T>,
): Promise<T> {
  const run = (chains.get(envId) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => {});
  chains.set(envId, tail);
  void tail.then(() => {
    if (chains.get(envId) === tail) chains.delete(envId);
  });
  return run;
}

/**
 * Ends a preview: the sprite's URL goes private first, so nothing is public a moment longer than it must
 * be, then both services go, then the token's row, which is what makes the token dead to Sky. A sprite or
 * service already gone counts as removed; anything else throws and leaves the row, so a retry finishes it.
 */
async function endPreview(
  db: Db,
  sprites: SpriteOps,
  running: Running,
): Promise<void> {
  const { spriteName: name } = running;
  await spriteCall(sprites, name, { op: "url-private" }, () =>
    sprites.client.updateSprite(name, { urlSettings: { auth: "sprite" } }),
  ).catch((err: unknown) => {
    if (!isGone(err)) throw err;
  });
  for (const service of [PREVIEW_PROXY_SERVICE, PREVIEW_APP_SERVICE]) {
    await spriteCall(sprites, name, { op: "service-delete" }, () =>
      sprites.client.sprite(name).deleteService(service),
    ).catch((err: unknown) => {
      if (!isGone(err)) throw err;
    });
  }
  db.delete(previews)
    .where(
      and(
        eq(previews.envId, running.envId),
        eq(previews.tokenHash, running.tokenHash),
      ),
    )
    .run();
}

export type StartResult =
  | { kind: "not_found" }
  | { kind: "archived" }
  | { kind: "not_ready" }
  | { kind: "no_worktree" }
  | { kind: "port_busy"; port: number }
  | { kind: "failed"; detail: string }
  | {
      kind: "started";
      preview: PresentedPreview & { link: string; replaced: AgentId | null };
    };

export type PresentedPreview = {
  agentId: AgentId;
  envId: EnvironmentId;
  port: number;
  cmd: string;
  startedAt: string;
  expiresAt: string;
};

const present = (row: PreviewRow): PresentedPreview => ({
  agentId: row.agentId,
  envId: row.envId,
  port: row.port,
  cmd: row.cmd,
  startedAt: row.createdAt,
  expiresAt: row.expiresAt,
});

type Deps = {
  db: Db;
  config: Config;
  sprites: SpriteOps;
  ensureBundle: BundleInstaller;
  log: (line: string) => void;
};

/** The services' own words for how one did, for a start that must say why it failed. */
function failureOf(
  service: string,
  events: ServiceLogEvent[],
  known: readonly string[],
): string | undefined {
  const ended = events.find((e) => e.type === "exit" || e.type === "error");
  if (!ended) return undefined;
  const output = events
    .filter((e) => e.type === "stdout" || e.type === "stderr")
    .map((e) => e.data ?? "")
    .join("")
    .trim();
  const how =
    ended.type === "exit"
      ? `exited ${ended.exitCode ?? "?"} within ${WATCH} of starting`
      : `failed to start: ${ended.data ?? "no reason given"}`;
  const tail = output ? `: ${output.slice(-OUTPUT_TAIL)}` : "";
  return redact(`${service} ${how}${tail}`, known);
}

export function createPreviews({
  db,
  config,
  sprites,
  ensureBundle,
  log,
}: Deps) {
  /** The agent and its env, when `principal` may act on it. */
  const find = (agentId: AgentId, principal: Principal) => {
    const found = db
      .select({
        agent: agents,
        envStatus: environments.status,
        spriteName: environments.spriteName,
        base: environments.base,
      })
      .from(agents)
      .innerJoin(environments, eq(agents.envId, environments.id))
      .where(and(eq(agents.id, agentId), ownAgents(principal)))
      .get();
    return found && canUseEnv(principal, found.agent.envId) ? found : undefined;
  };

  /** Creates a service and watches it for `WATCH`; throws with the service's own output when it dies in that time. */
  async function createService(
    spriteName: string,
    service: string,
    request: ServiceRequest,
    known: readonly string[],
  ): Promise<void> {
    const events = await spriteCall(
      sprites,
      spriteName,
      { op: "service-create", known },
      async () => {
        const stream = await sprites.client
          .sprite(spriteName)
          .createService(service, request, WATCH);
        const seen: ServiceLogEvent[] = [];
        for await (const event of stream) seen.push(event);
        return seen;
      },
    );
    const failure = failureOf(service, events, known);
    if (failure) throw new Error(failure);
  }

  /**
   * What the dev server's commands get: the environment's secrets and its profile's session variables, never a
   * Claude credential or one of Sky's tokens. `secretValues` are the secrets alone, what its output is redacted
   * by: the session variables are switches and `PORT` a number the output must keep.
   */
  function appEnv(envId: EnvironmentId, base: string | null, port: number) {
    const profile = base ? config.baseProfiles[base] : undefined;
    const secrets = new Map(
      openEnvSecrets(db, config.secretEncryptionKey, envId),
    );
    // reserved names are the runner's own (the Claude credential, the agent token, PATH…): never passed on
    for (const name of [...secrets.keys()]) {
      if (isReservedName(name)) secrets.delete(name);
    }
    return {
      env: {
        ...Object.fromEntries(secrets),
        ...(profile?.sessionEnv ?? {}),
        PORT: String(port),
      },
      secretValues: [...secrets.values()],
    };
  }

  /** `port_busy` or `failed` when the port check refuses `port`; `undefined` when nothing listens on it. */
  async function refusedPort(
    spriteName: string,
    port: number,
  ): Promise<StartResult | undefined> {
    const held = await execInSprite(
      sprites,
      spriteName,
      ["sh", "-c", PORT_HELD, "sh", String(port)],
      { op: "preview-port" },
    );
    if (held.exitCode === HELD) return { kind: "port_busy", port };
    if (held.exitCode !== 0) {
      return {
        kind: "failed",
        detail: `checking port ${port} on the sprite exited ${held.exitCode}`,
      };
    }
    return undefined;
  }

  return {
    /**
     * Starts the agent's preview: its dev server and the token proxy as two services on the env's sprite,
     * then the sprite's URL goes public. Replaces the env's running preview, whichever agent's it is.
     */
    async start(
      agentId: AgentId,
      principal: Principal,
      input: PreviewStart,
    ): Promise<StartResult> {
      const found = find(agentId, principal);
      if (!found) return { kind: "not_found" };
      if (found.agent.archivedAt) return { kind: "archived" };
      if (found.envStatus !== "ready") return { kind: "not_ready" };
      const { agent, spriteName } = found;
      return serialized(agent.envId, async (): Promise<StartResult> => {
        const worktree = `${WORKTREES_DIR}/${agentId}`;
        const there = await execInSprite(
          sprites,
          spriteName,
          ["test", "-d", worktree],
          { op: "preview-worktree", cwd: REPO_DIR },
        );
        if (there.exitCode !== 0) return { kind: "no_worktree" };
        const current = runningOf(db)
          .where(eq(previews.envId, agent.envId))
          .get();
        // every refusal that doesn't hinge on the running preview's own services comes before it is ended
        const url = (
          await spriteCall(sprites, spriteName, { op: "get-url" }, () =>
            sprites.client.getSprite(spriteName),
          )
        ).url;
        if (!url) {
          return {
            kind: "failed",
            detail: "the sprite has no URL to preview on",
          };
        }
        const devPortCheckedFirst =
          current !== undefined && current.port !== input.port;
        if (devPortCheckedFirst) {
          const refused = await refusedPort(spriteName, input.port);
          if (refused) return refused;
        }
        if (current) await endPreview(db, sprites, current);
        // a running preview's proxy holds 8080, and its dev server the dev port when this one asks for the same:
        // checked once its services are gone, so neither is counted
        const afterTeardown = devPortCheckedFirst
          ? [PREVIEW_PROXY_PORT]
          : [PREVIEW_PROXY_PORT, input.port];
        for (const port of afterTeardown) {
          const refused = await refusedPort(spriteName, port);
          if (refused) return refused;
        }
        const token = randomBytes(32).toString("base64url");
        const tokenHash = sha256Hex(token);
        const expiresAt = new Date(
          Date.now() + input.ttlSeconds * 1000,
        ).toISOString();
        // the row first: a start that dies midway leaves one for the sweep and a retry to clean up
        const row = db
          .insert(previews)
          .values({
            envId: agent.envId,
            agentId,
            port: input.port,
            cmd: input.cmd,
            tokenHash,
            expiresAt,
          })
          .returning()
          .get();
        const { env, secretValues } = appEnv(
          agent.envId,
          found.base,
          input.port,
        );
        const known = [...secretValues, token];
        try {
          await ensureBundle(spriteName, `preview-${agentId}`);
          // the proxy first, holding 8080 before the dev server opens a port of its own: a sprite's URL
          // goes to 8080, or else to the first HTTP port opened
          await createService(
            spriteName,
            PREVIEW_PROXY_SERVICE,
            {
              cmd: "bash",
              args: [
                "-c",
                `${WITH_PACKAGE_MANAGERS} && exec node ${RUNNER} preview-proxy`,
              ],
              env: {
                PREVIEW_TOKEN_HASH: tokenHash,
                PREVIEW_UPSTREAM_PORT: String(input.port),
                PREVIEW_EXPIRES_AT: expiresAt,
                PREVIEW_LISTEN_PORT: String(PREVIEW_PROXY_PORT),
              },
              httpPort: PREVIEW_PROXY_PORT,
            },
            known,
          );
          await createService(
            spriteName,
            PREVIEW_APP_SERVICE,
            {
              cmd: "bash",
              args: ["-c", RUN_DEV_SERVER, "bash", input.cmd],
              dir: worktree,
              env,
              needs: [PREVIEW_PROXY_SERVICE],
            },
            known,
          );
          await spriteCall(sprites, spriteName, { op: "url-public" }, () =>
            sprites.client.updateSprite(spriteName, {
              urlSettings: { auth: "public" },
            }),
          );
        } catch (err) {
          const detail = redact(
            err instanceof Error ? err.message : String(err),
            known,
          );
          log(`starting the preview of ${agentId} failed: ${detail}`);
          await endPreview(db, sprites, {
            envId: agent.envId,
            agentId,
            tokenHash,
            spriteName,
          }).catch((endErr: unknown) => {
            log(`ending the failed preview of ${agentId} failed: ${endErr}`);
          });
          return { kind: "failed", detail: cut(detail, 2000) };
        }
        return {
          kind: "started",
          preview: {
            ...present(row),
            link: `${url.replace(/\/+$/, "")}${PREVIEW_LINK_PATH}?t=${token}`,
            replaced:
              current && current.agentId !== agentId ? current.agentId : null,
          },
        };
      });
    },

    /** Ends the agent's preview; `undefined` when it has none, or `principal` may not act on the agent. */
    async stop(
      agentId: AgentId,
      principal: Principal,
    ): Promise<PresentedPreview | undefined> {
      const found = find(agentId, principal);
      if (!found) return undefined;
      return serialized(found.agent.envId, async () => {
        const row = db
          .select()
          .from(previews)
          .where(
            and(
              eq(previews.envId, found.agent.envId),
              eq(previews.agentId, agentId),
            ),
          )
          .get();
        if (!row) return undefined;
        await endPreview(db, sprites, { ...row, spriteName: found.spriteName });
        return present(row);
      });
    },

    /** The agent's running preview, with how its two services are doing; `null` when it has none, `undefined` for an agent `principal` may not see. */
    async state(agentId: AgentId, principal: Principal) {
      const found = find(agentId, principal);
      if (!found) return undefined;
      const row = db
        .select()
        .from(previews)
        .where(
          and(
            eq(previews.envId, found.agent.envId),
            eq(previews.agentId, agentId),
          ),
        )
        .get();
      if (!row) return null;
      const services = await spriteCall(
        sprites,
        found.spriteName,
        { op: "services-list" },
        () => sprites.client.sprite(found.spriteName).listServices(),
      ).catch((err: unknown) => {
        log(`listing the services of ${found.spriteName} failed: ${err}`);
        return undefined;
      });
      const status = (name: string) =>
        services?.find((s) => s.name === name)?.state?.status ?? "missing";
      return {
        ...present(row),
        services: services && {
          app: status(PREVIEW_APP_SERVICE),
          proxy: status(PREVIEW_PROXY_SERVICE),
        },
      };
    },

    /** Ends the agent's preview (archive), or the environment's, whichever agent's it is (delete). Throws when it can't. */
    stopForAgent(agentId: AgentId, envId: EnvironmentId): Promise<void> {
      return serialized(envId, async () => {
        const row = runningOf(db).where(eq(previews.agentId, agentId)).get();
        if (row) await endPreview(db, sprites, row);
      });
    },
    stopForEnv(envId: EnvironmentId): Promise<void> {
      return serialized(envId, async () => {
        const row = runningOf(db).where(eq(previews.envId, envId)).get();
        if (row) await endPreview(db, sprites, row);
      });
    },
  };
}

export type Previews = ReturnType<typeof createPreviews>;

/**
 * Ends every preview past its TTL. Each failure is logged and left for the next sweep, since the row
 * stays until its services are gone; the proxy stops honouring the token at its expiry regardless.
 */
export async function sweepExpiredPreviews(
  db: Db,
  sprites: SpriteOps,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<number> {
  const due = runningOf(db)
    .where(lte(previews.expiresAt, now.toISOString()))
    .all();
  let ended = 0;
  await Promise.all(
    due.map((row) =>
      serialized(row.envId, async () => {
        try {
          // a start that ran while this waited replaced the preview: its services are not this row's to end
          const still = runningOf(db)
            .where(
              and(
                eq(previews.envId, row.envId),
                eq(previews.tokenHash, row.tokenHash),
              ),
            )
            .get();
          if (!still) return;
          await endPreview(db, sprites, still);
          ended += 1;
          log(`preview of ${row.agentId} ended: its TTL passed`);
        } catch (err) {
          log(`ending the expired preview of ${row.agentId} failed: ${err}`);
        }
      }),
    ),
  );
  return ended;
}
