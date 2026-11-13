import { spawnSync } from "node:child_process";
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
import { APIError, FilesystemError, SpritesClient } from "@fly/sprites";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KnownSecrets } from "./redact.js";
import {
  CAPPED_EXEC,
  CAPPED_WRAPPER_FAILED,
  execCapped,
  execInSprite,
  SpriteExecStreamError,
  type SpriteOps,
  SpriteTimeoutError,
  spriteCall,
  spriteNameFor,
} from "./sprites.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
} from "./testing/sprites.js";

test("names a sprite in the API's lowercase, digit and hyphen alphabet, deterministically and per env", () => {
  const ids = ["env_q9shK0hzD63HUeS9mmcuHz", "env_Q9shK0hzD63HUeS9mmcuHz", "x"];
  const names = ids.map(spriteNameFor);
  for (const name of names) expect(name).toMatch(/^sky-[0-9a-f]{24}$/);
  expect(names.map((n) => /^[a-z0-9-]+$/.test(n))).toEqual([true, true, true]);
  expect(ids.map(spriteNameFor)).toEqual(names);
  expect(new Set(names).size).toBe(ids.length);
});

test("the stub refuses a name outside the API's alphabet with a 400, on create and get", async () => {
  const wire = stubSprites();
  const client = new SpritesClient(spritesToken);
  const bad = "sky-env_q9shK0hzD63HUeS9mmcuHz";
  for (const call of [
    () => client.createSprite(bad),
    () => client.getSprite(bad),
  ]) {
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(400);
  }
  expect(wire.sprites.has(bad)).toBe(false);
});

const opsWith = (overrides: Partial<SpriteOps> = {}) => {
  const logged: string[] = [];
  const secrets = new KnownSecrets();
  secrets.add("SPRITES_TOKEN", spritesToken);
  const ops: SpriteOps = {
    client: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    secrets,
    timeoutMs: 60_000,
    longTimeoutMs: 30 * 60_000,
    ...overrides,
  };
  return { ops, logged };
};

test("a Sprites call logs a start line, then an end line with its op, outcome and duration", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  const { ops, logged } = opsWith();
  await execInSprite(ops, "sky-a", ["true"], { op: "wake" });
  wire.exec = () => ({ exitCode: 128 });
  await execInSprite(ops, "sky-a", ["git", "clone"], { op: "clone" });
  expect(logged).toEqual([
    "sprite sky-a wake: start",
    expect.stringMatching(/^sprite sky-a wake: ok in \d+ms$/),
    "sprite sky-a clone: start",
    expect.stringMatching(/^sprite sky-a clone: exited 128 in \d+ms$/),
  ]);
});

test("a failed Sprites call logs failed with its message, scrubbed of known secrets and the caller's values", async () => {
  const { ops, logged } = opsWith();
  const err = await spriteCall(
    ops,
    "sky-a",
    { op: "write-file", known: ["agent-token-value"] },
    async () => {
      throw new Error(`refused ${spritesToken} for agent-token-value`);
    },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(logged).toEqual([
    "sprite sky-a write-file: start",
    expect.stringMatching(
      /^sprite sky-a write-file: failed in \d+ms: refused \[redacted\] for \[redacted\]$/,
    ),
  ]);
});

test("a Sprites call that never answers rejects at its bound, naming sprite, op and bound, logs timed out and aborts its signal", async () => {
  const { ops, logged } = opsWith({ timeoutMs: 20 });
  let signal: AbortSignal | undefined;
  const err = await spriteCall(ops, "sky-a", { op: "sha256sum" }, (s) => {
    signal = s;
    return new Promise(() => {});
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SpriteTimeoutError);
  expect((err as Error).message).toBe(
    "sprite sky-a: sha256sum timed out after 20 ms",
  );
  expect(signal?.aborted).toBe(true);
  expect(logged).toEqual([
    "sprite sky-a sha256sum: start",
    "sprite sky-a sha256sum: timed out after 20ms",
  ]);
});

test("a hung exec is cut at its bound: the request is aborted and the call rejects as timed out", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.hangs = (call) => call.includes("git clone");
  const { ops, logged } = opsWith();
  // the server would hold the call for ten minutes: only the client's abort can settle it
  wire.hangMs = 10 * 60_000;
  const err = await execInSprite(ops, "sky-a", ["git", "clone", "x"], {
    op: "clone",
    timeoutMs: 50,
  }).catch((e: unknown) => e);
  await wire.hangsSettled();
  expect((err as Error).message).toBe(
    "sprite sky-a: clone timed out after 50 ms",
  );
  expect(logged.at(-1)).toBe("sprite sky-a clone: timed out after 50ms");
});

test("an exec whose output arrives re-chunked fails as an undecodable stream, not as an unreachable sprite", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  // 0x74 is "t": the second chunk starts with output where the SDK expects a frame-type byte
  wire.execChunkBytes = 1024;
  wire.exec = () => ({ exitCode: 0, stdout: "t".repeat(5000) });
  const { ops, logged } = opsWith();
  const err = await execInSprite(ops, "sky-a", ["git", "diff"], {
    op: "diff",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SpriteExecStreamError);
  expect((err as Error).message).toContain(
    "Unsupported HTTP exec frame type 0x74",
  );
  expect(((err as Error).cause as Error).message).toContain(
    "preserved HTTP chunk boundaries",
  );
  expect(logged.at(-1)).toContain("failed in");
});

test("an exec that fails in transport is not an undecodable stream", async () => {
  stubSprites();
  const { ops } = opsWith();
  const err = await execInSprite(ops, "sky-missing", ["true"], {
    op: "check",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(APIError);
});

test("a capped exec of large output re-chunked on the wire returns the first bytes, the full size and a truncated flag", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.execChunkBytes = 1024;
  const big = "t".repeat(5000);
  wire.exec = () => ({ exitCode: 0, stdout: big });
  const { ops } = opsWith();
  const out = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes: 1000,
  });
  expect(out).toEqual({ exitCode: 0, stdout: "", size: 5000, truncated: true });
  // a single line longer than the cap leaves nothing whole to return
  wire.exec = () => ({ exitCode: 0, stdout: `${"a".repeat(99)}\n`.repeat(50) });
  const lines = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes: 1000,
  });
  expect(lines).toEqual({
    exitCode: 0,
    stdout: `${"a".repeat(99)}\n`.repeat(10),
    size: 5000,
    truncated: true,
  });
  await wire.cleanedUp();
});

