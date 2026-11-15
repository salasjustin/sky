import { pipeline, Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const BLOCK = 512;
// a pax or GNU long-name header is a path or a few; one past this is not a header
const MAX_HEADER_BODY = 1024 * 1024;
// a file past this is left to the caller's other way of fetching it, not held in memory
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
// GitHub's tree listing is cut off long before this many entries
const MAX_ENTRIES = 2_000_000;

const text = (buf: Buffer, start: number, length: number) => {
  const field = buf.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
};

/** `key=value` records of a pax header, each `<length> key=value\n`. */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(body.subarray(at, space).toString());
    if (!Number.isInteger(length) || length <= space - at + 1) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return records;
}

/** Bytes pulled from a chunked source exactly as asked: a count held, a count dropped. */
class Reader {
  private chunks: Buffer[] = [];
  private held = 0;
  private readonly source: AsyncIterator<Buffer>;
  constructor(source: AsyncIterator<Buffer>) {
    this.source = source;
  }

  /** Moves the next chunk in; false at the end of the stream. */
  private async more(): Promise<boolean> {
    const next = await this.source.next();
    if (next.done) return false;
    this.chunks.push(next.value);
    this.held += next.value.length;
    return true;
  }

  /** The next `n` bytes, or fewer at the end of the stream. */
  async take(n: number): Promise<Buffer> {
    while (this.held < n && (await this.more())) {}
    const all =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all?.subarray(0, Math.min(n, this.held)) ?? Buffer.alloc(0);
    const rest = all?.subarray(out.length);
    this.chunks = rest?.length ? [rest] : [];
    this.held = rest?.length ?? 0;
    return out;
  }

  /** Drops the next `n` bytes without holding them; the count dropped, which is fewer at the end. */
  async skip(n: number): Promise<number> {
    let left = n;
    while (left > 0) {
      if (this.held === 0 && !(await this.more())) break;
      const first = this.chunks[0] as Buffer;
      const cut = Math.min(left, first.length);
      if (cut === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(cut);
      this.held -= cut;
      left -= cut;
    }
    return n - left;
  }
}

/**
 * Walks a gzipped tar as it arrives: decompressed a chunk at a time, entries read in turn, and only
 * a file `wants` names is held, one at a time, so memory is the largest wanted file plus a few
 * buffers, never the archive. `file` runs, and is awaited, before the next entry is read, so a slow
 * consumer holds the download back. Paths come without the archive's top directory (GitHub wraps the
 * tree in `<owner>-<repo>-<sha>/`); a symlink's bytes are its target, as git stores it. Nothing is
 * written to disk, so no path in the archive can name a place on it. Stops reading at the end marker.
 */
export async function walkTarball(
  archive: AsyncIterable<Uint8Array>,
  entries: {
    wants: (path: string) => boolean;
    file: (path: string, bytes: Buffer) => Promise<void>;
  },
): Promise<void> {
  const inflated = pipeline(
    Readable.from(archive, { objectMode: false }),
    createGunzip(),
    () => {},
  );
  const reader = new Reader(
    inflated[Symbol.asyncIterator]() as AsyncIterator<Buffer>,
  );
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  let count = 0;
  try {
    for (;;) {
      const header = await reader.take(BLOCK);
      if (header.length === 0) return;
      if (header.length < BLOCK) {
        throw new Error("the archive ends inside an entry");
      }
      if (header.every((byte) => byte === 0)) return;
      if (++count > MAX_ENTRIES) {
        throw new Error(`the archive holds more than ${MAX_ENTRIES} entries`);
      }
      const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("the archive has an entry header that can't be read");
      }
      const type = String.fromCharCode(header[156] || 0x30);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const named = type === "x" || type === "L" || type === "K";
      if (named || type === "g") {
        if (size > MAX_HEADER_BODY) {
          throw new Error("the archive has an entry header that is too large");
        }
        const body = await reader.take(padded);
        if (body.length < padded) {
          throw new Error("the archive ends inside an entry");
        }
        const content = body.subarray(0, size);
        if (type === "x") pax = paxRecords(content);
        else if (type === "L") longName = text(content, 0, size);
        else if (type === "K") longLink = text(content, 0, size);
        continue;
      }
      const prefix = text(header, 345, 155);
      const name =
        pax.get("path") ??
        longName ??
        (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      const link = pax.get("linkpath") ?? longLink ?? text(header, 157, 100);
      pax = new Map();
      longName = undefined;
      longLink = undefined;
      const slash = name.indexOf("/");
      const path = slash === -1 ? "" : name.slice(slash + 1);
      const isFile = type === "0";
      const isLink = type === "2";
      if (!path || !(isFile || isLink) || !entries.wants(path)) {
        if ((await reader.skip(padded)) < padded) {
          throw new Error("the archive ends inside an entry");
        }
        continue;
      }
      if (isLink) {
        await reader.skip(padded);
        await entries.file(path, Buffer.from(link));
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        await reader.skip(padded);
        continue;
      }
      const body = await reader.take(padded);
      if (body.length < padded) {
        throw new Error("the archive ends inside an entry");
      }
      await entries.file(path, body.subarray(0, size));
    }
  } finally {
    // the end marker or a failure stops the read; either way the download is cancelled
    inflated.destroy();
  }
}
