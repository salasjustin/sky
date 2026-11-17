import { posix } from "node:path";

/**
 * Bash commands that run without an approval request. Deliberately strict and fail-closed:
 * simple commands joined by `;`, `&&`, `||` and `|` are approved only when every one of them
 * would be on its own, and anything this parser doesn't fully understand is left for a person
 * to decide.
 */

/**
 * Commands approved by default; each entry is the leading words of a command. The pnpm scripts
 * run whatever `package.json` says: they are here so a fix-and-verify loop doesn't ask, and an
 * environment that doesn't accept that drops them with `defaults: false`.
 */
export const DEFAULT_AUTO_APPROVE_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "grep",
  "rg",
  "sed",
  "head",
  "tail",
  "wc",
  "find",
  "pwd",
  "echo",
  "which",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git rev-parse",
  "pnpm test",
  "pnpm typecheck",
  "pnpm lint",
  "node --version",
];

export type AutoApprove = {
  /** Whether `DEFAULT_AUTO_APPROVE_COMMANDS` apply; false replaces them with `commands` alone. */
  defaults: boolean;
  /** Extra commands, each the leading words of a command, e.g. `git tag --list` or `make check`. */
  commands: string[];
};

type Operator = ";" | "&&" | "||" | "|";
/**
 * `literal` marks a word holding `$`, a backtick, `\` or `!` inside single quotes, or a kept
 * backslash inside double quotes, `braced` one of the words a `{a,b}` group expanded to,
 * `tilde` a word that starts with an unquoted `~` the shell expands to its home; `redirect` is
 * one of the harmless ones `lex` lets through.
 */
type Token =
  | { word: string; literal: boolean; braced: boolean; tilde: boolean }
  | { op: Operator }
  | { redirect: true };

/** More words than this from one brace-expanded word asks rather than being checked one by one. */
const MAX_BRACE_WORDS = 64;

/**
 * Programs whose arguments are patterns, programs or text and go no further, so a single-quoted
 * `$` reaches them as a plain character. Anything else may hand an argument to a shell or an
 * expander of its own (pnpm script arguments, `make 'X=$(shell …)'`), so it asks.
 */
const TAKES_LITERALS = new Set([
  "grep",
  "rg",
  "sed",
  "echo",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "jq",
  "awk",
]);

