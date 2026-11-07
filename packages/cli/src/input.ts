import type { Io } from "./cli.js";
import { UsageError } from "./output.js";

/**
 * Reads a value that must never come from argv, where `ps` and shell history would keep it:
 * piped stdin is read; a terminal gets a hidden prompt on stderr; a terminal with no one to
 * answer (stderr not a TTY, or `CI` set) is a usage error rather than a silent wait.
 */
export async function readStdinValue(
  io: Io,
  ask: {
    /** shown on stderr when prompting, e.g. `Value for TOKEN: ` */
    prompt: string;
    /** what to pipe, in "pipe the <noun> on stdin" */
    noun: string;
    /** the usage error for an empty value */
    empty: string;
  },
): Promise<string> {
  let raw: string;
  if (!io.stdin.isTTY) {
    raw = await io.stdin.readAll();
  } else if (io.stderrIsTTY && !io.env.CI) {
    raw = await io.stdin.promptHidden(ask.prompt);
  } else {
    throw new UsageError(
      `no terminal to prompt on; pipe the ${ask.noun} on stdin`,
    );
  }
  // `echo value |` and a heredoc both end in one newline that isn't part of the value
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") throw new UsageError(ask.empty);
  return value;
}
