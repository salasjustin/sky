import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOGIN = "claudeAiOauth";

/**
 * The entries in the credential file, or undefined when it is missing or not a JSON object: a file
 * this can't parse is left as it is. Any other read error throws, so a path that can't be read is
 * never replaced.
 */
async function readExisting(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The login a runner stored for a nested `claude`: a long-lived `claude setup-token` token, so no
 * refresh token and no expiry. An interactive `claude` login always has both.
 */
function isSkyLogin(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const { refreshToken, expiresAt } = entry as Record<string, unknown>;
  return refreshToken === null && expiresAt === null;
}

/**
 * Removes the subscription token an earlier runner stored in Claude Code's credential file,
 * where every later run's commands could read it; resolves to whether there was one. The runner's
 * `claude` processes run host-managed, which ignores a stored login, so nothing here writes one.
 *
 * Only that entry goes. A login a person made interactively and every other entry, such as a
 * `designOauth` credential from `/design-login`, are kept; a file with nothing left is deleted.
 * Every agent on a sprite shares this file, so it is never rewritten in place, where a `claude`
 * reading it mid-write could find it half-written: the rest goes to a 0600 temp file that is
 * renamed over it.
 */
export async function removeSkyLogin(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): Promise<boolean> {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const path = join(dir, ".credentials.json");
  const existing = await readExisting(path);
  if (!existing || !isSkyLogin(existing[LOGIN])) return false;
  const rest = Object.entries(existing).filter(([key]) => key !== LOGIN);
  if (rest.length === 0) {
    await rm(path, { force: true });
    return true;
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(Object.fromEntries(rest)), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return true;
}
