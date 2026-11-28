import { HttpResponse, http } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const envJson = (over: Record<string, unknown> = {}) => ({
  id: "env_1",
  name: "web",
  repo: "acme/web",
  setup: "",
  status: "ready",
  spriteName: "sky-env-1",
  checkpointId: "cp_1",
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
  failure: null,
  createdAt: "2026-10-30T12:00:00.000Z",
  ...over,
});

const web = envJson();
const failed = envJson({
  id: "env_2",
  name: "api docs",
  repo: "acme/api",
  status: "failed",
  checkpointId: null,
  failure: { step: "setup", stderr: "npm ERR! missing script\nexit 1\n" },
});

const list = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({ data: [web, failed] }),
);

test("env list prints one line per environment, name last", async () => {
  server.use(list);
  const r = await runCli(["env", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nenv_2 failed acme/api api docs\n",
  );
});

test("env list with no environments leaves stdout empty", async () => {
  server.use(
    http.get(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json({ data: [] }),
    ),
  );
  const r = await runCli(["env", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    "no environments; create one with sky apply <env.yaml>\n",
  );
});

const getEnv = http.get(`${apiUrl}/v1/environments/:id`, ({ params }) => {
  const found = [web, failed].find((e) => e.id === params.id);
  return found
    ? HttpResponse.json(found)
    : HttpResponse.json(
        { error: { code: "not_found", message: "no such environment" } },
        { status: 404 },
      );
});

test("env show by id prints the environment", async () => {
  server.use(list, getEnv);
  const r = await runCli(["env", "show", "env_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nruntime: default (the SKY_RUNTIME secret, else claude-code)\n",
  );
});

test("env show says a refresh script is set, without printing it", async () => {
  const script = "git -C ~/k pull --ff-only\nmake build";
  server.use(
    http.get(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json({ data: [envJson({ refresh: script })] }),
    ),
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(envJson({ refresh: script })),
    ),
  );
  const r = await runCli(["env", "show", "env_1"]);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nruntime: default (the SKY_RUNTIME secret, else claude-code)\nrefresh: set (2 lines, runs before every run)\n",
  );
  expect(r.stdout).not.toContain("git -C");
});

test("env show by name resolves the id, and a failed env shows its step and stderr", async () => {
  server.use(list, getEnv);
  const r = await runCli(["env", "show", "api docs"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "env_2 failed acme/api api docs\nruntime: default (the SKY_RUNTIME secret, else claude-code)\nfailed at step setup\n  npm ERR! missing script\n  exit 1\n",
  );
});

test("env show --json prints the API's environment object", async () => {
  server.use(list, getEnv);
  const r = await runCli(["env", "show", "web", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(web);
});

test("env show --json of a failed env passes the failure through", async () => {
  server.use(list, getEnv);
  const r = await runCli(["env", "show", "env_2", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(failed);
  expect(JSON.parse(r.stdout).failure.step).toBe("setup");
});

test("env show of an unknown name or id exits 1", async () => {
  server.use(list, getEnv);
  const byName = await runCli(["env", "show", "nope"]);
  expect(byName.code).toBe(1);
  expect(byName.stdout).toBe("");
  expect(byName.stderr).toBe("sky: no environment named nope\n");
  const byId = await runCli(["env", "show", "env_9", "--json"]);
  expect(byId.code).toBe(1);
  expect(byId.stdout).toBe("");
  expect(JSON.parse(byId.stderr)).toEqual({
    error: { code: "not_found", message: "no environment env_9" },
  });
});

// `sky apply` creates an env by name, so a name shaped like an id is reachable only by lookup
const idShaped = envJson({ id: "env_7", name: "env_prod" });
const listWithIdShaped = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({ data: [web, idShaped] }),
);

test("env show of a name shaped like an id resolves it by name", async () => {
  server.use(
    listWithIdShaped,
    http.get(`${apiUrl}/v1/environments/env_7`, () =>
      HttpResponse.json(idShaped),
    ),
  );
  const r = await runCli(["env", "show", "env_prod"]);
  expect(r.code).toBe(0);
  expect(r.stdout.split("\n")[0]).toBe("env_7 ready acme/web env_prod");
});

const deletes: string[] = [];

beforeEach(() => {
  deletes.length = 0;
});

const deleteEnv = (response: () => Response) =>
  http.delete(`${apiUrl}/v1/environments/:id`, ({ params }) => {
    deletes.push(String(params.id));
    return response();
  });

test("env delete by name deletes the resolved id", async () => {
  server.use(
    list,
    deleteEnv(() => new HttpResponse(null, { status: 204 })),
  );
  const r = await runCli(["env", "delete", "web", "--yes"]);
  expect(r.code).toBe(0);
  expect(deletes).toEqual(["env_1"]);
  expect(r.stdout).toBe("deleted env_1\n");
});

// no DELETE handler is registered: a request would be reported as a leak
test("env delete of an unknown env exits 1 without a request", async () => {
  server.use(list);
  const r = await runCli(["env", "delete", "nope", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: no environment named nope\n");
  expect(deletes).toEqual([]);
});

test("env delete --json prints an object naming the deleted id", async () => {
  server.use(
    list,
    deleteEnv(() => new HttpResponse(null, { status: 204 })),
  );
  const r = await runCli(["env", "delete", "env_1", "--json", "--yes"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ id: "env_1", deleted: true });
});

test("env delete refused by the API exits 1 with its message", async () => {
  server.use(
    list,
    deleteEnv(() =>
      HttpResponse.json(
        { error: { code: "run_active", message: "a run is active" } },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["env", "delete", "env_1", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: a run is active (run_active)\n");
});

test("env delete refused by the API under --json prints only code and message", async () => {
  server.use(
    list,
    deleteEnv(() =>
      HttpResponse.json(
        { error: { code: "run_active", message: "a run is active" } },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["env", "delete", "env_1", "--yes", "--json"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(JSON.parse(r.stderr)).toEqual({
    error: { code: "run_active", message: "a run is active" },
  });
});

const webhooksFilter = (extra: Record<string, unknown>) =>
  deleteEnv(() =>
    HttpResponse.json(
      {
        error: {
          code: "webhooks_filter",
          message:
            "webhooks filter on this environment: whk_a, whk_b; delete them first",
          ...extra,
        },
      },
      { status: 409 },
    ),
  );

test("env delete blocked by filtering webhooks names them and the command that unblocks it", async () => {
  server.use(list, webhooksFilter({ webhookIds: ["whk_a", "whk_b"] }));
  const r = await runCli(["env", "delete", "web", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    "sky: webhooks filter on web (env_1): whk_a, whk_b; delete them first with sky webhook delete <id>\n",
  );
});

test("env delete --json blocked by filtering webhooks keeps the API error", async () => {
  server.use(list, webhooksFilter({ webhookIds: ["whk_a", "whk_b"] }));
  const r = await runCli(["env", "delete", "env_1", "--json", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(JSON.parse(r.stderr)).toEqual({
    error: {
      code: "webhooks_filter",
      message:
        "webhooks filter on this environment: whk_a, whk_b; delete them first",
    },
  });
});

test("env delete blocked by filtering webhooks without their ids prints the API message", async () => {
  server.use(list, webhooksFilter({ webhookIds: "whk_a" }));
  const r = await runCli(["env", "delete", "env_1", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    "sky: webhooks filter on this environment: whk_a, whk_b; delete them first (webhooks_filter)\n",
  );
});

const terminal = (answer: string, prompts: string[]) => ({
  stderrIsTTY: true,
  stdin: {
    isTTY: true,
    prompt: async (text: string) => {
      prompts.push(text);
      return answer;
    },
  },
});

// no DELETE handler is registered: a request would be reported as a leak
test("env delete without --yes and no terminal is refused before any request", async () => {
  for (const opts of [
    {},
    { ...terminal("y", []), env: { CI: "true" } },
    { stderrIsTTY: true, stdin: { isTTY: false } },
  ]) {
    const r = await runCli(["env", "delete", "web"], opts);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("sky: refusing to delete web without --yes\n");
  }
});

test("env delete --json without --yes is refused even on a terminal", async () => {
  const prompts: string[] = [];
  const r = await runCli(
    ["env", "delete", "web", "--json"],
    terminal("y", prompts),
  );
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(prompts).toEqual([]);
});

test("env delete on a terminal deletes after a yes", async () => {
  for (const answer of ["y", "YES", " y "]) {
    deletes.length = 0; // per answer, within one test
    const prompts: string[] = [];
    server.use(
      list,
      deleteEnv(() => new HttpResponse(null, { status: 204 })),
    );
    const r = await runCli(["env", "delete", "web"], terminal(answer, prompts));
    expect(r.code, answer).toBe(0);
    expect(prompts).toEqual([
      "permanently delete web (env_1) and all its agents, runs and events? [y/N] ",
    ]);
    expect(deletes).toEqual(["env_1"]);
    expect(r.stdout).toBe("deleted env_1\n");
  }
});

test("env delete on a terminal aborts on anything but yes", async () => {
  for (const answer of ["", "n", "no", "yep"]) {
    server.use(list);
    const r = await runCli(["env", "delete", "web"], terminal(answer, []));
    expect(r.code, answer).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("nothing deleted\n");
  }
});

test("--yes goes only with env delete or env rebuild", async () => {
  const r = await runCli(["env", "show", "web", "--yes"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(
    "sky: --yes only goes with env delete or env rebuild\nRun 'sky --help' for usage.\n",
  );
});

const retryEnv = (response: () => Response) =>
  http.post(`${apiUrl}/v1/environments/:id/retry`, response);

const provisioning = { ...failed, status: "provisioning", failure: null };

test("env retry by name prints the reprovisioning environment", async () => {
  server.use(
    list,
    retryEnv(() => HttpResponse.json(provisioning, { status: 202 })),
  );
  const r = await runCli(["env", "retry", "api docs"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("env_2 provisioning acme/api api docs\n");
});

test("env retry --json by id prints the API's environment object", async () => {
  server.use(
    list,
    retryEnv(() => HttpResponse.json(provisioning, { status: 202 })),
  );
  const r = await runCli(["env", "retry", "env_2", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(provisioning);
});

// no POST handler is registered: a request would be reported as a leak
test("env retry of an unknown env exits 1 without a request", async () => {
  server.use(list);
  const r = await runCli(["env", "retry", "nope"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: no environment named nope\n");
});

test("env retry of an env that hasn't failed exits 1", async () => {
  server.use(
    list,
    retryEnv(() =>
      HttpResponse.json(
        {
          error: {
            code: "not_failed",
            message: "only a failed environment can be retried",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["env", "retry", "env_1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(
    "sky: only a failed environment can be retried (not_failed)\n",
  );
});

test("env usage errors exit 2 without a request", async () => {
  for (const argv of [
    ["env"],
    ["env", "rename", "web"],
    ["env", "list", "web"],
    ["env", "show"],
    ["env", "delete", "web", "api"],
    ["env", "retry"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/Run 'sky --help' for usage/);
  }
});

test("--help lists the env and secret subcommands", async () => {
  const r = await runCli(["env", "--help"]);
  expect(r.code).toBe(0);
  for (const usage of [
    "sky env list",
    "sky env show <env>",
    "sky env delete <env> [--yes]",
    "sky env retry <env>",
    "sky secret list <env>",
    "sky secret delete <env> <NAME>",
  ]) {
    expect(r.stdout).toContain(usage);
  }
});

test("env list --json prints the API's list object", async () => {
  server.use(list);
  const r = await runCli(["env", "list", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ data: [web, failed] });
});

test("env list --json with no environments prints the empty list object", async () => {
  server.use(
    http.get(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json({ data: [] }),
    ),
  );
  const r = await runCli(["env", "list", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ data: [] });
});

const claudeAssignment = (over: Record<string, unknown> = {}) =>
  envJson({ claudeCredential: "personal", claudeFallback: "api-key", ...over });

test("env set-claude patches the credential and prints the assignment by name", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(claudeAssignment());
    }),
  );
  const r = await runCli(["env", "set-claude", "web", "personal"]);
  expect(r.code).toBe(0);
  expect(bodies).toEqual([{ claudeCredential: "personal" }]);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nclaude credential: personal (fallback: api-key)\n",
  );
});

test("env set-claude default clears the assignment, and --fallback sets the fallback", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        claudeAssignment({ claudeCredential: null, claudeFallback: "none" }),
      );
    }),
  );
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "default",
    "--fallback=none",
  ]);
  expect(r.code).toBe(0);
  expect(bodies).toEqual([{ claudeCredential: null, claudeFallback: "none" }]);
  expect(r.stdout).toContain("claude credential: default (fallback: none)");
});

test("env set-claude api-key is accepted as a name", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        claudeAssignment({ claudeCredential: "api-key" }),
      );
    }),
  );
  expect((await runCli(["env", "set-claude", "web", "api-key"])).code).toBe(0);
  expect(bodies).toEqual([{ claudeCredential: "api-key" }]);
});

test("env set-claude api-key:backup assigns that named key and prints it", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        claudeAssignment({ claudeCredential: "api-key:backup" }),
      );
    }),
  );
  const r = await runCli(["env", "set-claude", "web", "api-key:backup"]);
  expect(r.code).toBe(0);
  expect(bodies).toEqual([{ claudeCredential: "api-key:backup" }]);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nclaude credential: api-key:backup (fallback: api-key)\n",
  );
});

test("the API refusing a credential its server doesn't hold is the CLI's failure, message intact", async () => {
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(
        {
          error: {
            code: "unknown_credential",
            message: 'unknown Claude credential "x"; this server has: default',
          },
        },
        { status: 400 },
      ),
    ),
  );
  const r = await runCli(["env", "set-claude", "web", "x"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("this server has: default");
});

test.each([
  [
    ["env", "set-claude", "web"],
    /takes <env> <name\|api-key\|api-key:<name>\|pool\|default>/,
  ],
  [["env", "set-claude", "web", "Not A Name"], /not a credential name/],
  [["env", "set-claude", "web", "x", "--fallback=maybe"], /api-key or none/],
  [["env", "list", "--fallback=none"], /only goes with env set-claude/],
])("%j is a usage error", async (argv, message) => {
  const r = await runCli(argv);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(message);
});

test("env show says which credential an environment uses once it isn't the default", async () => {
  server.use(
    list,
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(
        claudeAssignment({ claudeCredential: "work", claudeFallback: "none" }),
      ),
    ),
  );
  const r = await runCli(["env", "show", "env_1"]);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nruntime: default (the SKY_RUNTIME secret, else claude-code)\nclaude credential: work (fallback: none)\n",
  );
});

test("env set-claude pool sets the pool, with --pool its subscriptions in order", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      const body = await request.json();
      bodies.push(body);
      return HttpResponse.json(
        claudeAssignment({
          claudeCredential: "pool",
          claudePool: (body as { claudePool: string[] | null }).claudePool,
        }),
      );
    }),
  );
  expect((await runCli(["env", "set-claude", "web", "pool"])).code).toBe(0);
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "pool",
    "--pool=work, personal",
  ]);
  expect(bodies).toEqual([
    { claudeCredential: "pool" },
    { claudeCredential: "pool", claudePool: ["work", "personal"] },
  ]);
  expect(r.stdout).toContain("claude credential: pool [work, personal]");
});

test("--pool goes only with the pool credential", async () => {
  const r = await runCli(["env", "set-claude", "web", "personal", "--pool=a"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/--pool goes with the credential pool/);
});

test("env set-claude pool --fallback=none leaves an ordered pool as it is", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        claudeAssignment({
          claudeCredential: "pool",
          claudePool: ["work", "personal"],
          claudeFallback: "none",
        }),
      );
    }),
  );
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "pool",
    "--fallback=none",
  ]);
  expect(r.code).toBe(0);
  // no claudePool key: the server keeps the list
  expect(bodies).toEqual([
    { claudeCredential: "pool", claudeFallback: "none" },
  ]);
  expect(r.stdout).toContain("pool [work, personal] (fallback: none)");
});

