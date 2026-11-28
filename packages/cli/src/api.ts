import {
  AgentState,
  ApiKey,
  ClaudeCredentialSummary,
  ClaudeCreditCleared,
  CreatedApiKey,
  DrainStatus,
  Environment,
  EnvironmentHealth,
  EnvRefresh,
  type KeyInput,
  PluginRefresh,
  PreviewState,
  RunStatus,
  type Runtime,
} from "@sky/shared";
import { z } from "zod";
import type { Config } from "./config.js";

/** An env as the API returns it; loose so `--json` passes through fields this CLI doesn't read. */
export const ApiEnvironment = Environment.extend({
  failure: z.object({ step: z.string(), stderr: z.string() }).nullable(),
  /** Set while the env's sprite isn't answering; absent from an older API. A shape this CLI can't read is dropped, not an error. */
  health: EnvironmentHealth.nullish().catch(undefined),
}).loose();
export type ApiEnvironment = z.infer<typeof ApiEnvironment>;

/** A run as the API returns it; loose so `--json` passes through fields this CLI doesn't read. */
export const ApiRun = z
  .object({
    id: z.string(),
    status: RunStatus,
    summary: z.string().nullable(),
    error: z.string().nullable(),
    pendingRequest: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("question"),
          requestId: z.string(),
          prompt: z.string(),
        }),
        z.object({
          kind: z.literal("approval"),
          requestId: z.string(),
          toolName: z.string(),
          toolSummary: z.string(),
          /** The tool call's whole input as JSON text, cut at 64 KiB; absent from an older API. */
          toolInput: z.string().optional(),
        }),
      ])
      .nullable(),
    compareUrl: z.string().nullable(),
    /** The Claude credential the run used, by name; absent from an older API. */
    claudeCredential: z.string().nullable().optional(),
    /** What the start-of-run plugin refresh did and the plugin versions the session loaded; absent from an older API, null before the run starts. A shape this CLI can't read is dropped, not an error. */
    plugins: PluginRefresh.nullish().catch(undefined),
    /** What the environment's refresh script did before the run; null when it has none, absent from an older API. A shape this CLI can't read is dropped. */
    refresh: EnvRefresh.nullish().catch(undefined),
  })
  .loose();
export type ApiRun = z.infer<typeof ApiRun>;

/** An agent row of `GET /v1/agents`; loose so `--json` passes through fields this CLI doesn't read. */
const ApiListedAgent = z
  .object({
    id: z.string(),
    envName: z.string(),
    branch: z.string(),
    remoteBranch: z.string().nullable().optional(),
    run: z
      .object({
        id: z.string(),
        state: AgentState,
        lastEventAt: z.string(),
        openRequests: z.number().int(),
      })
      .loose()
      .nullable(),
  })
  .loose();
export type ApiListedAgent = z.infer<typeof ApiListedAgent>;

const AgentList = z.object({
  data: z.array(ApiListedAgent),
  nextCursor: z.string().optional(),
});

/** Not loose, unlike the others: parsing strips every field but name and kind, so no value can reach output. */
const SecretList = z.object({
  data: z.array(
    z.object({ name: z.string(), kind: z.enum(["value", "connector"]) }),
  ),
});
export type SecretSummary = z.infer<typeof SecretList>["data"][number];

/** Loose, so `--json` passes through fields this CLI doesn't read; there is no secret field to read. */
const ApiWebhook = z
  .object({
    id: z.string(),
    url: z.string(),
    format: z.string(),
    eventTypes: z.array(z.string()),
    environmentIds: z.array(z.string()).optional(),
    // optional: an older API sends none of the delivery results
    lastAttempt: z
      .object({
        at: z.string(),
        status: z.number().nullable(),
        error: z.string().nullable(),
        attempt: z.number(),
      })
      .loose()
      .optional(),
    failedStreak: z.number().optional(),
    failing: z.boolean().optional(),
  })
  .loose();
export type ApiWebhook = z.infer<typeof ApiWebhook>;

const ApiDelivery = z
  .object({
    id: z.number(),
    eventType: z.string(),
    runId: z.string(),
    status: z.string(),
    attempts: z.number(),
    lastStatus: z.number().nullable(),
    lastError: z.string().nullable(),
    lastErrorKind: z.string().nullable(),
    createdAt: z.string(),
    lastAttemptAt: z.string().nullable(),
  })
  .loose();
export type ApiDelivery = z.infer<typeof ApiDelivery>;

/** A preview as the API describes it; the link only comes with a start. */
const ApiPreview = z.looseObject({
  agentId: z.string(),
  state: PreviewState,
  port: z.number().int(),
  expiresAt: z.string(),
  replaced: z.string().nullish(),
  /** A failed preview's redacted error: the tail of what failed. */
  detail: z.string().nullish(),
  /** Whose side a failed preview failed on; absent from an older API. */
  failure: z.enum(["command", "sprite"]).nullish(),
});

