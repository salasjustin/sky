import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
const posts: unknown[] = [];

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
    const body = (await request.json()) as { format: string };
    posts.push(body);
    return HttpResponse.json(
      { ...created, format: body.format },
      { status: 201 },
    );
  }),
];
// installed for every test, so one that expects nothing sent fails if the CLI does post
beforeEach(() => {
  posts.length = 0;
  server.use(...handlers);
});

const add = [
  "webhook",
  "add",
  "https://hooks.example.com/x",
  "--events=run.waiting",
];

test("webhook add sends a standard webhook with its secret read from a file and the env name resolved", async () => {
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
  const r = await runCli([...add, "--format=standard", "--secret=-"], {
    stdin: { readAll: async () => `${secret}\n` },
  });
  expect(r.code).toBe(0);
  expect(posts[0]).toMatchObject({ secret });
});

test("--secret=- on a terminal prompts for the secret without echoing it", async () => {
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

test("webhook add sends an openbot webhook with a non-base64 secret, never printing it", async () => {
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
  expect(r.stdout).toBe(
    "whk_1 openbot https://hooks.example.com/x run.waiting env_1\n",
  );
  expect(r.stdout + r.stderr).not.toContain(openbotSecret);
});

const sentinel = "OB-7f3q-sentinel";
type Source = "file" | "stdin";
const sources: Source[] = ["file", "stdin"];

async function addOpenBot(source: Source, content: string) {
  if (source === "stdin") {
    return runCli([...add, "--format=openbot", "--secret=-"], {
      stdin: { readAll: async () => content },
    });
  }
  const file = join(mkdtempSync(join(tmpdir(), "sky-wh-")), "secret");
  writeFileSync(file, content);
  return runCli([...add, "--format=openbot", `--secret=@${file}`]);
}

const accepted = sources.flatMap((source): [Source, string, string][] => [
  [source, `${sentinel}\n`, sentinel],
  [source, `${sentinel}\r\n`, sentinel],
  [source, `in ${sentinel} side\n`, `in ${sentinel} side`],
]);
test.each(accepted)("openbot %s %j sends %j", async (src, raw, sent) => {
  const r = await addOpenBot(src, raw);
  expect(r.code).toBe(0);
  expect(posts).toEqual([
    expect.objectContaining({ format: "openbot", secret: sent }),
  ]);
});

const padded = "an openbot secret has no leading or trailing whitespace";
const refused: [string, Source, string, string][] = [
  ...sources.flatMap((source): [string, Source, string, string][] => [
    ["a leading space", source, ` ${sentinel}\n`, padded],
    ["a trailing space", source, `${sentinel} \n`, padded],
    ["two trailing newlines", source, `${sentinel}\n\n`, padded],
    [
      "257 characters",
      source,
      `${sentinel}${"a".repeat(257 - sentinel.length)}\n`,
      "an openbot secret is at most 256 characters",
    ],
  ]),
  ["a byte order mark", "file", `\uFEFF${sentinel}\n`, padded],
];
test.each(refused)("openbot refuses %s from %s", async (_, src, raw, rule) => {
  const r = await addOpenBot(src, raw);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(`sky: ${rule}\n`);
  expect(r.stdout + r.stderr).not.toContain(sentinel);
  expect(posts).toEqual([]);
});

test("an openbot secret given as the argument value is refused without echoing it", async () => {
  const r = await runCli([...add, "--format=openbot", `--secret=${sentinel}`]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(
    "--secret takes @<file> or - (stdin), not the secret itself",
  );
  expect(r.stdout + r.stderr).not.toContain(sentinel);
  expect(posts).toEqual([]);
});

test.each([
  ["--format=nope", "--format is sky, standard or openbot"],
  ["--format=", "--format is sky, standard or openbot"],
  ["--format=openbot", "--format=openbot needs --secret=@file|-"],
  ["--secret=-", "--secret only goes with --format=standard or openbot"],
])("webhook add %s exits 2 with its usage message", async (flag, message) => {
  const r = await runCli([...add, flag]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(`sky: ${message}\nRun 'sky --help' for usage.\n`);
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
const formats = ["standard", "openbot"];
const empties = formats.flatMap((f) => blanks.map((input) => [f, input]));
test.each(empties)("%s stdin %j exits 2 as empty", async (format, input) => {
  const r = await runCli([...add, `--format=${format}`, "--secret=-"], {
    stdin: { readAll: async () => input },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/the secret from stdin is empty/);
  expect(r.stderr).not.toMatch(/must be whsec_|whitespace/);
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
