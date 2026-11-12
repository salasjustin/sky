import { expect, test } from "vitest";
import { parseSpec, specHash } from "./spec.js";

test("parses a spec and fills the schema defaults", () => {
  const result = parseSpec(
    "name: web\nrepo: acme/web\nsetup: |\n  pnpm install\n",
    "env.yaml",
  );
  expect(result).toEqual({
    ok: true,
    spec: {
      name: "web",
      repo: "acme/web",
      setup: "pnpm install\n",
      base: null,
      concurrency: 3,
      approvalPolicy: [],
      autoApprove: { defaults: true, commands: [] },
      claudeCredential: null,
      claudeFallback: "api-key",
    },
  });
});

test("names the bad field and its line", () => {
  const result = parseSpec(
    "name: web\nrepo: not a repo\nsetup: x\n",
    "env.yaml",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toEqual([
    "env.yaml:2: repo: expected a GitHub repo as owner/name",
  ]);
});

test("names the line of an unknown key", () => {
  const result = parseSpec(
    "name: web\nrepo: acme/web\nsetup: x\napiKey: sk-123\n",
    "env.yaml",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatch(/^env\.yaml:4: apiKey: /);
});

test("names the line of a bad array item", () => {
  const result = parseSpec(
    "name: web\nrepo: acme/web\nsetup: x\napprovalPolicy:\n  - Bash\n  - ''\n",
    "env.yaml",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors[0]).toMatch(/^env\.yaml:6: approvalPolicy\.1: /);
});

test("a missing field has no line to point at", () => {
  const result = parseSpec("name: web\nrepo: acme/web\n", "env.yaml");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toEqual([expect.stringMatching(/^env\.yaml: setup: /)]);
});

test("a YAML syntax error carries its line and column", () => {
  const result = parseSpec("name: web\nrepo: [acme\n", "env.yaml");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors[0]).toMatch(/^env\.yaml:\d+:\d+: /);
});

test("a document that isn't a mapping is rejected", () => {
  const result = parseSpec("- a\n- b\n", "env.yaml");
  expect(result.ok).toBe(false);
});

test("the hash ignores key order and formatting", () => {
  const a = parseSpec("name: web\nrepo: acme/web\nsetup: x\n", "e");
  const b = parseSpec(
    "setup: x\nconcurrency: 3\nrepo: acme/web\nname: web\n",
    "e",
  );
  if (!a.ok || !b.ok) throw new Error("fixture invalid");
  expect(specHash(a.spec)).toBe(specHash(b.spec));
  expect(specHash(a.spec)).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("reads autoApprove overrides and names the line of a bad command", () => {
  const base = "name: web\nrepo: acme/web\nsetup: x\n";
  const ok = parseSpec(
    `${base}autoApprove:\n  defaults: false\n  commands:\n    - make check\n`,
    "env.yaml",
  );
  expect(ok).toMatchObject({
    ok: true,
    spec: { autoApprove: { defaults: false, commands: ["make check"] } },
  });
  const bad = parseSpec(
    `${base}autoApprove:\n  commands:\n    - "ls; rm x"\n`,
    "env.yaml",
  );
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.errors[0]).toMatch(/^env\.yaml:6: autoApprove\.commands\.0: /);
});

test("reads a base profile's name, and refuses a name the API would", () => {
  expect(
    parseSpec("name: web\nrepo: acme/web\nsetup: x\nbase: acme\n", "env.yaml"),
  ).toMatchObject({ ok: true, spec: { base: "acme" } });
  const bad = parseSpec(
    "name: web\nrepo: acme/web\nsetup: x\nbase: not a name\n",
    "env.yaml",
  );
  expect(bad).toMatchObject({ ok: false });
  expect(bad.ok ? [] : bad.errors[0]).toContain("env.yaml:4: base:");
});

test("a spec's hash changes with its base", () => {
  const base = {
    name: "web",
    repo: "acme/web",
    setup: "x",
    concurrency: 3,
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    claudeCredential: null,
    claudeFallback: "api-key" as const,
  };
  expect(specHash({ ...base, base: null })).not.toBe(
    specHash({ ...base, base: "acme" }),
  );
});
