import { zValidator } from "@hono/zod-validator";
import { type Db, environments, runEnvVars, secrets } from "@sky/db";
import { EnvironmentId, type RunId } from "@sky/shared";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { BASE_ENV_NAMES } from "./base-profile.js";
import {
  envSecretAad,
  open,
  runEnvVarAad,
  type Sealed,
  seal,
} from "./crypto.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import type { KnownSecrets } from "./redact.js";
import type { Tx } from "./runs.js";
import { body, jsonBody } from "./validation.js";

/** Matches the DB's name CHECK on `secrets` and `run_env_vars`. */
export const EnvVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

// the runner's own variables, and what would hijack the shell or node that start it
const reservedNames = new Set<string>([
  ...BASE_ENV_NAMES,
  "AGENT_ID",
  "RUN_ID",
  "API_BASE_URL",
  "AGENT_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PROMPT",
  "PROMPT_FILE",
  "ENV_FILE",
  "REPO_DIR",
  "WORKTREES_DIR",
  "APPROVAL_POLICY",
  "AUTO_APPROVE",
  "WAIT_TIMEOUT_MINUTES",
  "SESSION_ID",
  "START_BRANCH",
  "SKY_SPRITE_API_SOCKET",
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "IS_SANDBOX",
]);

export const isReservedName = (name: string) => reservedNames.has(name);

export const reservedName = (c: Context, name: string) =>
  apiError(c, 400, "reserved_name", `${name} is reserved by sky`);

// a value is registered under its own nonce, so one replaced or deleted mid-run stays scrubbed
// from the events of a runner that still holds it
const envSecretKey = (envId: string, name: string, nonce: Buffer) =>
  `${envSecretAad(envId, name)}:${nonce.toString("hex")}`;

const SecretInput = z.union([
  z.strictObject({ value: z.string().min(1) }),
  z.strictObject({ connector: z.string().min(1) }),
]);

type SecretRow = typeof secrets.$inferSelect;

const present = (row: SecretRow) => ({
  name: row.name,
  kind: row.kind,
  ...(row.connector === null ? {} : { connector: row.connector }),
});

const sealedOf = (row: {
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  keyVersion: number | null;
}): Sealed => {
  if (!row.ciphertext || !row.nonce || row.keyVersion === null) {
    throw new Error("a value secret is missing its ciphertext");
  }
  return {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyVersion: row.keyVersion,
  };
};

/**
 * The env's secrets as the runner gets them: a value secret decrypted, a connector secret as its
 * Sprites connection id, which a call through the sprite's connector gateway names. `only` limits
 * it to those names, so a step that needs two never decrypts the rest.
 */
export function openEnvSecrets(
  db: Db,
  key: Buffer,
  envId: EnvironmentId,
  only?: readonly string[],
): Map<string, string> {
  const rows = db
    .select()
    .from(secrets)
    .where(eq(secrets.envId, envId))
    .all()
    .filter((row) => !only || only.includes(row.name));
  return new Map(
    rows.map((row) => [
      row.name,
      row.connector ?? open(key, sealedOf(row), envSecretAad(envId, row.name)),
    ]),
  );
}

/** Whether the env stores `name` as a connector secret, not a value. */
export function hasConnectorSecret(
  db: Db,
  envId: EnvironmentId,
  name: string,
): boolean {
  const row = db
    .select({ kind: secrets.kind })
    .from(secrets)
    .where(and(eq(secrets.envId, envId), eq(secrets.name, name)))
    .get();
  return row?.kind === "connector";
}

/** A run's envVars, decrypted; one purged after its TTL is gone. */
export function openRunEnvVars(
  db: Db,
  key: Buffer,
  runId: RunId,
): Map<string, string> {
  const rows = db
    .select()
    .from(runEnvVars)
    .where(eq(runEnvVars.runId, runId))
    .all();
  return new Map(
    rows.map((row) => [
      row.name,
      open(key, row, runEnvVarAad(runId, row.name)),
    ]),
  );
}

/** Stores a run's envVars sealed, expiring `ttlSeconds` from now. */
export function storeRunEnvVars(
  tx: Tx,
  key: Buffer,
  runId: RunId,
  envVars: Record<string, string>,
  ttlSeconds: number,
): void {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  tx.insert(runEnvVars)
    .values(
      entries.map(([name, value]) => ({
        runId,
        name,
        expiresAt,
        ...seal(key, value, runEnvVarAad(runId, name)),
      })),
    )
    .run();
}

