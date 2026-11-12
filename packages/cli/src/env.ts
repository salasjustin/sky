import { ClaudeCredentialName, ClaudeFallback } from "@sky/shared";
import type { AgentCommand } from "./agent.js";
import { type ApiEnvironment, ApiError } from "./api.js";
import { UsageError } from "./output.js";
import { resolveEnv, resolveEnvId } from "./secret.js";

/** Name last: it may hold spaces, so the fields before it split on whitespace. */
const envLine = (env: ApiEnvironment) =>
  `${env.id} ${env.status} ${env.repo} ${env.name}`;

function onlyEnv(sub: string, rest: string[]): string {
  const [ref, ...extra] = rest;
  if (ref === undefined || extra.length > 0) {
    throw new UsageError(
      `env ${sub} takes one argument, the env id or name`,
      true,
    );
  }
  return ref;
}

/** The ids from a 409 `webhooks_filter` delete refusal; undefined for any other error. */
function filteringWebhookIds(err: unknown): string[] | undefined {
  if (
    !(err instanceof ApiError) ||
    err.status !== 409 ||
    err.code !== "webhooks_filter"
  ) {
    return undefined;
  }
  const ids = err.details.webhookIds;
  return Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === "string")
    ? ids
    : undefined;
}

/**
 * `--pool`'s value: undefined when not given, null for `all` (every subscription the server holds),
 * else the names, in order.
 */
function parsePool(value: string | undefined): string[] | null | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length === 0) {
    throw new UsageError("--pool names no subscription", true);
  }
  if (names.includes("all")) {
    if (names.length > 1) {
      throw new UsageError("--pool=all stands alone", true);
    }
    return null;
  }
  return names;
}

/** The claude assignment `env show` and `env set-claude` print: names only. */
const claudeLine = (env: ApiEnvironment) =>
  `claude credential: ${env.claudeCredential ?? "default"}${env.claudePool ? ` [${env.claudePool.join(", ")}]` : ""} (fallback: ${env.claudeFallback})`;

export const env: AgentCommand = {
  options: {
    yes: { type: "boolean" },
    fallback: { type: "string" },
    pool: { type: "string" },
  },
  prepare(positionals, values) {
    const [sub, ...rest] = positionals;
    if (values.yes && sub !== "delete") {
      throw new UsageError("--yes only goes with env delete", true);
    }
    if (values.fallback !== undefined && sub !== "set-claude") {
      throw new UsageError("--fallback only goes with env set-claude", true);
    }
    if (values.pool !== undefined && sub !== "set-claude") {
      throw new UsageError("--pool only goes with env set-claude", true);
    }
    if (sub === "list") {
      if (rest.length > 0) {
        throw new UsageError("env list takes no arguments", true);
      }
      return async (api, _io, out) => {
        const { raw, envs } = await api.listEnvironments();
        if (envs.length === 0 && !out.json) {
          out.progress("no environments; create one with sky apply <env.yaml>");
        } else {
          out.result(raw, envs.map(envLine).join("\n"));
        }
        return 0;
      };
    }
    if (sub === "show") {
      const ref = onlyEnv(sub, rest);
      return async (api, _io, out) => {
        const envId = await resolveEnvId(api, ref, out);
        if (envId === undefined) return 1;
        const { raw, env } = await api.getEnvironment(envId);
        const lines = [envLine(env)];
        if (env.claudeCredential !== null || env.claudeFallback !== "api-key") {
          lines.push(claudeLine(env));
        }
        if (env.failure) {
          lines.push(`failed at step ${env.failure.step}`);
          const tail = env.failure.stderr.trimEnd();
          if (tail !== "") lines.push(tail.replace(/^/gm, "  "));
        }
        out.result(raw, lines.join("\n"));
        return 0;
      };
    }
    if (sub === "delete") {
      const ref = onlyEnv(sub, rest);
      // the delete cascades to every agent, run and event and can't be undone
      return async (api, io, out) => {
        const canAsk =
          io.stdin.isTTY && io.stderrIsTTY && !out.json && !io.env.CI;
        if (!values.yes && !canAsk) {
          throw new UsageError(`refusing to delete ${ref} without --yes`);
        }
        const target = await resolveEnv(api, ref, out);
        if (target === undefined) return 1;
        const envId = target.id;
        if (!values.yes) {
          const answer = await io.stdin.prompt(
            `permanently delete ${target.name} (${envId}) and all its agents, runs and events? [y/N] `,
          );
          if (!/^y(es)?$/i.test(answer.trim())) {
            out.progress("nothing deleted");
            return 1;
          }
        }
        try {
          await api.deleteEnvironment(envId);
        } catch (err) {
          const webhookIds = filteringWebhookIds(err);
          if (webhookIds === undefined || out.json) throw err;
          return out.fail(
            "webhooks_filter",
            `webhooks filter on ${target.name} (${envId}): ${webhookIds.join(", ")}; delete them first with sky webhook delete <id>`,
          );
        }
        // the API answers 204, so --json gets an object of its own rather than nothing
        out.result({ id: envId, deleted: true }, `deleted ${envId}`);
        return 0;
      };
    }
    if (sub === "retry") {
      const ref = onlyEnv(sub, rest);
      return async (api, _io, out) => {
        const envId = await resolveEnvId(api, ref, out);
        if (envId === undefined) return 1;
        const { raw, env } = await api.retryEnvironment(envId);
        out.result(raw, envLine(env));
        return 0;
      };
    }
    if (sub === "set-claude") {
      const [ref, credential, ...extra] = rest;
      if (ref === undefined || credential === undefined || extra.length > 0) {
        throw new UsageError(
          "env set-claude takes <env> <name|api-key|pool|default> [--pool=<names>] [--fallback=api-key|none]",
          true,
        );
      }
      if (
        credential !== "default" &&
        !ClaudeCredentialName.safeParse(credential).success
      ) {
        throw new UsageError(
          `${JSON.stringify(credential)} is not a credential name: use a subscription's name, api-key, pool or default`,
          true,
        );
      }
      if (values.pool !== undefined && credential !== "pool") {
        throw new UsageError("--pool goes with the credential pool", true);
      }
      // undefined leaves the pool's list as it is, `all` (null) resets it to every subscription
      const poolNames = parsePool(values.pool);
      const fallback =
        values.fallback === undefined
          ? undefined
          : ClaudeFallback.safeParse(values.fallback);
      if (fallback && !fallback.success) {
        throw new UsageError("--fallback is api-key or none", true);
      }
      return async (api, _io, out) => {
        const envId = await resolveEnvId(api, ref, out);
        if (envId === undefined) return 1;
        const { raw, env } = await api.patchEnvironment(envId, {
          claudeCredential: credential === "default" ? null : credential,
          // only --pool changes the list: --fallback alone must not widen an ordered pool
          ...(poolNames !== undefined && { claudePool: poolNames }),
          ...(fallback?.success && { claudeFallback: fallback.data }),
        });
        out.result(raw, `${envLine(env)}\n${claudeLine(env)}`);
        return 0;
      };
    }
    throw new UsageError(
      sub === undefined
        ? "env needs a subcommand: list, show, delete, retry or set-claude"
        : `unknown env subcommand '${sub}'`,
      true,
    );
  },
};
