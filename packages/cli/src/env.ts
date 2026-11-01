import type { AgentCommand } from "./agent.js";
import type { ApiEnvironment } from "./api.js";
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

export const env: AgentCommand = {
  options: { yes: { type: "boolean" } },
  prepare(positionals, values) {
    const [sub, ...rest] = positionals;
    if (values.yes && sub !== "delete") {
      throw new UsageError("--yes only goes with env delete", true);
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
        await api.deleteEnvironment(envId);
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
    throw new UsageError(
      sub === undefined
        ? "env needs a subcommand: list, show, delete or retry"
        : `unknown env subcommand '${sub}'`,
      true,
    );
  },
};