// Outside quotes these either chain, redirect, substitute, expand or comment; inside quotes they are literal.
const UNQUOTED_SPECIAL = /[;&|<>()*?[\]{}#]/;
// Expand or escape even inside double quotes, so they are refused outside single quotes, except
// a backslash in double quotes that bash keeps as is.
const EXPANDING = /[$`\\!]/;
// End a command, or hide the rest of it, wherever they appear.
const LINE_BREAKING = /[\n\r\0]/;

/**
 * Splits a command into words and the chaining operators between them, or undefined when it
 * holds anything else.
 */
function lex(command: string): Token[] | undefined {
  if (LINE_BREAKING.test(command)) return undefined;
  const tokens: Token[] = [];
  let text = "";
  let open = false;
  let quoted = false;
  let literal = false;
  let tilde = false;
  let quote: string | undefined;
  // a word with brace groups: the alternatives of each finished segment, and the group still open
  let parts: string[][] = [];
  let group: string[] | undefined;
  const dropWord = () => {
    text = "";
    open = false;
    quoted = false;
    literal = false;
    tilde = false;
    parts = [];
  };
  /** False when the word's braces don't make a plain `{a,b}` expansion. */
  const endWord = (): boolean => {
    if (group) return false;
    if (!open) return true;
    let words = [""];
    for (const alternatives of [...parts, [text]]) {
      words = words.flatMap((w) => alternatives.map((a) => w + a));
      if (words.length > MAX_BRACE_WORDS) return false;
    }
    const braced = parts.length > 0;
    // tilde and zsh's `=` expansion run after brace expansion, and an empty word vanishes
    if (braced && words.some((w) => w === "" || /^[~=]/.test(w))) return false;
    for (const word of words) tokens.push({ word, literal, braced, tilde });
    dropWord();
    return true;
  };
  const append = (ch: string) => {
    if (group) group[group.length - 1] += ch;
    else text += ch;
    open = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    const next = command[i + 1];
    // in double quotes bash keeps a backslash as is unless `$`, a backtick, `"` or `\` follows,
    // so `"a\|b"` reaches the program as `a\|b`; `\!` asks too, since zsh drops that backslash
    // and bash with history expansion on keeps it
    if (quote === '"' && ch === "\\") {
      if (next === undefined || EXPANDING.test(next) || next === '"')
        return undefined;
      literal = true;
      text += ch + next;
      i++;
      continue;
    }
    // single quotes are fully literal in bash and zsh, so awk's `$1` is plain text there
    if (EXPANDING.test(ch)) {
      if (quote !== "'") return undefined;
      literal = true;
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else text += ch;
    } else if (ch === "'" || ch === '"') {
      if (group) return undefined;
      quote = ch;
      open = true;
      quoted = true;
    } else if (ch === ">") {
      // only `2>&1`, `2>/dev/null` and `>/dev/null`; a quoted or glued `2` is a word, not stderr
      const fd = open ? text : "";
      if (open && (fd !== "2" || quoted || parts.length > 0)) return undefined;
      dropWord();
      let j = i + 1;
      if (command[j] === "&") {
        if (fd !== "2" || command[j + 1] !== "1") return undefined;
        j += 2;
      } else {
        while (command[j] === " " || command[j] === "\t") j++;
        if (!command.startsWith("/dev/null", j)) return undefined;
        j += "/dev/null".length;
      }
      if (!/^[ \t;|&]?$/.test(command[j] ?? "")) return undefined;
      tokens.push({ redirect: true });
      i = j - 1;
    } else if (ch === " " || ch === "\t") {
      if (!endWord()) return undefined;
    } else if (ch === ";") {
      if (!endWord()) return undefined;
      tokens.push({ op: ";" });
    } else if ((ch === "&" || ch === "|") && next === ch) {
      if (!endWord()) return undefined;
      tokens.push({ op: ch === "&" ? "&&" : "||" });
      i++;
    } else if (ch === "|" && next !== "&") {
      if (!endWord()) return undefined;
      tokens.push({ op: "|" });
    } else if (ch === "{") {
      // one level of `{a,b}`; sequences (`{1..3}`) and nesting ask
      if (group) return undefined;
      parts.push([text]);
      text = "";
      group = [""];
      open = true;
    } else if (ch === "," && group) {
      group.push("");
    } else if (ch === "}") {
      if (!group || group.length < 2) return undefined;
      parts.push(group);
      group = undefined;
    } else if (UNQUOTED_SPECIAL.test(ch)) {
      return undefined;
    } else {
      // in zsh a leading `=` expands to a program's path
      if (!open && ch === "=") return undefined;
      // a leading unquoted `~` or `~/` is the home directory; `~user`, `~+` and the like ask
      if (!open && ch === "~") {
        if (next !== undefined && !/[/ \t;&|]/.test(next)) return undefined;
        tilde = true;
      }
      append(ch);
    }
  }
  if (quote !== undefined || !endWord()) return undefined;
  return tokens;
}

/**
 * One simple command of a compound one; `piped` when its stdin is the previous step's output,
 * `literal` when a word holds single-quoted expansion characters or a kept backslash in double
 * quotes.
 */
type Step = {
  words: string[];
  /** Per word: it started with an unquoted `~` that expands to the home directory. */
  tilde: boolean[];
  piped: boolean;
  literal: boolean;
};

/** Steps joined by `|`, run when `after` (the operator before it) lets them. */
type Pipeline = { steps: Step[]; after?: Exclude<Operator, "|"> };

/** The pipelines `;`, `&&` and `||` join, or undefined when any simple command is empty. */
function parsePipelines(command: string): Pipeline[] | undefined {
  const tokens = lex(command);
  if (!tokens) return undefined;
  const newStep = (piped: boolean): Step => ({
    words: [],
    tilde: [],
    piped,
    literal: false,
  });
  const pipelines: Pipeline[] = [{ steps: [newStep(false)] }];
  for (const token of tokens) {
    const pipeline = pipelines.at(-1);
    const step = pipeline?.steps.at(-1);
    if (!pipeline || !step) return undefined;
    if ("redirect" in token) continue;
    if ("word" in token) {
      // braces in the program's place would choose the program
      if (token.braced && step.words.length === 0) return undefined;
      step.words.push(token.word);
      step.tilde.push(token.tilde);
      step.literal ||= token.literal;
    } else if (step.words.length === 0) return undefined;
    else if (token.op === "|") pipeline.steps.push(newStep(true));
    else pipelines.push({ steps: [newStep(false)], after: token.op });
  }
  const steps = pipelines.flatMap((p) => p.steps);
  return steps.every((s) => s.words.length > 0) ? pipelines : undefined;
}

