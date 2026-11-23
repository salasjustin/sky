import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { connectorOf, takeConnector, withoutConnector } from "./connector.js";

const held = {
  PATH: "/usr/bin",
  GITHUB_CONNECTOR: "conn_secret",
  GITHUB_GATEWAY_URL: "https://gateway.test",
};

test("withoutConnector drops both variables and leaves the rest, without touching its argument", () => {
  const env = { ...held };
  expect(withoutConnector(env)).toEqual({ PATH: "/usr/bin" });
  expect(env).toEqual(held);
});

test("takeConnector removes the variables from the env and returns them, so a child process the runner starts inherits neither", () => {
  const env: NodeJS.ProcessEnv = { ...held };
  expect(takeConnector(env)).toEqual({
    GITHUB_CONNECTOR: "conn_secret",
    GITHUB_GATEWAY_URL: "https://gateway.test",
  });
  expect(env).toEqual({ PATH: "/usr/bin" });
});

test("after takeConnector on the process's own env, a child process sees no connector", () => {
  const before = { ...process.env };
  process.env.GITHUB_CONNECTOR = "conn_secret";
  process.env.GITHUB_GATEWAY_URL = "https://gateway.test";
  try {
    takeConnector(process.env);
    const seen = execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('GITHUB_'))))",
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(seen)).toEqual([]);
  } finally {
    process.env = before;
  }
});

test("connectorOf picks only the connector variables, for the runner's own subcommand", () => {
  expect(connectorOf(held)).toEqual({
    GITHUB_CONNECTOR: "conn_secret",
    GITHUB_GATEWAY_URL: "https://gateway.test",
  });
  expect(connectorOf({ PATH: "/usr/bin" })).toEqual({});
});
