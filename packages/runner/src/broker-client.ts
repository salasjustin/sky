import net from "node:net";
import {
  BROKER_SOCKET_ENV,
  BROKER_TOKEN_ENV,
  type BrokerReply,
} from "./broker.js";
import { readPublishArgs } from "./publish.js";
import { SYNC_HELP, SYNC_USAGE, syncArgs } from "./sync.js";

type Io = {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

/**
 * Sends one request to the runner's broker and relays its answer: the runner's output on this
 * command's stdout and stderr, and the exit status it reports. The agent's commands hold no
 * connector; whatever reaches GitHub is the runner's doing, after the approval it opens.
 */
async function ask(
  name: string,
  request: object,
  env: NodeJS.ProcessEnv,
  io: Io,
): Promise<number> {
  const socketPath = env[BROKER_SOCKET_ENV];
  if (!socketPath) {
    io.stderr(
      `${name}: ${BROKER_SOCKET_ENV} is not set, so there is no runner to ask. It works only from a command a run's agent starts, in a run whose environment has a connector secret: sky secret set <env> GITHUB_CONNECTOR --connector=<connection id>\n`,
    );
    return 2;
  }
  return new Promise<number>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let received = "";
    let exit: number | undefined;
    const relay = (line: string) => {
      let reply: BrokerReply;
      try {
        reply = JSON.parse(line) as BrokerReply;
      } catch {
        return;
      }
      if (reply.t === "out") io.stdout(reply.s);
      else if (reply.t === "err") io.stderr(reply.s);
      else if (reply.t === "exit") exit = reply.code;
    };
    // the token the runner put in front of this call; without it the runner refuses the request
    const token = env[BROKER_TOKEN_ENV];
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ ...request, ...(token && { token }) })}\n`,
      ),
    );
    socket.on("data", (chunk: string) => {
      received += chunk;
      for (
        let end = received.indexOf("\n");
        end >= 0;
        end = received.indexOf("\n")
      ) {
        relay(received.slice(0, end));
        received = received.slice(end + 1);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      io.stderr(
        `${name}: can't reach the run's runner at ${socketPath} (${error.code ?? error.message}); it asks for approval and does the sending, so nothing was sent\n`,
      );
      resolve(1);
    });
    socket.on("close", () => {
      if (exit === undefined) {
        io.stderr(
          `${name}: the runner closed the connection without an answer; nothing is known to have been sent\n`,
        );
      }
      resolve(exit ?? 1);
    });
  });
}

/**
 * `runner.mjs publish …`, the agent's own command: reads its arguments and asks the run's runner to
 * publish the worktree. The runner opens one approval, then prints the pull request's URL on stdout
 * through this command, and the exit status is its own.
 */
export async function brokerPublishMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
): Promise<number> {
  // a `--body @file` goes as its path: the runner reads it, and only from where it allows
  const args = await readPublishArgs(argv, io, { deferBodyFile: true });
  if ("code" in args) return args.code;
  return ask(
    "sky publish",
    {
      op: "publish",
      ...args.values,
      ...(args.bodyFile !== undefined && { bodyFile: args.bodyFile }),
    },
    env,
    io,
  );
}

/** `runner.mjs sync …`, the agent's own command: asks the run's runner to sync the worktree, after one approval. */
export async function brokerSyncMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout(`usage: ${SYNC_USAGE}\n${SYNC_HELP}\n`);
    return 0;
  }
  const args = syncArgs(argv);
  if (!args) {
    io.stderr(
      `sky sync: takes no arguments other than --branch <name>\nusage: ${SYNC_USAGE}\n`,
    );
    return 2;
  }
  return ask("sky sync", { op: "sync", ...args }, env, io);
}
