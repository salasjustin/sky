import { createHash } from "node:crypto";
import { HttpResponse, http, ws } from "msw";
import { server } from "../../../../test/msw.js";
import type { Config } from "../config.js";
import { LOGGED_EXEC } from "../sprites.js";

export const spritesToken = "sprites-test-token";
const SPRITES = "https://api.sprites.dev/v1/sprites";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  apiKey: "k".repeat(40),
  spritesToken,
  dataDir: "/unused",
  port: 8080,
  claudeOauthToken: "sk-ant-oat01-test-oauth-token",
  publicBaseUrl: "https://sky.test",
  runnerBundlePath: "/unused/runner.mjs",
  cliBundlePath: "/unused/sky.mjs",
  runTimeoutMs: 30 * 60_000,
  launchDeadlineMs: 15 * 60_000,
  spritesLongTimeoutMs: 30 * 60_000,
  waitTimeoutMs: 120 * 60_000,
  baseProfiles: {},
  webhookSigningKey: "webhook-signing-key-for-tests-0123456789",
  secretEncryptionKey: Buffer.alloc(32, 1),
  ...overrides,
});

export type ExecOutcome = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

/** A detachable session as the WebSocket exec endpoint received it. */
export type Session = {
  sprite: string;
  dir: string | null;
  argv: string[];
  env: Record<string, string>;
  tty: boolean;
  detachable: boolean;
  /** The WebSocket URL as sent, query included. */
  url: string;
};

/**
 * The variables a session's `ENV_FILE` exports, parsed back from the `export NAME='value'` lines the
 * launcher writes; empty when the session names no file or the file was never written.
 */
