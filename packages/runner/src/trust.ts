import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Marks each path as a trusted project in Claude Code's user config `file`, so a nested `claude -p`
 * honours the repo's `permissions.allow` entries, which wait on trust. The mark is permanent and
 * applies to every Claude session in that repo, not only nested ones. Merges into the file: every
 * other key stays, and so does its mode. When every path is already trusted the file is untouched. The write
 * goes to a temp file renamed into place. Returns whether it wrote.
 */
export function trustProjects(
  file: string,
  paths: string[],
  rename: typeof renameSync = renameSync,
): boolean {
  let text: string | undefined;
  let mode = 0o600;
  try {
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config: Record<string, unknown> =
    text === undefined || text.trim() === "" ? {} : JSON.parse(text);
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error(`${file} is not a JSON object`);
  const projects = config.projects;
  if (
    projects !== undefined &&
    (typeof projects !== "object" ||
      projects === null ||
      Array.isArray(projects))
  )
    throw new Error(`${file} has a "projects" that is not an object`);
  const merged: Record<string, Record<string, unknown>> = {
    ...(projects as Record<string, Record<string, unknown>> | undefined),
  };
  let changed = false;
  for (const path of paths) {
    const entry = merged[path];
    if (entry?.hasTrustDialogAccepted === true) continue;
    merged[path] = { ...entry, hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return false;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ ...config, projects: merged }, null, 2)}\n`,
      {
        mode,
      },
    );
    rename(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

/**
 * The paths `file` doesn't hold as trusted now, read back from disk: another process rewriting the
 * config between our write and Claude's read can drop the entry. A file that can't be read holds none.
 */
export function untrustedPaths(file: string, paths: string[]): string[] {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }> = {};
  try {
    projects = JSON.parse(readFileSync(file, "utf8")).projects ?? {};
  } catch {}
  return paths.filter(
    (path) => projects[path]?.hasTrustDialogAccepted !== true,
  );
}
