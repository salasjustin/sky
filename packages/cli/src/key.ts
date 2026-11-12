import type { ApiKey, EnvironmentId } from "@sky/shared";
import type { AgentCommand } from "./agent.js";
import { UsageError } from "./output.js";
import { resolveEnvId } from "./secret.js";

/** The name goes between fixed fields so one with spaces still splits: three words before, the env ids after. */
const keyLine = (k: ApiKey) =>
  `${k.id} ${k.role} ${k.revokedAt === null ? "active" : "revoked"} ${k.name} ${k.environmentIds.join(",")}`;

const split = (list: string) =>
  list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

export const key: AgentCommand = {
  options: {
    role: { type: "string" },
    env: { type: "string", multiple: true },
  },
  prepare(positionals, values) {
    const [sub, ...rest] = positionals;
    if (sub !== "create" && sub !== "list" && sub !== "revoke") {
      throw new UsageError(
        sub === undefined
          ? "key needs a subcommand: create, list or revoke"
          : `unknown key subcommand '${sub}'`,
        true,
      );
    }
    if (
      sub !== "create" &&
      (values.env !== undefined || values.role !== undefined)
    ) {
      throw new UsageError("--env and --role only go with key create", true);
    }
    if (sub === "list") {
      if (rest.length > 0) {
        throw new UsageError("key list takes no arguments", true);
      }
      return async (api, _io, out) => {
        const keys = await api.listKeys();
        if (keys.length === 0 && !out.json) {
          out.progress(
            "no keys; create one with sky key create <name> --env=<id|name>",
          );
        } else {
          out.result({ data: keys }, keys.map(keyLine).join("\n"));
        }
        return 0;
      };
    }
    if (sub === "revoke") {
      const [id, ...extra] = rest;
      if (id === undefined || extra.length > 0) {
        throw new UsageError("key revoke takes <id>", true);
      }
      return async (api, _io, out) => {
        await api.revokeKey(id);
        out.result({ id, revoked: true }, `revoked ${id}`);
        return 0;
      };
    }
    const [name, ...extra] = rest;
    if (name === undefined || extra.length > 0) {
      throw new UsageError(
        "key create takes <name> --env=<id|name>,... [--role=runs]",
        true,
      );
    }
    if ((values.role ?? "runs") !== "runs") {
      throw new UsageError("--role is runs, the only role a key gets", true);
    }
    if (values.env === undefined) {
      throw new UsageError("key create needs --env=<id|name>,...", true);
    }
    const envRefs = split(values.env);
    if (envRefs.length === 0) {
      throw new UsageError("--env names no environment", true);
    }
    return async (api, _io, out) => {
      const environmentIds: EnvironmentId[] = [];
      for (const ref of envRefs) {
        const id = await resolveEnvId(api, ref, out);
        if (id === undefined) return 1;
        environmentIds.push(id);
      }
      const created = await api.createKey({
        name,
        role: "runs",
        environmentIds,
      });
      out.progress("the secret is shown only now; it can't be retrieved again");
      out.result(created, `${created.id} ${created.secret}`);
      return 0;
    };
  },
};