/** The words of an allowlist entry, or undefined when it isn't a plain run of words. */
export function parseCommandEntry(entry: string): string[] | undefined {
  const tokens = lex(entry);
  if (!tokens || tokens.length === 0) return undefined;
  const words = tokens.flatMap((t) => ("word" in t ? [t.word] : []));
  const tilde = tokens.some((t) => "tilde" in t && t.tilde);
  return !tilde &&
    words.length === tokens.length &&
    !isAssignment(words[0] ?? "")
    ? words
    : undefined;
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

const SENSITIVE_DIRS = new Set([
  ".claude",
  ".config",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  "environ",
]);
const SENSITIVE_FILES =
  /^(\.env|\.claude\.json|\.dev\.vars|\.npmrc|\.yarnrc|\.netrc|\.pgpass|\.pypirc|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519))|credentials|token|secret|\.tfstate|\.(pem|key|p12|pfx)$/i;

/** Every reading of `word` that a program might open as a path. */
function pathCandidates(word: string): string[] {
  const candidates = [word];
  // `--opt=value` and `rev:path` carry a path on either side of the separator
  for (const m of word.matchAll(/[=:]/g)) {
    candidates.push(word.slice(0, m.index), word.slice(m.index + 1));
  }
  // a short option's value may be glued on after any letter of a bundle (`-of/etc/passwd`)
  if (/^-[^-]/.test(word))
    for (let i = 2; i < word.length; i++) candidates.push(word.slice(i));
  return candidates;
}

const isOutside = (relative: string) =>
  relative === ".." || relative.startsWith("../");

/** Under the worktree's `.claude`, only these hold files an agent has reason to read. */
const CLAUDE_READABLE = /^\.claude\/(skills|agents|commands)(\/|$)/;

/**
 * Beside the worktree, read-only commands may name these, below the session's home: the plugin
 * cache only, since the rest of `~/.claude` holds the login, settings and account files, and
 * the kru store checkout. Taken afresh for each command: with `realpath`, a root whose real
 * location is `/`, the home, a directory holding the home, or inside `~/.claude` outside the
 * plugin cache (a link to a broader place) is dropped, so reads there ask.
 */
function extraRoots(
  home: string | undefined,
  realpath?: (path: string) => string,
): string[] {
  if (home === undefined || !posix.isAbsolute(home)) return [];
  const base = posix.resolve(home);
  const roots = [
    posix.join(base, ".claude/plugins/cache"),
    posix.join(base, ".kru"),
  ];
  if (!realpath) return roots;
  const real = (path: string): string | undefined => {
    try {
      return realpath(path);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // a root that doesn't exist yet is judged on its text; any other failure drops it
      return code === "ENOENT" || code === "ENOTDIR" ? path : undefined;
    }
  };
  const realHome = real(base);
  if (realHome === undefined) return [];
  const realCache = posix.join(realHome, ".claude/plugins/cache");
  const within = (parent: string, path: string) =>
    !isOutside(posix.relative(parent, path));
  return roots.filter((root) => {
    const target = real(root);
    if (target === undefined || target === "/" || target === realHome)
      return false;
    if (within(target, realHome)) return false;
    return (
      !within(posix.join(realHome, ".claude"), target) ||
      within(realCache, target)
    );
  });
}

/** The word with a leading `~` or `~/` taken to `home`, as the shell does; unchanged without a usable home. */
function expandTilde(word: string, home: string | undefined): string {
  if (home === undefined || !posix.isAbsolute(home)) return word;
  const base = posix.resolve(home);
  if (word === "~") return base;
  // a home of `/` takes `~/x` to `/x`, not `//x`
  return (base === "/" ? "" : base) + word.slice(1);
}

/**
 * Whether this path-ish text names somewhere secrets live. `allowClaude` lets the worktree's
 * `.claude/skills`, `.claude/agents` and `.claude/commands` through; the rest of `.claude` asks.
 */
