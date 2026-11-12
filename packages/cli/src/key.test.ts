import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const secret = `sky_${"A".repeat(43)}`;
const posts: unknown[] = [];
beforeEach(() => {
  posts.length = 0;
});

const key = {
  id: "key_1",
  name: "ci",
  role: "runs",
  environmentIds: ["env_1", "env_2"],
  createdAt: "2026-11-12T10:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
};
const envRow = (id: string, name: string) => ({
  id,
  name,
  repo: `acme/${name}`,
  setup: "",
  status: "ready",
  spriteName: "s",
  checkpointId: null,
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
  failure: null,
});
const createHandlers = [
  http.get(`${apiUrl}/v1/environments`, () =>
    HttpResponse.json({
      data: [envRow("env_1", "web"), envRow("env_2", "api")],
    }),
  ),
  http.post(`${apiUrl}/v1/keys`, async ({ request }) => {
    posts.push(await request.json());
    return HttpResponse.json({ ...key, secret }, { status: 201 });
  }),
];

test("key create resolves env names to ids and prints the id and secret once on stdout", async () => {
  server.use(...createHandlers);
  const r = await runCli(["key", "create", "ci", "--env=web,env_2"]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([
    { name: "ci", role: "runs", environmentIds: ["env_1", "env_2"] },
  ]);
  expect(r.stdout).toBe(`key_1 ${secret}\n`);
  expect(r.stderr).not.toContain(secret);
  expect(r.stderr).toMatch(/only now/);
});

test("key create --json prints the created key, secret included, as one document", async () => {
  server.use(...createHandlers);
  const r = await runCli(["key", "create", "ci", "--env=web", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ ...key, secret });
  expect(r.stderr).not.toContain(secret);
});

test.each([
  ["no --env", ["key", "create", "ci"]],
  ["an empty --env", ["key", "create", "ci", "--env= , "]],
  [
    "a role other than runs",
    ["key", "create", "ci", "--env=web", "--role=admin"],
  ],
  ["no name", ["key", "create", "--env=web"]],
  ["an extra argument", ["key", "create", "ci", "extra", "--env=web"]],
  ["--env on key list", ["key", "list", "--env=web"]],
  ["no subcommand", ["key"]],
  ["an unknown subcommand", ["key", "rotate"]],
])("%s exits 2 and sends nothing", async (_, argv) => {
  server.use(...createHandlers);
  const r = await runCli(argv);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Run 'sky --help' for usage.");
  expect(posts).toEqual([]);
});

test("--role=runs is accepted", async () => {
  server.use(...createHandlers);
  const r = await runCli(["key", "create", "ci", "--env=web", "--role=runs"]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([
    { name: "ci", role: "runs", environmentIds: ["env_1"] },
  ]);
});

const revoked = {
  ...key,
  id: "key_2",
  name: "old bot",
  environmentIds: ["env_1"],
  revokedAt: "2026-11-12T11:00:00.000Z",
};

test("key list prints one line per key and never a secret or hash", async () => {
  server.use(
    http.get(`${apiUrl}/v1/keys`, () =>
      HttpResponse.json({ data: [key, { ...revoked, hash: "deadbeef" }] }),
    ),
  );
  const r = await runCli(["key", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "key_1 runs active ci env_1,env_2\nkey_2 runs revoked old bot env_1\n",
  );
  const json = await runCli(["key", "list", "--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ data: [key, revoked] });
});

test("key list with no keys prints nothing on stdout and a hint on stderr", async () => {
  server.use(
    http.get(`${apiUrl}/v1/keys`, () => HttpResponse.json({ data: [] })),
  );
  const r = await runCli(["key", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/no keys; create one with sky key create/);
  const json = await runCli(["key", "list", "--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ data: [] });
});

test("key revoke revokes the key and prints its id", async () => {
  const deleted: string[] = [];
  server.use(
    http.delete(`${apiUrl}/v1/keys/:id`, ({ params }) => {
      deleted.push(String(params.id));
      return HttpResponse.json({ ...key, revokedAt: revoked.revokedAt });
    }),
  );
  const r = await runCli(["key", "revoke", "key_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("revoked key_1\n");
  const json = await runCli(["key", "revoke", "key_1", "--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ id: "key_1", revoked: true });
  expect(deleted).toEqual(["key_1", "key_1"]);
});

test("key revoke of an unknown id exits 1 with the API's message", async () => {
  server.use(
    http.delete(`${apiUrl}/v1/keys/:id`, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "no key key_9" } },
        { status: 404 },
      ),
    ),
  );
  const r = await runCli(["key", "revoke", "key_9"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: no key key_9 (not_found)\n");
});

test.each([
  ["key revoke without an id", ["key", "revoke"]],
  ["key revoke with two ids", ["key", "revoke", "key_1", "key_2"]],
  ["key list with an argument", ["key", "list", "x"]],
])("%s exits 2", async (_, argv) => {
  const r = await runCli(argv);
  expect(r.code).toBe(2);
});

test("a non-admin key's 403 is a failure (exit 1) with its message and code, not a config error", async () => {
  server.use(
    http.get(`${apiUrl}/v1/keys`, () =>
      HttpResponse.json(
        { error: { code: "forbidden", message: "keys need the admin key" } },
        { status: 403 },
      ),
    ),
  );
  const r = await runCli(["key", "list"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe("sky: keys need the admin key (forbidden)\n");
  const json = await runCli(["key", "list", "--json"]);
  expect(json.code).toBe(1);
  expect(json.stdout).toBe("");
  expect(JSON.parse(json.stderr)).toEqual({
    error: { code: "forbidden", message: "keys need the admin key" },
  });
});

test("--help lists the key subcommands and their --json shapes", async () => {
  const r = await runCli(["key", "--help"]);
  expect(r.code).toBe(0);
  for (const usage of [
    "sky key create <name> --env=<id|name>,... [--role=runs]",
    "sky key list",
    "sky key revoke <id>",
    'key revoke: {"id": …, "revoked": true}',
  ]) {
    expect(r.stdout).toContain(usage);
  }
});

test("an unknown --env exits 1 and creates no key", async () => {
  server.use(...createHandlers);
  const r = await runCli(["key", "create", "ci", "--env=nope"]);
  expect(r.code).toBe(1);
  expect(posts).toEqual([]);
});