/** Keys are parsed, not loose: output is built from the parse, so a field the API adds (a hash) never reaches stdout. */
const KeyList = z.object({ data: z.array(ApiKey) });

function parseKey<T>(
  schema: z.ZodType<T>,
  status: number,
  json: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      status,
      "bad_response",
      `the API returned ${what} this CLI can't read`,
    );
  }
  return parsed.data;
}

const Launched = z.object({
  agent: z.object({ id: z.string() }),
  run: z.object({ id: z.string() }),
});

const ErrorBody = z.object({
  error: z.looseObject({ code: z.string(), message: z.string() }),
});

/** A non-2xx response; `code` and `message` come from the API's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The envelope's other fields, such as `already_decided`'s `decision`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const requestTimeoutMs = 30_000;
/** A switch to Codex waits for the server to install it on the sandbox when it's missing. */
const codexSwitchTimeoutMs = 15 * 60_000;

export type Api = ReturnType<typeof createApi>;

export function createApi(config: Config) {
  async function request(
    method: string,
    path: string,
    body?: unknown,
    opts: {
      timeoutMs?: number;
      /** Appended to the error when no response came in time. */
      timeoutHint?: string;
    } = {},
  ): Promise<{ status: number; json: unknown }> {
    const url = `${config.url}${path}`;
    const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // read on every path, the error one included, so the connection is released
      text = await res.text();
    } catch (err) {
      const timedOut = isTimeout(err);
      const reason = timedOut
        ? `no response in ${duration(timeoutMs)}`
        : describe(err);
      const hint =
        timedOut && opts.timeoutHint !== undefined
          ? `; ${opts.timeoutHint}`
          : "";
      throw new ApiError(
        0,
        "unreachable",
        `cannot reach ${config.url}: ${reason}${hint}`,
      );
    }
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(json);
      if (parsed.success) {
        const { code, message, ...details } = parsed.data.error;
        throw new ApiError(res.status, code, message, details);
      }
      throw new ApiError(
        res.status,
        `http_${res.status}`,
        `${method} ${path} returned ${res.status}`,
      );
    }
    return { status: res.status, json };
  }

  const env = (status: number, json: unknown) => {
    const parsed = ApiEnvironment.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        status,
        "bad_response",
        "the API returned an environment this CLI can't read",
      );
    }
    return { status, raw: json, env: parsed.data };
  };

  const agentPath = (id: string, rest: string) =>
    `/v1/agents/${encodeURIComponent(id)}/${rest}`;

  const secretPath = (envId: string, name: string) =>
    `/v1/environments/${encodeURIComponent(envId)}/secrets/${encodeURIComponent(name)}`;

  const launched = (status: number, json: unknown) => {
    const parsed = Launched.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        status,
        "bad_response",
        "the API returned a launch this CLI can't read",
      );
    }
    return {
      raw: json,
      agentId: parsed.data.agent.id,
      runId: parsed.data.run.id,
    };
  };

  return {
    async createAgent(body: {
      envId: string;
      prompt: string;
      branch?: string;
    }) {
      const { status, json } = await request("POST", "/v1/agents", body);
      return launched(status, json);
    },
    async followUp(agentId: string, body: { prompt: string }) {
      const { status, json } = await request(
        "POST",
        agentPath(agentId, "runs"),
        body,
      );
      return launched(status, json);
    },
    async archiveAgent(agentId: string) {
      const { json } = await request("POST", agentPath(agentId, "archive"));
      return json;
    },
    async startPreview(
      agentId: string,
      body: {
        build?: string;
        start?: string;
        port: number;
        ttlSeconds?: number;
      },
    ) {
      const { status, json } = await request(
        "POST",
        agentPath(agentId, "preview"),
        body,
      );
      const { preview } = parseKey(
        z.object({ preview: ApiPreview.extend({ link: z.string() }) }),
        status,
        json,
        "a preview",
      );
      return { raw: json, preview };
    },
    async stopPreview(agentId: string) {
      const { status, json } = await request(
        "DELETE",
        agentPath(agentId, "preview"),
      );
      const { stopped } = parseKey(
        z.object({ stopped: z.looseObject({}).nullable() }),
        status,
        json,
        "a preview",
      );
      return { raw: json, stopped: stopped !== null };
    },
    /** A failed preview comes back as one, `state: "failed"`, whichever way the API answered it. */
    async getPreview(agentId: string) {
      let status: number;
      let json: unknown;
      try {
        ({ status, json } = await request(
          "GET",
          agentPath(agentId, "preview"),
        ));
      } catch (err) {
        // an older API answers a failed preview with 422/502 `preview_failed`, the preview beside the error
        if (!(err instanceof ApiError) || err.code !== "preview_failed") {
          throw err;
        }
        const old = err.details.preview;
        if (typeof old !== "object" || old === null) throw err;
        status = err.status;
        json = { preview: { detail: err.message, ...old } };
      }
      const { preview } = parseKey(
        z.object({
          preview: ApiPreview.extend({
            services: z
              .object({ app: z.string(), proxy: z.string() })
              .nullish(),
          }).nullable(),
        }),
        status,
        json,
        "a preview",
      );
      return { raw: json, preview };
    },
    /** One page, newest activity first; `cursor` is the previous page's `nextCursor`. */
    async listAgents(query: URLSearchParams) {
      const { status, json } = await request(
        "GET",
        `/v1/agents${query.size > 0 ? `?${query}` : ""}`,
      );
      const parsed = AgentList.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned an agent list this CLI can't read",
        );
      }
      return { raw: json, ...parsed.data };
    },
    /** Newest first. */
    async listRuns(agentId: string): Promise<{ raw: unknown; run: ApiRun }[]> {
      const { status, json } = await request("GET", agentPath(agentId, "runs"));
      const data = (json as { data?: unknown } | null)?.data;
      const runs = Array.isArray(data)
        ? data.map((raw) => ({ raw, parsed: ApiRun.safeParse(raw) }))
        : undefined;
      if (runs === undefined || runs.some((r) => !r.parsed.success)) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned a run list this CLI can't read",
        );
      }
      return runs.map((r) => ({ raw: r.raw, run: r.parsed.data as ApiRun }));
    },
    async answer(agentId: string, body: { requestId: string; answer: string }) {
      const { json } = await request(
        "POST",
        agentPath(agentId, "answers"),
        body,
      );
      return json;
    },
    async decide(
      agentId: string,
      body: {
        requestId: string;
        decision: "approve" | "deny";
        reason?: string;
      },
    ) {
      const { json } = await request(
        "POST",
        agentPath(agentId, "approvals"),
        body,
      );
      return json;
    },
    async listEnvironments(): Promise<{
      raw: unknown;
      envs: ApiEnvironment[];
    }> {
      const { status, json } = await request("GET", "/v1/environments");
      const data = (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned an environment list this CLI can't read",
        );
      }
      return { raw: json, envs: data.map((item) => env(status, item).env) };
    },
    async getEnvironment(id: string) {
      const { status, json } = await request(
        "GET",
        `/v1/environments/${encodeURIComponent(id)}`,
      );
      return env(status, json);
    },
    async createEnvironment(body: unknown) {
      const { status, json } = await request("POST", "/v1/environments", body);
      return env(status, json);
    },
    async patchEnvironment(id: string, body: unknown) {
      const { status, json } = await request(
        "PATCH",
        `/v1/environments/${encodeURIComponent(id)}`,
        body,
      );
      return env(status, json);
    },
    /** Sets the runtime the env's runs use, or null to follow its `SKY_RUNTIME` secret again; 409 `gateway_key_missing` for Codex without the env's AI_GATEWAY_API_KEY, 502 `codex_install_failed` when Codex can't be installed. */
    async setEnvironmentRuntime(id: string, runtime: Runtime | null) {
      const { status, json } = await request(
        "PUT",
        `/v1/environments/${encodeURIComponent(id)}/runtime`,
        { runtime },
        runtime === "codex"
          ? {
              timeoutMs: codexSwitchTimeoutMs,
              // the server goes on installing and stores the runtime after the CLI gives up
              timeoutHint: `the switch may still complete on the server: check with sky env show ${id}`,
            }
          : {},
      );
      return env(status, json);
    },
    /** Destroys the env's sprite, then its agents, runs and events; 409 `run_active` while a run is active, `provisioning` while it provisions, `webhooks_filter` while a webhook filters on it. */
    async deleteEnvironment(id: string): Promise<void> {
      await request("DELETE", `/v1/environments/${encodeURIComponent(id)}`);
    },
    /** Reruns provisioning on a failed env; 409 `not_failed` otherwise. */
    async retryEnvironment(id: string) {
      const { status, json } = await request(
        "POST",
        `/v1/environments/${encodeURIComponent(id)}/retry`,
      );
      return env(status, json);
    },
    /**
     * Reprovisions a ready or failed env and keeps its agents; 409 `run_active`, `provisioning`, or
     * `unpublished_work` (with the agents at risk) unless `force`.
     */
    async rebuildEnvironment(id: string, force: boolean) {
      const { status, json } = await request(
        "POST",
        `/v1/environments/${encodeURIComponent(id)}/rebuild`,
        { force },
      );
      return env(status, json);
    },
    async createWebhook(body: unknown) {
      const { status, json } = await request("POST", "/v1/webhooks", body);
      const parsed = ApiWebhook.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned a webhook this CLI can't read",
        );
      }
      return { raw: json, webhook: parsed.data };
    },
    async listWebhooks() {
      const { status, json } = await request("GET", "/v1/webhooks");
      const parsed = z.object({ data: z.array(ApiWebhook) }).safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned a webhook list this CLI can't read",
        );
      }
      return { raw: json, webhooks: parsed.data.data };
    },
    /** Newest first; `nextCursor` when older deliveries remain. */
    async listWebhookDeliveries(id: string, query: URLSearchParams) {
      const { status, json } = await request(
        "GET",
        `/v1/webhooks/${encodeURIComponent(id)}/deliveries${query.size > 0 ? `?${query}` : ""}`,
      );
      const parsed = z
        .object({
          data: z.array(ApiDelivery),
          nextCursor: z.string().optional(),
        })
        .safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned a delivery list this CLI can't read",
        );
      }
      return { raw: json, ...parsed.data };
    },
    async deleteWebhook(id: string): Promise<void> {
      await request("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
    },
    /** The only response that carries the key's secret. */
    async createKey(body: KeyInput): Promise<CreatedApiKey> {
      const { status, json } = await request("POST", "/v1/keys", body);
      return parseKey(CreatedApiKey, status, json, "a created key");
    },
    /** Oldest first. */
    async listKeys(): Promise<ApiKey[]> {
      const { status, json } = await request("GET", "/v1/keys");
      return parseKey(KeyList, status, json, "a key list").data;
    },
    /** Revoking a revoked key succeeds again; an unknown id is 404. */
    async revokeKey(id: string): Promise<ApiKey> {
      const { status, json } = await request(
        "DELETE",
        `/v1/keys/${encodeURIComponent(id)}`,
      );
      return parseKey(ApiKey, status, json, "a revoked key");
    },
    /** Admin only: starts holding new launches, or moves the deadline of a drain already on. */
    async startDrain(timeoutSeconds?: number): Promise<DrainStatus> {
      const { status, json } = await request(
        "POST",
        "/v1/admin/drain",
        timeoutSeconds === undefined ? {} : { timeoutSeconds },
      );
      return parseKey(DrainStatus, status, json, "a drain");
    },
    /** Admin only. */
    async getDrain(): Promise<DrainStatus> {
      const { status, json } = await request("GET", "/v1/admin/drain");
      return parseKey(DrainStatus, status, json, "a drain");
    },
    /** Admin only: ends the drain and releases what it held; succeeds when none is on. */
    async cancelDrain(): Promise<DrainStatus> {
      const { status, json } = await request("DELETE", "/v1/admin/drain");
      return parseKey(DrainStatus, status, json, "a drain");
    },
    /** Admin only. Names, kinds, assignments, limits and counts; the API has no value to send. */
    async listClaudeCredentials(): Promise<ClaudeCredentialSummary[]> {
      const { status, json } = await request("GET", "/v1/claude-credentials");
      return parseKey(
        z.object({ data: z.array(ClaudeCredentialSummary) }),
        status,
        json,
        "a Claude credential list",
      ).data;
    },
    /** Admin only: clears an API key's out-of-credit mark, by name or credential; 404 for a key the server doesn't hold. */
    async clearCredit(name: string) {
      const { status, json } = await request(
        "POST",
        `/v1/claude-credentials/${encodeURIComponent(name)}/clear-credit`,
      );
      return parseKey(ClaudeCreditCleared, status, json, "a cleared API key");
    },
    async listSecrets(envId: string): Promise<SecretSummary[]> {
      const { status, json } = await request(
        "GET",
        `/v1/environments/${encodeURIComponent(envId)}/secrets`,
      );
      const parsed = SecretList.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned a secret list this CLI can't read",
        );
      }
      return parsed.data.data;
    },
    async putSecret(envId: string, name: string, body: unknown) {
      const { json } = await request("PUT", secretPath(envId, name), body);
      return json;
    },
    async deleteSecret(envId: string, name: string): Promise<void> {
      await request("DELETE", secretPath(envId, name));
    },
  };
}

const isTimeout = (err: unknown) =>
  err instanceof DOMException && err.name === "TimeoutError";

const duration = (ms: number) =>
  ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000}s`;

function describe(err: unknown): string {
  // a network failure reads "fetch failed", or "terminated" mid-body; the reason is in cause
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })
    .cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return err instanceof Error ? err.message : String(err);
}
