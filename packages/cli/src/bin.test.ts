import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// the built binary in a child process: exit codes, streams and real stdin, which an in-process run can't show
const pkg = join(import.meta.dirname, "..");
const bin = join(pkg, "dist", "bundle", "sky.mjs");

const provisioningEnv = {
  id: "env_slow",
  name: "web",
  repo: "acme/web",
  setup: "pnpm install",
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
  status: "provisioning",
  spriteName: "sky-env-slow",
  checkpointId: null,
  failure: null,
  createdAt: "2026-10-30T00:00:00.000Z",
};

let api: Server;
let apiUrl: string;
const received: { url: string; body: string }[] = [];

beforeAll(async () => {
  execFileSync("pnpm", ["run", "--silent", "build"], {
    cwd: pkg,
    stdio: "ignore",
  });
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      received.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      const answers: Record<string, unknown> = {
        "/v1/environments": {
          data: [{ ...provisioningEnv, id: "env_1", status: "ready" }],
        },
        "/v1/environments/env_slow": provisioningEnv,
      };
      res.end(
        JSON.stringify(
          answers[req.url ?? ""] ?? { name: "TOKEN", kind: "value" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => new Promise<void>((resolve) => api.close(() => resolve())));

function sky(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        // a fresh HOME so no real config file is read
        env: {
          PATH: process.env.PATH ?? "",
          HOME: mkdtempSync(join(tmpdir(), "sky-bin-")),
          ...opts.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.stdin.end(opts.stdin ?? "");
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

test("--help goes to stdout and exits 0", async () => {
  const r = await sky(["--help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/^Usage:/);
  expect(r.stderr).toBe("");
});

test("a usage error exits 2 with nothing on stdout", async () => {
  const r = await sky(["apply"]);
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/Run 'sky --help' for usage/);
});

test("no configuration exits 2", async () => {
  const r = await sky(["secret", "set", "env_1", "TOKEN"], { stdin: "v" });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/no API URL/);
});

test("an unreachable API exits 1", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise((resolve) => closed.close(resolve));
  const r = await sky(["secret", "set", "env_1", "TOKEN"], {
    env: { SKY_URL: url, SKY_API_KEY: "k" },
    stdin: "v",
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(`sky: cannot reach ${url}: ECONNREFUSED\n`);
});

test("a piped secret reaches the API and neither output stream", async () => {
  const value = "piped-secret-value-xyz";
  const r = await sky(["secret", "set", "env_1", "TOKEN"], {
    env: { SKY_URL: apiUrl, SKY_API_KEY: "test-key" },
    stdin: `${value}\n`,
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("set TOKEN (value)\n");
  expect(r.stdout + r.stderr).not.toContain(value);
  expect(r.stdout + r.stderr).not.toContain("test-key");
  expect(received.at(-1)).toEqual({
    url: "/v1/environments/env_1/secrets/TOKEN",
    body: JSON.stringify({ value }),
  });
});

test("Ctrl-C while waiting says the env keeps provisioning, then dies by SIGINT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sky-bin-apply-"));
  const file = join(dir, "env.yaml");
  writeFileSync(file, "name: web\nrepo: acme/web\nsetup: pnpm install\n");
  writeFileSync(
    join(dir, "sky-lock.json"),
    JSON.stringify({ envId: "env_slow" }),
  );
  const child = spawn(process.execPath, [bin, "apply", file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      SKY_URL: apiUrl,
      SKY_API_KEY: "k",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
    if (stderr.includes("provisioning web (env_slow)")) child.kill("SIGINT");
  });
  const [code, signal] = await new Promise<[number | null, string | null]>(
    (resolve) => child.on("close", (c, s) => resolve([c, s])),
  );
  expect({ code, signal }).toEqual({ code: null, signal: "SIGINT" });
  expect(stdout).toBe("");
  expect(stderr).toContain(
    "sky: interrupted; web (env_slow) keeps provisioning on the server. Re-run sky apply to pick it up\n",
  );
});
