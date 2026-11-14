import { posix } from "node:path";
import {
  type AutoApprove,
  type AutoApproveScope,
  isAutoApproved,
} from "@sky/shared";
import { z } from "zod";

/** The input field a parenthesised pattern matches against, per tool. */
const ARGUMENT_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
};

const PATTERN = /^([A-Za-z0-9_-]+)(?:\((.+)\))?$/;

/**
 * One approval-policy entry, in Claude Code permission-rule syntax: `Tool`, `Tool(exact)`
 * or `Tool(prefix:*)`. The parenthesised form only exists for the tools in ARGUMENT_FIELD.
 */
export const PolicyPattern = z.string().refine((s) => {
  const [, tool = "", argument] = PATTERN.exec(s) ?? [];
  return tool !== "" && (argument === undefined || tool in ARGUMENT_FIELD);
}, "expected Tool, Tool(exact) or Tool(prefix:*) for Bash, Read, Write, Edit or NotebookEdit");

/**
 * What the policy does with one tool call: `run` when no pattern matches, `auto-approved` when
 * only a bare `Bash` pattern matches and the command is read-only (see `isAutoApproved`), else
 * `hold`. A pattern that names a command always holds: writing `Bash(git diff:*)` is asking for
 * that hold. The read-only check fails closed: a relative `scope.cwd` or a throw holds the call.
 * Patterns are assumed valid `PolicyPattern`s.
 */
export function policyOutcome(
  policy: readonly string[],
  autoApprove: AutoApprove,
  scope: AutoApproveScope,
  toolName: string,
  input: unknown,
): "run" | "auto-approved" | "hold" {
  const matched = policy.filter((pattern) =>
    matchesOne(pattern, toolName, input),
  );
  if (matched.length === 0) return "run";
  if (matched.some((pattern) => pattern !== "Bash")) return "hold";
  return isReadOnly(input, autoApprove, scope) ? "auto-approved" : "hold";
}

function isReadOnly(
  input: unknown,
  autoApprove: AutoApprove,
  scope: AutoApproveScope,
): boolean {
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  if (scope.cwd !== undefined && !posix.isAbsolute(scope.cwd)) return false;
  try {
    return isAutoApproved(command, autoApprove, scope);
  } catch {
    return false;
  }
}

/** Whether `policy` holds this tool call for approval, ignoring any auto-approval. */
export function matchesPolicy(
  policy: readonly string[],
  toolName: string,
  input: unknown,
): boolean {
  return policy.some((pattern) => matchesOne(pattern, toolName, input));
}

export type ReadRule = { path: string; prefix: boolean };

/** The path each parenthesised `Read` pattern of `policy` names, and whether it is a `prefix:*`. */
export function readRules(policy: readonly string[]): ReadRule[] {
  return policy.flatMap((pattern): ReadRule[] => {
    const [, tool, rule] = PATTERN.exec(pattern) ?? [];
    if (tool !== "Read" || rule === undefined) return [];
    return rule.endsWith(":*")
      ? [{ path: rule.slice(0, -2), prefix: true }]
      : [{ path: rule, prefix: false }];
  });
}

function matchesOne(pattern: string, toolName: string, input: unknown) {
  const [, tool, rule] = PATTERN.exec(pattern) ?? [];
  if (tool !== toolName) return false;
  if (rule === undefined) return true;
  const value = (input as Record<string, unknown> | null)?.[
    ARGUMENT_FIELD[toolName] ?? ""
  ];
  if (typeof value !== "string") return false;
  const prefix = rule.endsWith(":*") ? rule.slice(0, -2) : undefined;
  // a compound command is held when any one of its commands matches, so `cd x && git push` can't slip past
  const candidates =
    toolName === "Bash" ? value.split(/&&|\|\||[;|&\n]/) : [value];
  return candidates.some((c) => {
    const candidate = c.trim();
    return prefix === undefined
      ? candidate === rule
      : candidate.startsWith(prefix);
  });
}
