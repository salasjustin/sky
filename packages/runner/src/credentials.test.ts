import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { removeSkyLogin } from "./credentials.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-cred-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The entry a runner stored for a nested `claude`: no refresh token, no expiry. */
const sky = {
  accessToken: "oauth-secret-token",
  refreshToken: null,
  expiresAt: null,
  scopes: ["user:inference"],
};
const person = {
  accessToken: "person-access",
  refreshToken: "person-refresh",
  expiresAt: 1_900_000_000_000,
  scopes: ["user:inference", "user:profile"],
};
const design = {
  accessToken: "design-access",
  refreshToken: "design-refresh",
};

/** Seeds `<dir>/.credentials.json` and returns its path. */
function seed(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

test("removes the login an earlier runner stored and keeps the other entries, private to the user", async () => {
  const path = seed(
    join(home, ".claude"),
    JSON.stringify({ claudeAiOauth: sky, designOauth: design }),
  );
  await expect(removeSkyLogin({}, home)).resolves.toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    designOauth: design,
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(home, ".claude"))).toEqual([".credentials.json"]);
});

test("removes the file when that login was all it held", async () => {
  const path = seed(
    join(home, ".claude"),
    JSON.stringify({ claudeAiOauth: sky }),
  );
  await expect(removeSkyLogin({}, home)).resolves.toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(join(home, ".claude"))).toEqual([]);
});

test.each([
  ["a person's interactive login", person],
  ["a login with a refresh token", { ...sky, refreshToken: "r" }],
  ["a login with an expiry", { ...sky, expiresAt: 1 }],
  ["a login with neither field", { accessToken: "a" }],
])("keeps %s, and the file as it was", async (_, login) => {
  const content = JSON.stringify({ claudeAiOauth: login, designOauth: design });
  const path = seed(join(home, ".claude"), content);
  await expect(removeSkyLogin({}, home)).resolves.toBe(false);
  expect(readFileSync(path, "utf8")).toBe(content);
});

test("honors CLAUDE_CONFIG_DIR and leaves ~/.claude alone", async () => {
  const dir = join(home, "cfg");
  const content = JSON.stringify({ claudeAiOauth: sky });
  const path = seed(dir, JSON.stringify({ claudeAiOauth: sky, x: 1 }));
  const other = seed(join(home, ".claude"), content);
  const removed = await removeSkyLogin({ CLAUDE_CONFIG_DIR: dir }, home);
  expect(removed).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 1 });
  expect(readFileSync(other, "utf8")).toBe(content);
});

test("a missing file is nothing to do, and creates nothing", async () => {
  await expect(removeSkyLogin({}, home)).resolves.toBe(false);
  expect(readdirSync(home)).toEqual([]);
});

test.each([
  ["not JSON", "not json"],
  ["an array", "[1,2]"],
  ["a string", '"abc"'],
  ["null", "null"],
])("leaves a file that is %s as it was", async (_, content) => {
  const path = seed(join(home, ".claude"), content);
  await expect(removeSkyLogin({}, home)).resolves.toBe(false);
  expect(readFileSync(path, "utf8")).toBe(content);
});

test("refuses a credential path it cannot read, leaving it in place", async () => {
  const path = join(home, ".claude", ".credentials.json");
  mkdirSync(path, { recursive: true });
  await expect(removeSkyLogin({}, home)).rejects.toThrow(/EISDIR/);
  expect(statSync(path).isDirectory()).toBe(true);
});