test("a capped exec of output within the cap returns all of it untruncated", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  const { ops } = opsWith();
  wire.exec = () => ({ exitCode: 0, stdout: "small\n" });
  expect(
    await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 1000,
    }),
  ).toEqual({ exitCode: 0, stdout: "small\n", size: 6, truncated: false });
  await wire.cleanedUp();
});

test("a capped exec that exits nonzero returns no output and reads nothing, though the argv wrote some, and removes its directory", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  const { ops } = opsWith();
  wire.exec = () => ({ exitCode: 3, stdout: "partial\n" });
  expect(
    await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 1000,
    }),
  ).toEqual({ exitCode: 3, stdout: "", size: 0, truncated: false });
  expect(wire.calls.filter((c) => c.startsWith("read "))).toEqual([]);
  await wire.cleanedUp();
  expect(wire.calls).toContain(`rm sky-a ${cappedDirs(wire)[0]}`);
  expect(leftovers(wire)).toEqual([]);
});

// cap 10 throughout; each row's `stdout` is what the argv printed
test.each([
  {
    name: "exactly the cap is whole and untruncated",
    stdout: "aaaa\nbbbb\n",
    expected: { stdout: "aaaa\nbbbb\n", size: 10, truncated: false },
  },
  {
    name: "one byte over the cap with its cut on a newline keeps every line before it",
    stdout: "aaaa\nbbbb\nc",
    expected: { stdout: "aaaa\nbbbb\n", size: 11, truncated: true },
  },
  {
    name: "one byte over the cap with its cut mid-line is cut back to the line before",
    stdout: "aaaa\nbbbbbb",
    expected: { stdout: "aaaa\n", size: 11, truncated: true },
  },
  {
    name: "one byte over the cap with no newline in what is kept returns nothing",
    stdout: "abcdefghijk",
    expected: { stdout: "", size: 11, truncated: true },
  },
])("a capped exec of output $name", async ({ stdout, expected }) => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.exec = () => ({ exitCode: 0, stdout });
  const { ops } = opsWith();
  expect(
    await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 10,
    }),
  ).toEqual({ exitCode: 0, ...expected });
  await wire.cleanedUp();
});

// the cap and `size` count bytes: "é" is 2 and "😀" is 4, though each is under 3 UTF-16 units
test.each([
  {
    name: "an é split by the cap is cut back to the line before it",
    stdout: "é\né\né\n",
    maxBytes: 4,
    expected: { stdout: "é\n", size: 9, truncated: true },
  },
  {
    name: "an emoji split by the cap with no line before it returns nothing",
    stdout: "😀😀\n😀😀\n",
    maxBytes: 6,
    expected: { stdout: "", size: 18, truncated: true },
  },
  {
    name: "multibyte output under the cap round-trips, sized in bytes",
    stdout: "é😀\n",
    maxBytes: 100,
    expected: { stdout: "é😀\n", size: 7, truncated: false },
  },
])("a capped exec of $name", async ({ stdout, maxBytes, expected }) => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.exec = () => ({ exitCode: 0, stdout });
  const { ops } = opsWith();
  const out = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes,
  });
  expect(out).toEqual({ exitCode: 0, ...expected });
  expect(out.stdout).not.toContain("�");
  await wire.cleanedUp();
});

