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
  "date",
  "true",
  "sleep",
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
  // the same code `pnpm test` and `pnpm lint` run
  "pnpm exec vitest",
  "pnpm exec tsc",
  "pnpm exec biome check",
  "pnpm exec biome lint",
  "pnpm exec biome format",
  "biome check",
  "biome lint",
  "biome format",
  // writes inside the worktree or the run's scratch directory, as the Edit and Write tools make
  "git add",
  "git commit",
  "git restore",
  "git checkout",
  "git stash",
  "mkdir -p",
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
 * one of the harmless ones `lex` lets through. `ref` is the variable a word starts with (`$S/a`
 * is `ref: "S"`, `word: "/a"`), `status` a word holding `$?`, and `plainName` a word whose text
 * up to its first `=` had no quote, so it is an assignment when it has a name and a value.
 */
type Token =
  | {
      word: string;
      literal: boolean;
      braced: boolean;
      tilde: boolean;
      ref?: string;
      status: boolean;
      plainName: boolean;
    }
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
// `$?`, `$NAME` and `${NAME}`: the only expansions `lex` lets through
const VARIABLE =
  /^\$(?:\?|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/;

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
  let ref: string | undefined;
  let status = false;
  let quotedName = false;
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
    ref = undefined;
    status = false;
    quotedName = false;
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
    if (braced && (ref !== undefined || status)) return false;
    for (const word of words)
      tokens.push({
        word,
        literal,
        braced,
        tilde,
        ref,
        status,
        plainName: !quotedName,
      });
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
    // `$?` is a number, and a variable at the start of a word is the value the command set it to
    // (`parsePipelines` checks it); every other `$` expands in ways this parser doesn't follow
    if (ch === "$" && quote !== "'") {
      const m = VARIABLE.exec(command.slice(i));
      if (!m) return undefined;
      if (m[0] === "$?") {
        status = true;
        append("$?");
      } else {
        if (ref !== undefined || text !== "" || parts.length > 0 || group)
          return undefined;
        // zsh reads `$S:h` as a modifier and `$S[1,0]` as a subscript, quoted or not
        const after = command[i + m[0].length];
        if (m[1] !== undefined && (after === ":" || after === "["))
          return undefined;
        ref = m[1] ?? m[2];
        open = true;
      }
      i += m[0].length - 1;
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
      if (!text.includes("=")) quotedName = true;
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
  /** Per word: the variable it starts with, until `parsePipelines` has put the value in. */
  refs: (string | undefined)[];
  piped: boolean;
  literal: boolean;
  /** A word holds `$?`. */
  status: boolean;
  /** The first word has no quote before its `=`, so `NAME=value` is an assignment. */
  plainName: boolean;
  /** `cat > target <<'DELIM'` or `>>`: the file it writes, a word that may start with a variable. */
  heredoc?: { word: string; ref?: string; append: boolean };
};

/** Steps joined by `|`, run when `after` (the operator before it) lets them. */
type Pipeline = { steps: Step[]; after?: Exclude<Operator, "|"> };

/** A value a command may set a variable to: no space, quote, glob, brace, tilde or `$`. */
const PLAIN_VALUE = /^[A-Za-z0-9_./@%+,:-][A-Za-z0-9_./@%+,:=-]*$/;
// names the shell, the toolchain or the runner read from the environment: `PATH=… ls` runs another ls
const SPECIAL_VARIABLE =
  /^(PATH|HOME|IFS|CDPATH|ENV|SHELL|PWD|OLDPWD|USER|LOGNAME|TMPDIR|TERM|EDITOR|VISUAL|PAGER|PS\d|PROMPT.*|BASH.*|ZSH.*|ZDOTDIR|FPATH|FIGNORE|GLOBIGNORE|HIST.*|LANG|LC_.*|LD_.*|DYLD_.*|NODE.*|NPM_.*|PNPM_.*|GIT_.*|SSH_.*|GH_.*|GITHUB_.*|SKY_.*|CLAUDE.*|ANTHROPIC.*|.*PROXY|XDG_.*|SUDO.*|PYTHON.*|TZ|TIMEFMT|MANPATH|CC|CXX|CFLAGS|LDFLAGS)$/i;
// names bash or zsh sets on its own or ignores an assignment to, so a later `$NAME` doesn't read
// what the command wrote: `$_` is the previous command's last argument, `FUNCNAME=src` has no effect
const SHELL_SET_VARIABLE =
  /^(_|FUNCNAME|GROUPS|DIRSTACK|S?RANDOM|SECONDS|LINENO|EPOCH.*|E?UID|E?GID|USERNAME|PPID|OPTIND|OPTARG|REPLY|PIPESTATUS|HOST.*|MACHTYPE|OSTYPE|SHLVL|MAIL.*|COMP_.*|COMPREPLY|READLINE_.*|SHELLOPTS|COLUMNS|LINES|funcstack|functrace|funcfiletrace|funcsourcetrace|argv|ARGC|status|ERRNO|TTY.*|psvar|TMPPREFIX|WORDCHARS|KEYTIMEOUT|module_path|parameters|commands|functions(_source)?|[gs]?aliases|builtins|options|modules|dis_.*|jobtexts|jobstates|jobdirs|nameddirs|userdirs|reswords|patchars|signals)$/i;

// `cat > target <<'DELIM'` closing a command line; `pre` is empty or ends in an operator
const HEREDOC_HEAD =
  /^(?<pre>(?:.*[;&|]\s*)?)cat\s*(?<op>>>?)\s*(?<target>\S+?)\s+<<\s*'(?<delim>[A-Za-z_][A-Za-z0-9_]*)'\s*$/;

/**
 * A command that is one line, or the one-line `cat > file <<'DELIM'` followed by its body and a
 * closing line: the line to lex, with the file `cat` writes. A quoted delimiter makes the body
 * plain text, so it is never looked at. Undefined for any other newline.
 */
function splitHeredoc(
  command: string,
): { line: string; heredoc?: Step["heredoc"] } | undefined {
  const newline = command.indexOf("\n");
  if (newline < 0) return { line: command };
  if (command.includes("\0")) return undefined;
  const head = HEREDOC_HEAD.exec(command.slice(0, newline));
  const { pre = "", op, target = "", delim = "" } = head?.groups ?? {};
  if (!head) return undefined;
  const lines = command.slice(newline + 1).split("\n");
  const end = lines.indexOf(delim);
  if (end < 0 || lines.slice(end + 1).some((l) => l !== "")) return undefined;
  const tokens = lex(target);
  const [word] = tokens ?? [];
  if (
    tokens?.length !== 1 ||
    !word ||
    !("word" in word) ||
    word.literal ||
    word.braced ||
    word.tilde ||
    word.status
  )
    return undefined;
  return {
    line: `${pre}cat`,
    heredoc: { word: word.word, ref: word.ref, append: op === ">>" },
  };
}

/**
 * The pipelines `;`, `&&` and `||` join, or undefined when any simple command is empty or a
 * variable isn't one the command set. A step that only sets a variable to a plain value, run
 * whatever came before it, becomes `true`, and a later word that starts with the variable has
 * the value put in: it is judged as if written out.
 */
function parsePipelines(command: string): Pipeline[] | undefined {
  const split = splitHeredoc(command);
  if (!split) return undefined;
  const tokens = lex(split.line);
  if (!tokens) return undefined;
  const newStep = (piped: boolean): Step => ({
    words: [],
    tilde: [],
    refs: [],
    piped,
    literal: false,
    status: false,
    plainName: true,
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
      if (step.words.length === 0) step.plainName = token.plainName;
      step.words.push(token.word);
      step.tilde.push(token.tilde);
      step.refs.push(token.ref);
      step.literal ||= token.literal;
      step.status ||= token.status;
    } else if (step.words.length === 0) return undefined;
    else if (token.op === "|") pipeline.steps.push(newStep(true));
    else pipelines.push({ steps: [newStep(false)], after: token.op });
  }
  const steps = pipelines.flatMap((p) => p.steps);
  if (!steps.every((s) => s.words.length > 0)) return undefined;
  if (split.heredoc) {
    const last = steps.at(-1);
    if (last?.words.length !== 1 || last.words[0] !== "cat") return undefined;
    last.heredoc = split.heredoc;
  }
  const vars = new Map<string, string>();
  const writtenOut = (ref: string | undefined, word: string) => {
    if (ref === undefined) return word;
    const value = vars.get(ref);
    return value === undefined ? undefined : value + word;
  };
  for (const { steps: group, after } of pipelines) {
    for (const step of group) {
      const words = step.words.map((w, i) => writtenOut(step.refs[i], w));
      if (words.some((w) => w === undefined)) return undefined;
      step.words = words as string[];
      if (step.heredoc) {
        const target = writtenOut(step.heredoc.ref, step.heredoc.word);
        if (target === undefined) return undefined;
        step.heredoc = { word: target, append: step.heredoc.append };
      }
    }
    const [only] = group;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(
      only?.words[0] ?? "",
    );
    // a variable set only where the shell surely runs it, or a later use could find it unset
    if (
      group.length === 1 &&
      only?.words.length === 1 &&
      assignment &&
      only.plainName &&
      !only.literal &&
      !only.status &&
      !only.heredoc &&
      only.refs[0] === undefined &&
      after !== "&&" &&
      after !== "||" &&
      PLAIN_VALUE.test(assignment[2] ?? "") &&
      !SPECIAL_VARIABLE.test(assignment[1] ?? "") &&
      !SHELL_SET_VARIABLE.test(assignment[1] ?? "")
    ) {
      vars.set(assignment[1] ?? "", assignment[2] ?? "");
      only.words = ["true"];
      only.tilde = [false];
    }
  }
  return pipelines;
}

/** The words of an allowlist entry, or undefined when it isn't a plain run of words. */
export function parseCommandEntry(entry: string): string[] | undefined {
  const tokens = lex(entry);
  if (!tokens || tokens.length === 0) return undefined;
  const words = tokens.flatMap((t) => ("word" in t ? [t.word] : []));
  const tilde = tokens.some(
    (t) => "tilde" in t && (t.tilde || t.status || t.ref !== undefined),
  );
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
 * `storeHome` as a normalized path below the session's home (one or more segments, no trailing
 * slash), or undefined when it can't be one: empty, with whitespace, absolute, climbing out, the
 * home itself or inside `~/.claude`.
 */
function storeRoot(base: string, storeHome: string | undefined) {
  if (storeHome === undefined || storeHome === "" || /[\0\s]/.test(storeHome))
    return undefined;
  if (posix.isAbsolute(storeHome)) return undefined;
  const path = posix.resolve(base, storeHome);
  const rel = posix.relative(base, path);
  if (rel === "" || isOutside(rel) || rel.split("/")[0] === ".claude")
    return undefined;
  return path;
}

/**
 * Beside the worktree, read-only commands and the Read, Grep and Glob tools may name these,
 * below the session's home: the plugin cache only, since the rest of `~/.claude` holds the
 * login, settings and account files, and the store checkout at `storeHome` below the home (the
 * runner's `SKY_STORE_HOME`, set from the base profile's store; none without one). Taken afresh
 * for each use: with `realpath`, a root whose real location holds the home, holds `~/.claude`,
 * sits inside `~/.claude` outside its plugin cache, or has a secret name in its path is dropped,
 * so reads there ask. `~/.claude` counts both beside the real home and where its own link leads.
 */
export function extraRoots(
  home: string | undefined,
  realpath?: (path: string) => string,
  storeHome?: string,
): string[] {
  if (home === undefined || !posix.isAbsolute(home)) return [];
  const base = posix.resolve(home);
  const store = storeRoot(base, storeHome);
  const roots = [
    posix.join(base, ".claude/plugins/cache"),
    ...(store === undefined ? [] : [store]),
  ];
  if (!realpath) return roots;
  const real = (path: string): string | undefined => {
    try {
      return realpath(path);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // a path that doesn't exist yet is judged on its text; any other failure drops the
      // roots it decides
      return code === "ENOENT" || code === "ENOTDIR" ? path : undefined;
    }
  };
  const realHome = real(base);
  const realClaude = real(posix.join(base, ".claude"));
  if (realHome === undefined || realClaude === undefined) return [];
  const claudes = [posix.join(realHome, ".claude"), realClaude];
  const cacheOf = (claude: string) => posix.join(claude, "plugins/cache");
  const within = (parent: string, path: string) =>
    !isOutside(posix.relative(parent, path));
  return roots.filter((root) => {
    const target = real(root);
    if (target === undefined || within(target, realHome)) return false;
    const exposesClaude = (claude: string) =>
      within(target, claude) ||
      (within(claude, target) && !within(cacheOf(claude), target));
    if (claudes.some(exposesClaude)) return false;
    // the plugin cache's own `.claude/plugins/cache` isn't a secret name
    const claude = claudes.find((c) => within(cacheOf(c), target));
    const path =
      claude === undefined
        ? target
        : posix.join(
            posix.dirname(claude),
            posix.relative(cacheOf(claude), target),
          );
    return !namesSecret(path);
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
 * A caller outside this file passes a path relative to the root it is in (the plugin cache or the
 * store), since `.claude` in the root's own path isn't a secret name.
 */
export function namesSecret(text: string, allowClaude = false): boolean {
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
  // the same programs `pnpm test` and `pnpm lint` run; any of their options, since the paths among
  // them are checked like any other
  if (script === "exec") {
    const [tool, sub] = args;
    if (
      tool === "vitest" ||
      tool === "tsc" ||
      (tool === "biome" && ["check", "lint", "format"].includes(sub ?? ""))
    )
      return ["pnpm", script, ...args];
  }
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

/**
 * A glob `rg` filters by: any exclusion, or an inclusion of one source or doc extension. rg's `*`
 * matches a leading dot and a matching glob beats its hidden and gitignore filters, so `*.env`
 * would read `.env`. Matched case-sensitively, so `--iglob '*.NPMRC'` can't reach `.npmrc`.
 */
const rgGlobOk = (glob: string) =>
  glob.startsWith("!") ||
  /^(\*\*\/)?\*\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|css|scss|html|svelte|vue|astro|yml|yaml|toml|sql|go|py|rs|zig|sh|txt|graphql|prisma)$/.test(
    glob,
  );

/**
 * `rg`'s arguments with each `-g`, `--glob` and `--iglob` and its pattern taken out, or undefined
 * when a glob is one `rgGlobOk` refuses. A glob only filters what is searched; the paths stay.
 */
function rgArgs(args: string[]): string[] | undefined {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    let glob: string | undefined;
    if (a === "-g" || a === "--glob" || a === "--iglob") glob = args[++i];
    else if (a.startsWith("--glob=")) glob = a.slice("--glob=".length);
    else if (a.startsWith("--iglob=")) glob = a.slice("--iglob=".length);
    else if (/^-g./.test(a)) glob = a.slice(2);
    else {
      rest.push(a);
      continue;
    }
    if (glob === undefined || !rgGlobOk(glob)) return undefined;
  }
  return rest;
}

/** The options of `sed` before its script, and whether any of them edits in place. */
function sedArgs(args: string[]):
  | {
      inPlace: boolean;
      script?: string;
      files: string[];
    }
  | undefined {
  let inPlace = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? "";
    // a suffix with a `/` or `*` would put the backup elsewhere
    const edit =
      /^-[nErs]*i([A-Za-z0-9._~-]*)$/.exec(a) ??
      /^--in-place(?:=([A-Za-z0-9._~-]*))?$/.exec(a);
    if (edit) inPlace = true;
    else if (!/^-[nErs]+$/.test(a)) break;
  }
  const [script, ...files] = args.slice(i);
  if (script?.startsWith("-") && script !== "--") return undefined;
  return { inPlace, script, files };
}

/**
 * Whether a `sed -i` script is only `s`, `d` and `p` commands, each with at most a line number,
 * `$`, `/regex/` or a range of them for an address: no `e`, `w`, `r` or flag that runs a program
 * or reaches a file.
 */
function sedScriptOk(script: string): boolean {
  let i = 0;
  let commands = 0;
  const skipTo = (end: string) => {
    while (i < script.length && script[i] !== end)
      i += script[i] === "\\" ? 2 : 1;
    if (i >= script.length) return false;
    i++;
    return true;
  };
  const address = () => {
    const c = script[i] ?? "";
    if (/\d/.test(c)) {
      while (/\d/.test(script[i] ?? "")) i++;
      return true;
    }
    if (c === "$") return !!++i;
    if (c === "/") return !!++i && skipTo("/");
    return false;
  };
  while (i < script.length) {
    while (/[\s;]/.test(script[i] ?? "x")) i++;
    if (i >= script.length) break;
    if (address() && script[i] === ",") {
      i++;
      if (!address()) return false;
    }
    const c = script[i++];
    if (c === "s") {
      const d = script[i++] ?? "";
      if (d === "" || d === "\\" || /[A-Za-z0-9\s;]/.test(d)) return false;
      if (!skipTo(d) || !skipTo(d)) return false;
      while (/[gGpIiMm0-9]/.test(script[i] ?? "")) i++;
    } else if (c !== "d" && c !== "p") return false;
    if (i < script.length && !/[\s;]/.test(script[i] ?? "")) return false;
    commands++;
  }
  return commands > 0;
}

const GIT_ADD_FLAGS = new Set([
  "-A",
  "--all",
  "-u",
  "--update",
  "-N",
  "--intent-to-add",
  "-v",
  "--verbose",
  "-n",
  "--dry-run",
]);

/**
 * What a `git commit`'s arguments name: the pathspecs and `-F` files it takes (the paths to
 * check), and whether it has a message; undefined on any option outside `-m`, `-F`, `-q` and `-a`.
 */
function commitArgs(
  args: string[],
): { paths: string[]; message: boolean } | undefined {
  const paths: string[] = [];
  let message = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (a === "-m" || /^-[aqs]*m$/.test(a)) {
      if (i + 1 >= args.length) return undefined;
      // the message is text, whatever it looks like
      i++;
      message = true;
    } else if (a === "-F") {
      const file = args[++i];
      // `-` reads standard input
      if (file === undefined || file === "-") return undefined;
      paths.push(file);
      message = true;
    } else if (a === "--quiet" || a === "--all" || /^-[aq]+$/.test(a)) {
    } else if (a.startsWith("-")) return undefined;
    else paths.push(a);
  }
  return { paths, message };
}

/** The arguments of `git add`, `restore`, `checkout` or `stash` after the flags this accepts, as pathspecs or refs; undefined on any other option. */
function gitPaths(
  sub: string,
  args: string[],
  allowed: ReadonlySet<string>,
): string[] | undefined {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      paths.push(...args.slice(i + 1));
      break;
    }
    // the value of `git stash push -m` is a message
    if (sub === "stash" && a === "-m") i++;
    else if (a.startsWith("-")) {
      if (!allowed.has(a)) return undefined;
    } else paths.push(a);
  }
  return paths;
}

