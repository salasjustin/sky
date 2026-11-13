import { APIError, SpritesClient } from "@fly/sprites";
import { expect, test, vi } from "vitest";
import { KnownSecrets } from "./redact.js";
import {
  execCapped,
  execInSprite,
  SpriteExecStreamError,
  type SpriteOps,
  SpriteTimeoutError,
  spriteCall,
  spriteNameFor,
} from "./sprites.js";
import { spritesToken, stubSprites } from "./testing/sprites.js";

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
  const started = Date.now();
  const err = await execInSprite(ops, "sky-a", ["git", "clone", "x"], {
    op: "clone",
    timeoutMs: 50,
  }).catch((e: unknown) => e);
  expect(Date.now() - started).toBeLessThan(2_000);
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
});

test("a capped exec of output within the cap returns all of it untruncated, and a nonzero exit reads nothing", async () => {
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
  wire.calls.length = 0;
  wire.exec = () => ({ exitCode: 3 });
  expect(
    await execCapped(ops, "sky-a", ["git", "diff"], {
      op: "diff",
      maxBytes: 1000,
    }),
  ).toMatchObject({ exitCode: 3, stdout: "" });
  expect(wire.calls.some((c) => c.startsWith("read "))).toBe(false);
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
