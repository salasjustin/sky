import { fileURLToPath } from "node:url";
import {
  BaseProfiles,
  DEFAULT_CLAUDE_CREDENTIAL,
  POOL_CREDENTIAL,
} from "@sky/shared";
import { z } from "zod";

// the build copies the runner bundle next to the API bundle, which is where this module lands
const bundledRunner = fileURLToPath(new URL("./runner.mjs", import.meta.url));

// likewise the CLI bundle, which GET /cli/sky.mjs serves
const bundledCli = fileURLToPath(new URL("./sky.mjs", import.meta.url));

const json = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    ctx.issues.push({ code: "custom", message: "expected JSON", input: s });
    return z.NEVER;
  }
});

const configSchema = z
  .object({
    /** Token68 only: bearerAuth rejects any token outside RFC 6750's token68 charset, so a key outside it could never match. */
    SKY_API_KEY: z
      .string()
      .min(32)
      .regex(/^[A-Za-z0-9._~+/-]+=*$/),
    SPRITES_TOKEN: z.string().min(1),
    DATA_DIR: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
    /** How a sprite reaches this API; the runner posts its events here. */
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }),
    RUNNER_BUNDLE_PATH: z.string().min(1).default(bundledRunner),
    CLI_BUNDLE_PATH: z.string().min(1).default(bundledCli),
    /** A run with no event for this long is failed with `runner_timeout`. */
    RUN_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
    /**
     * A `running` run with no event for this long has its runner checked on its sprite, and is failed
     * with `runner_lost` if the runner is gone; the check repeats at most once per window. Must be
     * below RUN_TIMEOUT_MINUTES, or the timeout would fail the run first. Defaults to 5, or half of a
     * shorter timeout.
     */
    RUN_PROBE_MINUTES: z.coerce.number().positive().optional(),
    /**
     * A run still starting with no event this long after it was created is failed with `launch_timeout`
     * and its runner signalled. The runner gets what is left of it at launch and bounds its queue for
     * the repo lock by that, so a run queued too long fails with its own error naming the lock. Keep it
     * past a store lock wait (10 minutes) plus the plugin refresh.
     */
    LAUNCH_DEADLINE_MINUTES: z.coerce.number().positive().default(15),
    /**
     * A launch is refused with `sprite_low_memory` when its sprite has less memory available (MB, as
     * `free -m` reports it) than this; 0 turns the check off.
     */
    SPRITE_MIN_FREE_MB: z.coerce.number().int().min(0).default(1024),
    /** How long a runner waits on a question or approval before giving up; the runner gets it at launch. */
    WAIT_TIMEOUT_MINUTES: z.coerce.number().positive().default(120),
    /** The bound on a sprite's clone, installs, setup script, store steps and checkpoint. */
    SPRITES_LONG_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
    /** Base profiles by name, as JSON; an environment's `base` names one. Holds no secret values. */
    SKY_BASE_PROFILES: json.pipe(BaseProfiles).default({}),
    /** HMAC key every outbound webhook delivery is signed with. */
    WEBHOOK_SIGNING_KEY: z.string().min(32),
    /** AES-256 key, base64, that env secrets and run envVars are encrypted under. */
    SECRET_ENCRYPTION_KEY: z
      .base64()
      .refine((s) => Buffer.from(s, "base64").length === 32, {
        error: "must decode to 32 bytes",
      }),
  })
  .refine(
    (e) =>
      e.RUN_PROBE_MINUTES === undefined ||
      e.RUN_PROBE_MINUTES < e.RUN_TIMEOUT_MINUTES,
    { path: ["RUN_PROBE_MINUTES"], error: "must be below RUN_TIMEOUT_MINUTES" },
  );

export type Config = {
  apiKey: string;
  spritesToken: string;
  dataDir: string;
  port: number;
  /** The default credential, `CLAUDE_CODE_OAUTH_TOKEN`. */
  claudeOauthToken: string;
  /** Named subscription tokens, `CLAUDE_OAUTH_TOKEN_<NAME>` by lowercased name; the default is not among them. */
  claudeOauthTokens: Record<string, string>;
  /** The pay-per-use fallback, `SKY_ANTHROPIC_API_KEY`; undefined when unset. */
  anthropicApiKey: string | undefined;
  publicBaseUrl: string;
  runnerBundlePath: string;
  cliBundlePath: string;
  runTimeoutMs: number;
  runProbeMs: number;
  launchDeadlineMs: number;
  spriteMinFreeMb: number;
  waitTimeoutMs: number;
  spritesLongTimeoutMs: number;
  baseProfiles: BaseProfiles;
  webhookSigningKey: string;
  secretEncryptionKey: Buffer;
};

