import { readFileSync } from "node:fs";
import { EventType, StandardWebhookSecret } from "@sky/shared";
import type { AgentCommand } from "./agent.js";
import type { Io } from "./cli.js";
import { readStdinValue } from "./input.js";
import { UsageError } from "./output.js";
import { resolveEnvId } from "./secret.js";

const webhookLine = (w: {
  id: string;
  format: string;
  url: string;
  eventTypes: string[];
  environmentIds?: string[];
}) =>
  `${w.id} ${w.format} ${w.url} ${w.eventTypes.join(",")}${
    w.environmentIds ? ` ${w.environmentIds.join(",")}` : ""
  }`;

const split = (list: string) =>
  list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** The secret never comes from argv, where `ps` and shell history would keep it: `-` reads stdin (a hidden prompt on a terminal), `@path` a file. */
async function readSecret(
  source: string,
  url: string,
  io: Io,
): Promise<string> {
  let raw: string;
  let from: string;
  if (source === "-") {
    from = "from stdin";
    raw = await readStdinValue(io, {
      prompt: `Secret for ${url}: `,
      noun: "secret",
      empty: `the secret ${from} is empty`,
    });
  } else if (source.startsWith("@")) {
    const file = source.slice(1);
    from = `in ${file}`;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new UsageError(`cannot read ${file}${code ? ` (${code})` : ""}`);
    }
  } else {
    // never echo the argument: it is probably the secret itself
    throw new UsageError(
      "--secret takes @<file> or - (stdin), not the secret itself",
      true,
    );
  }
  const secret = raw.trim();
  if (secret === "") throw new UsageError(`the secret ${from} is empty`);
  if (!StandardWebhookSecret.safeParse(secret).success) {
    throw new UsageError(
      "the secret must be whsec_ followed by the base64 of a 24-64 byte key",
    );
  }
  return secret;
}

export const webhook: AgentCommand = {
  options: {
    events: { type: "string" },
    format: { type: "string" },
    secret: { type: "string" },
    env: { type: "string" },
  },
  prepare(positionals, values) {
    const [sub, ...rest] = positionals;
    if (sub !== "add" && (values.events || values.format || values.env)) {
      throw new UsageError(
        "--events, --format and --env only go with webhook add",
        true,
      );
    }
    if (sub !== "add" && values.secret !== undefined) {
      throw new UsageError("--secret only goes with webhook add", true);
    }
    if (sub === "list") {
      if (rest.length > 0) {
        throw new UsageError("webhook list takes no arguments", true);
      }
      return async (api, _io, out) => {
        const { raw, webhooks } = await api.listWebhooks();
        if (webhooks.length === 0 && !out.json) {
          out.progress(
            "no webhooks; add one with sky webhook add <url> --events=<types>",
          );
        } else {
          out.result(raw, webhooks.map(webhookLine).join("\n"));
        }
        return 0;
      };
    }
    if (sub === "delete") {
      const [id, ...extra] = rest;
      if (id === undefined || extra.length > 0) {
        throw new UsageError("webhook delete takes <id>", true);
      }
      return async (api, _io, out) => {
        await api.deleteWebhook(id);
        out.result({ id, deleted: true }, `deleted ${id}`);
        return 0;
      };
    }
    if (sub === "add") {
      const [url, ...extra] = rest;
      if (url === undefined || extra.length > 0) {
        throw new UsageError(
          "webhook add takes <url> --events=<types,...> [--format=standard --secret=@file|-] [--env=<id|name>,...]",
          true,
        );
      }
      if (values.events === undefined) {
        throw new UsageError("webhook add needs --events=<types,...>", true);
      }
      const eventTypes = split(values.events);
      for (const type of eventTypes) {
        if (!EventType.safeParse(type).success) {
          throw new UsageError(`'${type}' is not an event type`, true);
        }
      }
      if (eventTypes.length === 0) {
        throw new UsageError("--events names no event type", true);
      }
      const format = values.format ?? "sky";
      if (format !== "sky" && format !== "standard") {
        throw new UsageError("--format is sky or standard", true);
      }
      if (format === "standard" && values.secret === undefined) {
        throw new UsageError("--format=standard needs --secret=@file|-", true);
      }
      if (format === "sky" && values.secret !== undefined) {
        throw new UsageError("--secret only goes with --format=standard", true);
      }
      const envRefs = values.env === undefined ? undefined : split(values.env);
      if (envRefs?.length === 0) {
        throw new UsageError("--env names no environment", true);
      }
      return async (api, io, out) => {
        const secret =
          values.secret === undefined
            ? undefined
            : await readSecret(values.secret, url, io);
        let environmentIds: string[] | undefined;
        if (envRefs) {
          environmentIds = [];
          for (const ref of envRefs) {
            const id = await resolveEnvId(api, ref, out);
            if (id === undefined) return 1;
            environmentIds.push(id);
          }
        }
        const created = await api.createWebhook({
          url,
          eventTypes,
          format,
          ...(secret === undefined ? {} : { secret }),
          ...(environmentIds === undefined ? {} : { environmentIds }),
        });
        out.result(created.raw, webhookLine(created.webhook));
        return 0;
      };
    }
    throw new UsageError(
      sub === undefined
        ? "webhook needs a subcommand: add, list or delete"
        : `unknown webhook subcommand '${sub}'`,
      true,
    );
  },
};