const GIT_RESTORE_FLAGS = new Set(["--staged", "-S", "--worktree", "-W"]);
const GIT_STASH_FLAGS = new Set([
  "-u",
  "--include-untracked",
  "-k",
  "--keep-index",
  "-q",
  "--quiet",
]);
const GIT_STASH_SUBCOMMANDS = new Set([
  "push",
  "pop",
  "apply",
  "list",
  "show",
  "drop",
]);

/** Whether `git`'s write commands (`add`, `commit`, `restore`, `checkout`, `stash`) have only arguments this accepts; `complete` false is the start of a command. */
function gitWriteOk(
  sub: string,
  args: string[],
  complete: boolean,
): boolean | undefined {
  // a pathspec with `:` is magic (`:(top)`, `:/`) that names files from the repository's root
  const plain = (paths: string[]) => paths.every((p) => !p.startsWith(":"));
  switch (sub) {
    case "add": {
      const paths = gitPaths(sub, args, GIT_ADD_FLAGS);
      return paths !== undefined && plain(paths);
    }
    case "commit": {
      const parsed = commitArgs(args);
      return (
        parsed !== undefined &&
        plain(parsed.paths) &&
        (!complete || parsed.message)
      );
    }
    case "restore": {
      const paths = gitPaths(sub, args, GIT_RESTORE_FLAGS);
      return (
        paths !== undefined && plain(paths) && (!complete || paths.length > 0)
      );
    }
    case "checkout": {
      // only `git checkout -- <path>`: any other form switches branches or detaches HEAD
      if (args.length === 0) return !complete;
      const [dash, ...paths] = args;
      return dash === "--" && plain(paths) && (!complete || paths.length > 0);
    }
    case "stash": {
      const [first] = args;
      const rest =
        first === undefined || first.startsWith("-") ? args : args.slice(1);
      if (first !== undefined && !first.startsWith("-"))
        if (!GIT_STASH_SUBCOMMANDS.has(first)) return false;
      const paths = gitPaths(sub, rest, GIT_STASH_FLAGS);
      return paths !== undefined && plain(paths);
    }
    default:
      return undefined;
  }
}

