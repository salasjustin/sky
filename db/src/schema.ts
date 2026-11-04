import type {
  AgentId,
  AgentStatus,
  Decision,
  EnvironmentId,
  EnvironmentStatus,
  EventType,
  PendingRequest,
  RequestId,
  RunId,
  RunRollup,
  RunStatus,
  WebhookId,
} from "@sky/shared";
import { type AnyColumn, sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// bare column name: drizzle qualifies `${t.col}` with the table, which breaks the `__new_<table>` copy a rebuild creates
const c = (column: AnyColumn) => sql.identifier(column.name);

// UTC ISO-8601, the form `z.iso.datetime()` accepts
const isoUtc = (column: AnyColumn) =>
  sql`${c(column)} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`;

// the provisioning step that failed; the CHECK on `failure_step` spells the same list
export const environmentFailureSteps = [
  "create",
  "clone",
  "setup",
  "checkpoint",
] as const;

// a webhook delivery's lifecycle; the CHECK on `status` spells the same list
export const deliveryStatuses = ["pending", "delivered", "failed"] as const;

// what a run waits on; the CHECK on `kind` spells the same list
export const requestKinds = ["question", "approval"] as const;

// a stored env value, or a Sprites connector whose connection id the runner gets under the name; the CHECK on `kind` spells the same list
export const secretKinds = ["value", "connector"] as const;

// an env-var name, the rule `^[A-Za-z_][A-Za-z0-9_]*$` in glob form
const envVarName = (column: AnyColumn) =>
  sql`${c(column)} glob '[A-Za-z_]*' and ${c(column)} not glob '*[^A-Za-z0-9_]*'`;

// stamped by the database, so no insert path can omit or misformat it
const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const environments = sqliteTable(
  "environments",
  {
    id: text().$type<EnvironmentId>().primaryKey(),
    name: text().notNull(),
    repo: text().notNull(),
    setup: text().notNull(),
    // the name of a base profile in the API's config; null applies none
    base: text(),
    status: text().$type<EnvironmentStatus>().notNull(),
    spriteName: text("sprite_name").notNull(),
    checkpointId: text("checkpoint_id"),
    concurrency: integer().notNull().default(3),
    approvalPolicy: text("approval_policy", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    autoApprove: text("auto_approve", { mode: "json" })
      .$type<{ defaults: boolean; commands: string[] }>()
      .notNull()
      .default({ defaults: true, commands: [] }),
    failureStep: text("failure_step", { enum: environmentFailureSteps }),
    // redacted and truncated by the API before it lands here
    failureStderr: text("failure_stderr"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("environments_name").on(t.name),
    check(
      "environments_status",
      sql`${c(t.status)} in ('provisioning', 'ready', 'failed')`,
    ),
    check("environments_concurrency", sql`${c(t.concurrency)} > 0`),
    check(
      "environments_approval_policy",
      sql`json_type(${c(t.approvalPolicy)}) = 'array'`,
    ),
    check(
      "environments_auto_approve",
      sql`json_type(${c(t.autoApprove)}) = 'object'`,
    ),
    check(
      "environments_failure_step",
      sql`${c(t.failureStep)} in ('create', 'clone', 'setup', 'checkpoint')`,
    ),
    check(
      "environments_failure_stderr",
      sql`length(${c(t.failureStderr)}) <= 4000`,
    ),
    check("environments_created_at", isoUtc(t.createdAt)),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text().$type<AgentId>().primaryKey(),
    envId: text("env_id")
      .$type<EnvironmentId>()
      .notNull()
      .references(() => environments.id),
    sessionId: text("session_id"),
    branch: text().$type<`claude/${AgentId}`>().notNull(),
    status: text().$type<AgentStatus>().notNull(),
    createdAt: createdAt(),
    // no CHECK: adding one makes drizzle-kit rebuild the table; the API writes toISOString() only
    archivedAt: text("archived_at"),
    // the existing GitHub branch the agent started from and publishes to; null means it uses `branch`.
    // no CHECK, for the same reason as archivedAt; the API validates the name
    remoteBranch: text("remote_branch"),
  },
  (t) => [
    index("agents_env_id").on(t.envId),
    check(
      "agents_status",
      sql`${c(t.status)} in ('idle', 'running', 'waiting')`,
    ),
    check("agents_branch", sql`${c(t.branch)} = 'claude/' || ${c(t.id)}`),
    check("agents_created_at", isoUtc(t.createdAt)),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text().$type<RunId>().primaryKey(),
    agentId: text("agent_id")
      .$type<AgentId>()
      .notNull()
      .references(() => agents.id),
    status: text().$type<RunStatus>().notNull(),
    summary: text(),
    // shared `Usage`, null until the run reports it; all five or none
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: real("cost_usd"),
    turns: integer(),
    durationMs: integer("duration_ms"),
    // no CHECK: adding one makes drizzle-kit rebuild the table; the API parses with the shared RunRollup first
    rollup: text({ mode: "json" }).$type<RunRollup>(),
    // names of the env secrets and envVars injected into the run; no CHECK, for the same reason as rollup
    secretNames: text("secret_names", { mode: "json" }).$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("runs_agent_id").on(t.agentId),
    check(
      "runs_status",
      sql`${c(t.status)} in ('starting', 'running', 'waiting', 'finished', 'failed', 'stopped')`,
    ),
    check(
      "runs_usage",
      sql`(${c(t.inputTokens)} is null and ${c(t.outputTokens)} is null and ${c(t.costUsd)} is null and ${c(t.turns)} is null and ${c(t.durationMs)} is null)
        or (${c(t.inputTokens)} >= 0 and ${c(t.outputTokens)} >= 0 and ${c(t.costUsd)} >= 0 and ${c(t.turns)} >= 0 and ${c(t.durationMs)} >= 0)`,
    ),
    check("runs_created_at", isoUtc(t.createdAt)),
  ],
);

export const events = sqliteTable(
  "events",
  {
    // AUTOINCREMENT: never reuses a deleted id, so it is safe as the SSE Last-Event-ID
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .$type<RunId>()
      .notNull()
      .references(() => runs.id),
    ts: text().notNull(),
    type: text().$type<EventType>().notNull(),
    payload: text({ mode: "json" }).notNull(),
  },
  (t) => [
    // a run's stream resumes with `run_id = ? and id > ?`
    index("events_run_id_id").on(t.runId, t.id),
    // the 7-day prune: the query must spell `type glob 'claude.*'` verbatim for the planner to pick a partial index
    index("events_claude_ts")
      .on(t.ts)
      .where(sql`${c(t.type)} glob 'claude.*'`),
    // the heartbeat prune: the query must spell `type = 'runner.heartbeat'` as a literal, not a bound parameter
    index("events_heartbeat_ts")
      .on(t.ts)
      .where(sql`${c(t.type)} = 'runner.heartbeat'`),
    check(
      "events_type",
      sql`${c(t.type)} in ('run.started', 'run.waiting', 'run.finished', 'run.failed', 'run.stopped', 'run.resumed',
        'run.probed', 'runner.warning', 'runner.heartbeat',
        'claude.PreToolUse', 'claude.PostToolUse', 'claude.PostToolUseFailure', 'claude.SubagentStart', 'claude.SubagentStop',
        'claude.TaskCreated', 'claude.TaskCompleted', 'claude.Notification', 'claude.PreCompact', 'claude.FileChanged', 'claude.Message')`,
    ),
    check("events_ts", isoUtc(t.ts)),
    check("events_payload", sql`json_type(${c(t.payload)}) = 'object'`),
  ],
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text().$type<WebhookId>().primaryKey(),
    url: text().notNull(),
    eventTypes: text("event_types", { mode: "json" })
      .$type<[EventType, ...EventType[]]>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "webhooks_event_types",
      sql`json_type(${c(t.eventTypes)}) = 'array' and json_array_length(${c(t.eventTypes)}) > 0`,
    ),
    check("webhooks_created_at", isoUtc(t.createdAt)),
  ],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    webhookId: text("webhook_id")
      .$type<WebhookId>()
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    status: text({ enum: deliveryStatuses }).notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    // HTTP status of the latest attempt; null until one gets a response
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    // one delivery per (subscriber, event); also serves the webhook_id foreign key
    uniqueIndex("webhook_deliveries_webhook_id_event_id").on(
      t.webhookId,
      t.eventId,
    ),
    // the prune's delete by event, and the FK lookup on every events delete
    index("webhook_deliveries_event_id").on(t.eventId),
    // the worker's due scan: `status = 'pending' and next_attempt_at <= ?`
    index("webhook_deliveries_status_next_attempt_at").on(
      t.status,
      t.nextAttemptAt,
    ),
    check(
      "webhook_deliveries_status",
      sql`${c(t.status)} in ('pending', 'delivered', 'failed')`,
    ),
    check("webhook_deliveries_attempts", sql`${c(t.attempts)} >= 0`),
    check("webhook_deliveries_next_attempt_at", isoUtc(t.nextAttemptAt)),
    check(
      "webhook_deliveries_last_status",
      sql`${c(t.lastStatus)} between 100 and 599`,
    ),
    check(
      "webhook_deliveries_last_error",
      sql`length(${c(t.lastError)}) <= 1000`,
    ),
    check("webhook_deliveries_created_at", isoUtc(t.createdAt)),
  ],
);

