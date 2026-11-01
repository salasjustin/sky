import { Environment, RunStatus } from "@sky/shared";
import { z } from "zod";
import type { Config } from "./config.js";

/** An env as the API returns it; loose so `--json` passes through fields this CLI doesn't read. */
export const ApiEnvironment = Environment.extend({
  failure: z.object({ step: z.string(), stderr: z.string() }).nullable(),
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
        }),
      ])
      .nullable(),
    compareUrl: z.string().nullable(),
  })
  .loose();
export type ApiRun = z.infer<typeof ApiRun>;

/** Not loose, unlike the others: parsing strips every field but name and kind, so no value can reach output. */
const SecretList = z.object({
  data: z.array(
    z.object({ name: z.string(), kind: z.enum(["value", "connector"]) }),
  ),
});
export type SecretSummary = z.infer<typeof SecretList>["data"][number];

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

export type Api = ReturnType<typeof createApi>;

export function createApi(config: Config) {
  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const url = `${config.url}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      throw new ApiError(
        0,
        "unreachable",
        `cannot reach ${config.url}: ${describe(err)}`,
      );
    }
    // read on every path, the error one included, so the connection is released
    const text = await res.text();
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
    async createAgent(body: { envId: string; prompt: string }) {
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
    /** Destroys the env's sprite, then its agents, runs and events; 409 while a run is active or it is provisioning. */
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

function describe(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `no response in ${requestTimeoutMs / 1000}s`;
  }
  // fetch's own message is always "fetch failed"; the reason is in cause
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })
    .cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return err instanceof Error ? err.message : String(err);
}
