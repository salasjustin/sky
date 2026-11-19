import {
  chmodSync,
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
import { trustProjects } from "./trust.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-trust-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = () => join(home, ".claude.json");
const read = () => JSON.parse(readFileSync(file(), "utf8"));

test("merges into the file, keeping every other key and the file's mode, and is a no-op the second time", () => {
  writeFileSync(
    file(),
    JSON.stringify({
      oauthAccount: { id: 1 },
      projects: { "/workspace/repo": { allowedTools: ["x"] }, "/other": {} },
    }),
  );
  chmodSync(file(), 0o640);
  expect(trustProjects(home, ["/workspace/repo", "/workspace/wt/a"])).toBe(
    true,
  );
  expect(read()).toEqual({
    oauthAccount: { id: 1 },
    projects: {
      "/workspace/repo": { allowedTools: ["x"], hasTrustDialogAccepted: true },
      "/workspace/wt/a": { hasTrustDialogAccepted: true },
      "/other": {},
    },
  });
  expect(statSync(file()).mode & 0o777).toBe(0o640);
  const once = readFileSync(file(), "utf8");
  // a rewrite renames a new file over it, so the inode changes even within one mtime tick
  const inode = statSync(file()).ino;
  expect(trustProjects(home, ["/workspace/repo", "/workspace/wt/a"])).toBe(
    false,
  );
  expect(readFileSync(file(), "utf8")).toBe(once);
  expect(statSync(file()).ino).toBe(inode);
  expect(readdirSync(home)).toEqual([".claude.json"]);
});

test("creates the file, and the home, when missing", () => {
  const nested = join(home, "new-home");
  expect(trustProjects(nested, ["/workspace/repo"])).toBe(true);
  expect(
    JSON.parse(readFileSync(join(nested, ".claude.json"), "utf8")),
  ).toEqual({
    projects: { "/workspace/repo": { hasTrustDialogAccepted: true } },
  });
  mkdirSync(join(nested, "x"));
});

test("throws on a file that isn't JSON, leaving it as it was", () => {
  writeFileSync(file(), "{ half");
  expect(() => trustProjects(home, ["/r"])).toThrow();
  expect(readFileSync(file(), "utf8")).toBe("{ half");
});
