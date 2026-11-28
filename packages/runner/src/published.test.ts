import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  PUBLISHED_DIR,
  publishedFileName,
  readPublished,
  recordPublished,
} from "./published.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-published-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const head = "a".repeat(40);

test("a record is two lines, the head then the branch, under the clone's git dir where every worktree finds it", async () => {
  writeFileSync(join(repo, "f"), "x");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "m");
  const tree = join(root, "tree");
  git(repo, "worktree", "add", "-q", tree, "-b", "claude/agt_1");
  await recordPublished(tree, "claude/agt_1", { head, branch: "feature/x" });
  expect(
    readFileSync(join(repo, ".git", PUBLISHED_DIR, "claude%2Fagt_1"), "utf8"),
  ).toBe(`${head}\nfeature/x\n`);
  expect(await readPublished(repo, "claude/agt_1")).toEqual({
    head,
    branch: "feature/x",
  });
  expect(await readPublished(tree, "claude/agt_1")).toEqual({
    head,
    branch: "feature/x",
  });
  expect(await readPublished(tree, "claude/agt_2")).toBeUndefined();
});

test("a newer publish replaces the record", async () => {
  await recordPublished(repo, "claude/agt_1", { head, branch: "one" });
  await recordPublished(repo, "claude/agt_1", {
    head: "b".repeat(40),
    branch: "two",
  });
  expect(await readPublished(repo, "claude/agt_1")).toEqual({
    head: "b".repeat(40),
    branch: "two",
  });
});

test("the file name escapes % and /, as the API's check does", () => {
  expect(publishedFileName("claude/agt_1")).toBe("claude%2Fagt_1");
  expect(publishedFileName("a%2Fb/c")).toBe("a%252Fb%2Fc");
});

test("a file that isn't a record reads as none", async () => {
  await recordPublished(repo, "claude/agt_1", { head, branch: "one" });
  writeFileSync(join(repo, ".git", PUBLISHED_DIR, "claude%2Fagt_1"), "junk\n");
  expect(await readPublished(repo, "claude/agt_1")).toBeUndefined();
});
