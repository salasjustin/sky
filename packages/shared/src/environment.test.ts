import { expect, test } from "vitest";
import { Environment } from "./environment.js";

const env = {
  id: "env_1",
  name: "kru",
  repo: "ap-justin/kru",
  setup: "pnpm install",
  status: "ready",
  spriteName: "sky-kru",
  checkpointId: "cp_abc",
};

test("accepts an environment and defaults its cap and approval policy", () => {
  expect(Environment.parse(env)).toEqual({
    ...env,
    base: null,
    concurrency: 3,
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    claudeCredential: null,
    claudePool: null,
    claudeFallback: "api-key",
  });
});

test("keeps an explicit cap and approval policy", () => {
  const parsed = Environment.parse({
    ...env,
    concurrency: 5,
    approvalPolicy: ["Bash", "mcp__github__*"],
  });
  expect(parsed.concurrency).toBe(5);
  expect(parsed.approvalPolicy).toEqual(["Bash", "mcp__github__*"]);
});

test("defaulted approval policies are not one shared array", () => {
  const a = Environment.parse(env);
  a.approvalPolicy.push("Bash");
  expect(Environment.parse(env).approvalPolicy).toEqual([]);
});

test("rejects a malformed repo, a zero cap and an unknown status", () => {
  expect(
    Environment.safeParse({ ...env, repo: "https://github.com/a/b; rm -rf /" })
      .success,
  ).toBe(false);
  expect(Environment.safeParse({ ...env, concurrency: 0 }).success).toBe(false);
  expect(Environment.safeParse({ ...env, status: "booting" }).success).toBe(
    false,
  );
});

test("a provisioning environment has no checkpoint yet", () => {
  expect(
    Environment.parse({ ...env, status: "provisioning", checkpointId: null })
      .checkpointId,
  ).toBeNull();
});

test("autoApprove can add to the defaults, replace them or turn them off", () => {
  const parse = (autoApprove: unknown) =>
    Environment.parse({ ...env, autoApprove }).autoApprove;
  expect(parse({})).toEqual({ defaults: true, commands: [] });
  expect(parse({ commands: ["make check"] })).toEqual({
    defaults: true,
    commands: ["make check"],
  });
  expect(parse({ defaults: false, commands: ["make check"] })).toEqual({
    defaults: false,
    commands: ["make check"],
  });
  expect(parse({ defaults: false })).toEqual({ defaults: false, commands: [] });
});

test.each([
  { commands: ["ls; rm x"] },
  { commands: ["cat $(id)"] },
  { commands: ["FOO=1 ls"] },
  { commands: [""] },
  { commands: "ls" },
  { defaults: "no" },
  { extra: true },
])("rejects autoApprove %j", (autoApprove) => {
  expect(Environment.safeParse({ ...env, autoApprove }).success).toBe(false);
});

test.each([
  ["./scripts/check.sh", /program name, not a path/],
  ["-v", /program name, not an option/],
  ["'git log'", /one quoted word/],
  ["pnpm --filter api test", /pnpm workspace options/],
  ["pnpm test --fix", /pnpm workspace options|refused/],
  ["git -c", /`-c` is refused/],
  ["grep --rec", /`--rec` is refused/],
  ["find . -delete", /`-delete` is refused/],
  ["git branch -d", /`-d` is refused/],
  ["sed -i", /`-i` is refused/],
  ["node script.js", /`script.js` is refused/],
])(
  "rejects the never-matching command entry %j with a reason",
  (entry, message) => {
    const result = Environment.safeParse({
      ...env,
      autoApprove: { commands: [entry] },
    });
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(message),
    ]);
  },
);

test("accepts entries a longer command can still complete", () => {
  const commands = [
    "sed -n",
    "git branch feature",
    "node",
    "make check",
    "git tag --list",
  ];
  expect(
    Environment.parse({ ...env, autoApprove: { commands } }).autoApprove
      .commands,
  ).toEqual(commands);
});

test("caps the number and length of command entries", () => {
  const parse = (commands: string[]) =>
    Environment.safeParse({ ...env, autoApprove: { commands } }).success;
  expect(parse(Array.from({ length: 64 }, (_, i) => `make t${i}`))).toBe(true);
  expect(parse(Array.from({ length: 65 }, (_, i) => `make t${i}`))).toBe(false);
  expect(parse([`make ${"x".repeat(195)}`])).toBe(true);
  expect(parse([`make ${"x".repeat(196)}`])).toBe(false);
});