// a run's question or approval; the decision lives here so a long-polling runner survives an API restart
export const runRequests = sqliteTable(
  "run_requests",
  {
    id: text().$type<RequestId>().primaryKey(),
    runId: text("run_id")
      .$type<RunId>()
      .notNull()
      .references(() => runs.id),
    kind: text({ enum: requestKinds }).notNull(),
    request: text({ mode: "json" }).$type<PendingRequest>().notNull(),
    decision: text({ mode: "json" }).$type<Decision>(),
    decidedAt: text("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    // the run's open request: `run_id = ? and decided_at is null`; also serves the run_id foreign key
    index("run_requests_run_id_decided_at").on(t.runId, t.decidedAt),
    // at most one undecided request per run
    uniqueIndex("run_requests_run_id_open")
      .on(t.runId)
      .where(sql`${c(t.decidedAt)} is null`),
    check("run_requests_kind", sql`${c(t.kind)} in ('question', 'approval')`),
    check(
      "run_requests_request",
      sql`json_valid(${c(t.request)}) and json_type(${c(t.request)}) = 'object'
        and json_extract(${c(t.request)}, '$.kind') = ${c(t.kind)}
        and json_extract(${c(t.request)}, '$.requestId') = ${c(t.id)}`,
    ),
    check(
      "run_requests_decision",
      sql`json_valid(${c(t.decision)}) and json_type(${c(t.decision)}) = 'object'
        and json_extract(${c(t.decision)}, '$.requestId') = ${c(t.id)}`,
    ),
    check(
      "run_requests_decided",
      sql`(${c(t.decision)} is null) = (${c(t.decidedAt)} is null)`,
    ),
    check("run_requests_decided_at", isoUtc(t.decidedAt)),
    check("run_requests_created_at", isoUtc(t.createdAt)),
  ],
);

// values are encrypted by the API before they reach this table; there is no plaintext column
export const secrets = sqliteTable(
  "secrets",
  {
    envId: text("env_id")
      .$type<EnvironmentId>()
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text({ enum: secretKinds }).notNull(),
    connector: text(),
    ciphertext: blob({ mode: "buffer" }),
    nonce: blob({ mode: "buffer" }),
    keyVersion: integer("key_version"),
  },
  (t) => [
    primaryKey({ columns: [t.envId, t.name] }),
    check("secrets_name", envVarName(t.name)),
    check("secrets_kind", sql`${c(t.kind)} in ('value', 'connector')`),
    check(
      "secrets_shape",
      sql`(${c(t.kind)} = 'value' and ${c(t.connector)} is null
          and ${c(t.ciphertext)} is not null and ${c(t.nonce)} is not null and ${c(t.keyVersion)} is not null)
        or (${c(t.kind)} = 'connector' and ${c(t.connector)} is not null and ${c(t.connector)} <> ''
          and ${c(t.ciphertext)} is null and ${c(t.nonce)} is null and ${c(t.keyVersion)} is null)`,
    ),
    check("secrets_key_version", sql`${c(t.keyVersion)} > 0`),
  ],
);

// a run's own env values, encrypted by the API like secrets and purged once expired
export const runEnvVars = sqliteTable(
  "run_env_vars",
  {
    runId: text("run_id")
      .$type<RunId>()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    name: text().notNull(),
    ciphertext: blob({ mode: "buffer" }).notNull(),
    nonce: blob({ mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.name] }),
    // the purge scan: `expires_at <= ?`
    index("run_env_vars_expires_at").on(t.expiresAt),
    check("run_env_vars_name", envVarName(t.name)),
    check("run_env_vars_key_version", sql`${c(t.keyVersion)} > 0`),
    check("run_env_vars_expires_at", isoUtc(t.expiresAt)),
    check("run_env_vars_created_at", isoUtc(t.createdAt)),
  ],
);
