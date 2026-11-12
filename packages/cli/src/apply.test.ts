import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { specHash } from "./spec.js";
import { apiKey, apiUrl, type Captured, runCli } from "./testing.js";

const yaml = "name: web\nrepo: acme/web\nsetup: pnpm install\n";
const spec = {
  name: "web",
  repo: "acme/web",
  setup: "pnpm install",
  base: null,
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
};
const env = (over: Record<string, unknown> = {}) => ({
  id: "env_1",
  ...spec,
  claudeCredential: null,
  claudePool: null,
  claudeFallback: "api-key",
  status: "ready",
  spriteName: "sky-env-1",
  checkpointId: "ckpt_1",
  failure: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  ...over,
});

let dir: string;
let file: string;
let lockFile: string;
const writes: { method: string; body: unknown }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-apply-"));
  file = join(dir, "env.yaml");
  lockFile = join(dir, "sky-lock.json");
  writeFileSync(file, yaml);
  writes.length = 0;
});

const authed = (request: Request) =>
  request.headers.get("authorization") === `Bearer ${apiKey}`;

/** GET /:id answers with each status in turn, then repeats the last. */
function getSequence(...states: Record<string, unknown>[]) {
  let i = 0;
  return http.get(`${apiUrl}/v1/environments/:id`, ({ request }) => {
    if (!authed(request)) return new HttpResponse(null, { status: 401 });
    const body = states[Math.min(i++, states.length - 1)];
    return HttpResponse.json(body);
  });
}
const list = (...envs: Record<string, unknown>[]) =>
  http.get(`${apiUrl}/v1/environments`, () =>
    HttpResponse.json({ data: envs }),
  );
const recordWrite =
  (status: number, response: Record<string, unknown>) =>
  async ({ request }: { request: Request }) => {
    writes.push({ method: request.method, body: await request.json() });
    return HttpResponse.json(response, { status });
  };

const noKeyLeak = (r: Captured) => {
  expect(r.stdout).not.toContain(apiKey);
  expect(r.stderr).not.toContain(apiKey);
};
const lock = () => JSON.parse(readFileSync(lockFile, "utf8"));

test("creates an absent env, waits for ready and writes the lock", async () => {
  server.use(
    list(env({ id: "env_other", name: "other" })),
    http.post(
      `${apiUrl}/v1/environments`,
      recordWrite(202, env({ status: "provisioning", checkpointId: null })),
    ),
    getSequence(
      env({ status: "provisioning", checkpointId: null }),
      env({ status: "ready" }),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([{ method: "POST", body: spec }]);
  expect(r.sleeps.every((ms) => ms === 3000)).toBe(true);
  expect(r.sleeps.length).toBeGreaterThan(0);
  expect(r.stderr).toMatch(/provisioning/);
  expect(r.stdout).toBe("ready web env_1\n");
  expect(lock()).toEqual({
    envId: "env_1",
    spriteName: "sky-env-1",
    checkpointId: "ckpt_1",
    specHash: specHash(spec),
  });
  noKeyLeak(r);
});

test("an unchanged spec makes no write and says up to date", async () => {
  writeFileSync(
    lockFile,
    JSON.stringify({
      envId: "env_1",
      spriteName: "x",
      checkpointId: "y",
      specHash: "z",
    }),
  );
  // no POST/PATCH handler: any write is an unhandled request and fails the test
  server.use(getSequence(env()));
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("up to date web env_1\n");
  expect(lock()).toMatchObject({ envId: "env_1", checkpointId: "ckpt_1" });
});

test("patches only the changed fields", async () => {
  writeFileSync(file, `${yaml}concurrency: 5\n`);
  server.use(
    list(env()),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, env({ concurrency: 5 })),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([{ method: "PATCH", body: { concurrency: 5 } }]);
  expect(r.sleeps).toEqual([]);
  expect(lock().specHash).toBe(specHash({ ...spec, concurrency: 5 }));
});

const poolSetByHand = {
  claudeCredential: "pool",
  claudePool: ["work", "personal"],
  claudeFallback: "none",
};

test("an env.yaml that omits the Claude fields leaves what sky env set-claude set: nothing is written", async () => {
  // no POST/PATCH handler: any write is an unhandled request and fails the test
  server.use(list(env(poolSetByHand)));
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([]);
  expect(r.stdout).toBe("up to date web env_1\n");
});

test("an env.yaml that changes another field leaves the omitted Claude fields out of the patch", async () => {
  writeFileSync(file, `${yaml}concurrency: 5\n`);
  server.use(
    list(env(poolSetByHand)),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, env({ ...poolSetByHand, concurrency: 5 })),
    ),
  );
  expect((await runCli(["apply", file])).code).toBe(0);
  expect(writes).toEqual([{ method: "PATCH", body: { concurrency: 5 } }]);
});

