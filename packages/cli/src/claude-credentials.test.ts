import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const data = [
  {
    name: "default",
    kind: "subscription",
    environments: [{ id: "env_1", name: "web" }],
    limitedUntil: null,
    runsToday: 4,
    usage: {
      fiveHour: { utilization: 0.42, resetsAt: "2026-11-12T13:00:00.000Z" },
      sevenDay: { utilization: 0.1, resetsAt: null },
      probedAt: "2026-11-12T08:00:00.000Z",
    },
    poolEnvironments: [{ id: "env_4", name: "pooled" }],
  },
  {
    name: "personal",
    kind: "subscription",
    environments: [
      { id: "env_2", name: "api" },
      { id: "env_3", name: "docs" },
    ],
    limitedUntil: "2026-11-12T10:20:00.000Z",
    runsToday: 2,
    usage: null,
    poolEnvironments: [],
  },
  {
    name: "api-key",
    kind: "api-key",
    environments: [],
    limitedUntil: null,
    runsToday: 1,
    usage: null,
    poolEnvironments: [],
  },
];

const listed = http.get(`${apiUrl}/v1/claude-credentials`, () =>
  HttpResponse.json({ data }),
);

test("claude-credentials prints name, kind, limit, runs today and env ids per credential", async () => {
  server.use(listed);
  const r = await runCli(["claude-credentials"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    [
      "default subscription - 4 env_1 5h=42% 7d=10% env_4",
      "personal subscription limited-until=2026-11-12T10:20:00.000Z 2 env_2,env_3 - - -",
      "api-key api-key - 1 - - - -",
      "",
    ].join("\n"),
  );
});

test("--json passes the list through", async () => {
  server.use(listed);
  const r = await runCli(["claude-credentials", "--json"]);
  expect(JSON.parse(r.stdout)).toEqual({ data });
});

test("a runs key's 403 is the CLI's failure", async () => {
  server.use(
    http.get(`${apiUrl}/v1/claude-credentials`, () =>
      HttpResponse.json(
        {
          error: {
            code: "forbidden",
            message: "only the admin key can do this",
          },
        },
        { status: 403 },
      ),
    ),
  );
  const r = await runCli(["claude-credentials"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("only the admin key");
});

test("an argument is a usage error", async () => {
  expect((await runCli(["claude-credentials", "extra"])).code).toBe(2);
});

test("a value in the API's answer never reaches the output: only the fields the CLI knows are read", async () => {
  server.use(
    http.get(`${apiUrl}/v1/claude-credentials`, () =>
      HttpResponse.json({
        data: [{ ...data[0], token: "sk-ant-oat01-should-never-print" }],
      }),
    ),
  );
  const r = await runCli(["claude-credentials"]);
  expect(r.stdout).not.toContain("should-never-print");
});