/** `date`'s plain output forms: UTC, an RFC format and a `+FORMAT`; `-s` sets the clock and `-f` reads a file. */
const DATE_ARGS = /^(-u|--utc|--universal|-R|--rfc-email|\+[^\0]*)$/;

/** Programs whose arguments are no paths: `echo`, and the ones that take only a count or a format. */
const NO_PATHS = new Set(["echo", "true", "sleep", "date"]);

/** The arguments a program may open as files; the rest are patterns, programs or sets. */
function fileArgs(words: string[]): string[] {
  const [program, ...args] = words;
  switch (program) {
    case "rg":
      return rgArgs(args) ?? args;
    case "sed": {
      const split = sedArgs(args);
      return split?.inPlace ? split.files : args;
    }
    case "git":
      if (args[0] === "commit")
        return commitArgs(args.slice(1))?.paths ?? args.slice(1);
      if (args[0] === "stash")
        return args.slice(1).filter((_a, i, all) => all[i - 1] !== "-m");
      // the subcommand is no path
      if (["add", "restore", "checkout"].includes(args[0] ?? ""))
        return args.slice(1);
      return args;
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
    case "rg": {
      const rest = rgArgs(args);
      return rest !== undefined && !rest.some((a) => RG_UNSAFE.test(a));
    }
    case "date":
      return args.every((a) => DATE_ARGS.test(a));
    case "true":
      return args.length === 0;
    case "sleep": {
      const [seconds] = args;
      if (seconds === undefined) return !complete;
      return (
        args.length === 1 &&
        /^\d{1,3}(\.\d{1,3})?$/.test(seconds) &&
        Number(seconds) <= 60
      );
    }
    case "mkdir": {
      const [flag, ...paths] = args;
      if (flag === undefined) return !complete;
      return (
        (flag === "-p" || flag === "--parents") &&
        paths.every((p) => !p.startsWith("-")) &&
        (!complete || paths.length > 0)
      );
    }
    case "sed": {
      const edit = sedArgs(args);
      if (edit?.inPlace) {
        // `-i` takes a file, never standard input, and a script of plain `s`, `d` and `p` commands
        if (edit.script === undefined) return !complete;
        return (
          sedScriptOk(edit.script) &&
          (!complete || edit.files.length > 0) &&
          edit.files.every((f) => !f.startsWith("-"))
        );
      }
      // `sed -n 'N,Mp' file` only: `w`, `e` and other scripts write or run things
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
      const written = gitWriteOk(args[0] ?? "", args.slice(1), complete);
      if (written !== undefined) return written;
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
   * Whether `path` is itself a symbolic link, dangling or not (`lstat`); a write to a file that
   * doesn't exist yet asks when it, or a parent on the way, is one that leads nowhere yet.
   */
  isSymlink?: (path: string) => boolean;
  /**
   * The run's scratch directory, an absolute path. Commands may read and write it as they do the
   * worktree, but it is never the shell's working directory.
   */
  scratch?: string;
  /**
   * The home the shell's `~` stands for, an absolute path taken from the session's env. With it,
   * a word's leading `~` or `~/` is expanded to it, and read-only commands may also name paths in
   * `.claude/plugins/cache` and `storeHome` below it; the cwd and a `cd` target must still be in
   * `root`. Without it a `~` asks.
   */
  home?: string;
  /** The store checkout's directory below `home` (the runner's `SKY_STORE_HOME`); without it there is no store root. */
  storeHome?: string;
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

/**
 * How many leading words a `timeout <N>` or `env -u NAME` wrapper takes before the command it
 * runs: 0 for no wrapper, -1 for one with any other option. Neither adds anything to what the
 * command underneath does, so that command is judged alone.
 */
function wrapperLength(words: string[]): number {
  const [first, ...rest] = words;
  if (first === "timeout")
    return /^\d{1,6}(\.\d{1,3})?[smhd]?$/.test(rest[0] ?? "") ? 2 : -1;
  if (first !== "env") return 0;
  let i = 0;
  while (rest[i] === "-u") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest[i + 1] ?? "")) return -1;
    i += 2;
  }
  return i === 0 ? -1 : i + 1;
}

