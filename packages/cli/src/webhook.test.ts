import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
const posts: unknown[] = [];
beforeEach(() => {
  posts.length = 0;
});

const created = {
  id: "whk_1",
  url: "https://hooks.example.com/x",
  eventTypes: ["run.waiting"],
  format: "standard",
  hasSecret: true,
  environmentIds: ["env_1"],
};
const envRow = {
  id: "env_1",
  name: "web",
  repo: "acme/web",
  setup: "",
  status: "ready",
  spriteName: "s",
  checkpointId: null,
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
  failure: null,
};
const handlers = [
  http.get(`${apiUrl}/v1/environments`, () =>
    HttpResponse.json({ data: [envRow] }),
  ),
  http.post(`${apiUrl}/v1/webhooks`, async ({ request }) => {
    posts.push(await request.json());
    return HttpResponse.json(created, { status: 201 });
  }),
];

const add = [
  "webhook",
  "add",
  "https://hooks.example.com/x",
  "--events=run.waiting",
];

test("webhook add sends a standard webhook with its secret read from a file and the env name resolved", async () => {
  server.use(...handlers);
  const file = join(mkdtempSync(join(tmpdir(), "sky-wh-")), "secret");
  writeFileSync(file, `${secret}\n`);
  const r = await runCli([
    ...add,
    "--format=standard",
    `--secret=@${file}`,
    "--env=web",
  ]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([
    {
      url: "https://hooks.example.com/x",
      eventTypes: ["run.waiting"],
      format: "standard",
      secret,
      environmentIds: ["env_1"],
    },
  ]);
  expect(r.stdout).toBe(
    "whk_1 standard https://hooks.example.com/x run.waiting env_1\n",
  );
  expect(r.stdout + r.stderr).not.toContain(secret);
});

test("--secret=- reads the secret from stdin", async () => {
  server.use(...handlers);
  const r = await runCli([...add, "--format=standard", "--secret=-"], {
    stdin: { readAll: async () => `${secret}\n` },
  });
  expect(r.code).toBe(0);
  expect(posts[0]).toMatchObject({ secret });
});

test("a secret given as the argument value is refused without echoing it", async () => {
  const r = await runCli([...add, "--format=standard", `--secret=${secret}`]);
  expect(r.code).toBe(2);
  expect(r.stderr + r.stdout).not.toContain(secret);
  expect(posts).toEqual([]);
});

test.each([
  ["a malformed secret", [...add, "--format=standard", "--secret=-"]],
  ["standard without a secret", [...add, "--format=standard"]],
  ["a secret on a sky webhook", [...add, "--secret=-"]],
  ["no --events", ["webhook", "add", "https://hooks.example.com/x"]],
  [
    "an unknown event type",
    ["webhook", "add", "https://x.test", "--events=nope"],
  ],
])("%s exits 2 and sends nothing", async (_, argv) => {
  const r = await runCli(argv, { stdin: { readAll: async () => "whsec_%%%" } });
  expect(r.code).toBe(2);
  expect(posts).toEqual([]);
});

test("an unknown --env exits 1 and sends nothing", async () => {
  server.use(...handlers);
  const r = await runCli([...add, "--env=nope"]);
  expect(r.code).toBe(1);
  expect(posts).toEqual([]);
});

test("webhook list prints one line per webhook and delete removes one", async () => {
  const deleted: string[] = [];
  server.use(
    http.get(`${apiUrl}/v1/webhooks`, () =>
      HttpResponse.json({ data: [created] }),
    ),
    http.delete(`${apiUrl}/v1/webhooks/:id`, ({ params }) => {
      deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const list = await runCli(["webhook", "list"]);
  expect(list.stdout).toBe(
    "whk_1 standard https://hooks.example.com/x run.waiting env_1\n",
  );
  const del = await runCli(["webhook", "delete", "whk_1"]);
  expect(del.code).toBe(0);
  expect(deleted).toEqual(["whk_1"]);
});