/** Registers a run's envVars with redaction, until `purgeExpiredEnvVars` drops them. */
export function registerRunEnvVars(
  known: KnownSecrets,
  runId: RunId,
  envVars: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(envVars)) {
    known.add(runEnvVarAad(runId, name), value);
  }
}

/** Deletes envVars past their expiry and drops them from redaction. */
export function purgeExpiredEnvVars(
  db: Db,
  known: KnownSecrets,
  now: Date,
): void {
  const purged = db
    .delete(runEnvVars)
    .where(lte(runEnvVars.expiresAt, now.toISOString()))
    .returning({ runId: runEnvVars.runId, name: runEnvVars.name })
    .all();
  for (const { runId, name } of purged) known.remove(runEnvVarAad(runId, name));
}

/** Registers every stored env value secret and every held run envVar with redaction. */
export function registerStoredValues(
  db: Db,
  key: Buffer,
  known: KnownSecrets,
): void {
  const values = db
    .select()
    .from(secrets)
    .where(isNotNull(secrets.ciphertext))
    .all();
  for (const row of values) {
    const sealed = sealedOf(row);
    known.add(
      envSecretKey(row.envId, row.name, sealed.nonce),
      open(key, sealed, envSecretAad(row.envId, row.name)),
    );
  }
  for (const row of db.select().from(runEnvVars).all()) {
    const aad = runEnvVarAad(row.runId, row.name);
    known.add(aad, open(key, row, aad));
  }
}

const notFound = "no such environment";

const envParam = zValidator(
  "param",
  z.object({ id: EnvironmentId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", notFound);
  },
);

const envExists = (db: Db, id: EnvironmentId) =>
  db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, id))
    .get() !== undefined;

/** `/:id/secrets`, mounted beside the environment routes. */
export function secretRoutes() {
  return factory
    .createApp()
    .get("/:id/secrets", envParam, (c) => {
      const { id } = c.req.valid("param");
      const db = c.var.db;
      if (!envExists(db, id)) return apiError(c, 404, "not_found", notFound);
      const rows = db
        .select()
        .from(secrets)
        .where(eq(secrets.envId, id))
        .orderBy(asc(secrets.name))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .put("/:id/secrets/:name", envParam, jsonBody, body(SecretInput), (c) => {
      const { id } = c.req.valid("param");
      const name = c.req.param("name");
      if (!EnvVarName.safeParse(name).success) {
        return apiError(
          c,
          400,
          "invalid_name",
          "a secret name is letters, digits and _, not starting with a digit",
        );
      }
      if (isReservedName(name)) return reservedName(c, name);
      const input = c.req.valid("json");
      const db = c.var.db;
      if (!envExists(db, id)) return apiError(c, 404, "not_found", notFound);
      const sealed =
        "value" in input
          ? seal(
              c.var.config.secretEncryptionKey,
              input.value,
              envSecretAad(id, name),
            )
          : null;
      const fields = sealed
        ? { kind: "value" as const, connector: null, ...sealed }
        : {
            kind: "connector" as const,
            connector: "connector" in input ? input.connector : null,
            ciphertext: null,
            nonce: null,
            keyVersion: null,
          };
      const row = db
        .insert(secrets)
        .values({ envId: id, name, ...fields })
        .onConflictDoUpdate({
          target: [secrets.envId, secrets.name],
          set: fields,
        })
        .returning()
        .get();
      if (sealed && "value" in input) {
        c.var.secrets.add(envSecretKey(id, name, sealed.nonce), input.value);
      }
      return c.json(present(row), 200);
    })
    .delete("/:id/secrets/:name", envParam, (c) => {
      const { id } = c.req.valid("param");
      const deleted = c.var.db
        .delete(secrets)
        .where(
          and(eq(secrets.envId, id), eq(secrets.name, c.req.param("name"))),
        )
        .returning({ name: secrets.name })
        .get();
      if (!deleted) return apiError(c, 404, "not_found", "no such secret");
      return c.body(null, 204);
    });
}