function namesSecret(text: string, allowClaude = false): boolean {
  let segments = text.split(/[/=:]/).filter(Boolean);
  if (allowClaude) {
    const i = segments.indexOf(".claude");
    const next = segments[i + 1];
    if (
      i >= 0 &&
      (next === "skills" || next === "agents" || next === "commands")
    )
      segments = segments.filter((_, j) => j !== i);
  }
  return (
    segments.some((s) => SENSITIVE_DIRS.has(s) || SENSITIVE_FILES.test(s)) ||
    segments.some((s, i) => s === ".git" && segments[i + 1] === "config")
  );
}

// `-L`/`-follow` walk through links the realpath check never sees; `-files0-from` reads its
// start paths from a file
const FIND_UNSAFE = new Set([
  "-L",
  "-follow",
  "-files0-from",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

// globs and type definitions override the hidden-file and gitignore filters; `--trace` and
// `--debug` print the patterns `-f` read. A short bundle holding any of `zuLg.` asks, even
// inside a glued value (`-ng.e*`), since the parser can't tell flag letters from value.
const RG_UNSAFE =
  /^(--(pre(-glob)?|hostname-bin|search-zip|unrestricted|hidden|follow|no-ignore.*|ignore-file|glob|iglob|type-add|trace|debug)(=.*)?|-(?!-)\S*[zuLg.]\S*)$/;

// GNU grep expands any unambiguous prefix (`--rec` is `--recursive`), so long options are
// matched exactly against this list and everything else asks; none of these recurses
const GREP_LONG =
  /^--(extended-regexp|fixed-strings|basic-regexp|perl-regexp|ignore-case|no-ignore-case|word-regexp|line-regexp|invert-match|count|files-with-matches|files-without-match|only-matching|quiet|silent|no-messages|byte-offset|line-number|with-filename|no-filename|initial-tab|null|text|no-group-separator|colou?r|regexp|file|max-count|before-context|after-context|context|binary-files|group-separator|label)(=.*)?$/;

// `--config-env` sets config like `-c`, so `diff.external` or `core.fsmonitor` would run a program
const GIT_UNSAFE =
  /^(--output.*|--ext-diff|--textconv|--no-index|--open-files-in-pager.*|--exec-path.*|-c|--config-env.*|-O.*|--work-tree.*|--git-dir.*)$/;

const GIT_BRANCH_FLAGS = new Set([
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--no-color",
  "--color",
]);

const PNPM_SCRIPT_FLAGS = new Set([
  "--run",
  "--silent",
  "--bail",
  "--passWithNoTests",
]);

// a package name or path; never a leading `-`, which pnpm would read as its own option
const FILTER_VALUE = /^[@A-Za-z0-9_./^][@A-Za-z0-9_./^-]*$/;

/** The canonical words (workspace options stripped) of a `pnpm` command, or undefined when its options aren't plain. */
function pnpmWords(words: string[]): string[] | undefined {
  const rest = words.slice(1);
  let i = 0;
  while (i < rest.length) {
    const w = rest[i] ?? "";
    if (w === "-r" || w === "--recursive") i += 1;
    else if (w === "--filter" || w === "-F") {
      if (!FILTER_VALUE.test(rest[i + 1] ?? "")) return undefined;
      i += 2;
    } else if (
      w.startsWith("--filter=") &&
      FILTER_VALUE.test(w.slice("--filter=".length))
    )
      i += 1;
    else break;
  }
  const [script, ...args] = rest.slice(i);
  if (script === undefined) return ["pnpm"];
  // only plain arguments and a few inert flags reach the script; `--fix`, `-u` and friends would write
  const safe = args.every(
    (a) => a === "--" || !a.startsWith("-") || PNPM_SCRIPT_FLAGS.has(a),
  );
  return safe ? ["pnpm", script, ...args] : undefined;
}

/**
 * Built in alongside the defaults, but only on the right of a `|`: they filter what the step
 * before printed, so on their own they'd mostly wait on a terminal or read files the list
 * doesn't cover.
 */
const PIPE_ONLY = new Set([
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "jq",
  "awk",
]);

// GNU long options take any unambiguous prefix (`--out` is `--output`), so these match whole
// names only; none writes, runs a program or reads a file list
const SORT_LONG =
  /^--(ignore-leading-blanks|dictionary-order|ignore-case|general-numeric-sort|ignore-nonprinting|month-sort|human-numeric-sort|numeric-sort|random-sort|reverse|version-sort|merge|stable|unique|zero-terminated|debug|check(=(quiet|silent|diagnose-first))?|key(=.*)?|field-separator(=.*)?|sort=[a-z]+|buffer-size=\w+|parallel=\d+)$/;

const UNIQ_LONG =
  /^--(count|repeated|all-repeated(=\w+)?|unique|ignore-case|zero-terminated|group(=\w+)?|(skip-fields|skip-chars|check-chars)=\d+)$/;

/** Whether `uniq`'s arguments name at most one file: a second operand is where it writes. */
function uniqReadsOnly(args: string[]): boolean {
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      operands += args.length - i - 1;
      break;
    }
    // `-f`, `-s` and `-w` take a count, glued or as the next word
    const counted = /^-[cdDuiz]*[fsw](\d*)$/.exec(a);
    if (counted) {
      if (counted[1] === "") i++;
    } else if (a === "-" || !a.startsWith("-")) operands++;
    else if (!/^-[cdDuiz]+$/.test(a) && !UNIQ_LONG.test(a)) return false;
  }
  return operands <= 1;
}