/** Whether single-quoted `$`, `!` and backticks reach this command as plain text. */
function takesLiterals(words: string[]): boolean {
  const [first = "", second, third] = words;
  if (TAKES_LITERALS.has(first)) return true;
  // a commit message or stash name is text to git
  if (first === "git") return second === "commit" || second === "stash";
  // `pnpm exec` starts the program itself, with no shell between
  return (
    first === "pnpm" &&
    second === "exec" &&
    (third === "vitest" || third === "tsc" || third === "biome")
  );
}

/** Whether the command changes files, so every path it names must be in the worktree or scratch. */
function writes(words: string[], step: Step): boolean {
  const [first, second] = words;
  if (step.heredoc || first === "mkdir" || first === "biome") return true;
  if (first === "pnpm") return second === "exec";
  if (first === "sed") return sedArgs(words.slice(1))?.inPlace === true;
  return (
    first === "git" &&
    ["add", "commit", "restore", "checkout", "stash"].includes(second ?? "")
  );
}

/** `.git` and `.claude` hold hooks and settings that run code: a command that writes asks about any path in them. */
const namesGuardedDir = (text: string) =>
  text.split("/").some((s) => s === ".git" || s === ".claude");

/** The verdict on one simple command, as if it ran alone. */
function stepVerdict(
  step: Step,
  autoApprove: AutoApprove,
  {
    root,
    cwd = root,
    realpath,
    isSymlink,
    home,
    storeHome,
    scratch,
  }: AutoApproveScope,
): "approved" | AskReason {
  const raw = step.words.map((w, i) =>
    step.tilde[i] ? expandTilde(w, home) : w,
  );
  const wrapped = wrapperLength(raw);
  if (wrapped !== 0) {
    if (wrapped < 0 || raw.length === wrapped) return "not-allowed";
    return stepVerdict(
      {
        ...step,
        words: step.words.slice(wrapped),
        tilde: step.tilde.slice(wrapped),
        refs: step.refs.slice(wrapped),
      },
      autoApprove,
      { root, cwd, realpath, isSymlink, home, storeHome, scratch },
    );
  }
  const first = raw[0] ?? "";
  if (step.status && first !== "echo") return "syntax";
  if (
    step.literal &&
    !takesLiterals(first === "pnpm" ? (pnpmWords(raw) ?? raw) : raw)
  )
    return "syntax";
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

  // these only print, wait or take a count or a format, so a path-like argument isn't a read
  if (NO_PATHS.has(first)) return "approved";
  const named = fileArgs(raw);
  const args = [
    ...named.flatMap(pathCandidates),
    ...(step.heredoc ? [step.heredoc.word] : []),
  ];
  // "." stands for the cwd itself, which `ls` or `git status` reads with no argument
  const targets = [".", ...args];
  const write = writes(words, step);
  // a command that changes files stays in the worktree and the run's scratch directory; one that
  // reads may also name the plugin cache and the store
  const roots = [
    root,
    ...(write ? [] : extraRoots(home, realpath, storeHome)),
    ...(scratch === undefined ? [] : [posix.resolve(scratch)]),
  ];
  // a `~` left in a word is one the shell won't expand to the home, and it asks; a quoted `~` on
  // its own is text (a pattern, a name), unless an unquoted one had no home to take it to
  const unexpanded = new Set(
    raw.filter((w, i) => step.tilde[i] && w === step.words[i]),
  );
  const asksTilde = (t: string) =>
    t.startsWith("~") && (t !== "~" || !named.includes(t) || unexpanded.has(t));
  const owners = targets.map((t) =>
    asksTilde(t) ? undefined : rootOf(roots, posix.resolve(cwd, t)),
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
    const allowClaude = inWorktree && !write && CLAUDE_READABLE.test(collapsed);
    if (write && namesGuardedDir(collapsed)) return "sensitive-path";
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
  return realpath
    ? resolvedVerdict(targets, roots, cwd, realpath, false, write, isSymlink)
    : "approved";
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
  write = false,
  isSymlink?: (path: string) => boolean,
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
      const joined = target.startsWith("/") ? target : `${cwd}/${target}`;
      let real = resolve(joined);
      if (real === undefined) {
        if (missingAsks) return "unresolvable";
        if (!write) continue;
        // a file or directory a write creates lands in the nearest parent that exists, which must
        // stay in the root too, and a dangling link on the way would put it wherever it points
        let at = joined;
        for (let hops = 0; real === undefined; hops++) {
          if (hops > 64 || at === "") return "unresolvable";
          real = resolve(at);
          // a path that resolves to nothing but is a link on disk is a dangling one
          if (real === undefined && isSymlink?.(at)) return "unresolvable";
          at = at.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
        }
      }
      const realOwner = owner === root ? realRoot : resolve(owner);
      if (realOwner === undefined) return "outside-root";
      const rel = posix.relative(realOwner, real);
      if (isOutside(rel)) return "outside-root";
      if (
        namesSecret(rel, !write && owner === root && CLAUDE_READABLE.test(rel))
      )
        return "sensitive-path";
      if (write && namesGuardedDir(rel)) return "sensitive-path";
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
