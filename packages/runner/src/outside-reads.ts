import {
  constants,
  createWriteStream,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { readRules } from "./policy.js";

/** The path input of each file-reading tool, which Claude Code refuses outside its working directories. */
const PATH_FIELD: Record<string, string> = {
  Read: "file_path",
  Grep: "path",
  Glob: "path",
};

/** The most bytes an approved outside read copies into the scratch directory. */
export const STAGE_MAX_BYTES = 64 * 1024 * 1024;

/** The most files, directories and links an approved outside read copies. */
export const STAGE_MAX_ENTRIES = 10_000;

/**
 * `path` is where the call reads; an approved call has `field` pointed at the copy. A Glob whose
 * pattern climbs out names its literal prefix as `path`, and `pattern` is the rest of it, which the
 * approved call takes in place of its own.
 */
export type OutsideRead = { field: string; path: string; pattern?: string };

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
  // a top-level entry named `..foo` is inside
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** `value` with a leading `~` or `~/` taken as `home`, as Claude Code takes it. */
const expandHome = (value: string, home: string) =>
  value === "~" || value.startsWith("~/") ? home + value.slice(1) : value;

const GLOB_META = /[*?[{]/;

/**
 * A Glob pattern split where matching starts: the segments before the first one holding a glob
 * metacharacter, and the rest. The last segment is always in the rest, so the prefix is a directory.
 */
function splitGlob(pattern: string): { prefix: string; rest: string } {
  const segments = pattern.split("/");
  const first = segments.findIndex((segment) => GLOB_META.test(segment));
  const at = first === -1 ? segments.length - 1 : first;
  return {
    prefix:
      segments.slice(0, at).join("/") || (pattern.startsWith("/") ? "/" : ""),
    rest: segments.slice(at).join("/"),
  };
}

/**
 * The path a Read, Grep or Glob call names when it lies outside every one of `roots`, else
 * undefined. A relative path is taken from `cwd`, a leading `~` from `home`, and symlinks are
 * resolved first, as Claude Code resolves them: a link inside the worktree that points out is
 * outside. A Grep or Glob with no `path` searches `cwd`. A Glob's `pattern` is read from its literal
 * prefix joined to that, so an absolute, `~` or `..` pattern is outside too; Grep's `glob` only
 * filters names under its search root.
 */
export function outsideRead(
  toolName: string,
  input: unknown,
  roots: readonly string[],
  cwd: string,
  home: string = homedir(),
): OutsideRead | undefined {
  const field = PATH_FIELD[toolName];
  if (field === undefined) return undefined;
  const fields = input as Record<string, unknown> | null;
  const value = fields?.[field];
  const named = typeof value === "string" && value !== "";
  const base = named ? resolve(cwd, expandHome(value, home)) : cwd;
  const pattern = fields?.pattern;
  const glob =
    toolName === "Glob" && typeof pattern === "string"
      ? splitGlob(expandHome(pattern, home))
      : undefined;
  if (!named && !glob?.prefix) return undefined;
  const path = realpathLoose(glob ? resolve(base, glob.prefix) : base);
  if (roots.some((root) => within(realpathLoose(root), path))) return undefined;
  return glob ? { field, path, pattern: glob.rest } : { field, path };
}

/**
 * Whether a `Read(...)` pattern of `policy` covers the real path `path` once the pattern's own path is
 * resolved the way a read's is (a leading `~` from `home`, a relative path from `cwd`, symlinks
 * followed): `path` is that path or, for `prefix:*`, starts with it; or that path lies inside `path`,
 * a tree a Grep, Glob or directory Read searches.
 */
export function readRuleCovers(
  policy: readonly string[],
  path: string,
  cwd: string,
  home: string = homedir(),
): boolean {
  return readRules(policy).some((rule) => {
    if (rule.prefix && rule.path === "") return true;
    const named = resolve(cwd, expandHome(rule.path, home));
    // a prefix may stop mid-name (`/srv/priv:*`), which only its parent's real path keeps
    const spellings = [
      realpathLoose(named),
      join(realpathLoose(dirname(named)), basename(named)),
    ];
    return spellings.some(
      (rulePath) =>
        within(path, rulePath) ||
        (rule.prefix ? path.startsWith(rulePath) : path === rulePath),
    );
  });
}

/**
 * Whether the real path `path` is in, or holds, one of the Claude config directories `configDirs`, and
 * whether it is in the saved tool output of session `sessionId` there:
 * `projects/<project>/<sessionId>/tool-results`.
 */
export function configDirPlace(
  path: string,
  configDirs: readonly string[],
  sessionId: string | undefined,
): "session-output" | "config" | undefined {
  const roots = configDirs.map(realpathLoose);
  // a search of a tree that holds a config directory reads all of it
  if (roots.some((root) => within(path, root))) return "config";
  for (const root of roots) {
    if (!within(root, path)) continue;
    const [top, , session, folder] = relative(root, path).split(sep);
    return top === "projects" &&
      sessionId !== undefined &&
      session === sessionId &&
      folder === "tool-results"
      ? "session-output"
      : "config";
  }
  return undefined;
}

/** What no approval copies, whatever the person answered. */
export type RefusedPaths = {
  /** Directories nothing is copied from, nor a hard link to any file in them: the runners' credential directories. */
  secretDirs: readonly string[];
  /** Files never copied, by path or by a hard link to them: Claude Code's login and account state. */
  secretFiles: readonly string[];
  /** Directories nothing is copied from: the kernel's, whose files read other than their size says. */
  systemDirs: readonly string[];
};

export type StageLimits = { maxBytes?: number; maxEntries?: number };

const inodeOf = (info: Stats) => `${info.dev}:${info.ino}`;

/** Every regular file's inode under `dir`, less `skip`'s; a directory gone or unreadable adds nothing. */
async function collectInodes(
  dir: string,
  skip: string,
  inodes: Set<string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== skip) await collectInodes(path, skip, inodes);
    } else if (entry.isFile()) {
      const info = await lstat(path).catch(() => undefined);
      if (info) inodes.add(inodeOf(info));
    }
  }
}

