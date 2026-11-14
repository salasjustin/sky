import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** The path input of each file-reading tool, which Claude Code refuses outside its working directories. */
const PATH_FIELD: Record<string, string> = {
  Read: "file_path",
  Grep: "path",
  Glob: "path",
};

/** The most an approved outside read copies into the scratch directory. */
export const STAGE_MAX_BYTES = 64 * 1024 * 1024;

export type OutsideRead = { field: string; path: string };

/** The real path of `path`, or of its nearest existing ancestor with the rest appended when it isn't there yet. */
function realpathLoose(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathLoose(parent), basename(path));
  }
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The path a Read, Grep or Glob call names when it lies outside every one of `roots`, else
 * undefined. A relative path is taken from `cwd`, and symlinks are resolved first, as Claude Code
 * resolves them: a link inside the worktree that points out is outside. A Grep or Glob with no
 * `path` searches the worktree.
 */
export function outsideRead(
  toolName: string,
  input: unknown,
  roots: readonly string[],
  cwd: string,
): OutsideRead | undefined {
  const field = PATH_FIELD[toolName];
  if (field === undefined) return undefined;
  const value = (input as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value === "") return undefined;
  const path = realpathLoose(resolve(cwd, value));
  return roots.some((root) => within(realpathLoose(root), path))
    ? undefined
    : { field, path };
}

function treeBytes(path: string, budget: number): number {
  const info = lstatSync(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of readdirSync(path)) {
    total += treeBytes(join(path, name), budget - total);
    if (total > budget) break;
  }
  return total;
}

/**
 * Copies an approved outside read into `scratch` and returns the copy's path, which Claude Code can
 * read without leaving its working directories. Throws when the path is missing or larger than
 * `STAGE_MAX_BYTES`.
 */
export function stageRead(
  read: OutsideRead,
  scratch: string,
  slot: number,
): string {
  if (!existsSync(read.path)) throw new Error(`${read.path} does not exist`);
  if (treeBytes(read.path, STAGE_MAX_BYTES) > STAGE_MAX_BYTES)
    throw new Error(
      `${read.path} is larger than ${STAGE_MAX_BYTES / 1024 / 1024} MiB`,
    );
  const dir = join(scratch, "approved", String(slot));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copy = join(dir, basename(read.path));
  cpSync(read.path, copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}