test("only the Claude fields a file names change the environment", async () => {
  writeFileSync(file, `${yaml}claudeCredential: personal\n`);
  server.use(
    list(env(poolSetByHand)),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, env({ ...poolSetByHand, claudeCredential: "personal" })),
    ),
  );
  expect((await runCli(["apply", file])).code).toBe(0);
  // the pool list and the fallback aren't named, so they aren't sent
  expect(writes).toEqual([
    { method: "PATCH", body: { claudeCredential: "personal" } },
  ]);
});

test("a file naming every Claude field sets all of them", async () => {
  writeFileSync(
    file,
    `${yaml}claudeCredential: pool\nclaudePool: [work, personal]\nclaudeFallback: none\n`,
  );
  server.use(
    list(env()),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, env(poolSetByHand)),
    ),
  );
  expect((await runCli(["apply", file])).code).toBe(0);
  expect(writes).toEqual([
    {
      method: "PATCH",
      body: {
        claudeCredential: "pool",
        claudePool: ["work", "personal"],
        claudeFallback: "none",
      },
    },
  ]);
});

test("a file naming every Claude field writes nothing once they match", async () => {
  writeFileSync(
    file,
    `${yaml}claudeCredential: pool\nclaudePool: [work, personal]\nclaudeFallback: none\n`,
  );
  server.use(list(env(poolSetByHand)));
  const r = await runCli(["apply", file]);
  expect(r.stdout).toBe("up to date web env_1\n");
  expect(writes).toEqual([]);
});

test("claudeCredential: default matches an env on the default token, which the API reports as null", async () => {
  writeFileSync(file, `${yaml}claudeCredential: default\n`);
  // no POST/PATCH handler: any write is an unhandled request and fails the test
  server.use(list(env({ claudeCredential: null })));
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([]);
  expect(r.stdout).toBe("up to date web env_1\n");
});

test("claudeCredential: default moves an env off a named credential back to the default token", async () => {
  writeFileSync(file, `${yaml}claudeCredential: default\n`);
  server.use(
    list(env({ claudeCredential: "personal" })),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, env({ claudeCredential: null })),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([
    { method: "PATCH", body: { claudeCredential: "default" } },
  ]);
  expect(r.stdout).toBe("ready web env_1\n");
});

test("the lock's id finds a renamed env, which is patched rather than created", async () => {
  writeFileSync(file, yaml.replace("name: web", "name: site"));
  writeFileSync(lockFile, JSON.stringify({ envId: "env_1" }));
  server.use(
    getSequence(env()),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, env({ name: "site" })),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([{ method: "PATCH", body: { name: "site" } }]);
});

test("a lock whose env is gone falls back to the name", async () => {
  writeFileSync(lockFile, JSON.stringify({ envId: "env_gone" }));
  server.use(
    http.get(`${apiUrl}/v1/environments/env_gone`, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "no such environment" } },
        { status: 404 },
      ),
    ),
    list(env()),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(lock().envId).toBe("env_1");
});

test("a failed reprovision exits 1 with the step and the stderr tail, and leaves the lock", async () => {
  writeFileSync(file, yaml.replace("pnpm install", "make"));
  writeFileSync(lockFile, JSON.stringify({ envId: "env_1", specHash: "old" }));
  server.use(
    getSequence(
      env(),
      env({ status: "provisioning", setup: "make" }),
      env({
        status: "failed",
        setup: "make",
        checkpointId: null,
        failure: { step: "setup", stderr: "make: *** No targets.  Stop.\n" },
      }),
    ),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(
        202,
        env({ status: "provisioning", setup: "make", checkpointId: null }),
      ),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(writes).toEqual([{ method: "PATCH", body: { setup: "make" } }]);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/failed at step setup/);
  expect(r.stderr).toContain("make: *** No targets.  Stop.");
  expect(lock().specHash).toBe("old");
});

const failed = env({
  status: "failed",
  checkpointId: null,
  failure: { step: "clone", stderr: "fatal: repository not found\n" },
});
const retry = (response: Record<string, unknown>) =>
  http.post(`${apiUrl}/v1/environments/:id/retry`, ({ params }) => {
    writes.push({ method: "RETRY", body: params.id });
    return HttpResponse.json(response, { status: 202 });
  });

