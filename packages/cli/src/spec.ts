import { createHash } from "node:crypto";
import { Environment } from "@sky/shared";
import {
  type Document,
  isMap,
  isNode,
  isScalar,
  LineCounter,
  parseDocument,
} from "yaml";
import { z } from "zod";

const {
  name,
  repo,
  setup,
  base,
  concurrency,
  approvalPolicy,
  autoApprove,
  claudeCredential,
  claudePool,
  claudeFallback,
} = Environment.shape;

/**
 * The Claude fields have no default here, unlike in the API: a file that omits them leaves the
 * environment's as they are, so `sky apply` never undoes `sky env set-claude`. Only a field the file
 * names changes anything.
 */
const optionalClaude = {
  claudeCredential: claudeCredential.unwrap().optional(),
  claudePool: claudePool.unwrap().optional(),
  claudeFallback: claudeFallback.unwrap().optional(),
};

/** What `env.yaml` holds; the API's create body, so the API URL and key can't be smuggled in. */
export const EnvSpec = z.strictObject({
  name,
  repo,
  setup,
  base,
  concurrency,
  approvalPolicy,
  autoApprove,
  ...optionalClaude,
});
export type EnvSpec = z.infer<typeof EnvSpec>;

export type SpecResult =
  | { ok: true; spec: EnvSpec }
  | { ok: false; errors: string[] };

export function parseSpec(source: string, file: string): SpecResult {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const at = lines.linePos(e.pos[0]);
        const where = `${file}:${at.line}:${at.col}`;
        return `${where}: ${e.message.split("\n")[0]}`;
      }),
    };
  }
  if (!isMap(doc.contents)) {
    return { ok: false, errors: [`${file}: expected a mapping of fields`] };
  }
  const parsed = EnvSpec.safeParse(doc.toJS());
  if (parsed.success) return { ok: true, spec: parsed.data };
  const lineAt = (offset: number | undefined) =>
    offset === undefined ? "" : `:${lines.linePos(offset).line}`;
  return {
    ok: false,
    errors: parsed.error.issues.flatMap((issue) => {
      const path = issue.path.map(String);
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map(
          (key) =>
            `${file}${lineAt(keyOffset(doc, [...path, key]))}: ${[...path, key].join(".")}: unknown field`,
        );
      }
      return [
        `${file}${lineAt(valueOffset(doc, path))}: ${path.join(".")}: ${issue.message}`,
      ];
    }),
  };
}

function valueOffset(doc: Document, path: string[]): number | undefined {
  const node: unknown = doc.getIn(path, true);
  return isNode(node) ? node.range?.[0] : undefined;
}

function keyOffset(doc: Document, path: string[]): number | undefined {
  const parent: unknown =
    path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return undefined;
  const key = path.at(-1);
  const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === key);
  return isNode(pair?.key) ? pair.key.range?.[0] : undefined;
}

/** sha256 over the spec with keys sorted, so reordering or reformatting `env.yaml` keeps the hash. */
export function specHash(spec: EnvSpec): string {
  return `sha256:${createHash("sha256").update(canonicalJson(spec)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