/** Overwrites the size file a capped exec left, as a process in the sprite could before it is read. */
const leaveSize = (wire: SpritesWire, text: string) => {
  wire.afterExec = () => {
    for (const path of [...wire.files.keys()]) {
      if (path.endsWith("/size")) wire.files.set(path, enc.encode(text));
    }
  };
};
const enc = new TextEncoder();

test.each([
  { name: "non-numeric", size: "lots\n" },
  { name: "empty", size: "" },
  { name: "negative", size: "-5\n" },
  { name: "smaller than the head it describes", size: "2\n" },
])("a capped exec whose size file is $name rejects as an unusable exec and removes its directory", async ({
  size,
}) => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.exec = () => ({ exitCode: 0, stdout: "+x\n" });
  leaveSize(wire, size);
  const { ops } = opsWith();
  const err = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes: 1000,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SpriteExecStreamError);
  expect((err as Error).message).toBe(
    "sprite sky-a: diff left an unreadable size file",
  );
  await wire.cleanedUp();
  expect(leftovers(wire)).toEqual([]);
});

test("a capped exec reads a size file padded with spaces, as BSD wc writes it", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.exec = () => ({ exitCode: 0, stdout: "+x\n" });
  leaveSize(wire, "       3\n");
  const { ops } = opsWith();
  expect(
    await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 1000,
    }),
  ).toEqual({ exitCode: 0, stdout: "+x\n", size: 3, truncated: false });
  await wire.cleanedUp();
});

// the script itself, which the stub only mimics
describe.skipIf(process.platform === "win32")("CAPPED_EXEC under sh", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sky-capped-exec-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (cap: number, argv: string[], dir = join(root, "out")) =>
    spawnSync("sh", ["-c", CAPPED_EXEC, "sh", dir, `${cap}`, ...argv], {
      encoding: "utf8",
    });
  const read = (file: string) => readFileSync(join(root, "out", file));

  test("keeps the first cap bytes of stdout and its full byte count", () => {
    const res = run(4, ["printf", "%s", "abcdefghij\n"]);
    expect(res.status).toBe(0);
    expect(read("head").toString()).toBe("abcd");
    // BSD wc pads its count with spaces
    expect(read("size").toString().trim()).toBe("11");
  });

  test("passes the argv's exit status through, its output still staged", () => {
    const res = run(100, ["sh", "-c", "printf partial; exit 7"]);
    expect(res.status).toBe(7);
    expect(read("head").toString()).toBe("partial");
    expect(read("size").toString().trim()).toBe("7");
  });

  test("lets nothing reach stderr, the argv's own included, or stdout", () => {
    const res = run(100, ["sh", "-c", "echo oops >&2; echo out"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("");
    expect(read("head").toString()).toBe("out\n");
  });

  test("leaves only head and size in its private directory", () => {
    run(2, ["printf", "%s", "abcdef"]);
    expect(readdirSync(join(root, "out")).sort()).toEqual(["head", "size"]);
    expect(statSync(join(root, "out")).mode & 0o777).toBe(0o700);
  });

  test("exits CAPPED_WRAPPER_FAILED, silently and without running the argv, for a directory that already exists", () => {
    const dir = join(root, "out");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep"), "mine");
    const ran = join(root, "ran");
    const res = run(100, ["sh", "-c", 'echo hi >"$0"', ran]);
    expect(res.status).toBe(CAPPED_WRAPPER_FAILED);
    expect(res.stderr).toBe("");
    expect(existsSync(ran)).toBe(false);
    expect(readdirSync(dir)).toEqual(["keep"]);
  });
});

/** What capped execs left under the sprite's /tmp: files and directories. */
const leftovers = (wire: SpritesWire) =>
  [...wire.files.keys(), ...wire.dirs].filter((p) =>
    p.startsWith("/tmp/sky-exec-"),
  );

/** The directory each capped exec was handed, in order. */
const cappedDirs = (wire: SpritesWire) =>
  wire.execUrls
    .map((u) => new URL(u).searchParams.getAll("cmd"))
    .filter((argv) => argv[2] === CAPPED_EXEC)
    .map((argv) => argv[4]);

test("a capped exec stages its output in a directory of its own and removes it whole, after a nonzero exit too", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  const { ops } = opsWith();
  for (const exitCode of [0, 3]) {
    wire.exec = () => ({ exitCode, stdout: "+x\n" });
    await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 1000,
    });
  }
  expect(cappedDirs(wire)).toEqual([
    expect.stringMatching(/^\/tmp\/sky-exec-[0-9a-f-]{36}$/),
    expect.stringMatching(/^\/tmp\/sky-exec-[0-9a-f-]{36}$/),
  ]);
  await wire.cleanedUp();
  expect(leftovers(wire)).toEqual([]);
});