test("env set-claude pool --pool=all resets the pool to every subscription", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        claudeAssignment({ claudeCredential: "pool", claudePool: null }),
      );
    }),
  );
  expect(
    (await runCli(["env", "set-claude", "web", "pool", "--pool=all"])).code,
  ).toBe(0);
  expect(bodies).toEqual([{ claudeCredential: "pool", claudePool: null }]);
});

test("--pool=all stands alone", async () => {
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "pool",
    "--pool=all,work",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/--pool=all takes no other subscription names/);
});

test("--fallback alone on a non-pool credential sends no pool either", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(claudeAssignment());
    }),
  );
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "personal",
    "--fallback=none",
  ]);
  expect(r.code).toBe(0);
  expect(bodies).toEqual([
    { claudeCredential: "personal", claudeFallback: "none" },
  ]);
});

test.each(["ALL", "All"])(
  "--pool=%s resets the pool to every subscription",
  async (value) => {
    const bodies: unknown[] = [];
    server.use(
      list,
      http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          claudeAssignment({ claudeCredential: "pool", claudePool: null }),
        );
      }),
    );
    const r = await runCli([
      "env",
      "set-claude",
      "web",
      "pool",
      `--pool=${value}`,
    ]);
    expect(r.code).toBe(0);
    expect(bodies).toEqual([{ claudeCredential: "pool", claudePool: null }]);
  },
);

