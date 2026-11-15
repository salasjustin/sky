import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readTarball } from "./tarball.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-tarball-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "a",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "a",
      GIT_COMMITTER_EMAIL: "a@example.com",
    },
    maxBuffer: 64 * 1024 * 1024,
  });

test("a tarball reads as its files by path, without the top directory: long and non-ASCII paths, a symlink's target, empty files", () => {
  git("init", "-q", "-b", "main");
  const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}/file.txt`;
  mkdirSync(join(root, long, ".."), { recursive: true });
  writeFileSync(join(root, long), "long\n");
  writeFileSync(join(root, "naïve é.txt"), "unicode\n");
  writeFileSync(join(root, "empty"), "");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(1_300, 7));
  symlinkSync("naïve é.txt", join(root, "link"));
  git("add", "--all");
  git("commit", "-qm", "all");

  const files = readTarball(
    gzipSync(
      git("archive", "--format=tar", "--prefix=acme-repo-abc1234/", "HEAD"),
    ),
  );

  expect([...files.keys()].sort()).toEqual(
    ["big.bin", "empty", long, "link", "naïve é.txt"].sort(),
  );
  expect(files.get(long)?.toString()).toBe("long\n");
  expect(files.get("naïve é.txt")?.toString()).toBe("unicode\n");
  expect(files.get("empty")?.length).toBe(0);
  expect(files.get("big.bin")).toEqual(Buffer.alloc(1_300, 7));
  expect(files.get("link")?.toString()).toBe("naïve é.txt");
});
