import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiKey, apiUrl, runCli } from "./testing.js";

const value = "s3cr3t-value-do-not-print";
const puts: { path: string; body: unknown }[] = [];

const secretDeletes: string[] = [];

beforeEach(() => {
  puts.length = 0;
  secretDeletes.length = 0;
});

const putSecret = (response: Record<string, unknown>) =>
  http.put(
    `${apiUrl}/v1/environments/:id/secrets/:name`,
    async ({ request, params }) => {
      if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
        return new HttpResponse(null, { status: 401 });
      }
      puts.push({
        path: `${params.id}/${params.name}`,
        body: await request.json(),
      });
      return HttpResponse.json(response);
    },
  );
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
const list = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({ data: [envRow] }),
);

test("a piped value is sent and never printed", async () => {
  server.use(list, putSecret({ name: "TOKEN", kind: "value" }));
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    stdin: { readAll: async () => `${value}\n` },
  });
  expect(r.code).toBe(0);
  expect(puts).toEqual([{ path: "env_1/TOKEN", body: { value } }]);
  expect(r.stdout).toBe("set TOKEN (value)\n");
  expect(r.stdout).not.toContain(value);
  expect(r.stderr).not.toContain(value);
});

test("an env name is resolved to its id", async () => {
  server.use(list, putSecret({ name: "TOKEN", kind: "value" }));
  const r = await runCli(["secret", "set", "web", "TOKEN"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(0);
  expect(puts[0]?.path).toBe("env_1/TOKEN");
});

test("an unknown env name exits 1", async () => {
  server.use(list);
  const r = await runCli(["secret", "set", "nope", "TOKEN"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/no environment named nope/);
});

test("--connector sets a connector secret without reading stdin", async () => {
  server.use(
    list,
    putSecret({ name: "GH", kind: "connector", connector: "github" }),
  );
  const r = await runCli(
    ["secret", "set", "env_1", "GH", "--connector=github"],
    {
      stdin: {
        readAll: async () => {
          throw new Error("stdin read");
        },
      },
    },
  );
  expect(r.code).toBe(0);
  expect(puts).toEqual([{ path: "env_1/GH", body: { connector: "github" } }]);
  expect(r.stdout).toBe("set GH (connector)\n");
});

test("on a terminal the value comes from a hidden prompt", async () => {
  server.use(list, putSecret({ name: "TOKEN", kind: "value" }));
  const prompts: string[] = [];
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    stderrIsTTY: true,
    stdin: {
      isTTY: true,
      promptHidden: async (p) => {
        prompts.push(p);
        return value;
      },
    },
  });
  expect(r.code).toBe(0);
  expect(prompts).toEqual(["Value for TOKEN: "]);
  expect(puts[0]?.body).toEqual({ value });
  expect(r.stderr).not.toContain(value);
});

test("a terminal stdin with CI set refuses to prompt", async () => {
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    env: { CI: "true" },
    stderrIsTTY: true,
    stdin: { isTTY: true },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/pipe the value on stdin/);
});

test("an empty value exits 2 without a request", async () => {
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    stdin: { readAll: async () => "\n" },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/empty/);
});

