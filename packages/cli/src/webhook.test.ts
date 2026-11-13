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

test("--secret=- on a terminal prompts for the secret without echoing it", async () => {
  server.use(...handlers);
  const prompts: string[] = [];
  const r = await runCli([...add, "--format=standard", "--secret=-"], {
    stderrIsTTY: true,
    stdin: {
      isTTY: true,
      readAll: async () => {
        throw new Error("read a terminal stdin instead of prompting");
      },
      promptHidden: async (p) => {
        prompts.push(p);
        return secret;
      },
    },
  });
  expect(r.code).toBe(0);
  expect(prompts).toEqual(["Secret for https://hooks.example.com/x: "]);
  expect(posts[0]).toMatchObject({ secret });
  expect(r.stdout + r.stderr).not.toContain(secret);
});

test("webhook add sends an openbot webhook with a non-base64 secret as is, never printing it", async () => {
  server.use(...handlers);
  const openbotSecret = "whsec_not+base64/but-fine";
  const file = join(mkdtempSync(join(tmpdir(), "sky-wh-")), "secret");
  writeFileSync(file, `${openbotSecret}\n`);
  const r = await runCli([
    ...add,
    "--format=openbot",
    `--secret=@${file}`,
    "--env=web",
  ]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([
    {
      url: "https://hooks.example.com/x",
      eventTypes: ["run.waiting"],
      format: "openbot",
      secret: openbotSecret,
      environmentIds: ["env_1"],
    },
  ]);
  expect(r.stdout + r.stderr).not.toContain(openbotSecret);
});

test("an openbot secret on stdin is read, and an argv one is refused", async () => {
  server.use(...handlers);
  const ok = await runCli([...add, "--format=openbot", "--secret=-"], {
    stdin: { readAll: async () => "plain-secret\n" },
  });
  expect(ok.code).toBe(0);
  expect(posts[0]).toMatchObject({ secret: "plain-secret" });
  const bad = await runCli([...add, "--format=openbot", "--secret=plain"]);
  expect(bad.code).toBe(2);
  expect(bad.stderr + bad.stdout).not.toContain("plain");
});

test("openbot without a secret exits 2", async () => {
  const r = await runCli([...add, "--format=openbot"]);
  expect(r.code).toBe(2);
  expect(posts).toEqual([]);
});

test.each([
  ["stderr is not a terminal", { stderrIsTTY: false }],
  ["CI is set", { stderrIsTTY: true, env: { CI: "true" } }],
])("--secret=- on a terminal stdin where %s exits 2", async (_, opts) => {
  const r = await runCli([...add, "--format=standard", "--secret=-"], {
    ...opts,
    stdin: { isTTY: true },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/pipe the secret on stdin/);
  expect(posts).toEqual([]);
});

const blanks = ["", "\n", "  \n"];
test.each(blanks)("empty stdin %j exits 2 as empty", async (input) => {
  const r = await runCli([...add, "--format=standard", "--secret=-"], {
    stdin: { readAll: async () => input },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/the secret from stdin is empty/);
  expect(r.stderr).not.toMatch(/must be whsec_/);
  expect(posts).toEqual([]);
});

test("an empty secret file exits 2 naming the file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sky-wh-")), "secret");
  writeFileSync(file, "\n");
  const r = await runCli([...add, "--format=standard", `--secret=@${file}`]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(`the secret in ${file} is empty`);
  expect(posts).toEqual([]);
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
