import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
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
  expect(r.stdout).toBe("env_1 ready acme/web web\n");
});

test("env show by name resolves the id, and a failed env shows its step and stderr", async () => {
  server.use(list, getEnv);
  const r = await runCli(["env", "show", "api docs"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "env_2 failed acme/api api docs\nfailed at step setup\n  npm ERR! missing script\n  exit 1\n",
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
  expect(r.stdout).toBe("env_7 ready acme/web env_prod\n");
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

test("--yes goes only with env delete", async () => {
  const r = await runCli(["env", "show", "web", "--yes"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(
    "sky: --yes only goes with env delete\nRun 'sky --help' for usage.\n",
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
