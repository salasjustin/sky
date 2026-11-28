/** Exit 2: the caller fixes its invocation, input file or config rather than retrying. */
export class UsageError extends Error {
  constructor(
    message: string,
    /** argv errors point at `--help`; a bad file or config says what's wrong in itself. */
    readonly showHelpPointer = false,
  ) {
    super(message);
  }
}

export interface Output {
  readonly json: boolean;
  /** The command's result: the API object under `--json`, else one line. */
  result(raw: unknown, line: string): void;
  progress(line: string): void;
  warn(line: string): void;
  /** Reports a failure on stderr and returns exit status 1. `fields` ride in the error under `--json` only. */
  fail(
    code: string,
    message: string,
    detail?: string,
    fields?: Record<string, unknown>,
  ): number;
}

export function createOutput(
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Output {
  return {
    json,
    result(raw, line) {
      stdout(json ? `${JSON.stringify(raw, null, 2)}\n` : `${line}\n`);
    },
    progress(line) {
      stderr(`${line}\n`);
    },
    warn(line) {
      stderr(`sky: warning: ${line}\n`);
    },
    fail(code, message, detail, fields) {
      if (json) {
        const error = {
          code,
          message,
          ...(detail !== undefined && { detail }),
          ...fields,
        };
        stderr(`${JSON.stringify({ error })}\n`);
      } else {
        const indented = detail?.replace(/^/gm, "  ");
        stderr(
          `sky: ${message}\n${indented === undefined ? "" : `${indented}\n`}`,
        );
      }
      return 1;
    },
  };
}
