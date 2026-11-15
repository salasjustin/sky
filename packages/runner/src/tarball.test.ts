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
  await expect(filesOf(chunked(cut))).rejects.toThrow(
    "the archive ends inside an entry",
  );
  await expect(
    filesOf(chunked(Buffer.from("not an archive"))),
  ).rejects.toThrow("incorrect header check");
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
  // 16 MiB is already 8 times the first-file bound below, so a walker that reads the whole archive first still fails it
  const FILES = 16;
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
  // level 1: random bytes don't compress at any level, so only the time spent trying differs
  const gzipped = Readable.from(tar()).pipe(createGzip({ level: 1 }));
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

const BLOCK = 512;
const END = Buffer.alloc(2 * BLOCK);

/** Lets the event loop go round `count` times, so what is already queued has run. */
const turns = async (count = 5) => {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** A whole entry: its header, then `body` padded to a block. Names stay under 100 bytes. */
const entry = (name: string, body: Buffer | string = "", type = "0") => {
  const bytes = Buffer.from(body);
  const pad = Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK);
  return Buffer.concat([tarHeader(name, bytes.length, type), bytes, pad]);
};

/** A symlink entry; git stores its target in the link field of the header, with a size of 0. */
const symlinkEntry = (name: string, target: string) => {
  const header = tarHeader(name, 0, "2");
  header.write(target, 157);
  return header;
};

/** One pax record, `<length> key=value\n`, where the length counts its own digits. */
const paxRecord = (key: string, value: string) => {
  const rest = Buffer.from(` ${key}=${value}\n`);
  let length = rest.length;
  while (String(length).length + rest.length !== length) {
    length = String(length).length + rest.length;
  }
  return Buffer.concat([Buffer.from(String(length)), rest]);
};

/** The entries as a gzipped tar with its end marker. */
const tarOf = (...entries: Buffer[]) =>
  gzipSync(Buffer.concat([...entries, END]));

/**
 * `tar` gzipped up to a flush point and no further, as a download cut off after those bytes:
 * everything before the cut inflates, and the stream then ends with no gzip trailer.
 */
const gzipCut = (tar: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    const gz = createGzip();
    const parts: Buffer[] = [];
    gz.on("data", (part: Buffer) => parts.push(part));
    gz.on("error", reject);
    gz.write(tar);
    gz.flush(() => {
      gz.destroy();
      resolve(Buffer.concat(parts));
    });
  });

const textsOf = (files: Map<string, Buffer>) =>
  Object.fromEntries(
    [...files].map(([path, bytes]) => [path, bytes.toString()]),
  );

test("a pax header names the entry after it, by path and by link target, and no other", async () => {
  const longName = "n".repeat(130);
  const longTarget = `${"t".repeat(130)}/target`;
  const archive = tarOf(
    entry("top/PaxHeaders/0", paxRecord("path", `top/${longName}`), "x"),
    entry("top/short", "pax body\n"),
    entry(
      "top/PaxHeaders/1",
      Buffer.concat([
        paxRecord("path", "top/lnk"),
        paxRecord("linkpath", longTarget),
      ]),
      "x",
    ),
    symlinkEntry("top/placeholder", "short-target"),
    entry("top/plain.txt", "plain\n"),
  );

  const files = await filesOf(chunked(archive, 300));

  expect(textsOf(files)).toEqual({
    [longName]: "pax body\n",
    lnk: longTarget,
    "plain.txt": "plain\n",
  });
});

test("GNU long-name and long-link headers name the entry after them, and no other", async () => {
  const longName = "g".repeat(130);
  const longTarget = `${"k".repeat(130)}/target`;
  const archive = tarOf(
    entry("top/././@LongLink", `top/${longName}\0`, "L"),
    entry("top/short", "gnu body\n"),
    entry("top/././@LongLink", `${longTarget}\0`, "K"),
    symlinkEntry("top/lnk", "short-target"),
    entry("top/plain.txt", "plain\n"),
  );

  const files = await filesOf(chunked(archive, 300));

  expect(textsOf(files)).toEqual({
    [longName]: "gnu body\n",
    lnk: longTarget,
    "plain.txt": "plain\n",
  });
});

// a download cut at a flush point loses its gzip trailer, so the inflater, not the walker, is what
// finds the end: it reports the same for a cut anywhere, and the entries before the cut still arrive
const AT_B = BLOCK + 5_120;
test.each([
  {
    cut: "a header",
    at: AT_B + 100,
    wants: () => true,
    handed: ["a.txt"],
  },
  {
    cut: "the body of a file it wants",
    at: BLOCK + 1_000,
    wants: () => true,
    handed: [],
  },
  {
    cut: "the body of a file it skips",
    at: AT_B + BLOCK + 1_000,
    wants: (path: string) => path !== "b.txt",
    handed: ["a.txt"],
  },
])(
  "gzip bytes cut inside $cut fail the walk saying the stream ended, and nothing of the cut entry is handed over",
  async ({ at, wants, handed }) => {
    const tar = Buffer.concat([
      entry("top/a.txt", Buffer.alloc(5_000, 2)),
      entry("top/b.txt", Buffer.alloc(5_000, 3)),
      END,
    ]);
    const cut = await gzipCut(tar.subarray(0, at));
    const seen: string[] = [];

    await expect(
      walkTarball(chunked(cut), {
        wants,
        file: async (path) => {
          seen.push(path);
        },
      }),
    ).rejects.toThrow("unexpected end of file");
    expect(seen).toEqual(handed);
  },
);