test("--pool=ALL stands alone too", async () => {
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "pool",
    "--pool=work,ALL",
  ]);
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/--pool=all takes no other subscription names/);
});

test("a --pool name that isn't a subscription name is a usage error, with no request", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(claudeAssignment());
    }),
  );
  const r = await runCli([
    "env",
    "set-claude",
    "web",
    "pool",
    "--pool=work,PERSONAL",
  ]);
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(
    /"PERSONAL" in --pool is not a subscription name: use one the server holds, in lowercase letters, digits and _/,
  );
  expect(bodies).toEqual([]);
});

const DEFAULT_RUNTIME =
  "runtime: default (the SKY_RUNTIME secret, else claude-code)";

test("env show prints the stored runtime, or that it follows the secret", async () => {
  server.use(
    list,
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(envJson({ runtime: "codex" })),
    ),
  );
  expect((await runCli(["env", "show", "env_1"])).stdout).toBe(
    "env_1 ready acme/web web\nruntime: codex\n",
  );
  server.use(
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(envJson({ runtime: null })),
    ),
  );
  expect((await runCli(["env", "show", "env_1"])).stdout).toBe(
    `env_1 ready acme/web web\n${DEFAULT_RUNTIME}\n`,
  );
});

test("env set-runtime puts the runtime and prints it", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.put(`${apiUrl}/v1/environments/env_1/runtime`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(envJson({ runtime: "codex" }));
    }),
  );
  const r = await runCli(["env", "set-runtime", "web", "codex"]);
  expect(r.code).toBe(0);
  expect(bodies).toEqual([{ runtime: "codex" }]);
  expect(r.stdout).toBe("env_1 ready acme/web web\nruntime: codex\n");
});