test("a capped exec whose wrapper can't stage its output rejects as an unusable exec and removes what it left", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.tmpFull = true;
  wire.exec = () => ({ exitCode: 0, stdout: "+x\n" });
  const { ops } = opsWith();
  const err = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes: 1000,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SpriteExecStreamError);
  expect((err as Error).message).toBe(
    "sprite sky-a: diff could not stage its output in the sprite",
  );
  expect(wire.calls.some((c) => c.startsWith("read "))).toBe(false);
  await wire.cleanedUp();
  expect(leftovers(wire)).toEqual([]);
});

test("a capped exec whose read fails removes its directory", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.readStatus = 500;
  wire.exec = () => ({ exitCode: 0, stdout: "+x\n" });
  const { ops } = opsWith();
  const err = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes: 1000,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(FilesystemError);
  await wire.cleanedUp();
  expect(leftovers(wire)).toEqual([]);
});

test("a capped exec whose stream drops mid-run rejects and removes the directory with the full output still in it", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.execDrops = true;
  wire.exec = () => ({ exitCode: 0, stdout: "+x\n" });
  const { ops } = opsWith();
  const err = await execCapped(ops, "sky-a", ["git", "diff"], {
    op: "diff",
    maxBytes: 1000,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SpriteExecStreamError);
  expect(leftovers(wire)).toContain(`${cappedDirs(wire)[0]}/full`);
  await wire.cleanedUp();
  expect(leftovers(wire)).toEqual([]);
});

test("a head file swapped for a larger one after the exec is refused past the cap, without being read whole", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.exec = () => ({ exitCode: 0, stdout: "+x\n" });
  const swapped = new Uint8Array(4 * 1024 * 1024).fill(0x78);
  // a process in the sprite rewrites the file between the exec and the read
  wire.afterExec = () => {
    const dir = cappedDirs(wire).at(-1);
    wire.files.set(`${dir}/head`, swapped);
  };
  // counts the bytes the API pulls from the head file's body, as it pulls them
  let pulled = 0;
  const fetchOf = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    const res = await fetchOf(input, init);
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.searchParams.get("path")?.endsWith("/head") || !res.body) {
      return res;
    }
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pulled += chunk.length;
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, { status: res.status, headers: res.headers });
  });
  const { ops } = opsWith();
  try {
    const err = await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 1000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpriteExecStreamError);
    expect((err as Error).message).toMatch(/holds more than 1000 bytes$/);
    expect(pulled).toBeLessThan(swapped.length / 4);
    await wire.cleanedUp();
  } finally {
    spy.mockRestore();
  }
  expect(leftovers(wire)).toEqual([]);
});

test("two capped execs at once each stage in their own directory and get their own output", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.exec = (argv) => ({ exitCode: 0, stdout: `${argv.at(-1)}\n` });
  const { ops } = opsWith();
  const [a, b] = await Promise.all(
    ["a", "b"].map((which) =>
      execCapped(ops, "sky-a", ["echo", which], { op: "echo", maxBytes: 1000 }),
    ),
  );
  expect([a?.stdout, b?.stdout]).toEqual(["a\n", "b\n"]);
  const dirs = cappedDirs(wire);
  expect(dirs).toHaveLength(2);
  expect(new Set(dirs).size).toBe(2);
  await wire.cleanedUp();
});

test("an exec whose output passes the SDK's buffer limit is not reported as an undecodable stream", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  // 0x01 is the stdout frame type, so however the transport re-chunks this, each read parses as stdout
  wire.exec = () => ({ exitCode: 0, stdout: "\x01".repeat(11 * 1024 * 1024) });
  const { ops } = opsWith();
  const err = await execInSprite(ops, "sky-a", ["cat", "big"], {
    op: "cat",
  }).catch((e: unknown) => e);
  expect((err as Error).message).toBe("stdout maxBuffer exceeded");
  expect(err).not.toBeInstanceOf(SpriteExecStreamError);
});

test("a bound in whole minutes or seconds reads as such in the error", async () => {
  const { ops } = opsWith();
  vi.useFakeTimers();
  try {
    for (const [timeoutMs, words] of [
      [30 * 60_000, "30 min"],
      [90_000, "90 s"],
    ] as const) {
      const call = spriteCall(
        ops,
        "sky-a",
        { op: "clone", timeoutMs },
        () => new Promise(() => {}),
      ).catch((e: unknown) => (e as Error).message);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(await call).toBe(`sprite sky-a: clone timed out after ${words}`);
    }
  } finally {
    vi.useRealTimers();
  }
});