/** awk's inline program and the file operands after it, or undefined on an option other than `-F` or `-v`. */
function awkArgs(
  args: string[],
): { program?: string; operands: string[] } | undefined {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-F" || a === "-v") i += 2;
    else if (/^-[Fv]./.test(a)) i++;
    else if (a.startsWith("-") && a !== "-") return undefined;
    else break;
  }
  if (i > args.length) return undefined;
  const [program, ...operands] = args.slice(i);
  return { program, operands };
}

// running commands, writing or piping, and reading files, arguments or variables it wasn't handed;
// gawk's SYMTAB and FUNCTAB name variables and functions by strings a program can assemble
const AWK_UNSAFE =
  /system|getline|ARGV|ARGC|ENVIRON|PROCINFO|SYMTAB|FUNCTAB|[>|@]/;

const JQ_LONG = new Set([
  "--raw-output",
  "--raw-output0",
  "--join-output",
  "--ascii-output",
  "--compact-output",
  "--null-input",
  "--slurp",
  "--raw-input",
  "--sort-keys",
  "--color-output",
  "--monochrome-output",
  "--tab",
  "--exit-status",
  "--seq",
  "--stream",
  "--unbuffered",
  "--args",
  "--jsonargs",
]);

/** jq's filter and its file operands, or undefined on an option outside the plain output ones. */
function jqArgs(
  args: string[],
): { filter?: string; operands: string[] } | undefined {
  let filter: string | undefined;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    // a named value is a string, never opened
    if (a === "--arg" || a === "--argjson") i += 2;
    else if (a === "--indent") i += 1;
    else if (JQ_LONG.has(a) || /^-[nrjascCMSeR]+$/.test(a)) continue;
    else if (a.startsWith("-")) return undefined;
    else if (filter === undefined) filter = a;
    else operands.push(a);
    if (i >= args.length) return undefined;
  }
  return { filter, operands };
}

// the environment, and modules jq would read off its search path
const JQ_UNSAFE = /\b(env|ENV|import|include|modulemeta)\b/;

/** The arguments a program may open as files; the rest are patterns, programs or sets. */
function fileArgs(words: string[]): string[] {
  const [program, ...args] = words;
  switch (program) {
    case "tr":
      return [];
    case "awk":
      return awkArgs(args)?.operands ?? args;
    case "jq":
      return jqArgs(args)?.operands ?? args;
    default:
      return args;
  }
}

/**
 * Per-program checks that run whichever entry allowed the command; false means ask. With
 * `complete` false, `words` is only the start of a command and fails only if no command
 * starting with them could pass. `piped` is a step reading the previous one's output.
 */
