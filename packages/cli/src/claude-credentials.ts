import type { ClaudeCredentialSummary } from "@sky/shared";
import type { AgentCommand } from "./agent.js";
import { UsageError } from "./output.js";

/**
 * Name and kind, when it resets (a dash when not limited), runs since midnight UTC, then the
 * assigned env ids, comma-joined (a dash for none). No field can hold a value: the API has none to send.
 */
const credentialLine = (c: ClaudeCredentialSummary) =>
  [
    c.name,
    c.kind,
    c.limitedUntil === null ? "-" : `limited-until=${c.limitedUntil}`,
    c.runsToday,
    c.environments.length === 0
      ? "-"
      : c.environments.map((e) => e.id).join(","),
  ].join(" ");

export const claudeCredentials: AgentCommand = {
  options: {},
  prepare(positionals) {
    if (positionals.length > 0) {
      throw new UsageError("claude-credentials takes no arguments", true);
    }
    return async (api, _io, out) => {
      const credentials = await api.listClaudeCredentials();
      out.result(
        { data: credentials },
        credentials.map(credentialLine).join("\n"),
      );
      return 0;
    };
  },
};