test("env set-runtime default stores no runtime, so the env follows its SKY_RUNTIME secret, and shows that", async () => {
  const bodies: unknown[] = [];
  server.use(
    list,
    http.put(`${apiUrl}/v1/environments/env_1/runtime`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(envJson({ runtime: null }));
    }),
  );
  const r = await runCli(["env", "set-runtime", "web", "default"]);
  expect(r.code).toBe(0);
  expect(bodies).toEqual([{ runtime: null }]);
  expect(r.stdout).toBe(`env_1 ready acme/web web\n${DEFAULT_RUNTIME}\n`);
  expect(r.stderr).toBe("");
});

test("env set-runtime --json prints the API's environment object", async () => {
  const back = envJson({ runtime: "claude-code" });
  server.use(
    list,
    http.put(`${apiUrl}/v1/environments/env_1/runtime`, () =>
      HttpResponse.json(back),
    ),
  );
  const r = await runCli([
    "env",
    "set-runtime",
    "web",
    "claude-code",
    "--json",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(back);
});

test("env set-runtime refused for want of the gateway key fails with the API's message", async () => {
  const message =
    "this environment has no AI_GATEWAY_API_KEY secret; set it with sky secret set web AI_GATEWAY_API_KEY, then switch again";
  server.use(
    list,
    http.put(`${apiUrl}/v1/environments/env_1/runtime`, () =>
      HttpResponse.json(
        { error: { code: "gateway_key_missing", message } },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["env", "set-runtime", "web", "codex"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(message);
  expect(r.stdout).toBe("");
});

const INSTALL_NOTICE =
  "installing Codex on the sandbox if it's missing; this can take a few minutes\n";

/** Runs the CLI recording the timeout each request was given, in request order. */
async function timeoutsOf(argv: string[]) {
  const spy = vi.spyOn(AbortSignal, "timeout");
  try {
    const r = await runCli(argv);
    return { r, timeouts: spy.mock.calls.map(([ms]) => ms) };
  } finally {
    spy.mockRestore();
  }
}

const putRuntime = (runtime: string | null) =>
  http.put(`${apiUrl}/v1/environments/env_1/runtime`, () =>
    HttpResponse.json(envJson({ runtime })),
  );

test("env set-runtime codex waits 15 minutes for the switch; the env lookup keeps 30 s", async () => {
  server.use(list, putRuntime("codex"));
  const { r, timeouts } = await timeoutsOf([
    "env",
    "set-runtime",
    "web",
    "codex",
  ]);
  expect(r.code).toBe(0);
  expect(timeouts).toEqual([30_000, 15 * 60_000]);
});

test("env set-runtime claude-code and other commands keep the 30 s timeout", async () => {
  server.use(list, getEnv, putRuntime("claude-code"));
  const set = await timeoutsOf(["env", "set-runtime", "web", "claude-code"]);
  expect(set.r.code).toBe(0);
  expect(set.timeouts).toEqual([30_000, 30_000]);
  const show = await timeoutsOf(["env", "show", "web"]);
  expect(show.r.code).toBe(0);
  expect(show.timeouts.length).toBeGreaterThan(0);
  expect(new Set(show.timeouts)).toEqual(new Set([30_000]));
});

test("env set-runtime codex says on stderr that Codex may be installed, stdout unchanged", async () => {
  server.use(list, putRuntime("codex"));
  const plain = await runCli(["env", "set-runtime", "web", "codex"]);
  expect(plain.code).toBe(0);
  expect(plain.stderr).toBe(INSTALL_NOTICE);
  expect(plain.stdout).toBe("env_1 ready acme/web web\nruntime: codex\n");
  const json = await runCli(["env", "set-runtime", "web", "codex", "--json"]);
  expect(json.code).toBe(0);
  expect(json.stderr).toBe(INSTALL_NOTICE);
  expect(JSON.parse(json.stdout)).toEqual(envJson({ runtime: "codex" }));
});

test("env set-runtime claude-code prints no install notice", async () => {
  server.use(list, putRuntime("claude-code"));
  const r = await runCli(["env", "set-runtime", "web", "claude-code"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
});

test.each([
  [
    "codex",
    "sky: cannot reach https://sky.test: no response in 15 min; the switch may still complete on the server: check with sky env show env_1\n",
  ],
  ["claude-code", "sky: cannot reach https://sky.test: no response in 30s\n"],
])(
  "a timed-out switch to %s exits 1 as unreachable",
  async (runtime, message) => {
    server.use(list);
    const fetchOf = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch");
    // what undici rejects with when the request's AbortSignal.timeout fires
    spy.mockImplementation(async (input, init) => {
      if (init?.method !== "PUT") return fetchOf(input, init);
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    });
    try {
      const r = await runCli(["env", "set-runtime", "web", runtime]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        `${runtime === "codex" ? INSTALL_NOTICE : ""}${message}`,
      );
      const json = await runCli([
        "env",
        "set-runtime",
        "web",
        runtime,
        "--json",
      ]);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const lines = json.stderr.trimEnd().split("\n");
      expect(JSON.parse(lines[lines.length - 1] ?? "")).toEqual({
        error: {
          code: "unreachable",
          message: message.replace(/^sky: /, "").trimEnd(),
        },
      });
    } finally {
      spy.mockRestore();
    }
  },
);

test.each([
  [["env", "set-runtime", "web"], /takes <env> <claude-code\|codex\|default>/],
  [["env", "set-runtime", "web", "codex", "extra"], /takes <env>/],
  [
    ["env", "set-runtime", "web", "claude"],
    /use claude-code, codex or default/,
  ],
])("%j is a usage error with no request", async (argv, message) => {
  let requests = 0;
  server.use(
    http.all(`${apiUrl}/*`, () => {
      requests++;
      return HttpResponse.json({}, { status: 500 });
    }),
  );
  const r = await runCli(argv);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(message);
  expect(requests).toBe(0);
});