test("an entry whose size can't be read fails the walk", async () => {
  const header = tarHeader("top/a.txt", 0);
  header.write("zzzzzzz\0", 124);

  await expect(filesOf(chunked(tarOf(header)))).rejects.toThrow(
    "the archive has an entry header that can't be read",
  );
});

test.each(["x", "g", "L", "K"])(
  "a %s header claiming a body past 1 MiB fails the walk without reading it",
  async (type) => {
    const archive = tarOf(tarHeader("top/header", 2 * MIB, type));

    await expect(filesOf(chunked(archive))).rejects.toThrow(
      "the archive has an entry header that is too large",
    );
  },
);

test("entries named with .. or an absolute path are never handed over, and a normalised twin doesn't replace the real file", async () => {
  const allowed = new Set(["README.md", "docs/a.txt"]);
  const archive = tarOf(
    entry("x/README.md", "real\n"),
    entry("x/../../evil", "evil\n"),
    entry("x/a/../README.md", "evil\n"),
    entry("/etc/evil", "evil\n"),
    entry("x/docs/a.txt", "doc\n"),
  );
  const handed: [string, string][] = [];

  await walkTarball(chunked(archive), {
    wants: (path) => allowed.has(path),
    file: async (path, bytes) => {
      handed.push([path, bytes.toString()]);
    },
  });

  expect(handed).toEqual([
    ["README.md", "real\n"],
    ["docs/a.txt", "doc\n"],
  ]);
});

test("the walk stops at the end marker, and an entry after it is never read", async () => {
  const archive = gzipSync(
    Buffer.concat([
      entry("top/a.txt", "a\n"),
      END,
      entry("top/after.txt", "after\n"),
      END,
    ]),
  );

  const files = await filesOf(chunked(archive));

  expect([...files.keys()]).toEqual(["a.txt"]);
});

test("a file that throws stops the walk, cancels the download, and leaves most of it unread", async () => {
  const archive = gzipSync(
    Buffer.concat([
      entry("top/first.txt", "first\n"),
      entry("top/big.bin", randomBytes(MIB)),
      END,
    ]),
    { level: 1 },
  );
  const CHUNK = 16_384;
  const chunks = Math.ceil(archive.length / CHUNK);
  let served = 0;
  let cancelled = false;
  async function* download(): AsyncGenerator<Buffer> {
    try {
      for (let at = 0; at < archive.length; at += CHUNK) {
        served++;
        yield archive.subarray(at, at + CHUNK);
      }
    } finally {
      cancelled = true;
    }
  }

  await expect(
    walkTarball(download(), {
      wants: () => true,
      file: async () => {
        throw new Error("disk full");
      },
    }),
  ).rejects.toThrow("disk full");
  await turns();

  expect(cancelled).toBe(true);
  expect(served).toBeLessThan(chunks / 2);
});

test("a consumer still busy with a file holds the download back: nothing past it is read, and the walk goes on when it is done", async () => {
  const FILES = 8;
  const archive = gzipSync(
    Buffer.concat([
      ...Array.from({ length: FILES }, (_, i) =>
        entry(`top/file-${i}.bin`, randomBytes(MIB)),
      ),
      END,
    ]),
    { level: 1 },
  );
  const CHUNK = 16_384;
  let delivered = 0;
  async function* download(): AsyncGenerator<Buffer> {
    for (let at = 0; at < archive.length; at += CHUNK) {
      delivered = Math.min(at + CHUNK, archive.length);
      yield archive.subarray(at, at + CHUNK);
    }
  }

  let entered = 0;
  let enteredWhileBusy = 0;
  let deliveredWhileBusy = 0;
  await walkTarball(download(), {
    wants: () => true,
    file: async () => {
      entered++;
      if (entered > 1) return;
      // busy until the download has gone still for a run of turns; a slow machine can only end
      // this early and miss a walker that reads ahead, never fail one that waits
      let last = -1;
      let still = 0;
      while (still < 25) {
        await turns(1);
        still = delivered === last ? still + 1 : 0;
        last = delivered;
      }
      enteredWhileBusy = entered;
      deliveredWhileBusy = delivered;
    },
  });

  expect(enteredWhileBusy).toBe(1);
  // the first file is 1 MiB of the 8 MiB; what is held beyond it is a few buffers
  expect(deliveredWhileBusy).toBeLessThan(2 * MIB);
  expect(entered).toBe(FILES);
});