function guard(words: string[], complete = true, piped = false): boolean {
  const [program = "", ...args] = words;
  switch (program) {
    case "cd": {
      // no `-`/OLDPWD, options, zsh's `+N` stack entries or two-argument form, nor a bare cd home
      const [dir, ...rest] = args;
      if (dir === undefined) return !complete;
      return rest.length === 0 && !/^[-+]/.test(dir);
    }
    case "sort":
      return args.every((a) =>
        a.startsWith("--")
          ? a === "--" || SORT_LONG.test(a)
          : !/^-\S*[oT]/.test(a),
      );
    case "uniq":
      return uniqReadsOnly(args);
    case "awk": {
      const split = awkArgs(args);
      if (!split) return false;
      if (split.program === undefined) return !complete;
      return !AWK_UNSAFE.test(split.program);
    }
    case "jq": {
      const split = jqArgs(args);
      return split !== undefined && !JQ_UNSAFE.test(split.filter ?? "");
    }
    case "find":
      return !args.some((a) => FIND_UNSAFE.has(a));
    case "wc":
      // `--files0-from` reads the paths to count from a file; getopt takes any prefix down to `--f`
      return !args.some((a) => a.startsWith("--f"));
    case "grep":
      // recursing reads dotfiles such as `.env` without naming them
      return !args.some(
        (a) =>
          /^-[A-Za-z0-9]*[rRd]/.test(a) ||
          (a.startsWith("--") && a !== "--" && !GREP_LONG.test(a)),
      );
    case "rg":
      return !args.some((a) => RG_UNSAFE.test(a));
    case "sed": {
      // `sed -n 'N,Mp' file` only: `-i`, `w`, `e` and other scripts write or run things
      const [flag, script, ...files] = args;
      // with no file it reads stdin, which only a pipe feeds
      if (complete && !piped && files.length === 0) return false;
      return (
        (flag === undefined || flag === "-n") &&
        (script === undefined || /^\d+(,\d+)?p$/.test(script)) &&
        files.every((a) => !a.startsWith("-") || a === "--")
      );
    }
    case "tail":
      // follows forever: `f`/`F` anywhere in a bundle (`-fn1`, obsolete `-5f`/`+5f`), and
      // `--f…`, since getopt expands every prefix of `--follow`
      return !args.some((a) => /^([-+](?!-)\S*[fF]|--f)/.test(a));
    case "node":
      return (
        (complete ? args.length === 1 : args.length <= 1) &&
        (args[0] === undefined || args[0] === "--version" || args[0] === "-v")
      );
    case "git": {
      if (args.some((a) => GIT_UNSAFE.test(a))) return false;
      if (args[0] === "branch") {
        const rest = args.slice(1);
        const listing = rest.some((a) => a === "--list" || a === "-l");
        const unknownFlag = rest.some(
          (a) => a.startsWith("-") && !GIT_BRANCH_FLAGS.has(a),
        );
        const positional = rest.some((a) => !a.startsWith("-"));
        // `git branch name` creates one; a pattern is only a pattern next to `--list`
        return !unknownFlag && (!positional || listing || !complete);
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * Why an allowlist entry could never match a command, or undefined when one could. Whichever
 * entry allows a command, pnpm canonicalisation and the per-program checks still run, so an
 * entry they refuse is dead text.
 */
export function commandEntryProblem(entry: string): string | undefined {
  const words = parseCommandEntry(entry);
  if (!words)
    return "expected plain words: no operators, redirects, substitution or variable assignment";
  const [first = ""] = words;
  if (first.includes("/"))
    return `start with a program name, not a path: \`${first}\` never matches`;
  if (first.startsWith("-"))
    return `start with a program name, not an option: \`${first}\` never matches`;
  if (/\s/.test(first))
    return `\`${first}\` is one quoted word, never a program name; write the words unquoted`;
  if (first === "pnpm") {
    const canonical = pnpmWords(words);
    if (canonical?.length !== words.length)
      return "pnpm workspace options (-r, --filter) are dropped before matching, so leave them out, and script flags other than --run, --silent, --bail and --passWithNoTests always ask";
  }
  for (let end = 2; end <= words.length; end++)
    if (!guard(words.slice(0, end), false))
      return `\`${words[end - 1]}\` is refused for ${first} by the built-in checks, so this entry never matches`;
  return undefined;
}

/** Why a command still asks; see `autoApproveVerdict`. */
export type AskReason =
  /** not plain words joined by `;`, `&&`, `||` and `|`: background, redirection, substitution, expansion, bad quoting, cd in a pipeline */
  | "syntax"
  /** a step starts with a variable assignment, a path or an option instead of a program name */
  | "program"
  /** no allowlist entry is a prefix of a step */
  | "not-allowed"
  /** a per-program guard refuses an option or argument that writes, runs code, recurses or follows */
  | "unsafe-option"
  /** an argument, or the working directory, lies outside the root */
  | "outside-root"
  /** an argument, or the working directory, names somewhere secrets live */
  | "sensitive-path"
  /** the realpath hook threw for a reason other than a missing path, or the root or a cd target doesn't resolve */
  | "unresolvable";

/** Where a command runs; a bare string is a root that is also the shell's cwd. */
export type AutoApproveScope = {
  /** The directory no path may leave: the agent's worktree. */
  root: string;
  /** The shell's working directory, which relative paths resolve against; `root` when omitted. */
  cwd?: string;
  /**
   * Resolves every symlink in an absolute path, so a link can't carry a path out of `root` or
   * onto a secret; `fs.realpathSync.native` fits. A path that doesn't exist (an error with code
   * `ENOENT` or `ENOTDIR`) is judged on its text alone, except a `cd` target, which asks; any
   * other throw asks.
   */
  realpath?: (path: string) => string;
  /**
   * The home the shell's `~` stands for, an absolute path taken from the session's env. With it,
   * a word's leading `~` or `~/` is expanded to it, and read-only commands may also name paths in
   * `.claude/plugins/cache` and `.kru` below it; the cwd and a `cd` target must still be in
   * `root`. Without it a `~` asks.
   */
  home?: string;
};

/**
 * `"approved"` when `command` may run without an approval request, else the first rule that
 * refuses it. `isAutoApproved` is this, reduced to a boolean.
 */
export function autoApproveVerdict(
  command: string,
  autoApprove: AutoApprove,
  scope: string | AutoApproveScope,
): "approved" | AskReason {
  const pipelines = parsePipelines(command);
  if (!pipelines) return "syntax";
  const resolved = typeof scope === "string" ? { root: scope } : scope;
  // every cwd the shell may be in after the pipelines so far, with whether the last one succeeded
  let states = [{ cwd: resolved.cwd ?? resolved.root, ok: true }];
  for (const { steps, after } of pipelines) {
    const [first] = steps;
    // in a pipeline bash runs cd in a subshell and zsh doesn't, so where it leaves the shell is unclear
    if (steps.length > 1 && steps.some((s) => s.words[0] === "cd"))
      return "syntax";
    const runs = (ok: boolean) =>
      after === "&&" ? ok : after === "||" ? !ok : true;
    const cwds = new Set(states.filter((s) => runs(s.ok)).map((s) => s.cwd));
    const next = states.filter((s) => !runs(s.ok));
    for (const cwd of cwds) {
      for (const step of steps) {
        const verdict = stepVerdict(step, autoApprove, { ...resolved, cwd });
        if (verdict !== "approved") return verdict;
      }
      // a cd that fails leaves the shell where it was
      if (first?.words[0] === "cd") {
        const target = first.words[1] ?? "";
        const dir = posix.resolve(
          cwd,
          first.tilde[1] ? expandTilde(target, resolved.home) : target,
        );
        // bash moves to this lexical path when it exists and otherwise falls back to the physical
        // one, which the text doesn't track, so the target must resolve inside the worktree
        if (resolved.realpath) {
          const verdict = resolvedVerdict(
            [dir],
            [resolved.root],
            cwd,
            resolved.realpath,
            true,
          );
          if (verdict !== "approved") return verdict;
        }
        next.push({ cwd: dir, ok: true });
      } else next.push({ cwd, ok: true });
      next.push({ cwd, ok: false });
    }
    states = next;
  }
  return "approved";
}

/** The verdict on one simple command, as if it ran alone. */
function stepVerdict(
  step: Step,
  autoApprove: AutoApprove,
  { root, cwd = root, realpath, home }: AutoApproveScope,
): "approved" | AskReason {
  const raw = step.words.map((w, i) =>
    step.tilde[i] ? expandTilde(w, home) : w,
  );
  const first = raw[0] ?? "";
  if (step.literal && !TAKES_LITERALS.has(first)) return "syntax";
  if (isAssignment(first) || first.includes("/") || first.startsWith("-"))
    return "program";
  const words = first === "pnpm" ? pnpmWords(raw) : raw;
  if (!words) return "unsafe-option";

  const entries = [
    ...(autoApprove.defaults ? DEFAULT_AUTO_APPROVE_COMMANDS : []),
    ...autoApprove.commands,
  ];
  const builtIn = first === "cd" || (step.piped && PIPE_ONLY.has(first));
  const allowed =
    (autoApprove.defaults && builtIn) ||
    entries.some((entry) => {
      const prefix = parseCommandEntry(entry);
      return prefix?.every((w, i) => words[i] === w);
    });
  if (!allowed) return "not-allowed";
  if (!guard(words, true, step.piped)) return "unsafe-option";

  // echo only prints its arguments, so a path-like one isn't a read
  if (first === "echo") return "approved";
  const args = fileArgs(raw).flatMap(pathCandidates);
  // "." stands for the cwd itself, which `ls` or `git status` reads with no argument
  const targets = [".", ...args];
  const roots = [root, ...extraRoots(home, realpath)];
  // a `~` left in a word is one the shell won't expand to the home, and it asks
  const owners = targets.map((t) =>
    t.startsWith("~") ? undefined : rootOf(roots, posix.resolve(cwd, t)),
  );
  if (owners.some((owner) => owner === undefined)) return "outside-root";
  // extra roots are named, never entered: `pnpm test` or `git` run there would act on
  // their files, so the shell's cwd and a cd target stay in the worktree
  const entered = first === "cd" ? owners : owners.slice(0, 1);
  if (entered.some((owner) => owner !== root)) return "outside-root";
  for (const [i, target] of targets.entries()) {
    const owner = owners[i] ?? root;
    const inWorktree = owner === root;
    // `.git/./config` is `.git/config`, so the collapsed form is checked too
    const collapsed = posix.relative(owner, posix.resolve(cwd, target));
    const allowClaude = inWorktree && CLAUDE_READABLE.test(collapsed);
    // beside the worktree the root's own path holds `.claude`, so only what follows it is read
    const text =
      !inWorktree && target.startsWith(`${owner}/`)
        ? target.slice(owner.length)
        : target === owner
          ? ""
          : target;
    if (namesSecret(text, allowClaude) || namesSecret(collapsed, allowClaude))
      return "sensitive-path";
  }
  return realpath ? resolvedVerdict(targets, roots, cwd, realpath) : "approved";
}

/** The first of `roots` that holds `path`, which is already resolved. */
const rootOf = (roots: string[], path: string): string | undefined =>
  roots.find((r) => !isOutside(posix.relative(r, path)));

/**
 * The same root and secret checks, on where each target's symlinks really lead; a target must
 * stay in the root it names, the first of `roots` being the worktree. A target that doesn't
 * exist is skipped, or asks with `missingAsks`.
 */
function resolvedVerdict(
  targets: string[],
  roots: string[],
  cwd: string,
  realpath: (path: string) => string,
  missingAsks = false,
): "approved" | AskReason {
  const [root = ""] = roots;
  const resolve = (path: string): string | undefined => {
    try {
      return realpath(path);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  };
  try {
    const realRoot = resolve(root);
    if (realRoot === undefined) return "unresolvable";
    for (const target of targets) {
      const owner = rootOf(roots, posix.resolve(cwd, target));
      if (owner === undefined) return "outside-root";
      // joined, not normalized: the kernel applies `..` after following a link, not before
      const real = resolve(
        target.startsWith("/") ? target : `${cwd}/${target}`,
      );
      if (real === undefined) {
        if (missingAsks) return "unresolvable";
        continue;
      }
      const realOwner = owner === root ? realRoot : resolve(owner);
      if (realOwner === undefined) return "outside-root";
      const rel = posix.relative(realOwner, real);
      if (isOutside(rel)) return "outside-root";
      if (namesSecret(rel, owner === root && CLAUDE_READABLE.test(rel)))
        return "sensitive-path";
    }
    return "approved";
  } catch {
    return "unresolvable";
  }
}

/**
 * Whether `command` may run without an approval request: simple commands joined by `;`, `&&`,
 * `||` and `|`, none of the shell's other redirection, substitution or expansion, each starting
 * with an allowlisted command (or `cd`, or a pipe-only filter after a `|`) and touching no
 * secret path nor anything outside the root from any cwd it may run in. A string `scope` is
 * both root and cwd.
 */
export function isAutoApproved(
  command: string,
  autoApprove: AutoApprove,
  scope: string | AutoApproveScope,
): boolean {
  return autoApproveVerdict(command, autoApprove, scope) === "approved";
}
