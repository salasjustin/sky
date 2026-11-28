import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const url = "https://signal.example.com/v1/webhooks/routine";
const events = [
  "run.waiting",
  "run.finished",
  "run.failed",
  "run.stopped",
  "runner.warning",
];
const webhook = { id: "whk_1", url, format: "openbot", events };
const yaml = `name: web
repo: acme/web
setup: pnpm install
webhook:
  url: ${url}
  format: openbot
`;
const env = (over: Record<string, unknown> = {}) => ({
  id: "env_1",
  name: "web",
  repo: "acme/web",
  setup: "pnpm install",
  refresh: "",
  base: null,
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
  claudeCredential: null,
  claudePool: null,
  claudeFallback: "api-key",
  runtime: null,
  status: "ready",
  spriteName: "sky-env-1",
  checkpointId: "ckpt_1",
  failure: null,
  webhook: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  ...over,
});

let dir: string;
let file: string;
const writes: { method: string; body: unknown }[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-apply-webhook-"));
  file = join(dir, "env.yaml");
  writeFileSync(file, yaml);
  writes.length = 0;
});

const list = (...envs: Record<string, unknown>[]) =>
  http.get(`${apiUrl}/v1/environments`, () =>
    HttpResponse.json({ data: envs }),
  );
const write =
  (method: string, status: number, response: Record<string, unknown>) =>
  async ({ request }: { request: Request }) => {
    writes.push({ method, body: await request.json() });
    return HttpResponse.json(response, { status });
  };
const patch = (status: number, response: Record<string, unknown>) =>
  http.patch(
    `${apiUrl}/v1/environments/env_1`,
    write("PATCH", status, response),
  );
const lock = () => JSON.parse(readFileSync(join(dir, "sky-lock.json"), "utf8"));

test("a new environment is created without its webhook, then given it once the secret can exist", async () => {
  server.use(
    list(),
    http.post(`${apiUrl}/v1/environments`, write("POST", 202, env())),
    patch(200, env({ webhook, webhookChange: "created" })),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([
    {
      method: "POST",
      body: expect.not.objectContaining({ webhook: expect.anything() }),
    },
    { method: "PATCH", body: { webhook: { url, format: "openbot", events } } },
  ]);
  expect(r.stdout).toBe("ready web env_1\n");
  expect(lock().webhookId).toBe("whk_1");
});

test("a re-apply with the webhook as it is answers up to date", async () => {
  server.use(
    list(env({ webhook })),
    patch(200, env({ webhook, webhookChange: "unchanged" })),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([
    { method: "PATCH", body: { webhook: { url, format: "openbot", events } } },
  ]);
  expect(r.stdout).toBe("up to date web env_1\n");
});

test("a webhook the server changed is a change", async () => {
  writeFileSync(file, `${yaml}  events: [run.finished]\n`);
  server.use(
    list(env({ webhook })),
    patch(
      200,
      env({
        webhook: { ...webhook, events: ["run.finished"] },
        webhookChange: "updated",
      }),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.stdout).toBe("ready web env_1\n");
  expect(writes[0]?.body).toEqual({
    webhook: { url, format: "openbot", events: ["run.finished"] },
  });
});

test("a file without webhook deletes the one the environment has, and writes nothing when it has none", async () => {
  writeFileSync(file, "name: web\nrepo: acme/web\nsetup: pnpm install\n");
  server.use(
    list(env({ webhook })),
    patch(200, env({ webhookChange: "removed" })),
  );
  const removed = await runCli(["apply", file]);
  expect(removed.stdout).toBe("ready web env_1\n");
  expect(writes).toEqual([{ method: "PATCH", body: { webhook: null } }]);

  writes.length = 0;
  rmSync(join(dir, "sky-lock.json"));
  server.use(list(env()));
  const none = await runCli(["apply", file]);
  expect(none.stdout).toBe("up to date web env_1\n");
  expect(writes).toEqual([]);
});

test("a missing SKY_WEBHOOK_SECRET fails the apply with the server's message", async () => {
  const message =
    "this environment has no SKY_WEBHOOK_SECRET secret, which signs its webhook; set it with sky secret set web SKY_WEBHOOK_SECRET, then apply again";
  server.use(
    list(env()),
    patch(400, { error: { code: "webhook_secret_missing", message } }),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(message);
});

test("a signing secret in the file is an unknown field", async () => {
  writeFileSync(file, `${yaml}  secret: whatever\n`);
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("webhook.secret: unknown field");
  expect(writes).toEqual([]);
});

test("env show --yaml exports the webhook without its id or any secret, and apply takes the export as a no-op", async () => {
  server.use(
    list(env({ webhook })),
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(env({ webhook })),
    ),
    http.get(`${apiUrl}/v1/environments/env_1/secrets`, () =>
      HttpResponse.json({
        data: [{ name: "SKY_WEBHOOK_SECRET", kind: "value" }],
      }),
    ),
  );
  const shown = await runCli(["env", "show", "env_1", "--yaml"]);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toMatch(
    /webhook:\n {2}url: https:\/\/signal\.example\.com\/v1\/webhooks\/routine\n {2}format: openbot\n {2}events:\n {4}- run\.waiting/,
  );
  expect(shown.stdout).not.toContain("whk_1");

  writeFileSync(file, shown.stdout);
  server.use(
    list(env({ webhook })),
    patch(200, env({ webhook, webhookChange: "unchanged" })),
  );
  const applied = await runCli(["apply", file]);
  expect(applied.code).toBe(0);
  expect(applied.stdout).toBe("up to date web env_1\n");
  expect(writes).toEqual([
    { method: "PATCH", body: { webhook: { url, format: "openbot", events } } },
  ]);
});

test("env show prints one line for the webhook", async () => {
  server.use(
    list(env({ webhook })),
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(env({ webhook })),
    ),
  );
  const r = await runCli(["env", "show", "env_1"]);
  expect(r.stdout).toContain(`webhook: openbot ${url} (5 events)\n`);
});