type Env = Record<string, string | undefined>;

const NAMED_TOKEN = /^CLAUDE_OAUTH_TOKEN_(.+)$/;

/**
 * The named subscription tokens in `env`, by lowercased name, and the variables whose names can't be
 * a credential's. Empty values are skipped: a secret set to nothing holds no credential.
 */
function namedClaudeTokens(env: Env) {
  const tokens: Record<string, string> = {};
  const invalid: string[] = [];
  for (const [variable, value] of Object.entries(env)) {
    const suffix = NAMED_TOKEN.exec(variable)?.[1];
    if (suffix === undefined || !value) continue;
    const name = suffix.toLowerCase();
    if (
      !/^[a-z0-9_]{1,64}$/.test(name) ||
      name === DEFAULT_CLAUDE_CREDENTIAL ||
      name === POOL_CREDENTIAL
    ) {
      invalid.push(variable);
    } else {
      tokens[name] = value;
    }
  }
  return { tokens, invalid };
}

/**
 * A union no branch matched reports one issue at the union, "Invalid input"; its branches' own
 * issues, with their full paths, are what name the field that's wrong.
 */
function unionBranchIssues(issue: z.core.$ZodIssue): z.core.$ZodIssue[] {
  if (issue.code !== "invalid_union" || issue.errors.length === 0) {
    return [issue];
  }
  return issue.errors
    .flat()
    .flatMap((inner) =>
      unionBranchIssues({ ...inner, path: [...issue.path, ...inner.path] }),
    );
}

/** Names each bad variable; values stay out of the message since some are secrets. */
export function loadConfig(
  env: Env,
): { ok: true; config: Config } | { ok: false; message: string } {
  const parsed = configSchema.safeParse(env);
  const named = namedClaudeTokens(env);
  if (parsed.success && named.invalid.length === 0) {
    const e = parsed.data;
    return {
      ok: true,
      config: {
        apiKey: e.SKY_API_KEY,
        spritesToken: e.SPRITES_TOKEN,
        dataDir: e.DATA_DIR,
        port: e.PORT,
        claudeOauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
        claudeOauthTokens: named.tokens,
        anthropicApiKey: env.SKY_ANTHROPIC_API_KEY || undefined,
        publicBaseUrl: e.PUBLIC_BASE_URL,
        runnerBundlePath: e.RUNNER_BUNDLE_PATH,
        cliBundlePath: e.CLI_BUNDLE_PATH,
        runTimeoutMs: e.RUN_TIMEOUT_MINUTES * 60_000,
        runProbeMs:
          (e.RUN_PROBE_MINUTES ?? Math.min(5, e.RUN_TIMEOUT_MINUTES / 2)) *
          60_000,
        launchDeadlineMs: e.LAUNCH_DEADLINE_MINUTES * 60_000,
        spriteMinFreeMb: e.SPRITE_MIN_FREE_MB,
        waitTimeoutMs: e.WAIT_TIMEOUT_MINUTES * 60_000,
        spritesLongTimeoutMs: e.SPRITES_LONG_TIMEOUT_MINUTES * 60_000,
        baseProfiles: e.SKY_BASE_PROFILES,
        webhookSigningKey: e.WEBHOOK_SIGNING_KEY,
        secretEncryptionKey: Buffer.from(e.SECRET_ENCRYPTION_KEY, "base64"),
      },
    };
  }
  // zod's default issue messages describe the rule, never the input
  const problems = (parsed.success ? [] : parsed.error.issues)
    .flatMap(unionBranchIssues)
    .map((issue) => {
      const name = String(issue.path[0]);
      // a nested path names the field inside a JSON variable, never its value
      const field = issue.path.slice(1).map(String).join(".");
      return env[name] === undefined
        ? `${name} is missing`
        : `${name}${field ? `.${field}` : ""} is invalid: ${issue.message}`;
    });
  // a name is all that is said of a token variable; its value never is
  problems.push(
    ...named.invalid.map(
      (variable) =>
        `${variable} is invalid: a name is lowercase letters, digits and _ (up to 64), and not "default" (which is CLAUDE_CODE_OAUTH_TOKEN) or "pool"`,
    ),
  );
  return { ok: false, message: `invalid config: ${problems.join("; ")}` };
}