export function envFileOf(
  wire: { files: Map<string, Uint8Array> },
  session: Pick<Session, "env"> | undefined,
): Record<string, string> {
  const path = session?.env.ENV_FILE;
  const bytes = path ? wire.files.get(path) : undefined;
  if (!bytes) return {};
  const text = new TextDecoder().decode(bytes);
  const line = /^export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'$/gm;
  return Object.fromEntries(
    [...text.matchAll(line)].map(([, name, quoted]) => [
      name,
      (quoted ?? "").replaceAll("'\\''", "'"),
    ]),
  );
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// the live API's answer to a name outside its alphabet, which the SDK raises as a 400 APIError
const VALID_NAME = /^[a-z0-9-]+$/;
const invalidName = () =>
  HttpResponse.json(
    { errors: ["invalid sprite name format"] },
    { status: 400 },
  );

/** In-memory Sprites API speaking the wire format @fly/sprites reads. */
export function stubSprites() {
  const wire = {
    sprites: new Set<string>(),
    /** Files written through the filesystem API, by absolute path. */
    files: new Map<string, Uint8Array>(),
    /** The octal mode each write asked for, by absolute path. */
    modes: new Map<string, string>(),
    /** Every exec URL, HTTP or WebSocket, query included. */
    execUrls: [] as string[],
    /**
     * One line per call, in order: `create <name>`, `exec <name> <dir> <argv…>` (`… &> <log>` for an
     * `execLogged` wrapper, its inner argv shown), `write <name> <path>`,
     * `session <name> <dir> <argv…>`, `checkpoint <name>`, `get <name>`, `read <name> <path>`,
     * `delete <name>`, `label <name>` (the PUT that sets labels).
     */
    calls: [] as string[],
    /** The body of each sprite's last update, by name. */
    updates: new Map<string, { labels?: string[]; url_settings?: unknown }>(),
    /** Each sprite's labels and url settings as the API holds them; an update keeps the fields its body omits. */
    stored: new Map<string, { labels: string[]; url_settings?: unknown }>(),
    sessions: [] as Session[],
    /** WebSocket exec connections the client has not closed. */
    openSockets: 0,
    // answers `sha256sum <path>` and `mv -f <from> <to>` from `files`, as coreutils would
    exec: (argv: string[]): ExecOutcome => {
      if (argv[0] === "sha256sum" && argv[1]) {
        const bytes = wire.files.get(argv[1]);
        return bytes
          ? { exitCode: 0, stdout: `${sha256(bytes)}  ${argv[1]}\n` }
          : {
              exitCode: 1,
              stderr: `sha256sum: ${argv[1]}: No such file or directory\n`,
            };
      }
      if (argv[0] === "mv" && argv[1] === "-f" && argv[2] && argv[3]) {
        const bytes = wire.files.get(argv[2]);
        if (!bytes)
          return { exitCode: 1, stderr: `mv: ${argv[2]}: No such file\n` };
        wire.files.delete(argv[2]);
        wire.files.set(argv[3], bytes);
      }
      return { exitCode: 0 };
    },
    /**
     * When set, each session's process prints `output` and exits right after the socket opens; the
     * SDK reads a TTY session's exit from its close code, 1000 as 0 and any other as 1.
     */
    sessionExit: undefined as { output: string; code: 0 | 1 } | undefined,
    /**
     * When set, HTTP exec frames are cut into pieces of this many bytes, each on its own tick, as an
     * intermediary may re-chunk them; the SDK takes each read to start a frame, so this breaks it.
     */
    execChunkBytes: undefined as number | undefined,
    /**
     * A call whose `calls` line this matches gets no answer until the client aborts it (or 5 s
     * pass, then a 503), as a Sprites API that hangs.
     */
    hangs: (_call: string): boolean => false,
    /** How long a hung call waits before answering 503 when the client never aborts it. */
    hangMs: 5_000,
    /** Resolves once every call `hangs` caught has been answered, whether the client aborted it or not. */
    hangsSettled: (): Promise<void> =>
      Promise.all(inflightHangs).then(() => undefined),
    createStatus: 201,
    updateStatus: 200,
    writeStatus: 200,
    checkpointLines: undefined as object[] | undefined,
    deleteStatus: 204,
  };
  let checkpoints = 0;
  const inflightHangs = new Set<Promise<Response>>();
  const hang = (request: Request) => {
    const answered = new Promise<Response>((resolve) => {
      const answer = () =>
        resolve(HttpResponse.json({ error: "hung" }, { status: 503 }));
      request.signal.addEventListener("abort", answer, { once: true });
      setTimeout(answer, wire.hangMs).unref();
    });
    inflightHangs.add(answered);
    return answered;
  };
  // a sprite the test seeded straight into `sprites` has the default settings
  const storedOf = (name: string) =>
    wire.stored.get(name) ?? { labels: [], url_settings: { auth: "sprite" } };
  const authorized = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${spritesToken}`;

  const execLink = ws.link("wss://api.sprites.dev/v1/sprites/:name/exec");

  server.use(
    http.post(SPRITES, async ({ request }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { name } = (await request.json()) as { name: string };
      wire.calls.push(`create ${name}`);
      if (!VALID_NAME.test(name)) return invalidName();
      if (wire.createStatus !== 201) {
        return HttpResponse.json(
          { error: "sprite quota exceeded" },
          { status: wire.createStatus },
        );
      }
      wire.sprites.add(name);
      wire.stored.set(name, { labels: [], url_settings: { auth: "sprite" } });
      return HttpResponse.json(
        {
          id: `spr_${name}`,
          name,
          status: "cold",
          url_settings: { auth: "sprite" },
          labels: [],
        },
        { status: 201 },
      );
    }),
    http.post(`${SPRITES}/:name/exec`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      const url = new URL(request.url);
      wire.execUrls.push(url.href);
      const argv = url.searchParams.getAll("cmd");
      // execLogged's wrapper: `sh -c <script> sh <log> <bytes> <argv…>`, run here as the shell would
      const logged =
        argv[0] === "sh" && argv[1] === "-c" && argv[2] === LOGGED_EXEC
          ? { log: argv[4] ?? "", bytes: Number(argv[5]), argv: argv.slice(6) }
          : undefined;
      const call = `exec ${name} ${url.searchParams.get("dir") ?? "-"} ${
        logged ? `${logged.argv.join(" ")} &> ${logged.log}` : argv.join(" ")
      }`;
      wire.calls.push(call);
      if (wire.hangs(call)) return hang(request);
      if (!wire.sprites.has(name)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      const enc = new TextEncoder();
      let outcome = wire.exec(logged?.argv ?? argv);
      if (logged) {
        if (outcome.exitCode !== 0) {
          const combined = enc.encode(
            (outcome.stdout ?? "") + (outcome.stderr ?? ""),
          );
          wire.files.set(`${logged.log}.tail`, combined.slice(-logged.bytes));
        }
        outcome = { exitCode: outcome.exitCode };
      }
      // one frame per chunk: a stream-id byte, then the payload; exit is [3, code]
      const frames = [
        ...(outcome.stdout ? [[1, ...enc.encode(outcome.stdout)]] : []),
        ...(outcome.stderr ? [[2, ...enc.encode(outcome.stderr)]] : []),
        [3, outcome.exitCode],
      ].flatMap((frame) => {
        const size = wire.execChunkBytes ?? frame.length;
        const pieces: number[][] = [];
        for (let at = 0; at < frame.length; at += size) {
          pieces.push(frame.slice(at, at + size));
        }
        return pieces;
      });
      // the SDK splits frames on read boundaries, so each goes out on its own tick, as the
      // live server flushes them; enqueued together they coalesce into one read
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const frame = frames.shift();
          if (!frame) return controller.close();
          await new Promise((resolve) => setTimeout(resolve, 0));
          controller.enqueue(new Uint8Array(frame));
        },
      });
      return new HttpResponse(body, {
        headers: { "content-type": "application/octet-stream" },
      });
    }),
    http.put(`${SPRITES}/:name/fs/write`, async ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      const query = new URL(request.url).searchParams;
      const path = query.get("path") ?? "";
      wire.calls.push(`write ${name} ${path}`);
      if (wire.hangs(`write ${name} ${path}`)) return hang(request);
      const mode = query.get("mode");
      if (mode) wire.modes.set(path, mode);
      if (wire.writeStatus !== 200) {
        return HttpResponse.json(
          { error: "write failed" },
          { status: wire.writeStatus },
        );
      }
      wire.files.set(path, new Uint8Array(await request.arrayBuffer()));
      return HttpResponse.json({ path, size: wire.files.get(path)?.length });
    }),
    http.get(`${SPRITES}/:name/fs/read`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const path = new URL(request.url).searchParams.get("path") ?? "";
      wire.calls.push(`read ${String(params.name)} ${path}`);
      const bytes = wire.files.get(path);
      if (!wire.sprites.has(String(params.name)) || !bytes) {
        return HttpResponse.json(
          { error: "no such file", code: "ENOENT", path },
          { status: 404 },
        );
      }
      return new HttpResponse(bytes, {
        headers: { "content-type": "application/octet-stream" },
      });
    }),
    // the WebSocket upgrade's headers are out of MSW's reach, so this one can't check the bearer
    execLink.addEventListener("connection", ({ client, params }) => {
      const name = String(params.name);
      const url = client.url;
      wire.execUrls.push(url.href);
      const argv = url.searchParams.getAll("cmd");
      const env = Object.fromEntries(
        url.searchParams.getAll("env").map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)];
        }),
      );
      const dir = url.searchParams.get("dir");
      wire.calls.push(`session ${name} ${dir ?? "-"} ${argv.join(" ")}`);
      wire.sessions.push({
        sprite: name,
        dir,
        argv,
        env,
        tty: url.searchParams.get("tty") === "true",
        detachable: url.searchParams.get("detachable") === "true",
        url: url.href,
      });
      wire.openSockets += 1;
      client.addEventListener("close", () => {
        wire.openSockets -= 1;
      });
      const exit = wire.sessionExit;
      if (exit) {
        // on separate ticks, as the live server sends them: sent in the close's tick, the output never arrives
        setTimeout(
          () => client.send(new TextEncoder().encode(exit.output)),
          10,
        );
        setTimeout(
          () => client.close(exit.code === 0 ? 1000 : 1011, "process exited"),
          20,
        );
      }
    }),
    http.post(`${SPRITES}/:name/checkpoint`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      wire.calls.push(`checkpoint ${name}`);
      checkpoints += 1;
      const time = "2026-10-29T00:00:00Z";
      const lines = wire.checkpointLines ?? [
        { type: "info", data: "Creating checkpoint...", time },
        { type: "complete", data: `Checkpoint v${checkpoints} created`, time },
      ];
      return new HttpResponse(
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }),
    http.get(`${SPRITES}/:name`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      wire.calls.push(`get ${name}`);
      if (!VALID_NAME.test(name)) return invalidName();
      if (!wire.sprites.has(name)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      const { labels, url_settings } = storedOf(name);
      return HttpResponse.json({
        id: `spr_${name}`,
        name,
        status: "warm",
        labels,
        url_settings,
      });
    }),
    http.put(`${SPRITES}/:name`, async ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      wire.calls.push(`label ${name}`);
      if (wire.hangs(`label ${name}`)) return hang(request);
      if (!wire.sprites.has(name)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      if (wire.updateStatus !== 200) {
        return HttpResponse.json(
          { error: "update failed" },
          { status: wire.updateStatus },
        );
      }
      const body = (await request.json()) as {
        labels?: string[];
        url_settings?: unknown;
      };
      wire.updates.set(name, body);
      const before = storedOf(name);
      const after = {
        labels: body.labels ?? before.labels,
        url_settings: body.url_settings ?? before.url_settings,
      };
      wire.stored.set(name, after);
      return HttpResponse.json({
        id: `spr_${name}`,
        name,
        status: "cold",
        ...after,
      });
    }),
    http.delete(`${SPRITES}/:name`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      wire.calls.push(`delete ${name}`);
      if (wire.deleteStatus !== 204) {
        return HttpResponse.json(
          { error: "upstream unavailable" },
          { status: wire.deleteStatus },
        );
      }
      if (!wire.sprites.delete(name)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return wire;
}

export type SpritesWire = ReturnType<typeof stubSprites>;