test("an unchanged spec on a failed env retries it and waits for ready", async () => {
  server.use(
    list(failed),
    retry(env({ status: "provisioning", checkpointId: null, failure: null })),
    getSequence(env()),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([{ method: "RETRY", body: "env_1" }]);
  expect(r.stderr).toContain("retrying web (last failed at clone)");
  expect(r.stdout).toBe("ready web env_1\n");
  expect(lock().checkpointId).toBe("ckpt_1");
});

test("a retry that fails again exits 1 with the new failure", async () => {
  server.use(
    list(failed),
    retry(env({ status: "provisioning", checkpointId: null, failure: null })),
    getSequence(
      env({
        status: "failed",
        checkpointId: null,
        failure: { step: "setup", stderr: "ERR_PNPM_NO_LOCKFILE\n" },
      }),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(writes).toEqual([{ method: "RETRY", body: "env_1" }]);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/failed at step setup/);
  expect(r.stderr).toContain("ERR_PNPM_NO_LOCKFILE");
  expect(existsSync(lockFile)).toBe(false);
});

test("a changed concurrency on a failed env patches it, then retries", async () => {
  writeFileSync(file, `${yaml}concurrency: 5\n`);
  server.use(
    list(failed),
    http.patch(
      `${apiUrl}/v1/environments/env_1`,
      recordWrite(200, { ...failed, concurrency: 5 }),
    ),
    retry(
      env({
        status: "provisioning",
        concurrency: 5,
        checkpointId: null,
        failure: null,
      }),
    ),
    getSequence(env({ concurrency: 5 })),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([
    { method: "PATCH", body: { concurrency: 5 } },
    { method: "RETRY", body: "env_1" },
  ]);
  expect(r.stdout).toBe("ready web env_1\n");
});

test("an API error exits 1 with its message", async () => {
  writeFileSync(file, yaml.replace("pnpm install", "make"));
  server.use(
    list(env()),
    http.patch(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(
        {
          error: {
            code: "run_active",
            message:
              "a run on this environment is active; wait for it or stop it",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(
    "a run on this environment is active; wait for it or stop it (run_active)",
  );
  expect(existsSync(lockFile)).toBe(false);
});

test("an unreachable API exits 1 naming the URL", async () => {
  server.use(http.get(`${apiUrl}/v1/environments`, () => HttpResponse.error()));
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`cannot reach ${apiUrl}`);
});

test("gives up after 30 minutes of provisioning", async () => {
  server.use(
    list(),
    http.post(
      `${apiUrl}/v1/environments`,
      recordWrite(202, env({ status: "provisioning" })),
    ),
    getSequence(env({ status: "provisioning" })),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60 * 1000);
  expect(r.stderr).toMatch(/still provisioning after 30m/);
  expect(existsSync(lockFile)).toBe(false);
});

test("--json prints the final env object and nothing else on stdout", async () => {
  server.use(list(env()));
  const r = await runCli(["apply", "--json", file]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(env());
});

test("--json failure leaves stdout empty and puts an error object on stderr", async () => {
  server.use(
    list(),
    http.post(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json(
        { error: { code: "name_taken", message: "taken" } },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["apply", "--json", file]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(JSON.parse(r.stderr)).toEqual({
    error: { code: "name_taken", message: "taken" },
  });
});

test("an invalid spec exits 2 naming field and line, with no request", async () => {
  writeFileSync(file, "name: web\nrepo: nope\nsetup: x\n");
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(
    `${file}:2: repo: expected a GitHub repo as owner/name`,
  );
});

test("a missing file exits 2", async () => {
  const r = await runCli(["apply", join(dir, "nope.yaml")]);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/nope\.yaml/);
});

test("missing config exits 2 before reading the API", async () => {
  const r = await runCli(["apply", file], {
    env: { SKY_URL: undefined, SKY_API_KEY: undefined },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/no API URL/);
});

test("usage errors exit 2 with a pointer to --help", async () => {
  for (const argv of [
    ["apply"],
    ["apply", file, "extra"],
    ["apply", "--bogus", file],
    ["nope"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.stderr).toMatch(/Run 'sky --help' for usage\.\n$/);
    expect(r.stdout).toBe("");
  }
});

const unavailable = () =>
  HttpResponse.json(
    { error: { code: "unavailable", message: "no healthy machines" } },
    { status: 503 },
  );

test("a 503 while polling is retried with backoff and the wait completes", async () => {
  let gets = 0;
  server.use(
    list(),
    http.post(
      `${apiUrl}/v1/environments`,
      recordWrite(202, env({ status: "provisioning", checkpointId: null })),
    ),
    http.get(`${apiUrl}/v1/environments/:id`, () => {
      gets++;
      if (gets === 1) return HttpResponse.json(env({ status: "provisioning" }));
      if (gets <= 4) return unavailable();
      if (gets === 5) return HttpResponse.error();
      return HttpResponse.json(env());
    }),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("ready web env_1\n");
  expect(r.sleeps).toEqual([3000, 3000, 6000, 12000, 24000, 30000]);
  // one line for the burst, not one per failed poll
  expect(r.stderr.match(/retrying/g)).toHaveLength(1);
  expect(r.stderr).toContain("no healthy machines");
});

test("a 4xx while polling fails at once", async () => {
  server.use(
    list(),
    http.post(
      `${apiUrl}/v1/environments`,
      recordWrite(202, env({ status: "provisioning", checkpointId: null })),
    ),
    http.get(`${apiUrl}/v1/environments/:id`, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "no such environment" } },
        { status: 404 },
      ),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(r.sleeps).toEqual([3000]);
  expect(r.stderr).toContain("no such environment (not_found)");
});

test("polling through an outage still gives up at the 30 minute deadline", async () => {
  server.use(
    list(),
    http.post(
      `${apiUrl}/v1/environments`,
      recordWrite(202, env({ status: "provisioning" })),
    ),
    http.get(`${apiUrl}/v1/environments/:id`, unavailable),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(1);
  expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
    30 * 60 * 1000,
  );
  expect(r.stderr).toMatch(/still provisioning after 30m/);
  expect(r.stderr).toContain("last poll: no healthy machines");
});

test("a setup change while the env is still provisioning waits for it, then patches", async () => {
  writeFileSync(file, yaml.replace("pnpm install", "make"));
  writeFileSync(lockFile, JSON.stringify({ envId: "env_1" }));
  const provisioning = env({ status: "provisioning", checkpointId: null });
  server.use(
    getSequence(
      provisioning,
      provisioning,
      env(),
      env({ setup: "make", checkpointId: "ckpt_2" }),
    ),
    http.patch(`${apiUrl}/v1/environments/env_1`, async ({ request }) => {
      writes.push({ method: "PATCH", body: await request.json() });
      return HttpResponse.json(
        env({ status: "provisioning", setup: "make", checkpointId: null }),
        { status: 202 },
      );
    }),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([{ method: "PATCH", body: { setup: "make" } }]);
  expect(r.stderr).toContain(
    "web (env_1) is still provisioning; waiting for it to finish before changing setup",
  );
  expect(r.stdout).toBe("ready web env_1\n");
  expect(lock().checkpointId).toBe("ckpt_2");
});

test("Ctrl-C during a wait says the env keeps provisioning and how to pick it up", async () => {
  server.use(
    list(),
    http.post(
      `${apiUrl}/v1/environments`,
      recordWrite(202, env({ status: "provisioning", checkpointId: null })),
    ),
    getSequence(env({ status: "provisioning" }), env()),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(r.interruptNotes).toEqual([
    "interrupted; web (env_1) keeps provisioning on the server. Re-run sky apply to pick it up",
  ]);
  expect(r.armedAtExit).toBe(0);
});

test("a SKY_URL without a scheme exits 2 showing the expected form, with no request", async () => {
  const r = await runCli(["apply", file], {
    env: { SKY_URL: "sky-api.fly.dev" },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(
    'sky: SKY_URL "sky-api.fly.dev" is not a URL; expected https://<host>, e.g. https://sky-api.fly.dev\n',
  );
});

test("a rejected API key exits 2 naming where the key came from", async () => {
  server.use(
    http.get(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "invalid API key" } },
        { status: 401 },
      ),
    ),
  );
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(
    "sky: invalid API key (unauthorized); check the key from SKY_API_KEY\n",
  );
  const json = await runCli(["apply", "--json", file]);
  expect(json.code).toBe(2);
  expect(JSON.parse(json.stderr)).toEqual({
    error: {
      code: "unauthorized",
      message: "invalid API key; check the key from SKY_API_KEY",
    },
  });
});

test.each([
  ["adding a base", "base: acme\n", null, "acme"],
  ["dropping the base line", "", "acme", null],
])(
  "%s patches base alone and waits for the reprovision",
  async (_, extra, was, now) => {
    writeFileSync(file, `${yaml}${extra}`);
    writeFileSync(
      lockFile,
      JSON.stringify({ envId: "env_1", specHash: "old" }),
    );
    server.use(
      getSequence(
        env({ base: was }),
        env({ base: now, status: "provisioning", checkpointId: null }),
        env({ base: now }),
      ),
      http.patch(
        `${apiUrl}/v1/environments/env_1`,
        recordWrite(
          202,
          env({ base: now, status: "provisioning", checkpointId: null }),
        ),
      ),
    );
    const r = await runCli(["apply", file]);
    expect(r.code).toBe(0);
    expect(writes).toEqual([{ method: "PATCH", body: { base: now } }]);
    expect(r.stderr).toMatch(/provisioning/);
  },
);

test("a base the env already has is not patched", async () => {
  writeFileSync(file, `${yaml}base: acme\n`);
  server.use(list(env({ base: "acme" })));
  const r = await runCli(["apply", file]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([]);
  expect(r.stdout).toBe("up to date web env_1\n");
});
