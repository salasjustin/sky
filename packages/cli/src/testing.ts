import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "./cli.js";

export const apiUrl = "https://sky.test";
export const apiKey = "hk_test_secret_key";

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  sleeps: number[];
  /** What a Ctrl-C would have printed, for each distinct note armed while the CLI slept. */
  interruptNotes: string[];
  /** Notes still armed when the run returned; a finished wait disarms its own. */
  armedAtExit: number;
}

/** Runs the CLI in-process against MSW with a fake clock that `sleep` advances. */
export async function runCli(
  argv: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: Partial<Io["stdin"]>;
    stderrIsTTY?: boolean;
  } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  let clock = 0;
  const sleeps: number[] = [];
  const armed = new Set<string>();
  const interruptNotes = new Set<string>();
  const code = await run({
    argv,
    env: {
      SKY_URL: apiUrl,
      SKY_API_KEY: apiKey,
      ...opts.env,
    },
    home: mkdtempSync(join(tmpdir(), "sky-home-")),
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    stderrIsTTY: opts.stderrIsTTY ?? false,
    stdin: {
      isTTY: false,
      readAll: async () => "",
      promptHidden: async () => {
        throw new Error("unexpected prompt");
      },
      prompt: async () => {
        throw new Error("unexpected prompt");
      },
      ...opts.stdin,
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      for (const note of armed) interruptNotes.add(note);
    },
    now: () => clock,
    onInterrupt: (note) => {
      armed.add(note);
      return () => armed.delete(note);
    },
  });
  return {
    code,
    stdout,
    stderr,
    sleeps,
    interruptNotes: [...interruptNotes],
    armedAtExit: armed.size,
  };
}