/** Why `path` (a real path, `info` its lstat) is never copied, or undefined. */
type Refusal = (path: string, info: Stats) => string | undefined;

/**
 * Why a real path is never copied by its name alone, or undefined: what `refused` holds, outside the
 * run's own `scratch`. A hard link to a credential file is `refusalOf`'s to find, at copy time.
 */
export function pathRefusal(
  scratch: string | undefined,
  refused: RefusedPaths,
): (path: string) => string | undefined {
  const own = scratch === undefined ? undefined : realpathLoose(scratch);
  const secretDirs = refused.secretDirs.map(realpathLoose);
  const systemDirs = refused.systemDirs.map(realpathLoose);
  const secretFiles = new Set(refused.secretFiles.map(realpathLoose));
  return (path) => {
    if (secretFiles.has(path)) return "is Claude Code's login or account file";
    if (systemDirs.some((dir) => within(dir, path)))
      return "is in a system directory";
    if (
      !(own !== undefined && within(own, path)) &&
      secretDirs.some((dir) => within(dir, path))
    )
      return "is in a runner's credential directory";
    return undefined;
  };
}

/**
 * Taken when the copy starts, after the approval: the credential files of a runner started since then
 * are refused by path but not by hard link.
 */
async function refusalOf(
  scratch: string,
  refused: RefusedPaths,
): Promise<Refusal> {
  const own = realpathLoose(scratch);
  const byPath = pathRefusal(scratch, refused);
  const secretInodes = new Set<string>();
  for (const file of refused.secretFiles) {
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) secretInodes.add(inodeOf(info));
  }
  // the run's own scratch holds only approved copies, each a file of its own
  for (const dir of refused.secretDirs.map(realpathLoose))
    await collectInodes(dir, own, secretInodes);
  return (path, info) => {
    const why = byPath(path);
    if (why) return why;
    if (info.isFile() && secretInodes.has(inodeOf(info)))
      return "is a hard link to a credential file";
    return undefined;
  };
}

const MIB = 1024 * 1024;
const sizeText = (bytes: number) =>
  bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;

type Walk = {
  /** The approved path, as resolved at copy time. */
  source: string;
  refusal: Refusal;
  maxBytes: number;
  maxEntries: number;
  bytes: number;
  entries: number;
};

// non-blocking, so a file swapped for a FIFO after its lstat can't hold the open
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function copyFile(
  src: string,
  dest: string,
  info: Stats,
  walk: Walk,
): Promise<void> {
  const handle = await open(src, READ_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || inodeOf(opened) !== inodeOf(info))
      throw new Error(`${src} changed while it was being copied`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  await pipeline(
    handle.createReadStream(),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        walk.bytes += chunk.length;
        if (walk.bytes > walk.maxBytes)
          throw new Error(
            `${walk.source} is larger than ${sizeText(walk.maxBytes)}`,
          );
        yield chunk;
      }
    },
    createWriteStream(dest, { flags: "wx", mode: 0o600 }),
  );
}

/**
 * Copies `src` to `dest` with modes of its own: directories 0700 and files 0600, so the run's end can
 * always remove the copy. A symlink is copied as the link, and a read through it is gated again;
 * sockets, FIFOs and devices are skipped.
 */
async function copyEntry(src: string, dest: string, walk: Walk): Promise<void> {
  if (++walk.entries > walk.maxEntries)
    throw new Error(
      `${walk.source} holds more than ${walk.maxEntries} files and directories`,
    );
  const info = await lstat(src);
  if (info.isSymbolicLink()) return symlink(await readlink(src), dest);
  const why = walk.refusal(src, info);
  if (why) throw new Error(`${src} ${why}`);
  if (info.isDirectory()) {
    await mkdir(dest, { mode: 0o700 });
    for (const name of await readdir(src))
      await copyEntry(join(src, name), join(dest, name), walk);
  } else if (info.isFile()) await copyFile(src, dest, info, walk);
}

/**
 * Copies an allowed outside read into `scratch` and returns the copy's path, which Claude Code can
 * read without leaving its working directories. The path is resolved again first, since the tree may
 * have changed since the gate, while a person was asked. Throws, leaving no partial copy, when the
 * path is missing or not a file or directory, when anything in it is `refused` (outside the run's own
 * `scratch`), or past `maxBytes` read or `maxEntries` copied.
 */
export async function stageRead(
  read: OutsideRead,
  scratch: string,
  slot: number,
  refused: RefusedPaths,
  {
    maxBytes = STAGE_MAX_BYTES,
    maxEntries = STAGE_MAX_ENTRIES,
  }: StageLimits = {},
): Promise<string> {
  const source = await realpath(read.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${read.path} does not exist`);
    throw error;
  });
  const info = await lstat(source);
  if (!info.isFile() && !info.isDirectory())
    throw new Error(`${source} is not a file or directory`);
  const walk: Walk = {
    source,
    refusal: await refusalOf(scratch, refused),
    maxBytes,
    maxEntries,
    bytes: 0,
    entries: 0,
  };
  const dir = join(scratch, "approved", String(slot));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const copy = join(dir, basename(read.path));
  try {
    await copyEntry(source, copy, walk);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return copy;
}
