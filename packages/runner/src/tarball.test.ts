import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test } from "vitest";
import { walkTarball } from "./tarball.js";

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

/** The archive in chunks of `size` bytes, as a download delivers it. */
async function* chunked(archive: Buffer, size = 1000): AsyncGenerator<Buffer> {
  for (let at = 0; at < archive.length; at += size) {
    yield archive.subarray(at, at + size);
  }
}

/** Every file of the archive the walk is asked for, by path. */
async function filesOf(
  archive: AsyncIterable<Buffer>,
  wants: (path: string) => boolean = () => true,
) {
  const files = new Map<string, Buffer>();
  await walkTarball(archive, {
    wants,
    file: async (path, bytes) => {
      files.set(path, Buffer.from(bytes));
    },
  });
  return files;
}

test("a tarball walks as its files by path, without the top directory: long and non-ASCII paths, a symlink's target, empty files, chunks that split headers", async () => {
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
  const archive = gzipSync(
    git("archive", "--format=tar", "--prefix=acme-repo-abc1234/", "HEAD"),
  );

  for (const size of [1, 700, archive.length]) {
    const files = await filesOf(chunked(archive, size));
    expect([...files.keys()].sort()).toEqual(
      ["big.bin", "empty", long, "link", "naïve é.txt"].sort(),
    );
    expect(files.get(long)?.toString()).toBe("long\n");
    expect(files.get("naïve é.txt")?.toString()).toBe("unicode\n");
    expect(files.get("empty")?.length).toBe(0);
    expect(files.get("big.bin")).toEqual(Buffer.alloc(1_300, 7));
    expect(files.get("link")?.toString()).toBe("naïve é.txt");
  }
});

test("a file the walk doesn't want is never handed over, and the ones after it still are", async () => {
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), Buffer.alloc(3_000, 1));
  writeFileSync(join(root, "c.txt"), "c\n");
  git("add", "--all");
  git("commit", "-qm", "all");
  const archive = gzipSync(
    git("archive", "--format=tar", "--prefix=x/", "HEAD"),
  );

  const files = await filesOf(chunked(archive), (path) => path !== "b.txt");

  expect([...files.keys()].sort()).toEqual(["a.txt", "c.txt"]);
});

test("an archive that is cut short, or isn't gzip, fails the walk", async () => {
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), Buffer.alloc(5_000, 2));
  git("add", "--all");
  git("commit", "-qm", "all");
  const tar = git("archive", "--format=tar", "--prefix=x/", "HEAD");

  const cut = gzipSync(tar.subarray(0, 2_000));
  await expect(filesOf(chunked(cut))).rejects.toThrow();
  await expect(
    filesOf(chunked(Buffer.from("not an archive"))),
  ).rejects.toThrow();
});

const MIB = 1024 * 1024;

const octal = (n: number, width: number) =>
  `${n.toString(8).padStart(width - 1, "0")}\0`;

/** A tar entry's header block: name, mode, size, type (`0`, a file, unless given) and the ustar magic. */
const tarHeader = (name: string, size: number, type = "0") => {
  const block = Buffer.alloc(512);
  block.write(name, 0);
  block.write(octal(0o644, 8), 100);
  block.write(octal(size, 12), 124);
  block.write(type, 156);
  block.write("ustar\0" + "00", 257);
  return block;
};

test.each([
  // git writes a symlink with size 0; a header claiming a body that never comes is a cut archive
  { kind: "a symlink", header: tarHeader("top/link", 1_024, "2") },
  // past the cap the walk drops the body rather than hold it, and still has to see all of it
  {
    kind: "a file past the size cap",
    header: tarHeader("top/huge.bin", 300 * MIB),
  },
])(
  "an archive cut inside $kind fails the walk, and nothing of that entry is handed over",
  async ({ header }) => {
    const cut = gzipSync(Buffer.concat([header, Buffer.alloc(100, 1)]));
    const handed: string[] = [];

    await expect(
      walkTarball(chunked(cut), {
        wants: () => true,
        file: async (path) => {
          handed.push(path);
        },
      }),
    ).rejects.toThrow("the archive ends inside an entry");
    expect(handed).toEqual([]);
  },
);

test("a file spanning many chunks is handed over in a buffer of its own, and the entry after it shares none of that memory", async () => {
  // the large file's body ends inside a decompressed chunk, so bytes of the next entry arrive with it
  const large = Buffer.alloc(100_000, 7);
  const padded = Math.ceil(large.length / 512) * 512;
  const tar = Buffer.concat([
    tarHeader("top/large.bin", large.length),
    large,
    Buffer.alloc(padded - large.length),
    tarHeader("top/small.txt", 2),
    Buffer.from("s\n"),
    Buffer.alloc(510),
    Buffer.alloc(1024),
  ]);
  const archive = gzipSync(tar);
  const memory = new Map<string, ArrayBufferLike>();

  await walkTarball(chunked(archive, archive.length), {
    wants: () => true,
    file: async (path, bytes) => {
      memory.set(path, bytes.buffer);
    },
  });

  // held once at its padded size, not copied into a buffer that also carries what came after it
  expect(memory.get("large.bin")?.byteLength).toBeLessThanOrEqual(padded);
  // what the walk kept past the large file is not a view that pins the large file's buffer
  expect(memory.get("small.txt")).toBeDefined();
  expect(memory.get("small.txt")).not.toBe(memory.get("large.bin"));
});

test("a large archive is read as it downloads: each file is handed over while the rest is still to come, and what is held ahead stays small", async () => {
  const FILES = 64;
  const ids = new Map<string, string>();
  // a tar of FILES one-MiB random files, made one file at a time, never whole
  async function* tar(): AsyncGenerator<Buffer> {
    for (let i = 0; i < FILES; i++) {
      const bytes = randomBytes(MIB);
      ids.set(
        `src/file-${i}.bin`,
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex"),
      );
      yield tarHeader(`top/src/file-${i}.bin`, bytes.length);
      yield bytes;
    }
    yield Buffer.alloc(1024);
  }
  let delivered = 0;
  const gzipped = Readable.from(tar()).pipe(createGzip());
  async function* download(): AsyncGenerator<Buffer> {
    for await (const chunk of gzipped) {
      delivered += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
  }

  let handed = 0;
  let firstAt = -1;
  let mostAhead = 0;
  await walkTarball(download(), {
    wants: () => true,
    file: async (path, bytes) => {
      expect(
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex"),
      ).toBe(ids.get(path));
      handed++;
      if (firstAt < 0) firstAt = delivered;
      // random bytes don't compress, so what was delivered beyond the files handed over so far is
      // what the walk and the pipes ahead of it are holding
      mostAhead = Math.max(mostAhead, delivered - handed * MIB);
    },
  });

  expect(handed).toBe(FILES);
  // the first file arrived with a small share of the archive delivered, not after all of it
  expect(firstAt).toBeLessThan((FILES * MIB) / 8);
  // nothing ran more than a few files' worth ahead of the one being handled
  expect(mostAhead).toBeLessThan(4 * MIB);
});
