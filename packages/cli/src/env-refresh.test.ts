import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const script = `[ -d "$HOME/.sky/kru-codex/.git" ] || git clone https://github.com/salasjustin/kru-codex "$HOME/.sky/kru-codex"
git -C "$HOME/.sky/kru-codex" pull --ff-only
bash "$HOME/.sky/kru-codex/scripts/build-codex.sh" --install "$HOME/.sky/codex"
`;

const envJson = (over: Record<string, unknown> = {}) => ({
  id: "env_1",
  name: "web",
  repo: "acme/web",
  setup: 'pnpm install\nmake: it\'s "quoted" # not a comment\n',
  refresh: "",
  base: "team",
  status: "ready",
  spriteName: "sky-env-1",
  checkpointId: "cp_1",
  concurrency: 5,
  approvalPolicy: ["Bash", "Edit"],
  autoApprove: { defaults: false, commands: ["make check"] },
  claudeCredential: "work",
  claudePool: null,
  claudeFallback: "none",
  runtime: "codex",
  failure: null,
  createdAt: "2026-10-30T12:00:00.000Z",
  ...over,
});

const list = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({ data: [envJson()] }),
);
const patches: unknown[] = [];
const patchOk = http.patch(
  `${apiUrl}/v1/environments/env_1`,
  async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    patches.push(body);
    return HttpResponse.json(envJson(body));
  },
);
const secrets = http.get(`${apiUrl}/v1/environments/env_1/secrets`, () =>
  HttpResponse.json({
    data: [
      { name: "AI_GATEWAY_API_KEY", kind: "value" },
      { name: "GITHUB_CONNECTOR", kind: "connector" },
    ],
  }),
);

beforeEach(() => {
  patches.length = 0;
});

test("env set-refresh @file sends the file's script as it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sky-refresh-"));
  const file = join(dir, "refresh.sh");
  writeFileSync(file, script);
  server.use(list, patchOk);
  const r = await runCli(["env", "set-refresh", "web", `@${file}`]);
  expect(r.code).toBe(0);
  expect(patches).toEqual([{ refresh: script }]);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nrefresh: set (3 lines, runs before every run)\n",
  );
});

test("env set-refresh - reads stdin, and an empty one clears the script", async () => {
  server.use(list, patchOk);
  const set = await runCli(["env", "set-refresh", "web", "-"], {
    stdin: { readAll: async () => script },
  });
  expect(set.code).toBe(0);
  const cleared = await runCli(["env", "set-refresh", "web", "-"], {
    stdin: { readAll: async () => "" },
  });
  expect(cleared.code).toBe(0);
  expect(patches).toEqual([{ refresh: script }, { refresh: "" }]);
  expect(cleared.stdout).toBe("env_1 ready acme/web web\nrefresh: none\n");
});

test("env set-refresh refuses a script on argv, a missing file and the wrong arity, with no request", async () => {
  server.use(list, patchOk);
  const argv = await runCli(["env", "set-refresh", "web", "git pull"]);
  expect(argv.code).toBe(2);
  expect(argv.stderr).toMatch(/@<file> or - \(stdin\), not the script itself/);
  expect((await runCli(["env", "set-refresh", "web"])).code).toBe(2);
  const missing = await runCli([
    "env",
    "set-refresh",
    "web",
    "@/nonexistent/x",
  ]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toMatch(/cannot read \/nonexistent\/x \(ENOENT\)/);
  expect(patches).toEqual([]);
});

test("env set-refresh --json prints the API's environment", async () => {
  server.use(list, patchOk);
  const r = await runCli(["env", "set-refresh", "web", "-", "--json"], {
    stdin: { readAll: async () => "make\n" },
  });
  expect(JSON.parse(r.stdout)).toMatchObject({
    id: "env_1",
    refresh: "make\n",
  });
});

test("env show --yaml prints every env.yaml field, scripts as block scalars, the runtime and secret names as comments and no value", async () => {
  server.use(
    list,
    secrets,
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(envJson({ refresh: script })),
    ),
  );
  const r = await runCli(["env", "show", "web", "--yaml"]);
  expect(r.code).toBe(0);
  for (const key of [
    "name:",
    "repo:",
    "setup: |",
    "refresh: |",
    "base:",
    "concurrency:",
    "approvalPolicy:",
    "autoApprove:",
    "claudeCredential:",
    "claudePool:",
    "claudeFallback:",
  ])
    expect(r.stdout).toContain(key);
  expect(r.stdout).toContain("# runtime: codex");
  expect(r.stdout).toContain("sky env set-runtime web");
  expect(r.stdout).toContain(
    "AI_GATEWAY_API_KEY, GITHUB_CONNECTOR (connector)",
  );
  expect(r.stdout.endsWith("\n\n")).toBe(false);
});

test("env show --yaml works with a key that can't list secrets, and refuses --json and other subcommands", async () => {
  server.use(
    list,
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(envJson()),
    ),
    http.get(`${apiUrl}/v1/environments/env_1/secrets`, () =>
      HttpResponse.json(
        { error: { code: "forbidden", message: "admin only" } },
        { status: 403 },
      ),
    ),
  );
  const r = await runCli(["env", "show", "web", "--yaml"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("# secrets: not listed with this key");
  expect((await runCli(["env", "show", "web", "--yaml", "--json"])).code).toBe(
    2,
  );
  expect((await runCli(["env", "list", "--yaml"])).code).toBe(2);
});

const serveOnly = (stored: Record<string, unknown>) =>
  server.use(
    http.get(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json({ data: [stored] }),
    ),
    secrets,
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(stored),
    ),
    patchOk,
  );

test("export → apply is a no-op: sky apply on the exported file says up to date", async () => {
  const stored = envJson({ refresh: script });
  serveOnly(stored);
  const exported = await runCli(["env", "show", "web", "--yaml"]);
  const dir = mkdtempSync(join(tmpdir(), "sky-export-"));
  const file = join(dir, "env.yaml");
  writeFileSync(file, exported.stdout);
  const applied = await runCli(["apply", file]);
  expect(applied.code).toBe(0);
  expect(patches).toEqual([]);
  expect(applied.stdout).toBe("up to date web env_1\n");
  expect(patches).toEqual([]);
});

test("export → apply is a no-op for an env with the defaults too, and one with a default credential and no script", async () => {
  const stored = envJson({
    setup: "",
    refresh: "",
    base: null,
    claudeCredential: null,
    claudeFallback: "api-key",
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    concurrency: 3,
    runtime: null,
  });
  serveOnly(stored);
  const exported = await runCli(["env", "show", "web", "--yaml"]);
  const dir = mkdtempSync(join(tmpdir(), "sky-export-"));
  const file = join(dir, "env.yaml");
  writeFileSync(file, exported.stdout);
  const applied = await runCli(["apply", file]);
  expect(patches).toEqual([]);
  expect(applied.stdout).toBe("up to date web env_1\n");
  expect(patches).toEqual([]);
});
