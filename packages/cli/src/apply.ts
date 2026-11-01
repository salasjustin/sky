import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Api, type ApiEnvironment, ApiError } from "./api.js";
import type { Io } from "./cli.js";
import { type Output, UsageError } from "./output.js";
import { type EnvSpec, parseSpec, specHash } from "./spec.js";

const pollIntervalMs = 3_000;
const provisionTimeoutMs = 30 * 60 * 1000;
const progressEveryPolls = 10;
const maxBackoffMs = 30_000;

const lockName = "sky-lock.json";
const Lock = z.object({ envId: z.string().min(1) });

type Fetched = { raw: unknown; env: ApiEnvironment };

/** Reads and validates the spec; every way it's unusable is a usage error, before any request. */
function loadSpec(file: string): EnvSpec {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UsageError(`cannot read ${file}${code ? ` (${code})` : ""}`);
  }
  const result = parseSpec(source, file);
  if (!result.ok) throw new UsageError(result.errors.join("\n"));
  return result.spec;
}

export async function apply(
  file: string,
  api: Api,
  io: Io,
  out: Output,
): Promise<number> {
  const spec = loadSpec(file);
  const lockFile = join(dirname(file), lockName);

  let current = await findEnv(api, spec.name, readLockedId(lockFile, out));
  if (current?.env.status === "provisioning") {
    const blocked = reprovisioningFields(changedFields(spec, current.env));
    if (blocked.length > 0) {
      // the API refuses a reprovisioning PATCH mid-provision; let this one finish, then diff against its result
      const { id, name } = current.env;
      out.progress(
        `${name} (${id}) is still provisioning; waiting for it to finish before changing ${blocked.join(", ")}`,
      );
      const waited = await waitForProvisioned(api, current, io, out);
      if (!waited.done) return timedOut(current.env, waited.lastError, out);
      current = waited.current;
    }
  }
  let changed = true;
  if (current === undefined) {
    current = await api.createEnvironment(spec);
  } else {
    const patch = changedFields(spec, current.env);
    if (Object.keys(patch).length === 0) {
      changed = false;
    } else {
      current = await api.patchEnvironment(current.env.id, patch);
    }
  }

  // an unchanged spec, or a PATCH of fields that don't reprovision, leaves a failed env failed
  if (current.env.status === "failed") {
    const step = current.env.failure?.step ?? "unknown";
    out.progress(`retrying ${spec.name} (last failed at ${step})`);
    current = await api.retryEnvironment(current.env.id);
    changed = true;
  }

  if (current.env.status === "provisioning") {
    const waited = await waitForProvisioned(api, current, io, out);
    if (!waited.done) return timedOut(current.env, waited.lastError, out);
    current = waited.current;
  }

  const { env } = current;
  if (env.status === "failed") {
    const step = env.failure?.step ?? "unknown";
    const tail = env.failure?.stderr.trimEnd() ?? "";
    return out.fail(
      "provisioning_failed",
      `provisioning ${env.name} (${env.id}) failed at step ${step}`,
      tail === "" ? undefined : tail,
    );
  }

  writeLock(lockFile, {
    envId: env.id,
    spriteName: env.spriteName,
    checkpointId: env.checkpointId,
    specHash: specHash(spec),
  });
  out.result(
    current.raw,
    `${changed ? "ready" : "up to date"} ${env.name} ${env.id}`,
  );
  return 0;
}

function timedOut(
  env: ApiEnvironment,
  lastError: ApiError | undefined,
  out: Output,
): number {
  return out.fail(
    "provision_timeout",
    `${env.name} (${env.id}) still provisioning after ${provisionTimeoutMs / 60_000}m; re-run apply to keep waiting`,
    lastError && `last poll: ${lastError.message}`,
  );
}

function readLockedId(lockFile: string, out: Output): string | undefined {
  let text: string;
  try {
    text = readFileSync(lockFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const parsed = Lock.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.envId;
  } catch {}
  out.warn(`ignoring ${lockFile}: no envId in it`);
  return undefined;
}

/** By the lock's id first, so a renamed env is still found; by name when there's no lock or its env is gone. */
async function findEnv(
  api: Api,
  name: string,
  lockedId: string | undefined,
): Promise<Fetched | undefined> {
  if (lockedId !== undefined) {
    try {
      return await api.getEnvironment(lockedId);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  const { envs } = await api.listEnvironments();
  const env = envs.find((e) => e.name === name);
  return env === undefined ? undefined : { raw: env, env };
}

const reprovisioningFields = (patch: Partial<EnvSpec>) =>
  (["repo", "setup", "base"] as const).filter((key) => key in patch);

function changedFields(spec: EnvSpec, env: ApiEnvironment): Partial<EnvSpec> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (JSON.stringify(value) !== JSON.stringify(env[key as keyof EnvSpec])) {
      patch[key] = value;
    }
  }
  return patch;
}

type Waited =
  | { done: true; current: Fetched }
  | { done: false; lastError: ApiError | undefined };

/** Polls until the env leaves `provisioning`; an unreachable API or a 5xx is retried with backoff up to the deadline. */
async function waitForProvisioned(
  api: Api,
  start: Fetched,
  io: Io,
  out: Output,
): Promise<Waited> {
  const { id, name } = start.env;
  const startedAt = io.now();
  // arm before the progress line: until a SIGINT listener exists, a Ctrl-C the line prompts takes node's default death with no note
  const disarm = io.onInterrupt(
    `interrupted; ${name} (${id}) keeps provisioning on the server. Re-run sky apply to pick it up`,
  );
  try {
    out.progress(`provisioning ${name} (${id})…`);
    return await poll();
  } finally {
    disarm();
  }

  async function poll(): Promise<Waited> {
    let current = start;
    let failures = 0;
    let lastError: ApiError | undefined;
    for (let polls = 1; current.env.status === "provisioning"; polls++) {
      const remaining = provisionTimeoutMs - (io.now() - startedAt);
      if (remaining <= 0) return { done: false, lastError };
      const backoff = Math.min(pollIntervalMs * 2 ** failures, maxBackoffMs);
      await io.sleep(Math.min(backoff, remaining));
      try {
        current = await api.getEnvironment(id);
      } catch (err) {
        if (!(err instanceof ApiError && isTransient(err))) throw err;
        if (failures === 0) {
          out.progress(`lost contact with the API (${err.message}); retrying`);
        }
        failures++;
        lastError = err;
        continue;
      }
      failures = 0;
      lastError = undefined;
      if (
        polls % progressEveryPolls === 0 &&
        current.env.status === "provisioning"
      ) {
        out.progress(`still provisioning (${elapsed(io.now() - startedAt)})`);
      }
    }
    return { done: true, current };
  }
}

const isTransient = (err: ApiError) => err.status === 0 || err.status >= 500;

const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

function writeLock(path: string, lock: Record<string, unknown>) {
  // rename over the old lock so an interrupted write never leaves half a file
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(tmp, path);
}