test("the API's rejection exits 1", async () => {
  server.use(
    list,
    http.put(`${apiUrl}/v1/environments/:id/secrets/:name`, () =>
      HttpResponse.json(
        { error: { code: "invalid_name", message: "bad name" } },
        { status: 400 },
      ),
    ),
  );
  const r = await runCli(["secret", "set", "env_1", "1BAD"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("bad name (invalid_name)");
  expect(r.stderr).not.toContain(value);
});

test("--json prints the API object", async () => {
  server.use(list, putSecret({ name: "TOKEN", kind: "value" }));
  const r = await runCli(["secret", "set", "--json", "env_1", "TOKEN"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ name: "TOKEN", kind: "value" });
});

// the API returns name and kind; the extra fields stand in for a server that ever sends more
const listSecrets = http.get(
  `${apiUrl}/v1/environments/:id/secrets`,
  ({ params }) =>
    params.id === "env_1"
      ? HttpResponse.json({
          data: [
            {
              name: "GITHUB_CONNECTOR",
              kind: "connector",
              connector: "conn-github-123",
            },
            { name: "NPM_TOKEN", kind: "value", value },
          ],
        })
      : HttpResponse.json(
          { error: { code: "not_found", message: "no such environment" } },
          { status: 404 },
        ),
);

test("secret list prints names and kinds, never values", async () => {
  server.use(list, listSecrets);
  const r = await runCli(["secret", "list", "web"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("GITHUB_CONNECTOR connector\nNPM_TOKEN value\n");
  expect(r.stdout + r.stderr).not.toContain(value);
  expect(r.stdout + r.stderr).not.toContain("conn-github-123");
});

test("secret list --json carries only name and kind", async () => {
  server.use(list, listSecrets);
  const r = await runCli(["secret", "list", "env_1", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({
    data: [
      { name: "GITHUB_CONNECTOR", kind: "connector" },
      { name: "NPM_TOKEN", kind: "value" },
    ],
  });
  expect(r.stdout + r.stderr).not.toContain(value);
});

test("secret list with none leaves stdout empty", async () => {
  server.use(
    list,
    http.get(`${apiUrl}/v1/environments/:id/secrets`, () =>
      HttpResponse.json({ data: [] }),
    ),
  );
  const r = await runCli(["secret", "list", "env_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    "no secrets on env_1; add one with sky secret set env_1 <NAME>\n",
  );
});

test("secret list --json with none prints the empty list object", async () => {
  server.use(
    list,
    http.get(`${apiUrl}/v1/environments/:id/secrets`, () =>
      HttpResponse.json({ data: [] }),
    ),
  );
  const r = await runCli(["secret", "list", "env_1", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ data: [] });
});

test("secret list of an unknown env exits 1", async () => {
  server.use(list, listSecrets);
  const byName = await runCli(["secret", "list", "nope"]);
  expect(byName.code).toBe(1);
  expect(byName.stderr).toBe("sky: no environment named nope\n");
  const byId = await runCli(["secret", "list", "env_9"]);
  expect(byId.code).toBe(1);
  expect(byId.stderr).toBe("sky: no environment env_9\n");
});

test("secret list of a name shaped like an id resolves it by name", async () => {
  server.use(
    http.get(`${apiUrl}/v1/environments`, () =>
      HttpResponse.json({
        data: [{ ...envRow, id: "env_7", name: "env_1" }],
      }),
    ),
    http.get(`${apiUrl}/v1/environments/env_7/secrets`, () =>
      HttpResponse.json({ data: [{ name: "NPM_TOKEN", kind: "value" }] }),
    ),
  );
  const r = await runCli(["secret", "list", "env_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("NPM_TOKEN value\n");
});

const deleteSecret = http.delete(
  `${apiUrl}/v1/environments/:id/secrets/:name`,
  ({ params }) => {
    secretDeletes.push(`${params.id}/${params.name}`);
    return params.name === "NPM_TOKEN"
      ? new HttpResponse(null, { status: 204 })
      : HttpResponse.json(
          { error: { code: "not_found", message: "no such secret" } },
          { status: 404 },
        );
  },
);

test("secret delete by env name deletes that secret", async () => {
  server.use(list, deleteSecret);
  const r = await runCli(["secret", "delete", "web", "NPM_TOKEN"]);
  expect(r.code).toBe(0);
  expect(secretDeletes).toEqual(["env_1/NPM_TOKEN"]);
  expect(r.stdout).toBe("deleted NPM_TOKEN\n");
});

test("secret delete --json prints an object naming the deleted secret", async () => {
  server.use(list, deleteSecret);
  const r = await runCli(["secret", "delete", "env_1", "NPM_TOKEN", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ name: "NPM_TOKEN", deleted: true });
});

test("secret delete of a missing secret exits 1", async () => {
  server.use(list, deleteSecret);
  const r = await runCli(["secret", "delete", "env_1", "NOPE"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: no such secret (not_found)\n");
});

// deleteSecret records every request, so an empty log proves none was sent
test("secret delete in an unknown env exits 1 without a request", async () => {
  server.use(list, deleteSecret);
  const r = await runCli(["secret", "delete", "nope", "NPM_TOKEN"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: no environment named nope\n");
  expect(secretDeletes).toEqual([]);
});

test("secret list and delete usage errors exit 2 without a request", async () => {
  for (const argv of [
    ["secret", "delete", "env_1"],
    ["secret", "delete", "env_1", "NPM_TOKEN", value],
    ["secret", "list"],
    ["secret", "list", "env_1", "NPM_TOKEN"],
    ["secret", "list", "env_1", "--connector=github"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/Run 'sky --help' for usage/);
    expect(r.stderr).not.toContain(value);
  }
});

test("a value on argv is a usage error", async () => {
  for (const argv of [
    ["secret", "set", "env_1", "TOKEN", value],
    ["secret", "set", "env_1"],
    ["secret", "get", "env_1", "TOKEN"],
    ["secret"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.stderr).not.toContain(value);
  }
});
