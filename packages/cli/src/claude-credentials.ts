import type { ClaudeCredentialSummary } from "@sky/shared";
import type { AgentCommand } from "./agent.js";
import { UsageError } from "./output.js";

const percent = (
  label: string,
  window: { utilization: number } | null | undefined,
) => (window ? `${label}=${Math.round(window.utilization * 100)}%` : "-");

/**
 * Name and kind, when it resets (a dash when not limited), runs since midnight UTC, the assigned env
 * ids, its last-seen 5-hour and 7-day usage as percentages, then the pool env ids that may use it;
 * ids comma-joined, and a dash for an empty list or a window never read. No field can hold a value:
 * the API has none to send.
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
    percent("5h", c.usage?.fiveHour),
    percent("7d", c.usage?.sevenDay),
    c.poolEnvironments.length === 0
      ? "-"
      : c.poolEnvironments.map((e) => e.id).join(","),
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
